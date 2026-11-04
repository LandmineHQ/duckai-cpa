/**
 * DuckDuckGo Sync & Backup pairing / recovery code codec (v2.2, local capability only).
 *
 * Reverse-engineered from the duck.ai web bundle (`sync/pairing` module, 2026-11-01):
 *
 *   v2 pairing payload = { version:"2", channel_id:"<16B base64url>", public_key:"<base64url>" }
 *   v2 pairing URL     = https://duckduckgo.com/sync/pairing/#&code2=<base64url(JSON(payload))>
 *   v1 pairing payload = { type:"v1-pairing" }                       (legacy, unsupported)
 *   recovery payload   = { recovery: { user_id: "..." , ... } }
 *   accepted origins   = https://duckduckgo.com, paths /sync/pairing, /sync/pairing/
 *   version regex      = /^2(?:\.\d+)?$/
 *   channel id regex   = uuid v4
 *   public key regex   = /^[A-Za-z0-9_-]+$/  (base64url)
 *   parse error enum   = bad_base64 | bad_encoding | bad_json | bad_payload |
 *                        unsupported_version | bad_channel_id | bad_public_key
 *
 * The sandbox can only reach duck.ai, so the actual sync transport is unavailable here:
 * `detectSyncTransport()` reports `blocked` and `pair()` surfaces
 * `DuckError code:"sync_transport_unavailable"` (503) without corrupting local state.
 */
import crypto from 'node:crypto';

import { base64urlEncode, base64urlDecode } from './jwe.js';

export const PAIRING_ORIGIN = 'https://duckduckgo.com';
export const PAIRING_PATHS = ['/sync/pairing', '/sync/pairing/'];
export const PAIRING_VERSION = '2';
export const PAIRING_URL_PREFIX = `${PAIRING_ORIGIN}/sync/pairing/#&code2=`;

/** Parse error codes accepted from the upstream pairing code parser. */
export const PAIRING_ERRORS = Object.freeze({
  BAD_BASE64: 'bad_base64',
  BAD_ENCODING: 'bad_encoding',
  BAD_JSON: 'bad_json',
  BAD_PAYLOAD: 'bad_payload',
  UNSUPPORTED_VERSION: 'unsupported_version',
  BAD_CHANNEL_ID: 'bad_channel_id',
  BAD_PUBLIC_KEY: 'bad_public_key'
});
export const PAIRING_ERROR_SET = new Set(Object.values(PAIRING_ERRORS));

const VERSION_RE = /^2(?:\.\d+)?$/;
const CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]+$/;
// duck.ai limits the *pairing code / URL* to 2048 chars; recovery codes wrap a JWE-encrypted
// RSA-2048 private JWK and are legitimately ~3–4KB, so they get their own (larger) limit.
export const MAX_PAIRING_CODE_LENGTH = 2048;
export const MAX_RECOVERY_CODE_LENGTH = 65536;

/** Random 16-byte channel id, base64url encoded (duck.ai uses base64url channel ids). */
export function generateChannelId() {
  return base64urlEncode(crypto.randomBytes(16));
}

/** @param {string} value */
function decodeBase64UrlUtf8(value) {
  return base64urlDecode(value).toString('utf8');
}

/**
 * Build the v2 pairing payload and URL.
 * @param {{ channelId: string, publicKeyBase64Url: string }} params
 * @returns {{ code: string, url: string, payload: { version: string, channel_id: string, public_key: string } }}
 */
export function buildPairingCode({ channelId, publicKeyBase64Url }) {
  if (typeof channelId !== 'string' || !channelId) throw makePairingError(PAIRING_ERRORS.BAD_CHANNEL_ID, 'channel_id is required');
  if (typeof publicKeyBase64Url !== 'string' || !PUBLIC_KEY_RE.test(publicKeyBase64Url)) {
    throw makePairingError(PAIRING_ERRORS.BAD_PUBLIC_KEY, 'public key must be base64url');
  }
  const payload = { version: PAIRING_VERSION, channel_id: channelId, public_key: publicKeyBase64Url };
  const code = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { code, url: buildPairingUrl(code), payload };
}

/** @param {string} code */
export function buildPairingUrl(code) {
  return `${PAIRING_URL_PREFIX}${code}`;
}

/** @param {string} code */
function makePairingError(detail, message) {
  const error = new Error(message || `pairing code error: ${detail}`);
  error.name = 'PairingCodeError';
  error.code = 'invalid_pairing_code';
  error.detail = detail;
  return error;
}

/**
 * Parse a pairing code / pairing URL / recovery code.
 *
 * @param {string} input raw code, full pairing URL, or recovery code
 * @param {{ maxLength?: number }} [options]
 * @returns {{ ok: true, type: 'v2-pairing', payload: { version: string, channel_id: string, public_key: string } } |
 *           { ok: true, type: 'v1-pairing' } |
 *           { ok: true, type: 'recovery', recovery: Record<string, any> } |
 *           { ok: false, type: 'unknown', detail: string }}
 */
export function parsePairingCode(input, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : MAX_RECOVERY_CODE_LENGTH;
  if (typeof input !== 'string' || input.length === 0 || input.length > maxLength) {
    return { ok: false, type: 'unknown', detail: 'empty_or_oversized' };
  }
  const text = input.trim();
  const isUrl = /^https?:\/\//i.test(text);
  if (isUrl && text.length > MAX_PAIRING_CODE_LENGTH) {
    // The upstream rejects oversized pairing URLs; recovery codes are not URLs.
    return { ok: false, type: 'unknown', detail: 'empty_or_oversized' };
  }

  let code = text;
  if (isUrl) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, type: 'unknown', detail: 'not_a_url' };
    }
    if (url.origin !== PAIRING_ORIGIN) return { ok: false, type: 'unknown', detail: 'wrong_origin' };
    if (!PAIRING_PATHS.includes(url.pathname)) return { ok: false, type: 'unknown', detail: 'wrong_path' };
    const match = url.hash.match(/[#&]code2=([^&]+)/);
    if (!match) return { ok: false, type: 'unknown', detail: 'missing_code2' };
    try {
      code = decodeURIComponent(match[1]);
    } catch {
      return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_ENCODING };
    }
  }

  let json;
  try {
    json = decodeBase64UrlUtf8(code);
  } catch {
    // Not valid base64url: maybe a recovery code with dashes/underscores only is still base64url;
    // fall back to the recovery parser (same encoding), otherwise report bad_base64.
    return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_BASE64 };
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_JSON };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_PAYLOAD };
  }

  // Legacy v1 pairing code.
  if (payload.type === 'v1-pairing') return { ok: true, type: 'v1-pairing' };

  // Recovery code (DuckDuckGo Sync: {"recovery":{"user_id":"..."}}).
  if (payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)) {
    return { ok: true, type: 'recovery', recovery: payload.recovery };
  }

  // v2 pairing payload.
  if (payload.version !== undefined) {
    if (typeof payload.version !== 'string' || !VERSION_RE.test(payload.version)) {
      return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.UNSUPPORTED_VERSION };
    }
    if (typeof payload.channel_id !== 'string' || !CHANNEL_ID_RE.test(payload.channel_id)) {
      // duck.ai allows base64url channel ids from other clients; accept both base64url and uuid v4.
      if (typeof payload.channel_id !== 'string' || !PUBLIC_KEY_RE.test(payload.channel_id)) {
        return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_CHANNEL_ID };
      }
    }
    if (typeof payload.public_key !== 'string' || !PUBLIC_KEY_RE.test(payload.public_key)) {
      return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_PUBLIC_KEY };
    }
    return { ok: true, type: 'v2-pairing', payload: { version: payload.version, channel_id: payload.channel_id, public_key: payload.public_key } };
  }

  return { ok: false, type: 'unknown', detail: PAIRING_ERRORS.BAD_PAYLOAD };
}

/**
 * Build a local recovery code. The DuckDuckGo on-the-wire format is
 * `base64url(JSON({"recovery":{"user_id":...}}))`; we extend `recovery` with the
 * wrapped key material so that a CPA instance can restore itself offline
 * (the official sync service is not reachable from this sandbox).
 *
 * @param {{ userId: string, mainKey: string, scopedPasswordSeed: string, encryptedPrivateKey: string, createdAt?: number }} params
 * @returns {string}
 */
export function createRecoveryCode({ userId, mainKey, scopedPasswordSeed, encryptedPrivateKey, createdAt = Date.now() }) {
  if (typeof userId !== 'string' || !userId) throw makePairingError(PAIRING_ERRORS.BAD_PAYLOAD, 'userId is required');
  if (typeof mainKey !== 'string' || !mainKey) throw makePairingError(PAIRING_ERRORS.BAD_PAYLOAD, 'mainKey is required');
  const payload = {
    recovery: {
      user_id: userId,
      version: 1,
      main_key: mainKey,
      scoped_password_seed: scopedPasswordSeed,
      encrypted_private_key: encryptedPrivateKey,
      created_at: createdAt
    }
  };
  return base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
}

/**
 * Decode a recovery code (accepts both the official `{recovery:{user_id}}` shape and
 * the extended local shape with key material).
 *
 * @param {string} code
 * @returns {{ ok: true, recovery: Record<string, any>, importable: boolean } | { ok: false, detail: string }}
 */
export function decodeRecoveryCode(code) {
  const parsed = parsePairingCode(code);
  if (!parsed.ok || parsed.type !== 'recovery') {
    return { ok: false, detail: parsed.ok ? PAIRING_ERRORS.BAD_PAYLOAD : parsed.detail };
  }
  const recovery = parsed.recovery;
  const importable = Boolean(recovery.main_key && recovery.scoped_password_seed && recovery.encrypted_private_key);
  return { ok: true, recovery, importable };
}

/**
 * Detect whether the DuckDuckGo Sync transport is reachable.
 *
 * v2.3: when a proxy manager is provided the probe goes through the proxy. With the proxy disabled
 * the transport is reported as `blocked/proxy_disabled` without wasting a network timeout (the
 * sandbox cannot resolve duckduckgo.com directly).
 *
 * @param {{
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   proxyManager?: { getSummary?: () => { enabled?: boolean }, fetch?: (url: string, init?: any) => Promise<any> } | null
 * }} [options]
 * @returns {Promise<{ status: 'available'|'blocked', reason: string|null, checkedAt: number }>}
 */
export async function detectSyncTransport(options = {}) {
  const proxyManager = options.proxyManager || null;
  if (proxyManager) {
    const summary = typeof proxyManager.getSummary === 'function' ? proxyManager.getSummary() : proxyManager;
    if (summary && summary.enabled === false) {
      return { status: 'blocked', reason: 'proxy_disabled', checkedAt: Date.now() };
    }
  }
  const baseUrl = String(options.baseUrl || PAIRING_ORIGIN).replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : proxyManager && proxyManager.getSummary && proxyManager.getSummary().enabled
      ? 15000
      : 3000;
  const fetchImpl =
    options.fetchImpl ||
    (proxyManager && typeof proxyManager.fetch === 'function' ? (url, init) => proxyManager.fetch(url, init) : globalThis.fetch);
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(500, timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();
  try {
    // `duckduckgo.com` serves the pairing page; 403/404 also proves network reachability.
    const response = await fetchImpl(`${baseUrl}/sync/pairing`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'duckai-cpa/identity', accept: 'text/html' }
    });
    return { status: 'available', reason: `http:${response.status}`, checkedAt };
  } catch (error) {
    const message = String((error && error.message) || error);
    return { status: 'blocked', reason: `network: ${message}`, checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  buildPairingCode,
  parsePairingCode,
  buildPairingUrl,
  createRecoveryCode,
  decodeRecoveryCode,
  detectSyncTransport,
  generateChannelId,
  PAIRING_ERRORS,
  PAIRING_ORIGIN,
  PAIRING_URL_PREFIX
};
