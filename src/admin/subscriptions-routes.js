/**
 * Admin API v2.15: first-class subscriptions (docs/ADMIN_API_V2.md §21).
 *
 *   GET    /admin/api/subscriptions               → { items, total }
 *   POST   /admin/api/subscriptions               → { subscription, duplicate }
 *   PATCH  /admin/api/subscriptions/:id           → { subscription }
 *   DELETE /admin/api/subscriptions/:id           → { ok, removed, unbound }
 *   POST   /admin/api/subscriptions/:id/verify    → { subscription }
 *
 * The store lives in `src/admin/subscriptions.js` (data/subscriptions.json, 0600) and never
 * returns the plaintext token. Identities reference a subscription by `subscriptionId`, so one
 * subscription can power many anonymous identities/devices.
 */

import { OpenAIError, toOpenAIError } from '../openai/errors.js';
import {
  createLoginSession,
  getLoginSession,
  cancelLoginSession,
  completeLoginSession,
  failLoginSession,
  normalizeTokenInput
} from './subscription-login.js';

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

function requireStore(ctx) {
  if (!ctx.subscriptions) {
    throw new OpenAIError('Subscription store is not available', {
      status: 503,
      type: 'subscription_store_unavailable',
      code: 'subscription_store_unavailable'
    });
  }
  return ctx.subscriptions;
}

function translated(fn) {
  return async () => {
    try {
      return await fn();
    } catch (error) {
      if (error && typeof error.status === 'number' && typeof error.code === 'string') {
        throw new OpenAIError(error.message, {
          status: error.status === 201 ? 200 : error.status,
          type: error.status === 404 ? 'not_found_error' : 'invalid_request_error',
          code: error.code,
          param: error.field || null
        });
      }
      throw toOpenAIError(error);
    }
  };
}

function boundIdentities(ctx, subscriptionId) {
  const pool = ctx.identities;
  if (!pool || typeof pool.list !== 'function') return [];
  try {
    return (pool.list() || [])
      .filter((item) => item && item.subscriptionId === subscriptionId)
      .map((item) => ({ id: item.id, label: item.label, deviceName: item.deviceName || null }));
  } catch {
    return [];
  }
}

function withBindings(ctx, subscription) {
  const bound = boundIdentities(ctx, subscription.id);
  return { ...subscription, bindingCount: bound.length, boundIdentities: bound };
}

/** v2.28：capture 的默认订阅名 = 本地绑定时间（MM-DD HH:mm），便于区分多次绑定。 */
function defaultLoginLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `绑定 ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * v2.25 免复制登录会话的「捕获端点」：由 duck.ai 页面的书签脚本调用（无需 admin token）。
 * 只接受一次性 sessionId + 有效期内的 token；写入订阅后立刻让会话变成 completed。
 */
export async function handleSubscriptionCapture(ctx) {
  requireMethod(ctx, ['POST']);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  // v2.26：允许直接粘贴 {"access_token": "..."} 或 Bearer xxx
  const token = normalizeTokenInput(body.token);
  if (!sessionId) {
    throw new OpenAIError('sessionId is required', {
      status: 400,
      type: 'invalid_request_error',
      code: 'session_required',
      param: 'sessionId'
    });
  }
  const session = getLoginSession(sessionId);
  if (!session) {
    throw new OpenAIError('登录会话不存在或已过期', {
      status: 404,
      type: 'not_found_error',
      code: 'login_session_not_found'
    });
  }
  if (session.status !== 'waiting') {
    throw new OpenAIError(`登录会话状态为 ${session.status}，无法再次提交`, {
      status: 409,
      type: 'invalid_request_error',
      code: 'login_session_not_pending'
    });
  }
  if (!token) {
    throw new OpenAIError('token is required', {
      status: 400,
      type: 'invalid_request_error',
      code: 'token_required',
      param: 'token'
    });
  }
  const store = requireStore(ctx);
  try {
    // v2.28：默认名称用绑定时间，便于区分同一账号的多次绑定
    const result = await store.add({ token, label: defaultLoginLabel(), source: 'login' });
    const subscription = withBindings(ctx, result.subscription);
    completeLoginSession(sessionId, {
      subscriptionId: subscription.id,
      tier: subscription.tier,
      email: subscription.email || null
    });
    ctx.json(200, { ok: true, duplicate: result.duplicate === true, subscription });
  } catch (error) {
    failLoginSession(sessionId, {
      code: error?.code || 'token_invalid',
      message: error?.message || 'token 绑定失败'
    });
    if (error && typeof error.status === 'number' && typeof error.code === 'string') {
      throw new OpenAIError(error.message, {
        status: error.status,
        type: 'invalid_request_error',
        code: error.code,
        param: error.field || null
      });
    }
    throw toOpenAIError(error);
  }
}

/** v2.25：创建/查询/取消「免复制登录」会话（需要 admin token）。 */
export async function handleSubscriptionLoginSession(ctx, parts) {
  const id = parts[0] || '';
  if (!id) {
    requireMethod(ctx, ['POST']);
    const origin =
      typeof ctx.body?.origin === 'string' && ctx.body.origin.trim()
        ? ctx.body.origin.trim()
        : `http://${ctx.req.headers.host || '127.0.0.1:8787'}`;
    ctx.json(200, createLoginSession({ origin }));
    return;
  }
  const session = getLoginSession(id);
  if (!session) {
    throw new OpenAIError('登录会话不存在或已过期', {
      status: 404,
      type: 'not_found_error',
      code: 'login_session_not_found'
    });
  }
  if (ctx.method === 'DELETE') {
    ctx.json(200, cancelLoginSession(id));
    return;
  }
  requireMethod(ctx, ['GET', 'HEAD']);
  ctx.json(200, session);
}

export async function handleSubscriptionRoutes(ctx, parts, method) {
  void method;
  const store = requireStore(ctx);
  // v2.25：/admin/api/subscriptions/login-session[...]
  if (parts[1] === 'login-session') {
    return handleSubscriptionLoginSession(ctx, parts.slice(2));
  }
  const id = parts[1] || '';
  const action = parts[2] || '';

  if (!id) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      return translated(async () => {
        const items = (await store.list()).map((item) => withBindings(ctx, item));
        ctx.json(200, { items, total: items.length });
      })();
    }
    requireMethod(ctx, ['POST']);
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    return translated(async () => {
      const result = await store.add({ token: normalizeTokenInput(body.token), label: body.label });
      const subscription = withBindings(ctx, result.subscription);
      ctx.json(result.duplicate ? 200 : 201, { ok: true, subscription, duplicate: result.duplicate === true });
    })();
  }

  if (action === 'verify') {
    requireMethod(ctx, ['POST']);
    return translated(async () => {
      const subscription = await store.verify(id);
      ctx.json(200, { ok: true, subscription: withBindings(ctx, subscription) });
    })();
  }

  /* ------------------- v2.27 自动续期（refresh token） ------------------- */
  if (action === 'refresh-token') {
    if (ctx.method === 'POST' || ctx.method === 'PUT') {
      const body = isPlainObject(ctx.body) ? ctx.body : {};
      return translated(async () => {
        const subscription = await store.setRefreshToken(id, body.refreshToken ?? body.token);
        ctx.json(200, { ok: true, subscription: withBindings(ctx, subscription) });
      })();
    }
    if (ctx.method === 'DELETE') {
      return translated(async () => {
        const subscription = await store.clearRefreshToken(id);
        ctx.json(200, { ok: true, subscription: withBindings(ctx, subscription) });
      })();
    }
    requireMethod(ctx, ['POST', 'PUT', 'DELETE']);
  }

  if (action === 'refresh') {
    requireMethod(ctx, ['POST']);
    return translated(async () => {
      const result = await store.refreshAccessToken(id, { force: ctx.query.get('force') !== 'false' });
      // 刷新后同步到绑定了该订阅的身份（identity.auth 存的是 token 快照）
      try {
        if (result?.raw && ctx.identities?.syncSubscriptionToken) {
          await ctx.identities.syncSubscriptionToken(id, result.raw);
        }
      } catch (error) {
        ctx.logger?.warn?.('failed to sync refreshed token to identities', { error: error.message });
      }
      ctx.json(200, {
        ok: true,
        refreshed: result?.refreshed === true,
        reason: result?.reason || null,
        rotatedRefreshToken: result?.rotatedRefreshToken === true,
        subscription: withBindings(ctx, result.subscription)
      });
    })();
  }

  if (action) {
    throw new OpenAIError(`Unknown subscriptions endpoint: ${ctx.method} ${parts.join('/')}`, {
      status: 404,
      type: 'not_found_error',
      code: 'not_found'
    });
  }

  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    return translated(async () => {
      const subscription = await store.get(id);
      if (!subscription) {
        throw new OpenAIError(`subscription "${id}" not found`, {
          status: 404,
          type: 'not_found_error',
          code: 'subscription_not_found'
        });
      }
      ctx.json(200, { subscription: withBindings(ctx, subscription) });
    })();
  }
  if (ctx.method === 'PATCH' || ctx.method === 'PUT') {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    return translated(async () => {
      const subscription = await store.updateLabel(id, body.label);
      ctx.json(200, { ok: true, subscription: withBindings(ctx, subscription) });
    })();
  }
  if (ctx.method === 'DELETE') {
    return translated(async () => {
      const pool = ctx.identities;
      const boundIds = pool && typeof pool.identitiesBoundToSubscription === 'function'
        ? pool.identitiesBoundToSubscription(id)
        : [];
      const result = await store.remove(id);
      if (!result.removed) {
        throw new OpenAIError(`subscription "${id}" not found`, {
          status: 404,
          type: 'not_found_error',
          code: 'subscription_not_found'
        });
      }
      // Unbind every identity that referenced it (entity is gone; identities stay usable/free).
      for (const identityId of boundIds) {
        try {
          await pool.unbindIdentitySubscription(identityId);
        } catch {
          // best effort: a stale identity id must not block deleting the subscription
        }
      }
      ctx.json(200, { ok: true, removed: true, unbound: boundIds.length, subscription: result.subscription });
    })();
  }
  requireMethod(ctx, ['GET', 'PATCH', 'DELETE']);
}
