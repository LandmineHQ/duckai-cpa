/**
 * Admin API v2.3: proxy configuration, status, live apply and connection test.
 *
 * Contract: docs/PROXY.md §3. The actual dispatching is owned by duck-protocol's
 * `src/duck/proxy.js` ProxyManager (injected through `createServer({ proxy })`);
 * this module validates/shapes HTTP responses and persists config updates.
 */

import { OpenAIError, badRequest } from '../openai/errors.js';
import { PROXY_TYPES, applyConfigPatch } from '../config.js';

const PROXY_FIELDS = new Set([
  'enabled',
  'type',
  'host',
  'port',
  'username',
  'password',
  'noProxy',
  'testUrl',
  'ipCheckUrl'
]);

const TEST_OVERRIDE_FIELDS = new Set([
  'type',
  'host',
  'port',
  'username',
  'password',
  'noProxy',
  'testUrl',
  'ipCheckUrl'
]);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function requireMethod(ctx, allowed) {
  const methods = Array.isArray(allowed) ? allowed : [allowed];
  if (methods.includes(ctx.method)) return;
  const error = Object.assign(new Error(`Method ${ctx.method} not allowed`), {
    status: 405,
    code: 'method_not_allowed',
    headers: { Allow: methods.join(', ') }
  });
  throw error;
}

function proxyUnavailable() {
  return new OpenAIError(
    'Proxy manager is not available: duck-protocol src/duck/proxy.js was not initialized',
    {
      status: 502,
      type: 'proxy_unavailable',
      code: 'proxy_unavailable'
    }
  );
}

function getProxy(ctx) {
  const manager = ctx.proxy;
  if (!manager || typeof manager.getRedacted !== 'function') throw proxyUnavailable();
  return manager;
}

function invalidProxy(message, field = null) {
  return new OpenAIError(message, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_proxy',
    param: field
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a proxy patch coming from PUT /proxy or POST /proxy/test.
 * @param {Record<string, any>} body
 * @param {{ allowEnabled?: boolean }} [options]
 * @returns {Record<string, any>} normalized patch (password omitted when not provided)
 */
function validateProxyPatch(body, { allowEnabled = true } = {}) {
  if (!isPlainObject(body)) throw invalidProxy('request body must be a JSON object');
  const allowed = allowEnabled ? PROXY_FIELDS : TEST_OVERRIDE_FIELDS;
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw invalidProxy(`unknown proxy field "${key}"`, key);
  }
  const patch = {};
  if (body.enabled !== undefined && allowEnabled) {
    if (typeof body.enabled !== 'boolean') throw invalidProxy('"enabled" must be a boolean', 'enabled');
    patch.enabled = body.enabled;
  }
  if (body.type !== undefined) {
    if (!PROXY_TYPES.includes(String(body.type))) {
      throw invalidProxy(`"type" must be one of ${PROXY_TYPES.join(', ')}`, 'type');
    }
    patch.type = String(body.type);
  }
  if (body.host !== undefined) {
    if (typeof body.host !== 'string' || !body.host.trim() || body.host.length > 253) {
      throw invalidProxy('"host" must be a non-empty hostname/IP (max 253 chars)', 'host');
    }
    patch.host = body.host.trim();
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalidProxy('"port" must be an integer between 1 and 65535', 'port');
    }
    patch.port = port;
  }
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || body.username.length > 200) {
      throw invalidProxy('"username" must be a string (max 200 chars)', 'username');
    }
    patch.username = body.username;
  }
  if (body.password !== undefined) {
    // Omitted → keep existing password; "" → clear it.
    if (typeof body.password !== 'string' || body.password.length > 500) {
      throw invalidProxy('"password" must be a string (max 500 chars); omit to keep, "" to clear', 'password');
    }
    patch.password = body.password;
  }
  if (body.noProxy !== undefined) {
    if (
      !Array.isArray(body.noProxy) ||
      body.noProxy.length > 50 ||
      body.noProxy.some((item) => typeof item !== 'string' || item.length > 253)
    ) {
      throw invalidProxy('"noProxy" must be an array of strings (max 50 entries)', 'noProxy');
    }
    patch.noProxy = [...new Set(body.noProxy.map((item) => item.trim()).filter(Boolean))];
  }
  for (const field of ['testUrl', 'ipCheckUrl']) {
    if (body[field] === undefined) continue;
    if (!isHttpUrl(body[field])) throw invalidProxy(`"${field}" must be an http(s) URL`, field);
    patch[field] = body[field].trim();
  }
  return patch;
}

function proxyStatusFrom(manager) {
  let status = null;
  if (typeof manager.getStatus === 'function') {
    try {
      status = manager.getStatus();
    } catch {
      status = null;
    }
  }
  const source = isPlainObject(status) ? status : {};
  return {
    active: source.active === true,
    mode: typeof source.mode === 'string' ? source.mode : 'direct',
    lastTestAt: source.lastTestAt ?? null,
    lastTestOk: typeof source.lastTestOk === 'boolean' ? source.lastTestOk : null,
    lastTestLatencyMs: Number.isFinite(source.lastTestLatencyMs) ? source.lastTestLatencyMs : null,
    lastTestStatus: Number.isFinite(source.lastTestStatus) ? source.lastTestStatus : null,
    exitIp: source.exitIp ?? null,
    lastError: source.lastError ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

/** Redacted proxy config + status, never containing the password. */
function proxyPayload(ctx) {
  const manager = getProxy(ctx);
  const redacted = manager.getRedacted();
  if (!isPlainObject(redacted)) throw proxyUnavailable();
  const status = isPlainObject(redacted.status) ? redacted.status : proxyStatusFrom(manager);
  const payload = { ...redacted };
  delete payload.password;
  return {
    proxy: {
      enabled: payload.enabled === true,
      type: typeof payload.type === 'string' ? payload.type : 'http',
      host: typeof payload.host === 'string' ? payload.host : '',
      port: Number.isFinite(payload.port) ? payload.port : null,
      hasAuth: payload.hasAuth === true || Boolean(redacted.username),
      username: typeof payload.username === 'string' ? payload.username : '',
      noProxy: Array.isArray(payload.noProxy) ? payload.noProxy : [],
      testUrl: typeof payload.testUrl === 'string' ? payload.testUrl : null,
      ipCheckUrl: typeof payload.ipCheckUrl === 'string' ? payload.ipCheckUrl : null,
      status: {
        active: status.active === true,
        mode: typeof status.mode === 'string' ? status.mode : 'direct',
        lastTestAt: status.lastTestAt ?? null,
        lastTestOk: typeof status.lastTestOk === 'boolean' ? status.lastTestOk : null,
        lastTestLatencyMs: Number.isFinite(status.lastTestLatencyMs) ? status.lastTestLatencyMs : null,
        lastTestStatus: Number.isFinite(status.lastTestStatus) ? status.lastTestStatus : null,
        exitIp: status.exitIp ?? null,
        lastError: status.lastError ?? null,
        updatedAt: status.updatedAt ?? null
      }
    }
  };
}

/** Map a duck ProxyError (or generic error) to an OpenAIError. */
function mapProxyError(error) {
  if (error instanceof OpenAIError) return error;
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'invalid_proxy') {
    return invalidProxy(error.message || 'invalid proxy configuration', error.field ?? null);
  }
  const status = Number.isInteger(error?.status) ? error.status : 502;
  if (status === 400) {
    return new OpenAIError(error.message || 'invalid proxy configuration', {
      status: 400,
      type: 'invalid_request_error',
      code: code || 'invalid_proxy',
      param: error?.field ?? null
    });
  }
  return new OpenAIError(error?.message || 'proxy operation failed', {
    status,
    type: 'proxy_unavailable',
    code: code || 'proxy_error'
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleGetProxy(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  ctx.json(200, proxyPayload(ctx));
}

async function handlePutProxy(ctx) {
  requireMethod(ctx, ['PUT', 'POST']);
  const manager = getProxy(ctx);
  let patch;
  try {
    patch = validateProxyPatch(ctx.body);
  } catch (error) {
    throw mapProxyError(error);
  }
  // Rebuild the dispatcher immediately (no restart), then persist the config.
  try {
    await manager.update(patch);
  } catch (error) {
    throw mapProxyError(error);
  }
  try {
    applyConfigPatch(ctx.config, { proxy: { ...patch } });
  } catch (error) {
    throw mapProxyError(error);
  }
  if (typeof ctx.store?.saveConfig === 'function') {
    try {
      await ctx.store.saveConfig(ctx.config);
    } catch (error) {
      ctx.logger?.warn?.('failed to persist proxy config', { error: error.message });
    }
  }
  ctx.json(200, { ok: true, ...proxyPayload(ctx), applied: true });
}

async function handleTestProxy(ctx) {
  requireMethod(ctx, ['POST']);
  const manager = getProxy(ctx);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  let overrides;
  try {
    overrides = validateProxyPatch(body, { allowEnabled: false });
  } catch (error) {
    // docs/PROXY.md §3.3: the test endpoint always answers 200 (even on failure),
    // so invalid overrides become {ok:false, code:"invalid_proxy", invalidField}.
    const mapped = mapProxyError(error);
    const proxyConfig = ctx.config?.proxy || {};
    ctx.json(200, {
      ok: false,
      mode: typeof body.type === 'string' ? body.type : proxyConfig.enabled ? proxyConfig.type : 'direct',
      target: typeof body.testUrl === 'string' ? body.testUrl : proxyConfig.testUrl ?? null,
      status: null,
      latencyMs: null,
      exitIp: null,
      ipError: null,
      testedAt: Date.now(),
      error: mapped.message,
      code: 'invalid_proxy',
      invalidField: mapped.param ?? null,
      bypassNoProxy: null
    });
    return;
  }
  let result;
  try {
    result = await manager.test(overrides);
  } catch (error) {
    const mapped = mapProxyError(error);
    if (mapped.status >= 500 && mapped.code !== 'proxy_unavailable') {
      result = {
        ok: false,
        mode: overrides.type || ctx.config?.proxy?.type || 'direct',
        target: overrides.testUrl || ctx.config?.proxy?.testUrl || null,
        status: null,
        latencyMs: null,
        exitIp: null,
        ipError: null,
        testedAt: Date.now(),
        error: mapped.message,
        code: mapped.code
      };
    } else {
      throw mapped;
    }
  }
  const source = isPlainObject(result) ? result : {};
  ctx.json(200, {
    ok: source.ok === true,
    mode: typeof source.mode === 'string' ? source.mode : 'direct',
    target: source.target ?? null,
    status: Number.isFinite(source.status) ? source.status : null,
    latencyMs: Number.isFinite(source.latencyMs) ? source.latencyMs : null,
    exitIp: source.exitIp ?? null,
    ipError: source.ipError ?? null,
    testedAt: Number.isFinite(source.testedAt) ? source.testedAt : Date.now(),
    error: source.error ?? null,
    code: source.code ?? null,
    ...(typeof source.bypassNoProxy === 'boolean' ? { bypassNoProxy: source.bypassNoProxy } : {}),
    ...(source.invalidField ? { invalidField: source.invalidField } : {})
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export async function handleProxyRoutes(ctx, parts, method) {
  void method;
  const action = parts[1] || '';
  if (!action) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') return handleGetProxy(ctx);
    if (ctx.method === 'PUT' || ctx.method === 'POST') return handlePutProxy(ctx);
    requireMethod(ctx, ['GET', 'PUT']);
  }
  if (action === 'test') return handleTestProxy(ctx);
  throw Object.assign(new Error(`Unknown proxy endpoint: ${ctx.method} ${ctx.pathname}`), {
    status: 404,
    code: 'not_found'
  });
}

/**
 * Health summary for /healthz (never leaks the password).
 * @param {Record<string, any>} ctx
 */
export async function getProxyHealthSummary(ctx) {
  try {
    if (ctx.proxy && typeof ctx.proxy.getSummary === 'function') {
      const summary = await ctx.proxy.getSummary();
      if (isPlainObject(summary)) return summary;
    }
    if (ctx.proxy && typeof ctx.proxy.getRedacted === 'function') {
      const redacted = ctx.proxy.getRedacted();
      const status = proxyStatusFrom(ctx.proxy);
      return {
        enabled: redacted.enabled === true,
        mode: status.mode,
        active: status.active,
        lastTestOk: status.lastTestOk,
        lastTestLatencyMs: status.lastTestLatencyMs,
        exitIp: status.exitIp
      };
    }
  } catch {
    // fall through to config-only summary
  }
  const proxyConfig = ctx.config?.proxy || {};
  return {
    enabled: proxyConfig.enabled === true,
    mode: proxyConfig.enabled === true ? proxyConfig.type || 'http' : 'direct',
    active: false,
    lastTestOk: null,
    lastTestLatencyMs: null,
    exitIp: null
  };
}

export { validateProxyPatch, proxyPayload, PROXY_FIELDS, TEST_OVERRIDE_FIELDS };

// Keep badRequest imported for tooling/tests that import this module directly.
void badRequest;
