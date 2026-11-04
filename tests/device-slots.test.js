/**
 * v2.9 设备槽位 / 每身份设备名 / 默认身份保护（Admin HTTP）。
 *
 * 按 api-core 最终契约：
 *   - 每身份 deviceName：id_default=DuckAI@main，其它 DuckCPA@<4hex>；PATCH identities/:id {deviceName}；池 items 含 deviceName
 *   - DELETE identities/id_default → 409 default_identity_protected（?force 也拒绝）
 *   - GET/PUT /admin/api/sync/device-slots：默认含 id_default；PUT {identityIds} 增量 registerDevices/logoutDevices，
 *     持久化 identity.sync.slots（重启保留）；空数组允许；非法/禁用 400；418→429+Retry-After
 *   - serverDevices 解密 name/type + matchedIdentityId
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
  JSON.stringify({ recovery: { user_id: 'slots-user-1', secret: 'slots-secret-1' } }),
  'utf8'
).toString('base64url');

function tempDataDir(prefix = 'duckai-qa-device-slots') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function fakeSyncClient(overrides = {}) {
  const calls = { login: 0, registerDevices: [], logoutDevices: [], listDetailed: [] };
  const state = { devices: [] };
  const client = {
    async login(params = {}) {
      calls.login += 1;
      calls.lastLogin = params;
      if (overrides.loginError) throw overrides.loginError;
      return { ok: true, userId: 'slots-user-1', token: `jwt-${calls.login}`, deviceId: params.deviceId ?? null };
    },
    async registerDevices(items) {
      calls.registerDevices.push(items);
      if (overrides.registerDevicesError) throw overrides.registerDevicesError;
      for (const item of items) {
        const name = item.name ?? item.deviceName;
        const existing = state.devices.find((device) => device.id === item.deviceId);
        if (existing) {
          existing.name = name;
          existing.type = item.type ?? 'browser';
        } else {
          state.devices.push({ id: item.deviceId, name, type: item.type ?? 'browser', credential_id: '3party', jwt_iat: Date.now(), decoded: true });
        }
      }
      return {
        ok: true,
        items: items.map((item) => ({
          ok: true,
          id: item.deviceId,
          name: item.name ?? item.deviceName,
          type: item.type ?? 'browser',
          credential_id: '3party',
          registeredAt: Date.now()
        })),
        devices: items.map((item) => ({ id: item.deviceId, credential_id: '3party', info: 'enc' }))
      };
    },
    async logoutDevices(ids) {
      calls.logoutDevices.push(ids);
      if (overrides.logoutDevicesError) throw overrides.logoutDevicesError;
      state.devices = state.devices.filter((device) => !ids.includes(device.id));
      return { ok: true, removed: ids, failed: [], results: ids.map((id) => ({ id, ok: true, removed: true })) };
    },
    async logoutDevice(id) {
      // v2.13：后端逐个注销（logout 会使 token 失效，需要中间重新 login）
      calls.logoutDevices.push([id]);
      if (overrides.logoutDevicesError) throw overrides.logoutDevicesError;
      state.devices = state.devices.filter((device) => device.id !== id);
      return { ok: true, removed: true };
    },
    async listDevicesDetailed() {
      calls.listDetailed.push(Date.now());
      if (overrides.listDetailedError) throw overrides.listDetailedError;
      if (overrides.serverDevices) return overrides.serverDevices;
      return state.devices.map((device) => ({ ...device }));
    },
    async listDevices() {
      return overrides.serverDevices ?? state.devices;
    },
    getStatus() {
      return { loggedIn: true };
    },
    async close() {}
  };
  return { client, calls };
}

/** 启动带身份池 + syncDevices 的网关。 */
async function runSlots(options = {}) {
  const { overrides = {}, config = {}, recoveryCode = OFFICIAL_CODE, dataDir: presetDir = null } = options;
  const assertions = options.assert || overrides.assert || null;
  const dataDir = presetDir || (await tempDataDir());
  const handle = { dataDir, fake: null, pairingStore: null };
  const cleanup = options.cleanup !== false && !presetDir;
  try {
    await withServer(
      {
        identity: true,
        pool: true,
        cleanup: false,
        dataDir,
        config: makeConfig(config),
        syncDevices: async ({ identity, identityPool }) => {
          const pairingStore = await createPairingStore({ dataDir });
          if (recoveryCode) await pairingStore.setRecoveryCode(recoveryCode);
          const fake = fakeSyncClient(overrides);
          const service = createSyncDeviceService({
            identity,
            pairingStore,
            identities: identityPool,
            logger: null,
            config,
            syncClientFactory: async () => fake.client
          });
          handle.fake = fake;
          handle.pairingStore = pairingStore;
          return service;
        }
      },
      async (env) => {
        handle.env = env;
        if (assertions) await assertions({ env, handle });
      }
    );
  } finally {
    if (cleanup) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  return handle;
}

async function poolItems(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/identities');
  assert.equal(res.status, 200, res.text);
  return res.json.items || [];
}

/* ------------------------------------------------------------------ */
/* 1. 每身份设备名 / 默认身份保护                                      */
/* ------------------------------------------------------------------ */

test('池设备名：id_default=DuckAI@main，generate 的身份 DuckCPA@xxxx 且持久化；PATCH deviceName 生效', async () => {
  await runSlots({
    overrides: {
      assert: async ({ env }) => {
        const { baseUrl } = env;
        const items = await poolItems(baseUrl);
        const main = items.find((item) => item.id === 'id_default');
        assert.ok(main, '池应含 id_default');
        assert.equal(main.deviceName, 'DuckAI@main', `默认身份设备名应为 DuckAI@main（实际 ${main.deviceName}）`);
        assert.ok(main.deviceId);

        const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
          method: 'POST',
          body: { count: 2, labelPrefix: '槽位' }
        });
        assert.equal(generated.status, 200, generated.text);
        const created = generated.json.items || generated.json.identities || [];
        assert.equal(created.length, 2);
        for (const item of created) {
          assert.match(String(item.deviceName), /^DuckCPA@[0-9a-f]{4}$/, `生成身份设备名应 DuckCPA@xxxx（实际 ${item.deviceName}）`);
        }
        // 池列表包含 deviceName
        const listed = await poolItems(baseUrl);
        for (const item of listed) {
          assert.equal(typeof item.deviceName, 'string');
        }

        // PATCH deviceName 生效
        const target = created[0];
        const patched = await adminRequest(baseUrl, `/admin/api/identities/${target.id}`, {
          method: 'PATCH',
          body: { deviceName: 'Custom Slot Name' }
        });
        assert.equal(patched.status, 200, patched.text);
        assert.equal(patched.json.identity.deviceName, 'Custom Slot Name');
        const after = (await poolItems(baseUrl)).find((item) => item.id === target.id);
        assert.equal(after.deviceName, 'Custom Slot Name');
        // 默认身份也可改名
        const patchedDefault = await adminRequest(baseUrl, '/admin/api/identities/id_default', {
          method: 'PATCH',
          body: { deviceName: 'Main Phone Renamed' }
        });
        assert.equal(patchedDefault.status, 200, patchedDefault.text);
        assert.equal(patchedDefault.json.identity.deviceName, 'Main Phone Renamed');
      }
    }
  });
});

test('默认身份保护：DELETE id_default → 409 default_identity_protected（?force 也拒绝）', async () => {
  await runSlots({
    overrides: {
      assert: async ({ env }) => {
        const { baseUrl } = env;
        for (const suffix of ['', '?force=true']) {
          const deleted = await adminRequest(baseUrl, `/admin/api/identities/id_default${suffix}`, { method: 'DELETE' });
          assert.equal(deleted.status, 409, `${suffix || '(no force)'}: ${deleted.text}`);
          assert.equal(deleted.json.error.code, 'default_identity_protected');
          assert.equal(typeof deleted.json.error.hint, 'string');
        }
        const items = await poolItems(baseUrl);
        assert.ok(items.some((item) => item.id === 'id_default'), '默认身份应仍存在');
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. device-slots                                                     */
/* ------------------------------------------------------------------ */

test('device-slots：GET 默认含 id_default；PUT 增量注册/注销并持久化 slots（重启保留）', async () => {
  const dataDir = await tempDataDir();
  try {
    await runSlots({
      dataDir,
      overrides: {
        assert: async ({ env, handle }) => {
          const { baseUrl } = env;
          const initial = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
          assert.equal(initial.status, 200, initial.text);
          assert.equal(initial.json.defaultIdentityId, 'id_default');
          assert.deepEqual(initial.json.identityIds, ['id_default']);
          assert.equal(initial.json.slots.length, 1);
          assert.equal(initial.json.slots[0].identityId, 'id_default');
          assert.equal(initial.json.slots[0].deviceName, 'DuckAI@main');
          assert.equal(initial.json.slots[0].registered, false);
          assert.ok(Array.isArray(initial.json.serverDevices));

          // 生成第二个身份
          const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
            method: 'POST',
            body: { count: 1, labelPrefix: '分身' }
          });
          const other = (generated.json.items || generated.json.identities || [])[0];
          assert.ok(other, generated.text);

          // PUT [id_default, other] → 批量注册
          const saved = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
            method: 'PUT',
            body: { identityIds: ['id_default', other.id] }
          });
          assert.equal(saved.status, 200, saved.text);
          assert.equal(handle.fake.calls.registerDevices.length, 1, '应调用一次批量 registerDevices');
          const batch = handle.fake.calls.registerDevices[0];
          assert.equal(batch.length, 2);
          assert.deepEqual(
            batch.map((item) => item.deviceId).sort(),
            ['id_default', other.id].map((id) => (id === 'id_default' ? saved.json.slots[0].deviceId : saved.json.slots[1].deviceId)).sort()
          );
          assert.ok(saved.json.slots.some((slot) => slot.identityId === other.id && slot.deviceName.startsWith('DuckCPA@')));
          assert.equal(saved.json.serverDevices.length, 2, '注册后服务端设备列表应含 2 台');

          // slots 持久化到 identity.sync.slots
          const raw = env.identityStore.getRaw();
          assert.deepEqual([...raw.sync.slots].sort(), ['id_default', other.id].sort());

          // v2.13：默认身份可以从设备槽移除（只注销设备，身份/配对账号/官方恢复码保留）
          const emptyPut = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
            method: 'PUT',
            body: { identityIds: [] }
          });
          assert.equal(emptyPut.status, 200, emptyPut.text);
          assert.deepEqual(emptyPut.json.identityIds, []);
          assert.equal(env.identityStore.getRaw().sync.server?.registered, false, '移除本机设备后应标记未注册');
          const withoutDefault = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
            method: 'PUT',
            body: { identityIds: [other.id] }
          });
          assert.equal(withoutDefault.status, 200, withoutDefault.text);
          assert.deepEqual(withoutDefault.json.identityIds, [other.id]);

          // PUT [id_default] → 注销其它身份（默认保留）
          const cleared = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
            method: 'PUT',
            body: { identityIds: ['id_default'] }
          });
          assert.equal(cleared.status, 200, cleared.text);
          assert.deepEqual(cleared.json.identityIds, ['id_default']);
          assert.ok(handle.fake.calls.logoutDevices.length >= 1, '应调用 logoutDevices 注销移除的身份');
          const rawCleared = env.identityStore.getRaw();
          assert.deepEqual(rawCleared.sync.slots, ['id_default']);
        }
      }
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('device-slots 持久化重启保留：再次启动 GET 仍读 identity.sync.slots', async () => {
  const dataDir = await tempDataDir();
  try {
    await runSlots({
      dataDir,
      overrides: {
        assert: async ({ env }) => {
          const generated = await adminRequest(env.baseUrl, '/admin/api/identities/generate', {
            method: 'POST',
            body: { count: 1 }
          });
          const other = (generated.json.items || generated.json.identities || [])[0];
          const saved = await adminRequest(env.baseUrl, '/admin/api/sync/device-slots', {
            method: 'PUT',
            body: { identityIds: ['id_default', other.id] }
          });
          assert.equal(saved.status, 200, saved.text);
        }
      }
    });
    // 新 server（同 dataDir）= 重启
    await runSlots({
      dataDir,
      overrides: {
        assert: async ({ env }) => {
          const res = await adminRequest(env.baseUrl, '/admin/api/sync/device-slots');
          assert.equal(res.status, 200, res.text);
          assert.equal(res.json.identityIds.length, 2, '重启后应从 identity.sync.slots 读取（含默认身份）');
          assert.ok(res.json.identityIds.includes('id_default'));
          const otherSlot = res.json.slots.find((slot) => slot.identityId !== 'id_default');
          assert.equal(String(otherSlot.deviceName).startsWith('DuckCPA@'), true);
        }
      }
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('device-slots 错误：非法/禁用身份 400 invalid_identity；418 → 429 + Retry-After', async () => {
  // 非法 / 禁用
  await runSlots({
    overrides: {
      assert: async ({ env }) => {
        const { baseUrl } = env;
        const invalid = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: ['no-such-id'] }
        });
        assert.equal(invalid.status, 400, invalid.text);
        assert.equal(invalid.json.error.code, 'invalid_identity');

        const notArray = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: 'id_default' }
        });
        assert.equal(notArray.status, 400);
        assert.equal(notArray.json.error.code, 'invalid_identity');

        const created = await adminRequest(baseUrl, '/admin/api/identities/generate', {
          method: 'POST',
          body: { count: 1 }
        });
        const other = (created.json.items || created.json.identities || [])[0];
        await adminRequest(baseUrl, `/admin/api/identities/${other.id}`, {
          method: 'PATCH',
          body: { enabled: false }
        });
        const disabled = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: [other.id] }
        });
        assert.equal(disabled.status, 400, disabled.text);
        assert.equal(disabled.json.error.code, 'invalid_identity');
      }
    }
  });

  // 418 → 429
  await runSlots({
    overrides: {
      registerDevicesError: Object.assign(new Error('anti-abuse'), { httpStatus: 418 }),
      assert: async ({ env, handle }) => {
        const created = await adminRequest(env.baseUrl, '/admin/api/identities/generate', {
          method: 'POST',
          body: { count: 1 }
        });
        const other = (created.json.items || created.json.identities || [])[0];
        const denied = await adminRequest(env.baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: ['id_default', other.id] }
        });
        assert.equal(denied.status, 429, denied.text);
        assert.equal(denied.json.error.code, 'sync_rate_limited');
        assert.equal(denied.headers.get('retry-after'), '120');
        assert.equal(handle.fake.calls.registerDevices.length, 1);
      }
    }
  });
});

test('serverDevices：解密 name/type + matchedIdentityId；slot registered 标记', async () => {
  await runSlots({
    overrides: {
      serverDevices: [
        { id: 'server-main-id', name: 'Android 手机', type: 'browser', credential_id: '3party', jwt_iat: 111, decoded: true }
      ],
      assert: async ({ env, handle }) => {
        const { baseUrl } = env;
        // 让 serverDevices 的 id 与默认身份 deviceId 对齐（按 id 映射）
        const defaultDeviceId = env.identityStore.getRedacted().deviceId;
        handle.fake.client.listDevicesDetailed = async () => [
          { id: defaultDeviceId, name: 'DuckAI@main', type: 'browser', credential_id: '3party', jwt_iat: 111, current: true, decoded: true },
          { id: 'server-phone-id', name: 'Android 手机', type: 'browser', credential_id: '3party', jwt_iat: 222, decoded: true }
        ];
        const res = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.equal(res.status, 200, res.text);
        const main = res.json.slots.find((slot) => slot.identityId === 'id_default');
        assert.equal(main.registered, true, '默认身份应标记 registered');
        assert.equal(main.matchedIdentityId, 'id_default');
        const phone = res.json.serverDevices.find((device) => device.id === 'server-phone-id');
        assert.equal(phone.name, 'Android 手机');
        assert.equal(phone.type, 'browser');
        assert.equal(phone.matchedIdentityId, null, '未知设备 matchedIdentityId 应为 null');
        assert.ok(!('info' in phone), 'serverDevices 不应返回 info 原文');
      }
    }
  });
});


/* ------------------------------------------------------------------ */
/* 3. v2.10 删除/禁用保护 + force + 孤儿自愈                           */
/* ------------------------------------------------------------------ */

test('删除保护：在 slots 的身份 DELETE → 409 identity_in_device_slots；?force=true 注销+清 slots+删身份；默认身份 force 仍 409', async () => {
  await runSlots({
    overrides: {
      assert: async ({ env, handle }) => {
        const { baseUrl } = env;
        const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
          method: 'POST',
          body: { count: 1, labelPrefix: '受保护' }
        });
        const other = (generated.json.items || generated.json.identities || [])[0];
        assert.ok(other, generated.text);
        const saved = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: ['id_default', other.id] }
        });
        assert.equal(saved.status, 200, saved.text);
        const otherDeviceId = saved.json.slots.find((slot) => slot.identityId === other.id)?.deviceId;
        assert.ok(otherDeviceId);

        // 普通 DELETE → 409（含 hint/identityId/deviceName）
        const denied = await adminRequest(baseUrl, `/admin/api/identities/${other.id}`, { method: 'DELETE' });
        assert.equal(denied.status, 409, denied.text);
        assert.equal(denied.json.error.code, 'identity_in_device_slots');
        assert.equal(typeof denied.json.error.hint, 'string');
        const deniedIdentityId = denied.json.error.identityId ?? denied.json.error.details?.identityId;
        const deniedDeviceName = denied.json.error.deviceName ?? denied.json.error.details?.deviceName;
        assert.equal(deniedIdentityId, other.id);
        assert.equal(deniedDeviceName, other.deviceName);
        // 状态不变
        const listed = await poolItems(baseUrl);
        assert.ok(listed.some((item) => item.id === other.id), '409 后身份仍存在');
        const slots = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.ok(slots.json.identityIds.includes(other.id), '409 后 slots 不变');

        // force=true → 注销设备 + 清 slots + 删身份
        const forced = await adminRequest(baseUrl, `/admin/api/identities/${other.id}?force=true`, { method: 'DELETE' });
        assert.equal(forced.status, 200, forced.text);
        assert.equal(forced.json.ok, true);
        assert.equal(forced.json.removedDevice, true, `force 删除应 removedDevice:true（实际 ${JSON.stringify(forced.json)}）`);
        assert.ok(
          handle.fake.calls.logoutDevices.some((ids) => ids.includes(otherDeviceId)),
          `应调用 logoutDevices([${otherDeviceId}])，实际 ${JSON.stringify(handle.fake.calls.logoutDevices)}`
        );
        const after = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.ok(!after.json.identityIds.includes(other.id), 'force 后 slots 应清理该身份');
        const raw = env.identityStore.getRaw();
        assert.ok(!(raw.sync?.slots || []).includes(other.id), 'identity.sync.slots 应清理');
        const listedAfter = await poolItems(baseUrl);
        assert.ok(!listedAfter.some((item) => item.id === other.id), '身份应已删除');

        // 默认身份 force 仍 409 default_identity_protected
        const defaultDenied = await adminRequest(baseUrl, '/admin/api/identities/id_default?force=true', { method: 'DELETE' });
        assert.equal(defaultDenied.status, 409, defaultDenied.text);
        assert.equal(defaultDenied.json.error.code, 'default_identity_protected');
      }
    }
  });
});

test('禁用保护：在 slots 的身份 PATCH enabled:false → 409；?force=true 注销+移出 slots+禁用', async () => {
  await runSlots({
    overrides: {
      assert: async ({ env, handle }) => {
        const { baseUrl } = env;
        const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
          method: 'POST',
          body: { count: 1 }
        });
        const other = (generated.json.items || generated.json.identities || [])[0];
        const saved = await adminRequest(baseUrl, '/admin/api/sync/device-slots', {
          method: 'PUT',
          body: { identityIds: ['id_default', other.id] }
        });
        assert.equal(saved.status, 200, saved.text);
        const otherDeviceId = saved.json.slots.find((slot) => slot.identityId === other.id)?.deviceId;

        const denied = await adminRequest(baseUrl, `/admin/api/identities/${other.id}`, {
          method: 'PATCH',
          body: { enabled: false }
        });
        assert.equal(denied.status, 409, denied.text);
        assert.equal(denied.json.error.code, 'identity_in_device_slots');

        const forced = await adminRequest(baseUrl, `/admin/api/identities/${other.id}?force=true`, {
          method: 'PATCH',
          body: { enabled: false }
        });
        assert.equal(forced.status, 200, forced.text);
        assert.equal(forced.json.identity.enabled, false);
        assert.ok(
          handle.fake.calls.logoutDevices.some((ids) => ids.includes(otherDeviceId)),
          '禁用 force 应注销设备'
        );
        const slots = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.ok(!slots.json.identityIds.includes(other.id), '禁用 force 后 slots 应移除');
      }
    }
  });
});

test('孤儿自愈：GET device-slots 过滤不存在/禁用身份并返回 orphans；?reconcile=true 清理 slots', async () => {
  await runSlots({
    overrides: {
      assert: async ({ env, handle }) => {
        const { baseUrl } = env;
        // 人工写入一个不存在的 identityId 到 slots
        const raw = env.identityStore.getRaw();
        const ghost = 'id_ghost_deleted';
        await env.identityStore.importIdentity({
          version: raw.version,
          identity: { ...raw, sync: { ...(raw.sync || {}), slots: ['id_default', ghost] } }
        });

        const slots = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.equal(slots.status, 200, slots.text);
        assert.ok(Array.isArray(slots.json.orphans), '应返回 orphans 数组');
        assert.ok(slots.json.orphans.some((item) => item.identityId === ghost), `orphans 应含 ${ghost}`);
        assert.ok(!slots.json.identityIds.includes(ghost), 'identityIds 应过滤不存在身份');
        assert.ok(!(slots.json.slots || []).some((slot) => slot.identityId === ghost), 'slots 应过滤');

        const reconciled = await adminRequest(baseUrl, '/admin/api/sync/device-slots?reconcile=true');
        assert.equal(reconciled.status, 200, reconciled.text);
        const rawAfter = env.identityStore.getRaw();
        assert.ok(!(rawAfter.sync?.slots || []).includes(ghost), 'reconcile 后 identity.sync.slots 应清理孤儿');
        const after = await adminRequest(baseUrl, '/admin/api/sync/device-slots');
        assert.ok(!after.json.orphans.some((item) => item.identityId === ghost), 'reconcile 后不应再有该孤儿');
      }
    }
  });
});
