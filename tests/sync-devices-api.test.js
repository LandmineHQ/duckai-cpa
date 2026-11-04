/**
 * v2.8 Sync 设备注册 — Admin HTTP（src/admin/identity-routes.js + src/http/server.js）。
 *
 * 覆盖：
 *   - `POST /admin/api/sync/register-device`：无官方码 400 recovery_code_not_configured；
 *     sync 服务未注入 503 sync_transport_unavailable + hint；成功 200 {ok,server:{...}}
 *   - `GET /admin/api/sync/server-devices`：devices/currentDeviceId/total/server，current 标记、脱敏
 *   - `DELETE /admin/api/sync/server-devices/:id`：当前设备 400 invalid_device；其它设备 logout
 *   - `GET /admin/api/sync`：默认身份 sync.deviceName=DuckAI@main 且稳定；config.identity.deviceName 自定义生效
 *   - `POST /admin/api/identity/rotate`：identityLost:true + note（不可恢复/身份丢失）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { withServer, adminRequest, makeConfig } from './helpers/test-server.js';
import { createPairingStore } from '../src/admin/pairing.js';
import { createSyncDeviceService } from '../src/admin/sync-devices.js';

const OFFICIAL_CODE = Buffer.from(
  JSON.stringify({ recovery: { user_id: 'server-user-1', secret: 'server-secret-1' } }),
  'utf8'
).toString('base64url');

function tempDataDir(prefix = 'duckai-qa-sync-devices-api') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function fakeSyncClient(overrides = {}) {
  const calls = { login: 0, register: [], list: 0, logout: [], closed: 0 };
  const client = {
    async login(params = {}) {
      calls.login += 1;
      calls.lastLogin = params;
      if (overrides.loginError) throw overrides.loginError;
      return { ok: true, userId: 'server-user-1', token: 'jwt-1', deviceId: params.deviceId ?? null };
    },
    async registerDevice(params = {}) {
      calls.register.push(params);
      if (overrides.registerError) throw overrides.registerError;
      calls.lastRegistered = { id: params.deviceId, name: params.name, type: params.type };
      return { id: params.deviceId, name: params.name, type: params.type, registeredAt: Date.now() };
    },
    async listDevices() {
      calls.list += 1;
      if (overrides.listError) throw overrides.listError;
      const selfId = calls.lastLogin?.deviceId || calls.lastRegistered?.id || 'self-device';
      const self = { id: selfId, name: calls.lastRegistered?.name || 'DuckCPA@abcd', type: 'browser' };
      const extras = (overrides.devices || [{ id: 'dev-other', name: '旧手机', type: 'browser' }]).filter(
        (device) => device.id !== selfId
      );
      return [self, ...extras];
    },
    async logoutDevice(id) {
      calls.logout.push(id);
      return { ok: true };
    },
    async close() {
      calls.closed += 1;
    }
  };
  return { client, calls };
}

/**
 * 启动带 syncDevices 的测试网关，执行 assert 后清理。
 * @param {{ overrides?: Record<string, any>, config?: Record<string, any>, recoveryCode?: string|null, assert?: Function }} options
 */
async function runDeviceAdmin(options = {}) {
  const {
    overrides = {},
    config = {},
    recoveryCode = OFFICIAL_CODE,
    legacyDeviceName = null,
    bootstrap = true,
    assert: assertions = null
  } = options;
  const dataDir = await tempDataDir();
  const handle = { dataDir, fake: null, pairingStore: null };
  try {
    await withServer(
      {
        identity: true,
        pool: true,
        dataDir,
        config: makeConfig(config),
        syncDevices: async ({ identity, identityPool, config: runtimeConfig }) => {
          if (legacyDeviceName) await identity.setDeviceName(legacyDeviceName);
          const pairingStore = await createPairingStore({ dataDir });
          if (recoveryCode) await pairingStore.setRecoveryCode(recoveryCode);
          const fake = fakeSyncClient(overrides);
          const service = createSyncDeviceService({
            identity,
            identities: identityPool,
            pairingStore,
            logger: null,
            config: runtimeConfig || config,
            syncClientFactory: async () => fake.client
          });
          handle.fake = fake;
          handle.pairingStore = pairingStore;
          return service;
        }
      },
      async (env) => {
        // 模拟 src/index.js 启动时的 bootstrapDeviceIdentity（生产启动路径）；迁移用例关闭以验证懒迁移
        if (bootstrap) await env.syncDevices?.ensureDeviceName?.();
        if (assertions) await assertions({ env, handle });
      }
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  return handle;
}

test('未注入 syncDevices → register-device/server-devices 503 sync_transport_unavailable + hint', async () => {
  await withServer({}, async ({ baseUrl }) => {
    for (const [pathName, method] of [
      ['/admin/api/sync/register-device', 'POST'],
      ['/admin/api/sync/server-devices', 'GET']
    ]) {
      const res = await adminRequest(baseUrl, pathName, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 503, `${pathName}: ${res.text}`);
      assert.equal(res.json.error.code, 'sync_transport_unavailable');
      assert.equal(typeof res.json.error.hint, 'string');
    }
  });
});

test('register-device：无官方码 400；成功 200 返回 server/devices；server-devices current 标记且脱敏', async () => {
  await runDeviceAdmin({
    assert: async ({ env, handle }) => {
      const { baseUrl } = env;
      await handle.pairingStore.clearRecoveryCode();
      const denied = await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(denied.status, 400, denied.text);
      assert.equal(denied.json.error.code, 'recovery_code_not_configured');
      const listedDenied = await adminRequest(baseUrl, '/admin/api/sync/server-devices');
      assert.equal(listedDenied.status, 400, listedDenied.text);

      await handle.pairingStore.setRecoveryCode(OFFICIAL_CODE);
      const registered = await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(registered.status, 200, registered.text);
      assert.equal(registered.json.ok, true);
      assert.ok(registered.json.server, '应返回 server 摘要');
      assert.equal(registered.json.server.registered, true);
      assert.equal(registered.json.server.userId, 'server-user-1');
      assert.equal(registered.json.server.deviceName, 'DuckAI@main');
      assert.equal(handle.fake.calls.register.length, 1);
      assert.equal(handle.fake.calls.register[0].type, 'browser');

      const listed = await adminRequest(baseUrl, '/admin/api/sync/server-devices');
      assert.equal(listed.status, 200, listed.text);
      assert.ok(Array.isArray(listed.json.devices));
      assert.equal(typeof listed.json.currentDeviceId, 'string');
      assert.equal(listed.json.total, listed.json.devices.length);
      const current = listed.json.devices.filter((device) => device.current === true);
      assert.equal(current.length, 1, `应恰有一个 current（实际 ${current.length}）`);
      assert.equal(current[0].id, listed.json.currentDeviceId);
      assert.ok(!listed.text.includes('jwt-1'), 'server-devices 不应泄漏 token');
      assert.ok(!('info' in (listed.json.devices[0] || {})), 'server-devices 不应返回 info 密文');
      assert.ok(!('encrypted_private_key' in (listed.json.devices[0] || {})), '不应返回私钥');
    }
  });
});

test('DELETE server-devices/:id：当前设备 400 invalid_device；其它设备调用 logout', async () => {
  await runDeviceAdmin({
    overrides: { devices: [{ id: 'dev-other', name: '旧手机', type: 'browser' }] },
    assert: async ({ env, handle }) => {
      const { baseUrl } = env;
      await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      const currentId = env.identityStore.getRedacted().deviceId;
      const denied = await adminRequest(baseUrl, `/admin/api/sync/server-devices/${encodeURIComponent(currentId)}`, {
        method: 'DELETE'
      });
      assert.equal(denied.status, 400, denied.text);
      assert.equal(denied.json.error.code, 'invalid_device');

      const removed = await adminRequest(baseUrl, '/admin/api/sync/server-devices/dev-other', { method: 'DELETE' });
      assert.equal(removed.status, 200, removed.text);
      assert.equal(removed.json.ok, true);
      assert.deepEqual(handle.fake.calls.logout, ['dev-other']);
    }
  });
});

test('GET /admin/api/sync：deviceName 默认 DuckAI@main 稳定；config.identity.deviceName 自定义生效', async () => {
  await runDeviceAdmin({
    assert: async ({ env }) => {
      const { baseUrl } = env;
      const first = await adminRequest(baseUrl, '/admin/api/sync');
      assert.equal(first.status, 200, first.text);
      const name = first.json.sync.deviceName;
      assert.equal(name, 'DuckAI@main', `默认设备名应 DuckAI@main（实际 ${name}）`);
      const second = await adminRequest(baseUrl, '/admin/api/sync');
      assert.equal(second.json.sync.deviceName, name, 'deviceName 应稳定');
      assert.equal(first.json.sync.server.registered, false);

      const updated = await adminRequest(baseUrl, '/admin/api/config', {
        method: 'PUT',
        body: { identity: { deviceName: 'QA Custom Device' } }
      });
      assert.equal(updated.status, 200, updated.text);
      const after = await adminRequest(baseUrl, '/admin/api/sync');
      assert.equal(after.json.sync.deviceName, 'QA Custom Device', '自定义 deviceName 应生效');

      const registered = await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(registered.status, 200, registered.text);
      assert.equal(registered.json.server.deviceName, 'QA Custom Device');
    }
  });
});

test('POST /admin/api/identity/rotate：identityLost:true + note（不可恢复），deviceId 变更', async () => {
  await runDeviceAdmin({
    assert: async ({ env }) => {
      const { baseUrl } = env;
      const before = await adminRequest(baseUrl, '/admin/api/identity');
      const beforeDeviceId = before.json.identity.deviceId;
      assert.equal(before.json.identity.deviceName, 'DuckAI@main');

      const rotated = await adminRequest(baseUrl, '/admin/api/identity/rotate', { method: 'POST', body: { scope: 'all' } });
      assert.equal(rotated.status, 200, rotated.text);
      assert.equal(rotated.json.ok, true);
      assert.equal(rotated.json.identityLost, true);
      assert.equal(typeof rotated.json.note, 'string');
      assert.match(rotated.json.note, /无法恢复|不可恢复|身份丢失/);
      assert.notEqual(rotated.json.identity.deviceId, beforeDeviceId, 'deviceId 应变化');
      assert.equal(rotated.json.identity.deviceName, 'DuckAI@main', 'rotate 后默认身份名应保持 DuckAI@main');
    }
  });
});

test('错误映射：登录网络失败 → 503 sync_transport_unavailable + hint', async () => {
  await runDeviceAdmin({
    overrides: { loginError: Object.assign(new Error('offline'), { code: 'sync_transport_unavailable' }) },
    assert: async ({ env }) => {
      const res = await adminRequest(env.baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(res.status, 503, res.text);
      assert.equal(res.json.error.code, 'sync_transport_unavailable');
      assert.equal(typeof res.json.error.hint, 'string');
    }
  });
});

test('限流：Sync 418 → HTTP 429 sync_rate_limited + Retry-After:120；cooldown 内不再打上游', async () => {
  await runDeviceAdmin({
    overrides: { loginError: Object.assign(new Error('anti-abuse'), { httpStatus: 418 }) },
    assert: async ({ env, handle }) => {
      const { baseUrl } = env;
      const denied = await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(denied.status, 429, denied.text);
      assert.equal(denied.json.error.code, 'sync_rate_limited');
      assert.equal(denied.json.error.type, 'rate_limit_error');
      assert.equal(typeof denied.json.error.hint, 'string');
      assert.equal(denied.headers.get('retry-after'), '120', '应带 Retry-After:120');
      assert.equal(handle.fake.calls.login, 1);

      const again = await adminRequest(baseUrl, '/admin/api/sync/register-device', { method: 'POST', body: {} });
      assert.equal(again.status, 429);
      const listed = await adminRequest(baseUrl, '/admin/api/sync/server-devices');
      assert.equal(listed.status, 429, 'cooldown 内 server-devices 应 429（无缓存时）');
      const removed = await adminRequest(baseUrl, '/admin/api/sync/server-devices/dev-other', { method: 'DELETE' });
      assert.equal(removed.status, 429, 'cooldown 内 delete 应 429');
      assert.equal(handle.fake.calls.login, 1, 'cooldown 内不应再次请求上游');
    }
  });
});

test('deviceName 懒迁移：直连 createServer 未 bootstrap 时 GET /sync 自动迁移为 DuckAI@main', async () => {
  await runDeviceAdmin({
    bootstrap: false,
    legacyDeviceName: 'DuckAI CPA @ qa-host',
    assert: async ({ env }) => {
      const { baseUrl } = env;
      const first = await adminRequest(baseUrl, '/admin/api/sync');
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.sync.deviceName, 'DuckAI@main', '应懒迁移为 DuckAI@main（实际 ' + first.json.sync.deviceName + '）');
      const identityRes = await adminRequest(baseUrl, '/admin/api/identity');
      assert.equal(identityRes.json.identity.deviceName, first.json.sync.deviceName, 'identity.deviceName 应同步迁移');
    }
  });
});
