/**
 * Persistent store for admin connection-test sessions (v2).
 * v2.40：持久化改为 SQLite（data/duckai.db 的 test_sessions 表），不再写 data/testsessions.json。
 *
 * `data/testsessions.json`:
 * {
 *   "sessions": [{
 *     id, title, model, reasoningEffort, webSearch, imageGeneration,
 *     createdAt, updatedAt, messages: [{ id, role, content, reasoning,
 *     reasoningEncrypted, sources, images, model, ts, latencyMs,
 *     finishReason, queueWaitMs?, error?, retriedFrom? }]
 *   }]
 * }
 *
 * Limits: 100 sessions (oldest evicted), 200 messages per session. Writes are
 * atomic (temp file + rename) and debounced.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFileSafe } from '../store.js';
import { openDatabase } from '../db.js';

export const MAX_SESSIONS = 100;
export const MAX_MESSAGES_PER_SESSION = 200;
const PERSIST_DEBOUNCE_MS = 300;

export function generateId(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeTitle(value) {
  return asString(value, '').trim().slice(0, 200);
}

function normalizeMessage(raw = {}) {
  const message = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : generateId('msg_'),
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: asString(raw.content, ''),
    reasoning: asString(raw.reasoning, ''),
    // v2.1: anonymous duck.ai may only return encrypted reasoning; the UI shows a hint.
    reasoningEncrypted: raw.reasoningEncrypted === true,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    images: Array.isArray(raw.images) ? raw.images : [],
    // v2.37：工具调用（位置 / 生图 / 联网），与「会话历史」共用前端展示组件
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls : [],
    model: asString(raw.model, ''),
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    latencyMs: Number.isFinite(raw.latencyMs) ? Math.max(0, Math.round(raw.latencyMs)) : 0,
    finishReason: asString(raw.finishReason, 'stop')
  };
  if (raw.error !== undefined && raw.error !== null) message.error = String(raw.error).slice(0, 1000);
  if (Number.isFinite(raw.queueWaitMs)) message.queueWaitMs = Math.max(0, Math.round(raw.queueWaitMs));
  // v2.1: retry lineage (set on the assistant message produced by a retry).
  if (typeof raw.retriedFrom === 'string' && raw.retriedFrom) message.retriedFrom = raw.retriedFrom;
  // v2.4: context guard trimmed this turn.
  if (raw.contextTrimmed === true) message.contextTrimmed = true;
  return message;
}

function normalizeSessionSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  return {
    text,
    version: Number.isFinite(raw.version) ? Math.max(1, Math.trunc(raw.version)) : 1,
    coveredMessageCount: Number.isFinite(raw.coveredMessageCount) ? Math.max(0, Math.trunc(raw.coveredMessageCount)) : 0,
    coveredPairCount: Number.isFinite(raw.coveredPairCount) ? Math.max(0, Math.trunc(raw.coveredPairCount)) : 0,
    anchorId: typeof raw.anchorId === 'string' && raw.anchorId ? raw.anchorId : null,
    // v2.19: where compaction happened (index into messages) + the last covered message id.
    anchorIndex: Number.isFinite(raw.anchorIndex)
      ? Math.max(0, Math.trunc(raw.anchorIndex))
      : Number.isFinite(raw.coveredMessageCount)
        ? Math.max(0, Math.trunc(raw.coveredMessageCount))
        : 0,
    anchorMessageId:
      typeof raw.anchorMessageId === 'string' && raw.anchorMessageId
        ? raw.anchorMessageId
        : typeof raw.anchorId === 'string' && raw.anchorId
          ? raw.anchorId
          : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    baseCompactionId: typeof raw.baseCompactionId === 'string' && raw.baseCompactionId ? raw.baseCompactionId : null,
    trigger: ['tokens', 'manual', 'limit', 'chars'].includes(raw.trigger) ? raw.trigger : 'manual',
    savedChars: Number.isFinite(raw.savedChars) ? Math.max(0, Math.trunc(raw.savedChars)) : 0,
    tokenThreshold: Number.isFinite(raw.tokenThreshold) ? Math.max(0, Math.trunc(raw.tokenThreshold)) : null,
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
  };
}

function normalizePendingCompaction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    baseCoveredPairCount: Number.isFinite(raw.baseCoveredPairCount) ? raw.baseCoveredPairCount : null,
    targetPairCount: Number.isFinite(raw.targetPairCount) ? raw.targetPairCount : null,
    thresholdTokens: Number.isFinite(raw.thresholdTokens) ? raw.thresholdTokens : null,
    trigger: typeof raw.trigger === 'string' ? raw.trigger : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
  };
}

function normalizeSession(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : generateId('sess_'),
    title: normalizeTitle(raw.title),
    model: asString(raw.model, ''),
    reasoningEffort: asString(raw.reasoningEffort, 'none'),
    webSearch: asBoolean(raw.webSearch, false),
    imageGeneration: asBoolean(raw.imageGeneration, false),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    // v2.4: permanent session → identity binding.
    identityId: typeof raw.identityId === 'string' && raw.identityId ? raw.identityId : null,
    identityLabel: typeof raw.identityLabel === 'string' && raw.identityLabel ? raw.identityLabel : null,
    contextTrimmed: raw.contextTrimmed === true,
    // v2.11: compaction summary (initial context for later turns).
    summary: normalizeSessionSummary(raw.summary),
    // v2.12: server-driven compaction hints / invalidation.
    pendingCompaction: normalizePendingCompaction(raw.pendingCompaction),
    summaryInvalid: raw.summaryInvalid === true,
    messages: Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES_PER_SESSION).map(normalizeMessage) : []
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    webSearch: session.webSearch,
    imageGeneration: session.imageGeneration,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    identityId: session.identityId ?? null,
    identityLabel: session.identityLabel ?? null,
    contextTrimmed: session.contextTrimmed === true,
    summary: session.summary ?? null,
    pendingCompaction: session.pendingCompaction ?? null,
    summaryInvalid: session.summaryInvalid === true,
    messageCount: session.messages.length
  };
}

/**
 * @param {{
 *   dataDir: string,
 *   config?: Record<string, any>,
 *   logger?: {warn?: Function, info?: Function, debug?: Function}
 * }} options
 */
export function createSessionsStore(options = {}) {
  const { dataDir, config, logger } = options;
  if (!dataDir) throw new Error('createSessionsStore: dataDir is required');
  // 仅用于一次性导入旧 JSON；之后不再生成/更新该文件。
  const legacyFilePath = path.join(dataDir, 'testsessions.json');
  let db = null;

  /** @type {Array<Record<string, any>>} */
  let sessions = [];
  let loadingPromise = null;
  let writeChain = Promise.resolve();
  let dirty = false;
  let timer = null;
  /** Session ids with an in-flight SSE generation (single stream per session). */
  const activeStreams = new Set();

  async function openDb() {
    if (db) return db;
    try {
      db = await openDatabase({ dataDir, logger });
    } catch (error) {
      logger?.warn?.('test sessions: SQLite unavailable; sessions will not persist', { error: error.message });
      db = null;
    }
    return db;
  }

  async function ensureLoaded() {
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const handle = await openDb();
        if (!handle?.db) return;
        try {
          const rows = handle.db.prepare('SELECT data_json FROM test_sessions ORDER BY updated_at ASC').all();
          if (rows.length > 0) {
            sessions = rows
              .map((row) => {
                try {
                  return normalizeSession(JSON.parse(row.data_json));
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .slice(-MAX_SESSIONS);
            return;
          }
        } catch (error) {
          logger?.warn?.('could not read test_sessions table', { error: error.message });
          return;
        }
        // 空库：一次性导入旧 testsessions.json（导入后不再写回 JSON）
        const legacy = await readJsonFileSafe(legacyFilePath, null, (error) =>
          logger?.warn?.(`could not read legacy testsessions.json: ${error.message}`)
        );
        if (legacy && Array.isArray(legacy.sessions)) {
          sessions = legacy.sessions
            .filter((item) => item && typeof item === 'object')
            .map(normalizeSession)
            .slice(-MAX_SESSIONS);
          if (sessions.length) {
            dirty = true;
            await persist();
          }
          logger?.info?.('migrated legacy testsessions.json into SQLite');
        } else if (legacy) {
          logger?.warn?.('discarded legacy testsessions.json (v2 structure required)');
        }
      })();
    }
    return loadingPromise;
  }

  function scheduleSave() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
  }

  async function persist() {
    if (!dirty) return;
    dirty = false;
    const handle = await openDb();
    if (!handle?.db) return;
    const snapshot = sessions.map((session) => ({
      ...session,
      messages: [...session.messages]
    }));
    writeChain = writeChain.catch(() => {}).then(() => {
      handle.transaction(() => {
        handle.db.prepare('DELETE FROM test_sessions').run();
        const insert = handle.db.prepare(
          'INSERT INTO test_sessions(id, updated_at, data_json) VALUES(?, ?, ?)'
        );
        for (const session of snapshot) {
          insert.run(session.id, session.updatedAt || Date.now(), JSON.stringify(session));
        }
      });
    });
    try {
      await writeChain;
    } catch (error) {
      dirty = true;
      logger?.warn?.('failed to persist test sessions to SQLite', { error: error.message });
    }
  }

  function find(id) {
    return sessions.find((session) => session.id === id) || null;
  }

  function defaultModel() {
    return asString(config?.duck?.defaultModel, 'gpt-6-luna') || 'gpt-6-luna';
  }

  const store = {
    // 兼容字段：旧 testsessions.json（仅迁移读取，不再写入）
    filePath: legacyFilePath,
    get storageInfo() {
      return db?.db
        ? { path: db.file || 'data/duckai.db', engine: 'sqlite', table: 'test_sessions', sessions: sessions.length }
        : { path: null, engine: 'memory', table: null, sessions: sessions.length };
    },

    async listSessions() {
      await ensureLoaded();
      return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(sessionSummary);
    },

    async createSession(patch = {}) {
      await ensureLoaded();
      if (sessions.length >= MAX_SESSIONS) {
        sessions.sort((a, b) => a.updatedAt - b.updatedAt);
        sessions.shift();
      }
      const now = Date.now();
      const session = normalizeSession({
        id: generateId('sess_'),
        title: normalizeTitle(patch.title),
        model: asString(patch.model, '') || defaultModel(),
        reasoningEffort: asString(patch.reasoningEffort, 'none') || 'none',
        webSearch: asBoolean(patch.webSearch, false),
        imageGeneration: asBoolean(patch.imageGeneration, false),
        createdAt: now,
        updatedAt: now,
        identityId: typeof patch.identityId === 'string' && patch.identityId ? patch.identityId : null,
        identityLabel: typeof patch.identityLabel === 'string' && patch.identityLabel ? patch.identityLabel : null,
        messages: []
      });
      sessions.push(session);
      scheduleSave();
      return structuredClone(session);
    },

    async getSession(id) {
      await ensureLoaded();
      const session = find(id);
      return session ? structuredClone(session) : null;
    },

    async updateSession(id, patch = {}) {
      await ensureLoaded();
      const session = find(id);
      if (!session) return null;
      if (patch.title !== undefined) session.title = normalizeTitle(patch.title);
      if (patch.model !== undefined) session.model = asString(patch.model, session.model);
      if (patch.reasoningEffort !== undefined) {
        session.reasoningEffort = asString(patch.reasoningEffort, session.reasoningEffort) || 'none';
      }
      if (patch.webSearch !== undefined) session.webSearch = asBoolean(patch.webSearch, session.webSearch);
      if (patch.imageGeneration !== undefined) {
        session.imageGeneration = asBoolean(patch.imageGeneration, session.imageGeneration);
      }
      if (patch.identityId !== undefined) {
        session.identityId = typeof patch.identityId === 'string' && patch.identityId ? patch.identityId : null;
      }
      if (patch.identityLabel !== undefined) {
        session.identityLabel = typeof patch.identityLabel === 'string' && patch.identityLabel ? patch.identityLabel : null;
      }
      if (patch.contextTrimmed === true) session.contextTrimmed = true;
      if (patch.summary !== undefined) {
        session.summary = patch.summary === null ? null : normalizeSessionSummary(patch.summary);
      }
      if (patch.pendingCompaction !== undefined) {
        session.pendingCompaction =
          patch.pendingCompaction === null ? null : normalizePendingCompaction(patch.pendingCompaction);
      }
      if (patch.summaryInvalid !== undefined) session.summaryInvalid = patch.summaryInvalid === true;
      session.updatedAt = Date.now();
      scheduleSave();
      return structuredClone(session);
    },

    async deleteSession(id) {
      await ensureLoaded();
      const index = sessions.findIndex((session) => session.id === id);
      if (index === -1) return false;
      sessions.splice(index, 1);
      activeStreams.delete(id);
      scheduleSave();
      return true;
    },

    /* ------------------------- retry / streaming lock ------------------------ */

    /** Try to acquire the single-stream lock for a session. */
    beginStream(id) {
      if (typeof id !== 'string' || !id) return false;
      if (activeStreams.has(id)) return false;
      activeStreams.add(id);
      return true;
    },

    endStream(id) {
      activeStreams.delete(id);
    },

    isStreaming(id) {
      return activeStreams.has(id);
    },

    /**
     * Prepare a "regenerate this turn" operation: validate the target assistant
     * message, find its preceding user message and truncate the session to keep
     * only that user prompt (removing the target assistant and everything after).
     * @returns {{ok: true, session: any, userMessage: any, targetMessage: any} |
     *   {ok: false, reason: 'session_not_found'|'message_not_found'|'not_assistant'|'no_previous_user'}}
     */
    async prepareRetry(id, messageId) {
      await ensureLoaded();
      const session = find(id);
      if (!session) return { ok: false, reason: 'session_not_found' };
      const targetIndex = session.messages.findIndex((message) => message.id === messageId);
      if (targetIndex === -1) return { ok: false, reason: 'message_not_found' };
      const targetMessage = session.messages[targetIndex];
      if (targetMessage.role !== 'assistant') return { ok: false, reason: 'not_assistant' };
      let userIndex = -1;
      for (let index = targetIndex - 1; index >= 0; index -= 1) {
        if (session.messages[index].role === 'user') {
          userIndex = index;
          break;
        }
      }
      if (userIndex === -1) return { ok: false, reason: 'no_previous_user' };
      const userMessage = session.messages[userIndex];
      session.messages = session.messages.slice(0, userIndex + 1);
      session.updatedAt = Date.now();
      scheduleSave();
      return {
        ok: true,
        session: structuredClone(session),
        userMessage: structuredClone(userMessage),
        targetMessage: structuredClone(targetMessage)
      };
    },

    async appendMessage(id, message) {
      await ensureLoaded();
      const session = find(id);
      if (!session) return null;
      if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
        const error = new Error(
          `Session ${id} reached the limit of ${MAX_MESSAGES_PER_SESSION} messages; create a new session`
        );
        error.status = 400;
        error.code = 'session_message_limit';
        throw error;
      }
      const normalized = normalizeMessage(message);
      session.messages.push(normalized);
      if (!session.title && normalized.role === 'user' && normalized.content.trim()) {
        session.title = normalized.content.trim().slice(0, 30);
      }
      session.updatedAt = Date.now();
      scheduleSave();
      return structuredClone(normalized);
    },

    async clear() {
      await ensureLoaded();
      sessions = [];
      activeStreams.clear();
      scheduleSave();
      await store.flush();
      return { ok: true };
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await persist();
      await writeChain;
    }
  };

  return store;
}
