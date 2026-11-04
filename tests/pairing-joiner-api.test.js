/**
 * v2.5 joiner 端到端（task-26b）：真实 PairingHost + mock Sync 服务 + PairingStore + PairingService + Admin API。
 *
 * 场景：手机（scanner/leader）已有 DuckDuckGo 账号，host（网关）无账号（或已有另一个账号）。
 *   1) scanner hello → host exchange；
 *   2) scanner 发 recovery_code_available（带 user_id）→ host **不得**回 unavailable，进入 joiner 等待；
 *   3) scanner 发 recovery_code_response（base64 JSON {recovery:{user_id,secret}}）→ host completed(joiner)；
 *   4) PairingService 把官方恢复码落盘 → GET /admin/api/sync/official-recovery-code configured=true（无明文）；
 *   5) GET /admin/api/sync/pairing state=completed/completedAs=joiner/accountAvailable=true；
 *   6) 冲突策略：已有不同官方码时默认**不覆盖**，仅 `sync.pairing.overwriteAccount=true` 覆盖；相同码 no-op。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { createPairingHost, generateHostKeyPair, encryptPayload, parseOfficialRecoveryCode } from '../src/duck/pairing.js';
import { createPairingStore, createPairingService } from '../src/admin/pairing.js';
import { withServer, adminRequest, waitFor } from './helpers/test-server.js';
import { createMockSyncService } from './helpers/mock-sync-service.js';

const SYNC_BASE = 'https://sync.example.test/sync';

function tempDataDir(prefix = 'duckai-qa-pairing-joiner') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function officialCode(userId, secret) {
  return Buffer.from(JSON.stringify({ recovery: { user_id: userId, secret } }), 'utf8').toString('base64url');
}

function decodePairingCode(code) {
  return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
}

/** 等待后台轮询推进到指定状态（PairingHost autoPoll 由 PairingService 默认开启）。 */
async function waitForPairingState(baseUrl, predicate, timeoutMs = 8000) {
  let latest = null;
  await waitFor(
    async () => {
      const res = await adminRequest(baseUrl, '/admin/api/sync/pairing');
      latest = res.json?.pairing ?? null;
      return latest && predicate(latest) ? latest : null;
    },
    { timeoutMs, intervalMs: 40 }
  );
  return latest;
}

/**
 * 跑一次完整 joiner 流程。
 * @param {{ initialCode?: string|null, overwrite?: boolean, incomingCode?: string, label?: string }} [opts]
 */
async function runJoinerFlow(opts = {}) {
  const {
    initialCode = null,
    overwrite = false,
    incomingCode = officialCode('phone-user-1', 'phone-secret-1')
  } = opts;
  const dataDir = await tempDataDir();
  const sync = createMockSyncService();
  const pairingStore = await createPairingStore({ dataDir });
  if (initialCode) await pairingStore.setRecoveryCode(initialCode);
  const pairing = createPairingService({
    createPairingHost,
    pairingStore,
    logger: null,
    config: overwrite ? { sync: { pairing: { overwriteAccount: true } } } : null,
    options: { fetchImpl: sync.fetchImpl, syncBase: SYNC_BASE, pollIntervalMs: 20, idleTimeoutMs: 10000 }
  });
  try {
    const result = await withServer({ pairing }, async ({ baseUrl }) => {
      const started = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method: 'POST', body: {} });
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.state, 'waiting');
      assert.equal(
        started.json.accountAvailable,
        Boolean(initialCode),
        `start 时 accountAvailable 应等于是否已有官方码（初始 ${initialCode ? '有' : '无'}）`
      );

      const hostChannel = started.json.channelId;
      const hostPublicKey = decodePairingCode(started.json.pairingCode).public_key;
      const scanner = { ...generateHostKeyPair(), channelId: crypto.randomUUID() };
      const push = (message) =>
        sync.pushInbound(hostChannel, encryptPayload(JSON.stringify(message), hostPublicKey, { kid: scanner.channelId }));

      // 1) hello
      push({ type: 'hello', channel_id: scanner.channelId, public_key: scanner.publicKeyBase64Url, version: '2' });
      const afterHello = await waitForPairingState(baseUrl, (item) => item.state === 'exchange');
      assert.equal(afterHello.state, 'exchange');

      // 2) 对方有账号 → host 不得回 unavailable，进入 joiner 等待
      const outboundBefore = sync.outboundFor(scanner.channelId).flatMap((entry) => entry.messages).length;
      push({ type: 'recovery_code_available', name: 'ddg', kind: '3party', user_id: 'phone-user-1' });
      const waiting = await waitForPairingState(baseUrl, (item) => item.state === 'exchange' && item.substate === 'joiner_awaiting');
      assert.equal(waiting.endReason, null, 'available 后不应 failed');
      assert.equal(waiting.substate, 'joiner_awaiting');
      assert.equal(
        sync.outboundFor(scanner.channelId).flatMap((entry) => entry.messages).length,
        outboundBefore,
        'available 后 host 不应发任何消息（旧实现错误回 unavailable）'
      );

      // 3) 发送官方恢复码 → completed(joiner)
      push({ type: 'recovery_code_response', recovery_code: incomingCode });
      const expectedUserId = parseOfficialRecoveryCode(incomingCode)?.userId ?? null;
      const finalStatus = await waitForPairingState(baseUrl, (item) => item.state === 'completed' || item.state === 'failed');
      assert.equal(finalStatus.state, 'completed', `应 completed（实际 ${finalStatus.state}/${finalStatus.endReason}）`);
      assert.equal(finalStatus.endReason, 'completed');
      assert.equal(finalStatus.completedAs, 'joiner');

      const official = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code');
      assert.equal(official.status, 200);
      const info = official.json.officialRecoveryCode;
      assert.equal(info.configured, true, `官方码应已落盘: ${official.text}`);
      assert.equal(info.hasCode, true);
      assert.ok(Number(info.length) > 10, `length=${info.length}`);

      const after = await adminRequest(baseUrl, '/admin/api/sync/pairing');
      assert.equal(after.json.pairing.accountAvailable, true, '落盘后 accountAvailable=true');
      assert.equal(after.json.pairing.completedAs, 'joiner');
      assert.equal(after.json.pairing.recoveryCodeReceived, true);
      assert.equal(after.json.pairing.recoveryUserId, expectedUserId);
      assert.equal(typeof after.json.pairing.accountConflict, 'boolean');
      assert.ok(!after.text.includes(incomingCode), 'Admin pairing status 不应回显恢复码明文');
      const incomingSecret = parseOfficialRecoveryCode(incomingCode)?.secret ?? null;
      if (incomingSecret) assert.ok(!after.text.includes(incomingSecret), 'Admin pairing status 不应包含 secret');
      assert.ok(!('recoveryCode' in after.json.pairing), 'Admin pairing status 应剥离 recoveryCode 原文');

      const stored = await pairingStore.getRecoveryCode();
      return { info, stored, finalStatus };
    });
    return result;
  } finally {
    await pairingStore.close?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

test('joiner 端到端：available 不回 unavailable；response 后 completed(joiner) 且官方码落盘', async () => {
  const incoming = officialCode('phone-user-1', 'phone-secret-1');
  const { info, stored, finalStatus } = await runJoinerFlow({ incomingCode: incoming });
  assert.equal(stored, incoming, '首次 joiner 应原样落盘');
  assert.equal(info.length, incoming.length);
  assert.equal(finalStatus.recoveryCodeReceived, true);
});

test('joiner 冲突：已有不同官方码时默认不覆盖（sync.pairing.overwriteAccount=false）', async () => {
  const existing = officialCode('old-user', 'old-secret');
  const incoming = officialCode('phone-user-2', 'phone-secret-2');
  const { info, stored } = await runJoinerFlow({ initialCode: existing, incomingCode: incoming });
  assert.equal(stored, existing, '默认应保留已有官方码');
  assert.equal(info.length, existing.length);
  assert.notEqual(stored, incoming);
});

test('joiner 冲突：相同官方码 → no-op（保持原样）', async () => {
  const code = officialCode('phone-user-3', 'phone-secret-3');
  const { stored, info } = await runJoinerFlow({ initialCode: code, incomingCode: code });
  assert.equal(stored, code);
  assert.equal(info.length, code.length);
});

test('joiner 冲突：sync.pairing.overwriteAccount=true → 覆盖为新码', async () => {
  const existing = officialCode('old-user', 'old-secret');
  const incoming = officialCode('phone-user-4', 'phone-secret-4');
  const { info, stored } = await runJoinerFlow({ initialCode: existing, incomingCode: incoming, overwrite: true });
  assert.equal(stored, incoming, 'overwriteAccount=true 时应覆盖');
  assert.equal(info.length, incoming.length);
});
