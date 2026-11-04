/**
 * v2.17 Admin API: POST /admin/api/sync/create-own-account（Sync This Device Only）。
 *  - 已有账号（userId/registered）时缺 confirm → 400 sync_account_exists
 *  - {confirm:true} → 200 并透出 sync（含 accountSource）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { withServer, adminRequest } from './helpers/test-server.js';

function tempDataDir(prefix = 'duckai-qa-own-account') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function fakeSyncPayload(overrides = {}) {
  return {
    enabled: true,
    deviceId: 'dev-1',
    deviceName: 'DuckAI@main',
    deviceCount: 1,
    devices: [],
    lastSyncAt: Date.now(),
    transport: 'available',
    pairingCode: null,
    recoveryCode: null,
    mode: 'backup',
    accountSource: 'self',
    server: {
      registered: true,
      userId: 'own-user-1',
      deviceId: 'dev-1',
      deviceName: 'DuckAI@main',
      serverDeviceId: 'dev-1',
      registeredAt: Date.now(),
      lastLoginAt: null,
      devices: [],
      lastError: null
    },
    ...overrides
  };
}

function fakeSyncDevices(state) {
  return {
    called: 0,
    async createOwnAccount() {
      state.called = (state.called || 0) + 1;
      state.created = true;
      return { ok: true, mode: 'own-account', userId: 'own-user-1', deviceName: 'DuckAI@main', recoveryCodeStored: true, registered: true };
    },
    getServerSummary() {
      return {
        registered: state.registered === true,
        userId: state.userId || null,
        deviceId: 'dev-1',
        deviceName: 'DuckAI@main',
        serverDeviceId: null,
        registeredAt: null,
        lastLoginAt: null,
        devices: [],
        lastError: null
      };
    },
    async getAccountSource() {
      return state.created ? 'self' : 'pairing';
    },
    deviceName: 'DuckAI@main'
  };
}

test('create-own-account：已有账号缺 confirm → 400；confirm → 200', async () => {
  const dataDir = await tempDataDir();
  const state = { registered: true, userId: 'existing-user' };
  const syncDevices = fakeSyncDevices(state);
  const server = await withServer({ dataDir, syncDevices, identity: true, withIdentities: true }, async ({ baseUrl }) => {
    const denied = await adminRequest(baseUrl, '/admin/api/sync/create-own-account', { method: 'POST', body: {} });
    assert.equal(denied.status, 400, denied.text);
    assert.equal(denied.json.error.code, 'sync_account_exists');
    assert.equal(state.called || 0, 0, '缺 confirm 时不应创建账号');

    const created = await adminRequest(baseUrl, '/admin/api/sync/create-own-account', {
      method: 'POST',
      body: { confirm: true }
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.mode, 'own-account');
    assert.equal(created.json.userId, 'own-user-1');
    assert.equal(state.called, 1, 'confirm 后应调用一次 createOwnAccount');
    assert.equal(created.json.sync?.accountSource, 'self');
    return 'ok';
  });
  assert.equal(server, 'ok');
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('create-own-account：无现有账号时可直接创建', async () => {
  const dataDir = await tempDataDir();
  const state = { registered: false, userId: null };
  const syncDevices = fakeSyncDevices(state);
  await withServer({ dataDir, syncDevices, identity: true, withIdentities: true }, async ({ baseUrl }) => {
    const created = await adminRequest(baseUrl, '/admin/api/sync/create-own-account', { method: 'POST', body: {} });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.ok, true);
    return 'ok';
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

void fakeSyncPayload;
