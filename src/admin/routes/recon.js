/**
 * Admin API for frontend recon (/admin/api/recon/*).
 *   GET  /admin/api/recon/status
 *   POST /admin/api/recon/pull
 *   POST /admin/api/recon/diff
 */
import path from 'node:path';
import { compareLive, DEFAULT_BASE_URL, DEFAULT_OUT_DIR, getReconStatus, takeSnapshot } from '../../recon/snapshot.js';
import { notFound, OpenAIError } from '../../openai/errors.js';
import { requireMethod } from './helpers.js';

function resolveReconOptions(ctx) {
  const outDir = ctx.reconOutDir || path.join(ctx.store?.dataDir || path.dirname(DEFAULT_OUT_DIR), 'recon', 'duckai-web');
  const baseUrl = ctx.config?.duck?.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl =
    typeof ctx.reconFetch === 'function'
      ? ctx.reconFetch
      : typeof ctx.usageFetch === 'function'
        ? ctx.usageFetch
        : typeof ctx.proxy?.fetch === 'function'
          ? (url, init) => ctx.proxy.fetch(url, init)
          : fetch;
  return { outDir, baseUrl, fetchImpl, tolerant: true };
}

export async function handleRecon(ctx, parts, method, route) {
  const options = resolveReconOptions(ctx);

  if (parts.length === 2 && parts[1] === 'status') {
    requireMethod(ctx, ['GET', 'HEAD']);
    const status = await getReconStatus(options);
    ctx.json(200, { ok: true, ...status });
    return;
  }

  if (parts.length === 2 && parts[1] === 'pull') {
    requireMethod(ctx, ['POST']);
    try {
      const manifest = await takeSnapshot(
        { ...options, onEntryAccepted: () => ctx.beginJsonKeepalive?.() },
        { write: true }
      );
      const status = await getReconStatus(options);
      ctx.json(200, { ok: true, pulled: true, ...status, manifestSummary: { truncated: manifest.truncated, skippedMediaCount: manifest.skippedMediaCount } });
    } catch (error) {
      throw new OpenAIError(`Recon 拉取失败: ${error?.message || 'unknown error'}`, {
        status: 502,
        type: 'upstream_error',
        code: 'recon_pull_failed'
      });
    }
    return;
  }

  if (parts.length === 2 && parts[1] === 'diff') {
    requireMethod(ctx, ['POST']);
    try {
      const diff = await compareLive({
        ...options,
        onEntryAccepted: () => ctx.beginJsonKeepalive?.()
      });
      ctx.json(200, { ok: true, ...diff });
    } catch (error) {
      throw new OpenAIError(`Recon 对比失败: ${error?.message || 'unknown error'}`, {
        status: 502,
        type: 'upstream_error',
        code: 'recon_diff_failed'
      });
    }
    return;
  }

  throw notFound(`Unknown admin endpoint: ${method} ${route}`);
}

export default { handleRecon };
