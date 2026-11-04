/**
 * DuckDuckGo Sync account login + device registration (v2.8).
 *
 * Goal: make the gateway appear in the phone's DuckDuckGo "My Devices" list.
 *
 * Protocol (verified by Lead against a real account through proxy 10808; docs/SYNC-DEVICES.md):
 *   1. official recovery code = base64url(JSON({recovery:{user_id,secret}}))
 *   2. secretBytes     = base64urlDecode(secret)
 *      scopedPassword  = HKDF-SHA256(ikm=secretBytes, salt=utf8(userId), info="Main Key", 32)
 *      hashedPassword  = base64url(HKDF-SHA256(ikm=secretBytes, salt=utf8(userId), info="Password", 32))
 *   3. POST {base}/login
 *        { user_id, hashed_password, device_id,
 *          device_name: JWE(scopedPassword, kid="3party", name),
 *          device_type: JWE(scopedPassword, kid="3party", type),
 *          scope: "ai_chats" }                                    → 200 {token}
 *   4. GET  {base}/keys (Bearer)                                 → {keys:[{kid,purpose,encrypted_with,public_key,...}]}
 *   5. account_info key (purpose="account_info", encrypted_with="3party"); if missing create a 3072-bit
 *      RSA key, JWE-encrypt its private JWK with scopedPassword (kid=key uuid) and
 *      POST {base}/keys/purpose/account_info/set-if-absent {key:{...}}
 *   6. device info = createEnvelope(JSON({name,type}), account_info.public_key, {kid, typ:"device"})
 *      PATCH {base}/devices {updates:[{id:deviceId, info:envelope.payload}]} → 200
 *   7. GET  {base}/devices → {devices:[{id,credential_id,info}]}
 *
 * This module is transport/protocol only; api-core wires admin routes and persistence
 * (`identity.setSyncServer(...)`).
 */
import crypto from 'node:crypto';

import { base64urlEncode, encryptJwe, decryptJwe } from './jwe.js';
import { createEnvelope, decryptEnvelope, parseOfficialRecoveryCode, encodeOfficialRecoveryCode } from './pairing.js';

export const DEFAULT_SYNC_BASE_URL = 'https://sync.duckduckgo.com/sync';
export const DEFAULT_DEVICE_TYPE = 'browser';
/** Device name used by the default identity (`id_default`) — v2.9. */
export const DEFAULT_MAIN_DEVICE_NAME = 'DuckAI@main';
export const DEFAULT_TIMEOUT_MS = 30000;
export const ACCOUNT_INFO_PURPOSE = 'account_info';
export const AI_CHATS_PURPOSE = 'ai_chats';
export const CREDENTIAL_3PARTY = '3party';
export const CREDENTIAL_ACCOUNT_INFO = 'account_info';
export const MAX_BATCH_DEVICES = 50;

/** Sync client error with a stable code. */
export class SyncClientError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, hint?: string, detail?: unknown, httpStatus?: number, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SyncClientError';
    this.status = meta.status ?? 500;
    this.code = meta.code || 'sync_transport_unavailable';
    if (meta.hint !== undefined) this.hint = meta.hint;
    if (meta.detail !== undefined) this.detail = meta.detail;
    if (meta.httpStatus !== undefined) this.httpStatus = meta.httpStatus;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const now = () => Date.now();
const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * Default recognizable device name: `DuckCPA@<4 lowercase hex>` (easy to spot in "My Devices").
 * @returns {string}
 */
export function defaultDeviceName() {
  return `DuckCPA@${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Derive the Sync scoped password (KEK) and login password hash.
 * @param {{ userId: string, secret: string }} credentials `secret` is base64url (from the official recovery code)
 * @returns {{ secretBytes: Buffer, scopedPassword: Buffer, hashedPassword: string }}
 */
export function deriveSyncKeys({ userId, secret }) {
  if (typeof userId !== 'string' || !userId) {
    throw new SyncClientError('userId is required', { status: 400, code: 'invalid_recovery_code', hint: 'recovery code has no user_id' });
  }
  if (typeof secret !== 'string' || !secret) {
    throw new SyncClientError('secret is required', { status: 400, code: 'invalid_recovery_code', hint: 'recovery code has no secret' });
  }
  let secretBytes;
  try {
    secretBytes = Buffer.from(secret, 'base64url');
  } catch (error) {
    throw new SyncClientError('secret is not valid base64url', { status: 400, code: 'invalid_recovery_code', cause: error });
  }
  const salt = Buffer.from(userId, 'utf8');
  const scopedPassword = Buffer.from(crypto.hkdfSync('sha256', secretBytes, salt, Buffer.from('Main Key', 'utf8'), 32));
  const hashedPassword = base64urlEncode(Buffer.from(crypto.hkdfSync('sha256', secretBytes, salt, Buffer.from('Password', 'utf8'), 32)));
  return { secretBytes, scopedPassword, hashedPassword };
}

/** Extract userId/secret from an official recovery code. */
export function credentialsFromRecoveryCode(recoveryCode) {
  const parsed = parseOfficialRecoveryCode(recoveryCode);
  if (!parsed || !parsed.secret) {
    throw new SyncClientError('official recovery code is missing or malformed', {
      status: 400,
      code: 'invalid_recovery_code',
      hint: 'expected base64url(JSON({recovery:{user_id,secret}}))'
    });
  }
  return { userId: parsed.userId, secret: parsed.secret };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.keys)) return value.keys;
  if (value && Array.isArray(value.devices)) return value.devices;
  return [];
}

/**
 * Normalize `/devices` responses. The real service returns
 * `{devices:{entries:[{id,jwt_iat,name,type}], entries_v2:[{id,credential_id,info}]}}`;
 * tests/mocks may return `{devices:[...]}` or a bare array.
 * @param {any} body
 * @returns {Array<Record<string, any>>}
 */
function devicesFrom(body) {
  const container = body && typeof body === 'object' && body.devices !== undefined ? body.devices : body;
  if (Array.isArray(container)) return container.filter(Boolean);
  if (!container || typeof container !== 'object') return [];
  const legacy = Array.isArray(container.entries) ? container.entries.filter(Boolean) : [];
  const v2 = Array.isArray(container.entries_v2) ? container.entries_v2.filter(Boolean) : [];
  if (!v2.length) return legacy;
  const legacyById = new Map(legacy.map((entry) => [entry.id, entry]));
  return v2.map((entry) => ({ ...(legacyById.get(entry.id) || {}), ...entry }));
}

/**
 * DuckDuckGo Sync client (login + account_info key + device registration).
 */
export class SyncClient {
  /**
   * @param {{
   *   proxyManager?: { fetch: Function } | null,
   *   fetchImpl?: typeof fetch | null,
   *   logger?: any,
   *   baseUrl?: string,
   *   officialRecoveryCode?: string | null,
   *   deviceId?: string | null,
   *   deviceName?: string | null,
   *   deviceType?: string,
   *   timeoutMs?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_SYNC_BASE_URL).replace(/\/+$/, '');
    this.logger = options.logger || null;
    this.proxyManager = options.proxyManager || null;
    this._fetch =
      this.proxyManager && typeof this.proxyManager.fetch === 'function'
        ? (url, init) => this.proxyManager.fetch(url, init)
        : typeof options.fetchImpl === 'function'
          ? options.fetchImpl
          : (url, init) => fetch(url, init);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.officialRecoveryCode = options.officialRecoveryCode || null;
    this.deviceId = options.deviceId || null;
    this.deviceName = options.deviceName || null;
    this.deviceType = options.deviceType || DEFAULT_DEVICE_TYPE;

    this.userId = null;
    this.token = null;
    this.scopedPassword = null;
    this.hashedPassword = null;
    this.loggedIn = false;
    this.lastLoginAt = null;
    this.lastRegisteredAt = null;
    this.lastError = null;
    this.accountInfoKey = null;
    this.accountInfoPrivateKey = null;
    /** @type {{ userId: string, secret: string } | null} in-memory only (used for re-login after logout) */
    this._credentials = null;
    this._closed = false;
  }

  // ------------------------------------------------------------------ transport

  _url(pathname) {
    return `${this.baseUrl}${pathname}`;
  }

  /**
   * @param {string} pathname
   * @param {{ method?: string, token?: string | null, body?: any, headers?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, body: any, text: string }>}
   */
  async _request(pathname, options = {}) {
    if (this._closed) throw new SyncClientError('sync client is closed', { status: 503, code: 'sync_transport_unavailable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let response;
    try {
      response = await this._fetch(this._url(pathname), { method: options.method || 'GET', headers, body, signal: controller.signal });
    } catch (error) {
      this.lastError = { code: 'sync_transport_unavailable', message: String((error && error.message) || error), at: now() };
      throw new SyncClientError('sync request failed (network/transport)', {
        status: 503,
        code: 'sync_transport_unavailable',
        hint: 'check the outbound proxy (sync.duckduckgo.com must be reachable)',
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, text };
  }

  _mapAuthError(httpStatus, payload, fallbackCode) {
    const detail = payload && typeof payload === 'object' ? payload : undefined;
    const message = (detail && (detail.error || detail.message)) || `HTTP ${httpStatus}`;
    const code = httpStatus === 401 || httpStatus === 403 ? 'sync_unauthorized' : fallbackCode;
    const status = code === 'sync_unauthorized' ? 401 : 502;
    this.lastError = { code, message: String(message), at: now(), httpStatus };
    return new SyncClientError(String(message), { status, code, httpStatus, detail });
  }

  // ------------------------------------------------------------------ login

  /**
   * Login with an official recovery code (or explicit userId+secret).
   * @param {{
   *   recoveryCode?: string,
   *   userId?: string,
   *   secret?: string,
   *   deviceId?: string,
   *   deviceName?: string,
   *   deviceType?: string
   * }} [options]
   * @returns {Promise<{ ok: true, userId: string, token: string, jwt: string, deviceId: string, deviceName: string, deviceType: string, loginAt: number, expiresAt: number | null }>}
   */
  async login(options = {}) {
    let userId = options.userId || null;
    let secret = options.secret || null;
    const recoveryCode = options.recoveryCode || (!userId || !secret ? this.officialRecoveryCode : null);
    if ((!userId || !secret) && recoveryCode) {
      const credentials = credentialsFromRecoveryCode(recoveryCode);
      userId = userId || credentials.userId;
      secret = secret || credentials.secret;
    }
    if (!userId || !secret) {
      throw new SyncClientError('official DuckDuckGo recovery code is not configured', {
        status: 400,
        code: 'recovery_code_not_configured',
        hint: 'pair the phone first, or set config.sync.pairing.recoveryCode'
      });
    }
    const deviceId = options.deviceId || this.deviceId || crypto.randomUUID();
    const deviceName = options.deviceName || this.deviceName || defaultDeviceName();
    const deviceType = options.deviceType || this.deviceType || DEFAULT_DEVICE_TYPE;
    if (!isUuid(deviceId)) {
      throw new SyncClientError('deviceId must be a uuid', { status: 400, code: 'invalid_device', detail: deviceId });
    }
    const { scopedPassword, hashedPassword } = deriveSyncKeys({ userId, secret });
    const loginBody = {
      user_id: userId,
      hashed_password: hashedPassword,
      device_id: deviceId,
      device_name: encryptJwe(deviceName, scopedPassword, { kid: CREDENTIAL_3PARTY }),
      device_type: encryptJwe(deviceType, scopedPassword, { kid: CREDENTIAL_3PARTY }),
      scope: 'ai_chats'
    };
    const response = await this._request('/login', { method: 'POST', body: loginBody });
    if (!response || response.status === 401 || response.status === 403) {
      throw this._mapAuthError(response ? response.status : 401, response && response.body, 'sync_login_failed');
    }
    if (response.status < 200 || response.status >= 300) {
      throw this._mapAuthError(response.status, response.body, 'sync_login_failed');
    }
    let token = response.body && typeof response.body === 'object' ? response.body.token || response.body.jwt || null : null;
    if (!token) {
      this.lastError = { code: 'sync_login_failed', message: 'login response has no token', at: now() };
      throw new SyncClientError('sync login response has no token', { status: 502, code: 'sync_login_failed', detail: 'no token in response' });
    }
    this.userId = userId;
    this.token = token;
    this.scopedPassword = scopedPassword;
    this.hashedPassword = hashedPassword;
    this._credentials = { userId, secret };
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.deviceType = deviceType;
    this.loggedIn = true;
    this.lastLoginAt = now();
    this.lastError = null;
    this.logger?.info?.('[duck:sync] login ok', { userId, deviceId, deviceName });
    return {
      ok: true,
      userId,
      token,
      jwt: token,
      deviceId,
      deviceName,
      deviceType,
      loginAt: this.lastLoginAt,
      expiresAt: null
    };
  }

  /**
   * v2.17: create a brand-new DuckDuckGo Sync account for THIS device only (the equivalent of
   * the "Sync This Device Only" CTA in duck.ai: signUpForPairing -> POST /sync/signup).
   *
   * The gateway keeps the derived official recovery code so it can re-login after restarts and
   * (optionally) hand the code to other devices later.
   *
   * @param {{ userId?: string, secret?: string, deviceId?: string, deviceName?: string, deviceType?: string }} [options]
   * @returns {Promise<{ ok: true, userId: string, secret: string, recoveryCode: string, token: string, deviceId: string }>}
   */
  async signup(options = {}) {
    const userId = options.userId || crypto.randomUUID();
    const secret = options.secret || base64urlEncode(crypto.randomBytes(32));
    const deviceId = options.deviceId || this.deviceId || crypto.randomUUID();
    const deviceName = options.deviceName || this.deviceName || defaultDeviceName();
    const deviceType = options.deviceType || this.deviceType || DEFAULT_DEVICE_TYPE;
    if (!isUuid(deviceId)) {
      throw new SyncClientError('deviceId must be a uuid', { status: 400, code: 'invalid_device', detail: deviceId });
    }
    const { scopedPassword, hashedPassword } = deriveSyncKeys({ userId, secret });

    // duck.ai builds one RSA-3072 'ai_chats' key; its PKCS#8 DER is JWE-encrypted with the
    // scoped password (header kid = credential "3party"), and public_key is exported as a JWK.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
    const kid = crypto.randomUUID();
    // Browsers export RSA-OAEP JWKs with lg/use; Node's PEM->JWK export omits them, but the
    // Sync /signup endpoint validates keys[].public_key.alg (length 3-50) and use.
    const publicKeyJwk = {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'RSA-OAEP-256',
      use: 'enc',
      key_ops: ['encrypt']
    };
    const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const encryptedPrivateKey = encryptJwe(privateKeyDer, scopedPassword, { kid: CREDENTIAL_3PARTY });
    const keyRecord = {
      kid,
      purpose: AI_CHATS_PURPOSE,
      encrypted_with: CREDENTIAL_3PARTY,
      encrypted_private_key: encryptedPrivateKey,
      public_key: publicKeyJwk
    };
    // duck.ai `PV()` also spreads the device triple into the /signup body:
    // { device_id, device_name: JWE(name), device_type: JWE(type) } — omitting it yields
    // "Invalid $ARG->device_id. Length must be between 8 and 64 chars, was 0."
    const body = {
      user_id: userId,
      hashed_password: hashedPassword,
      credential_id: CREDENTIAL_3PARTY,
      keys: [keyRecord],
      device_id: deviceId,
      device_name: encryptJwe(deviceName, scopedPassword, { kid: CREDENTIAL_3PARTY }),
      device_type: encryptJwe(deviceType, scopedPassword, { kid: CREDENTIAL_3PARTY }),
      scope: 'ai_chats'
    };
    this.logger?.info?.('[duck:sync] signup (Sync This Device Only)', { userId, deviceName });
    const response = await this._request('/signup', { method: 'POST', body });
    if (!response || ((response.status < 200 || response.status >= 300) && response.status !== 409)) {
      const status = response ? response.status : 0;
      throw this._mapAuthError(status || 502, response && response.body, 'sync_signup_failed');
    }
    let token = response.body && typeof response.body === 'object' ? response.body.token || response.body.jwt || null : null;
    if (!token) {
      const loginResult = await this.login({ userId, secret, deviceId, deviceName, deviceType });
      token = loginResult.token;
    } else {
      this.userId = userId;
      this.token = token;
      this.scopedPassword = scopedPassword;
      this.hashedPassword = hashedPassword;
      this._credentials = { userId, secret };
      this.deviceId = deviceId;
      this.deviceName = deviceName;
      this.deviceType = deviceType;
      this.loggedIn = true;
      this.lastLoginAt = now();
      this.lastError = null;
    }
    const recoveryCode = encodeOfficialRecoveryCode({ userId, secret });
    this.logger?.info?.('[duck:sync] signup ok', { userId, deviceName });
    return { ok: true, userId, secret, recoveryCode, token, deviceId };
  }

  _requireLogin() {
    if (!this.loggedIn || !this.token) {
      throw new SyncClientError('sync client is not logged in', { status: 409, code: 'sync_not_logged_in', hint: 'call login() first' });
    }
    if (!this.scopedPassword) {
      throw new SyncClientError('sync session has no scoped password', { status: 409, code: 'sync_not_logged_in' });
    }
  }

  // ------------------------------------------------------------------ keys

  /** @returns {Promise<Array<Record<string, any>>>} */
  async getKeys() {
    this._requireLogin();
    const response = await this._request('/keys', { token: this.token });
    if (!response || response.status === 401 || response.status === 403) {
      throw this._mapAuthError(response ? response.status : 401, response && response.body, 'sync_unauthorized');
    }
    if (response.status < 200 || response.status >= 300) {
      throw this._mapAuthError(response.status, response.body, 'sync_register_failed');
    }
    return asArray(response.body).filter(Boolean);
  }

  /**
   * Pick the `account_info` key; prefers `encrypted_with:"3party"` with a private key decryptable by
   * our scoped password.
   * @param {Array<Record<string, any>>} keys
   * @returns {{ kid: string, publicKeyJwk: Record<string, any>, encryptedWith: string, record: Record<string, any> } | null}
   */
  findAccountInfoKey(keys) {
    const candidates = (Array.isArray(keys) ? keys : []).filter((key) => key && key.purpose === ACCOUNT_INFO_PURPOSE);
    if (!candidates.length) return null;
    const tryCandidate = (candidate) => {
      if (!candidate || !candidate.kid || !candidate.public_key) return null;
      if (candidate.encrypted_with !== CREDENTIAL_3PARTY) return null;
      if (candidate.encrypted_private_key && this.scopedPassword) {
        try {
          decryptJwe(candidate.encrypted_private_key, this.scopedPassword, { kid: CREDENTIAL_3PARTY });
        } catch {
          return null;
        }
      }
      return {
        kid: candidate.kid,
        publicKeyJwk: candidate.public_key,
        encryptedWith: candidate.encrypted_with || null,
        record: candidate
      };
    };
    const preferred = candidates.find((candidate) => candidate.encrypted_with === CREDENTIAL_3PARTY);
    const thirdParty = tryCandidate(preferred);
    if (thirdParty) return thirdParty;
    if (this.accountInfoKey && this.accountInfoKey.kid) return this.accountInfoKey;
    return null;
  }

  /**
   * Ensure an `account_info` key exists (creates a 3072-bit RSA key via set-if-absent when missing).
   * @returns {Promise<{ kid: string, publicKeyJwk: Record<string, any> }>}
   */
  async ensureAccountInfoKey() {
    this._requireLogin();
    const keys = await this.getKeys();
    const existing = this.findAccountInfoKey(keys);
    if (existing) {
      this.accountInfoKey = { kid: existing.kid, publicKeyJwk: existing.publicKeyJwk };
      return this.accountInfoKey;
    }
    this.logger?.info?.('[duck:sync] no account_info key; creating 3072-bit RSA key (set-if-absent)');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
    const kid = crypto.randomUUID();
    // Browsers export RSA-OAEP JWKs with lg/use; Node's PEM->JWK export omits them, but the
    // Sync /signup endpoint validates keys[].public_key.alg (length 3-50) and use.
    const publicKeyJwk = {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'RSA-OAEP-256',
      use: 'enc',
      key_ops: ['encrypt']
    };
    // Match the bundle (`c.L0(privateKey, scopedPassword, "3party")`): PKCS#8 DER bytes are encrypted
    // directly as the JWE plaintext. The key-record kid is the UUID while the JWE header kid is the
    // credential ("3party") — decryptJwe validates it.
    const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const encryptedPrivateKey = encryptJwe(privateKeyDer, this.scopedPassword, { kid: CREDENTIAL_3PARTY });
    const keyRecord = {
      kid,
      purpose: ACCOUNT_INFO_PURPOSE,
      encrypted_with: CREDENTIAL_3PARTY,
      encrypted_private_key: encryptedPrivateKey,
      public_key: publicKeyJwk
    };
    const response = await this._request(`/keys/purpose/${ACCOUNT_INFO_PURPOSE}/set-if-absent`, { method: 'POST', token: this.token, body: { key: keyRecord } });
    if (response && (response.status === 401 || response.status === 403)) {
      throw this._mapAuthError(response.status, response.body, 'sync_unauthorized');
    }
    if (response && response.status >= 200 && response.status < 300) {
      this.accountInfoKey = { kid, publicKeyJwk, privateKey, encryptedPrivateKey };
      return this.accountInfoKey;
    }
    // set-if-absent can race: another device may have created the key in parallel → re-read.
    const after = await this.getKeys().catch(() => []);
    const raced = this.findAccountInfoKey(after);
    if (raced) {
      this.accountInfoKey = { kid: raced.kid, publicKeyJwk: raced.publicKeyJwk };
      return this.accountInfoKey;
    }
    this.lastError = { code: 'sync_account_info_unavailable', message: `set-if-absent HTTP ${response ? response.status : 'n/a'}`, at: now() };
    throw new SyncClientError('could not create the Sync account_info key', {
      status: 502,
      code: 'sync_account_info_unavailable',
      httpStatus: response ? response.status : undefined,
      detail: response && response.body
    });
  }

  // ------------------------------------------------------------------ devices

  /** @returns {Promise<Array<{ id: string, credential_id?: string, info?: string }>>} */
  async listDevices() {
    this._requireLogin();
    const response = await this._request('/devices', { token: this.token });
    if (!response || response.status === 401 || response.status === 403) {
      throw this._mapAuthError(response ? response.status : 401, response && response.body, 'sync_unauthorized');
    }
    if (response.status < 200 || response.status >= 300) {
      throw this._mapAuthError(response.status, response.body, 'sync_register_failed');
    }
    return devicesFrom(response.body);
  }

  /**
   * Register one or more devices in a single PATCH (one login, one /keys lookup).
   * @param {Array<{ deviceId?: string, name?: string, deviceName?: string, type?: string }>} devices
   * @returns {Promise<{ ok: true, items: Array<{ ok: true, id: string, name: string, type: string, credential_id: string, info: string, registeredAt: number }>, devices: Array<any> }>}
   */
  async registerDevices(devices) {
    this._requireLogin();
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new SyncClientError('registerDevices requires a non-empty array', { status: 400, code: 'invalid_device', field: 'devices' });
    }
    if (devices.length > MAX_BATCH_DEVICES) {
      throw new SyncClientError(`too many devices in one batch (max ${MAX_BATCH_DEVICES})`, { status: 400, code: 'invalid_device', field: 'devices' });
    }
    const accountInfo = await this.ensureAccountInfoKey();
    const registeredAt = now();
    const items = [];
    // Real Sync service rules:
    //  - `PATCH /devices` accepts exactly one update per call;
    //  - a login token may only patch the device it logged in as (`403 forbidden_device` otherwise).
    // Therefore a "batch" = for each device: login as that device (unless already logged in as it),
    // then one PATCH for its info. One account_info key lookup is shared.
    for (const entry of devices) {
      if (!entry || typeof entry !== 'object') {
        throw new SyncClientError('device entries must be objects', { status: 400, code: 'invalid_device', field: 'devices' });
      }
      const deviceId = entry.deviceId || entry.id || this.deviceId || crypto.randomUUID();
      if (!isUuid(deviceId)) {
        throw new SyncClientError('deviceId must be a uuid', { status: 400, code: 'invalid_device', detail: deviceId });
      }
      const rawName = entry.deviceName ?? entry.name;
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : this.deviceName || defaultDeviceName();
      if (name.length > 100) {
        throw new SyncClientError('device name is too long (max 100 chars)', { status: 400, code: 'invalid_device', field: 'name' });
      }
      const type = entry.type || DEFAULT_DEVICE_TYPE;
      if (!this.loggedIn || !this.token || this.deviceId !== deviceId) {
        // PATCH is device-scoped: authenticate as the device we want to register.
        if (!this._credentials) {
          throw new SyncClientError('sync client is not logged in and has no credentials', { status: 409, code: 'sync_not_logged_in' });
        }
        await this.login({
          userId: this._credentials.userId,
          secret: this._credentials.secret,
          deviceId,
          deviceName: name,
          deviceType: type
        });
      }
      const envelope = createEnvelope(JSON.stringify({ name, type }), accountInfo.publicKeyJwk, {
        kid: accountInfo.kid,
        typ: 'device'
      });
      const patchResponse = await this._request('/devices', {
        method: 'PATCH',
        token: this.token,
        body: { updates: [{ id: deviceId, info: envelope.payload }] }
      });
      if (!patchResponse || patchResponse.status === 401 || patchResponse.status === 403) {
        const mapped = this._mapAuthError(patchResponse ? patchResponse.status : 401, patchResponse && patchResponse.body, 'sync_unauthorized');
        mapped.partial = items.slice();
        throw mapped;
      }
      if (patchResponse.status < 200 || patchResponse.status >= 300) {
        const mapped = this._mapAuthError(patchResponse.status, patchResponse.body, 'sync_register_failed');
        mapped.partial = items.slice();
        throw mapped;
      }
      this.deviceId = deviceId;
      this.deviceName = name;
      this.deviceType = type;
      items.push({ ok: true, id: deviceId, name, type, credential_id: CREDENTIAL_3PARTY, info: envelope.payload, registeredAt });
    }
    // The last registered device becomes this client's current device (used by listDevicesDetailed).
    const last = items[items.length - 1];
    if (last) {
      this.deviceId = last.id;
      this.deviceName = last.name;
      this.deviceType = last.type;
    }
    this.lastRegisteredAt = registeredAt;
    this.lastError = null;
    const latest = await this.listDevices().catch(() => []);
    this.logger?.info?.('[duck:sync] devices registered', { count: items.length, registeredAt });
    return { ok: true, items, devices: latest };
  }

  /**
   * Register this gateway device in the DuckDuckGo Sync account (single-device convenience wrapper).
   * @param {{ deviceId?: string, name?: string, type?: string }} [options]
   * @returns {Promise<{ ok: true, id: string, name: string, type: string, credential_id: string, info: string, devices: Array<any>, registeredAt: number }>}
   */
  async registerDevice(options = {}) {
    const result = await this.registerDevices([
      { deviceId: options.deviceId, name: options.name, type: options.type }
    ]);
    const item = result.items[0];
    return {
      ok: true,
      id: item.id,
      name: item.name,
      type: item.type,
      credential_id: item.credential_id,
      info: item.info,
      devices: result.devices,
      registeredAt: item.registeredAt
    };
  }

  /**
   * Decrypt the `account_info` private key (PKCS#8 DER) for device-info decryption.
   * Cached on the client; returns null when no usable 3party key is present.
   * @returns {Promise<crypto.KeyObject | null>}
   */
  async _accountInfoPrivateKey() {
    if (this.accountInfoPrivateKey) return this.accountInfoPrivateKey;
    const keys = await this.getKeys();
    // The account can expose several account_info records (e.g. a native/ddg record whose private
    // key is not a compact JWE plus the decryptable 3party record). Try every candidate instead of
    // trusting the first one, otherwise every device name decodes to null.
    const candidates = keys.filter((record) => record && record.purpose === CREDENTIAL_ACCOUNT_INFO && record.encrypted_private_key);
    candidates.sort((a, b) => Number(b.encrypted_with === CREDENTIAL_3PARTY) - Number(a.encrypted_with === CREDENTIAL_3PARTY));
    for (const record of candidates) {
      for (const options of [{ kid: CREDENTIAL_3PARTY }, undefined]) {
        try {
          const der = decryptJwe(record.encrypted_private_key, this.scopedPassword, options);
          this.accountInfoPrivateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
          return this.accountInfoPrivateKey;
        } catch {
          // try the next candidate/format
        }
      }
    }
    this.logger?.warn?.('[duck:sync] no decryptable account_info private key found', {
      candidates: candidates.map((record) => record.encrypted_with || null)
    });
    return null;
  }

  /**
   * Device list with readable names/types (decrypts each `info` envelope).
   * Never returns raw JWE: undecryptable entries have `name:null,type:null,decoded:false`.
   * @returns {Promise<Array<{ id: string, credential_id: string|null, jwt_iat: string|null, name: string|null, type: string|null, current: boolean, decoded: boolean, decryptable: boolean }>>}
   */
  async listDevicesDetailed() {
    this._requireLogin();
    const devices = await this.listDevices();
    const privateKey = await this._accountInfoPrivateKey();
    return devices.map((device) => {
      const id = device.id || null;
      const jwtIat = typeof device.jwt_iat === 'string' ? device.jwt_iat : null;
      const result = {
        id,
        credential_id: device.credential_id || null,
        jwt_iat: jwtIat,
        name: null,
        type: null,
        current: Boolean(this.deviceId && id === this.deviceId),
        decoded: false,
        decryptable: false
      };
      if (privateKey && device.info) {
        try {
          const info = JSON.parse(decryptEnvelope(device.info, privateKey));
          result.name = typeof info.name === 'string' ? info.name : null;
          result.type = typeof info.type === 'string' ? info.type : null;
          result.decoded = Boolean(result.name || result.type);
          result.decryptable = result.decoded;
        } catch {
          // Legacy/foreign credential: fall through to the legacy name/type JWE below.
        }
      }
      if (!result.decoded) {
        // Legacy device records store name/type as JWE(scopedPassword, kid="3party").
        for (const field of ['name', 'type']) {
          const raw = device[field];
          if (typeof raw !== 'string' || !raw.includes('.')) continue;
          try {
            const plain = decryptJwe(raw, this.scopedPassword, { kid: CREDENTIAL_3PARTY }).toString('utf8');
            if (plain) result[field] = plain;
          } catch {
            // keep null — never expose the encrypted blob
          }
        }
        result.decoded = Boolean(result.name || result.type);
        result.decryptable = result.decoded;
      }
      return result;
    });
  }

  /**
   * Best-effort logout of one device (cleans the entry from the phone's My Devices).
   * @param {string} deviceId
   */
  async logoutDevice(deviceId) {
    this._requireLogin();
    if (!isUuid(deviceId)) {
      throw new SyncClientError('deviceId must be a uuid', { status: 400, code: 'invalid_device', detail: deviceId });
    }
    const response = await this._request('/logout-device', { method: 'POST', token: this.token, body: { device_id: deviceId } });
    if (response && (response.status === 401 || response.status === 403)) {
      throw this._mapAuthError(response.status, response.body, 'sync_unauthorized');
    }
    if (response && response.status === 404) {
      return { ok: true, removed: false, httpStatus: 404 };
    }
    if (response && response.status >= 200 && response.status < 300) {
      const removed = response.body && typeof response.body.removed === 'boolean' ? response.body.removed : true;
      // The Sync service invalidates the session token after logout-device; the caller must re-login
      // for further calls (`logoutDevices` does this automatically).
      this.loggedIn = false;
      return { ok: true, removed, httpStatus: response.status };
    }
    throw new SyncClientError('logout-device failed', {
      status: 502,
      code: 'sync_logout_failed',
      httpStatus: response ? response.status : undefined,
      detail: response && response.body
    });
  }

  /** Re-login with the in-memory credentials after `logout-device` invalidated the token. */
  async _relogin() {
    if (!this._credentials) return false;
    try {
      await this.login({
        userId: this._credentials.userId,
        secret: this._credentials.secret,
        deviceId: this.deviceId || undefined,
        deviceName: this.deviceName || undefined,
        deviceType: this.deviceType || DEFAULT_DEVICE_TYPE
      });
      return true;
    } catch (error) {
      this.logger?.warn?.('[duck:sync] re-login failed', { error: String((error && error.message) || error) });
      return false;
    }
  }

  /**
   * Log out several devices. `POST /logout-device` invalidates the token, so the client logs in
   * again between calls (the endpoint has no batch form).
   * @param {string[]} deviceIds
   * @returns {Promise<{ ok: boolean, removed: string[], failed: Array<{ id: string, code: string, status?: number, httpStatus?: number }>, results: Array<{ id: string, ok: boolean, removed?: boolean, httpStatus?: number, code?: string }> }>}
   */
  async logoutDevices(deviceIds) {
    this._requireLogin();
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      throw new SyncClientError('logoutDevices requires a non-empty array', { status: 400, code: 'invalid_device', field: 'deviceIds' });
    }
    const removed = [];
    const failed = [];
    const results = [];
    for (const deviceId of deviceIds) {
      if (!isUuid(deviceId)) {
        failed.push({ id: deviceId, code: 'invalid_device', status: 400 });
        results.push({ id: deviceId, ok: false, code: 'invalid_device' });
        continue;
      }
      let attempt = 0;
      let settled = false;
      while (attempt < 2 && !settled) {
        attempt += 1;
        try {
          // A successful logout-device invalidates the session token; log in again before the next
          // id so every device gets its own POST instead of failing with sync_not_logged_in.
          if (!this.loggedIn || !this.token) {
            const relogged = await this._relogin();
            if (!relogged) throw new SyncClientError('sync session expired during logout batch', { status: 401, code: 'sync_unauthorized' });
          }
          const result = await this.logoutDevice(deviceId);
          // 404 = already gone: success, but it must not be reported as "removed".
          if (result.removed !== false) removed.push(deviceId);
          results.push({ id: deviceId, ok: true, removed: result.removed, httpStatus: result.httpStatus });
          settled = true;
        } catch (error) {
          const code = error && error.code;
          if ((code === 'sync_unauthorized' || code === 'sync_not_logged_in') && attempt === 1 && this._credentials) {
            const relogged = await this._relogin();
            if (relogged) continue;
          }
          failed.push({
            id: deviceId,
            code: code || 'sync_logout_failed',
            status: error && error.status,
            httpStatus: error && error.httpStatus
          });
          results.push({ id: deviceId, ok: false, code: code || 'sync_logout_failed', httpStatus: error && error.httpStatus });
          settled = true;
        }
      }
    }
    return { ok: failed.length === 0, removed, failed, results };
  }

  // ------------------------------------------------------------------ status

  /** Synchronous status for admin endpoints. */
  getStatus() {
    return {
      loggedIn: Boolean(this.loggedIn && this.token),
      userId: this.userId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      deviceType: this.deviceType,
      tokenPresent: Boolean(this.token),
      lastLoginAt: this.lastLoginAt,
      lastRegisteredAt: this.lastRegisteredAt,
      lastError: this.lastError ? { ...this.lastError } : null,
      baseUrl: this.baseUrl
    };
  }

  close() {
    this._closed = true;
    this.token = null;
    this.scopedPassword = null;
    this.hashedPassword = null;
    this._credentials = null;
    this.accountInfoPrivateKey = null;
    this.loggedIn = false;
  }
}

/**
 * Create a Sync client (no network; call `login()` explicitly).
 * @param {ConstructorParameters<typeof SyncClient>[0]} options
 */
export async function createSyncClient(options = {}) {
  return new SyncClient(options);
}

/**
 * Build an `onCompleted` handler for `PairingHost`: after a joiner pairing (official recovery code
 * received), log in and register this gateway device. Nothing runs for host/same_account outcomes.
 *
 * ```js
 * const autoRegister = createPairingAutoRegister({ syncClient, deviceId, deviceName });
 * const host = await createPairingHost({ ..., onCompleted: autoRegister });
 * // later: const result = await autoRegister.pending;
 * ```
 * @param {{
 *   syncClient: SyncClient,
 *   deviceId: string,
 *   deviceName?: string,
 *   type?: string,
 *   logger?: any,
 *   onRegistered?: (result: Record<string, any>) => any
 * }} options
 */
export function createPairingAutoRegister(options = {}) {
  const { syncClient } = options;
  if (!syncClient || typeof syncClient.login !== 'function') {
    throw new SyncClientError('syncClient is required', { status: 400, code: 'invalid_device' });
  }
  const deviceId = options.deviceId;
  const deviceName = options.deviceName || null;
  const type = options.type || DEFAULT_DEVICE_TYPE;
  const logger = options.logger || null;
  /** @type {Promise<Record<string, any>> | null} */
  const handler = (status) => {
    if (!status || status.completedAs !== 'joiner' || !status.recoveryCode) return null;
    const running = (async () => {
      const login = await syncClient.login({ recoveryCode: status.recoveryCode, deviceId, deviceName, deviceType: type });
      const registered = await syncClient.registerDevice({ deviceId, name: deviceName || login.deviceName, type });
      const result = {
        ok: true,
        userId: login.userId,
        deviceId,
        deviceName: registered.name,
        deviceType: type,
        registeredAt: registered.registeredAt,
        lastLoginAt: login.loginAt,
        device: registered
      };
      await options.onRegistered?.(result);
      return result;
    })();
    handler.pending = running;
    // Errors are surfaced via `handler.pending` and `syncClient.getStatus().lastError`; do not throw
    // into the PairingHost callback (it is synchronous and would drop the promise).
    running.catch((error) => logger?.warn?.('[duck:sync] auto device registration failed', { error: String((error && error.message) || error) }));
    return null;
  };
  handler.pending = null;
  return handler;
}

export default {
  SyncClient,
  SyncClientError,
  createSyncClient,
  createPairingAutoRegister,
  deriveSyncKeys,
  credentialsFromRecoveryCode,
  defaultDeviceName,
  parseOfficialRecoveryCode,
  DEFAULT_SYNC_BASE_URL,
  DEFAULT_DEVICE_TYPE,
  DEFAULT_MAIN_DEVICE_NAME,
  ACCOUNT_INFO_PURPOSE,
  CREDENTIAL_3PARTY,
  MAX_BATCH_DEVICES
};
