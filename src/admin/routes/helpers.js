/** Admin route helpers (Phase 4A; behavior unchanged). */
import { toOpenAIError } from '../../openai/errors.js';

export function methodNotAllowed(ctx, allow) {
  return Object.assign(new Error(`Method ${ctx.method} not allowed for ${ctx.pathname}`), {
    status: 405,
    code: 'method_not_allowed',
    headers: { Allow: allow }
  });
}

export function requireMethod(ctx, allow) {
  const allowed = Array.isArray(allow) ? allow : [allow];
  if (!allowed.includes(ctx.method)) throw methodNotAllowed(ctx, allowed.join(', '));
}

export function getByDottedPath(object, dotted) {
  return dotted.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), object);
}

export function friendlyErrorMessage(error) {
  const normalized = toOpenAIError(error);
  if (normalized.status === 429) {
    return '上游请求受限（429）：匿名额度/队列限制，请稍后重试或降低请求频率。';
  }
  if (normalized.status >= 500) return `上游请求失败（${normalized.status}）：${normalized.message}`;
  return normalized.message;
}

export default { methodNotAllowed, requireMethod, getByDottedPath, friendlyErrorMessage };
