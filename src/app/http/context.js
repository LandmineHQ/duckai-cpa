/** Request context factory (Phase 1 split from src/http/server.js; behavior unchanged). */
import crypto from 'node:crypto';
import { errorPayload, toOpenAIError } from '../../openai/errors.js';
import { isContextLimitError } from '../../openai/context-guard.js';
import { sendError } from './errors.js';
import { openSSE } from './sse.js';

/**
 * @param {{
 *   baseContext: Record<string, any>,
 *   config: Record<string, any>,
 *   store: Record<string, any>,
 *   duck: Record<string, any>,
 *   queue: Record<string, any>,
 *   identities: Record<string, any>|null,
 *   history: Record<string, any>|null,
 *   responsesStore: Record<string, any>|null,
 *   proxy: Record<string, any>|null,
 *   logger: Record<string, any>,
 *   markIdentityCooldownFromError: (ctx: any, error: any) => Promise<void>
 * }} deps
 */
export function createRequestContextFactory(deps) {
  const { baseContext, config, store, duck, queue, identities, history, responsesStore, proxy, logger } = deps;

  return function createRequestContext(req, res, pathname, url) {
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
      responsesStore: responsesStore || null,
      // v2.31：查询身份额度时走同一代理
      usageFetch: proxy ? (targetUrl, init) => proxy.fetch(targetUrl, init) : null,
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
      async selectIdentity(options = {}) {
        if (!identities) return null;
        const paidModel = options.paidModel === true;
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
          await deps.markIdentityCooldownFromError(ctx, error);
          if (normalized.code === 'conversation_limit_reached') {
            normalized.hint =
              '会话已达到 duck.ai 长度上限：请新建会话继续；或由客户端先调用 POST /v1/compact 生成摘要，再用摘要作 system prompt 重新发起请求。';
            ctx.log.error = normalized.message;
            throw normalized;
          }
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
            requestId: ctx.requestId || null,
            clientTools: ctx.log.clientTools ?? null,
            protocolInjected: Boolean(ctx.log.protocolInjected),
            upstreamMessageCount: ctx.log.upstreamMessageCount ?? null,
            conversationChain: ctx.log.conversationChain ?? null
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
        return sendError(ctx, error);
      }
    };

    return ctx;
  };
}

export default { createRequestContextFactory };
