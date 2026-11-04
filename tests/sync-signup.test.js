/**
 * v2.17 "Sync This Device Only" — POST /sync/signup payload（duck.ai signUpForPairing 等价）。
 *
 * 断言：
 *  - 请求体含 user_id(uuid) / hashed_password / credential_id:"3party" / keys[0]（ai_chats, JWE 私钥, JWK 公钥）/ scope:"ai_chats"
 *  - 返回的 recoveryCode 可被 parseOfficialRecoveryCode 解出同一 user_id/secret
 *  - client 已登录（token / userId 状态）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncClient } from '../src/duck/sync-client.js';
import { parseOfficialRecoveryCode } from '../src/duck/pairing.js';

test('signup：生成 /sync/signup 请求体并返回本机恢复码', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (String(url).endsWith('/signup')) {
      return new Response(JSON.stringify({ token: 'jwt-signup-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  const client = new SyncClient({
    baseUrl: 'https://sync.example.test/sync',
    fetchImpl,
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceName: 'DuckAI@main',
    deviceType: 'browser'
  });

  const result = await client.signup();
  assert.equal(calls.length, 1, '应只发起一次 /signup 请求');
  const request = calls[0];
  assert.match(request.url, /\/sync\/signup$/);
  assert.equal(request.method, 'POST');
  const body = request.body;
  assert.match(body.user_id, /^[0-9a-f-]{36}$/i, 'user_id 应为 uuid');
  assert.equal(typeof body.hashed_password, 'string');
  assert.ok(body.hashed_password.length > 20);
  assert.equal(body.credential_id, '3party');
  assert.equal(body.scope, 'ai_chats');
  assert.ok(Array.isArray(body.keys) && body.keys.length === 1, 'keys 应含 1 个 ai_chats key');
  const key = body.keys[0];
  assert.equal(key.purpose, 'ai_chats');
  assert.equal(key.encrypted_with, '3party');
  assert.match(key.kid, /^[0-9a-f-]{36}$/i);
  assert.equal(String(key.encrypted_private_key).split('.').length, 5, '私钥应为 5 段 JWE');
  assert.equal(key.public_key && key.public_key.kty, 'RSA', '公钥应为 RSA JWK');
  assert.equal(key.public_key.n.length > 100, true);
  assert.equal(key.public_key.alg, 'RSA-OAEP-256', 'public_key.alg 必填（上游校验 3-50 字符）');
  assert.equal(key.public_key.use, 'enc');
  // device triple（duck.ai PV()）：缺少 device_id 时上游返回
  // "Invalid $ARG->device_id. Length must be between 8 and 64 chars, was 0."
  assert.equal(body.device_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(String(body.device_name).split('.').length, 5, 'device_name 应为 JWE');
  assert.equal(String(body.device_type).split('.').length, 5, 'device_type 应为 JWE');

  // 恢复码与账号一致
  const parsed = parseOfficialRecoveryCode(result.recoveryCode);
  assert.ok(parsed, 'recoveryCode 应可解析');
  assert.equal(parsed.userId, result.userId);
  assert.equal(parsed.secret, result.secret);
  assert.equal(result.token, 'jwt-signup-token');
  assert.equal(client.userId, result.userId);
  assert.equal(client.loggedIn, true);
  assert.equal(client.deviceId, '11111111-1111-4111-8111-111111111111');
});

test('signup：/signup 200 但无 token 时回退 /login', async () => {
  let loginCalls = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/signup')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/login')) {
      loginCalls += 1;
      return new Response(JSON.stringify({ token: 'jwt-from-login' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('{}', { status: 404 });
  };
  const client = new SyncClient({ baseUrl: 'https://sync.example.test/sync', fetchImpl, deviceType: 'browser' });
  const result = await client.signup();
  assert.equal(loginCalls, 1, '无 token 时应回退 login');
  assert.equal(result.token, 'jwt-from-login');
});
