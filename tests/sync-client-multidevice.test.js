/**
 * v2.9 Sync 多设备（src/duck/sync-client.js）：registerDevices 批量 / listDevicesDetailed 解密 / logoutDevices 批量。
 *
 * 按 duck-protocol 最终签名：
 *   - registerDevices([{deviceId,name?,type?}]) → 一次 GET /keys + 一次 PATCH /devices（updates.length===N，info 可解 {name,type}）
 *   - listDevicesDetailed() → 解密 info 得 name/type（失败 null、不泄漏 info/JWE）、current 标记
 *   - logoutDevices(ids) → 逐个 POST /logout-device；404 容忍；token 失效后自动重新 login
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createSyncClient } from '../src/duck/sync-client.js';
import { encryptJwe } from '../src/duck/jwe.js';
import { createEnvelope, decryptEnvelope } from '../src/duck/pairing.js';
import { createMockDuckSync } from './helpers/mock-duck-sync.js';

const SYNC_BASE = 'https://sync.example.test/sync';

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function makeCode(userId = 'user-multi-1', secret = crypto.randomBytes(32).toString('base64url')) {
  return b64urlJson({ recovery: { user_id: userId, secret } });
}

function deriveScoped(userId, secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'base64url'), Buffer.from(userId, 'utf8'), Buffer.from('Main Key', 'utf8'), 32));
}

function makeAccountInfo(scopedPassword) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const kid = crypto.randomUUID();
  const encryptedPrivateKey = encryptJwe(Buffer.from(der), Buffer.from(scopedPassword), { kid: '3party' });
  return {
    publicKey,
    privateKey,
    kid,
    publicJwk,
    record: {
      kid,
      purpose: 'account_info',
      encrypted_with: '3party',
      encrypted_private_key: encryptedPrivateKey,
      public_key: publicJwk
    }
  };
}

function clientFor(sync, extras = {}) {
  return createSyncClient({
    fetchImpl: sync.fetchImpl,
    baseUrl: SYNC_BASE,
    timeoutMs: 5000,
    ...extras
  });
}

function deviceInfo(publicJwk, kid, name, type = 'browser') {
  return createEnvelope(JSON.stringify({ name, type }), publicJwk, { kid, typ: 'device' }).payload;
}

test('registerDevices：一次 GET /keys + 一次 PATCH，updates 多条且 info 可解 {name,type}', async () => {
  const code = makeCode('user-batch-1', 'batch-secret');
  const creds = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')).recovery;
  const scoped = deriveScoped(creds.user_id, creds.secret);
  const accountInfo = makeAccountInfo(scoped);
  const d1 = crypto.randomUUID();
  const d2 = crypto.randomUUID();

  const sync = createMockDuckSync();
  const patched = [];
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-batch' } }));
  sync.on('GET', /\/keys$/, () => ({ status: 200, json: [accountInfo.record] }));
  sync.on('PATCH', /\/devices$/, ({ body }) => {
    patched.push(body);
    return { status: 200, json: { ok: true } };
  });
  sync.on('GET', /\/devices$/, () => ({
    status: 200,
    json: {
      devices: {
        entries: [
          { id: d1, jwt_iat: 111, name: 'DuckAI@main', type: 'browser' },
          { id: d2, jwt_iat: 222, name: 'DuckCPA@beef', type: 'browser' }
        ],
        entries_v2: [
          { credential_id: '3party', id: d1, info: patched[0]?.updates?.[0]?.info ?? null },
          { credential_id: '3party', id: d2, info: patched[1]?.updates?.[0]?.info ?? null }
        ]
      }
    }
  }));

  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId: d1 });
  try {
    await client.login();
    const result = await client.registerDevices([
      { deviceId: d1, name: 'DuckAI@main', type: 'browser' },
      { deviceId: d2, name: 'DuckCPA@beef' }
    ]);
    assert.equal(patched.length, 2, '真实服务每设备一次 PATCH（共 2 次）');
    for (const patch of patched) assert.equal(patch.updates.length, 1, '每次 PATCH 只允许 1 条 update');
    const updates = patched.map((patch) => patch.updates[0]);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].id, d1);
    assert.equal(updates[1].id, d2);
    const info1 = JSON.parse(decryptEnvelope(updates[0].info, accountInfo.privateKey));
    const info2 = JSON.parse(decryptEnvelope(updates[1].info, accountInfo.privateKey));
    assert.deepEqual(info1, { name: 'DuckAI@main', type: 'browser' });
    assert.deepEqual(info2, { name: 'DuckCPA@beef', type: 'browser' });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[1].type, 'browser', '缺省 type 应为 browser');
    assert.equal(result.items[0].credential_id, '3party');
    assert.ok(Array.isArray(result.devices));
    assert.equal(sync.requestList('GET', /\/keys$/).length, 1, '应只 GET /keys 一次');
  } finally {
    await client.close();
  }
});

test('listDevicesDetailed：解密 name/type（HONOR 等）、失败 null 不泄漏 info、current 标记', async () => {
  const code = makeCode('user-detail-1', 'detail-secret');
  const creds = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')).recovery;
  const scoped = deriveScoped(creds.user_id, creds.secret);
  const accountInfo = makeAccountInfo(scoped);
  const selfId = crypto.randomUUID();
  const phoneId = crypto.randomUUID();
  const badId = crypto.randomUUID();

  const sync = createMockDuckSync();
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-detail' } }));
  sync.on('GET', /\/keys$/, () => ({ status: 200, json: [accountInfo.record] }));
  sync.on('GET', /\/devices$/, () => ({
    status: 200,
    json: {
      devices: {
        entries: [{ id: selfId, jwt_iat: 111, name: 'DuckAI@main', type: 'browser' }],
        entries_v2: [
          { credential_id: '3party', id: selfId, info: deviceInfo(accountInfo.publicJwk, accountInfo.kid, 'DuckAI@main') },
          { credential_id: '3party', id: phoneId, info: deviceInfo(accountInfo.publicJwk, accountInfo.kid, 'HONOR BRT-AN00') },
          { credential_id: '3party', id: badId, info: 'not-a-valid-jwe' }
        ]
      }
    }
  }));

  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId: selfId });
  try {
    await client.login();
    const detailed = await client.listDevicesDetailed();
    assert.equal(detailed.length, 3);
    const phone = detailed.find((device) => device.id === phoneId);
    assert.equal(phone.name, 'HONOR BRT-AN00');
    assert.equal(phone.type, 'browser');
    assert.equal(phone.credential_id, '3party');
    assert.ok(phone.decoupled === true || phone.decoded === true || phone.decryptable === true, '应标记已解密');
    assert.equal(phone.info, undefined, '不应返回 info/JWE 原文');
    const self = detailed.find((device) => device.id === selfId);
    assert.equal(self.current, true, '本机应 current=true');
    const bad = detailed.find((device) => device.id === badId);
    assert.equal(bad.name, null);
    assert.equal(bad.type, null);
    assert.equal(bad.info, undefined);
  } finally {
    await client.close();
  }
});

test('logoutDevices：逐个 POST /logout-device；404 容忍；返回 removed/failed 明细', async () => {
  const code = makeCode('user-logout-multi-1', 'logout-multi-secret');
  const d1 = crypto.randomUUID();
  const d2 = crypto.randomUUID();
  const missing = crypto.randomUUID();
  const sync = createMockDuckSync();
  const posts = [];
  let logins = 0;
  sync.on('POST', /\/login$/, () => {
    logins += 1;
    return { status: 200, json: { token: `tok-${logins}` } };
  });
  sync.on('POST', /\/logout-device$/, ({ body }) => {
    posts.push(body.device_id);
    if (body.device_id === missing) return { status: 404, json: { error: 'not_found' } };
    return { status: 200, json: { ok: true } };
  });

  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId: d1 });
  try {
    await client.login();
    const result = await client.logoutDevices([d1, d2, missing]);
    assert.equal(posts.length, 3, '每个 id 一次 POST /logout-device');
    assert.deepEqual(posts.slice(0, 2), [d1, d2]);
    assert.equal(result.ok, true);
    assert.deepEqual([...result.removed].sort(), [d1, d2].sort());
    assert.equal(result.results.length, 3);
    assert.equal(sync.requestList('POST', /\/logout-device$/).length, 3);
  } finally {
    await client.close();
  }
});
