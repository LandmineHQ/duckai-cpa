/**
 * v2.51：会话 canonical 状态 + Codex 手动压缩 marker 检测。
 *
 * Codex 手动压缩会在 input 里发送一条摘要消息（user role），开头为：
 *   "Another language model started to solve this problem and produced a summary..."
 * 网关需要把 marker 之前的旧对话 + 摘要落入 conversation-context.pdf，marker 之后
 * 的消息（含当前 user）作为新的 hot text，并在同一 session 内复用 PDF。
 */
import crypto from 'node:crypto';
import { createContextPdf } from './context-pdf.js';
import { pdfFileFromState, stableAutoSessionKey } from './context-spill.js';

export const COMPACTION_MARKER = 'Another language model started to solve this problem';

export function hashText(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

export function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return String(part.text || '');
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** @returns {{index:number, message:any, summaryText:string, summaryHash:string, before:any[], hot:any[]}|null} */
export function findCompactionMarker(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!message || typeof message !== 'object') continue;
    const text = messageText(message);
    if (text.includes(COMPACTION_MARKER)) {
      return {
        index,
        message,
        summaryText: text,
        summaryHash: hashText(text),
        before: list.slice(0, index),
        hot: list.slice(index + 1)
      };
    }
  }
  return null;
}

/** 过滤供 PDF 渲染的消息：去掉 system/developer；保留 user/assistant/tool（tool 转 user 文本）。 */
export function messagesForContextPdf(messages = []) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (role === 'system' || role === 'developer') continue;
    if (role === 'tool' || role === 'function') {
      out.push({ role: 'user', content: `[tool:${message.name || ''}] ${messageText(message)}`.trim() });
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    out.push({ ...message, content: messageText(message), role });
  }
  return out;
}

/** 解析请求的稳定 session key（优先级与 server.js 一致，并补 previous_response_id / marker hash）。 */
export function resolveConversationSessionKey({ ctx = null, body = null, model = '', conversation = [], marker = null } = {}) {
  const fromCtx = ctx?.sessionKey || ctx?.conversationKey;
  if (typeof fromCtx === 'string' && fromCtx.trim()) return fromCtx.trim().slice(0, 512);
  const source = body && typeof body === 'object' ? body : {};
  for (const field of ['prompt_cache_key', 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'previous_response_id']) {
    const value = source[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
  }
  if (marker?.summaryHash) return `auto:compact:${marker.summaryHash.slice(0, 24)}`;
  return stableAutoSessionKey(model, conversation);
}

/**
 * 生成/复用 manual compaction 的上下文 PDF。
 * 新生成时把 marker 之前的旧对话 + 摘要消息渲染成 PDF。
 */
export async function buildManualCompactionPdf({
  marker,
  responsesStore = null,
  scopeKey,
  maxPages = 15,
  title = 'Codex manual compaction context'
} = {}) {
  if (!marker) return { state: null, file: null, generated: false, scopeKey };
  const expectedCoveredHash = hashText(JSON.stringify(marker.before));
  if (responsesStore?.enabled && scopeKey) {
    const existing = await responsesStore.getContextPdf(scopeKey);
    if (existing && existing.pdfB64 && existing.coveredHash === expectedCoveredHash) {
      return {
        state: existing,
        file: {
          mimeType: existing.mimeType || 'application/pdf',
          filename: existing.filename || 'conversation-context.pdf',
          b64: existing.pdfB64,
          pages: existing.pages,
          bytes: existing.bytes,
          textChars: existing.textChars,
          text: existing.textContent || ''
        },
        generated: false,
        scopeKey
      };
    }
  }
  const source = [...messagesForContextPdf(marker.before), marker.message];
  const pdf = await createContextPdf({ messages: source, maxPages, title });
  const file = {
    mimeType: 'application/pdf',
    filename: 'conversation-context.pdf',
    b64: pdf.buffer.toString('base64'),
    pages: pdf.pages,
    bytes: pdf.buffer.length,
    textChars: pdf.textChars,
    text: source.map((message) => messageText(message)).join('\n')
  };
  const coveredCount = marker.before.length + 1;
  let state = file;
  if (responsesStore?.enabled && scopeKey) {
    await responsesStore.saveContextPdf({
      scopeKey,
      filename: file.filename,
      mimeType: file.mimeType,
      pages: file.pages,
      bytes: file.bytes,
      textChars: file.textChars,
      textContent: file.text,
      coveredCount,
      coveredHash: expectedCoveredHash,
      pdfB64: file.b64
    });
    state = await responsesStore.getContextPdf(scopeKey);
  }
  return { state, file, generated: true, scopeKey };
}

/** 如果同一 summaryHash 已有压缩 PDF，直接复用（避免后续轮次重复生成）。 */
export async function loadReusableCompactionPdf({ responsesStore = null, compression = null, scopeKey = null } = {}) {
  if (!responsesStore?.enabled || !compression?.summaryHash || !scopeKey) return null;
  const state = await responsesStore.getContextPdf(scopeKey);
  if (!state || !state.pdfB64) return null;
  const file = pdfFileFromState(state);
  return file ? { state, file, generated: false, scopeKey } : null;
}

export function buildCompressionRecord({ marker, pdfFile = null, trigger = 'manual', reused = false, scopeKey = null }) {  return {
    trigger,
    summaryHash: marker.summaryHash,
    summaryChars: marker.summaryText.length,
    summaryText: marker.summaryText.slice(0, 4000),
    coveredMessageCount: marker.before.length + 1,
    hotMessageCount: marker.hot.length + 1,
    contextPdf: pdfFile
      ? { filename: pdfFile.filename, pages: pdfFile.pages, bytes: pdfFile.bytes }
      : null,
    contextPdfScope: scopeKey,
    reused: reused === true,
    createdAt: Date.now()
  };
}

export default {
  COMPACTION_MARKER,
  findCompactionMarker,
  messagesForContextPdf,
  resolveConversationSessionKey,
  buildManualCompactionPdf,
  buildCompressionRecord,
  hashText,
  messageText
};
