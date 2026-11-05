/**
 * v2.31：会话历史（只读，按身份分组）。
 *
 * 数据来源：网关每次聊天成功后，把「本次请求的消息 + 助手回复」追加到对应会话记录里；
 * 记录以 (identityId, sessionKey) 为主键（没有 sessionKey 时退化到 conversationId / history:<hash>）。
 *
 * 保留策略（二选一，当前实现）：`config.history.retentionDays`（默认 30 天）——
 * 超过该天数**没有更新**的会话会被自动清理。
 */
import crypto from 'node:crypto';

import { openDatabase } from './db.js';

const DEFAULT_RETENTION_DAYS = 30;
const MAX_MESSAGES = 400;
const MAX_MESSAGE_CHARS = 20000;
// v2.36：会话历史里的图片 base64 / 工具调用结果上限（避免单条记录过大）
const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_TOOL_CALLS_PER_MESSAGE = 20;
const MAX_TOOL_TEXT_CHARS = 4000;
const MAX_PDF_TEXT_CHARS = 200000;
const MAX_SOURCES_PER_MESSAGE = 20;

function now() {
  return Date.now();
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(500, Math.floor(parsed));
}

/** 从消息数组里抽取用于展示的纯文本。 */
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stripPdfInstruction(text) {
  return String(text || '')
    .replace(/\s*\[系统提示\] 附件包含 client-tools\.pdf[\s\S]*$/, '')
    .replace(/\s*\[系统提示\] 附件 client-tools\.pdf 是本次会话的客户端工具说明[\s\S]*$/, '')
    .trim();
}

function normalizeInjection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clientTools = Array.isArray(raw.clientTools)
    ? raw.clientTools.filter((name) => typeof name === 'string' && name).slice(0, 64)
    : [];
  const protocolText = typeof raw.protocolText === 'string' ? raw.protocolText.slice(0, 30000) : '';
  const firstUserContent =
    typeof raw.firstUserContent === 'string' ? raw.firstUserContent.slice(0, 60000) : '';
  return {
    injected: raw.injected === true || Boolean(protocolText),
    clientTools,
    protocolText,
    firstUserContent,
    upstreamMessageCount: Number.isFinite(Number(raw.upstreamMessageCount))
      ? Math.max(0, Math.trunc(Number(raw.upstreamMessageCount)))
      : null,
    chain: typeof raw.chain === 'string' && raw.chain ? raw.chain.slice(0, 64) : null,
    protocolKind: raw.protocolKind === 'client-tools-pdf' ? 'client-tools-pdf' : 'text',
    compression: raw.compression && typeof raw.compression === 'object'
      ? {
          trigger: typeof raw.compression.trigger === 'string' ? raw.compression.trigger : 'manual',
          summaryHash: typeof raw.compression.summaryHash === 'string' ? raw.compression.summaryHash : null,
          summaryChars: Number.isFinite(Number(raw.compression.summaryChars)) ? Number(raw.compression.summaryChars) : null,
          coveredMessageCount: Number.isFinite(Number(raw.compression.coveredMessageCount)) ? Number(raw.compression.coveredMessageCount) : null,
          hotMessageCount: Number.isFinite(Number(raw.compression.hotMessageCount)) ? Number(raw.compression.hotMessageCount) : null,
          reused: raw.compression.reused === true,
          createdAt: Number.isFinite(Number(raw.compression.createdAt)) ? Number(raw.compression.createdAt) : null
        }
      : null,
    toolsPdf: raw.toolsPdf && typeof raw.toolsPdf === 'object'
      ? {
          pages: Number.isFinite(Number(raw.toolsPdf.pages)) ? Number(raw.toolsPdf.pages) : null,
          bytes: Number.isFinite(Number(raw.toolsPdf.bytes)) ? Number(raw.toolsPdf.bytes) : null
        }
      : null,
    contextPdf: raw.contextPdf && typeof raw.contextPdf === 'object'
      ? {
          pages: Number.isFinite(Number(raw.contextPdf.pages)) ? Number(raw.contextPdf.pages) : null,
          bytes: Number.isFinite(Number(raw.contextPdf.bytes)) ? Number(raw.contextPdf.bytes) : null,
          reused: raw.contextPdfReused === true || raw.contextPdf.reused === true
        }
      : null,
    at: Number.isFinite(raw.at) ? raw.at : Date.now()
  };
}

const COMPACTION_MARKER = 'Another language model started to solve this problem';

function titleFrom(messages) {
  const users = (messages || []).filter((message) => message && message.role === 'user');
  const firstUser = users.find((message) => !messageText(message).includes(COMPACTION_MARKER)) || users[0];
  const text = messageText(firstUser).replace(/\s+/g, ' ').trim();
  if (!text) return '未命名会话';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export async function createHistoryStore({ dataDir = 'data', config = null, logger = null } = {}) {
  let db = null;
  try {
    db = await openDatabase({ dataDir, logger });
  } catch (error) {
    logger?.warn?.('[history] sqlite unavailable; history disabled', { error: error.message });
    db = null;
  }

  function retentionDays() {
    const raw = config && config.history ? config.history.retentionDays : undefined;
    const days = Number(raw);
    return Number.isFinite(days) && days >= 0 ? Math.min(3650, Math.floor(days)) : DEFAULT_RETENTION_DAYS;
  }

  const store = {
    available: Boolean(db),
    retentionDays,

    /**
     * 追加/更新一条会话。
     * @param {{identityId?: string|null, identityLabel?: string|null, sessionKey?: string|null,
     *   model?: string|null, systemPrompt?: string|null, messages?: any[]}} entry
     */
    record(entry = {}) {
      if (!db) return null;
      const messages = Array.isArray(entry.messages) ? entry.messages.slice(-MAX_MESSAGES) : [];
      if (!messages.length) return null;
      const identityId = typeof entry.identityId === 'string' && entry.identityId ? entry.identityId : null;
      const sessionKey =
        typeof entry.sessionKey === 'string' && entry.sessionKey
          ? entry.sessionKey
          : `auto:${sha(JSON.stringify(messages.slice(0, 2))).slice(0, 16)}`;
      const ts = Number.isFinite(entry.ts) ? entry.ts : now();
      const normalized = messages.map((message) => {
        const entry = {
          role: message && message.role ? String(message.role) : 'user',
          content: String(messageText(message)).slice(0, MAX_MESSAGE_CHARS),
          ts: Number.isFinite(message?.ts) ? message.ts : ts
        };
        // v2.36：保留工具调用 / 生成图片 / 思考过程（前端「会话历史」只读展示）
        if (message && typeof message.reasoning === 'string' && message.reasoning) {
          entry.reasoning = message.reasoning.slice(0, MAX_MESSAGE_CHARS);
        }
        if (message && Array.isArray(message.images)) {
          const images = message.images
            .filter((image) => image && typeof image.b64 === 'string' && image.b64)
            .slice(0, MAX_IMAGES_PER_MESSAGE)
            .map((image) => ({
              b64: image.b64.slice(0, MAX_IMAGE_BASE64_CHARS),
              format: typeof image.format === 'string' && image.format ? image.format : 'png',
              ...(typeof image.model === 'string' && image.model ? { model: image.model } : {})
            }));
          if (images.length) entry.images = images;
        }
        // v2.49：PDF/文件附件（只存元数据，不存 base64）
        if (message && Array.isArray(message.files) && message.files.length) {
          const files = message.files
            .filter((file) => file && (file.filename || file.mimeType))
            .slice(0, 4)
            .map((file) => ({
              filename: String(file.filename || 'attachment').slice(0, 200),
              mimeType: String(file.mimeType || 'application/octet-stream').slice(0, 100),
              ...(Number.isFinite(Number(file.pages)) ? { pages: Math.max(0, Math.trunc(Number(file.pages))) } : {}),
              ...(Number.isFinite(Number(file.bytes)) ? { bytes: Math.max(0, Math.trunc(Number(file.bytes))) } : {}),
              ...(Number.isFinite(Number(file.textChars)) ? { textChars: Math.max(0, Math.trunc(Number(file.textChars))) } : {}),
              ...(typeof file.text === 'string' && file.text ? { text: file.text.slice(0, MAX_PDF_TEXT_CHARS) } : {})
            }));
          if (files.length) entry.files = files;
        }
        if (message && Array.isArray(message.toolCalls) && message.toolCalls.length) {
          const toolCalls = message.toolCalls.slice(0, MAX_TOOL_CALLS_PER_MESSAGE).map((call) => {
            const name = call && call.name ? String(call.name) : 'tool';
            const item = { name };
            if (call && call.callId) item.callId = String(call.callId);
            if (call && call.args !== undefined) {
              item.args = String(typeof call.args === 'string' ? call.args : JSON.stringify(call.args)).slice(0, MAX_TOOL_TEXT_CHARS);
            }
            if (call && call.result !== undefined) {
              item.result = String(typeof call.result === 'string' ? call.result : JSON.stringify(call.result)).slice(0, MAX_TOOL_TEXT_CHARS);
            }
            return item;
          });
          entry.toolCalls = toolCalls;
        }
        // v2.36：有生成图片但上游没给 GenerateImage 工具帧时，补一条「图片生成」记录（前端展示）
        if (entry.images && entry.images.length) {
          const toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : [];
          if (!toolCalls.some((call) => /generate|image/i.test(call.name || ''))) {
            toolCalls.unshift({ name: 'GenerateImage', result: '已生成 ' + entry.images.length + ' 张图片' });
          }
          entry.toolCalls = toolCalls;
        }
        if (message && Array.isArray(message.sources) && message.sources.length) {
          entry.sources = message.sources
            .filter((source) => source && source.url)
            .slice(0, MAX_SOURCES_PER_MESSAGE)
            .map((source) => ({
              url: String(source.url),
              ...(source.title ? { title: String(source.title) } : {})
            }));
        }
        return entry;
      });
      const payload = JSON.stringify(normalized);
      const sizeBytes = Buffer.byteLength(payload, 'utf8');
      const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 120) : titleFrom(normalized);
      const systemPrompt =
        typeof entry.systemPrompt === 'string' && entry.systemPrompt.trim()
          ? entry.systemPrompt.slice(0, MAX_MESSAGE_CHARS)
          : null;
      const model = typeof entry.model === 'string' && entry.model ? entry.model : null;
      const injection = normalizeInjection(entry.injection);
      const injectionJson = injection ? JSON.stringify(injection) : null;

      const existing = db.db
        .prepare('SELECT id, created_at FROM history WHERE identity_id IS ? AND session_key = ?')
        .get(identityId, sessionKey);
      const id = existing?.id || `hist_${crypto.randomBytes(6).toString('hex')}`;
      const createdAt = existing?.created_at || ts;
      db.db
        .prepare(
          `INSERT INTO history(id, identity_id, session_key, title, model, system_prompt, messages_json, injection_json, message_count, created_at, updated_at, size_bytes)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, model = excluded.model, system_prompt = excluded.system_prompt,
             messages_json = excluded.messages_json, injection_json = excluded.injection_json,
             message_count = excluded.message_count, updated_at = excluded.updated_at, size_bytes = excluded.size_bytes`
        )
        .run(id, identityId, sessionKey, title, model, systemPrompt, payload, injectionJson, normalized.length, createdAt, ts, sizeBytes);
      // 更新身份标签快照
      if (identityId && typeof entry.identityLabel === 'string' && entry.identityLabel) {
        db.db.prepare('UPDATE history SET identity_id = ? WHERE id = ?').run(identityId, id);
      }
      return { id, title, messageCount: normalized.length, updatedAt: ts };
    },

    /** 按身份分组返回会话列表（组内按更新时间倒序）。 */
    list({ limit = 200, identityId = null } = {}) {
      if (!db) return { groups: [], total: 0 };
      const max = normalizeLimit(limit, 200);
      const rows = identityId
        ? db.db
            .prepare('SELECT * FROM history WHERE identity_id = ? ORDER BY updated_at DESC LIMIT ?')
            .all(identityId, max)
        : db.db.prepare('SELECT * FROM history ORDER BY updated_at DESC LIMIT ?').all(max);
      const groups = new Map();
      for (const row of rows) {
        const key = row.identity_id || '__unassigned__';
        if (!groups.has(key)) {
          groups.set(key, { identityId: row.identity_id, items: [], count: 0, updatedAt: 0 });
        }
        const group = groups.get(key);
        group.items.push({
          id: row.id,
          identityId: row.identity_id,
          sessionKey: row.session_key,
          title: stripPdfInstruction(row.title),
          model: row.model,
          messageCount: row.message_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          sizeBytes: row.size_bytes
        });
        group.count += 1;
        group.updatedAt = Math.max(group.updatedAt, Number(row.updated_at) || 0);
      }
      const list = [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return { groups: list, total: rows.length };
    },

    /** 单条会话详情（含消息与系统上下文）。 */
    get(id) {
      if (!db) return null;
      const row = db.db.prepare('SELECT * FROM history WHERE id = ?').get(String(id));
      if (!row) return null;
      let messages = [];
      try {
        messages = JSON.parse(row.messages_json);
      } catch {
        messages = [];
      }
      return {
        id: row.id,
        identityId: row.identity_id,
        sessionKey: row.session_key,
        title: stripPdfInstruction(row.title),
        model: row.model,
        systemPrompt: row.system_prompt,
        messages: Array.isArray(messages)
          ? messages.map((message) => ({ ...message, content: stripPdfInstruction(message.content) }))
          : [],
        injection: (() => {
          if (!row.injection_json) return null;
          try {
            return normalizeInjection(JSON.parse(row.injection_json));
          } catch {
            return null;
          }
        })(),
        messageCount: row.message_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sizeBytes: row.size_bytes
      };
    },

    remove(id) {
      if (!db) return false;
      const result = db.db.prepare('DELETE FROM history WHERE id = ?').run(String(id));
      return (result.changes || 0) > 0;
    },

    /** 清理超过保留天数的会话；返回删除条数。 */
    prune() {
      if (!db) return 0;
      const days = retentionDays();
      if (!days) return 0;
      const deadline = now() - days * 86400000;
      const result = db.db.prepare('DELETE FROM history WHERE updated_at < ?').run(deadline);
      const removed = result.changes || 0;
      if (removed > 0) logger?.info?.('[history] pruned stale conversations', { removed, retentionDays: days });
      return removed;
    },

    /** 统计（概览/诊断用）。 */
    stats() {
      if (!db) return { total: 0, bytes: 0, retentionDays: retentionDays() };
      const row = db.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes FROM history').get();
      return { total: Number(row?.total) || 0, bytes: Number(row?.bytes) || 0, retentionDays: retentionDays() };
    }
  };

  // 启动时清理一次
  try {
    store.prune();
  } catch (error) {
    logger?.warn?.('[history] initial prune failed', { error: error.message });
  }

  return store;
}
