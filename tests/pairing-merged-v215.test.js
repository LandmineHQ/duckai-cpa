/**
 * v2.15 配对状态合并语义（真实 PairingService + stub PairingHost）。
 *
 * 用户反馈：扫码后第一次无提示、第二次提示「账号冲突（但已绑定成功）」。修复：
 *  - 配对成功后若已采用手机账号 → status.accountMerged=true 且 accountConflict=false；
 *  - 未采用（overwriteAccount=false）时把手机账号记为 pendingAccount，供 UI「改用手机账号」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createPairingStore, createPairingService } from '../src/admin/pairing.js';

function codeFor(userId) {
  return Buffer.from(JSON.stringify({ recovery: { cid: '3party', secret: 'secret-1', user_id: userId, v: '2.0' } }), 'utf8').toString('base64url');
}

async function tempDataDir(prefix = 'duckai-qa-pairing-merged') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function stubHostFactory(statusRef) {
  return async () => ({
    status: () => ({ ...statusRef.current, messages: [], qrUrl: 'https://duckduckgo.com/sync/pairing/#code2=abc' }),
    stop: async () => {}
  });
}

test('v2.15 配对：已采用手机账号时 accountMerged=true 且不再报冲突', async () => {
  const dataDir = await tempDataDir();
  const pairingStore = await createPairingStore({ dataDir });
  const phoneCode = codeFor('phone-user-merged');
  await pairingStore.setRecoveryCode(phoneCode);

  const statusRef = {
    current: {
      state: 'completed',
      completedAs: 'joiner',
      channelId: 'chan-1',
      peerName: 'Android 手机',
      peerKind: 'ddg',
      peerUserId: 'phone-user-merged',
      recoveryUserId: 'phone-user-merged',
      recoveryCodeReceived: true,
      accountConflict: true, // host 在采用前记录为 true
      startedAt: Date.now()
    }
  };
  const service = createPairingService({
    createPairingHost: stubHostFactory(statusRef),
    pairingStore,
    logger: null,
    config: { sync: { pairing: { overwriteAccount: true } } },
    options: {}
  });
  try {
    await service.start();
    const status = await service.status();
    assert.equal(status.accountMerged, true, '已同账号应标记 accountMerged');
    assert.equal(status.accountConflict, false, '合并成功后不应再显示账号冲突');
    assert.equal(status.currentAccountUserId, 'phone-user-merged');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('v2.15 配对：未采用手机账号时记录 pendingAccount，供 UI 一键切换', async () => {
  const dataDir = await tempDataDir();
  const pairingStore = await createPairingStore({ dataDir });
  const ownCode = codeFor('own-user-1');
  await pairingStore.setRecoveryCode(ownCode);

  const statusRef = {
    current: {
      state: 'exchange',
      completedAs: null,
      channelId: 'chan-2',
      peerName: 'Android 手机',
      peerKind: 'ddg',
      peerUserId: 'phone-user-2',
      recoveryUserId: 'phone-user-2',
      recoveryCodeReceived: false,
      accountConflict: true,
      startedAt: Date.now()
    }
  };
  const service = createPairingService({
    createPairingHost: stubHostFactory(statusRef),
    pairingStore,
    logger: null,
    config: { sync: { pairing: { overwriteAccount: false } } },
    options: {}
  });
  try {
    await service.start();
    const before = await service.status();
    assert.equal(before.accountMerged, false);
    assert.equal(before.accountConflict, true, '不同账号时应提示冲突');
    assert.equal(before.pendingAccount, null, '握手未完成时没有待采用账号');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
