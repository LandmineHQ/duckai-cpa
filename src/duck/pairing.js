/**
 * DuckDuckGo Sync pairing host (v2.5) — fixes "扫二维码后绑定失败".
 *
 * Why the previous implementation always failed: `buildPairingCode()` only produced a local `code2`
 * QR payload. A real DuckDuckGo client, after scanning, talks to the Sync **exchange service**:
 * it opens a channel for itself and POSTs an encrypted `hello` into the *host* channel advertised by
 * the QR. Without a registered channel + host handshake there is nothing to connect to.
 *
 * This module implements the host side of that protocol (reverse-engineered from the duck.ai bundle
 * `pairing` modules, 2026-11-01):
 *
 *   base           : https://sync.duckduckgo.com/sync
 *   create channel : PUT    {base}/v2/exchange/<channelId>                     → 204
 *   read messages  : GET    {base}/v2/exchange/<channelId>/messages?after=<seq> → {messages:[{seq,version,payload}]}
 *   write messages : POST   {base}/v2/exchange/<channelId>/messages             → body {messages:[{version:"2",payload}]} (1–5)
 *
 *   envelope payload = [header, encKey, iv, ciphertext, tag].join(".")
 *     header = base64url(JSON { alg:"RSA-OAEP-256", enc:"A256GCM", typ, kid, iat })
 *     AES-256-GCM, 12B IV, 16B tag, AAD = base64url(header) as UTF-8
 *     encKey = RSA-OAEP-256(peerPublicKey, raw AES key)
 *
 *   host   : channelId(uuid v4) + RSA-OAEP 2048 key pair; QR = code2({version:"2",channel_id,public_key})
 *   scanner: opens own channel, POSTs encrypted hello {type,channel_id,public_key,version:"2"} to host
 *   host   : decrypts hello → replies hello to the scanner channel → exchange messages
 *
 * See docs/PAIRING-IMPL.md for what is verified end-to-end and what is intentionally out of scope.
 */
import crypto from 'node:crypto';

import { base64urlEncode, base64urlDecode } from './jwe.js';
import { buildPairingCode, parsePairingCode, PAIRING_ORIGIN } from './sync.js';

export const SYNC_BASE_URL = 'https://sync.duckduckgo.com/sync';
export const PAIRING_STATES = Object.freeze(['idle', 'waiting', 'hello', 'exchange', 'completed', 'failed', 'timeout']);
export const DEFAULT_PAIRING_OPTIONS = Object.freeze({
  syncBase: SYNC_BASE_URL,
  pollIntervalMs: 1000,
  idleTimeoutMs: 30000,
  timeoutMs: 300000,
  httpTimeoutMs: 30000,
  autoPoll: true
});
export const PAIRING_ERROR_CODES = Object.freeze([
  'network',
  'read_channel_lost',
  'write_channel_lost',
  'version_mismatch',
  'protocol_violation',
  'peer_key_changed',
  'sequence_gap',
  'self_scan',
  'timeout',
  'unavailable',
  'aborted',
  'invalid_argument'
]);

/** Pairing error with a stable code (mapped by the admin layer). */
export class PairingError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, httpStatus?: number, reason?: string, detail?: unknown, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PairingError';
    this.code = meta.code || 'protocol_violation';
    this.status = meta.status ?? 500;
    if (meta.httpStatus !== undefined) this.httpStatus = meta.httpStatus;
    this.reason = meta.reason || this.code;
    if (meta.detail !== undefined) this.detail = meta.detail;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Generate a channel-scoped RSA-OAEP-256 key pair (2048 bit) plus base64url SPKI public key. */
export function generateHostKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKey,
    privateKey,
    publicKeyBase64Url: base64urlEncode(spki)
  };
}

/**
 * Import a peer public key from base64url SPKI, JWK or an existing KeyObject.
 * @param {string | Record<string, any> | crypto.KeyObject} value
 */
export function importPublicKeyBase64Url(value) {
  if (value && typeof value === 'object' && value.type === 'public') return value;
  if (value && typeof value === 'object' && value.kty) return crypto.createPublicKey({ key: value, format: 'jwk' });
  if (typeof value !== 'string' || !value) throw new PairingError('peer public key must be a base64url SPKI string', { status: 400, code: 'invalid_argument' });
  const der = base64urlDecode(value);
  return crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
}

/**
 * Encode a DuckDuckGo Sync official recovery code:
 * `base64url(JSON({"recovery":{"user_id":...,"secret":...}}))`.
 * @param {{ userId: string, secret: string, format?: 'base64url'|'base64' }} params
 * @returns {string}
 */
export function encodeOfficialRecoveryCode({ userId, secret, format = 'base64url' }) {
  if (typeof userId !== 'string' || !userId || typeof secret !== 'string' || !secret) {
    throw new PairingError('userId and secret are required to encode a recovery code', { status: 400, code: 'invalid_argument' });
  }
  const payload = JSON.stringify({ recovery: { user_id: userId, secret } });
  return format === 'base64' ? Buffer.from(payload, 'utf8').toString('base64') : base64urlEncode(Buffer.from(payload, 'utf8'));
}

/**
 * Parse an official DuckDuckGo recovery code (base64 or base64url JSON). Tolerant of
 * `{recovery:{user_id,secret}}`, `{user_id,secret}` and raw JSON strings.
 * @param {string} code
 * @returns {{ userId: string, secret: string | null, raw: string } | null}
 */
export function parseOfficialRecoveryCode(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const raw = code.trim();
  /** @type {string[]} */
  const candidates = [];
  try {
    candidates.push(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(base64urlDecode(raw).toString('utf8'));
  } catch {
    /* ignore */
  }
  candidates.push(raw);
  for (const candidate of candidates) {
    let payload;
    try {
      payload = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== 'object') continue;
    const container = payload.recovery && typeof payload.recovery === 'object' ? payload.recovery : payload;
    const userId = typeof container.user_id === 'string' ? container.user_id : typeof container.userId === 'string' ? container.userId : null;
    const secret = typeof container.secret === 'string' ? container.secret : typeof container.key === 'string' ? container.key : null;
    if (userId) return { userId, secret, raw };
  }
  return null;
}

/**
 * Encrypt a plaintext string into the DuckDuckGo Sync v2 envelope payload.
 * @param {string} plaintext
 * @param {string | Record<string, any> | crypto.KeyObject} peerPublicKey
 * @param {{ kid?: string, typ?: string, iat?: number }} [options]
 * @returns {string} payload (5 dot-separated base64url segments)
 */
export function encryptPayload(plaintext, peerPublicKey, options = {}) {
  const publicKey = importPublicKeyBase64Url(peerPublicKey);
  const header = {
    alg: 'RSA-OAEP-256',
    enc: 'A256GCM',
    typ: options.typ || 'chat',
    kid: options.kid || '',
    iat: Number.isFinite(options.iat) ? options.iat : Math.floor(now() / 1000)
  };
  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(Buffer.from(headerB64, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return [headerB64, base64urlEncode(encKey), base64urlEncode(iv), base64urlEncode(ciphertext), base64urlEncode(tag)].join('.');
}

/**
 * Decrypt an envelope payload with the host private key.
 * @param {string} payload
 * @param {string | Record<string, any> | crypto.KeyObject} privateKey
 * @returns {string}
 */
export function decryptPayload(payload, privateKey) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 5) {
    throw new PairingError('envelope payload must have 5 segments', { status: 400, code: 'protocol_violation', reason: 'malformed' });
  }
  const [headerB64, encKeyB64, ivB64, ciphertextB64, tagB64] = parts;
  let header;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch (error) {
    throw new PairingError('envelope header is not valid JSON', { status: 400, code: 'protocol_violation', reason: 'malformed', cause: error });
  }
  if (header && header.alg !== 'RSA-OAEP-256') {
    throw new PairingError(`unsupported envelope alg "${header && header.alg}"`, { status: 400, code: 'protocol_violation', reason: 'unsupported_alg' });
  }
  if (header && header.enc !== 'A256GCM') {
    throw new PairingError(`unsupported envelope enc "${header && header.enc}"`, { status: 400, code: 'protocol_violation', reason: 'unsupported_enc' });
  }
  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      base64urlDecode(encKeyB64)
    );
  } catch (error) {
    throw new PairingError('envelope key cannot be decrypted (wrong key or malformed)', {
      status: 400,
      code: 'protocol_violation',
      reason: 'decrypt_failed',
      cause: error
    });
  }
  const iv = base64urlDecode(ivB64);
  const ciphertext = base64urlDecode(ciphertextB64);
  const tag = base64urlDecode(tagB64);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAAD(Buffer.from(headerB64, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new PairingError('envelope payload cannot be decrypted', { status: 400, code: 'protocol_violation', reason: 'decrypt_failed', cause: error });
  }
}

/**
 * Wrap a plaintext message into an exchange envelope.
 * @param {string} plaintext
 * @param {string | Record<string, any> | crypto.KeyObject} peerPublicKey
 * @param {{ kid?: string, typ?: string }} [options]
 * @returns {{ version: '2', payload: string }}
 */
export function createEnvelope(plaintext, peerPublicKey, options = {}) {
  return { version: '2', payload: encryptPayload(plaintext, peerPublicKey, options) };
}

/**
 * Decrypt an exchange envelope (`{version,payload}` or raw payload).
 * @param {{ version?: string, payload: string } | string} envelope
 * @param {string | Record<string, any> | crypto.KeyObject} privateKey
 * @returns {string}
 */
export function decryptEnvelope(envelope, privateKey) {
  const payload = typeof envelope === 'string' ? envelope : envelope && envelope.payload;
  const version = typeof envelope === 'string' ? null : envelope && envelope.version;
  if (version !== undefined && version !== null) {
    if (typeof version !== 'string' || !/^2(?:\.\d+)?$/.test(version)) {
      throw new PairingError(`unsupported envelope version "${version}"`, { status: 400, code: 'version_mismatch', reason: 'version_mismatch' });
    }
  }
  return decryptPayload(payload, privateKey);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Host side of the pairing handshake.
 */
export class PairingHost {
  /**
   * @param {{
   *   proxyManager?: { fetch: Function } | null,
   *   fetchImpl?: typeof fetch | null,
   *   logger?: any,
   *   syncBase?: string,
   *   pollIntervalMs?: number,
   *   idleTimeoutMs?: number,
   *   timeoutMs?: number,
   *   httpTimeoutMs?: number,
   *   autoPoll?: boolean,
   *   account?: { getRecoveryCode?: () => string | null, userId?: string, secret?: string } | null,
   *   onStateChange?: (status: Record<string, any>) => void,
   *   onCompleted?: (status: Record<string, any>) => void
   * }} [options]
   */
  constructor(options = {}) {
    this.syncBase = String(options.syncBase || DEFAULT_PAIRING_OPTIONS.syncBase).replace(/\/+$/, '');
    this.pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_PAIRING_OPTIONS.pollIntervalMs);
    this.idleTimeoutMs = Math.max(1000, Number(options.idleTimeoutMs) || DEFAULT_PAIRING_OPTIONS.idleTimeoutMs);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_PAIRING_OPTIONS.timeoutMs);
    this.httpTimeoutMs = Math.max(1000, Number(options.httpTimeoutMs) || DEFAULT_PAIRING_OPTIONS.httpTimeoutMs);
    this.autoPoll = options.autoPoll !== false;
    this.logger = options.logger || null;
    this.account = options.account || null;
    // Device identity advertised in the exchange (Duck.ai web is a "3party" client).
    this.deviceName = typeof options.deviceName === 'string' && options.deviceName ? options.deviceName : 'DuckAI CPA';
    this.ownKind = options.ownKind === 'ddg' ? 'ddg' : '3party';
    // v2.14: follow the peer's account instead of advertising our own (ask the phone for its code).
    this.preferPeerAccount = options.preferPeerAccount === true;
    this.exchangeInitiated = false;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.onCompleted = typeof options.onCompleted === 'function' ? options.onCompleted : null;
    this.proxyManager = options.proxyManager || null;
    this._fetch =
      this.proxyManager && typeof this.proxyManager.fetch === 'function'
        ? (url, init) => this.proxyManager.fetch(url, init)
        : typeof options.fetchImpl === 'function'
          ? options.fetchImpl
          : (url, init) => fetch(url, init);

    this.channelId = null;
    this.keyPair = null;
    this.publicKeyBase64Url = null;
    this.pairingCode = null;
    this.qrUrl = null;
    this.state = 'idle';
    /** @type {null | 'entry' | 'joiner_awaiting' | 'host_awaiting' | 'awaiting_confirmation'} */
    this.substate = null;
    this.peerChannelId = null;
    this.peerPublicKey64 = null;
    this.peerName = null;
    this.peerKind = null;
    this.peerUserId = null;
    this.lastSeq = 0;
    this.messages = [];
    this.endReason = null;
    this.endDetail = null;
    this.completedAs = null;
    /** Official DuckDuckGo recovery code received via `recovery_code_response` (joiner path). */
    this.receivedRecoveryCode = null;
    this.receivedRecoveryUserId = null;
    this.accountConflict = false;
    this.completion = null;
    this.startedAt = null;
    this.expiresAt = null;
    this.lastActivityAt = null;
    this._pollTimer = null;
    this._polling = false;
    this._closed = false;
    this._waiters = [];
    this._inFlight = null;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Register the exchange channel and (unless `autoPoll:false`) start polling.
   * @returns {Promise<{ channelId: string, pairingCode: string, url: string, qrUrl: string, publicKeyBase64Url: string, createdAt: number, expiresAt: number, syncBase: string }>}
   */
  async start() {
    if (this._closed || this.state !== 'idle') throw new PairingError('pairing host already started', { status: 409, code: 'invalid_argument' });
    this.channelId = crypto.randomUUID();
    this.keyPair = generateHostKeyPair();
    this.publicKeyBase64Url = this.keyPair.publicKeyBase64Url;
    const pairing = buildPairingCode({ channelId: this.channelId, publicKeyBase64Url: this.publicKeyBase64Url });
    this.pairingCode = pairing.code;
    this.qrUrl = pairing.url;
    this.startedAt = now();
    this.expiresAt = this.startedAt + this.timeoutMs;
    this.lastActivityAt = this.startedAt;

    const response = await this._request(this._channelUrl(this.channelId), { method: 'PUT' });
    if (!response.ok) {
      const httpStatus = response.status;
      this._terminate(httpStatus === 404 ? 'write_channel_lost' : 'network', httpStatus);
      throw new PairingError(`could not create pairing channel (HTTP ${httpStatus})`, {
        status: 502,
        code: httpStatus === 404 ? 'write_channel_lost' : 'network',
        httpStatus
      });
    }
    this.state = 'waiting';
    this._emitState();
    this.logger?.info?.('[duck:pairing] channel created', { channelId: this.channelId, httpStatus: response.status });
    if (this.autoPoll) this._schedulePoll(0);
    return {
      channelId: this.channelId,
      pairingCode: this.pairingCode,
      url: this.qrUrl,
      qrUrl: this.qrUrl,
      publicKeyBase64Url: this.publicKeyBase64Url,
      createdAt: this.startedAt,
      expiresAt: this.expiresAt,
      syncBase: this.syncBase
    };
  }

  /** Current status snapshot (safe to return through the admin API). */
  status() {
    return {
      state: this.state,
      substate: this.substate,
      channelId: this.channelId,
      peerChannelId: this.peerChannelId,
      peerPublicKey: this.peerPublicKey64,
      peerName: this.peerName || null,
      peerKind: this.peerKind || null,
      peerUserId: this.peerUserId || null,
      lastSeq: this.lastSeq,
      messages: this.messages.map((message) => ({ ...message })),
      endReason: this.endReason,
      endDetail: this.endDetail || null,
      completedAs: this.completedAs,
      // Joiner path: raw official DuckDuckGo recovery code (base64/base64url JSON) + parsed user id.
      recoveryCode: this.receivedRecoveryCode || null,
      recoveryUserId: this.receivedRecoveryUserId || null,
      recoveryCodeReceived: Boolean(this.receivedRecoveryCode),
      accountConflict: this.accountConflict === true,
      httpStatus: this.httpStatus ?? null,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      expiresInMs: this.expiresAt ? Math.max(0, this.expiresAt - now()) : null,
      qrUrl: this.qrUrl,
      pairingCode: this.pairingCode,
      accountAvailable: this._accountAvailable(),
      syncBase: this.syncBase
    };
  }

  /** Completion payload (also forwarded to `onCompleted`). */
  getCompletion() {
    return this.completion ? { ...this.completion } : null;
  }

  /** Whether a DuckDuckGo recovery code / account is configured (admin UI hint). */
  _accountAvailable() {
    if (!this.account) return false;
    return (
      typeof this.account.getRecoveryCode === 'function' ||
      (typeof this.account.recoveryCode === 'string' && this.account.recoveryCode.length > 0) ||
      typeof this.account.userId === 'string'
    );
  }

  /** Inject/clear the account (real DuckDuckGo recovery code) after construction. */
  setAccount(account) {
    this.account = account || null;
    return this;
  }

  /** Stop the pairing session (polling stops; status keeps the last state). */
  stop(reason = 'aborted') {
    if (this._isTerminal()) {
      this._closed = true;
      return this.status();
    }
    this._terminate(reason);
    this._closed = true;
    return this.status();
  }

  /** Alias for `stop()`. */
  close(reason = 'aborted') {
    return this.stop(reason);
  }

  /**
   * Resolve once the peer (scanner) has been seen; rejects on terminal failure/timeout.
   * @param {{ timeoutMs?: number }} [options]
   */
  async waitForPeer(options = {}) {
    if (this.peerChannelId) return this.status();
    if (this._isTerminal()) throw this._terminalError();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.idleTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removeWaiter(waiter);
        reject(new PairingError('timed out waiting for the scanning device', { status: 504, code: 'timeout', reason: 'timeout' }));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = {
        resolve: (status) => {
          clearTimeout(timer);
          resolve(status);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      this._waiters.push(waiter);
    });
  }

  /** One poll iteration (also usable directly in tests with `autoPoll:false`). */
  async pollOnce() {
    if (this._isTerminal() || this._closed) return this.status();
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._pollOnceInner().finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _pollOnceInner() {
    const current = now();
    if (this.startedAt && current - this.startedAt > this.timeoutMs) {
      this._terminate('timeout', undefined, 'max_session');
      return this.status();
    }
    let response;
    try {
      response = await this._request(this._messagesUrl(this.channelId, this.lastSeq), { method: 'GET' });
    } catch (error) {
      this.logger?.warn?.('[duck:pairing] poll failed', { error: String((error && error.message) || error) });
      if (current - this.lastActivityAt > this.idleTimeoutMs) this._terminate('timeout', undefined, 'idle');
      return this.status();
    }
    if (response.status === 404) {
      this._terminate('read_channel_lost', 404);
      return this.status();
    }
    if (!response.ok) {
      this.logger?.warn?.('[duck:pairing] poll http error', { httpStatus: response.status });
      if (current - this.lastActivityAt > this.idleTimeoutMs) this._terminate('timeout', undefined, 'idle');
      return this.status();
    }
    let body;
    try {
      body = await response.json();
    } catch {
      this.logger?.warn?.('[duck:pairing] poll returned invalid JSON');
      return this.status();
    }
    const rawMessages = body && Array.isArray(body.messages) ? body.messages : [];
    for (const item of rawMessages) {
      if (this._isTerminal()) break;
      const seq = Number(item && item.seq);
      const envelope = item && (item.envelope || { version: item.version, payload: item.payload });
      if (!Number.isFinite(seq) || !envelope || typeof envelope.payload !== 'string') {
        this._terminate('protocol_violation');
        break;
      }
      // Strictly sequential frames only: a gap means we cannot trust the transcript.
      if (seq !== this.lastSeq + 1) {
        this.logger?.warn?.('[duck:pairing] sequence gap — aborting', { expected: this.lastSeq + 1, received: seq });
        this._terminate('sequence_gap');
        break;
      }
      this.lastSeq = seq;
      this.lastActivityAt = now();
      let plaintext;
      try {
        plaintext = decryptEnvelope(envelope, this.keyPair.privateKey);
      } catch (error) {
        this._recordMessage('in', 'undecryptable', { seq, error: String(error && error.message) });
        this._terminate(error && error.code === 'version_mismatch' ? 'version_mismatch' : 'protocol_violation');
        break;
      }
      let message;
      try {
        message = JSON.parse(plaintext);
      } catch {
        this._recordMessage('in', 'unreadable', { seq });
        this._terminate('protocol_violation');
        break;
      }
      this._recordMessage('in', typeof message.type === 'string' ? message.type : 'malformed', { seq });
      await this._handleMessage(message);
    }
    return this.status();
  }

  // ------------------------------------------------------------------ inbound handling

  async _handleMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this._terminate('protocol_violation');
      return;
    }
    if (message.type === 'hello') return this._handleHello(message);
    if (!this.peerChannelId) {
      this._terminate('protocol_violation');
      return;
    }
    switch (message.type) {
      case 'recovery_code_request':
        return this._handleRecoveryCodeRequest(message);
      case 'recovery_code_available':
        return this._handleRecoveryCodeAvailable(message);
      case 'recovery_code_awaiting_confirmation':
        // Waiting for the peer/account confirmation; no reply, keep polling.
        this.state = 'exchange';
        this.substate = 'awaiting_confirmation';
        this._emitState();
        return;
      case 'recovery_code_confirmed':
        // The phone accepted the pairing prompt. It has NOT sent the recovery code yet: the
        // official app expects the requesting side to ask again after confirmation. Completing
        // here would report success without ever joining the account (no device shows up in
        // "My Devices"), so re-request the code instead.
        if (this.receivedRecoveryCode) {
          this._complete('completed', { completedAs: this.completedAs || 'joiner' });
          return;
        }
        this.state = 'exchange';
        this.substate = 'confirmed_requesting_code';
        this._emitState();
        await this._requestRecoveryCode();
        return;
      case 'recovery_code_denied':
        this._terminate('denied');
        return;
      case 'recovery_code_unavailable':
        this._terminate('unavailable');
        return;
      case 'recovery_code_response':
        // Joiner path: the peer (leader) sends the official recovery code after we advertised an account.
        return this._handleRecoveryCodeResponse(message);
      default:
        // Unknown message: tell the peer, then stop (do not silently continue).
        await this._safeSendToPeer({ type: 'protocol_error', reason: 'unknown_message', received: message.type });
        this._terminate('protocol_violation');
        return;
    }
  }

  async _handleHello(message) {
    if (typeof message.channel_id !== 'string' || !/^[0-9a-fA-F-]{16,64}$/.test(message.channel_id)) {
      this._terminate('protocol_violation');
      return;
    }
    if (typeof message.public_key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.public_key)) {
      this._terminate('protocol_violation');
      return;
    }
    const version = String(message.version || '');
    if (!/^2(?:\.\d+)?$/.test(version)) {
      this._terminate('version_mismatch');
      return;
    }
    // Self-scan: the browser detects it by channel id or key equality.
    if (message.channel_id === this.channelId || timingSafeEqualString(message.public_key, this.publicKeyBase64Url)) {
      this._terminate('self_scan');
      return;
    }
    if (this.peerChannelId) {
      if (message.channel_id !== this.peerChannelId || message.public_key !== this.peerPublicKey64) {
        this._terminate('peer_key_changed');
      }
      return;
    }
    this.peerChannelId = message.channel_id;
    this.peerPublicKey64 = message.public_key;
    this.state = 'hello';
    this._emitState();
    this.logger?.info?.('[duck:pairing] hello received', { peerChannelId: this.peerChannelId });
    // Important: Duck.ai's presenter (the side showing the QR) does NOT echo `hello` back.
    // It replies with its first exchange message instead (`recovery_code_request` when it has
    // no account, `recovery_code_available` when it has one). Echoing an unexpected `hello`
    // back makes the official app abort with "sync failed" before it can answer.
    this.state = 'exchange';
    this._emitState();
    await this._sendExchangeInit();
    if (this._isTerminal()) return;
    this._notifyPeerWaiters();
  }

  /**
   * Send the initial exchange message once. Without it the phone has nothing to answer and the
   * session times out (observed as "已连接，正在交换密钥…" then `sync failed` on the phone).
   */
  async _sendExchangeInit() {
    if (this.exchangeInitiated || !this.peerChannelId) return;
    this.exchangeInitiated = true;
    const account = await this._ownAccount();
    // v2.14: `preferPeerAccount` makes the presenter follow the *peer* account instead of
    // advertising its own. When the gateway already has a recovery code this is the difference
    // between "phone joins the gateway account" (available) and "gateway asks for the phone's
    // code and adopts it" (request). Asking is safer when both sides already have accounts.
    const useOwnAccount = !this.preferPeerAccount && Boolean(account && account.userId);
    const message = useOwnAccount
      ? { type: 'recovery_code_available', name: this.deviceName, kind: this.ownKind, user_id: account.userId }
      : { type: 'recovery_code_request', name: this.deviceName, kind: this.ownKind };
    this.substate = useOwnAccount ? 'host_available' : 'host_requested';
    this.logger?.info?.('[duck:pairing] sending exchange init', {
      type: message.type,
      kind: this.ownKind,
      preferPeerAccount: this.preferPeerAccount === true
    });
    await this._sendToPeer(message);
  }

  /**
   * Ask the peer for its official recovery code again (after the phone confirms the pairing
   * prompt). The official app only answers a request that arrives after the user confirmation.
   */
  async _requestRecoveryCode() {
    if (!this.peerChannelId) return;
    this.recoveryCodeRequests = (this.recoveryCodeRequests || 0) + 1;
    if (this.recoveryCodeRequests > 3) {
      this.logger?.warn?.('[duck:pairing] recovery code was not provided after repeated requests');
      return;
    }
    this.logger?.info?.('[duck:pairing] requesting recovery code from phone', { attempt: this.recoveryCodeRequests });
    // Soft send: the phone may already have closed its channel after the user confirmed while
    // its `recovery_code_response` is still in flight on OUR channel. A 404 here must not abort
    // the session — keep polling so the in-flight code is delivered.
    await this._softSendToPeer({
      type: 'recovery_code_request',
      name: this.deviceName,
      kind: this.ownKind
    });
  }

  /** Resolve our own sync account (official recovery code + user id) when configured. */
  async _ownAccount() {
    const code = await this._ownRecoveryCode();
    if (!code) return null;
    let userId = this.account && typeof this.account.userId === 'string' ? this.account.userId : null;
    if (!userId) {
      try {
        const parsed = parseOfficialRecoveryCode(code);
        if (parsed && parsed.userId) userId = parsed.userId;
      } catch {
        // ignore: fall back to request mode below
      }
    }
    return userId ? { recoveryCode: code, userId } : null;
  }

  async _handleRecoveryCodeRequest(message) {
    if (typeof message.name !== 'string' || !['ddg', '3party'].includes(message.kind)) {
      this._terminate('protocol_violation');
      return;
    }
    this.peerName = message.name;
    this.peerKind = message.kind;
    const recoveryCode = await this._ownRecoveryCode();
    if (!recoveryCode) {
      // We cannot create a DuckDuckGo account from the gateway, so honestly report unavailability.
      await this._safeSendToPeer({ type: 'recovery_code_unavailable' });
      this._terminate('unavailable');
      return;
    }
    const sent = await this._sendToPeer({ type: 'recovery_code_response', recovery_code: recoveryCode });
    if (!sent) return;
    this._complete('completed', { completedAs: 'host' });
  }

  async _handleRecoveryCodeAvailable(message) {
    if (typeof message.name !== 'string' || !['ddg', '3party'].includes(message.kind) || typeof message.user_id !== 'string') {
      this._terminate('protocol_violation');
      return;
    }
    this.peerName = message.name;
    this.peerKind = message.kind;
    this.peerUserId = message.user_id;
    const ownUserId = this.account && typeof this.account.userId === 'string' ? this.account.userId : null;
    if (ownUserId && ownUserId === message.user_id) {
      // Same account on both sides: the browser treats this as an already-synced success.
      this._complete('same_account', { completedAs: 'host' });
      return;
    }
    // Peer has an account and is willing to hand us a recovery code. In both cases (we have no
    // account, or a different one) the leader will send `recovery_code_response`; we must WAIT
    // instead of replying `recovery_code_unavailable` (the v2.5 bug that broke phone pairing).
    // If we still have not sent our own exchange message, ask for the code explicitly — the phone
    // answers a `recovery_code_request` with its official recovery code.
    if (!ownUserId && !this.exchangeInitiated) {
      await this._sendExchangeInit();
      if (this._isTerminal()) return;
    }
    this.state = 'exchange';
    this.substate = 'joiner_awaiting';
    this.accountConflict = Boolean(ownUserId && ownUserId !== message.user_id);
    this.logger?.info?.('[duck:pairing] peer has an account; waiting for recovery_code_response (joiner)', {
      peerUserId: message.user_id,
      accountConflict: this.accountConflict
    });
    this._emitState();
    // No outbound message on purpose.
  }

  /**
   * Joiner path: leader sent the official DuckDuckGo recovery code.
   * Format: base64/base64url(JSON({recovery:{user_id,secret}})) — we accept both, and tolerate
   * `{user_id,secret}` at the top level.
   * @param {{ type: string, recovery_code?: string }} message
   */
  async _handleRecoveryCodeResponse(message) {
    const code = typeof message.recovery_code === 'string' ? message.recovery_code.trim() : '';
    if (!code) {
      this._terminate('protocol_violation');
      return;
    }
    const parsed = parseOfficialRecoveryCode(code);
    this.receivedRecoveryCode = code;
    this.receivedRecoveryUserId = parsed ? parsed.userId : this.peerUserId || null;
    this.completedAs = 'joiner';
    this.logger?.info?.('[duck:pairing] official recovery code received (joiner)', {
      recoveryUserId: this.receivedRecoveryUserId,
      parsed: Boolean(parsed),
      accountConflict: this.accountConflict
    });
    // Acknowledge to the phone that the code was accepted; without this some clients keep
    // waiting on their confirmation screen even though the join already happened.
    try {
      await this._safeSendToPeer({ type: 'recovery_code_confirmed' });
    } catch {
      // best effort: the join already succeeded locally
    }
    this._complete('completed', {
      completedAs: 'joiner',
      recoveryCode: code,
      recoveryUserId: this.receivedRecoveryUserId
    });
  }

  // ------------------------------------------------------------------ outbound / transport

  async _ownRecoveryCode() {
    if (!this.account) return null;
    try {
      if (typeof this.account.getRecoveryCode === 'function') {
        const code = await this.account.getRecoveryCode();
        if (typeof code === 'string' && code) return code;
      }
      if (typeof this.account.recoveryCode === 'string' && this.account.recoveryCode) return this.account.recoveryCode;
      if (typeof this.account.userId === 'string' && typeof this.account.secret === 'string' && this.account.userId && this.account.secret) {
        return encodeOfficialRecoveryCode({ userId: this.account.userId, secret: this.account.secret });
      }
    } catch (error) {
      this.logger?.warn?.('[duck:pairing] account.getRecoveryCode failed', { error: String((error && error.message) || error) });
    }
    return null;
  }

  _envelopeForPeer(message) {
    const envelope = createEnvelope(JSON.stringify(message), this.peerPublicKey64, { kid: this.channelId });
    return { version: '2', payload: envelope.payload };
  }

  async _sendToPeer(message) {
    if (!this.peerChannelId || !this.peerPublicKey64) {
      this._terminate('protocol_violation');
      return false;
    }
    const envelope = this._envelopeForPeer(message);
    try {
      const response = await this._request(this._messagesUrl(this.peerChannelId, null), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [envelope] })
      });
      if (response.status === 404) {
        this._recordMessage('out', message.type, { httpStatus: 404 });
        this._terminate('write_channel_lost', 404);
        return false;
      }
      if (!response.ok) {
        this._recordMessage('out', message.type, { httpStatus: response.status });
        this._terminate('network', response.status);
        return false;
      }
      this._recordMessage('out', message.type, { httpStatus: response.status });
      this.lastActivityAt = now();
      return true;
    } catch (error) {
      this._recordMessage('out', message.type, { error: String((error && error.message) || error) });
      this._terminate('network');
      return false;
    }
  }

  async _safeSendToPeer(message) {
    if (!this.peerChannelId || !this.peerPublicKey64) return false;
    try {
      return await this._sendToPeer(message);
    } catch {
      return false;
    }
  }

  /**
   * Send without terminating on write errors. Used for advisory messages (e.g. re-requesting the
   * recovery code after the phone confirmed): the phone may already have closed its channel while
   * its final response is still in flight on our channel, so the session must keep polling.
   */
  async _softSendToPeer(message) {
    if (!this.peerChannelId || !this.peerPublicKey64) return false;
    try {
      const envelope = this._envelopeForPeer(message);
      const response = await this._request(this._messagesUrl(this.peerChannelId, null), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [envelope] })
      });
      this._recordMessage('out', message.type, { httpStatus: response.status, soft: true });
      if (!response.ok) {
        this.logger?.warn?.('[duck:pairing] advisory send failed (keep polling)', {
          type: message.type,
          httpStatus: response.status
        });
        return false;
      }
      this.lastActivityAt = now();
      return true;
    } catch (error) {
      this._recordMessage('out', message.type, { error: String((error && error.message) || error), soft: true });
      this.logger?.warn?.('[duck:pairing] advisory send error (keep polling)', {
        type: message.type,
        error: String((error && error.message) || error)
      });
      return false;
    }
  }

  _channelUrl(channelId) {
    return `${this.syncBase}/v2/exchange/${encodeURIComponent(channelId)}`;
  }

  _messagesUrl(channelId, afterSeq) {
    const base = `${this._channelUrl(channelId)}/messages`;
    if (afterSeq === null || afterSeq === undefined) return base;
    return `${base}?after=${encodeURIComponent(String(afterSeq))}`;
  }

  async _request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.httpTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await this._fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { accept: 'application/json', ...(init.headers || {}) }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ state helpers

  _recordMessage(dir, type, extra = {}) {
    this.messages.push({ dir, type, at: now(), ...extra });
    if (this.messages.length > 100) this.messages.shift();
  }

  _emitState() {
    try {
      this.onStateChange?.(this.status());
    } catch (error) {
      this.logger?.warn?.('[duck:pairing] onStateChange callback failed', { error: String((error && error.message) || error) });
    }
  }

  /**
   * Finish the pairing session successfully.
   * @param {string} [reason] `completed` | `same_account`
   * @param {{ completedAs?: 'host'|'joiner', recoveryCode?: string, recoveryUserId?: string }} [extras]
   */
  _complete(reason = 'completed', extras = {}) {
    this.state = 'completed';
    this.endReason = reason;
    if (extras.completedAs) this.completedAs = extras.completedAs;
    if (extras.recoveryCode) this.receivedRecoveryCode = extras.recoveryCode;
    if (extras.recoveryUserId) this.receivedRecoveryUserId = extras.recoveryUserId;
    if (this.substate === 'joiner_awaiting' || this.substate === 'awaiting_confirmation') this.substate = 'completed';
    this.completion = {
      completedAs: this.completedAs || null,
      // `recoveryCode` is the raw official DuckDuckGo recovery code; api-core persists it.
      recoveryCode: this.receivedRecoveryCode || null,
      recoveryUserId: this.receivedRecoveryUserId || null,
      peerUserId: this.peerUserId || null,
      peerName: this.peerName || null,
      peerKind: this.peerKind || null,
      accountConflict: this.accountConflict === true,
      endReason: reason,
      state: this.state,
      channelId: this.channelId,
      peerChannelId: this.peerChannelId
    };
    this._emitState();
    try {
      // Keep `recoveryCode`/`completedAs` at the top level (api-core contract).
      this.onCompleted?.({ ...this.status(), ...this.completion });
    } catch (error) {
      this.logger?.warn?.('[duck:pairing] onCompleted callback failed', { error: String((error && error.message) || error) });
    }
    this._notifyPeerWaiters();
    this._clearPollTimer();
  }

  _terminate(reason, httpStatus, detail) {
    if (this._isTerminal()) return;
    if (reason === 'timeout') this.state = 'timeout';
    else if (reason === 'completed' || reason === 'same_account') this.state = 'completed';
    else this.state = 'failed';
    this.endReason = reason;
    if (httpStatus !== undefined) this.endReason = `${reason}`;
    this.httpStatus = httpStatus;
    if (detail) this.endDetail = detail;
    this._clearPollTimer();
    this._emitState();
    this.logger?.warn?.('[duck:pairing] session ended', { reason, httpStatus, detail });
    const error = this._terminalError();
    for (const waiter of this._waiters.splice(0)) waiter.reject(error);
    this._waiters = [];
  }

  _isTerminal() {
    return this.state === 'completed' || this.state === 'failed' || this.state === 'timeout';
  }

  _terminalError() {
    const code = this.endReason === 'same_account' ? 'completed' : this.endReason || this.state;
    return new PairingError(`pairing session ended (${code})`, {
      status: this.state === 'timeout' ? 504 : 502,
      code,
      reason: this.endReason || this.state,
      httpStatus: this.httpStatus
    });
  }

  _notifyPeerWaiters() {
    if (!this.peerChannelId) return;
    for (const waiter of this._waiters.splice(0)) waiter.resolve(this.status());
  }

  _removeWaiter(waiter) {
    const index = this._waiters.indexOf(waiter);
    if (index !== -1) this._waiters.splice(index, 1);
  }

  _clearPollTimer() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _schedulePoll(delay = this.pollIntervalMs) {
    if (!this.autoPoll || this._closed || this._isTerminal() || this._pollTimer) return;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this._pollTick();
    }, Math.max(0, delay));
    if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
  }

  async _pollTick() {
    if (this._isTerminal() || this._closed) return;
    try {
      await this.pollOnce();
    } catch (error) {
      this.logger?.warn?.('[duck:pairing] poll iteration failed', { error: String((error && error.message) || error) });
    }
    if (!this._isTerminal() && !this._closed) {
      if (now() - this.lastActivityAt > this.idleTimeoutMs) {
        this._terminate('timeout', undefined, 'idle');
        return;
      }
      this._schedulePoll(this.pollIntervalMs);
    }
  }
}

/**
 * Create and start a pairing host.
 * @param {ConstructorParameters<typeof PairingHost>[0]} options
 * @returns {Promise<PairingHost & { startResult: Record<string, any> }>}
 */
export async function createPairingHost(options = {}) {
  const host = new PairingHost(options);
  const startResult = await host.start();
  host.startResult = startResult;
  return host;
}

/**
 * Decode a pairing URL/code into host info (used by tests / admin diagnostics).
 * @param {string} input
 */
export function parsePairingUrl(input) {
  const parsed = parsePairingCode(input);
  if (!parsed.ok) {
    throw new PairingError(`invalid pairing code (${parsed.detail})`, { status: 400, code: 'invalid_argument', reason: parsed.detail });
  }
  if (parsed.type === 'v1-pairing') throw new PairingError('legacy v1 pairing codes are not supported', { status: 400, code: 'version_mismatch' });
  if (parsed.type === 'recovery') throw new PairingError('recovery codes are not pairing URLs', { status: 400, code: 'invalid_argument' });
  return parsed.payload;
}

export { PAIRING_ORIGIN };

export default {
  PairingHost,
  PairingError,
  createPairingHost,
  createEnvelope,
  decryptEnvelope,
  encryptPayload,
  decryptPayload,
  generateHostKeyPair,
  importPublicKeyBase64Url,
  encodeOfficialRecoveryCode,
  parseOfficialRecoveryCode,
  parsePairingUrl,
  PAIRING_STATES,
  PAIRING_ERROR_CODES,
  DEFAULT_PAIRING_OPTIONS,
  SYNC_BASE_URL
};
