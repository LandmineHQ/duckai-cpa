/** Error envelope / SSE error handling (Phase 1 split; supports pre-header committed streams). */
import { badRequest, errorPayload, genId, nowSec, toOpenAIError } from '../../openai/errors.js';

export function sendError(ctx, error) {
  ctx.preHeaderKeepalive?.stop?.();
  ctx.jsonKeepalive?.stop?.();
  const normalized = toOpenAIError(error);
  ctx.log.error = normalized.message;
  ctx.log.status = normalized.status;
  if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
  const { res } = ctx;
  if (res.headersSent) {
    if (ctx.jsonKeepalive?.started) {
      ctx.jsonKeepalive.finishError(normalized);
      return;
    }
    if (ctx.streamWriter && !ctx.streamWriter.closed) {
      try {
        if (ctx.streamMode === 'responses') {
          const ts = nowSec();
          const errDetail = {
            code: normalized.code || normalized.type,
            message: normalized.message
          };
          ctx.streamWriter.event('response.failed', {
            type: 'response.failed',
            sequence_number: 0,
            response: {
              id: genId('resp_'),
              object: 'response',
              created_at: ts,
              status: 'failed',
              error: errDetail,
              incomplete_details: null,
              output: [],
              output_text: '',
              model: ctx.log?.model || ''
            }
          });
          ctx.streamWriter.event('error', {
            type: 'error',
            sequence_number: 1,
            code: normalized.code || normalized.type,
            message: normalized.message,
            param: normalized.param ?? null
          });
        } else if (ctx.streamMode === 'admin-session') {
          ctx.streamWriter.data({
            type: 'error',
            message: normalized.message,
            code: normalized.code ?? null,
            status: normalized.status
          });
        } else {
          ctx.streamWriter.data(errorPayload(normalized));
          ctx.streamWriter.data('[DONE]');
        }
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
