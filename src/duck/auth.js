/**
 * DuckDuckGo / Duck.ai subscription token parsing + online verification (v2.2).
 *
 * Reverse-engineered from the duck.ai web bundle (`auth/authorize|token|callback|logout`, 2026-11-01):
 *  - `/duckchat/v1/auth/token` returns `{ token }` when logged in; anonymous session returns `{}`.
 *  - token = three base64url segments (JWT). Payload fields: `api`, `email`, `exp`, `entitlements`.
 *  - `entitlements` is an array of `{ product, name, expiresAt? }`; a Duck.ai subscription is
 *    `product === "Duck.ai"` and `name === "plus" | "pro"`.
 *  - the frontend rejects any 62-character token with `ERR_AUTH_V1_TOKEN` (legacy v1 tokens),
 *    and rejects a missing/malformed payload with `ERR_AUTH_NO_PAYLOAD` / `ERR_AUTH_MALFORMED_TOKEN`.
 *  - the Authorization header is only attached when a token exists: `Authorization: Bearer <token>`;
 *    it also strips an internal-tier override header (`x-tier-internal: ignore`) outside internal builds.
 *
 * This module intentionally keeps the token out of logs and only exposes metadata.
 */
import crypto from 'node:crypto';

import { base64urlDecode } from './jwe.js';

/** Error raised for malformed / expired / unusable subscription tokens. */
export class AuthError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, detail?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = meta.status ?? 422;
    this.code = meta.code ?? 'token_invalid';
    if (meta.detail !== undefined) this.detail = meta.detail;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const DUCKAI_PRODUCT = 'Duck.ai';
const PAID_PLANS = ['plus', 'pro'];

/** @param {string} value */
function decodeSegment(value) {
  const text = String(value || '');
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new AuthError('subscription token is not valid base64url', { code: 'token_invalid', detail: 'bad_base64' });
  }
  try {
    return JSON.parse(base64urlDecode(text).toString('utf8'));
  } catch (error) {
    throw new AuthError('subscription token payload is not valid JSON', { code: 'token_invalid', detail: 'bad_json', cause: error });
  }
}

/**
 * Map `entitlements` to a Duck.ai tier.
 * @param {Array<{ product?: string, name?: string, expiresAt?: string }>} entitlements
 * @returns {'free'|'plus'|'pro'}
 */
export function entitlementsToTier(entitlements) {
  if (!Array.isArray(entitlements)) return 'free';
  const has = (name) => entitlements.some((entry) => entry && entry.product === DUCKAI_PRODUCT && entry.name === name);
  if (has('pro')) return 'pro';
  if (has('plus')) return 'plus';
  return 'free';
}

/**
 * Parse a subscription token without any network access.
 *
 * @param {string} token
 * @param {{ now?: number, allowExpired?: boolean }} [options]
 * @returns {{
 *   authenticated: boolean,
 *   api: any,
 *   email: string|null,
 *   exp: number|null,
 *   expiresAt: string|null,
 *   entitlements: Array<Record<string, any>>,
 *   tier: 'free'|'plus'|'pro',
 *   expired: boolean,
 *   tokenHash: string
 * }}
 * @throws {AuthError} token_invalid / token_expired
 */
export function parseSubscriptionToken(token, options = {}) {
  if (typeof token !== 'string') {
    throw new AuthError('subscription token must be a string', { code: 'token_invalid', detail: 'not_a_string' });
  }
  let value = token.trim();
  if (!value) throw new AuthError('subscription token is empty', { code: 'token_invalid', detail: 'empty' });
  if (value.toLowerCase().startsWith('bearer ')) value = value.slice(7).trim();
  if (value.length === 62) {
    // duck.ai explicitly rejects legacy v1 tokens (72-byte payload).
    throw new AuthError('legacy DuckDuckGo v1 tokens are not supported (ERR_AUTH_V1_TOKEN)', { code: 'token_invalid', detail: 'ERR_AUTH_V1_TOKEN' });
  }
  const parts = value.split('.');
  if (parts.length !== 3) {
    throw new AuthError('subscription token must have 3 segments', { code: 'token_invalid', detail: 'bad_segments' });
  }
  let payload;
  try {
    payload = decodeSegment(parts[1]);
  } catch (error) {
    throw error instanceof AuthError ? error : new AuthError('subscription token payload is malformed', { code: 'token_invalid', cause: error });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AuthError('subscription token payload is missing (ERR_AUTH_NO_PAYLOAD)', { code: 'token_invalid', detail: 'ERR_AUTH_NO_PAYLOAD' });
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const exp = Number.isFinite(Number(payload.exp)) && Number(payload.exp) > 0 ? Number(payload.exp) : null;
  const expired = exp !== null ? exp * 1000 <= now : true;
  if (expired && options.allowExpired !== true) {
    const error = new AuthError('subscription token has expired', { status: 422, code: 'token_expired', detail: exp ? new Date(exp * 1000).toISOString() : 'missing_exp' });
    error.expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
    throw error;
  }
  const entitlements = Array.isArray(payload.entitlements) ? payload.entitlements : [];
  const tier = entitlementsToTier(entitlements);
  return {
    authenticated: !expired && tier !== 'free' ? true : !expired,
    api: payload.api ?? null,
    email: typeof payload.email === 'string' ? payload.email : null,
    exp: exp,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    entitlements,
    tier,
    expired,
    tokenHash: hashToken(value)
  };
}

/** Non-reversible short fingerprint of a token (for logs / identity.json). */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Verify a subscription token online by calling duck.ai with `Authorization: Bearer`.
 * Never throws for network / HTTP problems; returns `{ verified: false, error }` instead.
 *
 * @param {{
 *   token: string,
 *   baseUrl?: string,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   buildFeSignals?: () => string,
 *   fetchImpl?: typeof fetch
 * }} params
 * @returns {Promise<{ verified: boolean, httpStatus: number|null, upstreamStatus: string|null, capabilities: any, error: { code: string, message: string, status?: number } | null, checkedAt: number }>}
 */
export async function verifySubscriptionOnline(params = {}) {
  const token = String(params.token || '').trim();
  const baseUrl = String(params.baseUrl || 'https://duck.ai').replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(params.timeoutMs) ? params.timeoutMs : 15000;
  const fetchImpl = params.fetchImpl || globalThis.fetch;
  const userAgent = params.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  const buildFeSignals = params.buildFeSignals || (() => {
    const start = Date.now();
    return Buffer.from(JSON.stringify({ start, events: [], end: start + 37 })).toString('base64');
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();
  const checkedAt = Date.now();
  const result = { verified: false, httpStatus: null, upstreamStatus: null, capabilities: null, error: null, checkedAt };

  try {
    // Page version is required for /duckchat/v1/status.
    let version = null;
    try {
      const home = await fetchImpl(`${baseUrl}/`, { headers: { 'user-agent': userAgent, accept: 'text/html' }, signal: controller.signal });
      const html = await home.text();
      const tag = html.match(/data-version-tag=["']([^"']+)["']/);
      const sha = html.match(/data-version-sha=["']([^"']+)["']/);
      if (tag && sha) version = `${tag[1]}-${sha[1]}`;
    } catch {
      /* version is optional for verification */
    }
    const headers = {
      'user-agent': userAgent,
      accept: 'application/json',
      origin: baseUrl,
      referer: `${baseUrl}/`,
      authorization: `Bearer ${token}`,
      'x-vqd-accept': '1',
      'x-vqd-hash-1': 'initial',
      ...(version ? { 'x-fe-version': version, 'x-fe-signals': buildFeSignals() } : {})
    };
    const statusResponse = await fetchImpl(`${baseUrl}/duckchat/v1/status`, { headers, signal: controller.signal });
    result.httpStatus = statusResponse.status;
    const statusBody = await statusResponse.text().catch(() => '');
    try {
      const parsed = JSON.parse(statusBody);
      result.upstreamStatus = parsed && parsed.status !== undefined ? String(parsed.status) : String(statusResponse.status);
    } catch {
      result.upstreamStatus = String(statusResponse.status);
    }
    if (statusResponse.status === 401 || statusResponse.status === 403) {
      result.error = { code: 'token_invalid', message: `upstream rejected the token (HTTP ${statusResponse.status})`, status: statusResponse.status };
      return result;
    }
    const capabilitiesResponse = await fetchImpl(`${baseUrl}/duckchat/v1/capabilities`, {
      headers: { ...headers, 'x-vqd-hash-1': 'initial' },
      signal: controller.signal
    });
    const capabilitiesBody = await capabilitiesResponse.text().catch(() => '');
    try {
      result.capabilities = JSON.parse(capabilitiesBody);
    } catch {
      result.capabilities = null;
    }
    result.verified = statusResponse.ok && capabilitiesResponse.ok;
    if (!result.verified) {
      result.error = { code: 'verify_failed', message: `upstream verification failed (status ${statusResponse.status}, capabilities ${capabilitiesResponse.status})`, status: statusResponse.status };
    }
    return result;
  } catch (error) {
    result.error = { code: 'verify_unavailable', message: `could not reach duck.ai for verification: ${String((error && error.message) || error)}` };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export default { parseSubscriptionToken, entitlementsToTier, verifySubscriptionOnline, AuthError, hashToken };
