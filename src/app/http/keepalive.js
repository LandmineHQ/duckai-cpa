/**
 * CDN / 反代长连接保活工具（参考 bohrium-club-auto/internal/openai/stream_bridge.go）。
 *
 * 解决 Cloudflare (100s) / 阿里云 ESA (30s) 等链路在慢响应（长思考、工具缓冲、生图、PDF 生成）
 * 期间因无下行字节导致的 524/504 源站读超时：
 *   - 流式 SSE：见 src/app/http/sse.js，仅在空闲 >= intervalMs 时写 `: keepalive\n\n`；
 *   - 非流式 JSON（延迟提交设计）：
 *     1. 启动时只挂空闲定时器，不立即写 HTTP 200 头；
 *     2. 若上游在 < intervalMs 内快速结束（成功或抛出 400/502 等语义错误），定时器从未触发，
 *        网关保持正常 `Content-Length` 响应或精确的 HTTP 错误状态码；
 *     3. 一旦等待达到 intervalMs（说明上游确系慢生成，CDN 超时窗口临近），立即提交
 *        HTTP 200 + `Content-Type: application/json; charset=utf-8` + `X-Accel-Buffering: no`，
 *        并每 intervalMs 写入 1 个前导空格 `' '`（RFC 8259 合法 JSON 前导空白）；
 *     4. 若提交 200 后完成/失败，则一次性写出完整 JSON 或 OpenAI 错误 JSON。
 */
import { errorPayload } from '../../openai/errors.js';

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15000;

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

/**
 * @param {Record<string, any>} ctx
 * @param {{ intervalMs?: number }} [options]
 */
export function createNonStreamJsonKeepalive(ctx, options = {}) {
  const res = ctx.res;
  const intervalMs = Math.max(10, Number(options.intervalMs) || resolveKeepaliveIntervalMs(ctx.config));
  let armed = false;
  let committed = false;
  let stopped = false;
  let timer = null;
  let lastTickAt = 0;

  const clearTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
  };

  const commitAndPing = (extraHeaders = {}) => {
    if (stopped || ctx.sent || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    const now = Date.now();
    if (!committed) {
      if (res.headersSent) {
        stop();
        return;
      }
      if (now - lastTickAt < intervalMs) return;
      const queueWait = Number.isFinite(ctx.log?.queueWaitMs) ? Math.round(ctx.log.queueWaitMs) : 0;
      try {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
          ...(queueWait > 0 ? { 'X-Duckai-Queue-Wait': String(queueWait) } : {}),
          ...extraHeaders
        });
        res.flushHeaders?.();
        res.write(' ');
        committed = true;
        lastTickAt = now;
        ctx.log.stream = false;
      } catch {
        stop();
      }
      return;
    }
    if (now - lastTickAt < intervalMs) return;
    try {
      res.write(' ');
      lastTickAt = now;
    } catch {
      stop();
    }
  };

  const start = (extraHeaders = {}) => {
    if (armed || stopped) return armed;
    if (ctx.sent || res.headersSent || res.writableEnded || res.destroyed) {
      return false;
    }
    armed = true;
    lastTickAt = Date.now();
    const tickMs = Math.max(10, Math.min(intervalMs, 5000));
    timer = setInterval(() => commitAndPing(extraHeaders), tickMs);
    timer.unref?.();
    res.once?.('close', stop);
    return true;
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
    stop,
    finishJson,
    finishError
  };
}

export default {
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  resolveKeepaliveIntervalMs,
  createNonStreamJsonKeepalive
};
