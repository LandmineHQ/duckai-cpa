/** Bearer / admin auth helpers (Phase 1 split; 401 behavior unchanged). */
import { unauthorized } from '../../openai/errors.js';
import { timingSafeEqualString } from '../../store.js';

export function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const apiKeyHeader = req.headers?.['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) return apiKeyHeader.trim();
  return null;
}

/** v2: every /v1/* request requires a valid API key (managed or config-file). */
export function authorizeV1(ctx) {
  const token = extractBearerToken(ctx.req);
  if (!token) {
    throw unauthorized('Missing API key. Provide "Authorization: Bearer <api key>".', 'invalid_api_key');
  }
  const authorized =
    typeof ctx.store.isAuthorizedKey === 'function'
      ? ctx.store.isAuthorizedKey(token)
      : Boolean(ctx.store.findManagedKey?.(token));
  if (!authorized) {
    throw unauthorized('Incorrect API key provided.', 'invalid_api_key');
  }
  ctx.store.touchKey?.(token);
}

export function authorizeAdmin(ctx, config) {
  let token = extractBearerToken(ctx.req);
  if (!token && ctx.method === 'GET') {
    const queryToken = ctx.query.get('token');
    if (queryToken) token = queryToken;
  }
  if (!token) {
    throw unauthorized(
      'Missing admin token. Provide "Authorization: Bearer <adminToken>" (or ?token= for GET).',
      'invalid_admin_token'
    );
  }
  if (!timingSafeEqualString(config.auth?.adminToken || '', token)) {
    throw unauthorized('Invalid admin token.', 'invalid_admin_token');
  }
}

export default { extractBearerToken, authorizeV1, authorizeAdmin };
