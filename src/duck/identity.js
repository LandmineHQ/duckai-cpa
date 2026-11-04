/**
 * Stable anonymous identity store for the duck.ai upstream (v2.2).
 *
 * Why this exists: duck.ai recognises an anonymous client through three loosely-coupled
 * mechanisms (see docs/IDENTITY-RESEARCH.md / docs/IDENTITY-SYNC.md §1):
 *   1. `x-ddg-journey-id`            32-hex, generated per page load by the browser → we persist it.
 *   2. durable-stream RSA-OAEP-256    public key sent in the chat body; private key never leaves
 *                                     the client → we persist the key pair and reuse the fingerprint.
 *   3. DuckDuckGo Sync `mainKey` +     recovery/pairing material → persisted locally so a gateway
 *      `encryptedPrivateKey` (JWE)     restart never changes the upstream-visible identity.
 *
 * `data/identity.json` is written atomically (temp file + rename), chmod 0600 where possible, and a
 * corrupt file is backed up as `identity.corrupt-<ts>.json` before being regenerated.
 *
 * Sensitive fields (`durableStream.privateKeyJwk`, `auth.token`) are never returned by
 * `getRedacted()`; only `getRaw()` (export/import) and `reveal()` expose them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { base64urlEncode, base64urlDecode, encryptJwe, decryptJwe } from './jwe.js';
import {
  buildPairingCode,
  buildPairingUrl,
  generateChannelId,
  parsePairingCode,
  createRecoveryCode,
  decodeRecoveryCode,
  detectSyncTransport,
  PAIRING_ERRORS
} from './sync.js';
import { AuthError, parseSubscriptionToken, verifySubscriptionOnline, entitlementsToTier } from './auth.js';

export const IDENTITY_VERSION = 1;
export const IDENTITY_FILE_NAME = 'identity.json';
export const DURABLE_STREAM_VERSION = '0.2.0';
export const DURABLE_STREAM_KEY_BITS = 2048;

const JOURNEY_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Unified error for the identity/sync/auth surface. */
export class IdentityError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, hint?: string, detail?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'IdentityError';
    this.status = meta.status ?? 400;
    this.code = meta.code ?? 'invalid_identity';
    if (meta.hint !== undefined) this.hint = meta.hint;
    if (meta.detail !== undefined) this.detail = meta.detail;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const now = () => Date.now();

/** @returns {string} 32 hex chars, duck.ai journey id format */
export function generateJourneyId() {
  return crypto.randomBytes(16).toString('hex');
}

/** @returns {string} uuid v4 */
export function generateDeviceId() {
  return crypto.randomUUID();
}

/**
 * Generate the durable-stream RSA-OAEP-256 key pair (duck.ai bundle module 2113909).
 * Public JWK is enriched the same way the browser stores it: `use:"enc"` (plus alg/ext/key_ops).
 * @returns {{ publicKeyJwk: Record<string, any>, privateKeyJwk: Record<string, any>, fingerprint: string, createdAt: number }}
 */
export function generateDurableStreamKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: DURABLE_STREAM_KEY_BITS,
    publicExponent: 0x10001
  });
  const publicKeyJwk = enrichPublicJwk(publicKey.export({ format: 'jwk' }));
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  return { publicKeyJwk, privateKeyJwk, fingerprint: durableStreamFingerprint(publicKeyJwk), createdAt: now() };
}

/** @param {Record<string, any>} jwk */
export function enrichPublicJwk(jwk) {
  return {
    ...jwk,
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['encrypt'],
    use: 'enc'
  };
}

/**
 * sha256(SPKI DER) first 32 hex chars — stable identifier of the durable-stream public key.
 * @param {Record<string, any>} publicKeyJwk
 */
export function durableStreamFingerprint(publicKeyJwk) {
  const key = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/** base64url of the SPKI DER (the `public_key` form used in v2 pairing codes). */
export function publicKeySpkiBase64Url(publicKeyJwk) {
  const key = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  return base64urlEncode(key.export({ type: 'spki', format: 'der' }));
}

/** @param {unknown} value @param {string} field @param {string} [code] */
function assert(condition, message, code = 'invalid_identity', field = '') {
  if (condition) return;
  throw new IdentityError(message, { status: 400, code, detail: field || undefined });
}

function deepClone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {{
 *   dataDir?: string,
 *   config?: Record<string, any>,
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function } | null,
 *   sync?: { transport?: 'available'|'blocked', fetchImpl?: typeof fetch, timeoutMs?: number },
 *   hostname?: string
 * }} [options]
 */
export class IdentityStore {
  constructor(options = {}) {
    const config = options.config || {};
    const configuredDir = options.dataDir || config.dataDir || config.identityDir || config.identity?.dir;
    this.dataDir = path.resolve(configuredDir || path.join(process.cwd(), 'data'));
    this.filePath = path.join(this.dataDir, IDENTITY_FILE_NAME);
    this.config = config;
    this.logger = options.logger || null;
    this.syncOptions = options.sync || {};
    this.hostname = options.hostname || os.hostname();
    this._identity = null;
    this._source = 'generated';
    this._ready = false;
    this._initPromise = null;
    this._writeLock = null;
    this._fileInfo = { path: this.filePath, bytes: 0, updatedAt: null };
    this._transportCache = null;
    /** @type {{ enabled?: boolean, fetch?: Function } | null} injected by DuckClient (v2.3) */
    this.proxyManager = null;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Load or create `data/identity.json`. Idempotent and safe to call concurrently. */
  async init() {
    if (this._ready) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
      let loaded = null;
      let source = 'file';
      try {
        const raw = await fs.readFile(this.filePath, 'utf8');
        loaded = JSON.parse(raw);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          source = 'generated';
        } else {
          // Corrupt file: keep a copy for forensics, then rebuild.
          const corruptPath = path.join(this.dataDir, `identity.corrupt-${now()}.json`);
          try {
            await fs.rename(this.filePath, corruptPath);
            source = 'recovered';
            this.logger?.warn?.('[duck:identity] identity.json is corrupt, moved aside and regenerated', { corruptPath, error: String(error && error.message) });
          } catch (renameError) {
            source = 'generated';
            this.logger?.error?.('[duck:identity] failed to back up corrupt identity.json', renameError);
          }
          loaded = null;
        }
      }

      if (loaded) {
        try {
          this._identity = this._normalizeIdentity(loaded);
          this._source = source;
        } catch (error) {
          const corruptPath = path.join(this.dataDir, `identity.corrupt-${now()}.json`);
          await fs.rename(this.filePath, corruptPath).catch(() => {});
          this.logger?.warn?.('[duck:identity] identity.json failed validation, regenerated', { corruptPath, error: String(error && error.message) });
          this._identity = this._defaultIdentity();
          this._source = 'recovered';
          await this._persist();
        }
      } else {
        this._identity = this._defaultIdentity();
        this._source = source;
        await this._persist();
      }

      // Backfill fields added in newer versions (conversationId / durableStream / sync / auth).
      let changed = false;
      if (!this._identity.conversationId) {
        this._identity.conversationId = generateDeviceId();
        changed = true;
      }
      if (!this._identity.durableStream || !this._identity.durableStream.publicKeyJwk || !this._identity.durableStream.privateKeyJwk) {
        this._identity.durableStream = { version: DURABLE_STREAM_VERSION, ...generateDurableStreamKeyPair() };
        changed = true;
      }
      if (!this._identity.sync) {
        this._identity.sync = this._defaultSync();
        changed = true;
      }
      if (!this._identity.auth) {
        this._identity.auth = this._defaultAuth();
        changed = true;
      }
      if (changed) await this._persist();

      // Populate file metadata for existing files (admin API `identity.file`).
      if (!changed) {
        const stat = await fs.stat(this.filePath).catch(() => null);
        this._fileInfo = { path: this.filePath, bytes: stat ? stat.size : 0, updatedAt: stat ? stat.mtimeMs : null };
      }

      this._ready = true;
      this.logger?.info?.('[duck:identity] identity ready', {
        source: this._source,
        journeyId: this._identity.journeyId,
        fingerprint: this._identity.durableStream.fingerprint
      });
      return this;
    })().catch((error) => {
      this._initPromise = null;
      throw error;
    });
    return this._initPromise;
  }

  /** @returns {Record<string, any>} */
  _defaultIdentity() {
    return createIdentityRecord({ deviceName: `DuckAI CPA @ ${this.hostname}`, hostname: this.hostname });
  }

  _defaultSync() {
    return defaultSyncRecord();
  }

  _defaultAuth() {
    return defaultAuthRecord();
  }

  /** Validate + normalize an imported identity object. */
  _normalizeIdentity(candidate) {
    return normalizeIdentityRecord(candidate, { hostname: this.hostname });
  }

  /** Atomic write of the full identity object. */
  async _persist() {
    const payload = JSON.stringify(this._identity, null, 2);
    const tempPath = `${this.filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
    await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => {});
    const stat = await fs.stat(this.filePath).catch(() => null);
    this._fileInfo = { path: this.filePath, bytes: stat ? stat.size : Buffer.byteLength(payload), updatedAt: stat ? stat.mtimeMs : now() };
  }

  /** Serialize mutations; concurrent mutation → identity_busy (409) as documented. */
  async _mutate(fn) {
    if (this._writeLock) {
      throw new IdentityError('another identity mutation is already in progress', { status: 409, code: 'identity_busy' });
    }
    let release;
    this._writeLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await this.init();
      const result = await fn();
      await this._persist();
      return result;
    } finally {
      this._writeLock = null;
      release();
    }
  }

  // ------------------------------------------------------------------ readers

  /** @returns {'file'|'generated'|'recovered'} */
  get source() {
    return this._source;
  }

  getJourneyId() {
    return this._identity ? this._identity.journeyId : null;
  }

  getConversationId() {
    return this._identity ? this._identity.conversationId : null;
  }

  getDeviceId() {
    return this._identity ? this._identity.deviceId : null;
  }

  getDeviceName() {
    return this._identity ? this._identity.deviceName || null : null;
  }

  /** Public JWK only (safe to send upstream). */
  getDurableStreamPublicKey() {
    return this._identity ? deepClone(this._identity.durableStream.publicKeyJwk) : null;
  }

  /** @returns {{ publicKeyJwk: Record<string, any>, fingerprint: string, version: string } | null} */
  getDurableStream() {
    if (!this._identity) return null;
    return {
      publicKeyJwk: deepClone(this._identity.durableStream.publicKeyJwk),
      fingerprint: this._identity.durableStream.fingerprint,
      version: this._identity.durableStream.version
    };
  }

  /**
   * Token for the `Authorization` header. Expired tokens are never returned.
   * @returns {{ token: string | null, expired: boolean, tier: string, expiresAt: string | null }}
   */
  getAuthToken() {
    const auth = this._identity?.auth || this._defaultAuth();
    if (!auth.token) return { token: null, expired: false, tier: auth.tier || 'free', expiresAt: auth.expiresAt || null };
    const expiresAtMs = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now() : true;
    return {
      token: expired ? null : auth.token,
      expired,
      tier: auth.tier || 'free',
      expiresAt: auth.expiresAt || null
    };
  }

  /** Full identity clone (includes privateKeyJwk + token) — export/import only. */
  getRaw() {
    return deepClone(this._identity);
  }

  getFileInfo() {
    return { ...this._fileInfo };
  }

  /** Redacted view used by the admin API (no private key / token). */
  getRedacted() {
    const identity = this._identity;
    if (!identity) {
      return { stable: false, source: 'uninitialized' };
    }
    const auth = identity.auth || this._defaultAuth();
    const expiresAtMs = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now() : Boolean(auth.token);
    const sync = identity.sync || this._defaultSync();
    return {
      journeyId: identity.journeyId,
      conversationId: identity.conversationId,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      createdAt: identity.createdAt,
      rotatedAt: identity.rotatedAt,
      version: identity.version,
      stable: true,
      source: this._source,
      durableStream: {
        fingerprint: identity.durableStream.fingerprint,
        publicKeyJwk: deepClone(identity.durableStream.publicKeyJwk),
        hasPrivateKey: Boolean(identity.durableStream.privateKeyJwk),
        version: identity.durableStream.version,
        createdAt: identity.durableStream.createdAt
      },
      auth: {
        authenticated: Boolean(auth.token) && !expired,
        email: auth.email || null,
        tier: expired ? 'free' : auth.tier || 'free',
        entitlements: deepClone(auth.entitlements || []),
        expiresAt: auth.expiresAt || null,
        activatedAt: auth.activatedAt || null,
        expired,
        verified: Boolean(auth.verified),
        verifyError: auth.verifyError || null,
        tokenHash: auth.tokenHash || null
      },
      sync: {
        enabled: Boolean(sync.enabled),
        deviceCount: Array.isArray(sync.devices) ? sync.devices.length : 0,
        devices: Array.isArray(sync.devices)
          ? sync.devices.map((device) => ({ id: device.id, name: device.name, type: device.type, thisDevice: device.id === identity.deviceId }))
          : [],
        lastSyncAt: sync.lastSyncAt || null,
        hasPairingCode: Boolean(sync.pairingCode),
        hasRecoveryCode: Boolean(sync.recoveryCode),
        recoveryCodePreview: sync.recoveryCode ? `${String(sync.recoveryCode).slice(0, 6)}…${String(sync.recoveryCode).slice(-4)}` : null
      },
      file: this.getFileInfo()
    };
  }

  /** Compact identity summary for `DuckClient.health()`. */
  getSummary() {
    const redacted = this.getRedacted();
    return {
      journeyId: redacted.journeyId || null,
      fingerprint: redacted.durableStream?.fingerprint || null,
      conversationId: redacted.conversationId || null,
      deviceId: redacted.deviceId || null,
      stable: redacted.stable !== false,
      source: redacted.source,
      authTier: redacted.auth?.tier || 'free',
      authenticated: Boolean(redacted.auth?.authenticated),
      authExpired: Boolean(redacted.auth?.expired),
      syncEnabled: Boolean(redacted.sync?.enabled)
    };
  }

  /** @param {'token'|'mainKey'|'scopedPasswordSeed'|'privateKeyJwk'} field */
  reveal(field) {
    const identity = this._identity;
    if (!identity) return null;
    switch (field) {
      case 'token':
        return identity.auth?.token || null;
      case 'mainKey':
        return identity.sync?.mainKey || null;
      case 'scopedPasswordSeed':
        return identity.sync?.scopedPasswordSeed || null;
      case 'privateKeyJwk':
        return deepClone(identity.durableStream.privateKeyJwk);
      default:
        throw new IdentityError(`unknown reveal field "${field}"`, { status: 400, code: 'invalid_identity', detail: 'reveal_field' });
    }
  }

  // ------------------------------------------------------------------ rotation / export / import

  /**
   * Rotate identity material. `journey` only changes the journey id; `device` regenerates the
   * device id, conversation id and durable-stream key pair; `all` does both.
   * @param {'journey'|'device'|'all'} [scope]
   */
  async rotate(scope = 'journey') {
    const normalized = scope === true ? 'all' : String(scope || 'journey');
    if (!['journey', 'device', 'all'].includes(normalized)) {
      throw new IdentityError(`unsupported rotate scope "${scope}"`, { status: 400, code: 'invalid_identity', detail: 'rotate_scope' });
    }
    return this._mutate(async () => {
      if (normalized === 'journey' || normalized === 'all') {
        this._identity.journeyId = generateJourneyId();
      }
      if (normalized === 'device' || normalized === 'all') {
        this._identity.deviceId = generateDeviceId();
        this._identity.conversationId = generateDeviceId();
        this._identity.durableStream = { version: DURABLE_STREAM_VERSION, ...generateDurableStreamKeyPair() };
      }
      this._identity.rotatedAt = now();
      return this.getRedacted();
    });
  }

  /**
   * Persist a human-friendly device name (v2.8/v2.9). Used for `DuckAI@main` / `DuckCPA@<4hex>`
   * defaults and DuckDuckGo Sync device registration.
   * @param {string} name 1–100 characters after trim
   */
  async setDeviceName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 100) {
      throw new IdentityError('deviceName must be a non-empty string (max 100 chars)', { status: 400, code: 'invalid_identity', detail: 'deviceName' });
    }
    return this._mutate(async () => {
      this._identity.deviceName = value;
      this._identity.rotatedAt = now();
      return { deviceName: value, identity: this.getRedacted() };
    });
  }

  /**
   * Persist the DuckDuckGo Sync server registration result (v2.8) under `identity.sync.server`.
   * Only known fields are kept; omitted fields preserve the previous value.
   * @param {{ userId?: string, deviceId?: string, deviceName?: string, registeredAt?: number, lastLoginAt?: number } | null} server
   */
  async setSyncServer(server) {
    if (server !== null && (typeof server !== 'object' || Array.isArray(server))) {
      throw new IdentityError('sync.server must be an object or null', { status: 400, code: 'invalid_identity', detail: 'sync.server' });
    }
    const patch = {};
    if (server) {
      for (const field of ['userId', 'deviceId', 'deviceName']) {
        if (server[field] !== undefined) {
          if (typeof server[field] !== 'string' || !server[field]) {
            throw new IdentityError(`sync.server.${field} must be a non-empty string`, { status: 400, code: 'invalid_identity', detail: `sync.server.${field}` });
          }
          patch[field] = server[field];
        }
      }
      for (const field of ['registeredAt', 'lastLoginAt']) {
        if (server[field] !== undefined) {
          const value = Number(server[field]);
          if (!Number.isFinite(value)) {
            throw new IdentityError(`sync.server.${field} must be a timestamp`, { status: 400, code: 'invalid_identity', detail: `sync.server.${field}` });
          }
          patch[field] = value;
        }
      }
    }
    return this._mutate(async () => {
      if (server === null) {
        this._identity.sync.server = null;
      } else {
        this._identity.sync.server = { ...(this._identity.sync.server || {}), ...patch };
      }
      return { server: this._identity.sync.server, identity: this.getRedacted() };
    });
  }

  /** Full export document (contains private key + token). */
  exportIdentity() {
    return { version: IDENTITY_VERSION, exportedAt: now(), identity: this.getRaw() };
  }

  /**
   * Replace the identity from an export document (or a raw identity object).
   * Validates before swapping; on failure the previous identity is kept.
   * @param {{ identity?: Record<string, any> } | Record<string, any>} document
   */
  async importIdentity(document) {
    const candidate = document && typeof document === 'object' && document.identity ? document.identity : document;
    const normalized = this._normalizeIdentity(candidate);
    return this._mutate(async () => {
      this._identity = normalized;
      this._source = 'file';
      return this.getRedacted();
    });
  }

  // ------------------------------------------------------------------ Sync & Backup

  /**
   * Inject the outbound fetch used by sync transport probing / subscription verification
   * (DuckClient passes the proxy-aware fetch in v2.3).
   * @param {typeof fetch | null} fetchImpl
   */
  setFetchImpl(fetchImpl) {
    this.syncOptions.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this._transportCache = null;
    return this;
  }

  /**
   * Inject the proxy manager; when set, sync transport probing goes through the proxy and
   * `transport` reports `blocked/proxy_disabled` while the proxy is off.
   * @param {{ enabled?: boolean, fetch?: Function } | null} proxyManager
   */
  setProxyManager(proxyManager) {
    this.proxyManager = proxyManager || null;
    this._transportCache = null;
    return this;
  }

  /** Force re-detection of the sync transport (e.g. after enabling the proxy). */
  async refreshTransport(options = {}) {
    this._transportCache = null;
    const transport = await this._transport({ ...options, force: true });
    if (this.proxyManager && typeof this.proxyManager.test === 'function' && transport.status === 'available') {
      // keep the manager status fresh for `/healthz`
      try {
        await this.proxyManager.test();
      } catch {
        /* best effort */
      }
    }
    return transport;
  }

  /** @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, force?: boolean, ignoreOverride?: boolean }} [options] */
  async _transport(options = {}) {
    // An explicitly configured transport (`options.sync.transport`) is a manual/test override and
    // wins over probing, including on forced refresh; production never sets it.
    if (this.syncOptions.transport && options.ignoreOverride !== true) {
      return { status: this.syncOptions.transport, reason: 'configured', checkedAt: now() };
    }
    if (!options.force && this._transportCache && now() - this._transportCache.checkedAt < 30000) {
      return this._transportCache;
    }
    const proxyManager = this.proxyManager || null;
    if (proxyManager && typeof proxyManager.getSummary === 'function') {
      const summary = proxyManager.getSummary();
      if (!summary || !summary.enabled) {
        const blocked = { status: 'blocked', reason: 'proxy_disabled', checkedAt: now() };
        this._transportCache = blocked;
        return blocked;
      }
    }
    const result = await detectSyncTransport({
      timeoutMs: options.timeoutMs ?? this.syncOptions.timeoutMs ?? 3000,
      fetchImpl: options.fetchImpl || this.syncOptions.fetchImpl,
      proxyManager
    });
    this._transportCache = result;
    return result;
  }

  /** @returns {Promise<Record<string, any>>} redacted sync status */
  async getSync(options = {}) {
    await this.init();
    const sync = this._identity.sync;
    const transport = await this._transport(options);
    return {
      enabled: Boolean(sync.enabled),
      userId: sync.userId || null,
      deviceId: this._identity.deviceId,
      deviceName: this._identity.deviceName,
      deviceCount: Array.isArray(sync.devices) ? sync.devices.length : 0,
      devices: Array.isArray(sync.devices)
        ? sync.devices.map((device) => ({ id: device.id, name: device.name, type: device.type, thisDevice: device.id === this._identity.deviceId }))
        : [],
      lastSyncAt: sync.lastSyncAt || null,
      // v2.16: DuckDuckGo Sync & Backup modes: "backup" (default) or "syncOnly" (no server
      // backup / recovery code is not persisted; devices must re-pair after a restart).
      mode: sync.mode === 'syncOnly' ? 'syncOnly' : 'backup',
      transport: transport.status,
      transportReason: transport.reason,
      hasPairingCode: Boolean(sync.pairingCode),
      pairingCode: sync.pairingCode
        ? {
            code: sync.pairingCode.code,
            url: sync.pairingCode.url || buildPairingUrl(sync.pairingCode.code),
            channelId: sync.pairingCode.channelId,
            publicKey: sync.pairingCode.publicKey,
            createdAt: sync.pairingCode.createdAt,
            expiresAt: sync.pairingCode.expiresAt
          }
        : null,
      hasRecoveryCode: Boolean(sync.recoveryCode),
      recoveryCodePreview: sync.recoveryCode ? `${String(sync.recoveryCode).slice(0, 6)}…${String(sync.recoveryCode).slice(-4)}` : null
    };
  }

  /**
   * Enable Sync & Backup: derive the locally-held key material and return the recovery code
   * (only this call returns the full value).
   * @param {{ deviceName?: string }} [params]
   */
  /**
   * v2.16: switch the Sync & Backup mode.
   * - backup   : recovery code persisted to data/pairing.json
   * - syncOnly : only device-to-device sync, recovery code kept in memory only
   */
  async setSyncMode(mode) {
    if (mode !== 'backup' && mode !== 'syncOnly') {
      throw new IdentityError('sync mode must be "backup" or "syncOnly"', { status: 400, code: 'invalid_sync_mode', detail: 'mode' });
    }
    await this.init();
    return this._mutate(async () => {
      this._identity.sync.mode = mode;
      return { mode };
    });
  }

  async enableSync(params = {}) {
    await this.init();
    return this._mutate(async () => {
      const sync = this._identity.sync;
      if (params.deviceName) this._identity.deviceName = String(params.deviceName);
      if (!sync.mainKey) sync.mainKey = base64urlEncode(crypto.randomBytes(32));
      if (!sync.scopedPasswordSeed) sync.scopedPasswordSeed = base64urlEncode(crypto.randomBytes(32));
      // Wrap the durable-stream private key with the main key (alg=dir, enc=A256GCM, kid=streams).
      const mainKeyBuf = base64urlDecode(sync.mainKey);
      sync.encryptedPrivateKey = encryptJwe(Buffer.from(JSON.stringify(this._identity.durableStream.privateKeyJwk), 'utf8'), mainKeyBuf, { kid: 'streams' });
      sync.userId = sync.userId || generateDeviceId();
      sync.enabled = true;
      sync.lastSyncAt = now();
      const device = sync.devices.find((entry) => entry.id === this._identity.deviceId);
      const deviceEntry = { id: this._identity.deviceId, name: this._identity.deviceName, type: 'desktop', addedAt: now() };
      if (device) Object.assign(device, deviceEntry);
      else sync.devices.push(deviceEntry);
      sync.recoveryCode = createRecoveryCode({
        userId: sync.userId,
        mainKey: sync.mainKey,
        scopedPasswordSeed: sync.scopedPasswordSeed,
        encryptedPrivateKey: sync.encryptedPrivateKey
      });
      return { sync: await this.getSync({ force: false }), recoveryCode: sync.recoveryCode };
    });
  }

  async disableSync() {
    return this._mutate(async () => {
      const deviceId = this._identity.deviceId;
      const deviceName = this._identity.deviceName;
      this._identity.sync = { ...this._defaultSync(), devices: [{ id: deviceId, name: deviceName, type: 'desktop', addedAt: now() }] };
      return { sync: await this.getSync() };
    });
  }

  /**
   * Build a v2 pairing code for another device to scan.
   * @returns {Promise<{ code: string, url: string, channelId: string, publicKey: string, createdAt: number, expiresAt: number }>}
   */
  async createPairingCode() {
    await this.init();
    return this._mutate(async () => {
      const channelId = generateChannelId();
      const publicKey = publicKeySpkiBase64Url(this._identity.durableStream.publicKeyJwk);
      const built = buildPairingCode({ channelId, publicKeyBase64Url: publicKey });
      const createdAt = now();
      this._identity.sync.pairingCode = { code: built.code, url: built.url, channelId, publicKey, createdAt, expiresAt: createdAt + 10 * 60 * 1000 };
      return { ...this._identity.sync.pairingCode };
    });
  }

  /**
   * Pair using a v2 pairing code. Never mutates local state on failure.
   * The sync transport (duckduckgo.com) is unreachable from this sandbox → 503 sync_transport_unavailable.
   * @param {string} code
   */
  async pair(code) {
    await this.init();
    const parsed = parsePairingCode(code);
    if (!parsed.ok) {
      throw new IdentityError(`invalid pairing code (${parsed.detail})`, {
        status: 400,
        code: 'invalid_pairing_code',
        detail: parsed.detail,
        hint: 'expected https://duckduckgo.com/sync/pairing/#&code2=... from the other device'
      });
    }
    if (parsed.type === 'v1-pairing') {
      throw new IdentityError('legacy v1 pairing codes are not supported', { status: 400, code: 'unsupported_pairing_version', detail: 'legacy_v1_code' });
    }
    if (parsed.type === 'recovery') {
      throw new IdentityError('this is a recovery code, use importRecoveryCode() instead', { status: 400, code: 'invalid_pairing_code', detail: 'recovery_code_not_pairing' });
    }
    // v2.3: re-probe the transport so a proxy toggle (enabled) takes effect immediately.
    const transport = await this._transport({ force: true });
    if (transport.status === 'blocked') {
      const proxyHint = transport.reason === 'proxy_disabled'
        ? 'enable the outbound proxy in the Proxy page to reach duckduckgo.com'
        : 'duckduckgo.com is not reachable from this environment; pairing/recovery work locally only';
      throw new IdentityError('DuckDuckGo Sync transport is unavailable in this environment', {
        status: 503,
        code: 'sync_transport_unavailable',
        hint: proxyHint,
        detail: transport.reason
      });
    }
    // Transport reachable: the actual channel handshake is not implemented in this build.
    throw new IdentityError('sync transport is reachable but the pairing handshake is not implemented', {
      status: 501,
      code: 'sync_handshake_unimplemented',
      hint: 'use export/import identity for cross-instance migration in this build'
    });
  }

  /** @returns {Promise<{ recoveryCode: string | null }>} */
  async getRecoveryCode() {
    await this.init();
    return { recoveryCode: this._identity.sync.recoveryCode || null };
  }

  /**
   * Import key material from a recovery code (local format; the official short code only carries
   * user_id and cannot restore keys offline).
   * @param {string} code
   */
  async importRecoveryCode(code) {
    await this.init();
    const decoded = decodeRecoveryCode(code);
    if (!decoded.ok) {
      throw new IdentityError(`invalid recovery code (${decoded.detail})`, { status: 400, code: 'invalid_recovery_code', detail: decoded.detail });
    }
    if (!decoded.importable) {
      throw new IdentityError('this recovery code does not contain key material (official DuckDuckGo recovery codes require the sync transport)', {
        status: 400,
        code: 'invalid_recovery_code',
        detail: 'missing_key_material',
        hint: 'paste a duckai-cpa exported recovery code, or import a full identity export'
      });
    }
    const { main_key: mainKey, scoped_password_seed: scopedPasswordSeed, encrypted_private_key: encryptedPrivateKey } = decoded.recovery;
    let privateKeyJwk;
    try {
      const plaintext = decryptJwe(encryptedPrivateKey, base64urlDecode(mainKey), { kid: 'streams' });
      privateKeyJwk = JSON.parse(plaintext.toString('utf8'));
      crypto.createPrivateKey({ key: privateKeyJwk, format: 'jwk' });
    } catch (error) {
      throw new IdentityError('recovery code key material cannot be decrypted/validated', {
        status: 400,
        code: 'invalid_recovery_code',
        detail: 'decrypt_failed',
        cause: error
      });
    }
    return this._mutate(async () => {
      const sync = this._identity.sync;
      sync.mainKey = mainKey;
      sync.scopedPasswordSeed = scopedPasswordSeed || sync.scopedPasswordSeed;
      sync.encryptedPrivateKey = encryptedPrivateKey;
      sync.userId = decoded.recovery.user_id || sync.userId || generateDeviceId();
      sync.enabled = true;
      sync.lastSyncAt = now();
      sync.devices = [{ id: this._identity.deviceId, name: this._identity.deviceName, type: 'desktop', addedAt: now() }];
      sync.recoveryCode = code;
      return { sync: await this.getSync() };
    });
  }

  // ------------------------------------------------------------------ Subscription

  /**
   * Activate a Duck.ai subscription token: parse JWT → store → verify online.
   * @param {string} token
   */
  async activateSubscription(token) {
    await this.init();
    let parsed;
    try {
      parsed = parseSubscriptionToken(token);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new IdentityError(error.message, { status: error.status || 422, code: error.code || 'token_invalid', detail: error.detail, cause: error });
      }
      throw error;
    }
    const verification = await verifySubscriptionOnline({
      token: token.trim().replace(/^Bearer\s+/i, ''),
      baseUrl: this.config.baseUrl || 'https://duck.ai',
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs ? Math.min(Number(this.config.timeoutMs), 20000) : undefined,
      fetchImpl: this.syncOptions.fetchImpl
    });
    return this._mutate(async () => {
      this._identity.auth = {
        token: token.trim().replace(/^Bearer\s+/i, ''),
        email: parsed.email,
        tier: parsed.tier,
        entitlements: parsed.entitlements,
        expiresAt: parsed.expiresAt,
        activatedAt: now(),
        verified: Boolean(verification.verified),
        verifyError: verification.error ? verification.error.message : null,
        tokenHash: parsed.tokenHash
      };
      return { auth: this.getRedacted().auth, verification };
    });
  }

  async clearSubscription() {
    return this._mutate(async () => {
      this._identity.auth = this._defaultAuth();
      return { auth: this.getRedacted().auth };
    });
  }

  /** Re-run online verification with the stored token. */
  async verifySubscription() {
    await this.init();
    const token = this._identity.auth?.token;
    if (!token) {
      return { verified: false, error: { code: 'not_authenticated', message: 'no subscription token is stored' }, auth: this.getRedacted().auth };
    }
    const verification = await verifySubscriptionOnline({
      token,
      baseUrl: this.config.baseUrl || 'https://duck.ai',
      userAgent: this.config.userAgent,
      fetchImpl: this.syncOptions.fetchImpl
    });
    return this._mutate(async () => {
      this._identity.auth.verified = Boolean(verification.verified);
      this._identity.auth.verifyError = verification.error ? verification.error.message : null;
      return { verified: Boolean(verification.verified), verification, auth: this.getRedacted().auth };
    });
  }
}

/**
 * Create + initialize an identity store.
 * @param {ConstructorParameters<typeof IdentityStore>[0]} options
 * @returns {Promise<IdentityStore>}
 */
export async function createIdentityStore(options = {}) {
  const store = new IdentityStore(options);
  await store.init();
  return store;
}

// ---------------------------------------------------------------------------
// Identity records without a file (v2.4 identity pool)
// ---------------------------------------------------------------------------

/** Default `sync` section of an identity record. */
export function defaultSyncRecord() {
  return {
    enabled: false,
    userId: null,
    mainKey: null,
    scopedPasswordSeed: null,
    encryptedPrivateKey: null,
    pairingCode: null,
    recoveryCode: null,
    lastSyncAt: null,
    devices: []
  };
}

/** Default `auth` section of an identity record. */
export function defaultAuthRecord() {
  return {
    token: null,
    email: null,
    tier: 'free',
    entitlements: [],
    expiresAt: null,
    activatedAt: null,
    verified: false,
    verifyError: null,
    tokenHash: null
  };
}

/**
 * Build a brand-new identity record (same shape as `data/identity.json`), without touching the disk.
 * Used by `IdentityStore` for first-run generation and by the identity pool for `generate()`.
 * @param {{ deviceName?: string, hostname?: string }} [options]
 * @returns {Record<string, any>}
 */
export function createIdentityRecord(options = {}) {
  const createdAt = now();
  const deviceName = options.deviceName || `DuckAI CPA @ ${options.hostname || os.hostname()}`;
  return {
    version: IDENTITY_VERSION,
    createdAt,
    rotatedAt: createdAt,
    journeyId: generateJourneyId(),
    deviceId: generateDeviceId(),
    deviceName,
    conversationId: generateDeviceId(),
    durableStream: { version: DURABLE_STREAM_VERSION, ...generateDurableStreamKeyPair() },
    sync: defaultSyncRecord(),
    auth: defaultAuthRecord()
  };
}

/**
 * Validate + normalize a raw identity record.
 * @param {Record<string, any>} candidate
 * @param {{ hostname?: string }} [options]
 * @returns {Record<string, any>}
 */
export function normalizeIdentityRecord(candidate, options = {}) {
  const hostname = options.hostname || os.hostname();
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'identity must be an object', 'invalid_identity', 'identity');
  assert(candidate.version === IDENTITY_VERSION || candidate.version === undefined, `unsupported identity version ${candidate.version}`, 'invalid_identity', 'version');
  const identity = {
    version: IDENTITY_VERSION,
    createdAt: Number(candidate.createdAt) || now(),
    rotatedAt: Number(candidate.rotatedAt) || Number(candidate.createdAt) || now(),
    journeyId: String(candidate.journeyId || ''),
    deviceId: String(candidate.deviceId || ''),
    deviceName: typeof candidate.deviceName === 'string' && candidate.deviceName ? candidate.deviceName : `DuckAI CPA @ ${hostname}`,
    conversationId: candidate.conversationId ? String(candidate.conversationId) : generateDeviceId(),
    durableStream: candidate.durableStream || null,
    sync: { ...defaultSyncRecord(), ...(candidate.sync && typeof candidate.sync === 'object' ? candidate.sync : {}) },
    auth: { ...defaultAuthRecord(), ...(candidate.auth && typeof candidate.auth === 'object' ? candidate.auth : {}) }
  };
  assert(JOURNEY_ID_RE.test(identity.journeyId), 'journeyId must be 32 lowercase hex chars', 'invalid_identity', 'journeyId');
  assert(UUID_RE.test(identity.deviceId), 'deviceId must be a uuid', 'invalid_identity', 'deviceId');

  const durable = identity.durableStream;
  assert(durable && durable.publicKeyJwk && durable.privateKeyJwk, 'identity.durableStream keys are required', 'invalid_identity', 'durableStream');
  try {
    crypto.createPrivateKey({ key: durable.privateKeyJwk, format: 'jwk' });
    crypto.createPublicKey({ key: durable.publicKeyJwk, format: 'jwk' });
  } catch (error) {
    throw new IdentityError('identity.durableStream key pair is not a valid RSA JWK', {
      status: 400,
      code: 'invalid_identity',
      detail: 'durableStream.keys',
      cause: error
    });
  }
  identity.durableStream = {
    version: durable.version || DURABLE_STREAM_VERSION,
    publicKeyJwk: enrichPublicJwk({ kty: durable.publicKeyJwk.kty, n: durable.publicKeyJwk.n, e: durable.publicKeyJwk.e }),
    privateKeyJwk: durable.privateKeyJwk,
    fingerprint: durableStreamFingerprint(durable.publicKeyJwk),
    createdAt: Number(durable.createdAt) || now()
  };
  return identity;
}

/**
 * Rotate identity material in memory (v2.4 pool). Returns a new record; the input is not mutated.
 * - `journey`: new journeyId
 * - `device` : new deviceId + conversationId + durable-stream key pair (sync wrapping updated if enabled)
 * - `all`    : both
 * @param {Record<string, any>} record
 * @param {'journey'|'device'|'all'} [scope]
 */
export function rotateIdentityRecord(record, scope = 'journey') {
  const normalizedScope = scope === true ? 'all' : String(scope || 'journey');
  if (!['journey', 'device', 'all'].includes(normalizedScope)) {
    throw new IdentityError(`unsupported rotate scope "${scope}"`, { status: 400, code: 'invalid_identity', detail: 'rotate_scope' });
  }
  const next = deepClone(record);
  if (normalizedScope === 'journey' || normalizedScope === 'all') {
    next.journeyId = generateJourneyId();
  }
  if (normalizedScope === 'device' || normalizedScope === 'all') {
    next.deviceId = generateDeviceId();
    next.conversationId = generateDeviceId();
    next.durableStream = { version: DURABLE_STREAM_VERSION, ...generateDurableStreamKeyPair() };
    // Keep the sync-wrapped private key consistent with the new key pair.
    if (next.sync && next.sync.mainKey && next.sync.encryptedPrivateKey) {
      try {
        next.sync.encryptedPrivateKey = encryptJwe(
          Buffer.from(JSON.stringify(next.durableStream.privateKeyJwk), 'utf8'),
          base64urlDecode(next.sync.mainKey),
          { kid: 'streams' }
        );
        if (next.sync.userId) {
          next.sync.recoveryCode = createRecoveryCode({
            userId: next.sync.userId,
            mainKey: next.sync.mainKey,
            scopedPasswordSeed: next.sync.scopedPasswordSeed,
            encryptedPrivateKey: next.sync.encryptedPrivateKey
          });
        }
      } catch {
        // Rotation must not fail because of stale sync material; sync can be re-enabled.
      }
    }
    if (Array.isArray(next.sync && next.sync.devices)) {
      next.sync.devices = next.sync.devices.map((device) =>
        device && device.id === record.deviceId ? { ...device, id: next.deviceId, name: next.deviceName } : device
      );
    }
  }
  next.rotatedAt = now();
  return next;
}

/** Auth view used by the DuckClient integration. @param {Record<string, any>} auth */
function authView(auth) {
  const record = auth || defaultAuthRecord();
  if (!record.token) return { token: null, expired: false, tier: record.tier || 'free', expiresAt: record.expiresAt || null };
  const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : null;
  const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now() : true;
  return { token: expired ? null : record.token, expired, tier: record.tier || 'free', expiresAt: record.expiresAt || null };
}

/**
 * In-memory identity store (same read surface as `IdentityStore`) backed by an identity record from
 * the identity pool. Nothing is written to disk; the pool owns persistence.
 */
export class MemoryIdentityStore {
  /**
   * @param {Record<string, any>} record
   * @param {{ hostname?: string, source?: string }} [options]
   */
  constructor(record, options = {}) {
    this.record = normalizeIdentityRecord(record, options);
    this.source = options.source || 'pool';
    this.proxyManager = null;
    this.fetchImpl = null;
  }

  async init() {
    return this;
  }

  getJourneyId() {
    return this.record.journeyId;
  }

  getConversationId() {
    return this.record.conversationId;
  }

  getDeviceId() {
    return this.record.deviceId;
  }

  getDeviceName() {
    return this.record.deviceName || null;
  }

  getDurableStreamPublicKey() {
    return deepClone(this.record.durableStream.publicKeyJwk);
  }

  getDurableStream() {
    return {
      publicKeyJwk: deepClone(this.record.durableStream.publicKeyJwk),
      fingerprint: this.record.durableStream.fingerprint,
      version: this.record.durableStream.version
    };
  }

  getAuthToken() {
    return authView(this.record.auth);
  }

  getRaw() {
    return deepClone(this.record);
  }

  /** Replace the backing record (used after pool-side mutations + runtime refresh). */
  updateRecord(record) {
    this.record = normalizeIdentityRecord(record);
    return this;
  }

  setProxyManager(proxyManager) {
    this.proxyManager = proxyManager || null;
    return this;
  }

  setFetchImpl(fetchImpl) {
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    return this;
  }

  getFileInfo() {
    return { path: null, bytes: 0, updatedAt: null };
  }

  /** Redacted view (no private key / token). */
  getRedacted() {
    const record = this.record;
    const tokenView = authView(record.auth);
    const sync = record.sync || defaultSyncRecord();
    return {
      journeyId: record.journeyId,
      conversationId: record.conversationId,
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      createdAt: record.createdAt,
      rotatedAt: record.rotatedAt,
      version: record.version,
      stable: true,
      source: this.source,
      durableStream: {
        fingerprint: record.durableStream.fingerprint,
        publicKeyJwk: deepClone(record.durableStream.publicKeyJwk),
        hasPrivateKey: Boolean(record.durableStream.privateKeyJwk),
        version: record.durableStream.version,
        createdAt: record.durableStream.createdAt
      },
      auth: {
        authenticated: Boolean(record.auth.token) && !tokenView.expired,
        email: record.auth.email || null,
        tier: tokenView.expired ? 'free' : record.auth.tier || 'free',
        entitlements: deepClone(record.auth.entitlements || []),
        expiresAt: record.auth.expiresAt || null,
        activatedAt: record.auth.activatedAt || null,
        expired: tokenView.expired,
        verified: Boolean(record.auth.verified),
        verifyError: record.auth.verifyError || null,
        tokenHash: record.auth.tokenHash || null
      },
      sync: {
        enabled: Boolean(sync.enabled),
        deviceCount: Array.isArray(sync.devices) ? sync.devices.length : 0,
        lastSyncAt: sync.lastSyncAt || null,
        hasPairingCode: Boolean(sync.pairingCode),
        hasRecoveryCode: Boolean(sync.recoveryCode)
      },
      file: this.getFileInfo()
    };
  }

  /** Compact summary for `DuckClient.health().identity`. */
  getSummary() {
    const redacted = this.getRedacted();
    return {
      journeyId: redacted.journeyId,
      fingerprint: redacted.durableStream.fingerprint,
      conversationId: redacted.conversationId,
      deviceId: redacted.deviceId,
      stable: true,
      source: redacted.source,
      authTier: redacted.auth.tier,
      authenticated: redacted.auth.authenticated,
      authExpired: redacted.auth.expired,
      syncEnabled: redacted.sync.enabled
    };
  }

  reveal(field) {
    switch (field) {
      case 'token':
        return this.record.auth.token || null;
      case 'mainKey':
        return this.record.sync.mainKey || null;
      case 'scopedPasswordSeed':
        return this.record.sync.scopedPasswordSeed || null;
      case 'privateKeyJwk':
        return deepClone(this.record.durableStream.privateKeyJwk);
      default:
        throw new IdentityError(`unknown reveal field "${field}"`, { status: 400, code: 'invalid_identity', detail: 'reveal_field' });
    }
  }
}

export default {
  IdentityStore,
  IdentityError,
  MemoryIdentityStore,
  createIdentityStore,
  createIdentityRecord,
  normalizeIdentityRecord,
  rotateIdentityRecord,
  defaultSyncRecord,
  defaultAuthRecord
};

