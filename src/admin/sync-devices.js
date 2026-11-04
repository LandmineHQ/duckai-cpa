/**
 * v2.8 Sync device registration (Admin API).
 *
 * DuckDuckGo Sync stores a per-account device list (`PATCH /devices`). This module:
 *  - keeps a stable, human-friendly device name (`DuckCPA@xxxx`, overridable via
 *    config.identity.deviceName / PUT config),
 *  - lazily loads duck-protocol's `src/duck/sync-client.js`,
 *  - persists the server registration info into `identity.sync.server` (atomic write
 *    via identityStore.importIdentity) so it survives restarts,
 *  - is triggered automatically after a pairing joiner hands us the official code.
 */

import crypto from 'node:crypto';
import { OpenAIError } from '../openai/errors.js';

const DEVICE_NAME_RE = /^DuckCPA@[0-9a-f]{4}$/;
const TYPE = 'browser';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function transportError(message, hint) {
  return new OpenAIError(message, {
    status: 503,
    type: 'sync_transport_unavailable',
    code: 'sync_transport_unavailable',
    hint: hint || 'enable the outbound proxy in the Proxy page (sync.duckduckgo.com must be reachable)'
  });
}

function mapSyncError(error, phase = 'login') {
  if (error instanceof OpenAIError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message = error?.message || 'Sync request failed';
  // DuckDuckGo Sync anti-abuse: HTTP 418 on /login. Map to 429 + cooldown.
  if (error?.httpStatus === 418 || code === 'sync_rate_limited' || /\b418\b/.test(message)) {
    return rateLimitError();
  }
  if (code === 'sync_transport_unavailable' || status === 503) return transportError(message, error?.hint);
  if (code === 'sync_unauthorized' || status === 401) {
    return new OpenAIError(message, { status: 401, type: 'authentication_error', code: 'sync_unauthorized' });
  }
  if (code === 'recovery_code_not_configured' || code === 'invalid_recovery_code') {
    return new OpenAIError(message, { status: 400, type: 'invalid_request_error', code });
  }
  if (code === 'sync_not_logged_in') {
    return new OpenAIError(message, { status: 409, type: 'invalid_request_error', code: 'sync_not_logged_in' });
  }
  if (code === 'invalid_device' || status === 400) {
    return new OpenAIError(message, { status: 400, type: 'invalid_request_error', code: code || 'invalid_device' });
  }
  if (code === 'sync_account_info_unavailable') {
    return new OpenAIError(message, {
      status: 502,
      type: 'upstream_error',
      code: 'sync_account_info_unavailable',
      detail: code
    });
  }
  return new OpenAIError(message, {
    status: 502,
    type: 'upstream_error',
    code: phase === 'register' ? 'sync_register_failed' : 'sync_login_failed',
    detail: code || null
  });
}

const RATE_LIMIT_COOLDOWN_MS = 120000;

function rateLimitError() {
  const error = new OpenAIError(
    'DuckDuckGo Sync is rate-limiting logins (HTTP 418 anti-abuse); please retry later',
    {
      status: 429,
      type: 'rate_limit_error',
      code: 'sync_rate_limited',
      hint: 'DuckDuckGo Sync 限流（418），请稍后重试（约 2 分钟），期间不会再次请求上游'
    }
  );
  error.headers = { 'Retry-After': String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000)) };
  error.retryAfterMs = RATE_LIMIT_COOLDOWN_MS;
  return error;
}

export function defaultDeviceName() {
  return `DuckCPA@${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Ensure `identity.deviceName` is a stable DuckCPA@xxxx name (or the configured one)
 * and persist it. Returns the effective name.
 */
export async function ensureDeviceName({ identity, config = {}, store = null, logger = null } = {}) {
  if (!identity) return null;
  const redacted = identity.getRedacted?.() || {};
  const LEGACY_DEVICE_NAME_RE = /^DuckAI CPA/i;
  const GENERATED_DEVICE_NAME_RE = /^DuckCPA@[0-9a-f]{4}$/;
  const MAIN_DEVICE_NAME = 'DuckAI@main';
  let configured =
    typeof config?.identity?.deviceName === 'string' && config.identity.deviceName.trim()
      ? config.identity.deviceName.trim().slice(0, 100)
      : null;
  // v2.8 migration: old defaults and auto-generated DuckCPA@xxxx (main identity now
  // uses DuckAI@main). Truly custom names are preserved.
  if (configured && (LEGACY_DEVICE_NAME_RE.test(configured) || GENERATED_DEVICE_NAME_RE.test(configured))) {
    configured = null;
  }
  let name = configured;
  if (!name) {
    const current = typeof redacted.deviceName === 'string' ? redacted.deviceName : '';
    if (current === MAIN_DEVICE_NAME) name = MAIN_DEVICE_NAME;
    else if (current && !LEGACY_DEVICE_NAME_RE.test(current) && !GENERATED_DEVICE_NAME_RE.test(current)) {
      name = current.slice(0, 100);
    } else name = MAIN_DEVICE_NAME;
  }
  if (redacted.deviceName !== name) {
    try {
      if (typeof identity.setDeviceName === 'function') {
        await identity.setDeviceName(name);
      } else {
        const raw = identity.getRaw?.() || {};
        const next = { ...raw, deviceName: name };
        await identity.importIdentity({ version: next.version, identity: next });
      }
    } catch (error) {
      logger?.warn?.('failed to persist identity.deviceName', { error: error.message });
    }
  }
  if (config?.identity && config.identity.deviceName !== name) {
    config.identity.deviceName = name;
    try {
      await store?.saveConfig?.(config);
    } catch (error) {
      logger?.warn?.('failed to persist config.identity.deviceName', { error: error.message });
    }
  }
  return name;
}

export function createSyncDeviceService({
  identity = null,
  pairingStore = null,
  proxyManager = null,
  logger = null,
  config = {},
  store = null,
  identities = null,
  syncClientFactory = null,
  loadSyncClientModule = null
} = {}) {
  let client = null;
  let lastError = null;
  /** In-memory DuckDuckGo Sync session (token stays out of identity.json). */
  let sessionCache = null;
  /** Process-wide cooldown after an HTTP 418 anti-abuse response. */
  let rateLimitedUntil = 0;

  function cooldownRemainingMs() {
    return Math.max(0, rateLimitedUntil - Date.now());
  }

  function throwIfRateLimited() {
    if (cooldownRemainingMs() > 0) throw rateLimitError();
  }

  /** Map a sync error; clear a stale cached token on 401 so the next call re-logins. */
  function handleSyncFailure(error, phase = 'login') {
    const mapped = mapSyncError(error, phase);
    if (mapped.status === 401 || mapped.code === 'sync_unauthorized') sessionCache = null;
    if (mapped.code === 'sync_rate_limited') rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    return mapped;
  }

  function requireIdentity() {
    if (!identity) {
      throw new OpenAIError('Identity store is not available', {
        status: 503,
        type: 'identity_unavailable',
        code: 'identity_unavailable'
      });
    }
    return identity;
  }

  async function officialRecoveryCode() {
    if (!pairingStore) {
      throw new OpenAIError('official DuckDuckGo recovery code is not configured', {
        status: 400,
        type: 'invalid_request_error',
        code: 'recovery_code_not_configured',
        hint: '完成手机扫码配对（joiner）或手动 PUT /admin/api/sync/official-recovery-code'
      });
    }
    const code = await pairingStore.getRecoveryCode();
    if (!code) {
      throw new OpenAIError('official DuckDuckGo recovery code is not configured', {
        status: 400,
        type: 'invalid_request_error',
        code: 'recovery_code_not_configured',
        hint: '完成手机扫码配对（joiner）或手动 PUT /admin/api/sync/official-recovery-code'
      });
    }
    return code;
  }

  async function getClient() {
    if (client) return client;
    if (typeof syncClientFactory === 'function') {
      client = await syncClientFactory({ proxyManager, logger });
      return client;
    }
    const loader =
      loadSyncClientModule ||
      (() => import('../duck/sync-client.js').catch((error) => {
        throw transportError('duck-protocol sync-client module is not available yet', 'wait for the sync-client implementation and restart the gateway');
      }));
    let mod;
    try {
      mod = await loader();
    } catch (error) {
      if (error?.code === 'sync_transport_unavailable') throw error;
      throw transportError(`sync-client module unavailable: ${error.message}`);
    }
    const factory = mod?.createSyncClient || mod?.default;
    if (typeof factory !== 'function') {
      throw transportError('sync-client module does not export createSyncClient');
    }
    client = await factory({ proxyManager, logger });
    return client;
  }

  /**
   * v2.18: the Sync client must log in as the SAME device that the identity pool registers.
   * Historically the gateway had two records named "DuckAI@main" (global data/identity.json and the
   * pool's id_default), so DuckDuckGo showed the gateway twice. Prefer the pool default identity.
   */
  async function syncDevice() {
    const id = requireIdentity();
    const red = id.getRedacted?.() || {};
    if (identities && typeof identities.get === 'function' && typeof identities.getDefaultIdentityId === 'function') {
      try {
        const defaultId = await identities.getDefaultIdentityId();
        const summary = await Promise.resolve(identities.get(defaultId));
        if (summary && typeof summary.deviceId === 'string' && summary.deviceId) {
          return {
            deviceId: summary.deviceId,
            deviceName: summary.deviceName || red.deviceName || deviceName(),
            identityId: summary.id || defaultId
          };
        }
      } catch {
        // fall back to the global identity below
      }
    }
    return { deviceId: red.deviceId || null, deviceName: red.deviceName || deviceName(), identityId: null };
  }

  function deviceName() {
    return (
      (typeof config?.identity?.deviceName === 'string' && config.identity.deviceName.trim()) ||
      identity?.getRedacted?.()?.deviceName ||
      null
    );
  }

  function serverView() {
    const raw = identity?.getRaw?.() || {};
    const server = isPlainObject(raw.sync?.server) ? raw.sync.server : null;
    return {
      registered: Boolean(server && (server.userId || server.deviceId)),
      userId: server?.userId ?? null,
      deviceId: server?.deviceId ?? null,
      deviceName: server?.deviceName ?? deviceName(),
      serverDeviceId: server?.serverDeviceId ?? null,
      registeredAt: server?.registeredAt ?? null,
      lastLoginAt: server?.lastLoginAt ?? null,
      devices: Array.isArray(server?.devices) ? server.devices.map(sanitizeDevice) : [],
      lastError: lastError ?? server?.lastError ?? null
    };
  }

  function sanitizeDevice(device) {
    if (!isPlainObject(device)) return device;
    // Device info from DuckDuckGo is encrypted (JWE compact string); never echo raw
    // ciphertext as a "name"/"type". The current device is synthesised readable.
    // Device info from DuckDuckGo may be encrypted (compact JWE). Never echo ciphertext as a
    // "name"/"type"; only hide values that actually look like a 5-segment JWE.
    const JWE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    const readable = (value) => (typeof value === 'string' && value && !JWE_RE.test(value) ? value : null);
    return {
      id: device.id ?? null,
      name: readable(device.name),
      type: readable(device.type),
      credential_id: device.credential_id ?? null,
      jwt_iat: device.jwt_iat ?? null,
      current: device.current === true,
      ...(Number.isFinite(device.createdAt) ? { createdAt: device.createdAt } : {})
    };
  }

  async function persistServer(patch) {
    const id = requireIdentity();
    // Store the full server block (incl. devices) in identity.sync.server via the
    // identity export/import path; duck's setSyncServer only persists a subset.
    const raw = id.getRaw?.() || {};
    const current = isPlainObject(raw.sync?.server) ? raw.sync.server : {};
    const nextServer = { ...current, ...patch, updatedAt: Date.now() };
    const nextIdentity = {
      ...raw,
      sync: { ...(raw.sync || {}), server: nextServer }
    };
    await id.importIdentity({ version: nextIdentity.version, identity: nextIdentity });
    return nextServer;
  }

  async function login() {
    const device = await syncDevice();
    const syncClient = await getClient();
    const clientStatus = typeof syncClient.getStatus === 'function' ? syncClient.getStatus() : null;
    // Reuse the cached token when possible (avoid repeated /login → 418 anti-abuse).
    if (sessionCache && clientStatus && clientStatus.loggedIn === true) {
      return {
        syncClient,
        session: { userId: sessionCache.userId, deviceId: device.deviceId },
        userId: sessionCache.userId,
        jwt: null,
        cached: true
      };
    }
    throwIfRateLimited();
    const code = await officialRecoveryCode();
    let session;
    try {
      session = await syncClient.login({
        recoveryCode: code,
        deviceName: device.deviceName || deviceName(),
        deviceId: device.deviceId
      });
    } catch (error) {
      throw handleSyncFailure(error, 'login');
    }
    const userId = session?.userId ?? session?.user_id ?? null;
    const jwt = session?.jwt ?? session?.token ?? null;
    if (!userId && !jwt) {
      throw new OpenAIError('Sync login did not return userId/jwt', {
        status: 502,
        type: 'upstream_error',
        code: 'sync_login_failed',
        detail: 'missing_user_id'
      });
    }
    sessionCache = { userId, loginAt: Date.now() };
    return { syncClient, session, userId, jwt };
  }

  function ensureCurrentDevice(list, red, name) {
    const devices = Array.isArray(list) ? list.map(sanitizeDevice) : [];
    const hasCurrent = devices.some((device) => device.id === red.deviceId);
    if (!hasCurrent && red.deviceId) {
      devices.unshift({
        id: red.deviceId,
        name,
        type: TYPE,
        credential_id: '3party',
        jwt_iat: null,
        current: true
      });
    } else {
      for (const device of devices) {
        if (device.id !== red.deviceId) continue;
        device.current = true;
        device.name = device.name || name;
        device.type = device.type || TYPE;
      }
    }
    return devices;
  }

  async function listDevices() {
    const cachedServer = serverView();
    const clientLoggedIn = Boolean(client && typeof client.getStatus === 'function' && client.getStatus().loggedIn);
    // Prefer the persisted device cache when we have no live session (avoids a
    // fresh /login on every GET and survives 418 rate limiting / restarts).
    if (!clientLoggedIn && cachedServer.devices.length > 0) {
      return {
        devices: cachedServer.devices,
        currentDeviceId: cachedServer.deviceId,
        total: cachedServer.devices.length,
        server: cachedServer,
        cached: true
      };
    }
    const { syncClient, session, userId } = await login();
    const device = await syncDevice();
    const red = { deviceId: device.deviceId, deviceName: device.deviceName };
    let devices;
    try {
      // Detailed list decrypts each device info envelope so the UI shows readable names
      // (e.g. "Chrome 156.0.0.0", "Android 手机") instead of "未命名设备".
      devices = typeof syncClient.listDevicesDetailed === 'function'
        ? await syncClient.listDevicesDetailed()
        : await syncClient.listDevices();
    } catch (error) {
      throw handleSyncFailure(error, 'login');
    }
    let list = Array.isArray(devices) ? devices : devices?.devices || [];
    list = list.map((device) => ({
      ...sanitizeDevice(device),
      current: device?.current === true || device?.id === red.deviceId || device?.id === session?.deviceId
    }));
    list = ensureCurrentDevice(list, red, deviceName());
    const server = {
      userId,
      deviceId: red.deviceId,
      deviceName: deviceName(),
      lastLoginAt: Date.now(),
      devices: list
    };
    await persistServer(server);
    lastError = null;
    return { devices: list, currentDeviceId: red.deviceId, total: list.length, server: serverView() };
  }

  function requirePool() {
    if (!identities) {
      throw new OpenAIError('Identity pool is not available', {
        status: 503,
        type: 'identity_pool_unavailable',
        code: 'identity_pool_unavailable'
      });
    }
    return identities;
  }

  async function defaultIdentityId() {
    const pool = requirePool();
    if (typeof pool.getDefaultIdentityId === 'function') {
      const id = await pool.getDefaultIdentityId();
      if (typeof id === 'string' && id) return id;
    }
    const summary = pool.getSummary?.() || {};
    return summary.activeId || 'id_default';
  }

  function savedSlotIds() {
    const raw = identity?.getRaw?.() || {};
    const slots = raw.sync && raw.sync.slots;
    if (!Array.isArray(slots)) return null;
    return slots.filter((id) => typeof id === 'string');
  }

  async function persistSlotIds(ids) {
    if (!identity) return;
    const raw = identity.getRaw?.() || {};
    const next = {
      ...raw,
      sync: { ...(raw.sync || {}), slots: [...new Set(ids)] }
    };
    await identity.importIdentity({ version: next.version, identity: next });
  }

  /** Is this identity currently in identity.sync.slots? */
  async function isIdentityInSlots(identityId) {
    const slots = savedSlotIds();
    if (slots) return slots.includes(identityId);
    const defaultId = await defaultIdentityId();
    return identityId === defaultId;
  }

  /** Classify saved slots into valid ids + orphans (missing/disabled identities). */
  async function classifySlots() {
    const pool = requirePool();
    const defaultId = await defaultIdentityId();
    const slots = savedSlotIds();
    const ids = slots || [defaultId];
    const valid = [];
    const orphans = [];
    for (const identityId of ids) {
      let summary = null;
      try {
        summary = await pool.get(identityId);
      } catch {
        summary = null;
      }
      if (!summary) {
        orphans.push({ identityId, deviceId: null, deviceName: null, reason: 'missing' });
        continue;
      }
      if (summary.enabled !== true) {
        orphans.push({
          identityId,
          deviceId: summary.deviceId ?? null,
          deviceName: summary.deviceName ?? null,
          reason: 'disabled'
        });
        continue;
      }
      valid.push(identityId);
    }
    return { defaultId, valid, orphans };
  }

  /** Best-effort logout of one identity's server device; never throws. */
  async function logoutIdentityDeviceBestEffort(identityId) {
    try {
      const pool = requirePool();
      let summary = null;
      try {
        summary = await pool.get(identityId);
      } catch {
        summary = null;
      }
      const deviceId = summary?.deviceId || null;
      if (!deviceId) return { ok: false, reason: 'identity_missing' };
      const { syncClient } = await login();
      if (typeof syncClient.logoutDevices === 'function') {
        await syncClient.logoutDevices([deviceId]);
      } else {
        await syncClient.logoutDevice(deviceId);
        sessionCache = null;
      }
      return { ok: true, deviceId };
    } catch (error) {
      const mapped = mapSyncError(error, 'register');
      if (mapped.code === 'sync_rate_limited') rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      if (mapped.status === 401) sessionCache = null;
      logger?.warn?.('[sync-devices] logout device for identity failed (best-effort)', {
        identityId,
        error: mapped.message,
        code: mapped.code
      });
      return { ok: false, reason: mapped.code || 'error', error: mapped.message };
    }
  }

  /**
   * Remove one identity from identity.sync.slots (optionally logout its device first).
   * Used by force delete / force disable.
   */
  async function removeIdentityFromSlots(identityId, { logout = true } = {}) {
    const slots = savedSlotIds();
    if (!slots || !slots.includes(identityId)) return { removed: false, logout: null };
    const logoutResult = logout ? await logoutIdentityDeviceBestEffort(identityId) : null;
    await persistSlotIds(slots.filter((id) => id !== identityId));
    return { removed: true, logout: logoutResult };
  }

  /** Defence-in-depth: drop every reference to a deleted identity from slots. */
  async function cleanupSlotsForIdentity(identityId) {
    return removeIdentityFromSlots(identityId, { logout: false });
  }

  /** Logout + drop orphan slots (missing/disabled identities). */
  async function reconcileSlots() {
    const classified = await classifySlots();
    const loggedOut = [];
    for (const orphan of classified.orphans) {
      if (!orphan.deviceId) continue;
      const result = await logoutIdentityDeviceBestEffort(orphan.identityId);
      if (result.ok) loggedOut.push({ identityId: orphan.identityId, deviceId: orphan.deviceId });
    }
    await persistSlotIds(classified.valid);
    return { ...classified, loggedOut };
  }

  function identityIdForServerDevice(device, poolIdentities) {
    if (!device || typeof device !== 'object') return null;
    const byId = poolIdentities.find((item) => item.deviceId === device.id);
    if (byId) return byId.id;
    if (device.name) {
      const byName = poolIdentities.find((item) => item.deviceName === device.name);
      if (byName) return byName.id;
    }
    return null;
  }

  async function listServerDevicesDetailed() {
    // Pool is optional here: server-devices works in single-identity setups too.
    const poolIdentities = identities?.list?.() || [];
    const device = await syncDevice();
    const red = { deviceId: device.deviceId, deviceName: device.deviceName };
    const JWE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    const readable = (value) => (typeof value === 'string' && value && !JWE_RE.test(value) ? value : null);
    const shape = (device) => ({
      id: device?.id ?? null,
      name: readable(device?.name),
      type: readable(device?.type),
      credential_id: device?.credential_id ?? null,
      jwt_iat: device?.jwt_iat ?? null,
      current: device?.current === true || device?.id === red.deviceId,
      primary: device?.id === red.deviceId,
      matchedIdentityId: identityIdForServerDevice(device, poolIdentities)
    });

    // v2.13: after the user removes this gateway from the DuckDuckGo device list we set
    // registered=false and remember the remaining devices. Read-only listings then serve that
    // cache instead of logging in — a fresh /login would immediately re-create our device
    // entry and make the removal look like it silently failed.
    const cachedServer = serverView();
    if (cachedServer.registered === false && cachedServer.devices.length > 0) {
      const cached = cachedServer.devices.map((device) => shape(device));
      return {
        devices: cached,
        server: { ...cachedServer, lastLoginAt: cachedServer.lastLoginAt ?? null },
        currentDeviceId: red.deviceId,
        primaryDeviceId: red.deviceId,
        total: cached.length,
        cached: true
      };
    }

    const { syncClient, session } = await login();
    let raw = [];
    try {
      raw = typeof syncClient.listDevicesDetailed === 'function'
        ? await syncClient.listDevicesDetailed()
        : await syncClient.listDevices();
    } catch (error) {
      throw handleSyncFailure(error, 'login');
    }
    const list = (Array.isArray(raw) ? raw : raw?.devices || []).map((device) => ({
      ...shape(device),
      current: device?.current === true || device?.id === red.deviceId || device?.id === session?.deviceId,
      // v2.15: 主设备 = 本网关（默认身份）注册的那台设备，UI 用它显示「主设备」标记
      primary: device?.id === red.deviceId
    }));
    return {
      devices: list,
      server: { ...serverView(), lastLoginAt: Date.now() },
      currentDeviceId: red.deviceId,
      primaryDeviceId: red.deviceId,
      total: list.length
    };
  }

  function buildSlots(identityIds, serverDevices) {
    const pool = requirePool();
    return identityIds.map((identityId) => {
      const summary = pool.get?.(identityId);
      if (!summary) return null;
      const serverDevice = serverDevices.find((device) => device.id === summary.deviceId);
      return {
        identityId,
        deviceId: summary.deviceId,
        deviceName: summary.deviceName ?? null,
        type: TYPE,
        serverDeviceId: serverDevice?.id ?? null,
        registered: Boolean(serverDevice),
        matchedIdentityId: serverDevice?.matchedIdentityId ?? identityId
      };
    }).filter(Boolean);
  }

  async function getDeviceSlots({ reconcile = false } = {}) {
    const classified = await classifySlots();
    let { valid, orphans } = classified;
    let reconciled = null;
    if (reconcile && orphans.length > 0) {
      reconciled = { loggedOut: [], cleaned: [] };
      for (const orphan of orphans) {
        if (orphan.deviceId) {
          const result = await logoutIdentityDeviceBestEffort(orphan.identityId);
          if (result.ok) reconciled.loggedOut.push({ identityId: orphan.identityId, deviceId: orphan.deviceId });
        }
        reconciled.cleaned.push(orphan.identityId);
      }
      await persistSlotIds(valid);
      const reclassified = await classifySlots();
      valid = reclassified.valid;
      orphans = reclassified.orphans;
    }
    const detailed = await listServerDevicesDetailed();
    return {
      defaultIdentityId: classified.defaultId,
      identityIds: valid,
      slots: buildSlots(valid, detailed.devices),
      serverDevices: detailed.devices,
      server: detailed.server,
      orphans,
      ...(reconciled ? { reconciled } : {})
    };
  }

  async function setDeviceSlots(nextIds) {
    const pool = requirePool();
    if (!Array.isArray(nextIds) || nextIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new OpenAIError('"identityIds" must be an array of identity id strings', {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_identity',
        param: 'identityIds'
      });
    }
    const identityIds = [...new Set(nextIds.map((id) => id.trim()))];
    const summaries = [];
    for (const identityId of identityIds) {
      let summary;
      try {
        summary = await pool.get(identityId);
      } catch {
        summary = null;
      }
      if (!summary) {
        throw new OpenAIError(`identity "${identityId}" does not exist`, {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_identity',
          param: 'identityIds'
        });
      }
      if (summary.enabled !== true) {
        throw new OpenAIError(`identity "${identityId}" is disabled`, {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_identity',
          param: 'identityIds',
          hint: 'enable the identity before adding it to device slots'
        });
      }
      summaries.push(summary);
    }
    const defaultId = await defaultIdentityId();
    // v2.13: the default identity is seeded into the slots by default, but the user may
    // remove it from the device list (its only special role is holding the phone pairing
    // key). Removing it logs the device out of DuckDuckGo while keeping identity + account.
    // Decide add/remove from the *actual* server device list (not just saved slots):
    // the default identity is a slot by default but may not be registered yet.
    // Removal candidates are the union of server-matched identities and entities that
    // were in the previously saved slots (server list can lag / be cached).
    const before = await listServerDevicesDetailed();
    const nextSet = new Set(identityIds);
    const previous = savedSlotIds() || [defaultId];
    const added = summaries.filter((item) => !before.devices.some((device) => device.id === item.deviceId));
    const removedIdentityIds = new Set([
      ...previous.filter((id) => !nextSet.has(id)),
      ...before.devices.filter((device) => device.matchedIdentityId && !nextSet.has(device.matchedIdentityId)).map((device) => device.matchedIdentityId)
    ]);
    const removedDeviceIds = [];
    for (const removedId of removedIdentityIds) {
      let summary = null;
      try {
        summary = await pool.get(removedId);
      } catch {
        summary = null; // ghost/orphan saved slot: just drop it, never fail the save
      }
      if (summary?.deviceId) removedDeviceIds.push(summary.deviceId);
    }

    const { syncClient } = await login();
    if (added.length > 0) {
      try {
        if (typeof syncClient.registerDevices === 'function') {
          await syncClient.registerDevices(
            added.map((item) => ({ deviceId: item.deviceId, name: item.deviceName, deviceName: item.deviceName, type: TYPE }))
          );
        } else {
          for (const item of added) {
            await syncClient.registerDevice({ deviceId: item.deviceId, name: item.deviceName, type: TYPE });
          }
        }
      } catch (error) {
        throw handleSyncFailure(error, 'register');
      }
    }
    if (removedDeviceIds.length > 0) {
      // Best-effort logout: `/logout-device` invalidates the caller's sync token as well, so
      // sequential logouts need a fresh login in between. A 401 here means the device was
      // already logged out — never fail the slot save because of that.
      for (const deviceId of removedDeviceIds) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await login();
            await syncClient.logoutDevice(deviceId);
            logger?.info?.('[admin:sync] device logged out from slots', { deviceId, attempt });
            break;
          } catch (error) {
            const mapped = mapSyncError(error, 'register');
            if (mapped.status === 429) {
              rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              throw mapped;
            }
            if (['sync_unauthorized', 'sync_not_logged_in'].includes(mapped.code)) {
              sessionCache = null;
              if (attempt === 1) {
                logger?.warn?.('[admin:sync] device logout skipped (already logged out)', { deviceId });
                break;
              }
              continue;
            }
            logger?.warn?.('[admin:sync] device logout failed (kept slot change)', { deviceId, code: mapped.code });
            break;
          }
        }
      }
    }
    await persistSlotIds(identityIds);
    // v2.13: when the default identity was removed from the slots we just logged its device
    // out — mark the account as unregistered (keeping identity + account + recovery code) and
    // remember the remaining devices. Do NOT re-login here: a fresh /login would recreate our
    // device entry and make the removal silently undo itself.
    if (!nextSet.has(defaultId) && removedDeviceIds.length > 0) {
      const removedSet = new Set(removedDeviceIds);
      const remaining = serverView().devices.filter((device) => !removedSet.has(device.id));
      await persistServer({ registered: false, serverDeviceId: null, lastError: null, devices: remaining });
      sessionCache = null;
      const slots = buildSlots(identityIds, remaining);
      return {
        ok: true,
        defaultIdentityId: defaultId,
        identityIds,
        slots,
        serverDevices: remaining,
        server: serverView(),
        currentDeviceRemoved: !nextSet.has(defaultId)
      };
    }
    const detailed = await listServerDevicesDetailed();
    return {
      ok: true,
      defaultIdentityId: defaultId,
      identityIds,
      slots: buildSlots(identityIds, detailed.devices),
      serverDevices: detailed.devices,
      server: detailed.server
    };
  }

  return {
    get deviceName() {
      return deviceName();
    },

    async getAccountSource() {
      if (!pairingStore || typeof pairingStore.getStatus !== 'function') return null;
      try {
        const status = await pairingStore.getStatus();
        return status && typeof status.source === 'string' ? status.source : null;
      } catch {
        return null;
      }
    },

    getServerSummary() {
      return serverView();
    },

    async ensureDeviceName() {
      return ensureDeviceName({ identity, config, store, logger });
    },

    async registerDevice() {
      const id = requireIdentity();
      await ensureDeviceName({ identity: id, config, store, logger });
      const device = await syncDevice();
      const red = { deviceId: device.deviceId, deviceName: device.deviceName };
      const name = deviceName();
      if (!name) {
        throw new OpenAIError('device name is not available', {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_device'
        });
      }
      const { syncClient, userId } = await login();
      let serverDevice;
      try {
        serverDevice = await syncClient.registerDevice({
          deviceId: red.deviceId,
          name,
          type: TYPE
        });
      } catch (error) {
        throw handleSyncFailure(error, 'register');
      }
      let devices = [];
      try {
        const listed = await syncClient.listDevices();
        devices = (Array.isArray(listed) ? listed : listed?.devices || []).map((device) => ({
          ...sanitizeDevice(device),
          current: device?.id === red.deviceId
        }));
      } catch (error) {
        logger?.warn?.('sync device list after register failed', { error: error.message });
      }
      if (Array.isArray(serverDevice?.devices) && serverDevice.devices.length > devices.length) {
        devices = serverDevice.devices.map((device) => ({
          ...sanitizeDevice(device),
          current: device?.id === red.deviceId
        }));
      }
      devices = ensureCurrentDevice(devices, red, name);
      const server = {
        userId,
        deviceId: red.deviceId,
        deviceName: name,
        serverDeviceId: serverDevice?.id ?? red.deviceId,
        registeredAt: Date.now(),
        lastLoginAt: Date.now(),
        devices,
        lastError: null
      };
      await persistServer(server);
      lastError = null;
      return {
        ok: true,
        serverDevice: { ...sanitizeDevice(serverDevice || { id: red.deviceId, name, type: TYPE }), current: true },
        devices,
        server: serverView()
      };
    },

    async listDevices() {
      return listDevices();
    },

    async getDeviceSlots(options = {}) {
      return getDeviceSlots(options);
    },

    async isIdentityInSlots(identityId) {
      return isIdentityInSlots(identityId);
    },

    async removeIdentityFromSlots(identityId, options = {}) {
      return removeIdentityFromSlots(identityId, options);
    },

    async cleanupSlotsForIdentity(identityId) {
      return cleanupSlotsForIdentity(identityId);
    },

    async reconcileSlots() {
      return reconcileSlots();
    },

    async setDeviceSlots(identityIds) {
      return setDeviceSlots(identityIds);
    },

    async listServerDevicesDetailed() {
      return listServerDevicesDetailed();
    },

    /**
     * v2.17: "Sync This Device Only" — create a brand-new DuckDuckGo Sync account for this gateway
     * only, keep the derived official recovery code locally and register DuckAI@main in it.
     * (duck.ai: signUpForPairing -> POST /sync/signup)
     */
    async createOwnAccount() {
      const id = requireIdentity();
      await ensureDeviceName({ identity: id, config, store, logger });
      const device = await syncDevice();
      const red = { deviceId: device.deviceId, deviceName: device.deviceName };
      const syncClient = await getClient();
      if (typeof syncClient.signup !== 'function') {
        throw new OpenAIError('Sync client does not support account creation', {
          status: 503,
          type: 'sync_transport_unavailable',
          code: 'sync_signup_unsupported'
        });
      }
      let created;
      try {
        created = await syncClient.signup({
          deviceId: red.deviceId,
          deviceName: deviceName(),
          deviceType: TYPE
        });
      } catch (error) {
        throw handleSyncFailure(error, 'register');
      }
      // Persist our own recovery code ("Sync This Device Only" keeps it on the gateway).
      let persistedRecoveryCode = false;
      if (pairingStore && typeof pairingStore.setRecoveryCode === 'function') {
        await pairingStore.setRecoveryCode(created.recoveryCode, { source: 'self' });
        persistedRecoveryCode = true;
      }
      // Reset cached server state; the new account has no devices yet.
      await persistServer({
        userId: created.userId || null,
        serverDeviceId: null,
        registered: false,
        registeredAt: null,
        lastLoginAt: null,
        lastError: null,
        devices: []
      });
      sessionCache = null;
      try {
        const raw = id.getRaw?.() || {};
        await id.importIdentity({
          version: raw.version,
          identity: { ...raw, sync: { ...(raw.sync || {}), slots: [await defaultIdentityId()] } }
        });
      } catch (error) {
        logger?.warn?.('[admin:sync] create-own-account: failed to seed device slots', { error: error.message });
      }
      const registered = await this.registerDevice().catch((error) => {
        logger?.warn?.('[admin:sync] create-own-account: device registration failed', { error: error.message });
        return null;
      });
      logger?.info?.('[admin:sync] created own sync account (Sync This Device Only)', {
        userId: created.userId,
        deviceName: deviceName(),
        persistedRecoveryCode
      });
      return {
        ok: true,
        mode: 'own-account',
        userId: created.userId,
        deviceName: deviceName(),
        recoveryCodeStored: persistedRecoveryCode,
        registered: registered?.server?.registered === true
      };
    },

    /**
     * v2.16: delete the current Sync & Backup data (DuckDuckGo in-app "Delete Sync & Backup
     * data"): logs every gateway device out of the account, forgets the official recovery code
     * and clears the cached server state. The anonymous identity (journeyId / fingerprint) and
     * the local account credentials survive — the device simply stops syncing.
     */
    async deleteSyncData() {
      const id = requireIdentity();
      const device = await syncDevice();
      const red = { deviceId: device.deviceId, deviceName: device.deviceName };
      const cached = serverView();
      const deviceIds = new Set();
      for (const device of cached.devices || []) {
        if (device && device.id) deviceIds.add(device.id);
      }
      deviceIds.add(red.deviceId);

      const deletedDevices = [];
      for (const deviceId of deviceIds) {
        try {
          // A logout invalidates the token, so a fresh login is attempted before each device.
          await login().catch(() => null);
          const syncClient = await getClient();
          if (typeof syncClient.logoutDevice !== 'function') continue;
          await syncClient.logoutDevice(deviceId);
          deletedDevices.push(deviceId);
        } catch (error) {
          logger?.warn?.('[admin:sync] delete-data: device logout failed (best effort)', {
            deviceId,
            code: error?.code || error?.message
          });
        } finally {
          sessionCache = null;
        }
      }

      let clearedRecoveryCode = false;
      if (pairingStore && typeof pairingStore.clearRecoveryCode === 'function') {
        try {
          await pairingStore.clearRecoveryCode();
          clearedRecoveryCode = true;
        } catch (error) {
          logger?.warn?.('[admin:sync] delete-data: failed to clear official recovery code', { error: error.message });
        }
      }

      // Clear the cached server block and the device slots (identity itself is kept).
      await persistServer({
        userId: null,
        serverDeviceId: null,
        registered: false,
        registeredAt: null,
        lastLoginAt: null,
        lastError: null,
        devices: []
      });
      try {
        const raw = id.getRaw?.() || {};
        await id.importIdentity({
          version: raw.version,
          identity: { ...raw, sync: { ...(raw.sync || {}), slots: [] } }
        });
      } catch (error) {
        logger?.warn?.('[admin:sync] delete-data: failed to clear device slots', { error: error.message });
      }
      sessionCache = null;
      logger?.info?.('[admin:sync] sync & backup data deleted', {
        deletedDevices: deletedDevices.length,
        clearedRecoveryCode
      });
      return { ok: true, deletedDevices, clearedRecoveryCode, mode: 'backup' };
    },

    async deleteDevice(deviceId, options = {}) {
      if (typeof deviceId !== 'string' || !deviceId.trim()) {
        throw new OpenAIError('device id is required', {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_device',
          param: 'id'
        });
      }
      const id = requireIdentity();
      // v2.18: "current" must match what the UI/API reports (`syncDevice()` = pool default
      // identity), otherwise deleting our own device is not recognised as the current one.
      const syncDev = await syncDevice();
      const red = { deviceId: syncDev.deviceId, deviceName: syncDev.deviceName };
      const confirm = options.confirm === true;
      const isCurrent = deviceId === red.deviceId;

      // Safety: never delete a device that is not actually in the account. Previously any id
      // returned 200 and forwarded a /logout-device call, which (together with a destructive
      // page-check test) removed a user's phone from their account.
      let known = null;
      try {
        const detailed = await listServerDevicesDetailed();
        known = (detailed.devices || []).find((device) => device.id === deviceId) || null;
      } catch (error) {
        // If the account cannot be reached we refuse the delete instead of guessing.
        throw handleSyncFailure(error, 'login');
      }
      if (!known) {
        throw new OpenAIError(`device "${deviceId}" is not in the DuckDuckGo device list`, {
          status: 404,
          type: 'invalid_request_error',
          code: 'invalid_device',
          param: 'id'
        });
      }

      if (isCurrent && !confirm) {
        throw new OpenAIError('deleting the current device requires confirm/force', {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_device',
          param: 'confirm',
          hint: 'retry with ?force=true (or {"confirm":true}) — identity, account and recovery code are kept'
        });
      }

      const { syncClient } = await login();
      try {
        await syncClient.logoutDevice(deviceId);
      } catch (error) {
        throw handleSyncFailure(error, 'register');
      }
      logger?.info?.('[admin:sync] device logged out', {
        deviceId,
        deviceName: known.name ?? null,
        credentialId: known.credential_id ?? null,
        current: isCurrent,
        reason: options.reason || 'admin_delete'
      });

      const cached = serverView().devices.filter((device) => device.id !== deviceId);
      const patch = { devices: cached };
      if (isCurrent) {
        // Removing the current device must not destroy the identity or the account itself:
        // mark the slot unregistered so it can be re-registered later.
        patch.registered = false;
        patch.serverDeviceId = null;
        patch.lastError = null;
      }
      await persistServer(patch);
      if (isCurrent) {
        try {
          const raw = id.getRaw?.() || {};
          const currentSlots = Array.isArray(raw.sync?.slots) ? raw.sync.slots : [];
          const defaultId = await defaultIdentityId().catch(() => 'id_default');
          const removedIds = new Set([red.deviceId, defaultId, 'id_default']);
          const nextSlots = currentSlots
            .map((item) => (typeof item === 'string' ? item : item && item.identityId))
            .filter((item) => typeof item === 'string' && item && !removedIds.has(item));
          await id.importIdentity({
            version: raw.version,
            identity: { ...raw, sync: { ...(raw.sync || {}), slots: nextSlots } }
          });
        } catch (error) {
          logger?.warn?.('[admin:sync] failed to clear device slot after logout', { error: error.message });
        }
      }
      return { ok: true, deletedId: deviceId, devices: cached, current: isCurrent, removedDevice: true };
    },

    async autoRegister() {
      try {
        await ensureDeviceName({ identity, config, store, logger });
        const result = await this.registerDevice();
        logger?.info?.('[sync-devices] auto registration after pairing completed', {
          userId: result?.server?.userId ?? null,
          deviceName: result?.server?.deviceName ?? null
        });
        return result;
      } catch (error) {
        lastError = error?.message || String(error);
        logger?.warn?.('[sync-devices] auto registration after pairing failed (non-fatal)', {
          error: lastError,
          code: error?.code ?? null
        });
        return null;
      }
    },

    async close() {
      try {
        await client?.close?.();
      } catch {
        // best effort
      }
      client = null;
    }
  };
}

/** Create + persist the default device name at startup. */
export async function bootstrapDeviceIdentity(options = {}) {
  try {
    return await ensureDeviceName(options);
  } catch (error) {
    options.logger?.warn?.('deviceName bootstrap failed', { error: error.message });
    return null;
  }
}

export { DEVICE_NAME_RE };
