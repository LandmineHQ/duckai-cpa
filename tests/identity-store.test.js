/**
 * v2.2 稳定身份 store（src/duck/identity.js）。
 *
 * 断言：
 *   - 同 dataDir 两次 createIdentityStore → journeyId/deviceId/durableStream 指纹一致；
 *   - getRaw() 含私钥（合法 RSA-OAEP-256 JWK），fingerprint = sha256(SPKI) 前 32 hex；
 *   - getFileInfo 指向 identity.json，文件非空；原子写无残留 tmp；
 *   - 损坏 identity.json → 自动备份 identity.corrupt-*.json 并重建；
 *   - 未配置 identity 时的 DuckClient 降级（volatile）在 duck-client 测试覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createIdentityStore, IdentityStore, IdentityError } from '../src/duck/identity.js';

async function tempDir() {
  return path.join(os.tmpdir(), `duckai-qa-idstore-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function spkiFingerprint(jwk) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32);
}

test('导出契约：IdentityStore / IdentityError / createIdentityStore', () => {
  assert.equal(typeof IdentityStore, 'function');
  assert.equal(typeof createIdentityStore, 'function');
  assert.equal(typeof IdentityError, 'function');
});

test('同 dataDir 两次创建 store → journeyId/deviceId/指纹一致（稳定身份）', async () => {
  const dataDir = await tempDir();
  try {
    const first = await createIdentityStore({ dataDir, config: {} });
    const firstRedacted = first.getRedacted();
    const firstRaw = first.getRaw();

    const second = await createIdentityStore({ dataDir, config: {} });
    const secondRedacted = second.getRedacted();

    assert.equal(secondRedacted.journeyId, firstRedacted.journeyId);
    assert.equal(secondRedacted.deviceId, firstRedacted.deviceId);
    assert.equal(secondRedacted.durableStream.fingerprint, firstRedacted.durableStream.fingerprint);
    assert.equal(second.getRaw().durableStream.privateKeyJwk.d, firstRaw.durableStream.privateKeyJwk.d);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('getRaw：publicKeyJwk 合法 RSA-OAEP-256；fingerprint=sha256(SPKI) 前 32 hex', async () => {
  const dataDir = await tempDir();
  try {
    const store = await createIdentityStore({ dataDir, config: {} });
    const raw = store.getRaw();
    assert.match(raw.journeyId, /^[a-f0-9]{32}$/);
    assert.match(raw.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const jwk = raw.durableStream.publicKeyJwk;
    assert.equal(jwk.kty, 'RSA');
    assert.equal(jwk.alg, 'RSA-OAEP-256');
    assert.equal(jwk.e, 'AQAB');
    assert.equal(typeof jwk.n, 'string');
    assert.equal(raw.durableStream.fingerprint, spkiFingerprint(jwk));
    assert.ok(raw.durableStream.privateKeyJwk.d, 'raw identity must include private key material (file-level)');

    // getRedacted 不含私钥/JWK 私有参数
    const redacted = store.getRedacted();
    const text = JSON.stringify(redacted);
    assert.ok(!text.includes('"privateKeyJwk"'));
    assert.ok(!text.includes('"d":"'));
    assert.equal(redacted.durableStream.hasPrivateKey, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('getFileInfo / 原子写：identity.json 存在且无 tmp 残留', async () => {
  const dataDir = await tempDir();
  try {
    const store = await createIdentityStore({ dataDir, config: {} });
    await store.flush?.();
    const info = store.getFileInfo();
    assert.ok(info.path.endsWith('identity.json'));
    assert.ok(info.bytes > 0);
    assert.equal(typeof info.updatedAt, 'number');

    const files = await fs.readdir(dataDir);
    assert.ok(files.includes('identity.json'));
    assert.deepEqual(
      files.filter((name) => name.includes('.tmp')),
      [],
      'atomic write must not leave tmp files behind'
    );
    const parsed = JSON.parse(await fs.readFile(info.path, 'utf8'));
    assert.equal(parsed.journeyId, store.getRedacted().journeyId);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('损坏 identity.json → 备份为 identity.corrupt-*.json 并重建', async () => {
  const dataDir = await tempDir();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'identity.json'), '{"version":1,"journeyId":not-json', 'utf8');
  try {
    const store = await createIdentityStore({ dataDir, config: {} });
    assert.match(store.getRedacted().journeyId, /^[a-f0-9]{32}$/);
    const files = await fs.readdir(dataDir);
    assert.ok(
      files.some((name) => name.startsWith('identity.corrupt-') && name.endsWith('.json')),
      `corrupt backup missing: ${files.join(', ')}`
    );
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, 'identity.json'), 'utf8'));
    assert.ok(parsed.journeyId);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
