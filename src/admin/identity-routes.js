/**
 * Admin API v2.2: identity / sync & backup / DuckDuckGo subscription.
 *
 * Contract: docs/IDENTITY-SYNC.md §3. All upstream identity work is delegated to
 * the duck-protocol `identityStore` injected through `createServer({ identity })`.
 * This module only:
 *   - shapes the public/redacted responses,
 *   - enforces `confirm:true` for reveal,
 *   - maps IdentityError codes to HTTP statuses (including 503 + hint),
 *   - never returns privateKeyJwk / token / mainKey without explicit reveal.
 */

import { OpenAIError, badRequest } from '../openai/errors.js';

const IDENTITY_ERROR_MAP = Object.freeze({
  invalid_identity: { status: 400, type: 'invalid_request_error' },
  invalid_recovery_code: { status: 400, type: 'invalid_request_error' },
  invalid_pairing_code: { status: 400, type: 'invalid_request_error' },
  unsupported_pairing_version: { status: 400, type: 'invalid_request_error' },
  token_invalid: { status: 422, type: 'invalid_request_error' },
  token_expired: { status: 422, type: 'invalid_request_error' },
  sync_transport_unavailable: { status: 503, type: 'sync_transport_unavailable' },
  identity_busy: { status: 409, type: 'invalid_request_error' },
  sync_not_enabled: { status: 409, type: 'invalid_request_error' },
  identity_unavailable: { status: 503, type: 'identity_unavailable' }
});

const SECRET_KEYS = new Set([
  'privateKeyJwk',
  'privateKey',
  'token',
  'accessToken',
  'mainKey',
  'encryptedPrivateKey',
  'scopedPasswordSeed',
  'recoveryCode',
  'secret',
  'password'
]);

const PAIRING_SCOPE = new Set(['journey', 'device', 'all']);
const REVEAL_FIELDS = new Set(['token', 'mainKey']);

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-copy while dropping obvious secret fields (defence in depth). */
function scrubSecrets(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    result[key] = scrubSecrets(item, depth + 1);
  }
  return result;
}

function identityStore(ctx) {
  const store = ctx.identity;
  if (!store || typeof store.getRedacted !== 'function') {
    const error = Object.assign(
      new Error('Identity store is not available: duck-protocol src/duck/identity.js was not initialized'),
      {
        name: 'IdentityError',
        status: 503,
        code: 'identity_unavailable',
        hint: '未找到 identity store（duck-protocol src/duck/identity.js 未就绪或初始化失败）。其他网关功能不受影响。'
      }
    );
    throw error;
  }
  return store;
}

function isIdentityError(error) {
  if (!error) return false;
  if (error.skipIdentityMapping === true) return false;
  if (error.name === 'IdentityError') return true;
  if (error.code === 'identity_unavailable') return true;
  return typeof error.code === 'string' && Boolean(IDENTITY_ERROR_MAP[error.code]);
}

function sendIdentityError(ctx, error) {
  const mapped = IDENTITY_ERROR_MAP[error.code] || {
    status: Number.isInteger(error.status) ? error.status : 500,
    type: 'server_error'
  };
  const message =
    typeof error.message === 'string' && error.message ? error.message : 'Identity operation failed';
  const body = {
    error: {
      message,
      type: mapped.type,
      code: typeof error.code === 'string' ? error.code : 'identity_error',
      param: null,
      ...(typeof error.hint === 'string' && error.hint ? { hint: error.hint } : {}),
      ...(error.detail !== undefined && error.detail !== null ? { detail: error.detail } : {})
    }
  };
  ctx.log.error = message;
  ctx.json(mapped.status, body);
}

function authPayload(auth) {
  const source = auth && typeof auth === 'object' ? auth : {};
  return {
    authenticated: source.authenticated === true,
    email: typeof source.email === 'string' ? source.email : null,
    tier: typeof source.tier === 'string' && source.tier ? source.tier : 'free',
    entitlements: Array.isArray(source.entitlements) ? source.entitlements : [],
    expiresAt: source.expiresAt ?? null,
    activatedAt: source.activatedAt ?? null,
    verified: source.verified === true,
    // honest semantics: verified only means "token parsed + upstream reachable",
    // not "Duck.ai confirmed the token is valid".
    verifyScope: 'reachability',
    ...(typeof source.verifyError === 'string' && source.verifyError ? { verifyError: source.verifyError } : {})
  };
}

function identityPayload(ctx) {
  const store = identityStore(ctx);  const red = scrubSecrets(store.getRedacted() || {});
  const durable = red.durableStream && typeof red.durableStream === 'object' ? red.durableStream : {};
  const sync = red.sync && typeof red.sync === 'object' ? red.sync : {};
  let file = null;
  if (typeof store.getFileInfo === 'function') {
    try {
      const info = store.getFileInfo();
      if (info && typeof info === 'object') {
        file = {
          path: info.path ?? null,
          bytes: Number.isFinite(info.bytes) ? info.bytes : null,
          updatedAt: info.updatedAt ?? null
        };
      }
    } catch {
      file = null;
    }
  }
  return {
    identity: {
      journeyId: red.journeyId ?? null,
      deviceId: red.deviceId ?? null,
      deviceName: red.deviceName ?? null,
      fingerprint: durable.fingerprint ?? red.fingerprint ?? null,
      createdAt: red.createdAt ?? null,
      rotatedAt: red.rotatedAt ?? null,
      stable: red.stable !== false,
      source: red.source === 'generated' ? 'generated' : 'file'
    },
    durableStream: {
      fingerprint: durable.fingerprint ?? null,
      publicKeyJwk: durable.publicKeyJwk ?? null,
      hasPrivateKey: durable.hasPrivateKey === true,
      version: durable.version ?? null,
      // v2.2: OFF by default while anonymous duck.ai rejects durableStream bodies.
      enabled: ctx.config?.identity?.durableStream?.enabled === true
    },
    auth: authPayload(red.auth),
    sync: {
      enabled: sync.enabled === true,
      deviceCount: Number.isFinite(sync.deviceCount) ? sync.deviceCount : 0,
      lastSyncAt: sync.lastSyncAt ?? null,
      hasPairingCode: sync.hasPairingCode === true,
      hasRecoveryCode: sync.hasRecoveryCode === true
    },
    file
  };
}

/**
 * Attach duck-layer durableStream stats (configured/enabled/degraded/rejectedCount)
 * plus a human-readable note so the dashboard can show the auto-degrade hint.
 */
async function withDurableStreamHealth(ctx, payload) {
  try {
    const health = typeof ctx.getUpstreamHealth === 'function' ? await ctx.getUpstreamHealth({ maxAgeMs: 1000 }) : null;
    const stats = health && health.durableStream;
    if (stats && typeof stats === 'object') {
      payload.durableStream = { ...payload.durableStream, ...stats };
      if (stats.degraded === true) {
        payload.durableStream.note =
          '上游拒绝了 durableStream（匿名档限制），已自动降级为不带该字段；如需跨设备恢复请使用 Sync/订阅身份。';
      }
    }
  } catch {
    // Degraded health info is best-effort only.
  }
  return payload;
}

async function syncPayload(ctx) {
  const store = identityStore(ctx);
  // v2.8: keep deviceName canonical (DuckCPA@xxxx / config custom) even when the
  // server is constructed directly in tests without index.js bootstrap.
  try {
    await ctx.syncDevices?.ensureDeviceName?.();
  } catch {
    // best-effort; the old name is still usable
  }
  const red = scrubSecrets(store.getRedacted() || {});
  const sync = (await store.getSync()) || {};
  const pairing =
    sync.pairingCode && typeof sync.pairingCode === 'object'
      ? {
          code: sync.pairingCode.code ?? null,
          url: sync.pairingCode.url ?? null,
          channelId: sync.pairingCode.channelId ?? null,
          publicKey: sync.pairingCode.publicKey ?? null,
          createdAt: sync.pairingCode.createdAt ?? null,
          expiresAt: sync.pairingCode.expiresAt ?? null
        }
      : null;
  const server = ctx.syncDevices?.getServerSummary?.() || {
    registered: false,
    userId: null,
    deviceId: red.deviceId ?? null,
    deviceName: red.deviceName ?? null,
    serverDeviceId: null,
    registeredAt: null,
    lastLoginAt: null,
    devices: [],
    lastError: null
  };
  return {
    sync: {
      enabled: sync.enabled === true,
      deviceId: red.deviceId ?? null,
      deviceName: ctx.syncDevices?.deviceName || sync.deviceName || red.deviceName || null,
      deviceCount: Number.isFinite(sync.deviceCount) ? sync.deviceCount : 0,
      devices: Array.isArray(sync.devices) ? scrubSecrets(sync.devices) : [],
      lastSyncAt: sync.lastSyncAt ?? null,
      // v2.16: Sync & Backup mode ("backup" | "syncOnly") — legacy, UI no longer toggles it.
      mode: sync.mode === 'syncOnly' ? 'syncOnly' : 'backup',
      // v2.17: where the current account came from: 'self' (Sync This Device Only),
      // 'pairing' (Sync With Another Device), 'manual' (pasted recovery code) or null.
      accountSource: (await ctx.syncDevices?.getAccountSource?.()) ?? null,
      transport: sync.transport === 'blocked' ? 'blocked' : 'available',
      ...(typeof sync.transportReason === 'string' && sync.transportReason
        ? { transportReason: sync.transportReason }
        : {}),
      pairingCode: pairing,
      server,
      recoveryCode:
        sync.hasRecoveryCode === true
          ? {
              present: true,
              preview: typeof sync.recoveryCodePreview === 'string' ? sync.recoveryCodePreview : null
            }
          : null
    }
  };
}

function subscriptionPayload(ctx, overrides = {}) {
  const store = identityStore(ctx);
  const red = scrubSecrets(store.getRedacted() || {});
  const auth = { ...authPayload(red.auth), ...overrides };
  return {
    subscription: {
      authenticated: auth.authenticated === true,
      email: auth.email ?? null,
      tier: auth.tier || 'free',
      entitlements: Array.isArray(auth.entitlements) ? auth.entitlements : [],
      expiresAt: auth.expiresAt ?? null,
      activatedAt: auth.activatedAt ?? null,
      verified: auth.verified === true,
      // v2.2 fix: duck.ai anonymous /status does not validate Bearer tokens, so
      // `verified` = token parsed locally + upstream reachable — NOT token validity.
      verifyScope: 'reachability',
      verifyNote:
        'verified 仅表示 token 本地解析通过且上游可达，不代表 Duck.ai 已确认 token 有效；真实档位以实际请求上游结果为准',
      ...(typeof auth.verifyError === 'string' && auth.verifyError ? { verifyError: auth.verifyError } : {}),
      allowPaidModels: ctx.config?.duck?.allowPaidModels === true
    }
  };
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

async function handleIdentity(ctx, parts) {
  const store = identityStore(ctx);
  const action = parts[1] || '';

  if (!action) {
    requireMethod(ctx, ['GET', 'HEAD']);
    try {
      await ctx.syncDevices?.ensureDeviceName?.();
    } catch {
      // best-effort
    }
    ctx.json(200, await withDurableStreamHealth(ctx, identityPayload(ctx)));
    return;
  }

  if (action === 'rotate') {
    requireMethod(ctx, ['POST']);
    const requestedScope = ctx.body && typeof ctx.body === 'object' ? ctx.body.scope : undefined;
    // Default "all" for the dashboard rotate button; invalid scopes are validated by
    // the identity store and mapped to 400 invalid_identity (contract error set).
    await store.rotate(requestedScope === undefined || requestedScope === null ? 'all' : requestedScope);
    const payload = await withDurableStreamHealth(ctx, identityPayload(ctx));
    ctx.json(200, {
      ok: true,
      ...payload,
      identityLost: true,
      note: '轮换会丢弃当前 journeyId/durableStream 密钥，旧身份无法恢复',
      warning: '轮换身份可能导致 duck.ai 将本网关识别为新访客（journey/durable-stream 指纹变化）'
    });
    return;
  }

  if (action === 'export') {
    requireMethod(ctx, ['GET', 'HEAD']);
    const raw = store.exportIdentity();
    const exportedAt = Date.now();
    const doc =
      raw && typeof raw === 'object' && raw.identity && typeof raw.identity === 'object'
        ? raw
        : { version: raw?.version ?? 1, exportedAt, identity: raw };
    const ts = new Date(exportedAt).toISOString().replace(/[:.]/g, '-');
    ctx.log.stream = false;
    ctx.json(200, doc, {
      'Content-Disposition': `attachment; filename="duckai-identity-${ts}.json"`,
      'Cache-Control': 'no-store'
    });
    return;
  }

  if (action === 'import') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const candidate = body.identity !== undefined ? body.identity : body;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw badRequest('"identity" is required and must be an object', 'identity', 'invalid_identity');
    }
    await store.importIdentity(candidate);
    ctx.json(200, { ok: true, ...(await withDurableStreamHealth(ctx, identityPayload(ctx))) });
    return;
  }

  if (action === 'reveal') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const field = typeof body.field === 'string' ? body.field : '';
    if (!REVEAL_FIELDS.has(field)) {
      throw badRequest('"field" must be "token" or "mainKey"', 'field', 'invalid_field');
    }
    if (body.confirm !== true) {
      throw badRequest('"confirm": true is required to reveal a secret', 'confirm', 'confirmation_required');
    }
    const value = store.reveal(field);
    ctx.json(200, { ok: true, field, value: value ?? null });
    return;
  }

  ctx.json(404, {
    error: { message: `Unknown identity endpoint: ${ctx.method} ${ctx.pathname}`, type: 'invalid_request_error', code: 'not_found', param: null }
  });
}

/* ------------------------------------------------------------------ */
/* Sync & Backup                                                       */
/* ------------------------------------------------------------------ */

async function handleRegisterDevice(ctx) {
  requireMethod(ctx, ['POST']);
  const service = ctx.syncDevices;
  if (!service) {
    throw new OpenAIError('Sync device registration service is not available', {
      status: 503,
      type: 'sync_transport_unavailable',
      code: 'sync_transport_unavailable',
      hint: 'sync-client 模块未就绪或网关未启用 Sync，请重启/检查代理'
    });
  }
  const result = await service.registerDevice();
  ctx.json(200, result);
}

async function handleServerDevices(ctx, parts) {
  const service = ctx.syncDevices;
  if (!service) {
    throw new OpenAIError('Sync device registration service is not available', {
      status: 503,
      type: 'sync_transport_unavailable',
      code: 'sync_transport_unavailable',
      hint: 'sync-client 模块未就绪或网关未启用 Sync，请重启/检查代理'
    });
  }
  if (parts[2]) {
    requireMethod(ctx, ['DELETE']);
    const deviceId = decodeURIComponent(parts[2]);
    // `?force=true` (or body {confirm:true}) allows removing the current device: it is logged
    // out of the DuckDuckGo account, while the identity, account and recovery code are kept.
    const forceRaw = typeof ctx.query?.get === 'function' ? ctx.query.get('force') : ctx.query?.force;
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const confirm =
      ['1', 'true', 'yes'].includes(String(forceRaw ?? '').toLowerCase()) ||
      body.force === true ||
      body.confirm === true;
    const result = await service.deleteDevice(deviceId, { confirm, reason: 'admin_delete' });
    ctx.json(200, result);
    return;
  }
  requireMethod(ctx, ['GET', 'HEAD']);
  if (typeof service.listServerDevicesDetailed === 'function') {
    const detailed = await service.listServerDevicesDetailed();
    ctx.json(200, {
      devices: detailed.devices,
      currentDeviceId: detailed.currentDeviceId,
      primaryDeviceId: detailed.primaryDeviceId ?? detailed.currentDeviceId,
      total: detailed.total,
      server: detailed.server
    });
    return;
  }
  const result = await service.listDevices();
  ctx.json(200, {
    devices: result.devices,
    currentDeviceId: result.currentDeviceId,
    total: result.total,
    server: result.server
  });
}

async function handleDeviceSlots(ctx) {
  const service = ctx.syncDevices;
  if (!service) {
    throw new OpenAIError('Sync device registration service is not available', {
      status: 503,
      type: 'sync_transport_unavailable',
      code: 'sync_transport_unavailable',
      hint: 'sync-client 模块未就绪或网关未启用 Sync，请重启/检查代理'
    });
  }
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    if (typeof service.getDeviceSlots !== 'function') {
      throw new OpenAIError('device slots are not available', {
        status: 503,
        type: 'identity_pool_unavailable',
        code: 'identity_pool_unavailable',
        hint: 'identity pool / sync-client 未就绪'
      });
    }
    const reconcileRaw =
      typeof ctx.query?.get === 'function' ? ctx.query.get('reconcile') : ctx.query?.reconcile;
    const reconcile = ['true', '1', 'yes'].includes(String(reconcileRaw || '').toLowerCase());
    ctx.json(200, await service.getDeviceSlots({ reconcile }));
    return;
  }
  requireMethod(ctx, ['PUT', 'POST']);
  const reconcileRaw =
    typeof ctx.query?.get === 'function' ? ctx.query.get('reconcile') : ctx.query?.reconcile;
  const reconcile = ['true', '1', 'yes'].includes(String(reconcileRaw || '').toLowerCase());
  if (reconcile) {
    // "清理" button sends PUT ?reconcile=true with an empty body: run the same
    // orphan cleanup as GET ?reconcile=true and return the filtered slots.
    ctx.json(200, await service.getDeviceSlots({ reconcile: true }));
    return;
  }
  const body = ctx.body;
  const identityIds = Array.isArray(body) ? body : isPlainObject(body) ? body.identityIds : null;
  ctx.json(200, await service.setDeviceSlots(identityIds));
}

async function handlePairing(ctx, parts = []) {
  // v2.14: explicit action to adopt the phone's account received during pairing.
  if (parts[2] === 'adopt-account') {
    requireMethod(ctx, ['POST']);
    if (!ctx.pairing) {
      throw new OpenAIError('Pairing host is not available', {
        status: 503,
        type: 'identity_unavailable',
        code: 'pairing_unavailable',
        hint: 'duck-protocol src/duck/pairing.js 未初始化，请重启网关'
      });
    }
    const result = await ctx.pairing.adoptPendingAccount();
    ctx.json(200, result);
    return;
  }
  requireMethod(ctx, ['GET', 'HEAD', 'POST', 'DELETE']);
  if (!ctx.pairing) {
    throw new OpenAIError('Pairing host is not available', {
      status: 503,
      type: 'identity_unavailable',
      code: 'pairing_unavailable',
      hint: 'duck-protocol src/duck/pairing.js 未初始化，请重启网关'
    });
  }
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    ctx.json(200, { pairing: await ctx.pairing.status() });
    return;
  }
  if (ctx.method === 'DELETE') {
    const pairing = await ctx.pairing.stop('aborted');
    ctx.json(200, { ok: true, pairing });
    return;
  }
  // POST: start a real Sync channel registration + host handshake.
  if (ctx.identity && typeof ctx.identity.getSync === 'function') {
    let syncState = null;
    try {
      syncState = await ctx.identity.getSync();
    } catch {
      syncState = null;
    }
    if (syncState && syncState.enabled !== true && ctx.config?.identity?.sync?.enabled !== true) {
      const error = new OpenAIError('Sync & Backup is not enabled', {
        status: 400,
        type: 'invalid_request_error',
        code: 'sync_not_enabled',
        hint: '先启用 Sync & Backup（或设置 identity.sync.enabled=true）再生成配对二维码'
      });
      // pairing contract wants 400 here; keep the generic identity mapping (409) for v2.2 endpoints.
      error.skipIdentityMapping = true;
      throw error;
    }
  }
  try {
    const pairing = await ctx.pairing.start();
    ctx.json(200, { ok: true, ...pairing, pairing });
  } catch (error) {
    if (error?.code === 'pairing_in_progress') {
      throw new OpenAIError(error.message, {
        status: 409,
        type: 'invalid_request_error',
        code: 'pairing_in_progress'
      });
    }
    const code = typeof error?.code === 'string' ? error.code : 'network';
    if (code === 'network' || code === 'timeout') {
      throw new OpenAIError(error.message || 'pairing host could not reach the Sync service', {
        status: 503,
        type: 'sync_transport_unavailable',
        code: 'sync_transport_unavailable',
        hint: 'enable the outbound proxy in the Proxy page (sync.duckduckgo.com must be reachable)',
        detail: code
      });
    }
    throw new OpenAIError(error.message || 'pairing start failed', {
      status: 502,
      type: 'upstream_error',
      code: 'pairing_start_failed',
      detail: code,
      hint: 'pairing channel registration failed; retry or check the proxy/network'
    });
  }
}

async function handleOfficialRecoveryCode(ctx, parts = []) {
  if (parts[2] === 'download') return handleOfficialRecoveryCodeDownload(ctx);
  requireMethod(ctx, ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);
  const pairingStore = ctx.pairing?.pairingStore;
  if (!pairingStore) {
    throw new OpenAIError('Pairing store is not available', {
      status: 503,
      type: 'identity_unavailable',
      code: 'pairing_unavailable'
    });
  }
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    ctx.json(200, { officialRecoveryCode: await pairingStore.getStatus({ includeCode: true }) });
    return;
  }
  if (ctx.method === 'DELETE') {
    ctx.json(200, { ok: true, officialRecoveryCode: await pairingStore.clearRecoveryCode() });
    return;
  }
  const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
  const code = body.code ?? body.recoveryCode;
  if (typeof code !== 'string' || !code.trim()) {
    throw badRequest('"code" is required (official DuckDuckGo recovery code)', 'code', 'invalid_request');
  }
  ctx.json(200, {
    ok: true,
    officialRecoveryCode: await pairingStore.setRecoveryCode(code, { source: 'manual' })
  });
}

async function handleOfficialRecoveryCodeDownload(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  const pairingStore = ctx.pairing?.pairingStore;
  if (!pairingStore) {
    throw new OpenAIError('Pairing store is not available', {
      status: 503,
      type: 'identity_unavailable',
      code: 'pairing_unavailable'
    });
  }
  const code = await pairingStore.getRecoveryCode();
  if (!code) {
    throw new OpenAIError('official DuckDuckGo recovery code is not configured', {
      status: 404,
      type: 'invalid_request_error',
      code: 'recovery_code_not_configured',
      hint: '先完成扫码配对或手动保存官方恢复码'
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const body = `${code}\n`;
  ctx.res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="duckduckgo-official-recovery-code-${stamp}.txt"`,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  if (ctx.method === 'HEAD') ctx.res.end();
  else ctx.res.end(body);
}

async function handleSync(ctx, parts) {
  const action = parts[1] || '';
  // v2.5 pairing host + official recovery code (docs/PAIRING-IMPL.md §4).
  if (action === 'pairing') return handlePairing(ctx, parts);
  if (action === 'official-recovery-code') return handleOfficialRecoveryCode(ctx, parts);
  // v2.8 Sync server device registration.
  if (action === 'register-device') return handleRegisterDevice(ctx);
  if (action === 'server-devices') return handleServerDevices(ctx, parts);
  if (action === 'device-slots') return handleDeviceSlots(ctx);

  const store = identityStore(ctx);

  if (!action) {
    requireMethod(ctx, ['GET', 'HEAD']);
    ctx.json(200, await syncPayload(ctx));
    return;
  }

  // v2.17: "Sync This Device Only" — create a dedicated backup account for this gateway.
  if (action === 'create-own-account') {
    requireMethod(ctx, ['POST']);
    if (!ctx.syncDevices || typeof ctx.syncDevices.createOwnAccount !== 'function') {
      throw new OpenAIError('Sync device service is not available', {
        status: 503,
        type: 'sync_transport_unavailable',
        code: 'sync_transport_unavailable'
      });
    }
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const current = ctx.syncDevices.getServerSummary?.() || {};
    const hasExisting = current.userId || current.registered === true;
    if (hasExisting && body.confirm !== true) {
      throw new OpenAIError('an existing Sync account is configured; creating a new one requires {"confirm":true}', {
        status: 400,
        type: 'invalid_request_error',
        code: 'sync_account_exists',
        param: 'confirm',
        hint: '{"confirm":true} replaces the current Sync account with a brand-new one for this device only'
      });
    }
    const result = await ctx.syncDevices.createOwnAccount();
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, ...result, sync: payload.sync });
    return;
  }

  // v2.16: Sync & Backup data deletion (stop syncing, forget server devices/recovery code).
  if (action === 'delete-data') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    if (body.confirm !== true) {
      throw badRequest('deleting Sync & Backup data requires {"confirm":true}', 'confirm');
    }
    if (!ctx.syncDevices || typeof ctx.syncDevices.deleteSyncData !== 'function') {
      throw new OpenAIError('Sync device service is not available', {
        status: 503,
        type: 'sync_transport_unavailable',
        code: 'sync_transport_unavailable'
      });
    }
    const result = await ctx.syncDevices.deleteSyncData();
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, ...result, sync: payload.sync });
    return;
  }

  // v2.16: Sync & Backup mode (backup | syncOnly).
  if (action === 'mode') {
    requireMethod(ctx, ['POST', 'PUT']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const mode = body.mode === 'syncOnly' ? 'syncOnly' : body.mode === 'backup' ? 'backup' : null;
    if (!mode) throw badRequest('"mode" must be "backup" or "syncOnly"', 'mode');
    await store.setSyncMode(mode);
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, mode, sync: payload.sync });
    return;
  }

  if (action === 'enable') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    if (body.deviceName !== undefined && typeof body.deviceName !== 'string') {
      throw badRequest('"deviceName" must be a string', 'deviceName');
    }
    const result = await store.enableSync({ deviceName: body.deviceName });
    const payload = await syncPayload(ctx);
    ctx.json(200, {
      ok: true,
      sync: payload.sync,
      // The full recovery code is only returned once, from enable.
      recoveryCode: result?.recoveryCode ?? null
    });
    return;
  }

  if (action === 'disable') {
    requireMethod(ctx, ['POST']);
    await store.disableSync();
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, sync: payload.sync });
    return;
  }

  if (action === 'pairing-code') {
    requireMethod(ctx, ['POST']);
    const pairing = await store.createPairingCode();
    ctx.json(200, {
      ok: true,
      code: pairing?.code ?? null,
      url: pairing?.url ?? null,
      channelId: pairing?.channelId ?? null,
      publicKey: pairing?.publicKey ?? null,
      createdAt: pairing?.createdAt ?? null,
      expiresAt: pairing?.expiresAt ?? null
    });
    return;
  }

  if (action === 'pair') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      throw Object.assign(new Error('"code" is required (v2 pairing code)'), {
        name: 'IdentityError',
        status: 400,
        code: 'invalid_pairing_code'
      });
    }
    await store.pair(code);
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, sync: payload.sync });
    return;
  }

  if (action === 'recovery-code') {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      const result = await store.getRecoveryCode();
      // duck-protocol IdentityStore returns { recoveryCode } (contract §3.2); tolerate
      // a plain string too so this never double-wraps.
      const recoveryCode =
        typeof result === 'string'
          ? result
          : result && typeof result === 'object' && 'recoveryCode' in result
            ? result.recoveryCode
            : null;
      ctx.json(200, { recoveryCode: recoveryCode ?? null });
      return;
    }
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
    if (!recoveryCode) {
      throw Object.assign(new Error('"recoveryCode" is required'), {
        name: 'IdentityError',
        status: 400,
        code: 'invalid_recovery_code'
      });
    }
    await store.importRecoveryCode(recoveryCode);
    const payload = await syncPayload(ctx);
    ctx.json(200, { ok: true, sync: payload.sync });
    return;
  }

  ctx.json(404, {
    error: { message: `Unknown sync endpoint: ${ctx.method} ${ctx.pathname}`, type: 'invalid_request_error', code: 'not_found', param: null }
  });
}

/* ------------------------------------------------------------------ */
/* Subscription                                                        */
/* ------------------------------------------------------------------ */

function looksLikeJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3 && token.split('.').every((part) => part.length > 0);
}

async function handleSubscription(ctx, parts) {
  const store = identityStore(ctx);
  const action = parts[1] || '';

  if (!action) {
    if (ctx.method === 'DELETE') {
      await store.clearSubscription();
      ctx.json(200, { ok: true, ...subscriptionPayload(ctx) });
      return;
    }
    requireMethod(ctx, ['GET', 'HEAD']);
    ctx.json(200, subscriptionPayload(ctx));
    return;
  }

  if (action === 'activate') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || !looksLikeJwt(token)) {
      throw Object.assign(new Error('Invalid token: expected a three-part JWT (base64url.header.payload.signature)'), {
        name: 'IdentityError',
        status: 422,
        code: 'token_invalid'
      });
    }
    await store.activateSubscription(token);
    ctx.json(200, { ok: true, ...subscriptionPayload(ctx) });
    return;
  }

  if (action === 'verify') {
    requireMethod(ctx, ['POST']);
    const result = await store.verifySubscription();
    const overrides = {};
    if (result && typeof result === 'object') {
      if (typeof result.verified === 'boolean') overrides.verified = result.verified;
      if (typeof result.error === 'string' && result.error) overrides.verifyError = result.error;
    }
    ctx.json(200, { ok: true, ...subscriptionPayload(ctx, overrides) });
    return;
  }

  ctx.json(404, {
    error: {
      message: `Unknown subscription endpoint: ${ctx.method} ${ctx.pathname}`,
      type: 'invalid_request_error',
      code: 'not_found',
      param: null
    }
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, any>} ctx request context from src/http/server.js
 * @param {string[]} parts path parts after `/admin/api` (e.g. ['identity','rotate'])
 * @param {string} method HTTP method
 */
export async function handleIdentityRoutes(ctx, parts, method) {
  void method;
  const head = parts[0];
  try {
    if (head === 'identity') {
      await handleIdentity(ctx, parts);
      return;
    }
    if (head === 'sync') {
      await handleSync(ctx, parts);
      return;
    }
    if (head === 'subscription') {
      await handleSubscription(ctx, parts);
      return;
    }
    ctx.json(404, {
      error: { message: 'Unknown admin endpoint', type: 'invalid_request_error', code: 'not_found', param: null }
    });
  } catch (error) {
    if (isIdentityError(error)) {
      sendIdentityError(ctx, error);
      return;
    }
    throw error;
  }
}
