/**
 * v2.49：token 估算与模型上下文预算。
 *
 * duck.ai 不返回真实 token 用量；这里用 gpt-tokenizer（o200k）估算文本 token，
 * 图片/PDF 用保守公式，并把估算方式写入 usage.estimation，方便区分。
 */
import { encode } from 'gpt-tokenizer';

/** 已知模型真实上下文（tokens）。未列出的模型用保守默认值。 */
export const MODEL_CONTEXT_TOKENS = Object.freeze({
  'gpt-6-luna': 1_000_000,
  'gpt-5.6-terra': 400_000,
  'gpt-5.6-sol': 400_000,
  'gpt-5.4-mini': 400_000,
  'claude-sonnet-5-5': 200_000,
  'claude-opus-5-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-8': 200_000,
  'claude-haiku-4-5': 200_000,
  'mistral-small-2603': 128_000,
  'tinfoil/gpt-oss-120b': 128_000,
  'tinfoil/gemma4-31b': 128_000
});

export const DEFAULT_CONTEXT_TOKENS = 128_000;

const tokenCache = new Map();
const MAX_CACHE_ENTRIES = 256;

/** 文本 token 数（gpt-tokenizer o200k）；失败时退回 chars/4。 */
export function countTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;
  let value;
  try {
    value = encode(text).length;
  } catch {
    value = Math.max(1, Math.ceil(text.length / 4));
  }
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    const first = tokenCache.keys().next().value;
    tokenCache.delete(first);
  }
  tokenCache.set(text, value);
  return value;
}

/** 图片 token 估算（OpenAI vision 近似：85 + 每 512x512 tile 170）。 */
export function countImageTokens(image = {}) {
  const width = Number(image.width || image.w);
  const height = Number(image.height || image.h);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
    return 85 + 170 * Math.max(1, tiles);
  }
  return 1000;
}

/** 文件 token 估算：PDF 用提取文本 + 页/id 开销；其它文件保守 1000。 */
export function countFileTokens(file = {}) {
  if (!file || typeof file !== 'object') return 0;
  const mime = typeof file.mimeType === 'string' ? file.mimeType : '';
  if (mime === 'application/pdf' || mime === 'application/x-pdf') {
    const text = typeof file.text === 'string' ? file.text : '';
    const pages = Number(file.pages);
    const pageCount = Number.isFinite(pages) && pages > 0 ? pages : 1;
    return countTextTokens(text) + pageCount * 100;
  }
  return 1000;
}

/** 单条消息 token（content + images + files）。 */
export function countMessageTokens(message = {}) {
  let total = countTextTokens(typeof message.content === 'string' ? message.content : '');
  if (Array.isArray(message.images)) total += message.images.reduce((sum, image) => sum + countImageTokens(image), 0);
  if (Array.isArray(message.files)) total += message.files.reduce((sum, file) => sum + countFileTokens(file), 0);
  return total;
}

/** 整个消息数组 token。 */
export function countMessagesTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + countMessageTokens(message), 0);
}

export function modelContextTokens(model) {
  const id = typeof model === 'string' ? model : model?.id || model?.model || '';
  const explicit = Number(model?.contextWindowTokens || model?.capabilities?.contextWindowTokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  return MODEL_CONTEXT_TOKENS[id] || DEFAULT_CONTEXT_TOKENS;
}

/** PDF 文本在页面上的字数量级（供 capacity 诊断，不作为 token 正式值）。 */
export function pdfTextCharCount(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + String(message?.content || '').length, 0);
}

export default {
  MODEL_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  countTextTokens,
  countImageTokens,
  countFileTokens,
  countMessageTokens,
  countMessagesTokens,
  modelContextTokens,
  pdfTextCharCount
};
