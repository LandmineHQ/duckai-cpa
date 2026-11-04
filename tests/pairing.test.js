/**
 * v2.5 扫码配对（src/duck/pairing.js）。
 *
 * 覆盖（按 duck-protocol 实际实现能力）：
 *   - 信封加解密 round-trip（两对 RSA 密钥）、5 段结构、错误 key 失败
 *   - start：PUT 频道 204、配对码/QR URL、status=waiting；PUT 404 → write_channel_lost
 *   - 轮询 hello → 校验 + 回 hello（scanner 能解密验证）
 *   - sequence gap / GET 404 / self_scan / version mismatch → failed + endReason
 *   - waitForPeer 超时 → PairingError timeout
 *   - recovery_code_request：有 account → response + completed(host)；无 account → unavailable + failed
 *   - status 状态机 + stop()
 *
 * 限界（与实现一致，见 docs/PAIRING-IMPL.md）：与官方 DuckDuckGo App 的完整账号加入（joinAccount/exitAccount、
 * 真实 recovery code 语义）不在本迭代范围；成功后不写 identity.sync。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPairingHost,
  generateHostKeyPair,
  createEnvelope,
  decryptEnvelope,
  encryptPayload,
  decryptPayload,
  importPublicKeyBase64Url,
  parseOfficialRecoveryCode,
  encodeOfficialRecoveryCode,
  PairingError
} from '../src/duck/pairing.js';
import { createMockSyncService } from './helpers/mock-sync-service.js';

const SYNC_BASE = 'https://sync.example.test/sync';

function scannerHello({ channelId, publicKeyBase64Url, version = '2' }) {
  return JSON.stringify({ type: 'hello', channel_id: channelId, public_key: publicKeyBase64Url, version });
}

function makeScanner() {
  const keys = generateHostKeyPair();
  const channelId = crypto.randomUUID();
  return { ...keys, channelId };
}

async function startHost(service, extra = {}) {
  const host = await createPairingHost({
    fetchImpl: service.fetchImpl,
    syncBase: SYNC_BASE,
    autoPoll: false,
    pollIntervalMs: 200,
    idleTimeoutMs: 5000,
    timeoutMs: 60000,
    ...extra
  });
  return host;
}

test('信封 round-trip：两对 RSA 密钥，A 加密 B 解密；结构 5 段', async () => {
  const crypto = await import('node:crypto');
  const a = generateHostKeyPair();
  const b = generateHostKeyPair();
  const envelope = createEnvelope('hello 配对', b.publicKey, { kid: 'chan-1', typ: 'chat' });
  assert.equal(envelope.version, '2');
  const segments = String(envelope.payload).split('.');
  assert.equal(segments.length, 5, 'payload 应为 5 段');
  assert.equal(decryptEnvelope(envelope, b.privateKey), 'hello 配对');
  assert.throws(() => decryptEnvelope(envelope, a.privateKey), '错误私钥应解密失败');

  // 低层 API + 导入 SPKI base64url
  const payload = encryptPayload('低层', a.publicKeyBase64Url, { kid: 'x' });
  assert.equal(decryptPayload(payload, a.privateKey), '低层');
  const imported = importPublicKeyBase64Url(b.publicKeyBase64Url);
  const envelope2 = createEnvelope('导入公钥', imported);
  assert.equal(decryptEnvelope(envelope2, b.privateKey), '导入公钥');
  assert.ok(crypto);
});

test('start：PUT 频道 204、配对码/QR URL 结构、status=waiting', async () => {
  const service = createMockSyncService();
  const host = await startHost(service);
  try {
    const status = host.status();
    assert.equal(status.state, 'waiting');
    assert.ok(status.channelId);
    assert.equal(service.puts.length, 1);
    assert.equal(service.puts[0].channelId, status.channelId);
    assert.ok(status.qrUrl.startsWith('https://duckduckgo.com/sync/pairing/#&code2='));
    const payload = JSON.parse(Buffer.from(status.pairingCode, 'base64url').toString('utf8'));
    assert.equal(payload.version, '2');
    assert.equal(payload.channel_id, status.channelId);
    assert.equal(payload.public_key, host.publicKeyBase64Url);
    assert.ok(status.expiresAt > status.startedAt);
  } finally {
    host.stop();
  }
});

test('start：PUT 404 → write_channel_lost', async () => {
  const service = createMockSyncService({ putStatus: 404 });
  await assert.rejects(
    () => startHost(service),
    (error) => {
      assert.ok(error instanceof PairingError);
      assert.equal(error.code, 'write_channel_lost');
      assert.equal(error.httpStatus, 404);
      return true;
    }
  );
});

test('轮询 hello → 校验并通过 scanner 频道发首条 exchange 消息（不回 hello）', async () => {
  const crypto = await import('node:crypto');
  const service = createMockSyncService();
  const host = await startHost(service);
  try {
    const scanner = makeScanner();
    const hello = scannerHello(scanner);
    const envelopePayload = encryptPayload(hello, host.publicKeyBase64Url, { kid: 'scan' });
    service.pushInbound(host.status().channelId, envelopePayload);

    const status = await host.pollOnce();
    assert.equal(status.state, 'exchange');
    assert.equal(status.peerChannelId, scanner.channelId);
    assert.ok(status.lastSeq >= 1);

    // Presenter 不回应 hello；而是立刻发自己的首条 exchange 消息（无账号 → recovery_code_request）。
    const replies = service.outboundFor(scanner.channelId);
    assert.ok(replies.length >= 1, '应向 scanner 频道发首条 exchange 消息');
    const sent = replies[0].messages[0];
    assert.equal(sent.version, '2');
    const decrypted = JSON.parse(decryptEnvelope(sent.payload, scanner.privateKey));
    assert.equal(decrypted.type, 'recovery_code_request');
    assert.equal(decrypted.kind, '3party');
    assert.equal(typeof decrypted.name, 'string');
    assert.ok(decrypted.name.length > 0);
    assert.ok(crypto);
  } finally {
    host.stop();
  }
});

test('self_scan / version mismatch / sequence gap → failed + endReason', async () => {
  // self scan
  {
    const service = createMockSyncService();
    const host = await startHost(service);
    try {
      const hello = scannerHello({ channelId: host.status().channelId, publicKeyBase64Url: 'ZmFrZQ' });
      service.pushInbound(
        host.status().channelId,
        encryptPayload(hello, host.publicKeyBase64Url)
      );
      const status = await host.pollOnce();
      assert.equal(status.state, 'failed');
      assert.equal(status.endReason, 'self_scan');
    } finally {
      host.stop();
    }
  }
  // version mismatch
  {
    const service = createMockSyncService();
    const host = await startHost(service);
    try {
      const scanner = makeScanner();
      const hello = scannerHello({ ...scanner, version: '1' });
      service.pushInbound(host.status().channelId, encryptPayload(hello, host.publicKeyBase64Url));
      const status = await host.pollOnce();
      assert.equal(status.state, 'failed');
      assert.equal(status.endReason, 'version_mismatch');
    } finally {
      host.stop();
    }
  }
  // sequence gap
  {
    const service = createMockSyncService();
    const host = await startHost(service);
    try {
      const scanner = makeScanner();
      service.pushInbound(
        host.status().channelId,
        encryptPayload(scannerHello(scanner), host.publicKeyBase64Url),
        1
      );
      await host.pollOnce();
      assert.equal(host.status().state, 'exchange');
      service.pushInbound(
        host.status().channelId,
        encryptPayload(JSON.stringify({ type: 'noop' }), scanner.publicKeyBase64Url),
        3
      );
      const status = await host.pollOnce();
      assert.equal(status.state, 'failed');
      assert.equal(status.endReason, 'sequence_gap');
    } finally {
      host.stop();
    }
  }
});

test('GET 频道 404 → read_channel_lost（failed）', async () => {
  const service = createMockSyncService({ getStatusResolver: () => 404 });
  const host = await startHost(service);
  try {
    const status = await host.pollOnce();
    assert.equal(status.state, 'failed');
    assert.equal(status.endReason, 'read_channel_lost');
  } finally {
    host.stop();
  }
});

test('waitForPeer：无配对设备时超时抛 PairingError(timeout)', async () => {
  const service = createMockSyncService();
  const host = await startHost(service);
  try {
    await assert.rejects(
      () => host.waitForPeer({ timeoutMs: 1100 }),
      (error) => {
        assert.ok(error instanceof PairingError);
        assert.equal(error.code, 'timeout');
        return true;
      }
    );
  } finally {
    host.stop();
  }
});

test('recovery_code_request：有 recoveryCode → 回 response 并 completed(host)', async () => {
  const service = createMockSyncService();
  const host = await startHost(service, { account: { getRecoveryCode: () => 'QA-RECOVERY-CODE-001' } });
  try {
    const scanner = makeScanner();
    service.pushInbound(host.status().channelId, encryptPayload(scannerHello(scanner), host.publicKeyBase64Url));
    await host.pollOnce();
    assert.equal(host.status().state, 'exchange');

    const request = JSON.stringify({ type: 'recovery_code_request', name: 'ddg', kind: '3party' });
    service.pushInbound(host.status().channelId, encryptPayload(request, host.publicKeyBase64Url));
    const status = await host.pollOnce();
    assert.equal(status.state, 'completed');
    assert.equal(status.endReason, 'completed');
    assert.equal(status.completedAs, 'host');

    const outbound = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages);
    const response = outbound
      .map((message) => {
        try {
          return JSON.parse(decryptEnvelope(message.payload, scanner.privateKey));
        } catch {
          return null;
        }
      })
      .find((message) => message?.type === 'recovery_code_response');
    assert.ok(response, '应回 recovery_code_response');
    assert.equal(response.recovery_code, 'QA-RECOVERY-CODE-001');
  } finally {
    host.stop();
  }
});

test('recovery_code_request：无 account → recovery_code_unavailable + failed(unavailable)', async () => {
  const service = createMockSyncService();
  const host = await startHost(service);
  try {
    const scanner = makeScanner();
    service.pushInbound(host.status().channelId, encryptPayload(scannerHello(scanner), host.publicKeyBase64Url));
    await host.pollOnce();

    const request = JSON.stringify({ type: 'recovery_code_request', name: 'ddg', kind: '3party' });
    service.pushInbound(host.status().channelId, encryptPayload(request, host.publicKeyBase64Url));
    const status = await host.pollOnce();
    assert.equal(status.state, 'failed');
    assert.equal(status.endReason, 'unavailable');

    const outbound = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages);
    const unavailable = outbound
      .map((message) => {
        try {
          return JSON.parse(decryptEnvelope(message.payload, scanner.privateKey));
        } catch {
          return null;
        }
      })
      .find((message) => message?.type === 'recovery_code_unavailable');
    assert.ok(unavailable, '应回 recovery_code_unavailable');
  } finally {
    host.stop();
  }
});

test('status：状态字段完整；stop() 后保留最后状态；关闭后不可重复 start', async () => {
  const service = createMockSyncService();
  const host = await startHost(service);
  const before = host.status();
  for (const key of ['state', 'channelId', 'lastSeq', 'messages', 'endReason', 'qrUrl', 'pairingCode']) {
    assert.ok(key in before, `status 缺少 ${key}`);
  }
  const stopped = host.stop('aborted');
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.endReason, 'aborted');
  await assert.rejects(
    () => host.start(),
    (error) => error instanceof PairingError && error.code === 'invalid_argument'
  );
});

/* ------------------------------------------------------------------ */
/* v2.5 joiner 分支（task-26b：手机有账号时 host 加入而非报 unavailable） */
/* ------------------------------------------------------------------ */

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function officialCode(userId, secret) {
  return b64urlJson({ recovery: { user_id: userId, secret } });
}

/** 从 status/onCompleted 里兼容取 joiner 收到的官方恢复码字段。 */
function statusRecoveryCode(status) {
  if (!status) return null;
  return (
    status.recoveryCode ?? status.officialRecoveryCode ?? status.joinedRecoveryCode ?? status.official_recovery_code ?? null
  );
}

/** 兼容解析 recovery_code 字符串（base64url/base64 JSON 或已是对象）。 */
function decodeRecoveryCodeValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return null;
  for (const encoding of ['base64url', 'base64']) {
    try {
      return JSON.parse(Buffer.from(value, encoding).toString('utf8'));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 向 host 频道注入一条加密消息（scanner → host）。 */
function pushPeerMessage(service, host, scanner, message) {
  const payload = encryptPayload(JSON.stringify(message), host.publicKeyBase64Url, { kid: scanner.channelId });
  return service.pushInbound(host.status().channelId, payload);
}

/** 读回 host 发给 scanner 频道的消息（解密为对象）。 */
function hostMessagesFor(service, scanner) {
  return service
    .outboundFor(scanner.channelId)
    .flatMap((entry) => entry.messages)
    .map((message) => {
      try {
        return JSON.parse(decryptEnvelope(message.payload, scanner.privateKey));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function greetPeer(host, service, scanner) {
  pushPeerMessage(service, host, scanner, JSON.parse(scannerHello(scanner)));
  const status = await host.pollOnce();
  assert.equal(status.state, 'exchange', `hello 后应进入 exchange: ${JSON.stringify(status.state)}`);
  return status;
}

test('joiner：对方有账号（recovery_code_available）→ 不回任何消息；response 后 completed(joiner) 并暴露恢复码', async () => {
  const service = createMockSyncService();
  const completed = [];
  const host = await startHost(service, { onCompleted: (status) => completed.push(status) });
  try {
    const scanner = makeScanner();
    await greetPeer(host, service, scanner);

    const outboundBefore = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages).length;
    pushPeerMessage(service, host, scanner, {
      type: 'recovery_code_available',
      name: 'ddg',
      kind: '3party',
      user_id: 'peer-user-1'
    });
    let status = await host.pollOnce();

    // 关键回归：对方有账号时 host 不应回任何消息（旧实现错误回 unavailable）
    const sentAfterAvailable = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages);
    assert.equal(
      sentAfterAvailable.length,
      outboundBefore,
      `收到 available 后不应有新出站消息（实际 +${sentAfterAvailable.length - outboundBefore}: ${JSON.stringify(
        hostMessagesFor(service, scanner).map((m) => m.type)
      )}）`
    );
    assert.equal(status.state, 'exchange', `available 后应等待对方 code（state=${status.state}）`);
    assert.equal(status.substate, 'joiner_awaiting');
    assert.equal(status.endReason, null);
    assert.equal(status.peerUserId, 'peer-user-1');

    // scanner 发回官方恢复码（base64url JSON {recovery:{user_id,secret}}）
    const peerCode = officialCode('peer-user-1', 'peer-secret-xyz');
    pushPeerMessage(service, host, scanner, { type: 'recovery_code_response', recovery_code: peerCode });
    status = await host.pollOnce();

    assert.equal(status.state, 'completed', `收到 response 后应 completed（实际 ${status.state}/${status.endReason}）`);
    assert.equal(status.endReason, 'completed');
    assert.equal(status.completedAs, 'joiner', `completedAs 应为 joiner（实际 ${status.completedAs}）`);

    const joined = statusRecoveryCode(status);
    assert.ok(joined, 'status 应暴露 joiner 收到的恢复码');
    assert.equal(status.recoveryCodeReceived, true);
    assert.equal(status.recoveryUserId, 'peer-user-1');
    const parsed = parseOfficialRecoveryCode(joined);
    assert.ok(parsed, `官方恢复码应可解析（实际 ${String(joined).slice(0, 40)}…）`);
    assert.equal(parsed.userId, 'peer-user-1');
    assert.equal(parsed.secret, 'peer-secret-xyz');
    assert.ok(completed.length >= 1, 'onCompleted 应被调用');
    const finalStatus = completed[completed.length - 1];
    assert.equal(finalStatus.state, 'completed');
    assert.ok(statusRecoveryCode(finalStatus), 'onCompleted 回调应带恢复码');
  } finally {
    host.stop();
  }
});

test('request + 本地官方恢复码 → 回 response（base64 JSON 正确）并 completed(host)', async () => {
  const service = createMockSyncService();
  const localCode = officialCode('local-user-9', 'local-secret-abc');
  const host = await startHost(service, { account: { getRecoveryCode: () => localCode } });
  try {
    const scanner = makeScanner();
    await greetPeer(host, service, scanner);

    pushPeerMessage(service, host, scanner, { type: 'recovery_code_request', name: 'ddg', kind: '3party' });
    const status = await host.pollOnce();
    assert.equal(status.state, 'completed');
    assert.equal(status.endReason, 'completed');
    assert.equal(status.completedAs, 'host');

    const response = hostMessagesFor(service, scanner).find((message) => message.type === 'recovery_code_response');
    assert.ok(response, 'host 应回 recovery_code_response');
    const decoded = parseOfficialRecoveryCode(response.recovery_code);
    assert.ok(decoded, `recovery_code 应可解析（实际 ${String(response.recovery_code).slice(0, 40)}…）`);
    assert.equal(decoded.userId, 'local-user-9');
    assert.equal(decoded.secret, 'local-secret-abc');
  } finally {
    host.stop();
  }
});

test('same_account：user_id 一致 → endReason same_account（completed）', async () => {
  const service = createMockSyncService();
  const host = await startHost(service, { account: { userId: 'same-user-1', getRecoveryCode: () => officialCode('same-user-1', 's') } });
  try {
    const scanner = makeScanner();
    await greetPeer(host, service, scanner);
    pushPeerMessage(service, host, scanner, {
      type: 'recovery_code_available',
      name: 'ddg',
      kind: '3party',
      user_id: 'same-user-1'
    });
    const status = await host.pollOnce();
    assert.equal(status.state, 'completed');
    assert.equal(status.endReason, 'same_account');
  } finally {
    host.stop();
  }
});

test('awaiting_confirmation → confirmed：重新请求恢复码（不直接 completed）；denied：failed(denied)', async () => {
  // confirmed: the official app asks its user; after confirmation it needs a new request before
  // it sends the recovery code. Completing here would falsely report success without joining.
  {
    const service = createMockSyncService();
    const host = await startHost(service);
    try {
      const scanner = makeScanner();
      await greetPeer(host, service, scanner);
      pushPeerMessage(service, host, scanner, {
        type: 'recovery_code_available',
        name: 'ddg',
        kind: '3party',
        user_id: 'peer-user-2'
      });
      await host.pollOnce();
      pushPeerMessage(service, host, scanner, { type: 'recovery_code_awaiting_confirmation' });
      let status = await host.pollOnce();
      assert.notEqual(status.state, 'failed', `awaiting_confirmation 不应 failed（${status.endReason}）`);
      const outboundBefore = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages).length;
      pushPeerMessage(service, host, scanner, { type: 'recovery_code_confirmed' });
      status = await host.pollOnce();
      assert.equal(status.state, 'exchange', `confirmed 后应继续等待（实际 ${status.state}/${status.endReason}）`);
      assert.equal(status.substate, 'confirmed_requesting_code');
      const outboundAfter = service.outboundFor(scanner.channelId).flatMap((entry) => entry.messages);
      assert.equal(outboundAfter.length, outboundBefore + 1, 'confirmed 后应重新发送 recovery_code_request');
      const sentMessages = hostMessagesFor(service, scanner);
      assert.equal(sentMessages[sentMessages.length - 1].type, 'recovery_code_request');
      // 手机在确认后收到新的 request 才回码
      pushPeerMessage(service, host, scanner, {
        type: 'recovery_code_response',
        recovery_code: officialCode('peer-user-2', 'peer-secret-2')
      });
      status = await host.pollOnce();
      assert.equal(status.state, 'completed', `response 后应 completed（实际 ${status.state}/${status.endReason}）`);
      assert.equal(status.completedAs, 'joiner');
    } finally {
      host.stop();
    }
  }
  // denied
  {
    const service = createMockSyncService();
    const host = await startHost(service);
    try {
      const scanner = makeScanner();
      await greetPeer(host, service, scanner);
      pushPeerMessage(service, host, scanner, {
        type: 'recovery_code_available',
        name: 'ddg',
        kind: '3party',
        user_id: 'peer-user-3'
      });
      await host.pollOnce();
      pushPeerMessage(service, host, scanner, { type: 'recovery_code_denied' });
      const status = await host.pollOnce();
      assert.equal(status.state, 'failed');
      assert.match(String(status.endReason), /denied/i, `denied 应体现在 endReason（实际 ${status.endReason}）`);
    } finally {
      host.stop();
    }
  }
});
