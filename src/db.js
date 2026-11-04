/**
 * v2.31：SQLite 持久层（node:sqlite，Node 24 内置）。
 *
 * 目的：身份池 / 订阅 / 会话绑定 / 日志 / 用量 / 会话历史等「列表型」数据改用 SQLite，
 * 不再整文件读写；旧的 JSON 文件在首次启动时自动导入（一次性迁移，之后不再写回 JSON）。
 *
 * 设计：
 *  - 单文件 `data/duckai.db`（WAL 模式）；
 *  - 每个 store 通过 `createDatabase()` 共享同一个连接（进程内单例）；
 *  - 表：
 *    identities / bindings / subscriptions / logs / usage_events / history / pool_meta / meta
 */
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
let sqliteLoadError = null;

async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  if (sqliteLoadError) throw sqliteLoadError;
  try {
    const mod = await import('node:sqlite');
    DatabaseSync = mod.DatabaseSync;
    return DatabaseSync;
  } catch (error) {
    sqliteLoadError = error;
    throw error;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS pool_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  tier TEXT,
  record_json TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS bindings (
  session_key TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  tier TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bindings_identity ON bindings(identity_id);
CREATE INDEX IF NOT EXISTS idx_bindings_updated ON bindings(updated_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  label TEXT,
  email TEXT,
  tier TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  token_hash TEXT,
  record_json TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT,
  model TEXT,
  identity_id TEXT,
  status INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_kind_ts ON logs(kind, ts DESC);
CREATE TABLE IF NOT EXISTS usage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  model TEXT,
  identity_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 1,
  session_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model);
CREATE INDEX IF NOT EXISTS idx_usage_identity ON usage_events(identity_id);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  identity_id TEXT,
  session_key TEXT,
  title TEXT,
  model TEXT,
  system_prompt TEXT,
  messages_json TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_identity ON history(identity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_updated ON history(updated_at DESC);
CREATE TABLE IF NOT EXISTS test_sessions (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_sessions_updated ON test_sessions(updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_summaries (
  session_key TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_updated ON chat_summaries(updated_at DESC);
`;

const connections = new Map();

/**
 * 打开（或复用）SQLite 数据库。
 * @param {{ dataDir?: string, file?: string, logger?: any }} [options]
 * @returns {Promise<object>} 数据库句柄（含 db + 便捷方法）
 */
export async function openDatabase(options = {}) {
  const dataDir = options.dataDir || 'data';
  const file = options.file || path.join(dataDir, 'duckai.db');
  const key = path.resolve(file);
  if (connections.has(key)) return connections.get(key);

  const Database = await loadSqlite();
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const db = new Database(key);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  } catch (error) {
    options.logger?.warn?.('[db] failed to init sqlite', { error: error.message });
    throw error;
  }

  const handle = {
    db,
    file: key,
    /** 事务包装：fn 内的所有写操作原子提交。 */
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback failures
        }
        throw error;
      }
    },
    getMeta(key2, fallback = null) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key2);
      return row ? row.value : fallback;
    },
    setMeta(key2, value) {
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key2,
        String(value)
      );
    },
    getPoolMeta(key2, fallback = null) {
      const row = db.prepare('SELECT value FROM pool_meta WHERE key = ?').get(key2);
      return row ? row.value : fallback;
    },
    setPoolMeta(key2, value) {
      db.prepare(
        'INSERT INTO pool_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key2, String(value));
    },
    close() {
      connections.delete(key);
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  };
  connections.set(key, handle);
  return handle;
}

/** 关闭所有连接（测试/退出用）。 */
export function closeAllDatabases() {
  for (const [key, handle] of [...connections]) {
    try {
      handle.db.close();
    } catch {
      // ignore
    }
    connections.delete(key);
  }
}

/** 数据库是否可用（没装/加载失败时返回 false）。 */
export async function isSqliteAvailable() {
  try {
    await loadSqlite();
    return true;
  } catch {
    return false;
  }
}

/** 把 JSON 文件内容读出来（迁移用；不存在返回 null）。 */
export function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}
