/**
 * v2 鉴权（BREAKING）：/v1/* 强制 API Key，/admin/api/* 强制 admin token。
 *
 * 依据 docs/ADMIN_API_V2.md §1：
 *   - 无 key / 错误 key → 401 authentication_error / invalid_api_key；
 *   - 合法 key 两类来源：config.auth.apiKeys（静态）+ data/keys.json（managed）；
 *   - auth.required 概念已删除（config 不再返回该字段）；
 *   - /healthz、/admin 静态公开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  withServer,
  makeConfig,
  request,
  v1Request,
  adminRequest,
  apiHeaders,
  ADMIN_TOKEN
} from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

test('/v1/* 强制 API Key：无 key/错 key 401，正确 key 200', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl, store }) => {
    // 无 key
    const noKey = await request(baseUrl, '/v1/models');
    assert.equal(noKey.status, 401);
    assert.equal(noKey.json.error.type, 'authentication_error');
    assert.equal(noKey.json.error.code, 'invalid_api_key');

    // 空 Bearer
    const empty = await request(baseUrl, '/v1/models', { headers: { authorization: 'Bearer ' } });
    assert.equal(empty.status, 401);

    // 错误 key
    const wrong = await request(baseUrl, '/v1/models', { headers: { authorization: 'Bearer sk-wrong-key' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_api_key');

    // 静态 key（config.auth.apiKeys）可用
    const ok = await v1Request(baseUrl, '/v1/models');
    assert.equal(ok.status, 200);

    // managed key（store.createKey）同样合法
    const created = store.createKey('agent-key');
    assert.match(created.key, /^sk-duck-/);
    const managed = await request(baseUrl, '/v1/models', { headers: { authorization: `Bearer ${created.key}` } });
    assert.equal(managed.status, 200);

    // chat 同样强制鉴权
    const chatNoKey = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(chatNoKey.status, 401);

    const chatOk = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(chatOk.status, 200);
  });
});

test('/admin/api/* 强制 admin token，且 API key 不能替代', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const noToken = await request(baseUrl, '/admin/api/overview');
    assert.equal(noToken.status, 401);

    const withApiKey = await request(baseUrl, '/admin/api/overview', { headers: apiHeaders() });
    assert.equal(withApiKey.status, 401, 'API key must not authorize admin API');

    const wrong = await request(baseUrl, '/admin/api/overview', {
      headers: { authorization: 'Bearer not-the-admin-token' }
    });
    assert.equal(wrong.status, 401);

    const ok = await adminRequest(baseUrl, '/admin/api/overview');
    assert.equal(ok.status, 200);

    // GET 允许 ?token=；写操作不接受 query token
    const queryToken = await request(baseUrl, `/admin/api/overview?token=${encodeURIComponent(ADMIN_TOKEN)}`);
    assert.equal(queryToken.status, 200);

    const postWithQuery = await request(baseUrl, `/admin/api/test/sessions?token=${encodeURIComponent(ADMIN_TOKEN)}`, {
      method: 'POST',
      body: { title: 'x' }
    });
    assert.equal(postWithQuery.status, 401);
  });
});

test('公开路由：/healthz 与 /admin 静态页无需鉴权', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const healthz = await request(baseUrl, '/healthz');
    assert.equal(healthz.status, 200);
    assert.equal(healthz.json.ok, true);
    assert.equal(healthz.json.service, 'duckai-cpa');

    const admin = await request(baseUrl, '/admin');
    assert.ok([200, 404].includes(admin.status), `unexpected /admin status: ${admin.status}`);
    assert.notEqual(admin.status, 401, '/admin static page must stay public');
  });
});

test('config 契约：不再包含 auth.required；PUT 也不会接受/回显', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const get = await adminRequest(baseUrl, '/admin/api/config');
    assert.equal(get.status, 200);
    assert.ok(get.json.config.auth, 'config.auth must exist');
    assert.equal('required' in get.json.config.auth, false, 'auth.required must be removed in v2');
    assert.equal(get.json.config.auth.adminToken, 'sk-***');

    const put = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { auth: { required: true } }
    });
    assert.equal(put.status, 200);
    assert.equal('required' in (put.json.config.auth || {}), false, 'auth.required must be ignored/rejected');
    assert.ok(get.json.config.upstream, 'config.upstream must exist');
  });
});

test('默认 API Key：keys 为空时 store 可创建 default key 并立即用于 /v1/*', async () => {
  // createServer 不负责自动创建（由 src/index.js 启动流程创建）；此处验证 store 契约，
  // 该行为保证「首次启动自动创建 default key」的实现底座可用。
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ auth: { apiKeys: [] } }) }, async ({ baseUrl, store }) => {
    const before = store.listKeys();
    assert.equal(before.length, 0);

    const created = store.createKey('default');
    const list = store.listKeys();
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'default');
    assert.equal(list[0].key, undefined, 'listKeys must not expose plaintext key');
    assert.match(list[0].keyPreview, /^sk-duck-/);

    const res = await request(baseUrl, '/v1/models', { headers: { authorization: `Bearer ${created.key}` } });
    assert.equal(res.status, 200);
  });
});

test('CORS 预检仍可用（OPTIONS 不需要 key）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const preflight = await request(baseUrl, '/v1/chat/completions', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(String(preflight.headers.get('access-control-allow-headers')), /Authorization/);
  });
});

test('/v1 未鉴权错误体为 OpenAI 风格，且无内部细节泄漏', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }] }
    });
    assert.equal(res.status, 401);
    assert.deepEqual(Object.keys(res.json.error).sort(), ['code', 'message', 'param', 'type']);
    assert.equal(res.json.error.type, 'authentication_error');
    assert.equal(res.json.error.code, 'invalid_api_key');
  });
});
