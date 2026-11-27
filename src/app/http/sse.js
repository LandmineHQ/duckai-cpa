/**
 * SSE writer with idle-aware CDN keepalive (参考 bohrium-club-auto syncKeepaliveWriter).
 * 仅在流空闲达到 intervalMs 时发送 `: keepalive\n\n`，有正常输出时不插冗余心跳。
 * 支持 pre-header keepalive 已提交 SSE 头后的幂等复用。
 */
import { DEFAULT_KEEPALIVE_INTERVAL_MS, resolveKeepaliveIntervalMs } from './keepalive.js';

export const SSE_HEARTBEAT_MS = DEFAULT_KEEPALIVE_INTERVAL_MS;

export function openSSE(ctx, extraHeaders = {}, options = {}) {
  const res = ctx.res;
  if (options.streamMode) {
    ctx.streamMode = options.streamMode;
  }
  if (ctx.streamWriter && !ctx.streamWriter.closed) {
    return ctx.streamWriter;
  }
  if (res.headersSent) throw new Error('SSE stream already started');
  const intervalMs = Math.max(10, Number(options.intervalMs) || resolveKeepaliveIntervalMs(ctx.config));
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
  let lastWriteAt = Date.now();
  const tickMs = Math.max(10, Math.min(intervalMs, 5000));
  const heartbeat = setInterval(() => {
    if (ended || res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    const now = Date.now();
    if (now - lastWriteAt < intervalMs) return;
    try {
      res.write(': keepalive\n\n');
      lastWriteAt = now;
    } catch {
      ended = true;
      clearInterval(heartbeat);
    }
  }, tickMs);
  heartbeat.unref?.();

  const touch = () => {
    lastWriteAt = Date.now();
  };

  const writer = {
    get closed() {
      return ended || res.writableEnded || res.destroyed;
    },
    data(payload) {
      if (this.closed) return false;
      try {
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const ok = res.write(`data: ${body}\n\n`);
        touch();
        return ok;
      } catch {
        ended = true;
        return false;
      }
    },
    event(name, data) {
      if (this.closed) return false;
      try {
        const ok = res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        touch();
        return ok;
      } catch {
        ended = true;
        return false;
      }
    },
    comment(text) {
      if (this.closed) return false;
      try {
        const ok = res.write(`: ${text}\n\n`);
        touch();
        return ok;
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
  res.once?.('close', () => writer.end());
  ctx.streamWriter = writer;
  return writer;
}

export default { SSE_HEARTBEAT_MS, openSSE };
