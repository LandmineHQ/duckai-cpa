/**
 * v2.11 persistent compaction summaries for `/v1` requests keyed by X-Session-Id.
 * v2.40：改为 SQLite（data/duckai.db 的 chat_summaries 表），不再写 data/chat-summaries.json。
 */

import { openDatabase } from '../db.js';

const MAX_ENTRIES = 1000;

function normalize(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const text = typeof summary.text === 'string' ? summary.text.trim() : '';
  if (!text) return null;
  return {
    text,
    version: Number.isFinite(summary.version) ? Math.max(1, Math.trunc(summary.version)) : 1,
    coveredMessageCount: Number.isFinite(summary.coveredMessageCount)
      ? Math.max(0, Math.trunc(summary.coveredMessageCount))
      : 0,
    coveredPairCount: Number.isFinite(summary.coveredPairCount) ? Math.max(0, Math.trunc(summary.coveredPairCount)) : 0,
    model: typeof summary.model === 'string' && summary.model ? summary.model : null,
    updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : Date.now()
  };
}

export function createChatSummaryStore({ dataDir, logger = null } = {}) {
  if (!dataDir) throw new Error('createChatSummaryStore: dataDir is required');
  let entries = new Map();
  let loaded = false;
  let db = null;
  let writeChain = Promise.resolve();

  async function openDb() {
    if (db) return db;
    try {
      db = await openDatabase({ dataDir, logger });
    } catch (error) {
      logger?.warn?.('chat summaries: SQLite unavailable; using in-memory store', { error: error.message });
      db = null;
    }
    return db;
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const handle = await openDb();
    if (!handle?.db) return;
    try {
      const rows = handle.db.prepare('SELECT session_key, data_json FROM chat_summaries').all();
      for (const row of rows) {
        try {
          const normalized = normalize(JSON.parse(row.data_json));
          if (normalized) entries.set(row.session_key, normalized);
        } catch {
          // 跳过损坏行
        }
      }
    } catch (error) {
      logger?.warn?.('could not read chat_summaries table', { error: error.message });
    }
  }

  async function persist() {
    const handle = await openDb();
    if (!handle?.db) return; // 无 SQLite：内存模式（不再落 JSON 文件）
    writeChain = writeChain.catch(() => {}).then(() => {
      const sorted = [...entries.entries()].sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      const capped = sorted.slice(0, MAX_ENTRIES);
      handle.transaction(() => {
        handle.db.prepare('DELETE FROM chat_summaries').run();
        const insert = handle.db.prepare(
          'INSERT INTO chat_summaries(session_key, updated_at, data_json) VALUES(?, ?, ?)'
        );
        for (const [key, value] of capped) {
          insert.run(key, value.updatedAt || Date.now(), JSON.stringify(value));
        }
      });
    });
    await writeChain;
  }

  return {
    async init() {
      await ensureLoaded();
      return this;
    },
    async get(sessionKey) {
      await ensureLoaded();
      return sessionKey ? entries.get(sessionKey) || null : null;
    },
    async set(sessionKey, summary) {
      await ensureLoaded();
      const normalized = normalize(summary);
      if (!sessionKey || !normalized) return null;
      entries.set(sessionKey, normalized);
      if (entries.size > MAX_ENTRIES) {
        const oldest = [...entries.entries()]
          .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
          .slice(0, entries.size - MAX_ENTRIES);
        for (const [key] of oldest) entries.delete(key);
      }
      await persist();
      return normalized;
    },
    async delete(sessionKey) {
      await ensureLoaded();
      const existed = entries.delete(sessionKey);
      if (existed) await persist();
      return existed;
    },
    async close() {
      await writeChain.catch(() => {});
    }
  };
}
