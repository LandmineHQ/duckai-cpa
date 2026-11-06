import { badRequest } from '../../openai/errors.js';
import { methodNotAllowed, requireMethod } from './helpers.js';

function normalizeLogKind(ctx, { strict = false } = {}) {
  const raw = ctx.query.get('kind');
  if (raw === null || raw === '') return 'upstream';
  if (raw === 'upstream' || raw === 'admin') return raw;
  if (strict) throw badRequest('"kind" must be "upstream" or "admin"', 'kind', 'invalid_kind');
  return 'upstream';
}

async function handleLogsDownload(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const kind = normalizeLogKind(ctx, { strict: true });
  const formatRaw = (ctx.query.get('format') || 'jsonl').toLowerCase();
  const format = ['json', 'jsonl', 'csv'].includes(formatRaw) ? formatRaw : 'jsonl';
  const items = ctx.store.getLogs({ kind, limit: 20000, offset: 0 }).items;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `duckai-cpa-${kind}-logs-${ts}.${format === 'csv' ? 'csv' : format === 'json' ? 'json' : 'jsonl'}`;

  let body;
  if (format === 'json') {
    body = JSON.stringify({ kind, exportedAt: Date.now(), total: items.length, items }, null, 2);
  } else if (format === 'csv') {
    const columns =
      kind === 'upstream'
        ? ['ts', 'id', 'source', 'endpoint', 'model', 'status', 'latencyMs', 'queueWaitMs', 'stream', 'identityId', 'identityLabel', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'error']
        : ['ts', 'id', 'endpoint', 'method', 'status', 'latencyMs', 'error'];
    const escape = (value) => {
      const str = value === null || value === undefined ? '' : String(value);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows = items.map((item) => {
      const tokens = item.tokens || {};
      const record = { ...item, prompt_tokens: tokens.prompt, completion_tokens: tokens.completion, total_tokens: tokens.total };
      return columns.map((column) => escape(record[column])).join(',');
    });
    body = [columns.join(','), ...rows].join('\n');
  } else {
    body = items.map((item) => JSON.stringify(item)).join('\n');
  }

  const contentType =
    format === 'csv' ? 'text/csv; charset=utf-8' : format === 'json' ? 'application/json; charset=utf-8' : 'application/x-ndjson; charset=utf-8';
  ctx.text(200, body, contentType, {
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'X-Log-Count': String(items.length)
  });
}

async function handleLogsRetention(ctx) {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    ctx.json(200, ctx.store.getLogRetention());
    return;
  }
  if (ctx.method !== 'PUT' && ctx.method !== 'POST') throw methodNotAllowed(ctx, 'GET, PUT');
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const maxEntries = Number(body.maxEntries);
  const maxAgeDays = Number(body.maxAgeDays);
  if (!Number.isFinite(maxEntries) && !Number.isFinite(maxAgeDays)) {
    throw badRequest('至少需要提供 maxEntries 或 maxAgeDays', 'maxEntries', 'invalid_log_retention');
  }
  if (Number.isFinite(maxEntries) && (maxEntries < 10 || maxEntries > 20000)) {
    throw badRequest('maxEntries 需在 10–20000 之间', 'maxEntries', 'invalid_log_retention');
  }
  if (Number.isFinite(maxAgeDays) && (maxAgeDays < 0 || maxAgeDays > 365)) {
    throw badRequest('maxAgeDays 需在 0–365 之间（0 = 不按时间淘汰）', 'maxAgeDays', 'invalid_log_retention');
  }
  const result = ctx.store.setLogRetention({
    ...(Number.isFinite(maxEntries) ? { maxEntries } : {}),
    ...(Number.isFinite(maxAgeDays) ? { maxAgeDays } : {})
  });
  if (!ctx.config.logging || typeof ctx.config.logging !== 'object') ctx.config.logging = {};
  ctx.config.logging.maxEntries = result.maxEntries;
  ctx.config.logging.maxAgeDays = result.maxAgeDays;
  await ctx.store.saveConfig(ctx.config);
  ctx.json(200, result);
}

async function handleUsage(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const model = ctx.query.get('model');
  const identityId = ctx.query.get('identityId') || ctx.query.get('identity');
  ctx.json(200, ctx.store.getUsage({ model, identityId }));
}

async function handleLogs(ctx) {
  if (ctx.method === 'DELETE') {
    const kind = normalizeLogKind(ctx, { strict: true });
    ctx.json(200, ctx.store.clearLogs(kind));
    return;
  }
  requireMethod(ctx, ['GET', 'HEAD']);
  const kind = normalizeLogKind(ctx, { strict: true });
  const limit = Number.parseInt(ctx.query.get('limit') ?? '50', 10);
  const offset = Number.parseInt(ctx.query.get('offset') ?? '0', 10);
  ctx.json(
    200,
    ctx.store.getLogs({
      kind,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0
    })
  );
}

export { handleLogs, handleLogsDownload, handleLogsRetention, handleUsage };
export default { handleLogs, handleLogsDownload, handleLogsRetention, handleUsage };
