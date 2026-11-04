/**
 * v2.8 Sync 设备注册 — Admin service 层（src/admin/sync-devices.js）。
 *
 * 用真实 IdentityStore + PairingStore + 注入 fake syncClientFactory，覆盖：
 *   - 默认身份设备名 DuckAI@main（其它身份 DuckCPA@<4hex>）；稳定/自定义 config 生效
 *   - registerDevice：无官方码 → 400 `recovery_code_not_configured`；成功 → 服务端设备持久化
 *     （identity.sync.server：userId/deviceId/deviceName/serverDeviceId/devices/current）
 *   - listDevices：current 标记、持久化 lastLoginAt
 *   - deleteDevice：当前设备拒绝（400 invalid_device）、其它设备调用 logoutDevice
 *   - autoRegister：成功注册 / 失败非致命（lastError 记录）
 *   - 错误映射：401 → sync_unauthorized；网络 → 503 sync_transport_unavailable + hint；其它 → 502 sync_register_failed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createIdentityStore, IdentityError } from '../src/duck/identity.js';
import { createPairingStore } from '../src/admin/pairing.js';
import { createSyncDeviceService, defaultDeviceName, DEVICE_NAME_RE } from '../src/admin/sync-devices.js';

const OFFICIAL_CODE = Buffer.from(
  JSON.stringify({ recovery: { user_id: 'server-user-1', secret: 'server-secret-1' } }),
  'utf8'
).toString('base64url');

async function tempDataDir(prefix = 'duckai-qa-sync-devices') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function fakeSyncClient(overrides = {}) {
  const calls = { login: 0, register: [], list: 0, logout: [], closed: 0 };
  const client = {
    async login({ recoveryCode, deviceName, deviceId }) {
      calls.login += 1;
      calls.lastLogin = { recoveryCode, deviceName, deviceId };
      if (overrides.loginError) throw overrides.loginError;
      calls.loggedIn = true;
      return { userId: 'server-user-1', jwt: 'server-jwt-1', deviceId };
    },
    getStatus() {
      return { loggedIn: calls.loggedIn === true };
    },
    async registerDevice(params) {
      calls.register.push(params);
      if (overrides.registerError) throw overrides.registerError;
      return { id: params.deviceId, name: params.name, type: params.type, current: true };
    },
    async listDevices() {
      calls.list += 1;
      if (overrides.listError) throw overrides.listError;
      return overrides.devices || [{ id: 'server-dev-1', name: 'DuckCPA@abcd', type: 'browser' }];
    },
    async logoutDevice(id) {
      calls.logout.push(id);
      if (overrides.logoutError) throw overrides.logoutError;
      return { ok: true };
    },
    async close() {
      calls.closed += 1;
    }
  };
  return { client, calls };
}

async function makeService(options = {}) {
  const dataDir = options.dataDir || (await tempDataDir());
  const identity = await createIdentityStore({ dataDir, config: {} });
  const pairingStore = await createPairingStore({ dataDir });
  if (options.recoveryCode !== null) await pairingStore.setRecoveryCode(options.recoveryCode ?? OFFICIAL_CODE);
  const fake = fakeSyncClient(options.syncClientOverrides);
  const service = createSyncDeviceService({
    identity,
    pairingStore,
    logger: null,
    config: options.config || {},
    syncClientFactory: async () => fake.client
  });
  const cleanup = async () => {
    await service.close?.();
    await pairingStore.close?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };
  return { dataDir, identity, pairingStore, service, fake, cleanup };
}

test('defaultDeviceName：DuckCPA@<4hex>；ensureDeviceName 稳定且自定义 config 生效', async () => {
  assert.match(defaultDeviceName(), DEVICE_NAME_RE);
  assert.equal(DEVICE_NAME_RE.test('DuckCPA@a1b2'), true);
  assert.equal(DEVICE_NAME_RE.test('DuckCPA@a1b2c3'), false);

  const first = await makeService();
  try {
    const name = await first.service.ensureDeviceName();
    assert.equal(name, 'DuckAI@main');
    const again = await first.service.ensureDeviceName();
    assert.equal(again, name, '重复 ensureDeviceName 应稳定');
    assert.equal(first.identity.getRedacted().deviceName, name, 'deviceName 应写入 identity');
    assert.equal(first.identity.getRedacted().deviceName, name, '重启（重新读取）后仍稳定');
  } finally {
    await first.cleanup();
  }

  const custom = await makeService({ config: { identity: { deviceName: 'My QA Gateway' } } });
  try {
    const name = await custom.service.ensureDeviceName();
    assert.equal(name, 'My QA Gateway');
    assert.equal(custom.identity.getRedacted().deviceName, 'My QA Gateway');
  } finally {
    await custom.cleanup();
  }
});

test('registerDevice：无官方码 → 400 recovery_code_not_configured；成功 → 服务端设备持久化', async () => {
  // 无官方码
  {
    const env = await makeService({ recoveryCode: null });
    try {
      await assert.rejects(
        () => env.service.registerDevice(),
        (error) => {
          assert.equal(error.status, 400);
          assert.equal(error.code, 'recovery_code_not_configured');
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  }

  // 成功
  const env = await makeService();
  try {
    await env.service.ensureDeviceName();
    const result = await env.service.registerDevice();
    assert.equal(result.ok, true);
    assert.equal(env.fake.calls.login, 1);
    assert.equal(env.fake.calls.register.length, 1);
    const params = env.fake.calls.register[0];
    assert.equal(params.name, 'DuckAI@main');
    assert.equal(params.type, 'browser');
    assert.equal(params.deviceId, env.identity.getRedacted().deviceId);

    const server = env.service.getServerSummary();
    assert.equal(server.registered, true);
    assert.equal(server.userId, 'server-user-1');
    assert.equal(server.deviceName, params.name);
    assert.equal(server.deviceId, params.deviceId);
    assert.equal(Array.isArray(server.devices), true);
    assert.equal(server.lastError, null);

    // 持久化到 identity.sync.server
    const raw = env.identity.getRaw();
    assert.equal(raw.sync.server.userId, 'server-user-1');
    assert.equal(raw.sync.server.deviceName, params.name);
    assert.ok(Number.isFinite(raw.sync.server.registeredAt));

    // 再次 listDevices：current 标记
    const listed = await env.service.listDevices();
    assert.equal(listed.currentDeviceId, params.deviceId);
    assert.ok(Array.isArray(listed.devices));
    assert.ok(Number.isFinite(listed.server.lastLoginAt));
  } finally {
    await env.cleanup();
  }
});

test('listDevices：current 标记与持久化；deleteDevice：当前设备拒绝、其它设备 logout', async () => {
  const env = await makeService({
    syncClientOverrides: {
      devices: [
        { id: 'dev-self', name: 'DuckCPA@aaaa', type: 'browser' },
        { id: 'dev-old', name: '旧设备', type: 'browser' }
      ]
    }
  });
  try {
    await env.service.ensureDeviceName();
    const selfId = env.identity.getRedacted().deviceId;
    // 让 fake 列表含本机 id
    env.fake.client.listDevices = async () => [
      { id: selfId, name: env.service.deviceName, type: 'browser' },
      { id: 'dev-old', name: '旧设备', type: 'browser' }
    ];
    const listed = await env.service.listDevices();
    const self = listed.devices.find((device) => device.id === selfId);
    assert.ok(self, '列表应含本机设备');
    assert.equal(self.current, true);
    const other = listed.devices.find((device) => device.id === 'dev-old');
    assert.equal(other.current, false);

    await assert.rejects(
      () => env.service.deleteDevice(selfId),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_device');
        return true;
      }
    );
    const deleted = await env.service.deleteDevice('dev-old');
    assert.equal(deleted.ok, true);
    assert.deepEqual(env.fake.calls.logout, ['dev-old']);
  } finally {
    await env.cleanup();
  }
});

test('autoRegister：成功注册；失败非致命（lastError 记录、不抛）', async () => {
  const ok = await makeService();
  try {
    const result = await ok.service.autoRegister();
    assert.ok(result, 'autoRegister 应返回结果');
    assert.equal(ok.service.getServerSummary().registered, true);
  } finally {
    await ok.cleanup();
  }

  const failing = await makeService({ syncClientOverrides: { loginError: Object.assign(new Error('boom'), { code: 'network' }) } });
  try {
    const result = await failing.service.autoRegister();
    assert.equal(result, null);
    assert.match(String(failing.service.getServerSummary().lastError), /boom|network|Sync/i);
  } finally {
    await failing.cleanup();
  }
});

test('错误映射：401 → sync_unauthorized；网络 → 503 sync_transport_unavailable+hint；其它 → 502 sync_register_failed', async () => {
  for (const [overrides, expected] of [
    [{ loginError: Object.assign(new Error('unauthorized'), { code: 'sync_unauthorized', status: 401 }) }, { status: 401, code: 'sync_unauthorized' }],
    [{ loginError: Object.assign(new Error('offline'), { code: 'sync_transport_unavailable' }) }, { status: 503, code: 'sync_transport_unavailable' }],
    [{ registerError: Object.assign(new Error('bad'), { code: 'weird_upstream' }) }, { status: 502, code: 'sync_register_failed' }]
  ]) {
    const env = await makeService({ syncClientOverrides: overrides });
    try {
      await env.service.ensureDeviceName();
      await assert.rejects(
        () => env.service.registerDevice(),
        (error) => {
          assert.equal(error.status, expected.status, `${JSON.stringify(overrides)}: ${error.status}/${error.code}`);
          assert.equal(error.code, expected.code);
          if (expected.status === 503) assert.equal(typeof error.hint, 'string');
          return true;
        }
      );
    } finally {
      await env.cleanup();
    }
  }
});

test('IdentityStore v2.8：setDeviceName/getDeviceName；setSyncServer 合并写与清空', async () => {
  const dataDir = await tempDataDir('duckai-qa-identity-devname');
  const identity = await createIdentityStore({ dataDir, config: {} });
  try {
    const name = `DuckCPA@${Math.random().toString(16).slice(2, 6)}`;
    await identity.setDeviceName(name);
    assert.equal(identity.getDeviceName(), name);
    assert.equal(identity.getRedacted().deviceName, name);
    await assert.rejects(
      () => identity.setDeviceName(''),
      (error) => error instanceof IdentityError && error.code === 'invalid_identity'
    );
    await assert.rejects(
      () => identity.setDeviceName('x'.repeat(101)),
      (error) => error instanceof IdentityError && error.code === 'invalid_identity'
    );

    await identity.setSyncServer({
      userId: 'u-server-1',
      deviceId: identity.getRedacted().deviceId,
      deviceName: name,
      registeredAt: 123456,
      lastLoginAt: 123457
    });
    let server = identity.getRaw().sync.server;
    assert.equal(server.userId, 'u-server-1');
    assert.equal(server.deviceName, name);
    assert.equal(server.registeredAt, 123456);
    // 合并写：再次写部分字段保留其余
    await identity.setSyncServer({ lastLoginAt: 999999 });
    server = identity.getRaw().sync.server;
    assert.equal(server.userId, 'u-server-1');
    assert.equal(server.lastLoginAt, 999999);
    // null 清空
    await identity.setSyncServer(null);
    assert.equal(identity.getRaw().sync.server ?? null, null, 'null 应清空 sync.server');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
test('deviceName 迁移：旧默认 DuckAI CPA → DuckAI@main 并回写 config；自定义名保持', async () => {
  // 旧默认 → 迁移
  {
    const env = await makeService();
    try {
      const legacy = env.identity.getRedacted().deviceName;
      if (!/^DuckAI CPA/i.test(String(legacy))) {
        await env.identity.setDeviceName('DuckAI CPA @ qa-host');
      }
      const saved = [];
      env.service = createSyncDeviceService({
        identity: env.identity,
        pairingStore: env.pairingStore,
        logger: null,
        config: { identity: {} },
        store: { async saveConfig(config) { saved.push(config); } },
        syncClientFactory: async () => env.fake.client
      });
      const name = await env.service.ensureDeviceName();
      assert.equal(name, 'DuckAI@main');
      assert.equal(env.identity.getRedacted().deviceName, name, 'identity 应写新名');
      assert.equal(saved.length, 1, '应回写 config');
      assert.equal(saved[0].identity.deviceName, name);
    } finally {
      await env.cleanup();
    }
  }
  // 自定义名保持
  {
    const env = await makeService();
    try {
      await env.identity.setDeviceName('My Gateway');
      const name = await env.service.ensureDeviceName();
      assert.equal(name, 'My Gateway');
      assert.equal(env.identity.getRedacted().deviceName, 'My Gateway');
    } finally {
      await env.cleanup();
    }
  }
  // config 自定义名优先
  {
    const env = await makeService({ config: { identity: { deviceName: 'Configured Name' } } });
    try {
      assert.equal(await env.service.ensureDeviceName(), 'Configured Name');
    } finally {
      await env.cleanup();
    }
  }
});

test('token 仅内存：identity.json 不含 token/jwt；二次 register 复用 session（不再 login）', async () => {
  const env = await makeService();
  try {
    await env.service.ensureDeviceName();
    await env.service.registerDevice();
    const rawText = await fs.readFile(path.join(env.dataDir, 'identity.json'), 'utf8');
    const raw = JSON.parse(rawText);
    assert.ok(!rawText.includes('server-jwt-1'), 'identity.json 不应包含 sync token');
    assert.equal(raw.sync?.token ?? null, null, 'identity.sync.token 应为空（token 仅内存）');
    assert.equal(raw.sync?.jwt ?? null, null, 'identity.sync.jwt 应为空');
    const firstLogin = env.fake.calls.login;
    await env.service.registerDevice();
    assert.equal(env.fake.calls.login, firstLogin, '进程内 session 复用后不应再次 login');
  } finally {
    await env.cleanup();
  }
});

test('server-devices 缓存：无 live session 时返回 identity.sync.server.devices，不打上游', async () => {
  const first = await makeService();
  let dataDir = first.dataDir;
  try {
    await first.service.ensureDeviceName();
    await first.service.registerDevice();
    assert.ok(first.service.getServerSummary().devices.length > 0);
  } finally {
    // 不删 dataDir（第二个 service 复用），仅关闭 pairing store
    await first.pairingStore.close?.();
  }
  const second = await makeService({
    dataDir,
    syncClientOverrides: { loginError: Object.assign(new Error('should not call upstream'), { code: 'network' }) }
  });
  try {
    const listed = await second.service.listDevices();
    assert.equal(listed.cached, true, '应命中持久化缓存');
    assert.ok(listed.devices.length > 0);
    assert.equal(second.fake.calls.login, 0, '缓存命中时不应 login/打上游');
  } finally {
    await second.cleanup();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('限流：Sync /login 418 → 429 sync_rate_limited + Retry-After:120 + hint；cooldown 内不再打上游', async () => {
  const env = await makeService({
    syncClientOverrides: { loginError: Object.assign(new Error('anti-abuse'), { httpStatus: 418 }) }
  });
  try {
    await env.service.ensureDeviceName();
    await assert.rejects(
      () => env.service.registerDevice(),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.type, 'rate_limit_error');
        assert.equal(error.code, 'sync_rate_limited');
        assert.equal(error.headers?.['Retry-After'], '120');
        assert.equal(typeof error.hint, 'string');
        return true;
      }
    );
    assert.equal(env.fake.calls.login, 1);
    // cooldown 内：register / list / delete 均 429，且不再请求上游
    for (const call of [
      () => env.service.registerDevice(),
      () => env.service.listDevices(),
      () => env.service.deleteDevice('dev-other')
    ]) {
      await assert.rejects(call, (error) => {
        assert.equal(error.code, 'sync_rate_limited');
        assert.equal(error.headers?.['Retry-After'], '120');
        return true;
      });
    }
    assert.equal(env.fake.calls.login, 1, 'cooldown 内不应再次请求上游');
  } finally {
    await env.cleanup();
  }
});