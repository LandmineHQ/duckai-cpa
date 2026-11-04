/**
 * v2.2 稳定身份（docs/IDENTITY-SYNC.md §2/§3.1）。
 *
 * 覆盖：
 *   - data/identity.json 首次生成；同 dataDir 重启后 journeyId/deviceId/durableStream 指纹不变；
 *   - GET /admin/api/identity 字段完整、stable:true、source=file；不泄漏 privateKeyJwk / token 明文；
 *   - durableStream.publicKeyJwk 为合法 RSA-OAEP-256 JWK；fingerprint = sha256(SPKI) 前 32 hex；
 *   - rotate（journey/device/all）更新对应标识与 rotatedAt；
 *   - export → import 到新 dataDir 后身份一致；
 *   - 损坏 identity.json → 自动备份 identity.corrupt-*.json 并重建；
 *   - reveal 需要 confirm:true。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startTestServer, withServer, adminRequest } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

async function tempDataDir(prefix = 'duckai-qa-identity') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function getIdentity(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/identity');
  assert.equal(res.status, 200, `HTTP ${res.status}: ${res.text}`);
  return res.json;
}

/** 把 JWK 的 n/e 还原为 SPKI DER 并计算 sha256 前 32 hex（与契约 fingerprint 对齐）。 */
function spkiFingerprint(jwk) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32);
}

function assertNoSecrets(jsonText, secrets = []) {
  for (const marker of ['"privateKeyJwk"', '"d":"', 'BEGIN PRIVATE KEY']) {
    assert.ok(!jsonText.includes(marker), `response must not expose ${marker}`);
  }
  for (const secret of secrets) {
    if (secret) assert.ok(!jsonText.includes(secret), 'response must not expose raw token/secret');
  }
}

test('首次启动生成 identity.json；GET /admin/api/identity 字段完整且 stable', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, identity: true, cleanup: true });
  try {
    const { identity, durableStream, auth, sync, file } = await getIdentity(server.baseUrl);
    assert.match(identity.journeyId, /^[a-f0-9]{32}$/);
    assert.match(identity.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(typeof identity.deviceName, 'string');
    assert.equal(identity.stable, true);
    assert.ok(['file', 'generated'].includes(identity.source));
    assert.equal(typeof identity.createdAt, 'number');
    assert.equal(typeof identity.rotatedAt, 'number');

    assert.ok(durableStream.publicKeyJwk, 'durableStream.publicKeyJwk missing');
    assert.equal(durableStream.publicKeyJwk.kty, 'RSA');
    assert.equal(durableStream.publicKeyJwk.alg, 'RSA-OAEP-256');
    assert.equal(durableStream.publicKeyJwk.e, 'AQAB');
    assert.equal(typeof durableStream.publicKeyJwk.n, 'string');
    assert.equal(durableStream.hasPrivateKey, true);
    assert.equal(durableStream.fingerprint, spkiFingerprint(durableStream.publicKeyJwk));
    assert.equal(identity.fingerprint, durableStream.fingerprint);
    // v2.2：durableStream 运行态字段来自 DuckClient.health（仅当服务注入了 DuckClient 时才有）
    if (durableStream.configured !== undefined) {
      assert.equal(typeof durableStream.configured, 'boolean');
      assert.equal(typeof durableStream.enabled, 'boolean');
      assert.equal(typeof durableStream.degraded, 'boolean');
      assert.equal(typeof durableStream.rejectedCount, 'number');
      // 默认配置 identity.durableStream.enabled=true（Lead 裁决），未降级时 degraded 应为 false
      assert.equal(durableStream.degraded, false, '尚未出现上游 400 拒绝，不应处于 degraded');
    }

    assert.equal(auth.authenticated, false);
    assert.equal(auth.tier, 'free');
    assert.ok(Array.isArray(auth.entitlements));
    assert.equal(sync.enabled, false);
    assert.equal(sync.deviceCount, 0);
    assert.equal(file.path.endsWith('identity.json'), true);
    assert.equal(typeof file.bytes, 'number');
    assert.equal(typeof file.updatedAt, 'number');

    // 文件已落盘
    const stat = await fs.stat(file.path);
    assert.ok(stat.size > 0, 'identity.json should be written');
    assertNoSecrets(JSON.stringify({ identity, durableStream, auth, sync, file }));
  } finally {
    await server.close();
  }
});

test('默认配置：identity.durableStream.enabled 默认 true（v2.2 裁决）', async () => {
  const { normalizeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
  assert.equal(DEFAULT_CONFIG.identity.durableStream.enabled, true);
  const normalized = normalizeConfig({});
  assert.equal(normalized.identity.enabled, true);
  assert.equal(normalized.identity.durableStream.enabled, true);
  assert.equal(normalized.identity.sync.enabled, false);
});

test('同 dataDir 重启后 journeyId/deviceId/durableStream 指纹完全不变（稳定身份）', async () => {
  const dataDir = await tempDataDir();
  const first = await startTestServer({ duck: new MockDuckClient(), dataDir, identity: true, cleanup: false });
  let before;
  try {
    before = await getIdentity(first.baseUrl);
  } finally {
    await first.close();
  }

  const second = await startTestServer({ duck: new MockDuckClient(), dataDir, identity: true, cleanup: true });
  try {
    const after = await getIdentity(second.baseUrl);
    assert.equal(after.identity.journeyId, before.identity.journeyId);
    assert.equal(after.identity.deviceId, before.identity.deviceId);
    assert.equal(after.durableStream.fingerprint, before.durableStream.fingerprint);
    assert.equal(after.durableStream.publicKeyJwk.n, before.durableStream.publicKeyJwk.n);
    assert.equal(after.identity.createdAt, before.identity.createdAt);
    assert.equal(after.identity.stable, true);
    assert.equal(after.identity.source, 'file');
  } finally {
    await second.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('rotate：journey/device/all 分别轮换并更新 rotatedAt', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const original = await getIdentity(baseUrl);

    const journeyRotate = await adminRequest(baseUrl, '/admin/api/identity/rotate', {
      method: 'POST',
      body: { scope: 'journey' }
    });
    assert.equal(journeyRotate.status, 200);
    const rotated = journeyRotate.json.identity || journeyRotate.json;
    assert.notEqual(rotated.journeyId, original.identity.journeyId);
    assert.equal(rotated.deviceId, original.identity.deviceId);
    assert.ok(rotated.rotatedAt >= original.identity.rotatedAt);

    const deviceRotate = await adminRequest(baseUrl, '/admin/api/identity/rotate', {
      method: 'POST',
      body: { scope: 'device' }
    });
    assert.equal(deviceRotate.status, 200);
    const device = deviceRotate.json.identity || deviceRotate.json;
    assert.notEqual(device.deviceId, original.identity.deviceId);

    const allRotate = await adminRequest(baseUrl, '/admin/api/identity/rotate', {
      method: 'POST',
      body: { scope: 'all' }
    });
    assert.equal(allRotate.status, 200);
    const afterAll = await getIdentity(baseUrl);
    assert.notEqual(afterAll.identity.journeyId, device.journeyId);

    // v2.2：非法 scope 交给 identityStore 校验 → 400 invalid_identity
    const invalid = await adminRequest(baseUrl, '/admin/api/identity/rotate', {
      method: 'POST',
      body: { scope: 'everything' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_identity');
  });
});

test('export → import：新 dataDir 导入后身份一致；export 含完整私钥（仅下载）', async () => {
  const dataDir = await tempDataDir();
  const serverA = await startTestServer({ duck: new MockDuckClient(), dataDir, identity: true, cleanup: false });
  let exported;
  let before;
  try {
    before = await getIdentity(serverA.baseUrl);
    const res = await adminRequest(serverA.baseUrl, '/admin/api/identity/export');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-disposition')), /attachment; filename="duckai-identity-.*\.json"/);
    exported = res.json;
    assert.equal(exported.version, 1);
    assert.equal(typeof exported.exportedAt, 'number');
    // export 是唯一允许携带私钥/token 的下载接口
    assert.ok(JSON.stringify(exported.identity).includes('privateKeyJwk'));
  } finally {
    await serverA.close();
  }

  const dataDirB = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir: dataDirB, identity: true }, async ({ baseUrl }) => {
    const imported = await adminRequest(baseUrl, '/admin/api/identity/import', {
      method: 'POST',
      body: { identity: exported.identity }
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.ok, true);
    const after = await getIdentity(baseUrl);
    assert.equal(after.identity.journeyId, before.identity.journeyId);
    assert.equal(after.identity.deviceId, before.identity.deviceId);
    assert.equal(after.durableStream.fingerprint, before.durableStream.fingerprint);
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDirB, { recursive: true, force: true }).catch(() => {});
});

test('损坏 identity.json → 备份为 identity.corrupt-*.json 并重建', async () => {
  const dataDir = await tempDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'identity.json'), '{"journeyId": not-json', 'utf8');

  const server = await startTestServer({ duck: new MockDuckClient(), dataDir, identity: true, cleanup: false });
  try {
    const identity = await getIdentity(server.baseUrl);
    assert.match(identity.identity.journeyId, /^[a-f0-9]{32}$/);
    assert.equal(identity.identity.stable, true);

    const files = await fs.readdir(dataDir);
    assert.ok(
      files.some((name) => name.startsWith('identity.corrupt-') && name.endsWith('.json')),
      `corrupt backup missing: ${files.join(', ')}`
    );
    // 重建后文件合法
    const raw = await fs.readFile(path.join(dataDir, 'identity.json'), 'utf8');
    assert.ok(JSON.parse(raw).journeyId);
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('reveal：不带 confirm 拒绝；带 confirm 才返回字段（token/mainKey）', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const denied = await adminRequest(baseUrl, '/admin/api/identity/reveal', {
      method: 'POST',
      body: { field: 'token' }
    });
    assert.ok([400, 403].includes(denied.status), `expected 400/403 without confirm, got ${denied.status}`);
    assert.ok(denied.json.error);

    const invalidField = await adminRequest(baseUrl, '/admin/api/identity/reveal', {
      method: 'POST',
      body: { field: 'privateKeyJwk', confirm: true }
    });
    assert.ok([400, 403].includes(invalidField.status), 'reveal must restrict allowed fields');

    const confirmed = await adminRequest(baseUrl, '/admin/api/identity/reveal', {
      method: 'POST',
      body: { field: 'mainKey', confirm: true }
    });
    // sync 未启用时 mainKey 为 null/空：接口仍应成功（返回 null）或有明确错误，不能 500
    assert.ok([200, 400, 404].includes(confirmed.status), `unexpected status ${confirmed.status}`);
  });
});

test('GET /admin/api/identity 永不泄漏 active token 明文', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    // 激活一个伪造 but 结构合法的 JWT，再检查 identity 接口
    const token = makeJwt({ email: 'secret@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    const activate = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
      method: 'POST',
      body: { token }
    });
    assert.equal(activate.status, 200);
    const identity = await adminRequest(baseUrl, '/admin/api/identity');
    assertNoSecrets(identity.text, [token, token.split('.')[1]]);
    const subscription = await adminRequest(baseUrl, '/admin/api/subscription');
    assertNoSecrets(subscription.text, [token, token.split('.')[1]]);
  });
});

/** 构造三段式 JWT（签名无意义，但 payload 可被解析）。 */
function makeJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const b64url = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${b64url(header)}.${b64url(payload)}.${Buffer.from('fake-signature').toString('base64url')}`;
}
