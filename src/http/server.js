/**
 * HTTP server composition root for duckai-cpa v2 (pure node:http).
 *
 * Phase 1（v2.64）：HTTP 核心已拆分到 src/app/http/*，本文件保留 createServer 组合根：
 *   - 依赖装配（queue/sessions/identity/proxy/history...）
 *   - 路由 dispatch（业务 handler 不变）
 *   - 请求日志 / graceful shutdown / 对外导出
 * 路径、鉴权、状态码、错误码、SSE 事件顺序、响应头与请求体限制保持 v2.63 行为不变。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  notFound,
  toOpenAIError
} from '../openai/errors.js';
import { handleListModels, listModelsPayload } from '../openai/models.js';
import { handleChatCompletions } from '../openai/chat.js';
import { handleCompact } from '../openai/compact.js';
import { handleResponses } from '../openai/responses.js';
import { handleImagesGenerations } from '../openai/images.js';
import { handleAdminRequest } from '../admin/routes.js';
import { createUpstreamQueue } from '../upstream/queue.js';
import { createSessionsStore } from '../admin/sessions.js';
import { PROJECT_ROOT } from '../config.js';
import { createNullLogger } from '../logger.js';
import { readJsonBody } from '../app/http/body.js';
import { authorizeAdmin, authorizeV1 } from '../app/http/auth.js';
import { applyCaptureCors, applyCors } from '../app/http/cors.js';
import { writeMalformedUrlResponse } from '../app/http/errors.js';
import { handleFavicon, handleHealthz, handleRoot, requireMethod } from '../app/http/router.js';
import { resolveStaticPath, serveAdminIndex, serveStaticFile } from '../app/http/static.js';
import { createRequestContextFactory } from '../app/http/context.js';

const SERVICE_NAME = 'duckai-cpa';

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
  const envVersion = typeof process.env.DUCKAI_CPA_VERSION === 'string' ? process.env.DUCKAI_CPA_VERSION.trim() : '';
  if (envVersion) return envVersion.slice(0, 100);
  return getPackageMeta().version || '0.1.0';
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

  // v2.2: explicit identityStore injection (see docs/IDENTITY-SYNC.md).
  const identity = options.identity || null;
  // v2.3: explicit ProxyManager injection (docs/PROXY.md).
  const proxy = options.proxy || null;
  // v2.4: identity pool (docs/IDENTITY-POOL.md).
  const identities = options.identities || options.identityPool || null;
  // v2.5: pairing host service (docs/PAIRING-IMPL.md).
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

  // v2.54：会话级稳定标识（用于历史/PDF，不影响身份绑定）。Codex 等客户端可能只发 prompt_cache_key。
  function extractConversationKey(req, body) {
    for (const name of ['x-session-id', 'x-conversation-id', 'x-conversation']) {
      const value = req.headers[name];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const field of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'prompt_cache_key']) {
        const value = body[field];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
      }
      for (const field of ['metadata', 'extra_body']) {
        const nested = body[field];
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const value = nested.session_id ?? nested.sessionId ?? nested.conversation_id ?? nested.prompt_cache_key;
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

  const createRequestContext = createRequestContextFactory({
    baseContext,
    config,
    store,
    duck,
    queue,
    identities,
    history,
    responsesStore: options.responsesStore || null,
    proxy,
    logger,
    markIdentityCooldownFromError
  });

  /* ---------------------------- routing ------------------------------ */

  async function dispatch(ctx) {
    const { pathname, method } = ctx;

    if (method === 'OPTIONS') {
      // v2.26：duck.ai 页面跨域 POST 到本机（capture）需要专用 CORS + Private Network Access
      if (pathname === '/admin/api/subscriptions/capture') {
        applyCaptureCors(ctx.res, ctx.req);
      } else {
        applyCors(ctx.res, config);
      }
      ctx.head(204);
      return;
    }

    applyCors(ctx.res, config);

    /* ------------------------------ public -------------------------- */
    if (pathname === '/healthz' || pathname === '/health') {
      await handleHealthz(ctx, {
        serviceName: SERVICE_NAME,
        version,
        serviceStartedAt,
        getUpstreamHealth,
        identities,
        queue
      });
      return;
    }

    if (pathname === '/') {
      handleRoot(ctx, { version, config });
      return;
    }
    if (pathname === '/favicon.ico') {
      handleFavicon(ctx);
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
      authorizeAdmin(ctx, config);
      await handleAdminRequest(ctx, adminRoute, method);
      return;
    }

    /* ------------------------- admin static UI ---------------------- */
    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) {
      requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
      const relative = pathname === '/admin' || pathname === '/admin/' ? '' : pathname.slice('/admin/'.length);
      if (!relative) {
        await serveAdminIndex(ctx, { webDir, serviceName: SERVICE_NAME });
        return;
      }
      const filePath = resolveStaticPath(webDir, relative);
      if (filePath && (await serveStaticFile(ctx, filePath, { cacheControl: 'public, max-age=3600' }))) return;
      // SPA fallback for client-side routes (no file extension → index.html).
      if (!path.extname(relative) && !relative.startsWith('assets/')) {
        await serveAdminIndex(ctx, { webDir, serviceName: SERVICE_NAME });
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
      writeMalformedUrlResponse(res);
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
            requestId: ctx.requestId || null,
            clientTools: ctx.log.clientTools ?? null,
            protocolInjected: Boolean(ctx.log.protocolInjected),
            upstreamMessageCount: ctx.log.upstreamMessageCount ?? null,
            conversationChain: ctx.log.conversationChain ?? null
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
        ctx.conversationKey = extractConversationKey(req, ctx.body);
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
