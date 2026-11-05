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
import { createContextPdf, PdfCapacityError } from './context-pdf.js';

const DEFAULT_INPUT_CHAR_LIMIT = 20000;
const DEFAULT_MAX_PAGES = 15;

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
  const filename = options.filename || 'conversation-context.pdf';
  const file = {
    mimeType: 'application/pdf',
    filename,
    b64: pdfResult.buffer.toString('base64'),
    pages: pdfResult.pages,
    text: history.map((message) => String(message.content || '')).join('\n'),
    textChars: pdfResult.textChars
  };

  const keepWithFile = keep.map((message, index) => {
    if (index !== 0 || message.role !== 'user') return message;
    return {
      ...message,
      files: [...(Array.isArray(message.files) ? message.files : []), file]
    };
  });
  if (keepWithFile.length === 0 || keepWithFile[0].role !== 'user') {
    keepWithFile.unshift({ role: 'user', content: '（较早的对话已放入附件 PDF，请结合 PDF 回答。）', files: [file] });
  }

  return {
    messages: [...systemPrefix, ...keepWithFile],
    pdf: { pages: pdfResult.pages, textChars: pdfResult.textChars, bytes: pdfResult.buffer.length },
    movedMessages: history.length
  };
}

export { PdfCapacityError };
export default { spillMessagesToPdf, messageTextChars, PdfCapacityError };
