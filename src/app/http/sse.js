/** SSE writer/heartbeat (Phase 1 split; event order unchanged). */
export const SSE_HEARTBEAT_MS = 15000;

export function openSSE(ctx, extraHeaders = {}) {
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

export default { SSE_HEARTBEAT_MS, openSSE };
