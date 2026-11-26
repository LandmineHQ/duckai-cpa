/**
 * 图片工坊画廊持久层（SQLite: data/duckai.db `image_gallery` 表）。
 *
 * 按 AGENTS.md 约定：新增列表型数据一律写入 SQLite，兼容 node:sqlite 与 bun:sqlite，不新造 JSON 快照文件。
 */
import crypto from 'node:crypto';
import { openDatabase } from '../db.js';
import { detectImageFormat, imageMimeType } from '../duck/image-format.js';
import { imagePixelSize } from '../duck/image-convert.js';

function rowToItem(row, { includeB64 = true } = {}) {
  if (!row) return null;
  const format = row.format || 'jpeg';
  const mimeType = row.mime_type || imageMimeType(format);
  return {
    id: row.id,
    prompt: row.prompt,
    composedPrompt: row.composed_prompt,
    style: row.style || 'auto',
    aspectRatio: row.aspect_ratio || '1:1',
    mood: row.mood || 'none',
    negativePrompt: row.negative_prompt || '',
    model: row.model,
    modelDisplayName: row.model_display_name || null,
    identityId: row.identity_id || null,
    identityLabel: row.identity_label || null,
    format,
    mimeType,
    width: Number.isFinite(row.width) ? row.width : null,
    height: Number.isFinite(row.height) ? row.height : null,
    ...(includeB64 ? { b64: row.b64, dataUrl: `data:${mimeType};base64,${row.b64}` } : {}),
    upstreamImageId: row.upstream_image_id || null,
    moderationToken: row.moderation_token || null,
    parentId: row.parent_id || null,
    latencyMs: Number.isFinite(row.latency_ms) ? row.latency_ms : null,
    createdAt: row.created_at
  };
}

export function createImageGalleryStore({ dataDir, logger = null } = {}) {
  if (!dataDir) throw new Error('createImageGalleryStore: dataDir is required');
  let dbPromise = null;

  async function getDb() {
    if (!dbPromise) {
      dbPromise = openDatabase({ dataDir, logger }).catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  }

  return {
    async init() {
      await getDb();
      return this;
    },

    async save(entry) {
      const db = (await getDb()).db;
      const b64 = String(entry.b64 || '');
      if (!b64) throw new Error('image_gallery.save requires non-empty b64');
      const format = detectImageFormat(b64, entry.format || 'png');
      const mimeType = imageMimeType(format);
      let width = Number(entry.width);
      let height = Number(entry.height);
      if (!(Number.isFinite(width) && width > 0) || !(Number.isFinite(height) && height > 0)) {
        const size = imagePixelSize(b64);
        width = size?.width || null;
        height = size?.height || null;
      }
      const id = entry.id || `gal_${crypto.randomBytes(8).toString('hex')}`;
      const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
      db.prepare(
        `INSERT INTO image_gallery(
          id, prompt, composed_prompt, style, aspect_ratio, mood, negative_prompt,
          model, model_display_name, identity_id, identity_label,
          format, mime_type, width, height, b64,
          upstream_image_id, moderation_token, parent_id, latency_ms, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        String(entry.prompt || ''),
        String(entry.composedPrompt || entry.prompt || ''),
        entry.style || 'auto',
        entry.aspectRatio || '1:1',
        entry.mood || 'none',
        entry.negativePrompt || null,
        String(entry.model || 'gpt-6-luna'),
        entry.modelDisplayName || null,
        entry.identityId || null,
        entry.identityLabel || null,
        format,
        mimeType,
        width,
        height,
        b64,
        entry.upstreamImageId || null,
        entry.moderationToken || null,
        entry.parentId || null,
        Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null,
        createdAt
      );
      return this.get(id);
    },

    async list({ limit = 60, offset = 0, style = null, model = null, q = null } = {}) {
      const db = (await getDb()).db;
      const where = [];
      const params = [];
      if (style && style !== 'all') {
        where.push('style = ?');
        params.push(String(style));
      }
      if (model && model !== 'all') {
        where.push('model = ?');
        params.push(String(model));
      }
      if (q && String(q).trim()) {
        where.push('(prompt LIKE ? OR composed_prompt LIKE ?)');
        const pat = `%${String(q).trim()}%`;
        params.push(pat, pat);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = db.prepare(`SELECT COUNT(*) AS cnt FROM image_gallery ${clause}`).get(...params);
      const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 60)));
      const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
      const rows = db
        .prepare(`SELECT * FROM image_gallery ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, safeLimit, safeOffset);
      return {
        items: rows.map((row) => rowToItem(row, { includeB64: true })),
        total: Number(totalRow?.cnt || 0)
      };
    },

    async get(id) {
      if (!id) return null;
      const db = (await getDb()).db;
      const row = db.prepare('SELECT * FROM image_gallery WHERE id = ?').get(String(id));
      return rowToItem(row, { includeB64: true });
    },

    async remove(id) {
      if (!id) return false;
      const db = (await getDb()).db;
      const result = db.prepare('DELETE FROM image_gallery WHERE id = ?').run(String(id));
      return (result.changes || 0) > 0;
    },

    async bulkRemove(ids = []) {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
      if (!list.length) return { deleted: 0 };
      const db = (await getDb()).db;
      const placeholders = list.map(() => '?').join(',');
      const result = db.prepare(`DELETE FROM image_gallery WHERE id IN (${placeholders})`).run(...list);
      return { deleted: Number(result.changes || 0) };
    },

    async stats() {
      const db = (await getDb()).db;
      const total = db.prepare('SELECT COUNT(*) AS cnt FROM image_gallery').get()?.cnt || 0;
      const byStyle = db
        .prepare('SELECT COALESCE(style, \'auto\') AS style, COUNT(*) AS cnt FROM image_gallery GROUP BY style')
        .all();
      return { total: Number(total), byStyle };
    }
  };
}

export default { createImageGalleryStore };
