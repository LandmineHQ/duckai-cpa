/**
 * v2.15 subscription store — first-class DuckDuckGo Plus/Pro subscriptions.
 *
 * A subscription (token) used to live inside a single identity (`identity.auth`), so the same
 * DuckDuckGo subscription could only power one anonymous identity. The pool now stores
 * subscriptions separately in SQLite (`data/duckai.db`; v2.31 migration) and identities reference
 * them by `subscriptionId`, which lets one subscription back many identities/devices.
 *
 *   { version: 1, items: [{ id, label, email, tier, entitlements, expiresAt, verified,
 *                           tokenHash, token, source, createdAt, updatedAt, lastVerifiedAt }] }
 *
 * The plaintext token is never returned over HTTP (`list()`/`get()` sanitize it).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSubscriptionToken, AuthError } from '../duck/auth.js';
import { openDatabase, readJsonIfExists } from '../db.js';

const FILE = 'subscriptions.json';
const VERSION = 1;
const PAID_TIERS = new Set(['plus', 'pro', 'internal']);

function now() {
  return Date.now();
}

/** Mask a token so the UI can distinguish entries without exposing the secret. */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length < 12) return null;
  return `${token.slice(0, 8)}…${token.slice(-6)}`;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Interpret a parsed token payload into the public subscription view. */
function viewOf(entry) {
  const expired =
    Boolean(entry.expiresAt) && Number.isFinite(Date.parse(entry.expiresAt))
      ? Date.parse(entry.expiresAt) <= Date.now()
      : false;
  return {
    id: entry.id,
    label: entry.label,
    email: entry.email || null,
    tier: entry.tier || 'free',
    paid: PAID_TIERS.has(entry.tier),
    entitlements: Array.isArray(entry.entitlements) ? entry.entitlements : [],
    expiresAt: entry.expiresAt || null,
    expired,
    verified: entry.verified === true,
    verifyError: entry.verifyError || null,
    maskedToken: maskToken(entry.token),
    tokenHashPrefix: typeof entry.tokenHash === 'string' ? entry.tokenHash.slice(0, 12) : null,
    source: entry.source || 'manual',
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    lastVerifiedAt: entry.lastVerifiedAt || null,
    // v2.27：自动续期状态（refresh token 只存服务端，视图不暴露明文）
    autoRefresh: typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0,
    refreshTokenUpdatedAt: entry.refreshTokenUpdatedAt || null,
    refreshedAt: entry.refreshedAt || null,
    refreshError: entry.refreshError || null,
    refreshCount: Number.isFinite(entry.refreshCount) ? entry.refreshCount : 0
  };
}

const REFRESH_COOKIE = 'ddg_auth_refresh_token';
const TOKEN_URL = 'https://duck.ai/duckchat/v1/auth/token';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export async function createSubscriptionStore({
  dataDir = 'data',
  logger = null,
  fetchImpl = null,
  userAgent = DEFAULT_UA
} = {}) {
  const filePath = path.join(dataDir, FILE);
  let state = { version: VERSION, items: [], updatedAt: null };
  // v2.31：SQLite 持久化（旧 subscriptions.json 首次启动时自动导入）
  const database = await openDatabase({ dataDir, logger });
  let sqliteReady = false;
  let loaded = false;
  let writeChain = Promise.resolve();
  let tempCounter = 0;
  // v2.27：自刷新用的出站 fetch（由 src/index.js 注入代理感知实现）
  let outboundFetch = fetchImpl || ((url, init) => fetch(url, init));
  const ua = typeof userAgent === 'string' && userAgent ? userAgent : DEFAULT_UA;

  function rowToItem(row) {
    try {
      const parsed = JSON.parse(row.record_json);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') return parsed;
    } catch {
      // fall through
    }
    return null;
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      // 1) 先读 SQLite
      const rows = database.db.prepare('SELECT record_json FROM subscriptions ORDER BY created_at ASC').all();
      const items = rows.map(rowToItem).filter(Boolean);
      if (items.length > 0) {
        state = { version: VERSION, items, updatedAt: state.updatedAt };
        sqliteReady = true;
        return;
      }
      // 2) 空库 → 尝试从旧 JSON 导入（一次性）
      const raw = readJsonIfExists(filePath);
      if (raw && Array.isArray(raw.items)) {
        state = {
          version: VERSION,
          items: raw.items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string'),
          updatedAt: raw.updatedAt ?? null
        };
        sqliteReady = true;
        await persist();
        logger?.info?.('[subscriptions] migrated subscriptions.json → sqlite', { count: state.items.length });
      } else {
        sqliteReady = true;
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logger?.warn?.('[subscriptions] failed to load subscriptions; starting empty', { error: error.message });
      }
      sqliteReady = false;
    }
  }

  async function persist() {
    state.updatedAt = now();
    if (!sqliteReady) return;
    const items = state.items;
    writeChain = writeChain.then(async () => {
      try {
        database.transaction(() => {
          const stmt = database.db.prepare(
            `INSERT INTO subscriptions(id, label, email, tier, paid, expires_at, verified, source, token_hash, record_json, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               label = excluded.label, email = excluded.email, tier = excluded.tier, paid = excluded.paid,
               expires_at = excluded.expires_at, verified = excluded.verified, source = excluded.source,
               token_hash = excluded.token_hash, record_json = excluded.record_json, updated_at = excluded.updated_at`
          );
          const keep = new Set();
          for (const item of items) {
            keep.add(item.id);
            stmt.run(
              item.id,
              item.label ?? null,
              item.email ?? null,
              item.tier ?? null,
              PAID_TIERS.has(item.tier) ? 1 : 0,
              item.expiresAt ?? null,
              item.verified === true ? 1 : 0,
              item.source ?? null,
              item.tokenHash ?? null,
              JSON.stringify(item),
              Number(item.createdAt) || null,
              Number(item.updatedAt) || null
            );
          }
          const existing = database.db.prepare('SELECT id FROM subscriptions').all();
          const del = database.db.prepare('DELETE FROM subscriptions WHERE id = ?');
          for (const row of existing) {
            if (!keep.has(row.id)) del.run(row.id);
          }
        });
      } catch (error) {
        logger?.warn?.('[subscriptions] sqlite persist failed', { error: error.message });
      }
    });
    await writeChain;
  }

  function newId() {
    return `sub_${crypto.randomBytes(4).toString('hex')}`;
  }

  function findById(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  function findByTokenHash(hash) {
    return state.items.find((item) => item.tokenHash === hash) || null;
  }

  /** Parse and normalize a raw token into store fields. */
  function parseToken(token) {
    let info;
    try {
      info = parseSubscriptionToken(token);
    } catch (error) {
      if (error instanceof AuthError) {
        throw Object.assign(new Error(error.message), {
          status: error.status || 422,
          code: error.code || 'token_invalid',
          detail: error.detail
        });
      }
      throw error;
    }
    return {
      token: String(token).trim().replace(/^Bearer\s+/i, ''),
      tokenHash: tokenHash(String(token).trim().replace(/^Bearer\s+/i, '')),
      email: info.email || null,
      tier: PAID_TIERS.has(info.tier) ? info.tier : 'free',
      entitlements: Array.isArray(info.entitlements) ? info.entitlements : [],
      expiresAt: info.expiresAt || null,
      verified: info.verified === true
    };
  }

  return {
    get filePath() {
      return filePath;
    },

    async list() {
      await ensureLoaded();
      return state.items.map((entry) => viewOf(entry));
    },

    async get(id) {
      await ensureLoaded();
      const entry = findById(id);
      return entry ? viewOf(entry) : null;
    },

    /** Raw (with token) — internal use only (identity binding mirrors auth). */
    async getRaw(id) {
      await ensureLoaded();
      const entry = findById(id);
      return entry ? { ...entry } : null;
    },

    /**
     * Add a subscription from a DuckDuckGo token. Duplicate tokens return the existing entry.
     * @param {{ token: string, label?: string }} params
     * @returns {Promise<{ subscription: object, duplicate: boolean }>}
     */
    async add({ token, label, source = 'manual' } = {}) {
      await ensureLoaded();
      if (typeof token !== 'string' || !token.trim()) {
        throw Object.assign(new Error('"token" is required'), { status: 400, code: 'invalid_request' });
      }
      const parsed = parseToken(token);
      const existing = findByTokenHash(parsed.tokenHash);
      if (existing) {
        if (typeof label === 'string' && label.trim() && !existing.label) {
          existing.label = label.trim();
          existing.updatedAt = now();
          await persist();
        }
        return { subscription: viewOf(existing), duplicate: true };
      }
      const entry = {
        id: newId(),
        label: typeof label === 'string' && label.trim() ? label.trim() : defaultLabel(parsed),
        ...parsed,
        source: source === 'login' ? 'login' : 'manual',
        verified: true,
        verifyError: null,
        createdAt: now(),
        updatedAt: now(),
        lastVerifiedAt: now()
      };
      state.items.push(entry);
      await persist();
      return { subscription: viewOf(entry), duplicate: false };
    },

    async updateLabel(id, label) {
      await ensureLoaded();
      const entry = findById(id);
      if (!entry) throw Object.assign(new Error('subscription not found'), { status: 404, code: 'subscription_not_found' });
      if (label !== undefined) {
        if (typeof label !== 'string') throw Object.assign(new Error('"label" must be a string'), { status: 400, code: 'invalid_request' });
        entry.label = label.trim().slice(0, 100);
      }
      entry.updatedAt = now();
      await persist();
      return viewOf(entry);
    },

    async remove(id) {
      await ensureLoaded();
      const index = state.items.findIndex((item) => item.id === id);
      if (index === -1) return { removed: false, subscription: null };
      const [entry] = state.items.splice(index, 1);
      await persist();
      return { removed: true, subscription: viewOf(entry) };
    },

    /** Re-parse the stored token; marks tier/expiry/verified fresh. */
    /** 设置/更新 refresh token（用于自动续期；不暴露给视图）。 */
    async setRefreshToken(id, refreshToken) {
      await ensureLoaded();
      const entry = findById(id);
      if (!entry) {
        throw Object.assign(new Error('subscription not found'), { status: 404, code: 'subscription_not_found' });
      }
      const value = typeof refreshToken === 'string' ? refreshToken.trim() : '';
      if (!value || value.split('.').length !== 3) {
        throw Object.assign(
          new Error('refresh token 必须是三段式 JWT（DevTools → Application → Cookies 里的 ddg_auth_refresh_token 值）'),
          { status: 400, code: 'invalid_refresh_token', field: 'refreshToken' }
        );
      }
      entry.refreshToken = value;
      entry.refreshTokenUpdatedAt = now();
      entry.refreshError = null;
      entry.updatedAt = now();
      await persist();
      return viewOf(entry);
    },

    /** 清除 refresh token（关闭自动续期）。 */
    async clearRefreshToken(id) {
      await ensureLoaded();
      const entry = findById(id);
      if (!entry) {
        throw Object.assign(new Error('subscription not found'), { status: 404, code: 'subscription_not_found' });
      }
      entry.refreshToken = null;
      entry.refreshTokenUpdatedAt = null;
      entry.refreshError = null;
      entry.updatedAt = now();
      await persist();
      return viewOf(entry);
    },

    /**
     * v2.27：用 ddg_auth_refresh_token 在服务端换新的 access_token（自动续期）。
     *
     * 源码依据：duck.ai 前端每次取 token 都是带 cookie 请求 /duckchat/v1/auth/token；
     * 该端点认 ddg_auth_refresh_token（30 天、scope=refresh），并在响应 Set-Cookie 里轮换新值。
     * 因此保存 refresh token 并在每次刷新后更新它，网关即可长期自刷新。
     */
    async refreshAccessToken(id, { force = false } = {}) {
      await ensureLoaded();
      const entry = findById(id);
      if (!entry) {
        throw Object.assign(new Error('subscription not found'), { status: 404, code: 'subscription_not_found' });
      }
      if (!entry.refreshToken) {
        throw Object.assign(new Error('该订阅未保存 refresh token，无法自动续期'), {
          status: 400,
          code: 'refresh_token_missing',
          hint: '在已登录 duck.ai 的浏览器里，打开 DevTools → Application → Cookies → 复制 ddg_auth_refresh_token 的值粘贴保存'
        });
      }
      const expiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : null;
      const expiringSoon = !Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() <= 30 * 60 * 1000;
      if (!force && !expiringSoon) {
        return { refreshed: false, reason: 'not_expiring', subscription: viewOf(entry) };
      }

      let response;
      try {
        response = await outboundFetch(TOKEN_URL, {
          method: 'GET',
          headers: {
            'user-agent': ua,
            accept: 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            referer: 'https://duck.ai/',
            origin: 'https://duck.ai',
            cookie: `${REFRESH_COOKIE}=${entry.refreshToken}`
          }
        });
      } catch (error) {
        entry.refreshError = String(error?.message || error).slice(0, 200);
        entry.updatedAt = now();
        await persist();
        throw Object.assign(new Error(`刷新 token 失败（网络）：${entry.refreshError}`), {
          status: 502,
          code: 'refresh_failed',
          detail: entry.refreshError
        });
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || typeof payload.access_token !== 'string') {
        const reason = `HTTP ${response.status}`;
        entry.refreshError = reason;
        entry.updatedAt = now();
        await persist();
        throw Object.assign(new Error(`刷新 token 失败：${reason}（refresh token 可能已失效，请重新复制）`), {
          status: 502,
          code: 'refresh_failed',
          detail: reason
        });
      }

      const parsed = parseToken(payload.access_token);
      let rotated = null;
      try {
        const cookies =
          typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean);
        for (const line of cookies) {
          const match = new RegExp(`${REFRESH_COOKIE}=([^;]+)`).exec(String(line || ''));
          if (match) rotated = match[1];
        }
      } catch {
        rotated = null;
      }

      Object.assign(entry, {
        token: payload.access_token,
        tokenHash: parsed.tokenHash,
        email: parsed.email ?? entry.email,
        tier: parsed.tier,
        entitlements: parsed.entitlements,
        expiresAt: parsed.expiresAt,
        verified: true,
        verifyError: null,
        refreshError: null,
        refreshedAt: now(),
        refreshCount: (Number.isFinite(entry.refreshCount) ? entry.refreshCount : 0) + 1,
        updatedAt: now(),
        ...(rotated ? { refreshToken: rotated, refreshTokenUpdatedAt: now() } : {})
      });
      await persist();
      logger?.info?.('[subscriptions] access token refreshed', {
        id: entry.id,
        tier: entry.tier,
        expiresAt: entry.expiresAt,
        rotatedRefreshToken: Boolean(rotated)
      });
      return {
        refreshed: true,
        rotatedRefreshToken: Boolean(rotated),
        subscription: viewOf(entry),
        raw: {
          token: entry.token,
          tier: entry.tier,
          expiresAt: entry.expiresAt,
          email: entry.email,
          entitlements: entry.entitlements
        }
      };
    },

    /** 列出需要续期的订阅（expiresAt 在 withinMs 内或已过期，且有 refresh token）。 */
    async listNeedingRefresh(withinMs = 30 * 60 * 1000) {
      await ensureLoaded();
      const deadline = Date.now() + Math.max(0, withinMs);
      return state.items
        .filter((entry) => typeof entry.refreshToken === 'string' && entry.refreshToken)
        .filter((entry) => {
          const at = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
          return !Number.isFinite(at) || at <= deadline;
        })
        .map((entry) => ({ id: entry.id, label: entry.label, tier: entry.tier, expiresAt: entry.expiresAt || null }));
    },

    /** 注入代理感知的 fetch。 */
    setFetcher(fn) {
      if (typeof fn === 'function') outboundFetch = fn;
    },

    async verify(id) {
      await ensureLoaded();
      const entry = findById(id);
      if (!entry) throw Object.assign(new Error('subscription not found'), { status: 404, code: 'subscription_not_found' });
      try {
        const parsed = parseToken(entry.token);
        Object.assign(entry, {
          email: parsed.email ?? entry.email,
          tier: parsed.tier,
          entitlements: parsed.entitlements,
          expiresAt: parsed.expiresAt,
          verified: true,
          verifyError: null,
          updatedAt: now(),
          lastVerifiedAt: now()
        });
      } catch (error) {
        entry.verified = false;
        entry.verifyError = error.code || error.message;
        entry.updatedAt = now();
        entry.lastVerifiedAt = now();
        await persist();
        throw Object.assign(new Error(error.message), {
          status: error.status || 422,
          code: error.code || 'token_invalid',
          subscription: viewOf(entry)
        });
      }
      await persist();
      return viewOf(entry);
    },

    async close() {
      await writeChain.catch(() => {});
    }
  };
}

function defaultLabel(parsed) {
  if (parsed.email) return parsed.email;
  const tier = parsed.tier && parsed.tier !== 'free' ? parsed.tier : 'free';
  return `DuckDuckGo ${tier} 订阅`;
}

export { PAID_TIERS };
