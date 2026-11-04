/**
 * Identity pool for v2.4 (anonymous "分身" pool + session→identity routing + per-identity RPS queue).
 *
 * Contract: docs/IDENTITY-POOL.md §1–§3. Design notes: docs/IDENTITY-POOL-IMPL.md.
 *
 * - Storage: `<dataDir>/identity-pool.json` (atomic write, corrupt backup `identity-pool.corrupt-<ts>.json`).
 *   First run migrates the existing `<dataDir>/identity.json` as `id_default` (the original file is kept
 *   untouched so the v2.2 API keeps working).
 * - Every identity carries a **complete identity record** (journeyId/deviceId/conversationId/
 *   durable-stream key pair/sync/auth) so each 分身 is a distinct upstream identity.
 * - Routing: a session is permanently bound to one identity. New bindings use
 *   `parseInt(sha256(sessionKey + ":" + salt).slice(0, 8), 16) % candidates.length` over
 *   `enabled` (and `subscribed` for paid models) identities sorted by id.
 * - Runtime: one lazily created DuckClient per identity (own challenge/journey/rate-limit state,
 *   shared proxy manager), recycled after `idleTimeoutMs` of inactivity.
 * - Queueing: one queue per identity with rps/maxConcurrent (default 1/1) + queue limits; different
 *   identities run in parallel.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  IdentityError,
  MemoryIdentityStore,
  createIdentityRecord,
  normalizeIdentityRecord,
  rotateIdentityRecord,
  defaultAuthRecord
} from './identity.js';
import { DEFAULT_MAIN_DEVICE_NAME, defaultDeviceName } from './sync-client.js';
import { parseSubscriptionToken, AuthError } from './auth.js';
import { DuckClient } from './index.js';
import { openDatabase, readJsonIfExists } from '../db.js';

export const POOL_FILE_NAME = 'identity-pool.json';
export const POOL_VERSION = 1;
export const IDENTITY_FILE_NAME = 'identity.json';
export const PAID_TIERS = Object.freeze(['plus', 'pro']);

export const DEFAULT_POOL_CONFIG = Object.freeze({
  maxIdentities: 20,
  bindingsLimit: 5000,
  rps: 1,
  maxConcurrent: 1,
  queueLimit: 50,
  queueTimeoutMs: 300000,
  idleTimeoutMs: 600000,
  strategy: 'hash'
});

/** Error raised by the identity pool (mapped to HTTP by the admin layer). */
export class PoolError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, field?: string, hint?: string, detail?: string, cause?: unknown, retryAfterMs?: number }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PoolError';
    this.status = meta.status ?? 400;
    this.code = meta.code ?? 'invalid_request';
    if (meta.field !== undefined) this.field = meta.field;
    if (meta.hint !== undefined) this.hint = meta.hint;
    if (meta.detail !== undefined) this.detail = meta.detail;
    if (meta.retryAfterMs !== undefined) {
      this.retryAfterMs = meta.retryAfterMs;
      this.retryAfter = Math.max(1, Math.ceil(meta.retryAfterMs / 1000));
    }
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/** Alias for consumers that prefer the module-qualified name (QA/tests). */
export const IdentityPoolError = PoolError;

const now = () => Date.now();
const deepClone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const sha256Hex = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** @param {any} value @param {string} message @param {string} [field] */
function fail(value, message, field) {
  if (value) return;
  throw new PoolError(message, { status: 400, code: 'invalid_identity', field });
}

function normalizePoolConfig(config = {}) {
  const raw = config && typeof config === 'object' && config.pool && typeof config.pool === 'object' ? config.pool : config || {};
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };
  return {
    maxIdentities: number(raw.maxIdentities, DEFAULT_POOL_CONFIG.maxIdentities, 1, 100),
    bindingsLimit: number(raw.bindingsLimit, DEFAULT_POOL_CONFIG.bindingsLimit, 1, 5000),
    rps: number(raw.rps, DEFAULT_POOL_CONFIG.rps, 1, 100),
    maxConcurrent: number(raw.maxConcurrent, DEFAULT_POOL_CONFIG.maxConcurrent, 1, 100),
    queueLimit: number(raw.queueLimit, DEFAULT_POOL_CONFIG.queueLimit, 1, 10000),
    queueTimeoutMs: number(raw.queueTimeoutMs, DEFAULT_POOL_CONFIG.queueTimeoutMs, 1000, 3600000),
    // `runtimeIdleMs` is the admin/config contract key; `idleTimeoutMs` is the internal spelling.
    idleTimeoutMs: number(raw.idleTimeoutMs ?? raw.runtimeIdleMs, DEFAULT_POOL_CONFIG.idleTimeoutMs, 30000, 86400000),
    strategy: raw.strategy === 'least-loaded' ? 'least-loaded' : 'hash'
  };
}

const JOURNEY_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Per-identity FIFO queue with an RPS gate (`rps=1` → at least 1000ms between request starts) and a
 * concurrency cap. Different queues are independent, so different identities run in parallel.
 */
export class IdentityQueue {
  /**
   * @param {{ identityId: string, rps?: number, maxConcurrent?: number, queueLimit?: number, queueTimeoutMs?: number, logger?: any }} options
   */
  constructor(options) {
    this.identityId = options.identityId;
    this.rps = Math.max(1, Number(options.rps) || 1);
    this.rpsIntervalMs = Math.round(1000 / this.rps);
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 1);
    this.queueLimit = Math.max(1, Number(options.queueLimit) || 50);
    this.queueTimeoutMs = Math.max(1000, Number(options.queueTimeoutMs) || 300000);
    this.logger = options.logger || null;
    /** @type {Array<{ enqueuedAt: number, run: Function, resolve: Function, reject: Function, timer?: any, signal?: AbortSignal, onAbort?: Function }>} */
    this.waiting = [];
    this.inFlight = 0;
    this.requests = 0;
    this.failures = 0;
    this.lastStartedAt = 0;
    this.lastCompletedAt = 0;
    this.peakInFlight = 0;
    this.totalWaitMs = 0;
    this.lastWaitMs = 0;
    this._timer = null;
    this._closed = false;
  }

  /** @param {{ waiting: number, inFlight: number, rps: number, requests: number, lastStartedAt: number, peakInFlight: number, totalWaitMs: number, identityId: string }} */
  stats() {
    return {
      identityId: this.identityId,
      waiting: this.waiting.length,
      inFlight: this.inFlight,
      rps: this.rps,
      maxConcurrent: this.maxConcurrent,
      queueLimit: this.queueLimit,
      requests: this.requests,
      failures: this.failures,
      lastStartedAt: this.lastStartedAt || null,
      lastCompletedAt: this.lastCompletedAt || null,
      peakInFlight: this.peakInFlight,
      totalWaitMs: this.totalWaitMs,
      avgWaitMs: this.requests > 0 ? Math.round(this.totalWaitMs / this.requests) : 0,
      lastWaitMs: this.lastWaitMs
    };
  }

  /**
   * Run `fn({queueWaitMs})` under this queue.
   * @template T
   * @param {(context: { queueWaitMs: number }) => Promise<T>} fn
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(fn, options = {}) {
    if (this._closed) throw new PoolError('identity queue is closed', { status: 503, code: 'identity_unavailable' });
    const signal = options.signal;
    if (signal && signal.aborted) {
      throw new PoolError('request aborted before queueing', { status: 499, code: 'aborted' });
    }
    if (this.waiting.length >= this.queueLimit) {
      const retryAfterMs = this._estimatedWaitMs();
      this.logger?.warn?.('[duck:pool] identity queue full', { identityId: this.identityId, waiting: this.waiting.length, queueLimit: this.queueLimit });
      throw new PoolError(`identity "${this.identityId}" queue is full`, {
        status: 429,
        code: 'queue_full',
        hint: 'retry later or use another identity',
        retryAfterMs
      });
    }
    return new Promise((resolve, reject) => {
      const task = { enqueuedAt: now(), run: fn, resolve, reject, signal, timer: null, onAbort: null };
      task.timer = setTimeout(() => {
        const index = this.waiting.indexOf(task);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(
          new PoolError(`identity "${this.identityId}" queue wait timed out after ${this.queueTimeoutMs}ms`, {
            status: 429,
            code: 'queue_timeout',
            retryAfterMs: this._estimatedWaitMs()
          })
        );
      }, this.queueTimeoutMs);
      if (typeof task.timer.unref === 'function') task.timer.unref();
      if (signal) {
        task.onAbort = () => {
          const index = this.waiting.indexOf(task);
          if (index !== -1) this.waiting.splice(index, 1);
          if (task.timer) clearTimeout(task.timer);
          reject(new PoolError('request aborted while queueing', { status: 499, code: 'aborted' }));
        };
        signal.addEventListener('abort', task.onAbort, { once: true });
      }
      this.waiting.push(task);
      this._pump();
    });
  }

  _estimatedWaitMs() {
    const running = this.inFlight > 0 ? this.rpsIntervalMs : 0;
    return Math.max(this.rpsIntervalMs, (this.waiting.length + 1) * this.rpsIntervalMs + running);
  }

  _pump() {
    if (this._closed) return;
    if (this.inFlight >= this.maxConcurrent) return;
    if (this.waiting.length === 0) return;
    const wait = this.lastStartedAt ? this.rpsIntervalMs - (now() - this.lastStartedAt) : 0;
    if (wait > 0) {
      if (!this._timer) {
        this._timer = setTimeout(() => {
          this._timer = null;
          this._pump();
        }, wait);
        // NOTE: intentionally not unref'd — a pending rps gate must keep the process alive until
        // queued work starts (otherwise callers await a promise that can never settle).
      }
      return;
    }
    const task = this.waiting.shift();
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
    const queueWaitMs = now() - task.enqueuedAt;
    this.inFlight += 1;
    this.requests += 1;
    this.lastStartedAt = now();
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.totalWaitMs += queueWaitMs;
    this.lastWaitMs = queueWaitMs;
    Promise.resolve()
      .then(() => task.run({ queueWaitMs }))
      .then(
        (value) => {
          this.lastCompletedAt = now();
          task.resolve(value);
        },
        (error) => {
          this.failures += 1;
          this.lastCompletedAt = now();
          task.reject(error);
        }
      )
      .finally(() => {
        this.inFlight -= 1;
        this._pump();
      });
  }

  close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    for (const task of this.waiting.splice(0)) {
      if (task.timer) clearTimeout(task.timer);
      if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
      task.reject(new PoolError('identity queue closed', { status: 503, code: 'identity_unavailable' }));
    }
  }
}

/**
 * Identity pool.
 */
export class IdentityPool {
  /**
   * @param {{
   *   dataDir?: string,
   *   config?: Record<string, any>,
   *   logger?: any,
   *   proxyManager?: any,
   *   createRuntime?: (record: Record<string, any>, ctx: Record<string, any>) => any,
   *   duckFactory?: (record: Record<string, any>, ctx: Record<string, any>) => any
   * }} [options]
   */
  constructor(options = {}) {
    const config = options.config || {};
    const dataDir = options.dataDir || config.dataDir || path.join(process.cwd(), 'data');
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, POOL_FILE_NAME);
    // v2.31：SQLite 持久化（identity-pool.json 首次启动自动导入）
    this._db = null;
    this.identityFilePath = path.join(this.dataDir, IDENTITY_FILE_NAME);
    this.config = config;
    this.poolConfig = normalizePoolConfig(config);
    this.duckConfig = (config && config.duck) || {};
    this.logger = options.logger || null;
    this.proxyManager = options.proxyManager || null;
    this.createRuntime = options.createRuntime || options.duckFactory || null;
    // v2.15: first-class subscription store (one subscription ↔ many identities).
    this.subscriptionStore = options.subscriptionStore || null;
    this._pool = null;
    this._ready = false;
    this._initPromise = null;
    this._writeLock = Promise.resolve();
    /** @type {Map<string, any>} */
    this.runtimes = new Map();
    /** @type {Map<string, IdentityQueue>} */
    this.queues = new Map();
    this._idleTimer = null;
    this._persistTimer = null;
    this._closed = false;
    this._fileInfo = { path: path.join(this.dataDir, 'duckai.db'), bytes: 0, updatedAt: null, source: 'sqlite', identities: 0 };
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    if (this._ready) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
      // v2.31：优先从 SQLite 读取；空库时从旧 identity-pool.json 导入（一次性迁移）
      try {
        this._db = await openDatabase({ dataDir: this.dataDir, logger: this.logger });
      } catch (error) {
        this.logger?.warn?.('[duck:pool] sqlite unavailable; falling back to JSON file', { error: error.message });
        this._db = null;
      }
      let raw = null;
      let source = 'file';
      if (this._db) {
        raw = this._loadFromSqlite();
        if (raw) source = 'sqlite';
      }
      if (!raw) {
        try {
          raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
          source = 'file';
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            source = 'migrated';
          } else {
            const corruptPath = path.join(this.dataDir, `identity-pool.corrupt-${now()}.json`);
            await fs.rename(this.filePath, corruptPath).catch(() => {});
            this.logger?.warn?.('[duck:pool] identity-pool.json is corrupt; backed up and rebuilding', { corruptPath, error: String(error && error.message) });
            source = 'recovered';
            raw = null;
          }
        }
      }
      if (raw) {
        try {
          this._pool = this._normalizePool(raw);
        } catch (error) {
          const corruptPath = path.join(this.dataDir, `identity-pool.corrupt-${now()}.json`);
          await fs.rename(this.filePath, corruptPath).catch(() => {});
          this.logger?.warn?.('[duck:pool] identity-pool.json failed validation; backed up and rebuilding', { corruptPath, error: String(error && error.message) });
          this._pool = null;
          source = 'recovered';
        }
      }
      if (!this._pool) {
        this._pool = await this._buildFromScratch(source);
        await this._persist();
      }
      // Keep activeId valid after manual file edits.
      if (!this._pool.activeId || !this._find(this._pool.activeId)) {
        this._pool.activeId = this._pool.identities[0] ? this._pool.identities[0].id : null;
        await this._persist();
      }
      // v2.9: per-identity device names (`DuckAI@main` for id_default, `DuckCPA@xxxx` otherwise).
      if (this._ensureDeviceNames()) await this._persist();
      const stat = await fs.stat(this.filePath).catch(() => null);
      this._fileInfo = { path: this.filePath, bytes: stat ? stat.size : 0, updatedAt: stat ? stat.mtimeMs : null, source: 'none', identities: 0 };
      await this._refreshFileInfo();
      // v2.30：启动时清理过期会话绑定
    try {
      const removed = this.pruneBindings();
      if (removed > 0) this.logger?.info?.('[duck:pool] expired session bindings pruned', { removed });
    } catch {
      // 清理失败不影响启动
    }
    this._ready = true;
      this._startIdleTimer();
      this.logger?.info?.('[duck:pool] identity pool ready', {
        source: this._pool.identities.length ? (this._pool.identities[0].source || source) : source,
        total: this._pool.identities.length,
        activeId: this._pool.activeId,
        bindings: Object.keys(this._pool.bindings).length
      });
      return this;
    })().catch((error) => {
      this._initPromise = null;
      throw error;
    });
    return this._initPromise;
  }

  // ------------------------------------------------------------------ device names (v2.9)

  /** Old auto-generated default names that should be migrated. */
  _isLegacyDefaultDeviceName(name) {
    if (typeof name !== 'string' || !name.trim()) return true;
    return /^DuckAI\s+CPA(\s*@.*)?$/i.test(name.trim());
  }

  _isAutoDeviceName(name) {
    return /^DuckCPA@[0-9a-f]{4}$/i.test(String(name || '').trim());
  }

  _takenDeviceNames() {
    return new Set((this._pool ? this._pool.identities : []).map((entry) => entry.identity.deviceName).filter(Boolean));
  }

  _uniqueDeviceName(taken = this._takenDeviceNames()) {
    for (let index = 0; index < 100; index += 1) {
      const name = defaultDeviceName();
      if (!taken.has(name)) return name;
    }
    return defaultDeviceName();
  }

  /**
   * Normalize device names on load:
   * - `id_default` → `DuckAI@main` unless the user gave a custom name;
   * - other identities without a name / with a legacy auto name → `DuckCPA@<4hex>`.
   * @returns {boolean} whether anything changed
   */
  _ensureDeviceNames() {
    if (!this._pool) return false;
    let changed = false;
    const taken = this._takenDeviceNames();
    for (const entry of this._pool.identities) {
      const current = entry.identity.deviceName;
      if (entry.id === 'id_default') {
        if ((this._isLegacyDefaultDeviceName(current) || this._isAutoDeviceName(current)) && current !== DEFAULT_MAIN_DEVICE_NAME) {
          entry.identity.deviceName = DEFAULT_MAIN_DEVICE_NAME;
          changed = true;
        }
      } else if (!current || this._isLegacyDefaultDeviceName(current)) {
        if (current) taken.delete(current);
        const name = this._uniqueDeviceName(taken);
        entry.identity.deviceName = name;
        taken.add(name);
        changed = true;
      }
    }
    return changed;
  }

  /** Fixed default identity id (`id_default` when present, else activeId). */
  getDefaultIdentityId() {
    if (this._find('id_default')) return 'id_default';
    return this._pool ? this._pool.activeId : null;
  }

  /** Device name of one identity. */
  getDeviceName(id) {
    const entry = this._require(id);
    return entry.identity.deviceName || null;
  }

  /** Persist a custom device name for one identity (1–100 chars). */
  async setDeviceName(id, name) {
    return this.update(id, { deviceName: name });
  }

  /** Migrate `identity.json` as `id_default`, or create a fresh default identity. */
  async _buildFromScratch(source) {
    let record = null;
    let identitySource = 'generated';
    try {
      const identityRaw = JSON.parse(await fs.readFile(this.identityFilePath, 'utf8'));
      record = normalizeIdentityRecord(identityRaw, { hostname: os.hostname() });
      identitySource = 'migrated';
      this.logger?.info?.('[duck:pool] migrated data/identity.json as id_default (original file kept)');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger?.warn?.('[duck:pool] data/identity.json is not usable for migration; generating a new default identity', {
          error: String(error && error.message)
        });
      }
    }
    if (!record) record = createIdentityRecord({ hostname: os.hostname(), deviceName: DEFAULT_MAIN_DEVICE_NAME });
    if (this._isLegacyDefaultDeviceName(record.deviceName) || this._isAutoDeviceName(record.deviceName)) {
      record.deviceName = DEFAULT_MAIN_DEVICE_NAME;
    }
    const entry = {
      id: 'id_default',
      label: '默认身份',
      enabled: true,
      subscribed: PAID_TIERS.includes(record.auth && record.auth.tier),
      source: source === 'recovered' ? 'generated' : identitySource,
      createdAt: now(),
      identity: record,
      stats: { sessions: 0, requests: 0, failures: 0, lastUsedAt: null }
    };
    return {
      version: POOL_VERSION,
      activeId: entry.id,
      salt: randomHex(16),
      identities: [entry],
      bindings: {},
      router: { strategy: this.poolConfig.strategy }
    };
  }

  _normalizePool(raw) {
    fail(raw && typeof raw === 'object' && !Array.isArray(raw), 'identity pool file must be an object');
    fail(raw.version === POOL_VERSION || raw.version === undefined, `unsupported identity pool version ${raw.version}`);
    const salt = typeof raw.salt === 'string' && /^[a-f0-9]{8,128}$/i.test(raw.salt) ? raw.salt : randomHex(16);
    const identities = [];
    const seen = new Set();
    for (const item of Array.isArray(raw.identities) ? raw.identities : []) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || !/^id_[A-Za-z0-9_-]{3,64}$/.test(item.id)) continue;
      if (seen.has(item.id)) continue;
      let record;
      try {
        record = normalizeIdentityRecord(item.identity, { hostname: os.hostname() });
      } catch {
        continue;
      }
      seen.add(item.id);
      const stats = item.stats && typeof item.stats === 'object' ? item.stats : {};
      identities.push({
        id: item.id,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.id,
        enabled: item.enabled !== false,
        subscribed: item.subscribed === true,
        source: typeof item.source === 'string' ? item.source : 'file',
        createdAt: Number(item.createdAt) || now(),
        // v2.15: subscription entity reference + snapshot for sync summaries.
        subscriptionId: typeof item.subscriptionId === 'string' && item.subscriptionId ? item.subscriptionId : null,
        subscription:
          item.subscription && typeof item.subscription === 'object'
            ? {
                label: typeof item.subscription.label === 'string' ? item.subscription.label : null,
                tier: typeof item.subscription.tier === 'string' ? item.subscription.tier : null,
                expiresAt: typeof item.subscription.expiresAt === 'string' ? item.subscription.expiresAt : null
              }
            : null,
        identity: record,
        // v2.32：额度冷却状态（持久化，重启后仍生效；到期由 pruneCooldowns 清理）
        cooldownUntil: Number.isFinite(Number(item.cooldownUntil)) ? Number(item.cooldownUntil) : null,
        cooldownReason: typeof item.cooldownReason === 'string' ? item.cooldownReason : null,
        cooldownScope: typeof item.cooldownScope === 'string' ? item.cooldownScope : null,
        cooldownMarkedAt: Number.isFinite(Number(item.cooldownMarkedAt)) ? Number(item.cooldownMarkedAt) : null,
        stats: {
          sessions: Number(stats.sessions) || 0,
          requests: Number(stats.requests) || 0,
          failures: Number(stats.failures) || 0,
          lastUsedAt: Number(stats.lastUsedAt) || null
        }
      });
    }
    if (!identities.length) throw new Error('identity pool contains no usable identities');
    const bindings = {};
    const rawBindings = raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings) ? raw.bindings : {};
    const byId = new Map(identities.map((entry) => [entry.id, entry]));
    for (const [key, value] of Object.entries(rawBindings)) {
      const identityId = typeof value === 'string' ? value : value && typeof value === 'object' ? value.identityId : null;
      if (!identityId || !byId.has(identityId)) continue;
      bindings[key] = {
        identityId,
        createdAt: Number(value && value.createdAt) || now(),
        updatedAt: Number(value && value.updatedAt) || Number(value && value.createdAt) || now(),
        tier: value && value.tier === 'paid' ? 'paid' : 'free'
      };
    }
    const activeId = typeof raw.activeId === 'string' && byId.has(raw.activeId) ? raw.activeId : identities[0].id;
    const strategy = raw.router && raw.router.strategy === 'least-loaded' ? 'least-loaded' : this.poolConfig.strategy;
    return { version: POOL_VERSION, activeId, salt, identities, bindings, router: { strategy } };
  }

  /** v2.31：从 SQLite 组装 pool 对象（无数据返回 null）。 */
  _loadFromSqlite() {
    if (!this._db) return null;
    try {
      const rows = this._db.db.prepare('SELECT record_json FROM identities ORDER BY created_at ASC').all();
      if (!rows.length) return null;
      const identities = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.record_json);
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') identities.push(parsed);
        } catch {
          // skip corrupt row
        }
      }
      if (!identities.length) return null;
      const bindings = {};
      for (const row of this._db.db.prepare('SELECT session_key, identity_id, created_at, updated_at, tier FROM bindings').all()) {
        bindings[row.session_key] = {
          identityId: row.identity_id,
          createdAt: Number(row.created_at) || now(),
          updatedAt: Number(row.updated_at) || Number(row.created_at) || now(),
          tier: row.tier === 'paid' ? 'paid' : 'free'
        };
      }
      const salt = this._db.getPoolMeta('salt', null);
      const activeId = this._db.getPoolMeta('activeId', null);
      const strategy = this._db.getPoolMeta('router.strategy', null);
      return {
        version: POOL_VERSION,
        salt: salt || randomHex(16),
        activeId: activeId || identities[0].id,
        identities,
        bindings,
        router: { strategy: strategy === 'least-loaded' ? 'least-loaded' : this.poolConfig.strategy }
      };
    } catch (error) {
      this.logger?.warn?.('[duck:pool] failed to read sqlite pool; falling back to JSON', { error: error.message });
      return null;
    }
  }

  /**
   * 持久化：SQLite 是唯一来源（v2.31 之后不再写 identity-pool.json 快照）。
   * 首次启动仍会从旧 JSON 导入（见 init），但之后只写 duckai.db。
   */
  async _persist() {
    if (this._db && this._pool) {
      try {
        this._db.transaction(() => {
          const stmt = this._db.db.prepare(
            `INSERT INTO identities(id, label, enabled, subscribed, source, tier, record_json, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               label = excluded.label, enabled = excluded.enabled, subscribed = excluded.subscribed,
               source = excluded.source, tier = excluded.tier, record_json = excluded.record_json,
               updated_at = excluded.updated_at`
          );
          const keep = new Set();
          for (const entry of this._pool.identities) {
            keep.add(entry.id);
            stmt.run(
              entry.id,
              entry.label ?? null,
              entry.enabled === false ? 0 : 1,
              entry.subscribed ? 1 : 0,
              entry.source ?? null,
              (entry.subscription && entry.subscription.tier) || null,
              JSON.stringify(entry),
              Number(entry.createdAt) || null,
              Number(entry.updatedAt) || now()
            );
          }
          const existing = this._db.db.prepare('SELECT id FROM identities').all();
          const delIdentity = this._db.db.prepare('DELETE FROM identities WHERE id = ?');
          for (const row of existing) if (!keep.has(row.id)) delIdentity.run(row.id);

          this._db.db.prepare('DELETE FROM bindings').run();
          const bindStmt = this._db.db.prepare(
            'INSERT INTO bindings(session_key, identity_id, tier, created_at, updated_at) VALUES(?, ?, ?, ?, ?)'
          );
          for (const [sessionKey, binding] of Object.entries(this._pool.bindings || {})) {
            bindStmt.run(
              sessionKey,
              binding.identityId,
              binding.tier === 'paid' ? 'paid' : 'free',
              Number(binding.createdAt) || now(),
              Number(binding.updatedAt) || now()
            );
          }
          this._db.setPoolMeta('salt', this._pool.salt);
          this._db.setPoolMeta('activeId', this._pool.activeId || '');
          this._db.setPoolMeta('router.strategy', (this._pool.router && this._pool.router.strategy) || this.poolConfig.strategy);
        });
      } catch (error) {
        this.logger?.warn?.('[duck:pool] sqlite persist failed（不再写 JSON 快照）', { error: error.message });
      }
      await this._refreshFileInfo();
      return;
    }
    // SQLite 不可用时不生成 JSON 快照，只记录告警（避免出现新的“伪持久化”文件）。
    this.logger?.warn?.('[duck:pool] sqlite unavailable; identity pool change is not persisted', {
      identities: this._pool?.identities?.length || 0
    });
  }

  /** 存储信息改为基于 SQLite（管理页“存储信息”使用）。 */
  async _refreshFileInfo() {
    if (this._db?.file) {
      const stat = await fs.stat(this._db.file).catch(() => null);
      let identities = 0;
      try {
        identities = Number(this._db.db.prepare('SELECT COUNT(*) AS n FROM identities').get()?.n) || 0;
      } catch {
        identities = 0;
      }
      this._fileInfo = {
        path: this._db.file,
        bytes: stat ? stat.size : 0,
        updatedAt: stat ? stat.mtimeMs : now(),
        source: 'sqlite',
        identities
      };
      return;
    }
    this._fileInfo = { path: this._db?.file || this.filePath, bytes: 0, updatedAt: null, source: 'none', identities: 0 };
  }

  /** Serialize mutations (FIFO) so concurrent admin calls cannot interleave writes. */
  _mutate(fn) {
    const run = async () => {
      await this.init();
      const result = await fn();
      await this._persist();
      return result;
    };
    const next = this._writeLock.then(run, run);
    this._writeLock = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** Stats-only changes (lastUsedAt/requests/sessions) are persisted with a short debounce. */
  _schedulePersist() {
    if (this._persistTimer || this._closed) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist().catch((error) => this.logger?.warn?.('[duck:pool] debounced persist failed', error));
    }, 1000);
    if (typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
  }

  _find(id) {
    if (!this._pool) return null;
    return this._pool.identities.find((entry) => entry.id === id) || null;
  }

  _require(id) {
    const entry = this._find(id);
    if (!entry) throw new PoolError(`identity "${id}" not found`, { status: 404, code: 'identity_not_found', field: 'id' });
    return entry;
  }

  _newId() {
    let id;
    do {
      id = `id_${randomHex(4)}`;
    } while (this._find(id) || (this.runtimes && this.runtimes.has(id)));
    return id;
  }

  // ------------------------------------------------------------------ summaries

  /** @returns {{ total: number, enabled: number, subscribed: number, activeId: string|null, saltPresent: boolean, bindingCount: number, maxIdentities: number, busy: number }} */
  getSummary() {
    const pool = this._pool || { identities: [], bindings: {}, activeId: null };
    const identities = pool.identities;
    let busy = 0;
    for (const queue of this.queues.values()) busy += queue.inFlight;
    return {
      total: identities.length,
      enabled: identities.filter((entry) => entry.enabled).length,
      subscribed: identities.filter((entry) => entry.enabled && entry.subscribed).length,
      activeId: pool.activeId,
      saltPresent: Boolean(pool.salt),
      bindingCount: Object.keys(pool.bindings).length,
      maxIdentities: this.poolConfig.maxIdentities,
      busy
    };
  }

  getPoolSummary() {
    return this.getSummary();
  }

  getRedacted() {
    return this.getSummary();
  }

  /** Compact summary for `/healthz`. */
  healthSummary() {
    const summary = this.getSummary();
    return { total: summary.total, enabled: summary.enabled, subscribed: summary.subscribed, busy: summary.busy };
  }

  /** Full pool stats. */
  stats() {
    const summary = this.getSummary();
    return {
      ...summary,
      identities: this.list(),
      queues: this.queueStats()
    };
  }

  _summary(entry, queue) {
    const record = entry.identity;
    const auth = record.auth || defaultAuthRecord();
    const expiresAtMs = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now() : Boolean(auth.token);
    return {
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      subscribed: entry.subscribed,
      source: entry.source,
      createdAt: entry.createdAt,
      journeyId: record.journeyId,
      deviceId: record.deviceId,
      deviceName: record.deviceName || null,
      conversationId: record.conversationId,
      fingerprint: record.durableStream.fingerprint,
      durableStreamEnabled: Boolean(record.durableStream && record.durableStream.publicKeyJwk),
      syncEnabled: Boolean(record.sync && record.sync.enabled),
      authTier: expired ? 'free' : auth.tier || 'free',
      authenticated: Boolean(auth.token) && !expired,
      authExpiresAt: auth.expiresAt || null,
      // v2.15: subscription entity bound to this identity (one subscription can back many).
      subscriptionId: entry.subscriptionId || null,
      subscriptionLabel: entry.subscription && entry.subscription.label ? entry.subscription.label : null,
      subscriptionTier: entry.subscription && entry.subscription.tier ? entry.subscription.tier : null,
      subscriptionExpiresAt: entry.subscription && entry.subscription.expiresAt ? entry.subscription.expiresAt : null,
      // v2.32：额度冷却状态（临时禁用，不持久化到 subscription）
      cooling: this._isCooling(entry),
      cooldownUntil: Number.isFinite(Number(entry.cooldownUntil)) ? Number(entry.cooldownUntil) : null,
      cooldownReason: entry.cooldownReason || null,
      cooldownScope: entry.cooldownScope || null,
      sessions: entry.stats.sessions,
      requests: entry.stats.requests,
      failures: entry.stats.failures,
      lastUsedAt: entry.stats.lastUsedAt,
      queue: queue || this._queueFor(entry.id).stats(),
      active: this._pool ? this._pool.activeId === entry.id : false
    };
  }

  list() {
    if (!this._pool) return [];
    return this._pool.identities.map((entry) => this._summary(entry));
  }

  /** Redacted detail (no private key / token). */
  get(id) {
    const entry = this._require(id);
    const summary = this._summary(entry);
    const record = entry.identity;
    return {
      ...summary,
      durableStream: {
        fingerprint: record.durableStream.fingerprint,
        publicKeyJwk: deepClone(record.durableStream.publicKeyJwk),
        hasPrivateKey: Boolean(record.durableStream.privateKeyJwk),
        version: record.durableStream.version
      },
      sync: {
        enabled: Boolean(record.sync && record.sync.enabled),
        deviceCount: Array.isArray(record.sync && record.sync.devices) ? record.sync.devices.length : 0,
        lastSyncAt: (record.sync && record.sync.lastSyncAt) || null,
        hasPairingCode: Boolean(record.sync && record.sync.pairingCode),
        hasRecoveryCode: Boolean(record.sync && record.sync.recoveryCode)
      },
      auth: {
        authenticated: summary.authenticated,
        email: record.auth.email || null,
        tier: summary.authTier,
        entitlements: deepClone(record.auth.entitlements || []),
        expiresAt: record.auth.expiresAt || null,
        activatedAt: record.auth.activatedAt || null,
        verified: Boolean(record.auth.verified),
        verifyError: record.auth.verifyError || null
      },
      stats: { ...entry.stats }
    };
  }

  // ------------------------------------------------------------------ CRUD

  /**
   * Create one identity (manual or imported).
   * @param {{ label?: string, identity?: Record<string, any>, import?: Record<string, any>, deviceName?: string }} [params]
   */
  async create(params = {}) {
    const source = params.import || params.identity;
    const customName = typeof params.deviceName === 'string' ? params.deviceName.trim() : '';
    if (customName && (customName.length < 1 || customName.length > 100)) {
      throw new PoolError('deviceName must be 1–100 characters', { status: 400, code: 'invalid_identity', field: 'deviceName' });
    }
    return this._mutate(() => {
      if (this._pool.identities.length >= this.poolConfig.maxIdentities) {
        throw new PoolError(`identity pool is full (max ${this.poolConfig.maxIdentities})`, {
          status: 409,
          code: 'pool_full',
          hint: 'delete unused identities or raise config.pool.maxIdentities'
        });
      }
      let record;
      try {
        record = source
          ? normalizeIdentityRecord(source.identity || source, { hostname: os.hostname() })
          : createIdentityRecord({ hostname: os.hostname(), deviceName: customName || this._uniqueDeviceName() });
      } catch (error) {
        if (error instanceof IdentityError) throw new PoolError(error.message, { status: 400, code: 'invalid_identity', detail: error.detail, cause: error });
        throw error;
      }
      if (source) record.deviceName = customName || this._uniqueDeviceName();
      else if (customName) record.deviceName = customName;
      const entry = {
        id: this._newId(),
        label: typeof params.label === 'string' && params.label.trim() ? params.label.trim() : `分身 ${this._pool.identities.length + 1}`,
        enabled: true,
        subscribed: params.subscribed === true || PAID_TIERS.includes(record.auth && record.auth.tier),
        source: source ? 'imported' : 'generated',
        createdAt: now(),
        identity: record,
        stats: { sessions: 0, requests: 0, failures: 0, lastUsedAt: null }
      };
      this._pool.identities.push(entry);
      if (!this._pool.activeId) this._pool.activeId = entry.id;
      return this._summary(entry);
    });
  }

  /**
   * Generate 1–20 identities with independent keys.
   * @param {{ count?: number, labelPrefix?: string, subscribed?: boolean }} [params]
   */
  async generate(params = {}) {
    const count = params.count === undefined || params.count === null ? 1 : Math.floor(Number(params.count));
    if (count < 1 || count > 20) {
      throw new PoolError('count must be between 1 and 20', { status: 400, code: 'invalid_request', field: 'count' });
    }
    const prefix = typeof params.labelPrefix === 'string' && params.labelPrefix.trim() ? params.labelPrefix.trim() : '分身';
    return this._mutate(() => {
      if (this._pool.identities.length + count > this.poolConfig.maxIdentities) {
        throw new PoolError(`generating ${count} identities would exceed the pool limit (${this.poolConfig.maxIdentities})`, {
          status: 409,
          code: 'pool_full',
          hint: 'delete unused identities or raise config.pool.maxIdentities'
        });
      }
      const existingNumbers = new Set(
        this._pool.identities
          .map((entry) => {
            const match = entry.label.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\d+)$`));
            return match ? Number(match[1]) : null;
          })
          .filter((value) => value !== null)
      );
      let nextNumber = 1;
      const created = [];
      const takenNames = this._takenDeviceNames();
      for (let index = 0; index < count; index += 1) {
        while (existingNumbers.has(nextNumber)) nextNumber += 1;
        existingNumbers.add(nextNumber);
        const deviceName = this._uniqueDeviceName(takenNames);
        takenNames.add(deviceName);
        const record = createIdentityRecord({ hostname: os.hostname(), deviceName });
        const entry = {
          id: this._newId(),
          label: `${prefix} ${nextNumber}`,
          enabled: true,
          subscribed: params.subscribed === true,
          source: 'generated',
          createdAt: now(),
          identity: record,
          stats: { sessions: 0, requests: 0, failures: 0, lastUsedAt: null }
        };
        this._pool.identities.push(entry);
        created.push(this._summary(entry));
        nextNumber += 1;
      }
      return created;
    });
  }

  /** Import a full identity export document as a new pool identity. */
  async importIdentity(document, options = {}) {
    const identity = document && document.identity ? document.identity : document;
    return this.create({ label: options.label, identity });
  }

  /** @param {string} id @param {{ label?: string, enabled?: boolean, subscribed?: boolean, deviceName?: string }} patch */
  async update(id, patch = {}) {
    return this._mutate(() => {
      const entry = this._require(id);
      if (patch.label !== undefined) {
        fail(typeof patch.label === 'string' && patch.label.trim(), 'label must be a non-empty string', 'label');
        entry.label = patch.label.trim();
      }
      if (patch.enabled !== undefined) {
        fail(typeof patch.enabled === 'boolean', 'enabled must be a boolean', 'enabled');
        entry.enabled = patch.enabled;
        if (!entry.enabled) this.releaseRuntime(id);
      }
      if (patch.subscribed !== undefined) {
        fail(typeof patch.subscribed === 'boolean', 'subscribed must be a boolean', 'subscribed');
        entry.subscribed = patch.subscribed;
      }
      if (patch.deviceName !== undefined) {
        const name = typeof patch.deviceName === 'string' ? patch.deviceName.trim() : '';
        if (!name || name.length > 100) {
          throw new PoolError('deviceName must be 1–100 characters', { status: 400, code: 'invalid_identity', field: 'deviceName' });
        }
        entry.identity.deviceName = name;
        entry.identity.rotatedAt = now();
      }
      return this._summary(entry);
    });
  }

  /** Alias matching the QA/admin naming. */
  async remove(id, options = {}) {
    return this.delete(id, options);
  }

  /** Delete an identity; refuses when active or bound unless `force`. */
  async delete(id, options = {}) {
    return this._mutate(() => {
      const entry = this._require(id);
      const boundSessions = Object.entries(this._pool.bindings)
        .filter(([, binding]) => binding.identityId === id)
        .map(([sessionKey]) => sessionKey);
      const isActive = this._pool.activeId === id;
      if (!options.force && (isActive || boundSessions.length > 0)) {
        throw new PoolError(`identity "${id}" is still in use`, {
          status: 409,
          code: 'identity_in_use',
          hint: isActive ? 'activate another identity first or use force=true' : 'unbind sessions or use force=true',
          detail: { active: isActive, boundSessions: boundSessions.length }
        });
      }
      for (const sessionKey of boundSessions) delete this._pool.bindings[sessionKey];
      this._pool.identities = this._pool.identities.filter((item) => item.id !== id);
      if (isActive) this._pool.activeId = this._pool.identities[0] ? this._pool.identities[0].id : null;
      this.releaseRuntime(id);
      return { deleted: true, identityId: id, removedBindings: boundSessions.length, activeId: this._pool.activeId };
    });
  }

  async activate(id) {
    return this._mutate(() => {
      this._require(id);
      this._pool.activeId = id;
      return { activeId: id, pool: this.getSummary() };
    });
  }

  /** @param {string} id @param {'journey'|'device'|'all'} [scope] */
  async rotate(id, scope = 'journey') {
    return this._mutate(() => {
      const entry = this._require(id);
      try {
        entry.identity = rotateIdentityRecord(entry.identity, scope);
      } catch (error) {
        if (error instanceof IdentityError) throw new PoolError(error.message, { status: 400, code: 'invalid_identity', detail: error.detail, cause: error });
        throw error;
      }
      this.releaseRuntime(id);
      return this._summary(entry);
    });
  }

  /** Full identity export document (contains the private key + token). */
  exportIdentity(id) {
    const entry = this._require(id);
    return { version: 1, exportedAt: now(), identity: deepClone(entry.identity) };
  }

  /** Alias. */
  export(id) {
    return this.exportIdentity(id);
  }

  // ------------------------------------------------------------------ subscription (v2.15)

  /** Inject the first-class subscription store (one subscription can back many identities). */
  setSubscriptionStore(store) {
    this.subscriptionStore = store || null;
    return this;
  }

  /**
   * Bind an existing subscription entity to an identity.
   * @param {string} id identity id
   * @param {string} subscriptionId subscription entity id (sub_xxxx)
   * @param {object} [info] raw subscription record (token/email/tier/expiresAt/...)
   */
  async bindSubscriptionToIdentity(id, subscriptionId, info = null) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      throw new PoolError('"subscriptionId" is required', { status: 400, code: 'invalid_request', field: 'subscriptionId' });
    }
    let sub = info;
    if (!sub && this.subscriptionStore) {
      sub = await this.subscriptionStore.getRaw(subscriptionId);
    }
    if (!sub || typeof sub !== 'object') {
      throw new PoolError(`subscription "${subscriptionId}" not found`, {
        status: 404,
        code: 'subscription_not_found',
        field: 'subscriptionId'
      });
    }
    const tier = PAID_TIERS.includes(sub.tier) ? sub.tier : 'free';
    return this._mutate(() => {
      const entry = this._require(id);
      entry.subscriptionId = subscriptionId;
      entry.subscription = { label: sub.label || null, tier, expiresAt: sub.expiresAt || null };
      entry.subscribed = PAID_TIERS.includes(tier);
      entry.identity.auth = {
        ...defaultAuthRecord(),
        ...(entry.identity.auth || {}),
        token: sub.token || null,
        email: sub.email || null,
        tier,
        entitlements: Array.isArray(sub.entitlements) ? deepClone(sub.entitlements) : [],
        expiresAt: sub.expiresAt || null,
        activatedAt: sub.createdAt || now(),
        verified: sub.verified === true,
        verifyError: sub.verifyError || null,
        tokenHash: typeof sub.tokenHash === 'string' ? sub.tokenHash : null
      };
      this.releaseRuntime(id);
      return this._summary(entry);
    });
  }

  /** Remove the subscription binding from one identity (subscription entity itself is kept). */
  async unbindIdentitySubscription(id) {
    return this._mutate(() => {
      const entry = this._require(id);
      entry.subscriptionId = null;
      entry.subscription = null;
      entry.subscribed = false;
      entry.identity.auth = defaultAuthRecord();
      this.releaseRuntime(id);
      return this._summary(entry);
    });
  }

  /**
   * v2.27：订阅 access token 自动续期后，把新 token 同步到所有绑定了该订阅的身份。
   * （identity.auth 存的是绑定时的 token 快照，不更新就会继续用过期 token。）
   * @param {string} subscriptionId
   * @param {{ token?: string, tier?: string, expiresAt?: string|null, email?: string|null, entitlements?: any[] }} info
   */
  async syncSubscriptionToken(subscriptionId, info = {}) {
    if (!this._pool || !subscriptionId) return { updated: 0 };
    const token = typeof info.token === 'string' ? info.token : '';
    if (!token) return { updated: 0 };
    return this._mutate(() => {
      let updated = 0;
      for (const entry of this._pool.identities) {
        if (entry.subscriptionId !== subscriptionId) continue;
        const auth = { ...defaultAuthRecord(), ...(entry.identity.auth || {}) };
        auth.token = token;
        if (typeof info.tier === 'string') {
          auth.tier = PAID_TIERS.includes(info.tier) ? info.tier : 'free';
          entry.subscribed = PAID_TIERS.includes(info.tier);
          entry.subscription = {
            ...(entry.subscription || {}),
            tier: auth.tier,
            expiresAt: info.expiresAt || (entry.subscription && entry.subscription.expiresAt) || null
          };
        }
        if (info.expiresAt !== undefined) auth.expiresAt = info.expiresAt || null;
        if (info.email !== undefined) auth.email = info.email || null;
        if (Array.isArray(info.entitlements)) auth.entitlements = deepClone(info.entitlements);
        auth.verified = true;
        entry.identity.auth = auth;
        this.releaseRuntime(entry.id);
        updated += 1;
      }
      return { updated };
    });
  }

  /**
   * v2.31：取出某身份当前的 Duck.ai access token（用于查询额度；不对外暴露）。
   * @param {string} id
   * @returns {string|null}
   */
  getIdentityToken(id) {
    const entry = this._find(id);
    const token = entry && entry.identity && entry.identity.auth ? entry.identity.auth.token : null;
    return typeof token === 'string' && token ? token : null;
  }

  /** Ids of identities currently bound to a subscription. */
  identitiesBoundToSubscription(subscriptionId) {
    if (!this._pool || !subscriptionId) return [];
    return this._pool.identities.filter((entry) => entry.subscriptionId === subscriptionId).map((entry) => entry.id);
  }

  /**
   * Legacy API kept for compatibility: bind a raw token to one identity.
   * When a subscription store is available the token is first registered as an entity (so it can
   * later be shared with other identities); otherwise the old per-identity behaviour is used.
   * @param {string} id
   * @param {string | { token?: string, email?: string|null, tier?: string, entitlements?: any[], expiresAt?: string|null, activatedAt?: number|null, verified?: boolean }} tokenInfo
   */
  async bindSubscription(id, tokenInfo) {
    if (typeof tokenInfo === 'string' && this.subscriptionStore) {
      const { subscription } = await this.subscriptionStore.add({ token: tokenInfo });
      const raw = await this.subscriptionStore.getRaw(subscription.id);
      return this.bindSubscriptionToIdentity(id, subscription.id, raw);
    }
    let info = tokenInfo;
    if (typeof tokenInfo === 'string') {
      try {
        info = parseSubscriptionToken(tokenInfo);
      } catch (error) {
        if (error instanceof AuthError) {
          throw new PoolError(error.message, { status: error.status || 422, code: error.code || 'token_invalid', detail: error.detail, cause: error });
        }
        throw error;
      }
    }
    fail(info && typeof info === 'object', 'tokenInfo is required', 'token');
    const token = typeof info.token === 'string' ? info.token : '';
    const tier = PAID_TIERS.includes(info.tier) ? info.tier : 'free';
    const entitlements = Array.isArray(info.entitlements) ? info.entitlements : [];
    return this._mutate(() => {
      const entry = this._require(id);
      entry.identity.auth = {
        ...defaultAuthRecord(),
        ...(entry.identity.auth || {}),
        token: token || (entry.identity.auth && entry.identity.auth.token) || null,
        email: info.email || null,
        tier,
        entitlements,
        expiresAt: info.expiresAt || null,
        activatedAt: info.activatedAt || now(),
        verified: info.verified === true,
        verifyError: null,
        tokenHash: typeof info.tokenHash === 'string' ? info.tokenHash : null
      };
      entry.subscribed = PAID_TIERS.includes(tier);
      this.releaseRuntime(id);
      return {
        identity: this._summary(entry),
        subscription: {
          authenticated: Boolean(entry.identity.auth.token),
          email: entry.identity.auth.email,
          tier,
          entitlements,
          expiresAt: entry.identity.auth.expiresAt,
          verified: entry.identity.auth.verified
        }
      };
    });
  }

  async clearSubscription(id) {
    const summary = await this.unbindIdentitySubscription(id);
    return {
      identity: summary,
      subscription: { authenticated: false, email: null, tier: 'free', entitlements: [], expiresAt: null, verified: false }
    };
  }


  // ------------------------------------------------------------------ routing / bindings

  /**
   * v2.30：双池路由。
   *  - 付费池：只含已订阅身份（付费模型必须走订阅身份）；
   *  - free 池：优先未订阅身份（避免免费流量消耗订阅身份），若池内没有未订阅身份则回退到全部。
   */
  _candidates(paidModel) {
    // v2.32：额度冷却中的身份临时不参与路由（不解绑已有会话，只影响新请求/改绑请求）
    this.pruneCooldowns();
    const enabled = this._pool.identities.filter((entry) => entry.enabled && !this._isCooling(entry));
    let pool;
    if (paidModel) {
      pool = enabled.filter((entry) => entry.subscribed);
    } else {
      const freeOnly = enabled.filter((entry) => !entry.subscribed);
      pool = freeOnly.length ? freeOnly : enabled;
    }
    return pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /* ---------------- v2.32：额度冷却（临时禁用，不需要人工解绑） ---------------- */

  /** 冷却配置的兜底时长（毫秒）：上游没给 resetAt 时使用。 */
  _quotaCooldownMs() {
    const raw = this.config && this.config.pool ? this.config.pool.quotaCooldownMinutes : undefined;
    const minutes = Number(raw);
    const normalized = Number.isFinite(minutes) && minutes > 0 ? Math.min(10080, Math.floor(minutes)) : 1440;
    return normalized * 60 * 1000;
  }

  /** 身份是否仍在冷却期。 */
  _isCooling(entry, at = now()) {
    const until = Number(entry && entry.cooldownUntil);
    return Number.isFinite(until) && until > at;
  }

  /** 清理已过期的冷却状态；返回清理数量。 */
  pruneCooldowns() {
    if (!this._pool) return 0;
    const nowMs = now();
    let cleared = 0;
    for (const entry of this._pool.identities) {
      if (Number.isFinite(Number(entry.cooldownUntil)) && Number(entry.cooldownUntil) <= nowMs) {
        entry.cooldownUntil = null;
        entry.cooldownReason = null;
        entry.cooldownScope = null;
        entry.cooldownMarkedAt = null;
        cleared += 1;
      }
    }
    if (cleared) this._schedulePersist();
    return cleared;
  }

  /**
   * 标记身份额度耗尽，进入冷却（临时禁用，禁止参与路由）。
   * @param {string} id
   * @param {{ until?: number|null, reason?: string, scope?: string, windows?: any[]|null }} [options]
   */
  markCooldown(id, options = {}) {
    return this._mutate(() => {
      const entry = this._require(id);
      const at = now();
      const until = Number.isFinite(Number(options.until)) && Number(options.until) > at
        ? Math.floor(Number(options.until))
        : at + this._quotaCooldownMs();
      entry.cooldownUntil = until;
      entry.cooldownReason = typeof options.reason === 'string' && options.reason ? options.reason : 'quota_exhausted';
      entry.cooldownScope = typeof options.scope === 'string' && options.scope ? options.scope : 'entity';
      entry.cooldownMarkedAt = at;
      this.releaseRuntime(id);
      this.logger?.warn?.('[duck:pool] identity cooling down (quota exhausted)', {
        id,
        until: new Date(until).toISOString(),
        reason: entry.cooldownReason,
        scope: entry.cooldownScope
      });
      return { identityId: id, cooldownUntil: until, reason: entry.cooldownReason, scope: entry.cooldownScope };
    });
  }

  /** 解除冷却（审批/手动恢复）。 */
  clearCooldown(id) {
    return this._mutate(() => {
      const entry = this._require(id);
      const had = entry.cooldownUntil || null;
      entry.cooldownUntil = null;
      entry.cooldownReason = null;
      entry.cooldownScope = null;
      entry.cooldownMarkedAt = null;
      return { identityId: id, cleared: Boolean(had), previousUntil: had };
    });
  }

  /** 绑定缓存有效期（毫秒）；0 表示永不过期。读取实时配置，支持管理页修改后立即生效。 */
  _bindingTtlMs() {
    const raw = this.config && this.config.pool ? this.config.pool.bindingTtlDays : undefined;
    const days = Number(raw);
    const normalized = Number.isFinite(days) && days >= 0 ? Math.min(365, Math.floor(days)) : 7;
    return normalized === 0 ? 0 : normalized * 24 * 60 * 60 * 1000;
  }

  /** 移除超过 TTL 未被使用的会话绑定；返回被移除的条数。 */
  pruneBindings() {
    if (!this._pool || !this._pool.bindings) return 0;
    const ttl = this._bindingTtlMs();
    if (!ttl) return 0;
    const deadline = now() - ttl;
    let removed = 0;
    for (const [key, binding] of Object.entries(this._pool.bindings)) {
      const at = Number(binding && (binding.updatedAt || binding.createdAt)) || 0;
      if (at && at < deadline) {
        delete this._pool.bindings[key];
        removed += 1;
      }
    }
    if (removed) this._schedulePersist();
    return removed;
  }

  /** 池设置（供管理 API 读取）。 */
  getSettings() {
    return {
      bindingTtlDays: this._bindingTtlMs() === 0 ? 0 : Math.round(this._bindingTtlMs() / 86400000),
      bindingsTotal: this._pool ? Object.keys(this._pool.bindings || {}).length : 0
    };
  }

  _hashIndex(sessionKey, candidates) {
    const hex = sha256Hex(`${sessionKey}:${this._pool.salt}`);
    return parseInt(hex.slice(0, 8), 16) % candidates.length;
  }

  _leastLoaded(candidates) {
    let best = null;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const entry of candidates) {
      const queue = this._queueFor(entry.id);
      const load = queue.inFlight * 1000 + queue.waiting;
      if (load < bestLoad) {
        bestLoad = load;
        best = entry;
      }
    }
    return best;
  }

  _selectFor(sessionKey, paidModel) {
    const candidates = this._candidates(paidModel);
    if (!candidates.length) {
      // v2.32：全部身份都在额度冷却 → 429 + 最近恢复时间
      const cooling = this._pool.identities
        .filter((entry) => entry.enabled && this._isCooling(entry))
        .map((entry) => Number(entry.cooldownUntil) || 0)
        .filter((value) => value > 0);
      if (cooling.length) {
        const retryAt = Math.min(...cooling);
        throw new PoolError('all enabled identities are cooling down after hitting their quota', {
          status: 429,
          code: 'all_identities_cooling',
          retriable: true,
          retryAfterMs: Math.max(0, retryAt - now()),
          retryAt,
          hint: '所有可用身份的额度都已用完，等额度恢复后会自动恢复路由；也可在身份池手动解除冷却'
        });
      }
      if (paidModel) {
        throw new PoolError('no subscribed identity is available for a paid model', {
          status: 403,
          code: 'model_requires_subscription',
          hint: 'bind a Duck.ai Plus/Pro subscription to an enabled identity'
        });
      }
      throw new PoolError('no enabled identity is available', { status: 503, code: 'no_identity_available', hint: 'create or enable an identity' });
    }
    const strategy = (this._pool.router && this._pool.router.strategy) || 'hash';
    if (!sessionKey || strategy === 'least-loaded') return { entry: this._leastLoaded(candidates), strategy };
    return { entry: candidates[this._hashIndex(sessionKey, candidates)], strategy };
  }

  _bindingMeta(sessionKey) {
    return this._pool.bindings[String(sessionKey)] || null;
  }

  /**
   * Route a session to an identity and persist the binding (unless `sessionKey` is empty).
   * @param {string | null | undefined} sessionKey
   * @param {{ paidModel?: boolean, model?: string }} [options]
   * @returns {Promise<string>} identityId
   */
  async route(sessionKey, options = {}) {
    await this.init();
    return (await this.routeDetailed(sessionKey, options)).identityId;
  }

  /**
   * Like `route()` but returns the identity summary as well.
   * @param {string | null | undefined} sessionKey
   * @param {{ paidModel?: boolean, model?: string }} [options]
   */
  async routeDetailed(sessionKey, options = {}) {
    await this.init();
    const paidModel = options.paidModel === true || options.paid === true;
    // v2.29：已绑定的身份不满足付费模型要求时，允许改绑到订阅身份（连接测试用）
    const rebindOnSubscriptionMismatch = options.rebindOnSubscriptionMismatch === true;
    const key = sessionKey === undefined || sessionKey === null || String(sessionKey).trim() === '' ? null : String(sessionKey);
    if (key) {
      // v2.30：先清理过期绑定（缓存语义：7 天未使用即失效）
      this.pruneBindings();
      const binding = this._bindingMeta(key);
      if (binding) {
        const entry = this._find(binding.identityId);
        if (!entry || !entry.enabled) {
          throw new PoolError(`bound identity "${binding.identityId}" is not available`, {
            status: 503,
            code: 'identity_unavailable',
            hint: entry ? 'enable the identity or unbind the session' : 'the bound identity was deleted; unbind the session to re-route'
          });
        }
        // v2.32：绑定身份额度耗尽 → 本次请求按需交给其他身份（只在真正调用时改绑，未调用的会话保持原绑定）
        if (this._isCooling(entry)) {
          let replacement = null;
          try {
            replacement = this._selectFor(key, paidModel);
          } catch (error) {
            throw error;
          }
          return this._mutate(() => {
            const timestamp = now();
            const existing = this._pool.bindings[key];
            this._pool.bindings[key] = {
              identityId: replacement.entry.id,
              createdAt: existing ? existing.createdAt : timestamp,
              updatedAt: timestamp,
              tier: paidModel ? 'paid' : 'free'
            };
            replacement.entry.stats.sessions += 1;
            replacement.entry.stats.lastUsedAt = timestamp;
            this.logger?.info?.('[duck:pool] session moved off cooling identity', {
              sessionKey: key,
              from: entry.id,
              to: replacement.entry.id,
              reason: 'quota_cooldown'
            });
            return {
              identityId: replacement.entry.id,
              identity: this._summary(replacement.entry),
              bound: true,
              rebound: true,
              reboundFrom: entry.id,
              reboundReason: 'quota_cooldown',
              strategy: replacement.strategy
            };
          });
        }
        // v2.30：双池语义。绑定只在「需要的池」与当前绑定不一致时切换一次：
        //  - 付费模型 + 绑定在 free 身份 → 改绑到付费池；
        //  - 免费模型 + 绑定在订阅身份 → 若存在 free 身份则改绑回 free 池（避免占用订阅额度）。
        const needsRebind =
          (paidModel && !entry.subscribed) ||
          (!paidModel && entry.subscribed && this._candidates(false).some((item) => !item.subscribed));
        if (needsRebind) {
          const rebound = this._selectFor(key, paidModel);
          const fromIdentityId = entry.id;
          // 目标身份与当前相同（例如只剩订阅身份）→ 直接复用，不写绑定
          if (rebound.entry.id === entry.id) {
            return {
              identityId: entry.id,
              identity: this._summary(entry),
              bound: true,
              rebound: false,
              strategy: rebound.strategy
            };
          }
          return this._mutate(() => {
            const timestamp = now();
            const existing = this._pool.bindings[key];
            this._pool.bindings[key] = {
              identityId: rebound.entry.id,
              createdAt: existing ? existing.createdAt : timestamp,
              updatedAt: timestamp,
              tier: paidModel ? 'paid' : 'free'
            };
            rebound.entry.stats.sessions += 1;
            rebound.entry.stats.lastUsedAt = timestamp;
            return {
              identityId: rebound.entry.id,
              identity: this._summary(rebound.entry),
              bound: true,
              rebound: true,
              reboundFrom: fromIdentityId,
              strategy: rebound.strategy
            };
          });
        }
        entry.stats.lastUsedAt = now();
        // 刷新绑定时间（滑动 TTL）与所属池
        this._mutate(() => {
          const current = this._pool.bindings[key];
          if (current) {
            current.updatedAt = now();
            current.tier = paidModel ? 'paid' : 'free';
          }
        });
        this._schedulePersist();
        return {
          identityId: entry.id,
          identity: this._summary(entry),
          bound: true,
          rebound: false,
          cooling: this._isCooling(entry),
          strategy: (this._pool.router && this._pool.router.strategy) || 'hash'
        };
      }
    }
    const { entry, strategy } = this._selectFor(key, paidModel);
    if (!key) {
      return { identityId: entry.id, identity: this._summary(entry), bound: false, strategy };
    }
    return this._mutate(() => {
      const timestamp = now();
      const existing = this._pool.bindings[key];
      this._pool.bindings[key] = {
        identityId: entry.id,
        createdAt: existing ? existing.createdAt : timestamp,
        updatedAt: timestamp,
        tier: paidModel ? 'paid' : 'free'
      };
      this._enforceBindingLimit();
      entry.stats.sessions += 1;
      entry.stats.lastUsedAt = timestamp;
      return { identityId: entry.id, identity: this._summary(entry), bound: true, strategy };
    });
  }

  /**
   * Resolve wrapper accepting `{ sessionKey, paidModel|paid, model }` or a bare session key.
   * @param {{ sessionKey?: string, paidModel?: boolean, paid?: boolean, model?: string } | string} input
   * @param {{ paidModel?: boolean, model?: string }} [options]
   */
  async resolve(input, options = {}) {
    if (input && typeof input === 'object') {
      return this.routeDetailed(input.sessionKey, { paidModel: input.paidModel ?? input.paid, model: input.model });
    }
    return this.routeDetailed(input, options);
  }

  /** Route and return the runtime handle (does not run a request; queueing is done by `run`). */
  async routeRuntime(sessionKey, options = {}) {
    const detail = await this.routeDetailed(sessionKey, options);
    const runtime = await this.getRuntime(detail.identityId);
    return { ...detail, runtime };
  }

  _enforceBindingLimit() {
    const entries = Object.entries(this._pool.bindings);
    if (entries.length <= this.poolConfig.bindingsLimit) return;
    entries
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
      .slice(0, entries.length - this.poolConfig.bindingsLimit)
      .forEach(([key]) => {
        delete this._pool.bindings[key];
      });
  }

  /** Manually bind a session. */
  async bind(sessionKey, identityId) {
    return this._mutate(() => {
      const key = String(sessionKey || '').trim();
      fail(key, 'sessionKey is required', 'sessionKey');
      const entry = this._require(identityId);
      const timestamp = now();
      const existing = this._pool.bindings[key];
      this._pool.bindings[key] = { identityId: entry.id, createdAt: existing ? existing.createdAt : timestamp, updatedAt: timestamp };
      this._enforceBindingLimit();
      return { sessionKey: key, identityId: entry.id, createdAt: this._pool.bindings[key].createdAt, updatedAt: timestamp };
    });
  }

  /** Remove a session binding (next request re-routes). */
  async unbind(sessionKey) {
    return this._mutate(() => {
      const key = String(sessionKey || '').trim();
      const existed = Boolean(this._pool.bindings[key]);
      delete this._pool.bindings[key];
      return { ok: true, sessionKey: key, removed: existed };
    });
  }

  getBinding(sessionKey) {
    const binding = this._bindingMeta(sessionKey);
    return binding ? { sessionKey: String(sessionKey), ...binding } : null;
  }

  /** @param {{ limit?: number, offset?: number }} [options] */
  listBindings(options = {}) {
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const all = Object.entries(this._pool ? this._pool.bindings : {})
      .map(([sessionKey, binding]) => ({
        sessionKey,
        identityId: binding.identityId,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
        tier: binding.tier === 'paid' ? 'paid' : 'free'
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  // ------------------------------------------------------------------ router config

  getRouting() {
    const perIdentity = (this._pool ? this._pool.identities : []).map((entry) => {
      const queue = this._queueFor(entry.id).stats();
      return { id: entry.id, label: entry.label, waiting: queue.waiting, inFlight: queue.inFlight, requests: queue.requests, rps: queue.rps };
    });
    return {
      strategy: (this._pool && this._pool.router && this._pool.router.strategy) || this.poolConfig.strategy,
      saltPresent: Boolean(this._pool && this._pool.salt),
      perIdentity,
      totals: perIdentity.reduce(
        (acc, item) => ({ waiting: acc.waiting + item.waiting, inFlight: acc.inFlight + item.inFlight, requests: acc.requests + item.requests }),
        { waiting: 0, inFlight: 0, requests: 0 }
      )
    };
  }

  /** @param {{ strategy?: 'hash'|'least-loaded', salt?: string }} patch */
  async setRouter(patch = {}) {
    return this._mutate(() => {
      if (patch.strategy !== undefined) {
        if (!['hash', 'least-loaded'].includes(patch.strategy)) {
          throw new PoolError(`unsupported router strategy "${patch.strategy}"`, { status: 400, code: 'invalid_request', field: 'strategy' });
        }
        this._pool.router = { ...(this._pool.router || {}), strategy: patch.strategy };
      }
      if (patch.salt !== undefined) {
        if (typeof patch.salt !== 'string' || !/^[a-f0-9]{8,128}$/i.test(patch.salt)) {
          throw new PoolError('salt must be an 8–128 char hex string', { status: 400, code: 'invalid_request', field: 'salt' });
        }
        this._pool.salt = patch.salt;
      }
      return this.getRouting();
    });
  }

  /** Alias. */
  async setStrategy(patch = {}) {
    return this.setRouter(patch);
  }

  // ------------------------------------------------------------------ queue / runtime

  _queueFor(identityId) {
    let queue = this.queues.get(identityId);
    if (!queue) {
      queue = new IdentityQueue({
        identityId,
        rps: this.poolConfig.rps,
        maxConcurrent: this.poolConfig.maxConcurrent,
        queueLimit: this.poolConfig.queueLimit,
        queueTimeoutMs: this.poolConfig.queueTimeoutMs,
        logger: this.logger
      });
      this.queues.set(identityId, queue);
    }
    return queue;
  }

  /** @param {string} [identityId] */
  queueStats(identityId) {
    if (identityId) return this._queueFor(identityId).stats();
    const byIdentity = {};
    const totals = { waiting: 0, inFlight: 0, rps: this.poolConfig.rps, requests: 0 };
    for (const entry of this._pool ? this._pool.identities : []) {
      const stats = this._queueFor(entry.id).stats();
      byIdentity[entry.id] = stats;
      totals.waiting += stats.waiting;
      totals.inFlight += stats.inFlight;
      totals.requests += stats.requests;
    }
    return { byIdentity, totals };
  }

  /** Alias some callers use for pool-level stats. */
  getStats() {
    return this.stats();
  }

  /**
   * Lazily build (and cache) the DuckClient runtime for one identity.
   * @param {string} identityId
   */
  async getRuntime(identityId) {
    await this.init();
    const entry = this._require(identityId);
    const existing = this.runtimes.get(identityId);
    if (existing) {
      existing.lastUsedAt = now();
      return existing;
    }
    const record = deepClone(entry.identity);
    let client = null;
    let store = null;
    try {
      if (this.createRuntime) {
        const created = await this.createRuntime(record, {
          identityId,
          config: this.config,
          proxyManager: this.proxyManager,
          logger: this.logger,
          pool: this
        });
        if (created && typeof created.chat === 'function') client = created;
        else if (created && created.client) {
          client = created.client;
          store = created.store || null;
        }
        if (!client) throw new Error('createRuntime did not return a DuckClient-like object');
      } else {
        store = new MemoryIdentityStore(record, { source: 'pool' });
        client = new DuckClient({
          ...this.duckConfig,
          identityStore: store,
          proxyManager: this.proxyManager,
          logger: this.logger
        });
        if (this.duckConfig.durableStream && this.duckConfig.durableStream.enabled) {
          // identityRecord path: durableStream opt-in stays as configured
        }
      }
      if (client && typeof client.init === 'function') await client.init();
    } catch (error) {
      throw new PoolError(`identity "${identityId}" runtime initialization failed`, {
        status: 503,
        code: 'identity_unavailable',
        detail: String((error && error.message) || error),
        cause: error
      });
    }
    const runtime = {
      identityId,
      identity: entry.identity,
      store,
      client,
      createdAt: now(),
      lastUsedAt: now(),
      queueWaitMs: 0,
      get journeyId() {
        return entry.identity.journeyId;
      },
      get fingerprint() {
        return entry.identity.durableStream.fingerprint;
      },
      chat: (params, handlers) => client.chat(params, handlers),
      imageGeneration: (params) => client.imageGeneration(params),
      health: typeof client.health === 'function' ? () => client.health() : undefined
    };
    this.runtimes.set(identityId, runtime);
    this.logger?.debug?.('[duck:pool] runtime created', { identityId, journeyId: entry.identity.journeyId });
    return runtime;
  }

  /** Drop the cached runtime (next call rebuilds from the current record). */
  releaseRuntime(identityId) {
    const runtime = this.runtimes.get(identityId);
    if (!runtime) return false;
    this.runtimes.delete(identityId);
    try {
      runtime.client?.close?.();
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * Run `fn(runtime)` for one identity under its queue (rps=1/maxConcurrent=1 by default).
   * Different identities run in parallel.
   * @template T
   * @param {string} identityId
   * @param {(runtime: any) => Promise<T>} fn
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async run(identityId, fn, options = {}) {
    await this.init();
    if (this._closed) {
      throw new PoolError('identity pool is closed', { status: 503, code: 'identity_unavailable' });
    }
    const entry = this._require(identityId);
    if (!entry.enabled) {
      throw new PoolError(`identity "${identityId}" is disabled`, { status: 503, code: 'identity_unavailable', hint: 'enable the identity first' });
    }
    if (typeof fn !== 'function') throw new PoolError('run() requires a function', { status: 400, code: 'invalid_request', field: 'fn' });
    const queue = this._queueFor(identityId);
    return queue.run(async ({ queueWaitMs }) => {
      entry.stats.requests += 1;
      entry.stats.lastUsedAt = now();
      this._schedulePersist();
      try {
        const runtime = await this.getRuntime(identityId);
        runtime.queueWaitMs = queueWaitMs;
        runtime.lastUsedAt = now();
        return await fn(runtime);
      } catch (error) {
        entry.stats.failures += 1;
        this._schedulePersist();
        throw error;
      }
    }, options);
  }

  // ------------------------------------------------------------------ idle reaping / close

  _startIdleTimer() {
    if (this._idleTimer) return;
    const interval = Math.max(15000, Math.min(60000, Math.floor(this.poolConfig.idleTimeoutMs / 2)));
    this._idleTimer = setInterval(() => this._reapIdleRuntimes(), interval);
    if (typeof this._idleTimer.unref === 'function') this._idleTimer.unref();
  }

  _reapIdleRuntimes() {
    const deadline = now() - this.poolConfig.idleTimeoutMs;
    for (const [identityId, runtime] of [...this.runtimes.entries()]) {
      const queue = this.queues.get(identityId);
      if (queue && (queue.inFlight > 0 || queue.waiting.length > 0)) continue;
      if (runtime.lastUsedAt && runtime.lastUsedAt > deadline) continue;
      this.releaseRuntime(identityId);
      this.logger?.debug?.('[duck:pool] runtime recycled after idle timeout', { identityId });
    }
  }

  getFileInfo() {
    return { ...this._fileInfo };
  }

  async close() {
    this._closed = true;
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    for (const identityId of [...this.runtimes.keys()]) this.releaseRuntime(identityId);
    for (const queue of this.queues.values()) queue.close();
    this.queues.clear();
    if (this._pool && this._ready) {
      await this._persist().catch(() => {});
    }
  }
}

/**
 * Create + initialize an identity pool.
 * @param {ConstructorParameters<typeof IdentityPool>[0]} options
 * @returns {Promise<IdentityPool>}
 */
export async function createIdentityPool(options = {}) {
  const pool = new IdentityPool(options);
  await pool.init();
  return pool;
}

export default { IdentityPool, PoolError, IdentityPoolError, IdentityQueue, createIdentityPool, DEFAULT_POOL_CONFIG, POOL_FILE_NAME };
