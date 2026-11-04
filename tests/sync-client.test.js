/**
 * v2.8 Sync 设备注册协议客户端（src/duck/sync-client.js）。
 *
 * 覆盖（duck-protocol 最终签名）：
 *   - HKDF：scopedPassword / hashed_password 用 node:crypto 独立复算对齐
 *   - login：POST /login，device_name/device_type 为 JWE（scopedPassword 可解），token 返回
 *   - keys：GET /keys 选 account_info（3party 优先）；缺失时创建 RSA 3072 + 私钥 JWE +
 *     POST set-if-absent
 *   - devices：PATCH /devices updates[{id,info}]，info 用 account_info 公钥加密、可解出 {name,type}；
 *     GET /devices 含本机；logoutDevice POST /logout-device
 *   - 错误映射：401 sync_unauthorized、网络 503 sync_transport_unavailable、PATCH 失败 502 sync_register_failed
 *   - createPairingAutoRegister：joiner+recoveryCode 才注册
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  deriveSyncKeys,
  credentialsFromRecoveryCode,
  createSyncClient,
  SyncClientError,
  defaultDeviceName,
  createPairingAutoRegister
} from '../src/duck/sync-client.js';
import { encryptJwe, decryptJwe } from '../src/duck/jwe.js';
import { createEnvelope, decryptEnvelope } from '../src/duck/pairing.js';
import { createMockDuckSync } from './helpers/mock-duck-sync.js';

const SYNC_BASE = 'https://sync.example.test/sync';

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function makeRecoveryCode(userId = 'user-1', secret = crypto.randomBytes(32).toString('base64url')) {
  return b64urlJson({ recovery: { user_id: userId, secret } });
}

function credentials(code) {
  return credentialsFromRecoveryCode(code);
}

/** 独立按契约复算 HKDF（不调用被测代码）。 */
function expectedKeys(userId, secret) {
  const secretBytes = Buffer.from(secret, 'base64url');
  const scopedPassword = Buffer.from(
    crypto.hkdfSync('sha256', secretBytes, Buffer.from(userId, 'utf8'), Buffer.from('Main Key', 'utf8'), 32)
  );
  const hashedPassword = Buffer.from(
    crypto.hkdfSync('sha256', secretBytes, Buffer.from(userId, 'utf8'), Buffer.from('Password', 'utf8'), 32)
  ).toString('base64url');
  return { secretBytes, scopedPassword, hashedPassword };
}

function makeAccountInfoRecord(scopedPassword) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const kid = crypto.randomUUID();
  const encryptedPrivateKey = encryptJwe(Buffer.from(JSON.stringify(privateJwk), 'utf8'), Buffer.from(scopedPassword), {
    kid: '3party'
  });
  return {
    publicKey,
    privateKey,
    kid,
    publicJwk,
    privateJwk,
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

/* ------------------------------------------------------------------ */
/* HKDF / login                                                        */
/* ------------------------------------------------------------------ */

test('deriveSyncKeys：scopedPassword / hashed_password 与独立 HKDF 复算一致', () => {
  const userId = 'user-hkdf-1';
  const secret = crypto.randomBytes(32).toString('base64url');
  const derived = deriveSyncKeys({ userId, secret });
  const expected = expectedKeys(userId, secret);

  assert.equal(Buffer.from(derived.scopedPassword).length, 32);
  assert.equal(Buffer.from(derived.scopedPassword).toString('hex'), expected.scopedPassword.toString('hex'));
  assert.equal(derived.hashedPassword, expected.hashedPassword);
  assert.equal(Buffer.from(derived.secretBytes).toString('hex'), expected.secretBytes.toString('hex'));
});

test('login：HKDF 字段正确、device_name/type 为 JWE（scopedPassword 可解）、token 返回', async () => {
  const code = makeRecoveryCode('user-login-1', 'login-secret-abc');
  const { userId, secret } = credentials(code);
  const keys = expectedKeys(userId, secret);
  const name = 'DuckCPA@1a2b';
  const deviceId = crypto.randomUUID();

  const sync = createMockDuckSync();
  sync.on('POST', /\/login$/, ({ body }) => {
    assert.equal(body.user_id, userId);
    assert.equal(body.hashed_password, keys.hashedPassword);
    assert.equal(body.device_id, deviceId);
    assert.equal(body.scope, 'ai_chats');
    for (const field of ['device_name', 'device_type']) {
      assert.equal(String(body[field]).split('.').length, 5, `${field} 应为 compact JWE`);
    }
    assert.equal(decryptJwe(body.device_name, Buffer.from(keys.scopedPassword)).toString('utf8'), name);
    assert.equal(decryptJwe(body.device_type, Buffer.from(keys.scopedPassword)).toString('utf8'), 'browser');
    return { status: 200, json: { token: 'server-token-1' } };
  });

  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId, deviceName: name });
  try {
    const session = await client.login();
    assert.equal(session.ok, true);
    assert.equal(session.userId, userId);
    assert.equal(session.token ?? session.jwt, 'server-token-1');
    assert.equal(sync.requestList('POST', /\/login$/).length, 1);
  } finally {
    await client.close();
  }
});

/* ------------------------------------------------------------------ */
/* keys / account_info                                                 */
/* ------------------------------------------------------------------ */

test('ensureAccountInfoKey：缺失时创建 RSA 3072 + 私钥 JWE + set-if-absent', async () => {
  const code = makeRecoveryCode('user-keys-1', 'keys-secret-abc');
  const { userId, secret } = credentials(code);
  const keys = expectedKeys(userId, secret);

  const sync = createMockDuckSync();
  let storedKey = null;
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-keys' } }));
  sync.on('GET', /\/keys$/, () => ({ status: 200, json: { keys: storedKey ? [storedKey] : [] } }));
  sync.on('POST', /\/keys\/purpose\/account_info\/set-if-absent$/, ({ body }) => {
    assert.ok(body?.key, 'set-if-absent body 应含 key');
    assert.equal(body.key.purpose, 'account_info');
    assert.equal(body.key.encrypted_with, '3party');
    storedKey = body.key;
    return { status: 200, json: { key: storedKey } };
  });

  const client = await clientFor(sync, { officialRecoveryCode: code });
  try {
    await client.login();
    const accountInfo = await client.ensureAccountInfoKey();
    assert.ok(accountInfo);
    assert.ok(accountInfo.kid);
    assert.equal(accountInfo.publicKeyJwk.kty, 'RSA');
    // 私钥 JWE 明文是 PKCS#8 DER 字节（真实 duck.ai 行为）；header kid=3party
    const jwe = accountInfo.encryptedPrivateKey ?? storedKey.encrypted_private_key;
    const der = decryptJwe(jwe, Buffer.from(keys.scopedPassword), { kid: '3party' });
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    assert.equal(privateKey.asymmetricKeyType, 'rsa');
    assert.equal(privateKey.asymmetricKeyDetails?.modulusLength, 3072, '应为 RSA 3072');
    assert.equal(sync.requestList('POST', /set-if-absent/).length, 1, '应只创建一次（set-if-absent）');
  } finally {
    await client.close();
  }
});

/* ------------------------------------------------------------------ */
/* devices                                                             */
/* ------------------------------------------------------------------ */

test('registerDevice：PATCH updates 含 id+info（可解出 {name,type}），GET devices 含本机', async () => {
  const code = makeRecoveryCode('user-dev-1', 'dev-secret-abc');
  const { userId, secret } = credentials(code);
  const keys = expectedKeys(userId, secret);
  const accountKey = makeAccountInfoRecord(keys.scopedPassword);
  const deviceId = crypto.randomUUID();
  const name = defaultDeviceName();
  assert.match(name, /^DuckCPA@[0-9a-f]{4}$/);

  const sync = createMockDuckSync();
  const patched = [];
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-dev' } }));
  sync.on('GET', /\/keys$/, () => ({ status: 200, json: { keys: [accountKey.record] } }));
  sync.on('PATCH', /\/devices$/, ({ body }) => {
    patched.push(body);
    return { status: 200, json: { ok: true } };
  });
  sync.on('GET', /\/devices$/, () => ({
    status: 200,
    json: {
      devices: [
        { id: deviceId, credential_id: '3party', info: patched[0]?.updates?.[0]?.info ?? null },
        { id: crypto.randomUUID(), credential_id: '3party', info: 'x' }
      ]
    }
  }));

  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId, deviceName: name });
  try {
    await client.login();
    const result = await client.registerDevice({ deviceId, name, type: 'browser' });
    assert.equal(result.ok, true);
    assert.equal(result.id, deviceId);
    assert.equal(result.name, name);
    assert.equal(result.type, 'browser');
    assert.equal(result.credential_id, '3party');
    assert.equal(patched.length, 1, '应发送一次 PATCH /devices');
    const updates = patched[0].updates;
    assert.ok(Array.isArray(updates) && updates.length === 1);
    assert.equal(updates[0].id, deviceId);
    assert.equal(typeof updates[0].info, 'string');

    // info 用 account_info 公钥加密 → 私钥解出 {name,type}
    const info = JSON.parse(decryptEnvelope(updates[0].info, accountKey.privateKey));
    assert.deepEqual(info, { name, type: 'browser' });

    const devices = await client.listDevices();
    assert.ok(devices.some((device) => device.id === deviceId), 'GET /devices 应含本机');
  } finally {
    await client.close();
  }
});

test('logoutDevice：POST /logout-device {device_id}', async () => {
  const code = makeRecoveryCode('user-logout-1', 'logout-secret');
  const deviceId = crypto.randomUUID();
  const oldDeviceId = crypto.randomUUID();
  const sync = createMockDuckSync();
  const loggedOut = [];
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-logout' } }));
  sync.on('POST', /\/logout-device$/, ({ body }) => {
    loggedOut.push(body);
    return { status: 200, json: { ok: true } };
  });
  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId });
  try {
    await client.login();
    await client.logoutDevice(oldDeviceId);
    assert.equal(loggedOut.length, 1);
    assert.equal(loggedOut[0].device_id, oldDeviceId);
  } finally {
    await client.close();
  }
});

test('listDevices：真实嵌套形状（entries + entries_v2）归一化合并', async () => {
  const code = makeRecoveryCode('user-nested-1', 'nested-secret');
  const sync = createMockDuckSync();
  sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-nested' } }));
  sync.on('GET', /\/devices$/, () => ({
    status: 200,
    json: {
      devices: {
        entries: [
          { id: 'dev-x', jwt_iat: 111, name: 'DuckCPA@aaaa', type: 'browser' },
          { id: 'dev-y', jwt_iat: 222, name: '旧手机', type: 'browser' }
        ],
        entries_v2: [
          { credential_id: '3party', id: 'dev-x', info: 'info-x' },
          { credential_id: '3party', id: 'dev-y', info: 'info-y' },
          { credential_id: '3party', id: 'dev-z', info: 'info-z' }
        ]
      }
    }
  }));
  const client = await clientFor(sync, { officialRecoveryCode: code, deviceId: crypto.randomUUID() });
  try {
    await client.login();
    const devices = await client.listDevices();
    assert.equal(devices.length, 3, `应合并 entries_v2（实际 ${JSON.stringify(devices.map((d) => d.id))}）`);
    const x = devices.find((device) => device.id === 'dev-x');
    assert.equal(x.info, 'info-x');
    assert.equal(x.credential_id, '3party');
    assert.equal(x.name, 'DuckCPA@aaaa');
    assert.equal(devices.find((device) => device.id === 'dev-z').info, 'info-z');
  } finally {
    await client.close();
  }
});
/* ------------------------------------------------------------------ */
/* 错误映射 / auto register                                             */
/* ------------------------------------------------------------------ */

test('错误映射：401 → sync_unauthorized；网络 → 503 sync_transport_unavailable；PATCH 失败 → 502 sync_register_failed', async () => {
  const code = makeRecoveryCode('user-err-1', 'err-secret');
  const deviceId = crypto.randomUUID();

  // 401
  {
    const sync = createMockDuckSync();
    sync.on('POST', /\/login$/, () => ({ status: 401, json: { error: 'unauthorized' } }));
    const client = await clientFor(sync, { officialRecoveryCode: code, deviceId });
    try {
      await assert.rejects(
        () => client.login(),
        (error) => {
          assert.ok(error instanceof SyncClientError);
          assert.equal(error.code, 'sync_unauthorized');
          assert.equal(error.status, 401);
          return true;
        }
      );
    } finally {
      await client.close();
    }
  }
  // 网络失败（fetch 抛错）
  {
    const sync = createMockDuckSync();
    sync.on('POST', /\/login$/, () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const client = await clientFor(sync, { officialRecoveryCode: code, deviceId });
    try {
      await assert.rejects(
        () => client.login(),
        (error) => {
          assert.ok(error instanceof SyncClientError);
          assert.equal(error.code, 'sync_transport_unavailable');
          assert.equal(error.status, 503);
          return true;
        }
      );
    } finally {
      await client.close();
    }
  }
  // /login HTTP 418（DuckDuckGo anti-abuse）→ SyncClientError 保留 httpStatus=418（由 Admin 层映射 429）
  {
    const sync = createMockDuckSync();
    sync.on('POST', /\/login$/, () => ({ status: 418, json: { error: 'anti-abuse' } }));
    const client = await clientFor(sync, { officialRecoveryCode: code, deviceId });
    try {
      await assert.rejects(
        () => client.login(),
        (error) => {
          assert.ok(error instanceof SyncClientError);
          assert.equal(error.status, 502);
          assert.equal(error.code, 'sync_login_failed');
          assert.equal(error.httpStatus, 418, '应保留 httpStatus=418 供上层映射');
          return true;
        }
      );
    } finally {
      await client.close();
    }
  }  // PATCH 500 → sync_register_failed
  {
    const { userId, secret } = credentials(code);
    const keys = expectedKeys(userId, secret);
    const accountKey = makeAccountInfoRecord(keys.scopedPassword);
    const sync = createMockDuckSync();
    sync.on('POST', /\/login$/, () => ({ status: 200, json: { token: 'tok-err' } }));
    sync.on('GET', /\/keys$/, () => ({ status: 200, json: { keys: [accountKey.record] } }));
    sync.on('PATCH', /\/devices$/, () => ({ status: 500, json: { error: 'boom' } }));
    const client = await clientFor(sync, { officialRecoveryCode: code, deviceId });
    try {
      await client.login();
      await assert.rejects(
        () => client.registerDevice({ deviceId, name: 'DuckCPA@ffff', type: 'browser' }),
        (error) => {
          assert.ok(error instanceof SyncClientError);
          assert.equal(error.status, 502);
          assert.equal(error.code, 'sync_register_failed');
          return true;
        }
      );
    } finally {
      await client.close();
    }
  }
});

test('createPairingAutoRegister：仅 completedAs=joiner 且有 recoveryCode 时 login+register', async () => {
  const calls = [];
  const fakeClient = {
    async login(params) {
      calls.push({ type: 'login', params });
      return { ok: true, userId: 'u-auto', deviceName: params.deviceName };
    },
    async registerDevice(params) {
      calls.push({ type: 'register', params });
      return { ok: true, id: params.deviceId, name: params.name, registeredAt: Date.now() };
    }
  };
  const handler = createPairingAutoRegister({
    syncClient: fakeClient,
    deviceId: crypto.randomUUID(),
    deviceName: 'DuckCPA@beef',
    type: 'browser'
  });

  handler({ state: 'completed', completedAs: 'host', recoveryCode: 'x' });
  handler({ state: 'completed', completedAs: 'joiner', recoveryCode: '' });
  assert.equal(calls.length, 0, '非 joiner 或无恢复码不应注册');

  handler({ state: 'completed', completedAs: 'joiner', recoveryCode: makeRecoveryCode('u-auto') });
  assert.ok(handler.pending, 'joiner 完成时应触发 pending 注册');
  const result = await handler.pending;
  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.type === 'register').length, 1);
  assert.equal(calls.find((call) => call.type === 'register').params.name, 'DuckCPA@beef');
});
