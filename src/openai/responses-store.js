/**
 * v2.46：Responses API response chaining 存储（previous_response_id）。
 *
 * 每次 /v1/responses（store !== false）保存：
 *   - 本次请求的完整规范化 conversation（不含 system prompt / 工具协议注入）
 *   - 本次 response 的 output items（含 function_call / image_generation_call）
 * 下一次请求带 previous_response_id 时，网关按链重建完整 conversation：
 *   previous.conversation + outputItemsToConversation(previous.output) + 新 input
 * 然后照常转发给 duck.ai（duck.ai 仍然收到完整历史，稳定前缀保证 cache 可命中）。
 */
import crypto from 'node:crypto';
import { openDatabase } from '../db.js';

const MAX_RECORD_BYTES = 16 * 1024 * 1024; // 单条 response 记录上限（含图片 base64）

function safeJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export async function createResponseStore({ dataDir, config = {}, logger = null } = {}) {
  if (!dataDir) throw new Error('createResponseStore: dataDir is required');
  let db = null;
  try {
    db = await openDatabase({ dataDir, logger });
  } catch (error) {
    logger?.warn?.('responses store: SQLite unavailable; previous_response_id disabled', { error: error.message });
    db = null;
  }
  const retentionDays = Number.isFinite(Number(config.responses?.retentionDays))
    ? Math.max(0, Math.floor(Number(config.responses.retentionDays)))
    : 7;
  const conversationRetentionDays = Number.isFinite(Number(config.conversations?.retentionDays))
    ? Math.max(0, Math.floor(Number(config.conversations.retentionDays)))
    : 7;
  const enabled = config.responses?.enabled !== false && db != null;

  function expiresAtFrom(now = Date.now()) {
    return retentionDays === 0 ? null : now + retentionDays * 24 * 60 * 60 * 1000;
  }

  function conversationExpiresAtFrom(now = Date.now()) {
    return conversationRetentionDays === 0 ? null : now + conversationRetentionDays * 24 * 60 * 60 * 1000;
  }

  return {
    enabled,
    retentionDays,

    async save({
      id,
      previousId = null,
      sessionKey = null,
      model = null,
      systemPrompt = null,
      conversation = [],
      upstream = [],
      toolsHash = null,
      output = [],
      ttlMs = null
    }) {
      if (!enabled || !db) return null;
      const now = Date.now();
      const expiresAt = Number.isFinite(ttlMs) ? now + ttlMs : expiresAtFrom(now);
      const conversationJson = JSON.stringify(safeJson(conversation, []));
      const upstreamJson = JSON.stringify(safeJson(upstream, []));
      const outputJson = JSON.stringify(safeJson(output, []));
      const bytes =
        Buffer.byteLength(conversationJson, 'utf8') +
        Buffer.byteLength(upstreamJson, 'utf8') +
        Buffer.byteLength(outputJson, 'utf8');
      if (bytes > MAX_RECORD_BYTES) {
        logger?.warn?.('responses store: record too large; not stored', { id, bytes, limit: MAX_RECORD_BYTES });
        return null;
      }
      try {
        db.db
          .prepare(
            `INSERT INTO responses(id, previous_id, session_key, model, system_prompt, conversation_json, upstream_json, tools_hash, output_json, created_at, expires_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               previous_id=excluded.previous_id, session_key=excluded.session_key, model=excluded.model,
               system_prompt=excluded.system_prompt, conversation_json=excluded.conversation_json,
               upstream_json=excluded.upstream_json, tools_hash=excluded.tools_hash,
               output_json=excluded.output_json, created_at=excluded.created_at, expires_at=excluded.expires_at`
          )
          .run(
            id,
            previousId,
            sessionKey,
            model,
            systemPrompt && String(systemPrompt).trim() ? String(systemPrompt) : null,
            conversationJson,
            upstreamJson,
            toolsHash,
            outputJson,
            now,
            expiresAt
          );
        return { id, previousId, expiresAt };
      } catch (error) {
        logger?.warn?.('responses store: save failed', { error: error.message, id });
        return null;
      }
    },

    async get(id) {
      if (!enabled || !db) return null;
      if (typeof id !== 'string' || !id.trim()) return null;
      let row;
      try {
        row = db.db
          .prepare(
            'SELECT id, previous_id, session_key, model, system_prompt, conversation_json, upstream_json, tools_hash, output_json, created_at, expires_at FROM responses WHERE id = ?'
          )
          .get(id.trim());
      } catch (error) {
        logger?.warn?.('responses store: get failed', { error: error.message, id });
        return null;
      }
      if (!row) return null;
      if (row.expires_at != null && Number(row.expires_at) <= Date.now()) {
        try {
          db.db.prepare('DELETE FROM responses WHERE id = ?').run(row.id);
        } catch {
          // ignore
        }
        return null;
      }
      let conversation = [];
      let upstream = [];
      let output = [];
      try {
        conversation = JSON.parse(row.conversation_json);
      } catch {
        conversation = [];
      }
      try {
        upstream = row.upstream_json ? JSON.parse(row.upstream_json) : [];
      } catch {
        upstream = [];
      }
      try {
        output = JSON.parse(row.output_json);
      } catch {
        output = [];
      }
      return {
        id: row.id,
        previousId: row.previous_id || null,
        sessionKey: row.session_key || null,
        model: row.model || null,
        systemPrompt: row.system_prompt || null,
        conversation: Array.isArray(conversation) ? conversation : [],
        upstream: Array.isArray(upstream) ? upstream : [],
        toolsHash: row.tools_hash || null,
        output: Array.isArray(output) ? output : [],
        createdAt: row.created_at,
        expiresAt: row.expires_at
      };
    },

    async getLatestBySession(sessionKey) {
      if (!enabled || !db || typeof sessionKey !== 'string' || !sessionKey) return null;
      let row;
      try {
        row = db.db
          .prepare(
            'SELECT id FROM responses WHERE session_key = ? ORDER BY created_at DESC LIMIT 1'
          )
          .get(sessionKey);
      } catch (error) {
        logger?.warn?.('responses store: getLatestBySession failed', { error: error.message });
        return null;
      }
      if (!row) return null;
      return this.get(row.id);
    },

    async getContextPdf(scopeKey) {
      if (!enabled || !db || typeof scopeKey !== 'string' || !scopeKey) return null;
      let row;
      try {
        row = db.db.prepare('SELECT * FROM context_pdfs WHERE scope_key = ?').get(scopeKey);
      } catch (error) {
        logger?.warn?.('responses store: getContextPdf failed', { error: error.message });
        return null;
      }
      if (!row) return null;
      if (row.expires_at != null && Number(row.expires_at) <= Date.now()) {
        try { db.db.prepare('DELETE FROM context_pdfs WHERE scope_key = ?').run(scopeKey); } catch {}
        return null;
      }
      return {
        scopeKey: row.scope_key,
        filename: row.filename,
        mimeType: row.mime_type,
        pages: row.pages,
        bytes: row.bytes,
        coveredCount: row.covered_count,
        coveredHash: row.covered_hash,
        textChars: row.text_chars ?? null,
        textContent: row.text_content ?? null,
        pdfB64: row.pdf_b64,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    async saveContextPdf({ scopeKey, filename, mimeType = 'application/pdf', pages, bytes, textChars = null, textContent = null, coveredCount, coveredHash, pdfB64 }) {
      if (!enabled || !db || typeof scopeKey !== 'string' || !scopeKey) return null;
      if (typeof pdfB64 !== 'string' || !pdfB64) return null;
      const now = Date.now();
      const expiresAt = conversationExpiresAtFrom(now);
      try {
        db.db.prepare(
          `INSERT INTO context_pdfs(scope_key, filename, mime_type, pages, bytes, covered_count, covered_hash, text_chars, text_content, pdf_b64, created_at, updated_at, expires_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_key) DO UPDATE SET
             filename=excluded.filename, mime_type=excluded.mime_type, pages=excluded.pages, bytes=excluded.bytes,
             covered_count=excluded.covered_count, covered_hash=excluded.covered_hash, text_chars=excluded.text_chars, text_content=excluded.text_content, pdf_b64=excluded.pdf_b64,
             updated_at=excluded.updated_at, expires_at=excluded.expires_at`
        ).run(scopeKey, filename, mimeType, pages, bytes, coveredCount, coveredHash, textChars, textContent, pdfB64, now, now, expiresAt);
        return { scopeKey, pages, bytes, coveredCount };
      } catch (error) {
        logger?.warn?.('responses store: saveContextPdf failed', { error: error.message });
        return null;
      }
    },

    async getConversation(sessionKey) {
      if (!enabled || !db || typeof sessionKey !== 'string' || !sessionKey) return null;
      let row;
      try {
        row = db.db
          .prepare(
            'SELECT session_key, model, mode, system_prompt, canonical_json, upstream_json, tools_hash, compression_json, context_pdf_scope, compacted_at, updated_at, expires_at FROM conversation_state WHERE session_key = ?'
          )
          .get(sessionKey);
      } catch (error) {
        logger?.warn?.('responses store: getConversation failed', { error: error.message });
        return null;
      }
      if (!row) return null;
      if (row.expires_at != null && Number(row.expires_at) <= Date.now()) {
        try {
          db.db.prepare('DELETE FROM conversation_state WHERE session_key = ?').run(row.session_key);
        } catch {
          // ignore
        }
        return null;
      }
      let canonical = [];
      let upstream = [];
      try {
        canonical = JSON.parse(row.canonical_json);
      } catch {
        canonical = [];
      }
      try {
        upstream = JSON.parse(row.upstream_json);
      } catch {
        upstream = [];
      }
      let compression = null;
      try {
        compression = row.compression_json ? JSON.parse(row.compression_json) : null;
      } catch {
        compression = null;
      }
      return {
        sessionKey: row.session_key,
        model: row.model || null,
        mode: row.mode || null,
        systemPrompt: row.system_prompt || null,
        canonical: Array.isArray(canonical) ? canonical : [],
        upstream: Array.isArray(upstream) ? upstream : [],
        toolsHash: row.tools_hash || null,
        compression: compression && typeof compression === 'object' ? compression : null,
        contextPdfScope: row.context_pdf_scope || null,
        compactedAt: Number.isFinite(row.compacted_at) ? row.compacted_at : null,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at
      };
    },

    async saveConversation({
      sessionKey,
      model = null,
      mode = 'auto',
      systemPrompt = null,
      canonical = [],
      upstream = [],
      toolsHash = null,
      compression = null,
      contextPdfScope = null,
      compactedAt = null
    }) {
      if (!enabled || !db || typeof sessionKey !== 'string' || !sessionKey) return null;
      const now = Date.now();
      const expiresAt = conversationExpiresAtFrom(now);
      const canonicalJson = JSON.stringify(safeJson(canonical, []));
      const upstreamJson = JSON.stringify(safeJson(upstream, []));
      const compressionJson = compression && typeof compression === 'object' ? JSON.stringify(compression) : null;
      const bytes = Buffer.byteLength(canonicalJson, 'utf8') + Buffer.byteLength(upstreamJson, 'utf8');
      if (bytes > MAX_RECORD_BYTES) {
        logger?.warn?.('responses store: conversation too large; not stored', { sessionKey, bytes, limit: MAX_RECORD_BYTES });
        return null;
      }
      try {
        db.db
          .prepare(
            `INSERT INTO conversation_state(session_key, model, mode, system_prompt, canonical_json, upstream_json, tools_hash, compression_json, context_pdf_scope, compacted_at, updated_at, expires_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_key) DO UPDATE SET
               model=excluded.model, mode=excluded.mode, system_prompt=excluded.system_prompt,
               canonical_json=excluded.canonical_json, upstream_json=excluded.upstream_json,
               tools_hash=excluded.tools_hash, compression_json=excluded.compression_json,
               context_pdf_scope=excluded.context_pdf_scope, compacted_at=excluded.compacted_at,
               updated_at=excluded.updated_at, expires_at=excluded.expires_at`
          )
          .run(
            sessionKey,
            model,
            mode,
            systemPrompt && String(systemPrompt).trim() ? String(systemPrompt) : null,
            canonicalJson,
            upstreamJson,
            toolsHash,
            compressionJson,
            contextPdfScope,
            Number.isFinite(compactedAt) ? compactedAt : null,
            now,
            expiresAt
          );
        return { sessionKey, expiresAt };
      } catch (error) {
        logger?.warn?.('responses store: saveConversation failed', { error: error.message, sessionKey });
        return null;
      }
    },

    async deleteConversation(sessionKey) {
      if (!enabled || !db || typeof sessionKey !== 'string' || !sessionKey) return false;
      try {
        const result = db.db.prepare('DELETE FROM conversation_state WHERE session_key = ?').run(sessionKey);
        return (result.changes || 0) > 0;
      } catch {
        return false;
      }
    },

    prune() {
      if (!enabled || !db) return 0;
      try {
        const now = Date.now();
        const responses = db.db.prepare('DELETE FROM responses WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
        const conversations = db.db
          .prepare('DELETE FROM conversation_state WHERE expires_at IS NOT NULL AND expires_at <= ?')
          .run(now);
        const pdfs = db.db.prepare('DELETE FROM context_pdfs WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
        return (responses.changes || 0) + (conversations.changes || 0) + (pdfs.changes || 0);
      } catch (error) {
        logger?.warn?.('responses store: prune failed', { error: error.message });
        return 0;
      }
    },

    async close() {
      // 共享 SQLite 连接由 db.js 管理，不在这里关闭
    }
  };
}

export function randomResponseId() {
  return `resp_${crypto.randomBytes(12).toString('hex')}`;
}

export default { createResponseStore, randomResponseId };
