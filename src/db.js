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
let sqliteDriver = null;

async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  if (sqliteLoadError) throw sqliteLoadError;
  try {
    // windows 平台分支（bun exe）：Bun（含 bun 编译的 exe）没有实现 node:sqlite，
    // 回退到 src/platform/sqlite-bun.js（bun:sqlite 兼容层）；Node 24 保持原生。
    if (typeof Bun !== 'undefined') {
      const mod = await import('./platform/sqlite-bun.js');
      DatabaseSync = mod.DatabaseSync;
      sqliteDriver = 'bun:sqlite';
      return DatabaseSync;
    }
    const mod = await import('node:sqlite');
    DatabaseSync = mod.DatabaseSync;
    sqliteDriver = 'node:sqlite';
    return DatabaseSync;
  } catch (error) {
    sqliteLoadError = error;
    throw error;
  }
}

/** 当前 SQLite 驱动（`node:sqlite` | `bun:sqlite` | null；排障/测试用）。 */
export function getSqliteDriver() {
  return sqliteDriver;
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
  injection_json TEXT,
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
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  previous_id TEXT,
  session_key TEXT,
  model TEXT,
  system_prompt TEXT,
  conversation_json TEXT NOT NULL,
  upstream_json TEXT,
  tools_hash TEXT,
  output_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_responses_previous ON responses(previous_id);
CREATE INDEX IF NOT EXISTS idx_responses_expires ON responses(expires_at);
CREATE TABLE IF NOT EXISTS conversation_state (
  session_key TEXT PRIMARY KEY,
  model TEXT,
  mode TEXT,
  system_prompt TEXT,
  canonical_json TEXT NOT NULL,
  upstream_json TEXT NOT NULL,
  tools_hash TEXT,
  compression_json TEXT,
  context_pdf_scope TEXT,
  compacted_at INTEGER,
  images_json TEXT,
  client_json TEXT,
  client_hash TEXT,
  epoch INTEGER NOT NULL DEFAULT 0,
  first_user_hash TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversation_state_expires ON conversation_state(expires_at);
CREATE TABLE IF NOT EXISTS context_pdfs (
  scope_key TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  pages INTEGER,
  bytes INTEGER,
  covered_count INTEGER NOT NULL,
  covered_hash TEXT NOT NULL,
  text_chars INTEGER,
  text_content TEXT,
  pdf_b64 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_context_pdfs_expires ON context_pdfs(expires_at);
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
    // 兼容 v2.46 已存在的 responses 表：补 upstream/tools_hash 列
    const responseColumns = new Set(
      db.prepare('PRAGMA table_info(responses)').all().map((column) => column.name)
    );
    if (!responseColumns.has('upstream_json')) {
      db.exec('ALTER TABLE responses ADD COLUMN upstream_json TEXT');
    }
    if (!responseColumns.has('tools_hash')) {
      db.exec('ALTER TABLE responses ADD COLUMN tools_hash TEXT');
    }
    const historyColumns = new Set(
      db.prepare('PRAGMA table_info(history)').all().map((column) => column.name)
    );
    if (!historyColumns.has('injection_json')) {
      db.exec('ALTER TABLE history ADD COLUMN injection_json TEXT');
    }
    const pdfColumns = new Set(db.prepare('PRAGMA table_info(context_pdfs)').all().map((column) => column.name));
    if (!pdfColumns.has('text_chars')) db.exec('ALTER TABLE context_pdfs ADD COLUMN text_chars INTEGER');
    if (!pdfColumns.has('text_content')) db.exec('ALTER TABLE context_pdfs ADD COLUMN text_content TEXT');
    // v2.51：canonical conversation 的压缩状态（手动 Codex 压缩/context PDF 引用）。
    const conversationColumns = new Set(
      db.prepare('PRAGMA table_info(conversation_state)').all().map((column) => column.name)
    );
    if (!conversationColumns.has('compression_json')) db.exec('ALTER TABLE conversation_state ADD COLUMN compression_json TEXT');
    if (!conversationColumns.has('context_pdf_scope')) db.exec('ALTER TABLE conversation_state ADD COLUMN context_pdf_scope TEXT');
    if (!conversationColumns.has('compacted_at')) db.exec('ALTER TABLE conversation_state ADD COLUMN compacted_at INTEGER');
    if (!conversationColumns.has('images_json')) db.exec('ALTER TABLE conversation_state ADD COLUMN images_json TEXT');
    // v2.59：authoritative session（客户端输入 diff / epoch / 冲突检测）。
    if (!conversationColumns.has('client_json')) db.exec('ALTER TABLE conversation_state ADD COLUMN client_json TEXT');
    if (!conversationColumns.has('client_hash')) db.exec('ALTER TABLE conversation_state ADD COLUMN client_hash TEXT');
    if (!conversationColumns.has('epoch')) db.exec('ALTER TABLE conversation_state ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');
    if (!conversationColumns.has('first_user_hash')) db.exec('ALTER TABLE conversation_state ADD COLUMN first_user_hash TEXT');
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
