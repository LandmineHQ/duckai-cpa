/** CORS helpers (Phase 1 split; headers unchanged). */
export const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Requested-With, Accept, Origin, X-Api-Key';
export const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
export const CORS_EXPOSE_HEADERS =
  'X-Request-Id, X-Duckai-Model, X-Duckai-Reasoning-Effort, X-Duckai-Reasoning-Adjusted, X-Duckai-Reasoning-Note, X-Duckai-Retriable, X-Duckai-Retry-At, X-Duckai-Queue, Retry-After';

/** v2.25 capture 端点专用 CORS：只允许 duck.ai / 本机来源。 */
export function applyCaptureCors(res, req) {
  const origin = String(req?.headers?.origin || '');
  const allowed =
    origin === 'https://duck.ai' ||
    origin === 'https://duckduckgo.com' ||
    origin === 'null' ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

export function applyCors(res, config) {
  if (!config.server?.cors) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_EXPOSE_HEADERS, applyCaptureCors, applyCors };
