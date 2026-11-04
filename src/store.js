/**
 * JSON persistence, request logs, usage statistics and API-key management for
 * duckai-cpa v2.
 *
 * Storage layout under `dataDir`:
 *   - config.json      : runtime config (written by the admin API, kept for reference)
 *   - keys.json        : managed API keys ({ items: [...] })
 *   - logs.json        : legacy v2 split logs ({ upstream: [...], admin: [...] }); v2.69 起只导入不再写
 *   - stats.json       : v2 split stats ({ upstream: {...}, admin: {...} })
 *   - testsessions.json: admin connection-test sessions (src/admin/sessions.js)
 *
 * Every write is atomic: serialize to `<file>.<rand>.tmp` in the same directory,
 * then rename() over the target. Writes to the same file are queued.
 *
 * v2 BREAKING: old flat logs/stats files are discarded during migration (no
 * compatibility layer), as allowed by docs/ADMIN_API_V2.md.
 */

import fsp from 'node:fs/promises';
import { openDatabase, readJsonIfExists } from './db.js';
import path from 'node:path';
import crypto from 'node:crypto';

const PERSIST_DEBOUNCE_MS = 750;
const MAX_KEY_LABEL_LENGTH = 64;

/* ------------------------------------------------------------------ */
/* Low-level helpers (also used by config.js / sessions.js)            */
/* ------------------------------------------------------------------ */

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Read + parse a JSON file. Returns `fallback` when the file is missing. */
export async function readJsonFile(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Like readJsonFile but never throws; reports parse errors through onError. */
export async function readJsonFileSafe(file, fallback = null, onError = null) {
  try {
    return await readJsonFile(file, fallback);
  } catch (error) {
    if (typeof onError === 'function') onError(error);
    return fallback;
  }
}

/** Atomic JSON write (temp file + rename). */
export async function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const body = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Constant-time string comparison (hash first so lengths always match). */
export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = crypto.createHash('sha256').update(a, 'utf8').digest();
  const right = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function keyPreview(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.length <= 14) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 11)}...${key.slice(-4)}`;
}

function freshUpstreamStats() {
  return {
    requests: 0,
    errors: 0,
    latencyTotalMs: 0,
    queueWaitTotalMs: 0,
    totalPromptChars: 0,
    byModel: {},
    byEndpoint: {},
    rateLimitCount: 0,
    lastErrorAt: null,
    lastRateLimitAt: null,
    since: Date.now()
  };
}

/* ---------------------- v2.24 token usage ------------------------ */

function freshUsageBucket() {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function freshUsageStats() {
  return {
    total: freshUsageBucket(),
    byModel: {},
    byIdentity: {},
    updatedAt: null
  };
}

function addUsage(bucket, prompt, completion, total) {
  bucket.requests += 1;
  bucket.prompt_tokens += prompt;
  bucket.completion_tokens += completion;
  bucket.total_tokens += total;
}

function usageView(bucket) {
  const source = bucket && typeof bucket === 'object' ? bucket : freshUsageBucket();
  return {
    requests: Math.max(0, Math.trunc(Number(source.requests) || 0)),
    prompt_tokens: Math.max(0, Math.trunc(Number(source.prompt_tokens) || 0)),
    completion_tokens: Math.max(0, Math.trunc(Number(source.completion_tokens) || 0)),
    total_tokens: Math.max(0, Math.trunc(Number(source.total_tokens) || 0))
  };
}

/** 读取 usage.json 时做防御性归一化（字段缺失/类型错误都回退为 0）。 */
function mergeUsageStats(raw) {
  const stats = freshUsageStats();
  if (!raw || typeof raw !== 'object') return stats;
  stats.total = usageView(raw.total);
  if (raw.byModel && typeof raw.byModel === 'object') {
    for (const [model, bucket] of Object.entries(raw.byModel)) {
      stats.byModel[model] = usageView(bucket);
    }
  }
  if (raw.byIdentity && typeof raw.byIdentity === 'object') {
    for (const [id, identity] of Object.entries(raw.byIdentity)) {
      if (!identity || typeof identity !== 'object') continue;
      const view = usageView(identity);
      const byModel = {};
      if (identity.byModel && typeof identity.byModel === 'object') {
        for (const [model, bucket] of Object.entries(identity.byModel)) {
          byModel[model] = usageView(bucket);
        }
      }
      stats.byIdentity[id] = {
        ...view,
        identityId: id,
        identityLabel: typeof identity.identityLabel === 'string' ? identity.identityLabel : null,
        byModel
      };
    }
  }
  stats.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null;
  return stats;
}

function freshAdminStats() {
  return {
    requests: 0,
    errors: 0,
    latencyTotalMs: 0,
    byEndpoint: {},
    lastErrorAt: null,
    since: Date.now()
  };
}

function mergeCounterMap(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source)) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) target[key] = Math.trunc(count);
  }
}

function mergeUpstreamStats(loaded) {
  const stats = freshUpstreamStats();
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return stats;
  for (const field of ['requests', 'errors', 'latencyTotalMs', 'queueWaitTotalMs', 'totalPromptChars', 'rateLimitCount']) {
    const value = Number(loaded[field]);
    if (Number.isFinite(value) && value >= 0) stats[field] = value;
  }
  stats.lastErrorAt = Number.isFinite(loaded.lastErrorAt) ? loaded.lastErrorAt : null;
  stats.lastRateLimitAt = Number.isFinite(loaded.lastRateLimitAt) ? loaded.lastRateLimitAt : null;
  stats.since = Number.isFinite(loaded.since) ? loaded.since : Date.now();
  mergeCounterMap(stats.byModel, loaded.byModel);
  mergeCounterMap(stats.byEndpoint, loaded.byEndpoint);
  return stats;
}

function mergeAdminStats(loaded) {
  const stats = freshAdminStats();
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return stats;
  for (const field of ['requests', 'errors', 'latencyTotalMs']) {
    const value = Number(loaded[field]);
    if (Number.isFinite(value) && value >= 0) stats[field] = value;
  }
  stats.lastErrorAt = Number.isFinite(loaded.lastErrorAt) ? loaded.lastErrorAt : null;
  stats.since = Number.isFinite(loaded.since) ? loaded.since : Date.now();
  mergeCounterMap(stats.byEndpoint, loaded.byEndpoint);
  return stats;
}

function normalizeLoadedLogs(loaded) {
  const upstream = [];
  const admin = [];
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { upstream, admin, discarded: Boolean(loaded) };
  }
  // Old v1 shape: { logs: [...] } / array → discard.
  if (Array.isArray(loaded.logs)) return { upstream, admin, discarded: true };
  if (Array.isArray(loaded.upstream)) upstream.push(...loaded.upstream.filter((item) => item && typeof item === 'object'));
  if (Array.isArray(loaded.admin)) admin.push(...loaded.admin.filter((item) => item && typeof item === 'object'));
  return { upstream, admin, discarded: false };
}

function sanitizeErrorDetail(detail) {
  const safe = {};
  for (const key of ['code', 'status', 'event', 'eventIndex', 'type', 'reason']) {
    const value = detail[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') safe[key] = value.slice(0, 300);
    else if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

function upstreamStatsView(stats) {
  const requests = stats.requests;
  return {
    requests,
    errors: stats.errors,
    avgLatencyMs: requests > 0 ? Math.round(stats.latencyTotalMs / requests) : 0,
    avgQueueWaitMs: requests > 0 ? Math.round(stats.queueWaitTotalMs / requests) : 0,
    totalPromptChars: stats.totalPromptChars,
    byModel: { ...stats.byModel },
    byEndpoint: { ...stats.byEndpoint },
    rateLimitCount: stats.rateLimitCount,
    lastErrorAt: stats.lastErrorAt,
    lastRateLimitAt: stats.lastRateLimitAt,
    since: stats.since
  };
}

function adminStatsView(stats) {
  const requests = stats.requests;
  return {
    requests,
    errors: stats.errors,
    avgLatencyMs: requests > 0 ? Math.round(stats.latencyTotalMs / requests) : 0,
    byEndpoint: { ...stats.byEndpoint },
    lastErrorAt: stats.lastErrorAt,
    since: stats.since
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   dataDir: string,
 *   configPath?: string,
 *   config?: Record<string, any>,
 *   logger?: {warn: Function, error?: Function, debug?: Function, info?: Function}
 * }} options
 */
export function createStore(options = {}) {
  const { dataDir, config, logger } = options;
  if (!dataDir) throw new Error('createStore: dataDir is required');

  const paths = {
    dataDir,
    configPath: options.configPath || path.join(dataDir, 'config.json'),
    keysPath: path.join(dataDir, 'keys.json'),
    logsPath: path.join(dataDir, 'logs.json'),
    statsPath: path.join(dataDir, 'stats.json'),
    // v2.24：token 消耗累计（分模型 / 分身份×模型），独立持久化，不受日志清空影响
    usagePath: path.join(dataDir, 'usage.json')
  };

  const managedKeys = [];
  /** @type {Array<Record<string, any>>} newest last */
  let upstreamLogs = [];
  /** @type {Array<Record<string, any>>} newest last */
  let adminLogs = [];
  let upstreamStats = freshUpstreamStats();
  let adminStats = freshAdminStats();
  /** v2.24 token 消耗累计 */
  let usage = freshUsageStats();
  let usageDirty = false;
  let usageTimer = null;
  let initialized = false;
  let logCounter = 0;
  let statsDirty = false;
  let logsDirty = false;
  let keysDirty = false;
  let statsTimer = null;
  let logsTimer = null;
  let keysTimer = null;

  const writeQueues = new Map();
  function queuedWrite(file, data) {
    const previous = writeQueues.get(file) || Promise.resolve();
    const next = previous.then(() => atomicWriteJson(file, data));
    // Keep the chain alive even if a write rejects; callers still see the error.
    writeQueues.set(file, next.catch(() => {}));
    return next;
  }

  /** v2.24：把一次请求的 token 用量累加到 usage（总量 / 分模型 / 分身份×模型）。 */
  function applyUsageEntry(entry) {
      const tokens = entry.tokens || {};
      const prompt = Math.max(0, Math.trunc(Number(tokens.prompt) || 0));
      const completion = Math.max(0, Math.trunc(Number(tokens.completion) || 0));
      const total = Math.max(0, Math.trunc(Number(tokens.total) || prompt + completion));
      if (!total) return;
      const model = String(entry.model || 'unknown');
      const identityId = entry.identityId ? String(entry.identityId) : 'unassigned';
      const identityLabel = entry.identityLabel ? String(entry.identityLabel) : null;
      addUsage(usage.total, prompt, completion, total);
      usage.byModel[model] = usage.byModel[model] || freshUsageBucket();
      addUsage(usage.byModel[model], prompt, completion, total);
      const identity = (usage.byIdentity[identityId] = usage.byIdentity[identityId] || {
        ...freshUsageBucket(),
        identityId,
        identityLabel,
        byModel: {}
      });
      if (identityLabel && !identity.identityLabel) identity.identityLabel = identityLabel;
      addUsage(identity, prompt, completion, total);
      identity.byModel[model] = identity.byModel[model] || freshUsageBucket();
      addUsage(identity.byModel[model], prompt, completion, total);
      // v2.31：明细写入 SQLite 事件表（JSON 仅保留聚合快照）
      if (db) {
        try {
          db.db
            .prepare(
              'INSERT INTO usage_events(ts, model, identity_id, prompt_tokens, completion_tokens, total_tokens, estimated, session_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              Date.now(),
              model,
              identityId === 'unassigned' ? null : identityId,
              prompt,
              completion,
              total,
              tokens.estimated === false ? 0 : 1,
              entry.sessionKey ? String(entry.sessionKey).slice(0, 200) : null
            );
        } catch (error) {
          logger?.warn?.('failed to write usage event', { error: error.message });
        }
      }  }

  function maxLogEntries() {
    const configured = Number(config?.logging?.maxEntries);
    if (Number.isFinite(configured)) return Math.min(20000, Math.max(10, Math.trunc(configured)));
    return 500;
  }

  /** v2.24：日志最大保留时间（毫秒）；0 = 不按时间淘汰。 */
  function maxLogAgeMs() {
    const days = Number(config?.logging?.maxAgeDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    return Math.min(365, Math.max(1, Math.trunc(days))) * 24 * 60 * 60 * 1000;
  }

  function pruneByAge(list) {
    const ageMs = maxLogAgeMs();
    if (!ageMs || !list.length) return list;
    const cutoff = Date.now() - ageMs;
    // 日志按时间升序（newest last），直接截断最旧的即可。
    let index = 0;
    while (index < list.length && Number(list[index].ts) < cutoff) index += 1;
    return index > 0 ? list.slice(index) : list;
  }

  function pruneLogs() {
    const limit = maxLogEntries();
    upstreamLogs = pruneByAge(upstreamLogs);
    adminLogs = pruneByAge(adminLogs);
    if (upstreamLogs.length > limit) upstreamLogs = upstreamLogs.slice(upstreamLogs.length - limit);
    if (adminLogs.length > limit) adminLogs = adminLogs.slice(adminLogs.length - limit);
  }

  /** v2.24：立即应用日志保留策略（供 PUT /admin/api/logs/retention 调用）。 */
  function setLogRetention({ maxEntries, maxAgeDays } = {}) {
    if (Number.isFinite(Number(maxEntries))) {
      config.logging = { ...(config.logging || {}), maxEntries: Math.min(20000, Math.max(10, Math.trunc(Number(maxEntries)))) };
    }
    if (Number.isFinite(Number(maxAgeDays))) {
      config.logging = { ...(config.logging || {}), maxAgeDays: Math.min(365, Math.max(0, Math.trunc(Number(maxAgeDays)))) };
    }
    const before = upstreamLogs.length + adminLogs.length;
    pruneLogs();
    scheduleLogsPersist();
    const after = upstreamLogs.length + adminLogs.length;
    return {
      ok: true,
      maxEntries: maxLogEntries(),
      maxAgeDays: Number(config?.logging?.maxAgeDays) || 0,
      pruned: Math.max(0, before - after),
      upstreamCount: upstreamLogs.length,
      adminCount: adminLogs.length
    };
  }

  function getLogRetention() {
    return {
      maxEntries: maxLogEntries(),
      maxAgeDays: Math.max(0, Math.trunc(Number(config?.logging?.maxAgeDays) || 0)),
      upstreamCount: upstreamLogs.length,
      adminCount: adminLogs.length
    };
  }

  function scheduleStatsPersist() {
    statsDirty = true;
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      void persistStats();
    }, PERSIST_DEBOUNCE_MS);
    statsTimer.unref?.();
  }

  function scheduleLogsPersist() {
    logsDirty = true;
    if (logsTimer) return;
    logsTimer = setTimeout(() => {
      logsTimer = null;
      void persistLogs();
    }, PERSIST_DEBOUNCE_MS);
    logsTimer.unref?.();
  }

  function scheduleUsagePersist() {
    usageDirty = true;
    if (usageTimer) return;
    usageTimer = setTimeout(() => {
      usageTimer = null;
      void persistUsage();
    }, PERSIST_DEBOUNCE_MS);
    usageTimer.unref?.();
  }

  /** v2.31：用量累计写入 SQLite；v2.69 起 SQLite 不可用时也不再写 usage.json 快照。 */
  async function persistUsage() {
    if (!usageDirty) return;
    usageDirty = false;
    if (db) {
      // 事件已在 applyUsageEntry 中实时写入，这里只更新 updated_at 标记
      try {
        db.setMeta('usage.updatedAt', usage.updatedAt || Date.now());
      } catch {
        // ignore
      }
      return;
    }
    logger?.warn?.('usage.json 快照已停用（sqlite 不可用，用量不会持久化）', {
      updatedAt: usage.updatedAt || null
    });
  }

  function scheduleKeysPersist() {
    keysDirty = true;
    if (keysTimer) return;
    keysTimer = setTimeout(() => {
      keysTimer = null;
      void persistKeys();
    }, PERSIST_DEBOUNCE_MS);
    keysTimer.unref?.();
  }

  async function persistStats() {
    if (!statsDirty) return;
    statsDirty = false;
    const payload = {
      upstream: {
        ...upstreamStats,
        byModel: { ...upstreamStats.byModel },
        byEndpoint: { ...upstreamStats.byEndpoint }
      },
      admin: { ...adminStats, byEndpoint: { ...adminStats.byEndpoint } }
    };
    try {
      if (db) {
        // v2.40：统计写入 SQLite meta（不再生成 stats.json）
        db.setMeta('stats.upstream', JSON.stringify(payload.upstream));
        db.setMeta('stats.admin', JSON.stringify(payload.admin));
      } else {
        logger?.warn?.('stats.json 快照已停用（sqlite 不可用，统计不会持久化）');
      }
    } catch (error) {
      statsDirty = true;
      logger?.warn?.('failed to persist stats to SQLite', { error: error.message });
    }
  }

  let persistedLogIds = null;

  /** v2.31：把新日志追加进 SQLite（按 id 去重），并同步清理超出保留策略的行。 */
  function persistLogsToSqlite() {
    if (!db) return false;
    try {
      if (!persistedLogIds) persistedLogIds = new Set();
      const all = [
        ...upstreamLogs.map((entry) => ({ kind: 'upstream', entry })),
        ...adminLogs.map((entry) => ({ kind: 'admin', entry }))
      ];
      const insert = db.db.prepare(
        'INSERT INTO logs(kind, ts, level, model, identity_id, status, json) VALUES(?, ?, ?, ?, ?, ?, ?)'
      );
      db.transaction(() => {
        for (const { kind, entry } of all) {
          if (!entry || !entry.id || persistedLogIds.has(entry.id)) continue;
          insert.run(
            kind,
            Number(entry.ts) || Date.now(),
            entry.level ?? null,
            entry.model ?? null,
            entry.identityId ?? null,
            Number.isFinite(entry.status) ? entry.status : null,
            JSON.stringify(entry)
          );
          persistedLogIds.add(entry.id);
        }
        // 保留策略：条数上限 + 天数上限（与 memory 中的 pruneLogs 一致）
        const maxEntries = Math.max(10, Math.min(20000, Number(config?.logging?.maxEntries) || 500));
        const maxAgeDays = Math.max(0, Number(config?.logging?.maxAgeDays) || 0);
        for (const kind of ['upstream', 'admin']) {
          db.db
            .prepare(
              `DELETE FROM logs WHERE kind = ? AND seq NOT IN (
                 SELECT seq FROM logs WHERE kind = ? ORDER BY ts DESC LIMIT ?
               )`
            )
            .run(kind, kind, maxEntries);
        }
        if (maxAgeDays > 0) {
          db.db.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - maxAgeDays * 86400000);
        }
      });
      return true;
    } catch (error) {
      logger?.warn?.('failed to persist logs to sqlite', { error: error.message });
      return false;
    }
  }

  async function persistLogs() {
    if (!logsDirty) return;
    logsDirty = false;
    if (persistLogsToSqlite()) return;
    // v2.69：SQLite 是日志唯一来源；失败时不再回退写 logs.json 快照。
    logger?.warn?.('logs.json 快照已停用（sqlite 持久化失败，本次日志未落库）', {
      upstream: upstreamLogs.length,
      admin: adminLogs.length
    });
  }

  async function persistKeys() {
    if (!keysDirty) return;
    keysDirty = false;
    try {
      if (db) {
        // v2.40：managed API keys 写入 SQLite meta（不再生成 keys.json）
        db.setMeta('keys.managed', JSON.stringify(managedKeys));
      } else {
        logger?.warn?.('keys.json 快照已停用（sqlite 不可用，managed keys 不会持久化）');
      }
    } catch (error) {
      keysDirty = true;
      logger?.warn?.('failed to persist managed keys to SQLite', { error: error.message });
    }
  }

  function toPublicKey(item, source) {
    return {
      id: item.id,
      label: item.label,
      keyPreview: item.keyPreview || keyPreview(item.key),
      createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt,
      requestCount: item.requestCount || 0,
      source
    };
  }

  function staticKeys() {
    const configured = Array.isArray(config?.auth?.apiKeys) ? config.auth.apiKeys : [];
    const managed = new Set(managedKeys.map((item) => item.key));
    return configured
      .filter((key) => typeof key === 'string' && key && !managed.has(key))
      .map((key) => ({
        id: `static_${sha256Hex(key).slice(0, 12)}`,
        label: 'config',
        key,
        keyPreview: keyPreview(key),
        createdAt: null,
        lastUsedAt: null,
        requestCount: 0,
        source: 'config'
      }));
  }

  // v2.31：SQLite 持久化（日志/用量/会话历史）
  let db = null;
  const openStoreDb = async () => {
    if (db) return db;
    try {
      db = await openDatabase({ dataDir, logger });
    } catch (error) {
      logger?.warn?.('sqlite unavailable; falling back to JSON stores', { error: error.message });
      db = null;
    }
    return db;
  };

  const store = {
    paths,
    get configPath() {
      return paths.configPath;
    },
    get dataDir() {
      return paths.dataDir;
    },

    async init() {
      await ensureDir(dataDir);
      // v2.40：先打开 SQLite，后面的 keys/stats/logs/usage 加载都要用它读 meta/事件表
      await openStoreDb();

      /* ------------------------------- keys ------------------------- */
      let loadedKeys = null;
      if (db) {
        try {
          const rawKeys = db.getMeta('keys.managed');
          if (rawKeys) loadedKeys = { items: JSON.parse(rawKeys) };
        } catch {
          loadedKeys = null;
        }
      }
      if (!loadedKeys) {
        loadedKeys = await readJsonFileSafe(paths.keysPath, null, (error) =>
          logger?.warn?.(`could not read legacy keys.json: ${error.message}`)
        );
        if (db && loadedKeys && Array.isArray(loadedKeys.items)) {
          // 一次性迁移到 SQLite（之后不再写 keys.json）
          for (const item of loadedKeys.items) {
            if (!item || typeof item.key !== 'string' || !item.key) continue;
            managedKeys.push({
              id: typeof item.id === 'string' && item.id ? item.id : `key_${crypto.randomBytes(8).toString('hex')}`,
              label: typeof item.label === 'string' && item.label ? item.label : 'api-key',
              key: item.key,
              keyPreview: typeof item.keyPreview === 'string' ? item.keyPreview : keyPreview(item.key)
            });
          }
          keysDirty = true;
          void persistKeys();
          loadedKeys = { items: [] };
        }
      }
      if (loadedKeys && Array.isArray(loadedKeys.items)) {
        for (const item of loadedKeys.items) {
          if (!item || typeof item.key !== 'string' || !item.key) continue;
          managedKeys.push({
            id: typeof item.id === 'string' && item.id ? item.id : `key_${crypto.randomBytes(8).toString('hex')}`,
            label: typeof item.label === 'string' && item.label ? item.label : 'api-key',
            key: item.key,
            keyPreview: typeof item.keyPreview === 'string' ? item.keyPreview : keyPreview(item.key),
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
            lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : null,
            requestCount: Number.isFinite(item.requestCount) ? Math.max(0, Math.trunc(item.requestCount)) : 0
          });
        }
      }
      // v1 → v2 migration: config-file API keys become managed keys too so the
      // dashboard can list / revoke them and usage counters work.
      if (managedKeys.length === 0 && Array.isArray(config?.auth?.apiKeys)) {
        for (const key of config.auth.apiKeys) {
          if (typeof key !== 'string' || !key.trim()) continue;
          managedKeys.push({
            id: `key_${crypto.randomBytes(8).toString('hex')}`,
            label: 'migrated',
            key: key.trim(),
            keyPreview: keyPreview(key.trim()),
            createdAt: Date.now(),
            lastUsedAt: null,
            requestCount: 0
          });
        }
        if (managedKeys.length > 0) {
          logger?.info?.('migrated config.auth.apiKeys into data/keys.json', { count: managedKeys.length });
          scheduleKeysPersist();
        }
      }

      /* ------------------------------- logs ------------------------- */
      // v2.31：优先从 SQLite 读取日志；空库时从旧 logs.json 导入。
      await openStoreDb();
      let loadedLogs = null;
      if (db) {
        try {
          const maxEntries = Math.max(10, Math.min(20000, Number(config?.logging?.maxEntries) || 500));
          const rows = db.db
            .prepare('SELECT kind, json FROM logs ORDER BY ts DESC LIMIT ?')
            .all(maxEntries * 2);
          const upstream = [];
          const admin = [];
          for (const row of rows.slice().reverse()) {
            try {
              const parsed = JSON.parse(row.json);
              (row.kind === 'admin' ? admin : upstream).push(parsed);
            } catch {
              // skip corrupt
            }
          }
          if (upstream.length || admin.length) loadedLogs = { upstream, admin };
        } catch (error) {
          logger?.warn?.('failed to load logs from sqlite', { error: error.message });
        }
      }
      if (!loadedLogs) {
        loadedLogs = await readJsonFileSafe(paths.logsPath, null, (error) =>
          logger?.warn?.(`could not read logs.json: ${error.message}`)
        );
      }
      const normalizedLogs = normalizeLoadedLogs(loadedLogs);
      upstreamLogs = normalizedLogs.upstream;
      adminLogs = normalizedLogs.admin;
      if (normalizedLogs.discarded) {
        logger?.warn?.('discarded legacy v1 logs.json (v2 split structure required)');
      }
      logCounter = upstreamLogs.length + adminLogs.length;
      pruneLogs();

      /* ------------------------------ usage ------------------------- */
      // v2.31：从 SQLite 事件表聚合；空库时从旧 usage.json 导入（仅用于展示，之后以事件表为准）
      let loadedUsage = null;
      if (db) {
        try {
          const rows = db.db
            .prepare(
              `SELECT model, identity_id, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
                      SUM(total_tokens) AS total, COUNT(*) AS requests
               FROM usage_events GROUP BY model, identity_id`
            )
            .all();
          if (rows.length) {
            const bucket = { total: freshUsageBucket(), byModel: {}, byIdentity: {}, updatedAt: null };
            for (const row of rows) {
              const model = row.model || 'unknown';
              const prompt = Number(row.prompt) || 0;
              const completion = Number(row.completion) || 0;
              const total = Number(row.total) || prompt + completion;
              bucket.byModel[model] = addUsage(bucket.byModel[model] || freshUsageBucket(), prompt, completion, total);
              addUsage(bucket.total, prompt, completion, total);
              if (row.identity_id) {
                const identity = bucket.byIdentity[row.identity_id] || {
                  identityLabel: null,
                  total: freshUsageBucket(),
                  byModel: {}
                };
                identity.total = addUsage(identity.total, prompt, completion, total);
                identity.byModel[model] = addUsage(
                  identity.byModel[model] || freshUsageBucket(),
                  prompt,
                  completion,
                  total
                );
                bucket.byIdentity[row.identity_id] = identity;
              }
            }
            loadedUsage = bucket;
          }
        } catch (error) {
          logger?.warn?.('failed to load usage from sqlite', { error: error.message });
        }
      }
      if (!loadedUsage) {
        loadedUsage = await readJsonFileSafe(paths.usagePath, null, (error) =>
          logger?.warn?.(`could not read usage.json: ${error.message}`)
        );
      }
      if (loadedUsage) usage = mergeUsageStats(loadedUsage);
      else usage.updatedAt = null;

      /* ------------------------------ stats ------------------------- */
      let loadedStats = null;
      if (db) {
        try {
          const rawUpstream = db.getMeta('stats.upstream');
          const rawAdmin = db.getMeta('stats.admin');
          if (rawUpstream) {
            loadedStats = { upstream: JSON.parse(rawUpstream), admin: rawAdmin ? JSON.parse(rawAdmin) : {} };
          }
        } catch {
          loadedStats = null;
        }
      }
      if (!loadedStats) {
        loadedStats = await readJsonFileSafe(paths.statsPath, null, (error) =>
          logger?.warn?.(`could not read legacy stats.json: ${error.message}`)
        );
        // 迁移交给下方 merge 分支（保证写入的是合并后的数据）
      }
      if (loadedStats && typeof loadedStats === 'object' && !Array.isArray(loadedStats) && loadedStats.upstream) {
        upstreamStats = mergeUpstreamStats(loadedStats.upstream);
        adminStats = mergeAdminStats(loadedStats.admin);
        if (db) scheduleStatsPersist();
      } else if (loadedStats) {
        logger?.warn?.('discarded legacy v1 stats.json (v2 split structure required)');
      }

      initialized = true;
      logger?.debug?.('store initialized', {
        dataDir,
        configPath: paths.configPath,
        managedKeys: managedKeys.length,
        upstreamLogs: upstreamLogs.length,
        adminLogs: adminLogs.length,
        upstreamRequests: upstreamStats.requests,
        adminRequests: adminStats.requests
      });
      return store;
    },

    /* -------------------------- config file ------------------------- */
    async saveConfig(configObject) {
      await queuedWrite(paths.configPath, configObject);
    },

    /* ----------------------------- keys ----------------------------- */
    listKeys() {
      const managed = managedKeys.map((item) => toPublicKey(item, 'managed'));
      return [...managed, ...staticKeys().map((item) => toPublicKey(item, 'config'))];
    },

    findManagedKey(key) {
      return managedKeys.find((item) => timingSafeEqualString(item.key, key)) || null;
    },

    hasConfiguredKey(key) {
      const configured = Array.isArray(config?.auth?.apiKeys) ? config.auth.apiKeys : [];
      return configured.some((candidate) => timingSafeEqualString(candidate, key));
    },

    getManagedKeyStrings() {
      return managedKeys.map((item) => item.key);
    },

    createKey(label) {
      const safeLabel =
        typeof label === 'string' && label.trim()
          ? label.trim().slice(0, MAX_KEY_LABEL_LENGTH)
          : 'api-key';
      const key = `sk-duck-${crypto.randomBytes(24).toString('base64url')}`;
      const item = {
        id: `key_${crypto.randomBytes(8).toString('hex')}`,
        label: safeLabel,
        key,
        keyPreview: keyPreview(key),
        createdAt: Date.now(),
        lastUsedAt: null,
        requestCount: 0
      };
      managedKeys.push(item);
      scheduleKeysPersist();
      return { ...toPublicKey(item, 'managed'), key: item.key };
    },

    /**
     * Delete a managed key or a static key that lives in `config.auth.apiKeys`.
     * @returns {{ok: boolean, removedFromConfig?: boolean, label?: string} | null}
     */
    deleteKey(id) {
      const managedIndex = managedKeys.findIndex((item) => item.id === id);
      if (managedIndex !== -1) {
        const [removed] = managedKeys.splice(managedIndex, 1);
        let removedFromConfig = false;
        if (Array.isArray(config?.auth?.apiKeys)) {
          const next = config.auth.apiKeys.filter((key) => key !== removed.key);
          removedFromConfig = next.length !== config.auth.apiKeys.length;
          config.auth.apiKeys = next;
        }
        scheduleKeysPersist();
        return { ok: true, label: removed.label, removedFromConfig };
      }
      const found = staticKeys().find((item) => item.id === id);
      if (!found) return null;
      if (Array.isArray(config?.auth?.apiKeys)) {
        config.auth.apiKeys = config.auth.apiKeys.filter((key) => key !== found.key);
      }
      return { ok: true, label: found.label, removedFromConfig: true };
    },

    touchKey(key) {
      if (typeof key !== 'string' || !key) return;
      const item = managedKeys.find((candidate) => timingSafeEqualString(candidate.key, key));
      if (!item) return;
      item.lastUsedAt = Date.now();
      item.requestCount = (item.requestCount || 0) + 1;
      scheduleKeysPersist();
    },

    /** True if the key is a managed key or configured in config.auth.apiKeys. */
    isAuthorizedKey(key) {
      if (typeof key !== 'string' || !key) return false;
      if (store.findManagedKey(key)) return true;
      return store.hasConfiguredKey(key);
    },

    /* -------------------- upstream logs / stats -------------------- */
    recordUpstream(entry = {}) {
      const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
      logCounter += 1;
      const logEntry = {
        id: `log_u_${ts}_${logCounter}`,
        ts,
        source: entry.source === 'admin-test' ? 'admin-test' : 'v1',
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
        model: entry.model ?? null,
        status: Number.isFinite(entry.status) ? entry.status : 0,
        latencyMs: Number.isFinite(entry.latencyMs) ? Math.max(0, Math.round(entry.latencyMs)) : 0,
        queueWaitMs: Number.isFinite(entry.queueWaitMs) ? Math.max(0, Math.round(entry.queueWaitMs)) : 0,
        stream: entry.stream === true,
        error: entry.error ? String(entry.error).slice(0, 1000) : null,
        rateLimited: Number(entry.status) === 429 || /rate[_\s-]?limit/i.test(String(entry.error || '')),
        ...(entry.identityId ? { identityId: String(entry.identityId).slice(0, 100) } : {}),
        ...(entry.identityLabel ? { identityLabel: String(entry.identityLabel).slice(0, 100) } : {}),
        // v2.33：会话标识与请求 id，方便在日志里定位「哪个会话 / 哪次请求」用了哪个身份
        ...(entry.sessionKey ? { sessionKey: String(entry.sessionKey).slice(0, 200) } : {}),
        ...(entry.requestId ? { requestId: String(entry.requestId).slice(0, 64) } : {}),
        ...(entry.tokens && typeof entry.tokens === 'object'
          ? {
              tokens: {
                prompt: Math.max(0, Math.trunc(Number(entry.tokens.prompt) || 0)),
                completion: Math.max(0, Math.trunc(Number(entry.tokens.completion) || 0)),
                total: Math.max(0, Math.trunc(Number(entry.tokens.total) || 0)),
                estimated: entry.tokens.estimated !== false
              }
            }
          : {}),
        ...(entry.errorDetail && typeof entry.errorDetail === 'object'
          ? { errorDetail: sanitizeErrorDetail(entry.errorDetail) }
          : {})
      };
      upstreamLogs.push(logEntry);
      pruneLogs();
      scheduleLogsPersist();

      if (logEntry.tokens && logEntry.tokens.total > 0) {
        applyUsageEntry(logEntry);
      }

      upstreamStats.requests += 1;
      if (Number(entry.status) >= 400 || Boolean(entry.error)) {
        upstreamStats.errors += 1;
        upstreamStats.lastErrorAt = Date.now();
      }
      upstreamStats.latencyTotalMs += Math.max(0, Number(entry.latencyMs) || 0);
      upstreamStats.queueWaitTotalMs += Math.max(0, Number(entry.queueWaitMs) || 0);
      upstreamStats.totalPromptChars += Math.max(0, Math.trunc(Number(entry.promptChars) || 0));
      const modelKey = entry.model || 'unknown';
      upstreamStats.byModel[modelKey] = (upstreamStats.byModel[modelKey] || 0) + 1;
      const endpointKey = entry.endpoint || 'unknown';
      upstreamStats.byEndpoint[endpointKey] = (upstreamStats.byEndpoint[endpointKey] || 0) + 1;
      if (logEntry.rateLimited) {
        upstreamStats.rateLimitCount += 1;
        upstreamStats.lastRateLimitAt = Date.now();
      }
      scheduleStatsPersist();
      return logEntry;
    },

    recordAdmin(entry = {}) {
      const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
      logCounter += 1;
      const logEntry = {
        id: `log_a_${ts}_${logCounter}`,
        ts,
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
        method: typeof entry.method === 'string' ? entry.method : '',
        status: Number.isFinite(entry.status) ? entry.status : 0,
        latencyMs: Number.isFinite(entry.latencyMs) ? Math.max(0, Math.round(entry.latencyMs)) : 0,
        error: entry.error ? String(entry.error).slice(0, 1000) : null
      };
      adminLogs.push(logEntry);
      pruneLogs();
      scheduleLogsPersist();

      adminStats.requests += 1;
      if (Number(entry.status) >= 400 || Boolean(entry.error)) {
        adminStats.errors += 1;
        adminStats.lastErrorAt = Date.now();
      }
      adminStats.latencyTotalMs += Math.max(0, Number(entry.latencyMs) || 0);
      const endpointKey = entry.endpoint || 'unknown';
      adminStats.byEndpoint[endpointKey] = (adminStats.byEndpoint[endpointKey] || 0) + 1;
      scheduleStatsPersist();
      return logEntry;
    },

    /** v2.24：token 消耗累计（总量 + 分模型 + 分身份×模型）。 */
    recordUsage(entry) {
      applyUsageEntry(entry);
    },

    getUsage({ model = null, identityId = null } = {}) {
      const modelFilter = typeof model === 'string' && model ? model : null;
      const identityFilter = typeof identityId === 'string' && identityId ? identityId : null;

      const models = Object.entries(usage.byModel)
        .filter(([id]) => !modelFilter || id === modelFilter)
        .map(([id, bucket]) => ({ model: id, ...usageView(bucket) }))
        .sort((a, b) => b.total_tokens - a.total_tokens);

      const identities = Object.entries(usage.byIdentity)
        .filter(([id]) => !identityFilter || id === identityFilter)
        .map(([id, identity]) => {
          const byModel = Object.entries(identity.byModel || {})
            .filter(([modelId]) => !modelFilter || modelId === modelFilter)
            .map(([modelId, bucket]) => ({ model: modelId, ...usageView(bucket) }))
            .sort((a, b) => b.total_tokens - a.total_tokens);
          const totals = byModel.reduce(
            (acc, item) => ({
              requests: acc.requests + item.requests,
              prompt_tokens: acc.prompt_tokens + item.prompt_tokens,
              completion_tokens: acc.completion_tokens + item.completion_tokens,
              total_tokens: acc.total_tokens + item.total_tokens
            }),
            { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          );
          return {
            identityId: id,
            identityLabel: identity.identityLabel || null,
            ...totals,
            byModel
          };
        })
        .filter((identity) => identity.byModel.length > 0)
        .sort((a, b) => b.total_tokens - a.total_tokens);

      const total = modelFilter
        ? models.reduce(
            (acc, item) => ({
              requests: acc.requests + item.requests,
              prompt_tokens: acc.prompt_tokens + item.prompt_tokens,
              completion_tokens: acc.completion_tokens + item.completion_tokens,
              total_tokens: acc.total_tokens + item.total_tokens
            }),
            { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          )
        : usageView(usage.total);

      return {
        total,
        byModel: models,
        byIdentity: identities,
        filter: { model: modelFilter, identityId: identityFilter },
        estimated: true,
        estimation: 'chars/4',
        updatedAt: usage.updatedAt || null
      };
    },

    resetUsage() {
      usage = freshUsageStats();
      usage.updatedAt = Date.now();
      scheduleUsagePersist();
      return { ok: true };
    },

    getLogRetention,

    setLogRetention,

    getLogs({ kind = 'upstream', limit = 50, offset = 0 } = {}) {
      const safeKind = kind === 'admin' ? 'admin' : 'upstream';
      const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
      const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
      const source = safeKind === 'admin' ? adminLogs : upstreamLogs;
      const newestFirst = source.slice().reverse();
      return {
        kind: safeKind,
        total: newestFirst.length,
        items: newestFirst.slice(safeOffset, safeOffset + safeLimit)
      };
    },

    clearLogs(kind = 'upstream') {
      const safeKind = kind === 'admin' ? 'admin' : 'upstream';
      if (safeKind === 'admin') adminLogs = [];
      else upstreamLogs = [];
      scheduleLogsPersist();
      return { ok: true, kind: safeKind };
    },

    getStats() {
      return {
        upstream: upstreamStatsView(upstreamStats),
        admin: adminStatsView(adminStats)
      };
    },

    /* ---------------------------- lifecycle ------------------------- */
    async flush() {
      for (const timer of [statsTimer, logsTimer, keysTimer, usageTimer]) {
        if (timer) clearTimeout(timer);
      }
      statsTimer = null;
      logsTimer = null;
      keysTimer = null;
      await Promise.all([persistStats(), persistLogs(), persistKeys()]);
      await Promise.all([...writeQueues.values()]);
    },

    get initialized() {
      return initialized;
    }
  };

  return store;
}
