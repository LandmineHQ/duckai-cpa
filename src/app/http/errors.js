/** Error envelope / SSE error handling (Phase 1 split; behavior unchanged). */
import { badRequest, errorPayload, toOpenAIError } from '../../openai/errors.js';

export function sendError(ctx, error) {
  const normalized = toOpenAIError(error);
  ctx.log.error = normalized.message;
  if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
  const { res } = ctx;
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

/** Malformed request URL (before ctx exists): same 400 JSON envelope as before. */
export function writeMalformedUrlResponse(res) {
  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(errorPayload(badRequest('Malformed request URL'))));
}

export default { sendError, writeMalformedUrlResponse };
