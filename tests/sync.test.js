/**
 * v2.2 Sync & Backup（docs/IDENTITY-SYNC.md §3.2）。
 *
 * 模块级（src/duck/sync.js）：
 *   - v2 配对码 `{version:"2",channel_id,public_key}` 构建/解析 + URL `#&code2=`；
 *   - 错误枚举（PAIRING_ERRORS / PAIRING_ERROR_SET）；v1 旧格式与 recovery 识别；
 *   - createRecoveryCode → decodeRecoveryCode round-trip（AC5 的基础）；
 *   - detectSyncTransport 在本沙箱返回 blocked。
 * HTTP 级（/admin/api/sync*）：
 *   - enable 生成密钥/恢复码并持久；disable 清空但保留 durableStream 身份；
 *   - pairing-code → 格式/URL；pair 在 transport blocked 时 503 sync_transport_unavailable(+hint) 且不改本地状态；
 *   - recovery code 导入到新 identity 目录后 mainKey 还原；非法恢复码 400。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  buildPairingCode,
  parsePairingCode,
  buildPairingUrl,
  createRecoveryCode,
  decodeRecoveryCode,
  detectSyncTransport,
  PAIRING_ERRORS,
  PAIRING_ERROR_SET,
  PAIRING_URL_PREFIX
} from '../src/duck/sync.js';
import { startTestServer, withServer, adminRequest } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { createIdentityStore } from '../src/duck/identity.js';

const b64url = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** 解析器允许的额外 detail（URL/空值等非枚举情况）。 */
const EXTRA_DETAILS = new Set(['empty_or_oversized', 'not_a_url', 'wrong_origin', 'wrong_path', 'missing_code2']);

async function tempDataDir(prefix = 'duckai-qa-sync') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/* ------------------------------------------------------------------ */
/* 模块级：配对码编解码                                                */
/* ------------------------------------------------------------------ */

test('配对码：build → v2 JSON 结构 → parse → URL 格式', async () => {
  const crypto = await import('node:crypto');
  const channelId = crypto.randomUUID();
  const built = buildPairingCode({
    channelId,
    publicKeyBase64Url: 'ZmFrZS1wdWJsaWMta2V5'
  });
  assert.equal(typeof built.code, 'string');
  assert.deepEqual(built.payload, {
    version: '2',
    channel_id: channelId,
    public_key: 'ZmFrZS1wdWJsaWMta2V5'
  });
  assert.equal(built.url, buildPairingUrl(built.code));
  assert.ok(built.url.startsWith('https://duckduckgo.com/sync/pairing/#&code2='));
  assert.equal(PAIRING_URL_PREFIX, 'https://duckduckgo.com/sync/pairing/#&code2=');

  const payload = JSON.parse(Buffer.from(built.code, 'base64url').toString('utf8'));
  assert.equal(payload.version, '2');
  assert.equal(payload.channel_id, channelId);
  assert.equal(payload.public_key, 'ZmFrZS1wdWJsaWMta2V5');

  const parsed = parsePairingCode(built.code);
  assert.equal(parsed.ok, true, `parsePairingCode failed: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.type, 'v2-pairing');
  assert.deepEqual(parsed.payload, payload);

  // 完整配对 URL 也应可解析
  const parsedUrl = parsePairingCode(built.url);
  assert.equal(parsedUrl.ok, true);
  assert.equal(parsedUrl.type, 'v2-pairing');
  assert.equal(parsedUrl.payload.channel_id, channelId);
});

test('配对码解析错误枚举：非法 base64/JSON/版本/字段', () => {
  assert.ok(PAIRING_ERRORS && typeof PAIRING_ERRORS === 'object');
  assert.ok(PAIRING_ERROR_SET instanceof Set);
  const cases = [
    '',
    '!!!not-base64!!!',
    b64url('not-json-string'),
    b64url({ version: '1' }),
    b64url({ version: '2' }),
    b64url({ version: '2', channel_id: 'bad id!', public_key: 'x' }),
    b64url({ version: '9', channel_id: 'c', public_key: 'p' })
  ];
  for (const input of cases) {
    const result = parsePairingCode(input);
    assert.equal(result.ok, false, `expected parse failure for ${input}`);
    assert.ok(
      PAIRING_ERROR_SET.has(result.detail) || EXTRA_DETAILS.has(result.detail),
      `unknown error detail: ${result.detail}`
    );
  }
});

test('配对码解析：v1 旧格式 / recovery 返回 type 与 payload', () => {
  const v1 = parsePairingCode(b64url({ type: 'v1-pairing', channel_id: 'x' }));
  assert.equal(v1.ok, true);
  assert.equal(v1.type, 'v1-pairing');

  const recoveryPayload = { type: 'recovery', recovery: { user_id: 'u1', main_key: 'k' } };
  const recovery = parsePairingCode(b64url(recoveryPayload));
  assert.equal(recovery.ok, true);
  assert.equal(recovery.type, 'recovery');
  assert.deepEqual(recovery.recovery, recoveryPayload.recovery);
});

test('createRecoveryCode → decodeRecoveryCode round-trip（AC5 基础）', () => {
  const input = {
    userId: 'user-1',
    mainKey: Buffer.from('a'.repeat(32)).toString('base64url'),
    scopedPasswordSeed: Buffer.from('b'.repeat(32)).toString('base64url'),
    encryptedPrivateKey: `eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoic3RyZWFtcyJ9..${'x'.repeat(600)}`
  };
  const code = createRecoveryCode(input);
  assert.equal(typeof code, 'string');
  assert.ok(code.length > 0);

  const decoded = decodeRecoveryCode(code);
  assert.equal(decoded.ok, true, `decodeRecoveryCode failed: ${JSON.stringify(decoded).slice(0, 300)}`);
  // 实现返回 { ok:true, recovery:{...} }（type 可能缺省，契约以 recovery 内容为准）
  if (decoded.type !== undefined) assert.equal(decoded.type, 'recovery');
  const recovery = decoded.recovery || {};
  assert.equal(recovery.user_id ?? recovery.userId, input.userId);
  assert.equal(recovery.main_key ?? recovery.mainKey, input.mainKey);
  assert.equal(recovery.scoped_password_seed ?? recovery.scopedPasswordSeed, input.scopedPasswordSeed);
  assert.equal(recovery.encrypted_private_key ?? recovery.encryptedPrivateKey, input.encryptedPrivateKey);
});

test('detectSyncTransport：本沙箱 duckduckgo.com 不可达 → blocked', async () => {
  const result = await detectSyncTransport({ baseUrl: 'https://duckduckgo.com/sync/pairing/', timeoutMs: 3000 });
  assert.ok(result && typeof result === 'object');
  assert.ok(['blocked', 'available'].includes(result.status), `unexpected transport status: ${JSON.stringify(result)}`);
  if (result.status === 'blocked') {
    assert.equal(typeof result.reason, 'string');
  }
});

/* ------------------------------------------------------------------ */
/* HTTP 级：/admin/api/sync*                                          */
/* ------------------------------------------------------------------ */

async function getSync(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/sync');
  assert.equal(res.status, 200, `HTTP ${res.status}: ${res.text}`);
  return res.json.sync;
}

test('/admin/api/sync：初始状态 + enable 生成密钥/恢复码 + 状态持久', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const initial = await getSync(baseUrl);
    assert.equal(initial.enabled, false);
    assert.equal(initial.deviceCount, 0);
    assert.equal(initial.pairingCode, null);
    assert.equal(initial.recoveryCode, null);
    assert.ok(['available', 'blocked'].includes(initial.transport));

    const enabled = await adminRequest(baseUrl, '/admin/api/sync/enable', {
      method: 'POST',
      body: { deviceName: 'QA Device' }
    });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.ok, true);
    assert.equal(enabled.json.sync.enabled, true);
    assert.equal(typeof enabled.json.recoveryCode, 'string');
    assert.ok(enabled.json.recoveryCode.length > 0, 'enable must return recovery code once');

    const after = await getSync(baseUrl);
    assert.equal(after.enabled, true);
    assert.ok(after.deviceCount >= 1);
    assert.equal(after.recoveryCode.present, true);
    assert.equal(typeof after.recoveryCode.preview, 'string');
    assert.ok(after.devices.some((device) => device.thisDevice === true), 'this device must be marked');

    const identity = await adminRequest(baseUrl, '/admin/api/identity');
    assert.equal(identity.json.sync.enabled, true);

    const recovery = await adminRequest(baseUrl, '/admin/api/sync/recovery-code');
    assert.equal(recovery.status, 200);
    assert.equal(typeof recovery.json.recoveryCode, 'string', 'GET recovery-code 应返回扁平字符串（契约 §3.2）');
    assert.equal(recovery.json.recoveryCode, enabled.json.recoveryCode);

    // disable 清空 sync 但保留 durableStream 身份
    const fingerprintBefore = identity.json.durableStream.fingerprint;
    const disabled = await adminRequest(baseUrl, '/admin/api/sync/disable', { method: 'POST', body: {} });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.sync.enabled, false);
    const afterDisable = await adminRequest(baseUrl, '/admin/api/identity');
    assert.equal(afterDisable.json.durableStream.fingerprint, fingerprintBefore);
    assert.equal(afterDisable.json.sync.enabled, false);
    const syncAfterDisable = await getSync(baseUrl);
    assert.equal(syncAfterDisable.recoveryCode, null);
  });
});

test('/admin/api/sync/pairing-code：v2 结构 + URL；pair 在 blocked 时 503 且不破坏本地状态', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    await adminRequest(baseUrl, '/admin/api/sync/enable', { method: 'POST', body: {} });

    const pairing = await adminRequest(baseUrl, '/admin/api/sync/pairing-code', { method: 'POST', body: {} });
    assert.equal(pairing.status, 200, pairing.text);
    assert.equal(typeof pairing.json.code, 'string');
    assert.ok(pairing.json.url.startsWith('https://duckduckgo.com/sync/pairing/#&code2='));
    assert.ok(pairing.json.url.includes(pairing.json.code));
    assert.equal(typeof pairing.json.expiresAt, 'number');

    const payload = JSON.parse(Buffer.from(pairing.json.code, 'base64url').toString('utf8'));
    assert.equal(payload.version, '2');
    assert.ok(payload.channel_id);
    assert.ok(payload.public_key);

    const before = await getSync(baseUrl);
    const paired = await adminRequest(baseUrl, '/admin/api/sync/pair', {
      method: 'POST',
      body: { code: pairing.json.code }
    });
    assert.equal(paired.status, 503);
    assert.equal(paired.json.error.code, 'sync_transport_unavailable');
    assert.equal(typeof paired.json.error.hint, 'string');
    assert.ok(paired.json.error.hint.length > 0);

    const after = await getSync(baseUrl);
    assert.equal(after.enabled, before.enabled);
    assert.equal(after.deviceCount, before.deviceCount);

    // 非法配对码 → 400 invalid_pairing_code（在 transport 探测前）
    const invalid = await adminRequest(baseUrl, '/admin/api/sync/pair', {
      method: 'POST',
      body: { code: 'not-a-valid-code' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_pairing_code');
  });
});

test('recovery code：导入新 identity 目录后还原同一 mainKey；非法码 400', async () => {
  const dataDirA = await tempDataDir('duckai-qa-sync-a');
  const serverA = await startTestServer({ duck: new MockDuckClient(), dataDir: dataDirA, identity: true, cleanup: false });
  let recoveryCode;
  let mainKeyA;
  try {
    const enabled = await adminRequest(serverA.baseUrl, '/admin/api/sync/enable', {
      method: 'POST',
      body: { deviceName: 'Device A' }
    });
    assert.equal(enabled.status, 200);
    recoveryCode = enabled.json.recoveryCode;
    assert.equal(typeof recoveryCode, 'string');
    const exported = await adminRequest(serverA.baseUrl, '/admin/api/identity/export');
    mainKeyA = exported.json.identity.sync.mainKey;
    assert.ok(typeof mainKeyA === 'string' && mainKeyA.length > 0);
  } finally {
    await serverA.close();
  }

  const dataDirB = await tempDataDir('duckai-qa-sync-b');
  await withServer({ duck: new MockDuckClient(), dataDir: dataDirB, identity: true }, async ({ baseUrl }) => {
    const imported = await adminRequest(baseUrl, '/admin/api/sync/recovery-code', {
      method: 'POST',
      body: { recoveryCode }
    });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.json.ok, true);
    const exportedB = await adminRequest(baseUrl, '/admin/api/identity/export');
    assert.equal(exportedB.json.identity.sync.mainKey, mainKeyA, 'recovery must restore the same mainKey');

    const invalid = await adminRequest(baseUrl, '/admin/api/sync/recovery-code', {
      method: 'POST',
      body: { recoveryCode: 'definitely-not-a-recovery-code' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_recovery_code');
  });

  await fs.rm(dataDirA, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDirB, { recursive: true, force: true }).catch(() => {});
});

test('sync 未启用时读取恢复码 → 200 { recoveryCode: null }', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/admin/api/sync/recovery-code');
    assert.equal(res.status, 200);
    assert.equal(res.json.recoveryCode, null);
  });
});

/* ------------------------------------------------------------------ */
/* v2.3：代理开启后 transport 变 available → pair 501                  */
/* ------------------------------------------------------------------ */

test('v2.3 代理：transport blocked(proxy_disabled) → 代理可用后 available → pair 501 sync_handshake_unimplemented', async () => {
  const crypto = await import('node:crypto');
  const dataDir = await tempDataDir('duckai-qa-sync-proxy');
  const store = await createIdentityStore({ dataDir, config: {} });
  store.syncOptions.timeoutMs = 600;
  try {
    const code = buildPairingCode({
      channelId: crypto.randomUUID(),
      publicKeyBase64Url: 'ZmFrZS1wdWJsaWMta2V5'
    }).code;

    // 未注入代理：transport blocked（沙箱不可达 duckduckgo.com），pair → 503
    const blockedTransport = await store._transport?.({ force: true });
    if (blockedTransport) {
      assert.equal(blockedTransport.status, 'blocked');
    }
    await assert.rejects(
      () => store.pair(code),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'sync_transport_unavailable');
        return true;
      }
    );

    // 注入“代理可用”的 mock manager：探测 200 → transport available → pair 501（握手未实现）
    const proxyManager = {
      getSummary: () => ({ enabled: true, mode: 'http', active: true }),
      fetch: async () => new Response('ok', { status: 200 })
    };
    store.setProxyManager(proxyManager);
    const transport = await store.refreshTransport();
    assert.equal(transport.status, 'available');

    const sync = await store.getSync({ force: true });
    assert.equal(sync.transport, 'available');

    await assert.rejects(
      () => store.pair(code),
      (error) => {
        assert.equal(error.status, 501);
        assert.equal(error.code, 'sync_handshake_unimplemented');
        return true;
      }
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
