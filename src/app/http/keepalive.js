/**
 * CDN / 反代长连接保活工具（对齐 bohrium-club-auto/internal/openai/stream_bridge.go）。
 *
 * 解决 Cloudflare (100s) / Nginx (60s) / 阿里云 ESA (30s) 等链路在慢响应期间因无下行字节导致的
 * 524/504 源站读超时（含队列排队、x-vqd-hash-1 求解、大上下文 Prefill、长思考、工具缓冲、生图）：
 *   - **流式 SSE（pre-header + idle-aware）**：
 *     1. 请求进入上游等待前挂载延迟定时器（默认 preHeaderKeepaliveDelayMs = 8000ms，0 = 禁用）；
 *     2. 若 < delayMs 内快速成功或抛出 400/403/429 等错误，保留精确 HTTP 状态码与首字节前重试能力；
 *     3. 一旦等待超过 delayMs 仍未收到响应头，立即提交 HTTP 200 SSE 响应头并发送首个 `: keepalive\n\n`；
 *     4. 后续在真实流式输出期间，仅当空闲 >= keepaliveIntervalMs（默认 10000ms）时补发 `: keepalive\n\n`。
 *   - **非流式 JSON（pre-header + 延迟提交空白保活）**：
 *     1. 启动后按 `preHeaderDelayMs`（默认 8000ms）与 `onUpstreamAccepted` 后的 `intervalMs`（默认 10000ms）
 *        的更早截止时间触发首次 HTTP 200 提交 + 前导空格 `' '`；
 *     2. 在截止前快速返回的语义/认证/限流错误，仍完整保留原始 HTTP 状态码；
 *     3. 一旦进入保活窗口，每 `intervalMs` 写 1 个 RFC 8259 合法前导空格 `' '`，完成/出错时再写出完整 JSON。
 */
import { errorPayload } from '../../openai/errors.js';

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 10000;
export const DEFAULT_PRE_HEADER_KEEPALIVE_DELAY_MS = 8000;

export function resolveKeepaliveIntervalMs(config) {
  const configured = Number(config?.http?.keepaliveIntervalMs);
  if (Number.isFinite(configured) && configured >= 10) {
    return Math.trunc(configured);
  }
  const envValue = Number(process.env.DUCKAI_KEEPALIVE_MS);
  if (Number.isFinite(envValue) && envValue >= 10) {
    return Math.trunc(envValue);
  }
  return DEFAULT_KEEPALIVE_INTERVAL_MS;
}

export function resolvePreHeaderKeepaliveDelayMs(config) {
  const raw = config?.http?.preHeaderKeepaliveDelayMs;
  if (raw !== undefined && raw !== null && raw !== '') {
    const configured = Number(raw);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.trunc(configured);
    }
  }
  const envRaw = process.env.DUCKAI_PRE_HEADER_KEEPALIVE_MS;
  if (envRaw !== undefined && envRaw !== '') {
    const envValue = Number(envRaw);
    if (Number.isFinite(envValue) && envValue >= 0) {
      return Math.trunc(envValue);
    }
  }
  return DEFAULT_PRE_HEADER_KEEPALIVE_DELAY_MS;
}

/**
 * 非流式 JSON 延迟提交保活管理器（支持 pre-header 阶段 + accepted 阶段两段 deadline）。
 *
 * @param {Record<string, any>} ctx
 * @param {{ intervalMs?: number, preHeaderDelayMs?: number }} [options]
 */
export function createNonStreamJsonKeepalive(ctx, options = {}) {
  const res = ctx.res;
  const intervalMs = Math.max(10, Number(options.intervalMs) || resolveKeepaliveIntervalMs(ctx.config));
  const preHeaderDelayMs =
    options.preHeaderDelayMs !== undefined
      ? Math.max(0, Number(options.preHeaderDelayMs) || 0)
      : resolvePreHeaderKeepaliveDelayMs(ctx.config);

  let armed = false;
  let accepted = false;
  let committed = false;
  let stopped = false;
  let armedAt = 0;
  let acceptedAt = 0;
  let commitTimer = null;
  let pingTimer = null;
  let savedHeaders = {};

  const clearTimers = () => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const onAbort = () => stop();
  const onClose = () => stop();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimers();
    res.off?.('close', onClose);
    ctx.signal?.removeEventListener?.('abort', onAbort);
  }

  const writePing = () => {
    if (stopped || ctx.sent || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    try {
      res.write(' ');
    } catch {
      stop();
    }
  };

  const commit = () => {
    commitTimer = null;
    if (stopped || committed || ctx.sent || res.headersSent || res.writableEnded || res.destroyed) {
      if (stopped || ctx.sent || res.writableEnded || res.destroyed) stop();
      return;
    }
    const queueWait = Number.isFinite(ctx.log?.queueWaitMs) ? Math.round(ctx.log.queueWaitMs) : 0;
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        ...(queueWait > 0 ? { 'X-Duckai-Queue-Wait': String(queueWait) } : {}),
        ...savedHeaders
      });
      res.flushHeaders?.();
      res.write(' ');
      committed = true;
      ctx.log.stream = false;
      pingTimer = setInterval(writePing, intervalMs);
      pingTimer.unref?.();
    } catch {
      stop();
    }
  };

  const scheduleCommit = () => {
    if (stopped || committed || !armed) return;
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    const preDeadline = preHeaderDelayMs > 0 ? armedAt + preHeaderDelayMs : Infinity;
    const postDeadline = accepted ? acceptedAt + intervalMs : Infinity;
    const deadline = Math.min(preDeadline, postDeadline);
    if (!Number.isFinite(deadline)) return;
    const waitMs = Math.max(0, deadline - Date.now());
    commitTimer = setTimeout(commit, waitMs);
    commitTimer.unref?.();
  };

  const start = (extraHeaders = {}) => {
    if (armed || stopped) return armed;
    if (ctx.sent || res.headersSent || res.writableEnded || res.destroyed) {
      return false;
    }
    armed = true;
    armedAt = Date.now();
    savedHeaders = extraHeaders && typeof extraHeaders === 'object' ? { ...extraHeaders } : {};
    res.once?.('close', onClose);
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    scheduleCommit();
    return true;
  };

  const markAccepted = () => {
    if (stopped || accepted) return;
    accepted = true;
    acceptedAt = Date.now();
    if (armed && !committed) {
      scheduleCommit();
    }
  };

  const finishJson = (payload) => {
    stop();
    if (ctx.sent || res.writableEnded || res.destroyed) return false;
    ctx.sent = true;
    let body;
    try {
      body = Buffer.from(JSON.stringify(payload));
    } catch {
      body = Buffer.from(
        '{"error":{"message":"response serialization failed","type":"server_error","code":"serialization_failed","param":null}}'
      );
    }
    try {
      if (ctx.method === 'HEAD') res.end();
      else res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  const finishError = (normalizedError) => {
    stop();
    if (ctx.sent || res.writableEnded || res.destroyed) return false;
    ctx.sent = true;
    const envelope = errorPayload(normalizedError);
    let body;
    try {
      body = Buffer.from(JSON.stringify(envelope));
    } catch {
      body = Buffer.from('{"error":{"message":"internal error","type":"server_error","code":null,"param":null}}');
    }
    try {
      if (ctx.method === 'HEAD') res.end();
      else res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  return {
    get armed() {
      return armed;
    },
    get accepted() {
      return accepted;
    },
    get committed() {
      return committed;
    },
    // `started` 仅在真正写出 HTTP 200 头后才为 true，保证快速错误保留准确 HTTP 状态码
    get started() {
      return committed;
    },
    get active() {
      return armed && !stopped;
    },
    start,
    markAccepted,
    stop,
    finishJson,
    finishError
  };
}

/**
 * 流式 SSE Pre-Header 保活器：
 * 等待 upstream 返回前的慢阶段达到 delayMs 时提前打开 SSE 并写出首条 `: keepalive\n\n`。
 *
 * @param {Record<string, any>} ctx
 * @param {{ delayMs?: number, intervalMs?: number, headers?: Record<string, string>, streamMode?: string }} [options]
 */
export function createPreHeaderSSEKeepalive(ctx, options = {}) {
  const res = ctx.res;
  const delayMs =
    options.delayMs !== undefined
      ? Math.max(0, Number(options.delayMs) || 0)
      : resolvePreHeaderKeepaliveDelayMs(ctx.config);
  const intervalMs = Math.max(10, Number(options.intervalMs) || resolveKeepaliveIntervalMs(ctx.config));
  const headers = options.headers && typeof options.headers === 'object' ? options.headers : {};
  const streamMode = options.streamMode || null;
  const openSseImpl = options.openSSE;

  if (
    typeof openSseImpl !== 'function' ||
    delayMs <= 0 ||
    ctx.sent ||
    res.headersSent ||
    res.writableEnded ||
    res.destroyed ||
    ctx.signal?.aborted
  ) {
    return {
      get committed() {
        return false;
      },
      stop() {
        return false;
      }
    };
  }

  let committed = false;
  let stopped = false;
  let timer = null;

  const onAbort = () => stop();
  const onClose = () => stop();

  function stop() {
    if (!stopped) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      res.off?.('close', onClose);
      ctx.signal?.removeEventListener?.('abort', onAbort);
    }
    return committed;
  }

  timer = setTimeout(() => {
    timer = null;
    if (stopped || ctx.sent || res.headersSent || res.writableEnded || res.destroyed || ctx.signal?.aborted) {
      return;
    }
    try {
      const writer = openSseImpl(ctx, headers, { intervalMs, streamMode });
      writer.comment('keepalive');
      committed = true;
    } catch {
      stop();
    }
  }, delayMs);
  timer.unref?.();
  res.once?.('close', onClose);
  ctx.signal?.addEventListener?.('abort', onAbort, { once: true });

  return {
    get committed() {
      return committed;
    },
    stop
  };
}

export default {
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_PRE_HEADER_KEEPALIVE_DELAY_MS,
  resolveKeepaliveIntervalMs,
  resolvePreHeaderKeepaliveDelayMs,
  createNonStreamJsonKeepalive,
  createPreHeaderSSEKeepalive
};
