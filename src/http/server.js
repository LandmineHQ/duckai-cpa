/**
 * HTTP server for duckai-cpa v2 (pure node:http).
 *
 * Responsibilities:
 *   - routing for /v1/*, /admin/api/*, /healthz, /admin (static React build)
 *   - **mandatory** Bearer API-key auth for /v1/* (admin token for /admin/api/*)
 *   - CORS (config.server.cors)
 *   - JSON body parsing with a size limit
 *   - SSE writers (unbuffered, flushHeaders, heartbeat, client-disconnect abort)
 *   - upstream RPS queue wiring (`ctx.callUpstream`) + split request logging
 *   - path-traversal-safe static file serving + SPA fallback
 *   - graceful shutdown helper (closes queue, flushes sessions/store)
 *
 * `createServer({ config, store, duck, logger, webDir, queue?, sessions? })`
 * returns a plain `http.Server` so tests can inject a mock DuckClient (and an
 * optional custom queue / sessions store).
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  badRequest,
  errorPayload,
  methodNotAllowed,
  notFound,
  payloadTooLarge,
  toOpenAIError,
  unauthorized
} from '../openai/errors.js';
import { handleListModels, listModelsPayload } from '../openai/models.js';
import { handleChatCompletions } from '../openai/chat.js';
import { handleCompact } from '../openai/compact.js';
import { handleResponses } from '../openai/responses.js';
import { handleImagesGenerations } from '../openai/images.js';
import { handleAdminRequest } from '../admin/routes.js';
import { getProxyHealthSummary } from '../admin/proxy-routes.js';
import { isContextLimitError } from '../openai/context-guard.js';
import { createUpstreamQueue } from '../upstream/queue.js';
import { createSessionsStore } from '../admin/sessions.js';
import { PROJECT_ROOT } from '../config.js';
import { createNullLogger } from '../logger.js';
import { timingSafeEqualString } from '../store.js';

const SERVICE_NAME = 'duckai-cpa';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15000;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
});

const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Requested-With, Accept, Origin, X-Api-Key';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
const CORS_EXPOSE_HEADERS =
  'X-Request-Id, X-Duckai-Model, X-Duckai-Reasoning-Effort, X-Duckai-Reasoning-Adjusted, X-Duckai-Reasoning-Note, X-Duckai-Retriable, X-Duckai-Retry-At, X-Duckai-Queue, Retry-After';

/* ------------------------------------------------------------------ */
/* Package metadata                                                    */
/* ------------------------------------------------------------------ */

let cachedPackageMeta = null;

export function getPackageMeta() {
  if (cachedPackageMeta) return cachedPackageMeta;
  try {
    cachedPackageMeta = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  } catch {
    cachedPackageMeta = { name: SERVICE_NAME, version: '0.1.0' };
  }
  return cachedPackageMeta;
}

export function getServiceVersion() {
  return getPackageMeta().version || '0.1.0';
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const apiKeyHeader = req.headers?.['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) return apiKeyHeader.trim();
  return null;
}

async function readJsonBody(req) {
  const contentLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw payloadTooLarge();
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw payloadTooLarge();
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw badRequest(`Invalid JSON body: ${error.message}`, null, 'invalid_json');
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderIntroPage({ version, config }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(SERVICE_NAME)} v2</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 860px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.65; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { background: rgba(127,127,127,.12); padding: .9rem 1rem; border-radius: .5rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    td, th { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid rgba(127,127,127,.25); }
    .tag { font-size: .8rem; opacity: .75; }
  </style>
</head>
<body>
  <h1>${escapeHtml(SERVICE_NAME)} <span class="tag">v2</span></h1>
  <p class="tag">OpenAI-compatible gateway for duck.ai · version ${escapeHtml(version)}</p>
  <p>管理后台：<a href="/admin/">/admin</a> · 健康检查：<a href="/healthz">/healthz</a></p>
  <p><strong>v2 起所有 <code>/v1/*</code> 请求必须携带 API Key</strong>（<code>Authorization: Bearer sk-duck-…</code>），首次启动会自动生成 default key 并打印一次，也可在管理后台创建。</p>
  <table>
    <tr><th>方法</th><th>路径</th><th>说明</th></tr>
    <tr><td>GET</td><td><code>/v1/models</code></td><td>模型列表（含免费/付费标记）</td></tr>
    <tr><td>POST</td><td><code>/v1/chat/completions</code></td><td>对话补全（stream / web_search / image_generation / reasoning_effort）</td></tr>
    <tr><td>POST</td><td><code>/v1/responses</code></td><td>OpenAI Responses API</td></tr>
    <tr><td>POST</td><td><code>/v1/images/generations</code></td><td>图片生成</td></tr>
<tr><td>POST</td><td><code>/v1/compact</code></td><td>客户端显式上下文压缩（返回摘要 + 保留的最近消息）</td></tr>
    <tr><td>—</td><td><code>/admin/api/*</code></td><td>管理 API（adminToken）</td></tr>
  </table>
  <h2>快速开始</h2>
  <pre>curl http://127.0.0.1:${escapeHtml(config.server.port)}/v1/chat/completions \\
  -H "Authorization: Bearer $DUCKAI_CPA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"Hello"}]}'</pre>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* createServer                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   config: Record<string, any>,
 *   store: Record<string, any>,
 *   duck: Record<string, any>,
 *   logger?: Record<string, any>,
 *   webDir?: string,
 *   version?: string,
 *   queue?: ReturnType<typeof createUpstreamQueue>,
 *   sessions?: ReturnType<typeof createSessionsStore>,
 *   identity?: Record<string, any>|null,
 *   proxy?: Record<string, any>|null,
 *   identities?: Record<string, any>|null,
 *   pairing?: Record<string, any>|null,
 *   syncDevices?: Record<string, any>|null,
 *   chatSummaries?: Record<string, any>|null
 * }} options
 * @returns {import('node:http').Server & { closeGracefully: Function }}
 */
export function createServer(options = {}) {
  const { config, store, duck } = options;
  if (!config) throw new Error('createServer: config is required');
  if (!store) throw new Error('createServer: store is required');

  const logger = options.logger || createNullLogger();
  const version = options.version || getServiceVersion();
  const webDir = options.webDir || path.join(PROJECT_ROOT, 'web');
  const queue = options.queue || createUpstreamQueue({ config, logger });
  const sessions = options.sessions || createSessionsStore({ dataDir: store.dataDir, config, logger });

  /**
   * v2.32：额度耗尽时计算「何时恢复」。
   *  - 优先用上游 limit 帧附带的 [FIXED_COST_WINDOW_USAGE] windows[].resetAt（isBlocked 优先，其次最近的未来 resetAt）；
   *  - 没有窗口信息时用 config.pool.quotaCooldownMinutes 兜底。
   */
  function resolveQuotaCooldownUntil(error, fallbackMs) {
    const nowMs = Date.now();
    const candidates = [];
    const usage = error && error.fixedCostWindowUsage;
    const windows = usage && Array.isArray(usage.windows) ? usage.windows : [];
    for (const window of windows) {
      if (!window || typeof window.resetAt !== 'string') continue;
      const at = Date.parse(window.resetAt);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      candidates.push({ at, blocked: window.isBlocked === true, id: window.id || null });
    }
    if (candidates.length) {
      const blocked = candidates.filter((item) => item.blocked);
      const pool = blocked.length ? blocked : candidates;
      pool.sort((a, b) => a.at - b.at);
      return { until: pool[0].at, source: 'window_reset', windowId: pool[0].id };
    }
    return { until: nowMs + fallbackMs, source: 'fallback' };
  }

  /** 上游额度类错误 → 给当前身份打冷却标记（临时禁用）。 */
  async function markIdentityCooldownFromError(ctx, error) {
    try {
      const identityId = ctx.identityRoute && ctx.identityRoute.identityId;
      if (!identityId || !identities || typeof identities.markCooldown !== 'function') return;
      const mapped = toOpenAIError(error);
      const quotaCodes = new Set(['user_limit_exceeded', 'upstream_subscription_required']);
      const upstreamType = String(error?.upstreamType || '');
      const isQuota =
        quotaCodes.has(mapped.code) ||
        upstreamType === 'ERR_USER_LIMIT' ||
        upstreamType === 'ERR_ACCOUNT_LIMIT';
      if (!isQuota) return;
      const fallbackMs = (() => {
        const minutes = Number(ctx.config?.pool?.quotaCooldownMinutes);
        return (Number.isFinite(minutes) && minutes > 0 ? Math.min(10080, Math.floor(minutes)) : 1440) * 60 * 1000;
      })();
      const resolved = resolveQuotaCooldownUntil(error, fallbackMs);
      const scope = error?.limitScope || (upstreamType === 'ERR_ACCOUNT_LIMIT' ? 'account' : 'entity');
      await identities.markCooldown(identityId, {
        until: resolved.until,
        reason: 'quota_exhausted',
        scope,
        windows: error?.fixedCostWindowUsage?.windows || null
      });
      ctx.log.identityCooldown = {
        identityId,
        until: resolved.until,
        source: resolved.source,
        scope
      };
      logger.warn?.('identity marked cooling down', {
        identityId,
        until: new Date(resolved.until).toISOString(),
        source: resolved.source,
        scope
      });
    } catch (markError) {
      logger.warn?.('failed to mark identity cooldown', { error: markError.message });
    }
  }
  // v2.2: explicit identityStore injection (see docs/IDENTITY-SYNC.md). Tests may
  // inject a mock; when absent the identity/sync/subscription endpoints answer
  // 503 identity_unavailable while everything else keeps working.
  const identity = options.identity || null;
  // v2.3: explicit ProxyManager injection (docs/PROXY.md). Absent → /admin/api/proxy
  // answers 502 proxy_unavailable; everything else keeps working (direct mode).
  const proxy = options.proxy || null;
  // v2.4: identity pool (docs/IDENTITY-POOL.md). Absent → pool endpoints answer
  // 503 identity_pool_unavailable and /v1 falls back to the global DuckClient.
  const identities = options.identities || options.identityPool || null;
  // v2.5: pairing host service (docs/PAIRING-IMPL.md); absent → pairing endpoints 503.
  const pairing = options.pairing || null;
  // v2.8: DuckDuckGo Sync server-device registration service.
  const syncDevices = options.syncDevices || null;
  // v2.11: /v1 X-Session-Id compaction summary store.
  const chatSummaries = options.chatSummaries || null;
  // v2.15: first-class subscriptions (one subscription can back many identities).
  const subscriptions = options.subscriptions || null;
  // v2.31：会话历史（SQLite）
  const history = options.history || null;
  const serviceStartedAt = Date.now();

  /**
   * v2.4 sessionKey extraction: X-Session-Id header wins, then body
   * session_id / conversation_id (also accepts common metadata nesting).
   */
  function extractSessionKey(req, body) {
    const header = req.headers['x-session-id'];
    if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 512);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const field of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
        const value = body[field];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
      }
      for (const field of ['metadata', 'extra_body']) {
        const nested = body[field];
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const value = nested.session_id ?? nested.sessionId ?? nested.conversation_id;
          if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
        }
      }
    }
    return null;
  }

  // Upstream health is cached briefly so /healthz and the admin overview do not
  // stampede the challenge endpoint.
  const healthCache = { at: 0, value: null };
  async function getUpstreamHealth({ maxAgeMs = 2000 } = {}) {
    const now = Date.now();
    if (healthCache.value && now - healthCache.at < maxAgeMs) return healthCache.value;
    const started = Date.now();
    let upstream;
    try {
      const result = typeof duck?.health === 'function' ? await duck.health() : null;
      upstream = {
        ok: result?.ok !== false,
        ...(result?.version ? { version: result.version } : {}),
        challengeOk: result?.challengeOk === true,
        ...(result?.upstreamStatus !== undefined ? { upstreamStatus: result.upstreamStatus } : {}),
        ...(typeof result?.rateLimited === 'boolean' ? { rateLimited: result.rateLimited } : {}),
        ...(result?.retryAt ? { retryAt: result.retryAt } : {}),
        ...(result?.initDone !== undefined ? { initDone: result.initDone } : {}),
        ...(result?.durableStream && typeof result.durableStream === 'object'
          ? { durableStream: result.durableStream }
          : {}),
        ...(result?.identity && typeof result.identity === 'object' ? { identity: result.identity } : {}),
        ...(result?.stats && typeof result.stats === 'object' ? { health: result.stats } : {})
      };
    } catch (error) {
      upstream = { ok: false, challengeOk: false, error: error?.message || 'health check failed' };
    }
    upstream.latencyMs = Date.now() - started;
    healthCache.at = Date.now();
    healthCache.value = upstream;
    return upstream;
  }

  const baseContext = {
    config,
    store,
    duck,
    queue,
    sessions,
    identity,
    proxy,
    identities,
    pairing,
    syncDevices,
    chatSummaries,
    subscriptions,
    logger,
    version,
    webDir,
    serviceStartedAt,
    getUpstreamHealth
  };

  /* --------------------------- static files --------------------------- */

  function resolveStaticPath(baseDir, relativePath) {
    let decoded;
    try {
      decoded = decodeURIComponent(relativePath);
    } catch {
      return null;
    }
    if (!decoded || decoded.includes('\0')) return null;
    const normalized = decoded.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return null;
    const segments = normalized.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return null;
    if (segments.some((segment) => segment === '..' || segment === '.' || /^[a-zA-Z]:$/.test(segment))) {
      return null;
    }
    const baseResolved = path.resolve(baseDir);
    const resolved = path.resolve(baseResolved, ...segments);
    if (resolved !== baseResolved && !resolved.startsWith(`${baseResolved}${path.sep}`)) return null;
    return resolved;
  }

  async function serveStaticFile(ctx, filePath, { cacheControl = 'no-cache' } = {}) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    let data;
    try {
      data = await fsp.readFile(filePath);
    } catch {
      return false;
    }
    const headers = {
      'Content-Type': mimeFor(filePath),
      'Content-Length': data.length,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    };
    ctx.res.writeHead(200, headers);
    ctx.sent = true;
    if (ctx.method === 'HEAD') ctx.res.end();
    else ctx.res.end(data);
    return true;
  }

  async function serveAdminIndex(ctx) {
    const indexFile = path.join(webDir, 'index.html');
    if (await serveStaticFile(ctx, indexFile, { cacheControl: 'no-cache' })) return;
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${SERVICE_NAME} · admin</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;line-height:1.6">
  <h1>管理后台尚未构建</h1>
  <p>未找到 <code>web/index.html</code>（Vite 构建产物；<code>npm run build:web</code> 生成到 <code>web/</code>）。</p>
  <p>管理 API 仍然可用：<code>GET /admin/api/overview?token=&lt;adminToken&gt;</code>。</p>
</body></html>`;
    ctx.text(404, html, 'text/html; charset=utf-8');
  }

  /* ------------------------------ SSE -------------------------------- */

  function openSSE(ctx, extraHeaders = {}) {
    const res = ctx.res;
    if (res.headersSent) throw new Error('SSE stream already started');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(Number.isFinite(ctx.log.queueWaitMs) && ctx.log.queueWaitMs > 0
        ? { 'X-Duckai-Queue-Wait': String(Math.round(ctx.log.queueWaitMs)) }
        : {}),
      ...extraHeaders
    });
    res.flushHeaders?.();
    ctx.log.stream = true;

    let ended = false;
    const heartbeat = setInterval(() => {
      if (ended || res.writableEnded || res.destroyed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        ended = true;
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const writer = {
      get closed() {
        return ended || res.writableEnded || res.destroyed;
      },
      data(payload) {
        if (this.closed) return false;
        try {
          const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return res.write(`data: ${body}\n\n`);
        } catch {
          ended = true;
          return false;
        }
      },
      event(name, data) {
        if (this.closed) return false;
        try {
          return res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          ended = true;
          return false;
        }
      },
      comment(text) {
        if (this.closed) return false;
        try {
          return res.write(`: ${text}\n\n`);
        } catch {
          ended = true;
          return false;
        }
      },
      end() {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        try {
          if (!res.writableEnded && !res.destroyed) res.end();
        } catch {
          // ignore
        }
      }
    };
    ctx.streamWriter = writer;
    return writer;
  }

  /* ---------------------------- request ctx -------------------------- */

  function createRequestContext(req, res, pathname, url) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!controller.signal.aborted) controller.abort(new Error('client disconnected'));
    };
    req.on('aborted', abortUpstream);
    res.on('close', () => {
      if (!res.writableEnded) abortUpstream();
    });

    try {
      res.setHeader('X-Request-Id', requestId);
    } catch {
      // ignore
    }

    const ctx = {
      ...baseContext,
      req,
      res,
      url,
      pathname,
      method: req.method || 'GET',
      query: url.searchParams,
      body: null,
      signal: controller.signal,
      requestId,
      requestStartedAt: startedAt,
      sent: false,
      streamWriter: null,
      upstreamLogged: false,
      sessionKey: null,
      identityRoute: null,
      history,
      // v2.46：Responses API response chaining 存储（previous_response_id）
      responsesStore: options.responsesStore || null,
      // v2.31：查询身份额度时走同一代理
      usageFetch: proxy ? (url, init) => proxy.fetch(url, init) : null,
      log: {
        record: false,
        kind: 'none',
        source: 'v1',
        endpoint: '',
        model: null,
        stream: false,
        promptChars: 0,
        queueWaitMs: 0,
        identityId: null,
        identityLabel: null,
        sessionKey: null,
        contextTrimmed: false,
        upstreamStartedAt: null,
        error: null,
        errorDetail: null
      },
      /**
       * v2.4: resolve the identity for this request (session → identity).
       * Returns null when no pool is injected (v2.3 behaviour).
       */
      async selectIdentity(options = {}) {
        if (!identities) return null;
        const paidModel = options.paidModel === true;
        // v2.29：连接测试等场景允许在「已绑定非订阅身份 + 付费模型」时自动改绑到订阅身份，
        // 而不是直接 403（此前先绑定再请求，付费模型会被路由到 free 身份而失败）。
        const rebindOnSubscriptionMismatch = options.rebindPaid === true;
        const sessionKey = options.sessionKey !== undefined ? options.sessionKey : ctx.sessionKey;
        let routed;
        try {
          routed =
            typeof identities.routeDetailed === 'function'
              ? await identities.routeDetailed(sessionKey || null, { paidModel, rebindOnSubscriptionMismatch })
              : { identityId: await identities.route(sessionKey || null, { paidModel }), identity: null };
        } catch (error) {
          throw toOpenAIError(error);
        }
        const identityId = routed?.identityId ?? routed?.id ?? null;
        let summary = routed?.identity ?? null;
        if (!summary && identityId && typeof identities.get === 'function') {
          try {
            summary = await identities.get(identityId);
          } catch {
            summary = null;
          }
        }
        ctx.identityRoute = {
          identityId,
          label: summary?.label ?? null,
          bound: routed?.bound === true,
          strategy: routed?.strategy ?? null,
          // v2.29：是否因付费模型要求而被动改绑，以及原绑定身份
          rebound: routed?.rebound === true,
          reboundFrom: routed?.reboundFrom ?? null,
          paidModel
        };
        if (identityId) {
          ctx.log.identityId = identityId;
          ctx.log.identityLabel = summary?.label ?? null;
          try {
            if (!ctx.res.headersSent) {
              ctx.res.setHeader('X-Duckai-Identity-Id', identityId);
              if (summary?.label) ctx.res.setHeader('X-Duckai-Identity-Label', String(summary.label));
            }
          } catch {
            // headers already flushed (SSE) — logs still carry the identity
          }
        }
        return ctx.identityRoute;
      },
      /** Run one duck.ai upstream call, via the routed identity runtime when available. */
      async callUpstream(task, meta = {}) {
        if (typeof meta.model === 'string' && meta.model) ctx.log.model = meta.model;
        if (meta.source === 'admin-test') ctx.log.source = 'admin-test';
        ctx.log.upstreamStartedAt = Date.now();
        const invoke = (activeTask, runtimeInfo) => (activeTask.length >= 1 ? activeTask(runtimeInfo) : activeTask());
        const execute = async (activeTask) => {
          if (identities && ctx.identityRoute?.identityId) {
            return identities.run(
              ctx.identityRoute.identityId,
              async (runtime) => {
                ctx.log.queueWaitMs = Number.isFinite(runtime?.queueWaitMs) ? runtime.queueWaitMs : 0;
                const info = {
                  client: runtime?.client || ctx.duck,
                  identity: runtime?.identity ?? null,
                  identityId: runtime?.identityId ?? ctx.identityRoute.identityId,
                  store: runtime?.store ?? null
                };
                return invoke(activeTask, info);
              },
              { signal: ctx.signal }
            );
          }
          return queue.run(() => invoke(activeTask, null), {
            signal: ctx.signal,
            onStart: ({ queueWaitMs }) => {
              ctx.log.queueWaitMs = queueWaitMs;
            }
          });
        };
        try {
          return await execute(task);
        } catch (error) {
          const normalized = toOpenAIError(error);
          // v2.32：额度耗尽 → 标记身份冷却（临时禁用，绑定保持不变，后续请求按需改绑）
          await markIdentityCooldownFromError(ctx, error);
          // v2.21: 会话上限（409）不自动压缩/裁剪，交给调用方（客户端可先 POST /v1/compact）。
          if (normalized.code === 'conversation_limit_reached') {
            normalized.hint =
              '会话已达到 duck.ai 长度上限：请新建会话继续；或由客户端先调用 POST /v1/compact 生成摘要，再用摘要作 system prompt 重新发起请求。';
            ctx.log.error = normalized.message;
            throw normalized;
          }
          // v2.4 context guard: trim aggressively and retry once when enabled.
          if (
            typeof meta.onContextLimitRetry === 'function' &&
            ctx.config?.context?.onLimit !== 'error' &&
            isContextLimitError(normalized) &&
            normalized.code !== 'conversation_limit_reached'
          ) {
            try {
              const retryTask = await meta.onContextLimitRetry(normalized);
              if (typeof retryTask === 'function') {
                ctx.log.contextTrimmed = true;
                return await execute(retryTask);
              }
            } catch (retryError) {
              const retryNormalized = toOpenAIError(retryError);
              ctx.log.error = retryNormalized.message;
              throw retryError;
            }
          }
          ctx.log.error = normalized.message;
          if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
          throw error;
        }
      },
      /** Record a source="admin-test" upstream log entry (session test handler). */
      recordUpstream(entry = {}) {
        if (ctx.upstreamLogged) return;
        ctx.upstreamLogged = true;
        try {
          ctx.store.recordUpstream({
            source: 'admin-test',
            endpoint: entry.endpoint || ctx.log.endpoint,
            model: entry.model ?? ctx.log.model,
            status: entry.status ?? 500,
            latencyMs: entry.latencyMs ?? Math.max(0, Date.now() - (ctx.log.upstreamStartedAt || ctx.requestStartedAt)),
            queueWaitMs: entry.queueWaitMs ?? ctx.log.queueWaitMs,
            stream: entry.stream !== false,
            error: entry.error ?? null,
            errorDetail: entry.errorDetail ?? ctx.log.errorDetail ?? null,
            identityId: entry.identityId ?? ctx.log.identityId ?? null,
            identityLabel: entry.identityLabel ?? ctx.log.identityLabel ?? null,
            sessionKey: entry.sessionKey ?? ctx.log.sessionKey ?? ctx.sessionKey ?? null,
            requestId: ctx.requestId || null
          });
        } catch (error) {
          logger.warn?.('failed to record admin-test upstream log', { error: error.message });
        }
      },
      json(status, payload, headers = {}) {
        if (ctx.sent || res.writableEnded) return;
        ctx.sent = true;
        let body;
        try {
          body = Buffer.from(JSON.stringify(payload));
        } catch {
          body = Buffer.from('{"error":{"message":"response serialization failed","type":"server_error","code":null,"param":null}}');
          status = 500;
        }
        const queueWait = Number.isFinite(ctx.log.queueWaitMs) ? Math.round(ctx.log.queueWaitMs) : 0;
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          ...(queueWait > 0 ? { 'X-Duckai-Queue-Wait': String(queueWait) } : {}),
          ...headers
        });
        if (ctx.method === 'HEAD') res.end();
        else res.end(body);
      },
      text(status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
        if (ctx.sent || res.writableEnded) return;
        ctx.sent = true;
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        res.writeHead(status, {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          ...headers
        });
        if (ctx.method === 'HEAD') res.end();
        else res.end(buffer);
      },
      head(status, headers = {}) {
        if (ctx.sent || res.headersSent) return;
        ctx.sent = true;
        res.writeHead(status, headers);
        res.end();
      },
      openSSE(headers = {}) {
        return openSSE(ctx, headers);
      },
      sendError(error) {
        const normalized = toOpenAIError(error);
        ctx.log.error = normalized.message;
        if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
        if (res.headersSent) {
          if (ctx.streamWriter && !ctx.streamWriter.closed) {
            try {
              ctx.streamWriter.data(errorPayload(normalized));
              ctx.streamWriter.end();
            } catch {
              // ignore
            }
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {
              // ignore
            }
          }
          return;
        }
        if (normalized.status === 499) {
          try {
            res.statusCode = 499;
            res.end();
          } catch {
            // ignore
          }
          return;
        }
        ctx.json(normalized.status, errorPayload(normalized), normalized.headers || {});
      }
    };

    return ctx;
  }

  /**
   * v2.25：capture 端点的 CORS。只允许 duck.ai（浏览器在该页面执行书签）与本机来源，
   * 避免任意站点借用户浏览器写入订阅。
   */
  function applyCaptureCors(res, req) {
    const origin = String(req?.headers?.origin || '');
    const allowed =
      origin === 'https://duck.ai' ||
      origin === 'https://duckduckgo.com' ||
      origin === 'null' ||
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome 的 Private Network Access：从公网页面（duck.ai）请求 127.0.0.1 需要显式允许
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }

  function applyCors(res) {
    if (!config.server?.cors) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /* ------------------------------ auth ------------------------------- */

  /** v2: every /v1/* request requires a valid API key (managed or config-file). */
  function authorizeV1(ctx) {
    const token = extractBearerToken(ctx.req);
    if (!token) {
      throw unauthorized('Missing API key. Provide "Authorization: Bearer <api key>".', 'invalid_api_key');
    }
    const authorized =
      typeof ctx.store.isAuthorizedKey === 'function'
        ? ctx.store.isAuthorizedKey(token)
        : Boolean(ctx.store.findManagedKey?.(token));
    if (!authorized) {
      throw unauthorized('Incorrect API key provided.', 'invalid_api_key');
    }
    ctx.store.touchKey?.(token);
  }

  function authorizeAdmin(ctx) {
    let token = extractBearerToken(ctx.req);
    if (!token && ctx.method === 'GET') {
      const queryToken = ctx.query.get('token');
      if (queryToken) token = queryToken;
    }
    if (!token) {
      throw unauthorized(
        'Missing admin token. Provide "Authorization: Bearer <adminToken>" (or ?token= for GET).',
        'invalid_admin_token'
      );
    }
    if (!timingSafeEqualString(config.auth?.adminToken || '', token)) {
      throw unauthorized('Invalid admin token.', 'invalid_admin_token');
    }
  }

  /* ---------------------------- routing ------------------------------ */

  function requireMethod(ctx, allowed, allowHeader = null) {
    if (allowed.includes(ctx.method)) return;
    throw methodNotAllowed(ctx.method, allowHeader || allowed.join(', '));
  }

  async function dispatch(ctx) {
    const { pathname, method } = ctx;

    if (method === 'OPTIONS') {
      // v2.26：duck.ai 页面跨域 POST 到本机（capture）需要专用 CORS + Private Network Access
      if (pathname === '/admin/api/subscriptions/capture') {
        applyCaptureCors(ctx.res, ctx.req);
      } else {
        applyCors(ctx.res);
      }
      ctx.head(204);
      return;
    }

    applyCors(ctx.res);

    /* ------------------------------ public -------------------------- */
    if (pathname === '/healthz' || pathname === '/health') {
      requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
      const upstream = await getUpstreamHealth();
      let identityPool = null;
      if (identities && typeof identities.getSummary === 'function') {
        try {
          const summary = identities.getSummary() || {};
          let busy = 0;
          if (typeof identities.queueStats === 'function') {
            const queueStats = await identities.queueStats();
            busy = Number(queueStats?.totals?.inFlight) || 0;
          }
          identityPool = {
            total: summary.total ?? 0,
            enabled: summary.enabled ?? 0,
            subscribed: summary.subscribed ?? 0,
            busy
          };
        } catch {
          identityPool = null;
        }
      }
      ctx.json(200, {
        ok: true,
        service: SERVICE_NAME,
        version,
        uptimeSec: Math.round((Date.now() - serviceStartedAt) / 1000),
        upstream,
        proxy: await getProxyHealthSummary(ctx),
        identityPool,
        queue: queue.snapshot?.() || null
      });
      return;
    }

    if (pathname === '/') {
      requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
      ctx.text(200, renderIntroPage({ version, config }), 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/favicon.ico') {
      requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
      ctx.head(204);
      return;
    }

    /* --------------- public: subscription token capture ------------- */
    // v2.25：duck.ai 页面上的书签脚本会 POST 到这个端点（无 admin token），
    // 因此必须放在 admin 鉴权之前，并单独放开 CORS（仅允许 duck.ai / 本机来源）。
    if (pathname === '/admin/api/subscriptions/capture') {
      if (method === 'OPTIONS') {
        applyCaptureCors(ctx.res, ctx.req);
        ctx.head(204);
        return;
      }
      requireMethod(ctx, ['POST'], 'POST, OPTIONS');
      applyCaptureCors(ctx.res, ctx.req);
      ctx.log.record = false;
      const { handleSubscriptionCapture } = await import('../admin/subscriptions-routes.js');
      await handleSubscriptionCapture(ctx);
      return;
    }

    /* ---------------------------- admin API ------------------------- */
    if (pathname === '/admin/api' || pathname.startsWith('/admin/api/')) {
      ctx.log.record = true;
      ctx.log.kind = 'admin';
      const adminRoute = pathname.slice('/admin/api'.length) || '/';
      ctx.log.endpoint = `${method} /admin/api${adminRoute}`;
      authorizeAdmin(ctx);
      await handleAdminRequest(ctx, adminRoute, method);
      return;
    }

    /* ------------------------- admin static UI ---------------------- */
    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) {
      requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
      const relative = pathname === '/admin' || pathname === '/admin/' ? '' : pathname.slice('/admin/'.length);
      if (!relative) {
        await serveAdminIndex(ctx);
        return;
      }
      const filePath = resolveStaticPath(webDir, relative);
      if (filePath && (await serveStaticFile(ctx, filePath, { cacheControl: 'public, max-age=3600' }))) return;
      // SPA fallback for client-side routes (no file extension → index.html).
      if (!path.extname(relative) && !relative.startsWith('assets/')) {
        await serveAdminIndex(ctx);
        return;
      }
      ctx.text(404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }

    /* ------------------------------ OpenAI -------------------------- */
    if (pathname.startsWith('/v1/')) {
      ctx.log.record = true;
      ctx.log.kind = 'upstream';
      ctx.log.source = 'v1';
      ctx.log.endpoint = `${method} ${pathname}`;
      authorizeV1(ctx);

      if (pathname === '/v1/models') {
        requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
        ctx.log.endpoint = 'GET /v1/models';
        await handleListModels(ctx.req, ctx.res, ctx);
        return;
      }

      if (pathname.startsWith('/v1/models/')) {
        requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
        const modelId = decodeURIComponent(pathname.slice('/v1/models/'.length));
        const found = listModelsPayload(config).data.find((model) => model.id === modelId);
        if (!found) throw notFound(`Model "${modelId}" not found`, 'model_not_found');
        ctx.log.endpoint = 'GET /v1/models/:id';
        ctx.json(200, found);
        return;
      }

      if (pathname === '/v1/chat/completions') {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/chat/completions';
        await handleChatCompletions(ctx.req, ctx.res, ctx);
        return;
      }

      // v2.21: 客户端显式请求上下文压缩（429/409 后由调用方决定是否压缩）。
      if (pathname === '/v1/compact') {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/compact';
        await handleCompact(ctx.req, ctx.res, ctx);
        return;
      }

      if (pathname === '/v1/responses') {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/responses';
        await handleResponses(ctx.req, ctx.res, ctx);
        return;
      }

      if (pathname === '/v1/images/generations') {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/images/generations';
        await handleImagesGenerations(ctx.req, ctx.res, ctx);
        return;
      }

      throw notFound(`Unknown request URL: ${method} ${pathname}`);
    }

    ctx.text(404, 'Not found', 'text/plain; charset=utf-8');
  }

  /* --------------------------- http server --------------------------- */

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(errorPayload(badRequest('Malformed request URL'))));
      return;
    }

    const ctx = createRequestContext(req, res, url.pathname, url);

    let finished = false;
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (!ctx.log.record) return;
      const status = res.statusCode;
      const latencyMs = Date.now() - ctx.requestStartedAt;
      try {
        if (ctx.log.kind === 'upstream') {
          store.recordUpstream?.({
            source: 'v1',
            endpoint: ctx.log.endpoint,
            model: ctx.log.model,
            status,
            latencyMs,
            queueWaitMs: ctx.log.queueWaitMs,
            stream: ctx.log.stream,
            error: ctx.log.error,
            errorDetail: ctx.log.errorDetail,
            promptChars: ctx.log.promptChars,
            tokens: ctx.log.tokens ?? null,
            identityId: ctx.log.identityId ?? null,
            identityLabel: ctx.log.identityLabel ?? null,
            sessionKey: ctx.log.sessionKey ?? ctx.sessionKey ?? null,
            requestId: ctx.requestId || null
          });
        } else if (ctx.log.kind === 'admin') {
          store.recordAdmin?.({
            endpoint: ctx.log.endpoint,
            method: ctx.method,
            status,
            latencyMs,
            error: ctx.log.error
          });
        }
      } catch (error) {
        logger.warn?.('failed to record request log', { error: error.message });
      }
    };
    res.on('finish', finalize);
    res.on('close', finalize);

    (async () => {
      try {
        if (['POST', 'PUT', 'PATCH'].includes(ctx.method)) {
          ctx.body = await readJsonBody(req);
        }
        ctx.sessionKey = extractSessionKey(req, ctx.body);
        await dispatch(ctx);
        if (!ctx.sent && !res.headersSent) {
          ctx.head(204);
        }
      } catch (error) {
        const normalized = toOpenAIError(error);
        if (normalized.status !== 499) {
          logger.debug?.(`request failed: ${ctx.method} ${ctx.pathname}`, {
            status: normalized.status,
            message: normalized.message,
            code: normalized.code
          });
          // v2.31：500 时把栈打到 warn 日志，便于定位（此前只有 debug 一行 message）
          if (normalized.status >= 500) {
            logger.warn?.(`request 500: ${ctx.method} ${ctx.pathname}`, {
              message: normalized.message,
              stack: error && error.stack ? String(error.stack).split('\n').slice(0, 8).join(' | ') : null
            });
          }
        }
        ctx.sendError(error);
      }
    })();
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      } catch {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
    logger.debug?.('client error', { error: error?.message });
  });

  /** Graceful shutdown: stop accepting, close queue, flush sessions/store. */
  server.closeGracefully = async ({ timeoutMs = 5000 } = {}) => {
    try {
      queue.close?.();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore
        }
        done();
      }, timeoutMs);
      timer.unref?.();
      try {
        server.close(() => done());
      } catch {
        done();
      }
      try {
        server.closeIdleConnections?.();
      } catch {
        // ignore
      }
    });
    try {
      await sessions.flush?.();
    } catch (error) {
      logger.warn?.('sessions flush failed during shutdown', { error: error.message });
    }
    try {
      await store.flush?.();
    } catch (error) {
      logger.warn?.('store flush failed during shutdown', { error: error.message });
    }
  };

  server.serviceInfo = { name: SERVICE_NAME, version, startedAt: serviceStartedAt };
  server.getUpstreamHealth = getUpstreamHealth;
  server.queue = queue;
  server.sessions = sessions;
  server.identity = identity;
  server.proxy = proxy;
  server.identities = identities;
  server.pairing = pairing;
  server.syncDevices = syncDevices;
  return server;
}
