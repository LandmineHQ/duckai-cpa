/**
 * v2.49：自动 PDF 溢出。
 *
 * 规则（用户确认）：
 * - 本次文本输入字符 ≤ duck.ai 限制（默认 20000）→ 不移动；
 * - 超过 → 把“除当前用户消息以外的全部历史”渲染为会话 PDF；
 * - 当前用户消息保留为文本，PDF 作为 file part 附在它后面；
 * - PDF 最多 15 页（Free 实测上限），超限抛 PdfCapacityError。
 *
 * 注意：PDF 仍然消耗模型 token；这里只解决 duck.ai 的文本字符限制。
 */
import crypto from 'node:crypto';
import { createContextPdf, createToolsPdf, PdfCapacityError } from './context-pdf.js';

const DEFAULT_INPUT_CHAR_LIMIT = 20000;
const DEFAULT_MAX_PAGES = 15;

export function hashConversationPrefix(messages = []) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(messages)).digest('hex');
  } catch {
    return '';
  }
}

/** v2.50：稳定的 PDF scope（同一会话复用同一 PDF）。 */
export function stableAutoSessionKey(model = '', conversation = []) {
  const firstUser = (Array.isArray(conversation) ? conversation : []).find((message) => message && message.role === 'user');
  const seed = `${model}\n${firstUser ? String(firstUser.content || '') : ''}`;
  return `auto:${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

export function pdfScopeKey({ kind = 'chat', sessionKey = null, previousResponseId = null, model = '', conversation = [] }) {
  if (sessionKey) return `${kind}:session:${sessionKey}`;
  if (previousResponseId) return `${kind}:response:${previousResponseId}`;
  const firstUser = (Array.isArray(conversation) ? conversation : []).find((message) => message && message.role === 'user');
  const seed = `${model}\n${firstUser ? String(firstUser.content || '') : ''}`;
  return `${kind}:auto:${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24)}`;
}

export function pdfFileFromState(state) {
  if (!state || !state.pdfB64) return null;
  return {
    mimeType: state.mimeType || 'application/pdf',
    filename: state.filename || 'conversation-context.pdf',
    b64: state.pdfB64,
    pages: state.pages,
    bytes: state.bytes,
    textChars: state.textChars,
    text: state.textContent || ''
  };
}

/** 把已存储的 PDF 挂到第一条 user 消息上（上下文 PDF 固定在会话顶部，不随每轮移动）。 */
export function attachPdfFile(messages = [], file) {
  if (!file || !Array.isArray(messages) || !messages.length) return messages;
  let index = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'user') { index = i; break; }
  }
  if (index < 0) return messages;
  return messages.map((message, i) =>
    i === index
      ? { ...message, files: [...(Array.isArray(message.files) ? message.files : []), file] }
      : message
  );
}

export function stripSpillInstruction(text) {
  return String(text || '').replace(/\s*\[系统提示\] 附件包含 client-tools\.pdf[\s\S]*$/, '').trim();
}

export function messageTextChars(messages = []) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'system' || message?.role === 'developer') {
      total += String(message.content || '').length;
      continue;
    }
    if (typeof message?.content === 'string') total += message.content.length;
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) {
          total += String(part.text || '').length;
        }
      }
    }
  }
  return total;
}

function isSystem(message) {
  return message?.role === 'system' || message?.role === 'developer';
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * @param {Array<Record<string, any>>} duckMessages 已构建的 duck 消息
 * @param {{inputCharLimit?: number, maxPages?: number, filename?: string}} options
 * @returns {Promise<{messages: any[], pdf: {pages: number, textChars: number, bytes: number}, movedMessages: number} | null>}
 */
export async function spillMessagesToPdf(duckMessages, options = {}) {
  const inputCharLimit = Number.isFinite(Number(options.inputCharLimit))
    ? Math.max(1000, Math.trunc(Number(options.inputCharLimit)))
    : DEFAULT_INPUT_CHAR_LIMIT;
  const maxPages = Number.isFinite(Number(options.maxPages))
    ? Math.max(1, Math.trunc(Number(options.maxPages)))
    : DEFAULT_MAX_PAGES;
  const messages = Array.isArray(duckMessages) ? duckMessages : [];
  const totalChars = messageTextChars(messages);
  if (totalChars <= inputCharLimit) return null;

  const keepIndex = lastUserIndex(messages);
  if (keepIndex < 0) return null;
  const history = messages.slice(0, keepIndex).filter((message) => !isSystem(message));
  if (!history.length) return null;
  const keep = messages.slice(keepIndex);
  const systemPrefix = messages.slice(0, keepIndex).filter(isSystem);

  const pdfResult = await createContextPdf({
    messages: history,
    maxPages,
    title: options.filename || 'DuckAI conversation context'
  });
  let toolsFile = null;
  if (options.toolProtocol || (Array.isArray(options.toolNames) && options.toolNames.length)) {
    const toolsPdf = await createToolsPdf({
      toolProtocol: options.toolProtocol || '',
      toolNames: options.toolNames || [],
      maxPages: 1
    });
    toolsFile = {
      mimeType: 'application/pdf',
      filename: 'client-tools.pdf',
      b64: toolsPdf.buffer.toString('base64'),
      pages: toolsPdf.pages,
      bytes: toolsPdf.buffer.length,
      textChars: toolsPdf.textChars,
      text: toolsPdf.text
    };
  }
  const filename = options.filename || 'conversation-context.pdf';
  const file = {
    mimeType: 'application/pdf',
    filename,
    b64: pdfResult.buffer.toString('base64'),
    pages: pdfResult.pages,
    text: history.map((message) => String(message.content || '')).join('\n'),
    textChars: pdfResult.textChars
  };

  const instruction =
    '\n\n[系统提示] 附件包含 client-tools.pdf（客户端工具说明）和 context PDF（会话历史上下文）。' +
    '请先阅读工具说明，然后读取 context PDF 的全部页面（不要只读第一页/摘要），结合当前问题继续回答。';
  const keepWithFile = keep.map((message, index) => {
    if (index !== 0 || message.role !== 'user') return message;
    return {
      ...message,
      content: typeof message.content === 'string' ? message.content + instruction : message.content,
      files: [...(Array.isArray(message.files) ? message.files : []), ...(toolsFile ? [toolsFile] : []), file]
    };
  });
  if (keepWithFile.length === 0 || keepWithFile[0].role !== 'user') {
    keepWithFile.unshift({ role: 'user', content: '（较早的对话已放入附件 PDF，请结合 PDF 回答。）', files: [file] });
  }

  return {
    messages: [...systemPrefix, ...keepWithFile],
    pdf: { pages: pdfResult.pages, textChars: pdfResult.textChars, bytes: pdfResult.buffer.length },
    file,
    toolsFile,
    movedMessages: history.length,
    coveredCount: keepIndex,
    coveredHash: hashConversationPrefix(messages.slice(0, keepIndex))
  };
}

export { PdfCapacityError };
export { createToolsPdf };
export default { spillMessagesToPdf, messageTextChars, stripSpillInstruction, stableAutoSessionKey, pdfScopeKey, pdfFileFromState, attachPdfFile, createToolsPdf, PdfCapacityError };
