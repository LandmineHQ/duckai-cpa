import { notFound } from '../../openai/errors.js';
import { requireMethod } from './helpers.js';

export async function handleHistory(ctx, parts, method, route) {
if (!ctx.history) {
  throw new OpenAIError('会话历史不可用（SQLite 未就绪）', {
    status: 503,
    type: 'server_error',
    code: 'history_unavailable'
  });
}
if (parts.length === 1) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const result = ctx.history.list({
    limit: Number(ctx.query.get('limit')) || 200,
    identityId: ctx.query.get('identityId') || null
  });
  ctx.json(200, { ok: true, ...result, stats: ctx.history.stats() });
  return;
}
const historyId = decodeURIComponent(parts[1]);
// v2.48：调试视图——查看该会话最近一次实际发给 duck.ai 的 upstream messages（脱敏）
if (parts.length === 3 && parts[2] === 'upstream') {
  requireMethod(ctx, ['GET', 'HEAD']);
  if (!ctx.responsesStore) {
    throw new OpenAIError('上游请求调试视图不可用（SQLite 未就绪）', {
      status: 503,
      type: 'server_error',
      code: 'responses_store_unavailable'
    });
  }
  const detail = ctx.history.get(historyId);
  if (!detail) throw notFound(`history "${historyId}" not found`, 'history_not_found');
  const sessionKey = detail.sessionKey || null;
  let source = null;
  let record = null;
  let updatedAt = null;
  if (sessionKey) {
    const conversation = await ctx.responsesStore.getConversation(sessionKey);
    const latest = await ctx.responsesStore.getLatestBySession(sessionKey);
    if (conversation && (!latest || (conversation.updatedAt || 0) >= (latest.createdAt || 0))) {
      source = 'conversation_state';
      record = conversation;
      updatedAt = conversation.updatedAt;
    } else if (latest) {
      source = 'response';
      record = latest;
      updatedAt = latest.createdAt;
    }
  }
  const redact = (value, depth = 0) => {
    if (depth > 8) return '[truncated depth]';
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) {
        const match = value.match(/^data:(image\/[^;]+);base64,/);
        return `[image data${match ? ` ${match[1]}` : ''}, ${value.length} chars]`;
      }
      return value.length > 20000 ? `${value.slice(0, 20000)}…(truncated)` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === 'b64') {
          out[key] = `[image data, ${String(item).length} chars]`;
          continue;
        }
        if (key === 'image' || key === 'dataUrl') {
          out[key] = redact(String(item), depth + 1);
          continue;
        }
        out[key] = redact(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  const messages = record
    ? source === 'conversation_state'
      ? record.upstream
      : record.upstream && record.upstream.length
        ? record.upstream
        : record.conversation
    : [];
  ctx.json(200, {
    ok: true,
    sessionKey,
    source,
    updatedAt,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    injection: detail.injection || null,
    messages: redact(messages)
  });
  return;
}
if (parts.length === 2) {
  if (ctx.method === 'DELETE') {
    const removed = ctx.history.remove(historyId);
    ctx.json(removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: { code: 'history_not_found' } });
    return;
  }
  requireMethod(ctx, ['GET', 'HEAD']);
  const detail = ctx.history.get(historyId);
  if (!detail) throw notFound(`history "${historyId}" not found`, 'history_not_found');
  ctx.json(200, { ok: true, item: detail });
  return;
}
throw notFound(`Unknown admin endpoint: ${method} ${route}`);
}

export default { handleHistory };
