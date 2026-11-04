/**
 * v2.8 配对 joiner 完成后自动注册设备（index.js 的 onCompleted glue，mock）。
 *
 * 真实 PairingService（真实 PairingHost + mock Sync exchange）+ 真实 SyncDeviceService（fake sync client）：
 *   joiner 完成 → onCompleted → syncDevices.autoRegister() → login+registerDevice；
 *   pairing 状态保持 completed；设备名 DuckCPA@<4hex>。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { createPairingHost, generateHostKeyPair, encryptPayload } from '../src/duck/pairing.js';
import { createPairingStore, createPairingService } from '../src/admin/pairing.js';
import { createSyncDeviceService } from '../src/admin/sync-devices.js';
import { createIdentityStore } from '../src/duck/identity.js';
import { createMockSyncService } from './helpers/mock-sync-service.js';

const SYNC_BASE = 'https://sync.example.test/sync';

function tempDataDir(prefix = 'duckai-qa-pairing-autoreg') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function officialCode(userId, secret) {
  return Buffer.from(JSON.stringify({ recovery: { user_id: userId, secret } }), 'utf8').toString('base64url');
}

function decodePairingCode(code) {
  return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
}

async function waitFor(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test('joiner 完成 → 自动注册设备（login+registerDevice），pairing 保持 completed', async () => {
  const dataDir = await tempDataDir();
  const exchange = createMockSyncService();
  const identity = await createIdentityStore({ dataDir, config: {} });
  const pairingStore = await createPairingStore({ dataDir });
  const peerCode = officialCode('phone-user-9', 'phone-secret-9');
  // v2.14: 网关已有另一个账号的恢复码（与手机账号不同）→ 触发 accountConflict + joiner 路径；
  // overwriteAccount=true 表示配对完成时采用手机账号。
  const hostCode = officialCode('host-user-1', 'host-secret-1');
  await pairingStore.setRecoveryCode(hostCode);

  const syncCalls = { login: 0, register: [] };
  const syncDevices = createSyncDeviceService({
    identity,
    pairingStore,
    logger: null,
    config: {},
    syncClientFactory: async () => ({
      async login(params) {
        syncCalls.login += 1;
        syncCalls.lastLogin = params;
        return { ok: true, userId: 'phone-user-9', token: 'jwt-auto', deviceId: params.deviceId };
      },
      async registerDevice(params) {
        syncCalls.register.push(params);
        return { id: params.deviceId, name: params.name, type: params.type, registeredAt: Date.now() };
      },
      async listDevices() {
        return [{ id: identity.getRedacted().deviceId, name: syncDevices.deviceName, type: 'browser' }];
      },
      async close() {}
    })
  });
  await syncDevices.ensureDeviceName();

  const pairing = createPairingService({
    createPairingHost,
    pairingStore,
    logger: null,
    config: { sync: { pairing: { overwriteAccount: true } } },
    options: {
      fetchImpl: exchange.fetchImpl,
      syncBase: SYNC_BASE,
      pollIntervalMs: 20,
      idleTimeoutMs: 10000,
      // 与 src/index.js 相同的 glue：joiner 完成后异步 autoRegister（失败不影响 pairing）
      onCompleted: () => {
        setTimeout(() => {
          void syncDevices.autoRegister().catch(() => {});
        }, 0);
      }
    }
  });

  try {
    const started = await pairing.start();
    assert.equal(started.state, 'waiting');
    const hostChannel = started.channelId;
    const hostPublicKey = decodePairingCode(started.pairingCode).public_key;
    const scanner = { ...generateHostKeyPair(), channelId: crypto.randomUUID() };
    const push = (message) =>
      exchange.pushInbound(hostChannel, encryptPayload(JSON.stringify(message), hostPublicKey, { kid: scanner.channelId }));

    push({ type: 'hello', channel_id: scanner.channelId, public_key: scanner.publicKeyBase64Url, version: '2' });
    await waitFor(async () => (await pairing.status())?.state === 'exchange', { label: 'exchange' });
    push({ type: 'recovery_code_available', name: 'ddg', kind: '3party', user_id: 'phone-user-9' });
    await waitFor(async () => (await pairing.status())?.substate === 'joiner_awaiting', { label: 'joiner_awaiting' });
    push({ type: 'recovery_code_response', recovery_code: peerCode });

    const completed = await waitFor(async () => {
      const status = await pairing.status();
      return status?.state === 'completed' ? status : null;
    }, { label: 'pairing completed' });
    assert.equal(completed.completedAs, 'joiner');

    // 自动注册（异步）
    await waitFor(() => syncCalls.register.length === 1, { label: 'auto register called' });
    assert.equal(syncCalls.login, 1);
    assert.equal(syncCalls.register[0].type, 'browser');
    assert.equal(syncCalls.register[0].name, 'DuckAI@main');

    const server = syncDevices.getServerSummary();
    assert.equal(server.registered, true);
    assert.equal(server.userId, 'phone-user-9');
    assert.equal(server.deviceName, syncCalls.register[0].name);

    // pairing 状态保持 completed（自动注册失败也不影响；这里成功）
    assert.equal((await pairing.status()).state, 'completed');
  } finally {
    await pairing.stop?.('aborted');
    await syncDevices.close?.();
    await pairingStore.close?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
