import { adminCatalogItems } from '../../openai/models.js';
import { requireMethod } from './helpers.js';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

async function handleOverview(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const upstream = await ctx.getUpstreamHealth();
  const stats = ctx.store.getStats();
  const queue = ctx.queue?.snapshot?.() || null;
  const rateLimited =
    typeof upstream.rateLimited === 'boolean'
      ? upstream.rateLimited
      : Boolean(stats.upstream.lastRateLimitAt && Date.now() - stats.upstream.lastRateLimitAt < RATE_LIMIT_WINDOW_MS);

  let identities = null;
  if (ctx.identities) {
    try {
      const summary = ctx.identities.getSummary?.() || {};
      const items = (await ctx.identities.list?.()) || [];
      identities = {
        pool: {
          total: summary.total ?? items.length,
          enabled: summary.enabled ?? items.filter((item) => item.enabled).length,
          subscribed: summary.subscribed ?? items.filter((item) => item.subscribed).length,
          activeId: summary.activeId ?? null,
          bindingCount: summary.bindingCount ?? 0,
          maxIdentities: summary.maxIdentities ?? ctx.config?.pool?.maxIdentities ?? null
        },
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          enabled: item.enabled === true,
          subscribed: item.subscribed === true,
          journeyId: item.journeyId ?? null,
          fingerprint: item.fingerprint ?? null,
          sessions: item.sessions ?? 0,
          requests: item.requests ?? 0,
          queue: item.queue || { waiting: 0, inFlight: 0, rps: 1 }
        }))
      };
    } catch {
      identities = null;
    }
  }

  ctx.json(200, {
    service: {
      name: 'duckai-cpa',
      version: ctx.version,
      uptimeSec: Math.round((Date.now() - ctx.serviceStartedAt) / 1000)
    },
    upstream: { ...upstream, rateLimited, queue },
    identities,
    stats,
    models: adminCatalogItems(ctx.config),
    // v2.24：token 消耗总览（分模型 / 分身份×模型）+ 日志保留策略
    tokens: typeof ctx.store.getUsage === 'function' ? ctx.store.getUsage() : null,
    logRetention: typeof ctx.store.getLogRetention === 'function' ? ctx.store.getLogRetention() : null,
    recentUpstream: ctx.store.getLogs({ kind: 'upstream', limit: 10 }).items,
    recentAdmin: ctx.store.getLogs({ kind: 'admin', limit: 10 }).items
  });
}

async function handleHealth(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const upstream = await ctx.getUpstreamHealth();
  ctx.json(200, {
    ok: true,
    upstream: {
      ok: upstream.ok === true,
      challengeOk: upstream.challengeOk === true,
      ...(upstream.version ? { version: upstream.version } : {}),
      ...(upstream.rateLimited !== undefined ? { rateLimited: upstream.rateLimited } : {})
    },
    queue: ctx.queue?.snapshot?.() || null,
    version: ctx.version
  });
}

export { handleOverview, handleHealth };
export default { handleOverview, handleHealth };
