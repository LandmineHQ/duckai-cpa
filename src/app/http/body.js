/** HTTP body parsing (Phase 1 split from src/http/server.js; behavior unchanged). */
import { badRequest, payloadTooLarge } from '../../openai/errors.js';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function readJsonBody(req) {
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

export default { MAX_BODY_BYTES, readJsonBody };
