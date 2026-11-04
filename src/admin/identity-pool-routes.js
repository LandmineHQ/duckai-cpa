/**
 * Admin API v2.4: identity pool (docs/IDENTITY-POOL.md §5).
 *
 * The pool itself is duck-protocol's `src/duck/identity-pool.js`, injected as
 * `createServer({ identities })`. This module only validates/shapes HTTP I/O.
 */

import { OpenAIError, toOpenAIError } from '../openai/errors.js';

const IDENTITY_POOL_UNAVAILABLE = () =>
  new OpenAIError('Identity pool is not available: duck-protocol src/duck/identity-pool.js was not initialized', {
    status: 503,
    type: 'identity_pool_unavailable',
    code: 'identity_pool_unavailable'
  });

function requireMethod(ctx, allowed) {
  const methods = Array.isArray(allowed) ? allowed : [allowed];
  if (methods.includes(ctx.method)) return;
  throw Object.assign(new Error(`Method ${ctx.method} not allowed`), {
    status: 405,
    code: 'method_not_allowed',
    headers: { Allow: methods.join(', ') }
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPool(ctx) {
  if (!ctx.identities) throw IDENTITY_POOL_UNAVAILABLE();
  return ctx.identities;
}

async function callPool(ctx, fn) {
  try {
    return await fn(getPool(ctx));
  } catch (error) {
    throw toOpenAIError(error);
  }
}

function invalidPool(message, field = null) {
  return new OpenAIError(message, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_identity',
    param: field
  });
}

function normalizeLimit(value, fallback = 50, max = 500) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.trunc(number));
}

/** ctx.query is a URLSearchParams in src/http/server.js; tolerate plain objects in tests. */
function queryValue(ctx, key) {
  const query = ctx.query;
  if (!query) return undefined;
  if (typeof query.get === 'function') {
    const value = query.get(key);
    return value === null ? undefined : value;
  }
  return query[key];
}

function sanitizeSummary(summary) {
  if (!isPlainObject(summary)) return null;
  return summary;
}

/** duck pool.get() is synchronous; tolerate both sync and async implementations. */
async function safeGetIdentity(pool, id) {
  try {
    return await pool.get(id);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleListIdentities(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const pool = getPool(ctx);
  return callPool(ctx, async () => {
    const [summary, items, bindingCount] = await Promise.all([
      Promise.resolve(pool.getSummary?.() || {}),
      Promise.resolve(pool.list?.() || []),
      typeof pool.listBindings === 'function'
        ? Promise.resolve(pool.listBindings({ limit: 1 }))
            .then((result) => (result && result.total) || 0)
            .catch(() => null)
        : null
    ]);
    ctx.json(200, {
      pool: {
        total: summary.total ?? items.length,
        enabled: summary.enabled ?? items.filter((item) => item.enabled).length,
        subscribed: summary.subscribed ?? items.filter((item) => item.subscribed).length,
        activeId: summary.activeId ?? null,
        bindingCount: bindingCount ?? summary.bindingCount ?? 0,
        maxIdentities: summary.maxIdentities ?? ctx.config?.pool?.maxIdentities ?? null
      },
      items: items.map(sanitizeSummary).filter(Boolean)
    });
  });
}

async function handleCreateIdentity(ctx) {
  requireMethod(ctx, ['POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 100) : undefined;
  return callPool(ctx, async (pool) => {
    let identity;
    if (body.import !== undefined || body.identity !== undefined || body.doc !== undefined) {
      const doc = body.import ?? body.identity ?? body.doc;
      identity = await pool.importIdentity(doc, label ? { label } : undefined);
    } else {
      identity = await pool.create(label ? { label } : {});
    }
    ctx.json(201, { identity });
  });
}

async function handleGenerateIdentities(ctx) {
  requireMethod(ctx, ['POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const count = Number(body.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw invalidPool('"count" must be an integer 1-20', 'count');
  const labelPrefix =
    typeof body.labelPrefix === 'string' && body.labelPrefix.trim()
      ? body.labelPrefix.trim().slice(0, 80)
      : undefined;
  return callPool(ctx, async (pool) => {
    const items = await pool.generate({
      count,
      ...(labelPrefix ? { labelPrefix } : {}),
      subscribed: body.subscribed === true
    });
    ctx.json(200, { items: items.map(sanitizeSummary).filter(Boolean) });
  });
}

async function handleGetIdentity(ctx, id) {
  requireMethod(ctx, ['GET', 'HEAD']);
  return callPool(ctx, async (pool) => {
    ctx.json(200, { identity: await pool.get(id) });
  });
}

async function handlePatchIdentity(ctx, id) {
  requireMethod(ctx, ['PATCH', 'PUT', 'POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const patch = {};
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.length > 100) throw invalidPool('"label" must be a string (max 100)', 'label');
    patch.label = body.label.trim();
  }
  for (const field of ['enabled', 'subscribed']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'boolean') throw invalidPool(`"${field}" must be a boolean`, field);
      patch[field] = body[field];
    }
  }
  if (body.deviceName !== undefined) {
    if (typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.trim().length > 100) {
      throw invalidPool('"deviceName" must be a non-empty string (max 100)', 'deviceName');
    }
    patch.deviceName = body.deviceName.trim();
  }
  if (Object.keys(patch).length === 0) throw invalidPool('no updatable fields provided');
  const forceQuery = queryValue(ctx, 'force');
  const force =
    body.force === true ||
    forceQuery === true ||
    ['true', '1', 'yes'].includes(String(forceQuery || '').toLowerCase());
  return callPool(ctx, async (pool) => {
    const info = await safeGetIdentity(pool, id);
    if (patch.enabled === false && ctx.syncDevices?.isIdentityInSlots) {
      const inSlots = await ctx.syncDevices.isIdentityInSlots(id);
      if (inSlots && !force) {
        const error = new OpenAIError('identity is used by DuckDuckGo device slots', {
          status: 409,
          type: 'invalid_request_error',
          code: 'identity_in_device_slots',
          hint: '该身份在设备列表中，请先在设备列表移除后再禁用（或使用 ?force=true）'
        });
        error.identityId = id;
        if (info?.deviceName) error.deviceName = info.deviceName;
        throw toOpenAIError(error);
      }
      if (inSlots && force) {
        await ctx.syncDevices.removeIdentityFromSlots(id, { logout: true }).catch(() => null);
      }
    }
    const identity = await pool.update(id, patch);
    ctx.json(200, { identity, ...(force && patch.enabled === false ? { removedDevice: true } : {}) });
  });
}

async function handleDeleteIdentity(ctx, id) {
  requireMethod(ctx, ['DELETE']);
  const forceRaw = queryValue(ctx, 'force');
  const force = forceRaw === true || forceRaw === 1 || ['true', '1', 'yes'].includes(String(forceRaw || '').toLowerCase());
  return callPool(ctx, async (pool) => {
    // v2.9: the default identity is protected (it holds the pairing key account).
    let defaultId = 'id_default';
    if (typeof pool.getDefaultIdentityId === 'function') {
      defaultId = (await pool.getDefaultIdentityId()) || defaultId;
    } else {
      const summary = pool.getSummary?.() || {};
      defaultId = summary.activeId || defaultId;
    }
    if (id === defaultId) {
      const error = new OpenAIError('the default identity cannot be deleted', {
        status: 409,
        type: 'invalid_request_error',
        code: 'default_identity_protected',
        hint: '默认身份用于获取手机配对 key，不能删除；可禁用其他身份或先切换默认身份'
      });
      error.identityId = id;
      throw toOpenAIError(error);
    }
    const info = await safeGetIdentity(pool, id);
    // v2.27：绑定了订阅的身份不允许直接删除（等价于「退出登录」必须先解绑）
    if (info?.subscriptionId) {
      if (!force) {
        const error = new OpenAIError('identity has a bound subscription', {
          status: 409,
          type: 'invalid_request_error',
          code: 'identity_has_subscription',
          hint: '该身份绑定了订阅：请先解绑订阅（相当于在 duck.ai 退出登录）后再删除，或使用 ?force=true 强制解绑并删除'
        });
        error.identityId = id;
        error.subscriptionId = info.subscriptionId;
        if (info?.deviceName) error.deviceName = info.deviceName;
        error.subscriptionTier = info.subscriptionTier || null;
        error.subscriptionLabel = info.subscriptionLabel || null;
        throw toOpenAIError(error);
      }
      try {
        await pool.clearSubscription(id);
      } catch (error) {
        ctx.logger?.warn?.('failed to unbind subscription before deleting identity', { error: error.message });
      }
    }
    let removedDevice = false;
    if (ctx.syncDevices?.isIdentityInSlots) {
      const inSlots = await ctx.syncDevices.isIdentityInSlots(id);
      if (inSlots && !force) {
        const error = new OpenAIError('identity is used by DuckDuckGo device slots', {
          status: 409,
          type: 'invalid_request_error',
          code: 'identity_in_device_slots',
          hint: '该身份在 DuckDuckGo 设备列表中，请先在设备列表移除后再删除（或使用 ?force=true）'
        });
        error.identityId = id;
        if (info?.deviceName) error.deviceName = info.deviceName;
        throw toOpenAIError(error);
      }
      if (inSlots && force) {
        const removed = await ctx.syncDevices
          .removeIdentityFromSlots(id, { logout: true })
          .catch(() => null);
        removedDevice = Boolean(removed?.removed);
      }
    }
    await pool.delete(id, { force });
    // Defence-in-depth: drop any remaining slot references after deletion.
    try {
      await ctx.syncDevices?.cleanupSlotsForIdentity?.(id);
    } catch {
      // best-effort
    }
    ctx.json(200, { ok: true, id, ...(removedDevice ? { removedDevice: true } : {}) });
  });
}

async function handleActivateIdentity(ctx, id) {
  requireMethod(ctx, ['POST']);
  return callPool(ctx, async (pool) => {
    await pool.activate(id);
    ctx.json(200, { ok: true, pool: (await pool.getSummary?.()) || null });
  });
}

async function handleRotateIdentity(ctx, id) {
  requireMethod(ctx, ['POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const scope = body.scope ?? 'all';
  if (!['journey', 'device', 'all'].includes(scope)) throw invalidPool('"scope" must be journey|device|all', 'scope');
  return callPool(ctx, async (pool) => {
    await pool.rotate(id, scope);
    ctx.json(200, {
      ok: true,
      identity: await pool.get(id),
      identityLost: true,
      note: '轮换会丢弃当前 journeyId/durableStream 密钥，旧身份无法恢复'
    });
  });
}

async function handleExportIdentity(ctx, id) {
  requireMethod(ctx, ['GET', 'HEAD']);
  return callPool(ctx, async (pool) => {
    const doc = await pool.exportIdentity(id);
    const payload = isPlainObject(doc) && isPlainObject(doc.identity) ? doc : { identity: doc };
    const body = JSON.stringify(
      { version: 1, exportedAt: Date.now(), id, ...payload },
      null,
      2
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="duckai-pool-identity-${id}-${stamp}.json"`,
      'Cache-Control': 'no-store'
    });
    ctx.res.end(body);
  });
}

async function handleSubscription(ctx, id) {
  return callPool(ctx, async (pool) => {
    if (ctx.method === 'POST' || ctx.method === 'PUT') {
      const body = isPlainObject(ctx.body) ? ctx.body : {};
      // v2.15: bind an existing subscription entity (selector in the UI) …
      if (typeof body.subscriptionId === 'string' && body.subscriptionId) {
        if (!ctx.subscriptions) {
          throw new OpenAIError('Subscription store is not available', {
            status: 503,
            type: 'subscription_store_unavailable',
            code: 'subscription_store_unavailable'
          });
        }
        const raw = await ctx.subscriptions.getRaw(body.subscriptionId);
        if (!raw) throw invalidPool('subscription not found', 'subscriptionId');
        const summary = await pool.bindSubscriptionToIdentity(id, body.subscriptionId, raw);
        ctx.json(200, { ok: true, identity: summary, subscriptionId: body.subscriptionId, subscription: summary?.subscriptionTier ? { tier: summary.subscriptionTier, label: summary.subscriptionLabel } : null });
        return;
      }
      // … and keep the legacy raw-token binding working.
      const token = body.token;
      if (typeof token !== 'string' || !token.trim()) throw invalidPool('"subscriptionId" or "token" is required', 'token');
      const result = await pool.bindSubscription(id, token);
      const identity = result?.identity ?? result;
      ctx.json(200, { ok: true, identity, subscription: result?.subscription ?? identity?.auth ?? null });
      return;
    }
    if (ctx.method === 'DELETE') {
      const result = await pool.clearSubscription(id);
      const identity = result?.identity ?? result;
      ctx.json(200, { ok: true, identity, subscription: result?.subscription ?? identity?.auth ?? null });
      return;
    }
    requireMethod(ctx, ['POST', 'PUT', 'DELETE']);
  });
}

async function handleListBindings(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const limit = normalizeLimit(queryValue(ctx, 'limit'), 50, 500);
  const offset = Math.max(0, Math.trunc(Number(queryValue(ctx, 'offset')) || 0));
  const sessionKey = typeof queryValue(ctx, 'sessionKey') === 'string' ? queryValue(ctx, 'sessionKey') : undefined;
  return callPool(ctx, async (pool) => {
    const result = (await pool.listBindings({ limit, offset, ...(sessionKey ? { sessionKey } : {}) })) || {};
    const items = Array.isArray(result.items) ? result.items : Array.isArray(result) ? result : [];
    ctx.json(200, {
      items: items.map((binding) =>
        isPlainObject(binding)
          ? binding
          : { sessionKey: String(binding), identityId: result.items?.[binding] ?? null }
      ),
      total: Number.isFinite(result.total) ? result.total : items.length
    });
  });
}

async function handleCreateBinding(ctx) {
  requireMethod(ctx, ['POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
  const identityId = typeof body.identityId === 'string' ? body.identityId.trim() : '';
  if (!sessionKey) throw invalidPool('"sessionKey" is required', 'sessionKey');
  if (!identityId) throw invalidPool('"identityId" is required', 'identityId');
  return callPool(ctx, async (pool) => {
    const binding = await pool.bind(sessionKey, identityId);
    ctx.json(200, {
      binding: isPlainObject(binding)
        ? binding
        : { sessionKey, identityId, createdAt: Date.now(), updatedAt: Date.now() }
    });
  });
}

async function handleDeleteBinding(ctx, sessionKey) {
  requireMethod(ctx, ['DELETE']);
  const key = decodeURIComponent(sessionKey || '');
  if (!key) throw invalidPool('sessionKey is required');
  return callPool(ctx, async (pool) => {
    await pool.unbind(key);
    ctx.json(200, { ok: true, sessionKey: key });
  });
}

/**
 * v2.30 GET/PUT /admin/api/identities/settings
 * 会话绑定缓存（TTL 天数，0=永不过期）+ 当前绑定数量。
 */
/** 额度缓存（identityId → { at, data }），60 秒有效。 */
const usageCache = new Map();
const USAGE_TTL_MS = 60 * 1000;

/** 把 status 响应里的 fixedCostWindowUsage 归一化成展示结构。 */
function normalizeUsageWindows(payload) {
  const windows = payload && payload.fixedCostWindowUsage && Array.isArray(payload.fixedCostWindowUsage.windows)
    ? payload.fixedCostWindowUsage.windows
    : [];
  const labels = { six_hours: '6 小时限额', day: '每日限额', iso_week: '每周限额', month: '每月限额' };
  return windows
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      label: labels[item.id] || item.id,
      percentUsed: Number.isFinite(Number(item.percentUsed)) ? Math.max(0, Number(item.percentUsed)) : 0,
      resetAt: typeof item.resetAt === 'string' ? item.resetAt : null,
      isBlocked: item.isBlocked === true,
      isBypassable: item.isBypassable === true
    }));
}

/**
 * GET /admin/api/identities/usage
 * 返回每个身份的额度窗口（仅订阅身份可查；free 身份 supported=false）。
 */
async function handleIdentityUsage(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const refresh = queryValue(ctx, 'refresh') === '1' || queryValue(ctx, 'refresh') === 'true';
  return callPool(ctx, async (pool) => {
    const items = typeof pool.list === 'function' ? await pool.list() : [];
    const list = Array.isArray(items) ? items : items.items || [];
    const results = [];
    for (const identity of list) {
      const identityId = identity.id;
      const cacheKey = identityId;
      const cached = usageCache.get(cacheKey);
      if (!refresh && cached && Date.now() - cached.at < USAGE_TTL_MS) {
        results.push(cached.data);
        continue;
      }
      const subscribed = identity.subscribed === true || Boolean(identity.subscriptionId);
      if (!subscribed) {
        const data = { identityId, supported: false, reason: 'free_identity', windows: [] };
        usageCache.set(cacheKey, { at: Date.now(), data });
        results.push(data);
        continue;
      }
      const token =
        typeof pool.getIdentityToken === 'function' ? await pool.getIdentityToken(identityId) : null;
      if (!token) {
        const data = { identityId, supported: false, reason: 'no_token', windows: [] };
        usageCache.set(cacheKey, { at: Date.now(), data });
        results.push(data);
        continue;
      }
      try {
        const { fetchIdentityUsage } = await import('../duck/usage.js');
        const usage = await fetchIdentityUsage({ token, fetchImpl: ctx.usageFetch || null });
        const data = { identityId, supported: usage.supported, windows: usage.windows, fetchedAt: Date.now() };
        usageCache.set(cacheKey, { at: Date.now(), data });
        results.push(data);
      } catch (error) {
        const data = {
          identityId,
          supported: false,
          reason: 'fetch_failed',
          error: String(error?.message || error).slice(0, 200),
          windows: []
        };
        usageCache.set(cacheKey, { at: Date.now(), data });
        results.push(data);
      }
    }
    ctx.json(200, { ok: true, items: results, ttlMs: USAGE_TTL_MS });
  });
}

async function handlePoolSettings(ctx) {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    return callPool(ctx, async (pool) => {
      const settings = typeof pool.getSettings === 'function' ? await pool.getSettings() : {};
      const poolConfig = ctx.config?.pool || {};
      ctx.json(200, {
        ok: true,
        ...settings,
        bindingsLimit: poolConfig.bindingsLimit ?? null,
        strategy: poolConfig.strategy || null
      });
    });
  }
  if (ctx.method === 'PUT' || ctx.method === 'POST' || ctx.method === 'PATCH') {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const raw = Number(body.bindingTtlDays);
    if (!Number.isFinite(raw) || raw < 0 || raw > 365) {
      throw invalidPool('"bindingTtlDays" must be an integer between 0 and 365', 'bindingTtlDays');
    }
    const days = Math.min(365, Math.floor(raw));
    return callPool(ctx, async (pool) => {
      // 直接改运行时配置并持久化（与 PUT /admin/api/config 等价，但只允许这一个字段）
      if (!ctx.config.pool) ctx.config.pool = {};
      ctx.config.pool.bindingTtlDays = days;
      try {
        await ctx.store?.saveConfig?.(ctx.config);
      } catch (error) {
        ctx.logger?.warn?.('failed to persist pool.bindingTtlDays', { error: error.message });
      }
      const settings = typeof pool.getSettings === 'function' ? await pool.getSettings() : {};
      ctx.json(200, { ok: true, ...settings, bindingTtlDays: days });
    });
  }
  return requireMethod(ctx, ['GET', 'PUT']);
}

async function handleRouting(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  return callPool(ctx, async (pool) => {
    if (typeof pool.getRouting === 'function') {
      const routing = await pool.getRouting();
      ctx.json(200, {
        strategy: routing?.strategy ?? ctx.config?.pool?.strategy ?? 'hash',
        saltPresent: routing?.saltPresent !== false,
        perIdentity: Array.isArray(routing?.perIdentity) ? routing.perIdentity : [],
        totals: routing?.totals ?? { waiting: 0, inFlight: 0, rps: 1 }
      });
      return;
    }
    const router = (typeof pool.getRouter === 'function' ? await pool.getRouter() : null) || {};
    const queueStats = (typeof pool.queueStats === 'function' ? await pool.queueStats() : null) || {};
    const totals = queueStats.totals || { waiting: 0, inFlight: 0, rps: ctx.config?.pool?.queueLimit ?? null };
    const perIdentity = Object.entries(queueStats.byIdentity || {}).map(([id, queue]) => ({
      id,
      waiting: queue.waiting ?? 0,
      inFlight: queue.inFlight ?? 0,
      requests: queue.requests ?? 0
    }));
    ctx.json(200, {
      strategy: router.strategy ?? ctx.config?.pool?.strategy ?? 'hash',
      saltPresent: router.saltPresent !== false,
      perIdentity,
      totals
    });
  });
}

async function handleRouter(ctx) {
  requireMethod(ctx, ['PATCH', 'PUT', 'POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const strategy = body.strategy;
  if (!['hash', 'least-loaded'].includes(strategy)) {
    throw invalidPool('"strategy" must be hash|least-loaded', 'strategy');
  }
  if (body.salt !== undefined && (typeof body.salt !== 'string' || !body.salt.trim())) {
    throw invalidPool('"salt" must be a non-empty string', 'salt');
  }
  return callPool(ctx, async (pool) => {
    const result = await pool.setRouter({ strategy, ...(body.salt ? { salt: body.salt } : {}) });
    const routing =
      result ??
      (typeof pool.getRouting === 'function' ? await pool.getRouting() : null) ??
      (typeof pool.getRouter === 'function' ? await pool.getRouter() : null) ?? { strategy };
    ctx.json(200, { ok: true, routing });
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export async function handleIdentityPoolRoutes(ctx, parts, method) {
  void method;
  const action = parts[1] || '';
  const id = parts[2] && !['bindings', 'routing', 'router', 'generate'].includes(parts[2]) ? decodeURIComponent(parts[2]) : null;

  if (!action) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') return handleListIdentities(ctx);
    if (ctx.method === 'POST') return handleCreateIdentity(ctx);
    return requireMethod(ctx, ['GET', 'POST']);
  }
  if (action === 'generate') return handleGenerateIdentities(ctx);
  if (action === 'bindings') {
    if (!parts[2]) {
      if (ctx.method === 'GET' || ctx.method === 'HEAD') return handleListBindings(ctx);
      if (ctx.method === 'POST') return handleCreateBinding(ctx);
      return requireMethod(ctx, ['GET', 'POST']);
    }
    return handleDeleteBinding(ctx, parts[2]);
  }
  // v2.30：会话绑定缓存设置（TTL 天数）
  if (action === 'settings') return handlePoolSettings(ctx);
  // v2.31：身份额度（付费身份可查 /duckchat/v1/status 的 fixedCostWindowUsage）
  if (action === 'usage') return handleIdentityUsage(ctx);
  if (action === 'routing') return handleRouting(ctx);
  if (action === 'router') return handleRouter(ctx);

  const identityId = decodeURIComponent(action);
  if (!parts[2]) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') return handleGetIdentity(ctx, identityId);
    if (ctx.method === 'PATCH' || ctx.method === 'PUT') return handlePatchIdentity(ctx, identityId);
    if (ctx.method === 'DELETE') return handleDeleteIdentity(ctx, identityId);
    return requireMethod(ctx, ['GET', 'PATCH', 'DELETE']);
  }
  const sub = parts[2];
  if (sub === 'activate') return handleActivateIdentity(ctx, identityId);
  if (sub === 'rotate') return handleRotateIdentity(ctx, identityId);
  if (sub === 'export') return handleExportIdentity(ctx, identityId);
  // v2.32：额度冷却（临时禁用）
  if (sub === 'cooldown') {
    requireMethod(ctx, ['DELETE', 'POST']);
    return callPool(ctx, async (pool) => {
      if (typeof pool.clearCooldown !== 'function') {
        throw invalidPool('cooldown is not supported', 'cooldown');
      }
      const result = await pool.clearCooldown(identityId);
      ctx.json(200, { ok: true, ...result });
    });
  }
  if (sub === 'subscription') return handleSubscription(ctx, identityId);
  void id;
  throw Object.assign(new Error(`Unknown identity pool endpoint: ${ctx.method} ${ctx.pathname}`), {
    status: 404,
    code: 'not_found'
  });
}
