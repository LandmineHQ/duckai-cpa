/**
 * v2.4 身份池 Admin API 契约（docs/IDENTITY-POOL.md §5）。
 *
 * 覆盖：
 *   - GET /admin/api/identities：pool 摘要（total/enabled/subscribed/activeId/bindingCount/maxIdentities，无 salt）、items 脱敏
 *   - POST /identities、/generate；GET/PATCH/DELETE /identities/:id；activate/rotate/export
 *   - 删除被绑定/active → 409 identity_in_use（?force=true 强制）
 *   - bindings：分页（limit/offset、上限 500）、手工绑定、解绑
 *   - routing/router：strategy/saltPresent/perIdentity；PATCH 切换策略与非法值 400
 *   - subscription：POST/DELETE /identities/:id/subscription
 *   - 会话 identityId/identityLabel 透出；healthz.identityPool；overview.identities
 *   - 未注入 pool → 503 identity_pool_unavailable
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startTestServer, withServer, adminRequest } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

async function tempDataDir(prefix = 'duckai-qa-pool-api') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function makeJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const b64url = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${b64url(header)}.${b64url(payload)}.${Buffer.from('fake-signature').toString('base64url')}`;
}

function plusToken(email = 'pool-plus@example.com') {
  const now = Math.floor(Date.now() / 1000);
  return makeJwt({
    api: 'Duck.ai',
    email,
    exp: now + 3600,
    iat: now,
    entitlements: [{ product: 'Duck.ai', name: 'plus' }]
  });
}

async function getIdentities(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/identities');
  assert.equal(res.status, 200, `HTTP ${res.status}: ${res.text}`);
  return res.json;
}

test('GET /admin/api/identities：pool 摘要 + items 脱敏', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const body = await getIdentities(baseUrl);
    assert.ok(body.pool && typeof body.pool === 'object', '缺少 pool');
    assert.equal(typeof body.pool.total, 'number');
    assert.equal(typeof body.pool.enabled, 'number');
    assert.equal(typeof body.pool.subscribed, 'number');
    assert.equal(typeof body.pool.bindingCount, 'number');
    assert.equal(typeof body.pool.maxIdentities, 'number');
    assert.ok(body.pool.activeId);
    assert.ok(!('salt' in body.pool), 'pool 不应返回 salt');
    assert.ok(Array.isArray(body.items) && body.items.length >= 1);
    const item = body.items[0];
    for (const key of ['id', 'label', 'enabled', 'subscribed', 'journeyId', 'deviceId', 'fingerprint']) {
      assert.ok(key in item, `item 缺少 ${key}`);
    }
    assert.ok(item.queue && typeof item.queue.waiting === 'number' && typeof item.queue.inFlight === 'number');
    const text = JSON.stringify(body);
    assert.ok(!text.includes('privateKeyJwk'), '列表泄漏 privateKeyJwk');
    assert.ok(!text.includes('"token"'), '列表泄漏 token');
  });
});

test('生成/创建/详情/更新/activate/rotate/export', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
      method: 'POST',
      body: { count: 2, labelPrefix: 'QA分身' }
    });
    assert.equal(generated.status, 200, generated.text);
    assert.equal(generated.json.items.length, 2);
    for (const item of generated.json.items) assert.match(item.label, /^QA分身/);

    const created = await adminRequest(baseUrl, '/admin/api/identities', {
      method: 'POST',
      body: { label: '手动QA' }
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.identity.id;
    assert.ok(id);

    const detail = await adminRequest(baseUrl, `/admin/api/identities/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.identity.id, id);

    const patched = await adminRequest(baseUrl, `/admin/api/identities/${id}`, {
      method: 'PATCH',
      body: { label: '改名QA', subscribed: true, enabled: true }
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.identity.label, '改名QA');
    assert.equal(patched.json.identity.subscribed, true);

    const activated = await adminRequest(baseUrl, `/admin/api/identities/${id}/activate`, {
      method: 'POST',
      body: {}
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.json.pool.activeId, id);

    const rotated = await adminRequest(baseUrl, `/admin/api/identities/${id}/rotate`, {
      method: 'POST',
      body: { scope: 'journey' }
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.json.identity.journeyId, patched.json.identity.journeyId ?? detail.json.identity.journeyId);

    const exported = await adminRequest(baseUrl, `/admin/api/identities/${id}/export`);
    assert.equal(exported.status, 200);
    assert.match(String(exported.headers.get('content-disposition')), /attachment; filename=.*\.json/);
    assert.ok(JSON.stringify(exported.json.identity ?? exported.json).includes('privateKeyJwk'), 'export 应含完整私钥');

    const notFound = await adminRequest(baseUrl, '/admin/api/identities/id_not_exist');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'identity_not_found');
  });
});

test('删除：被绑定/active → 409；?force=true 强制删除并清理绑定', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
      method: 'POST',
      body: { count: 2 }
    });
    const ids = generated.json.items.map((item) => item.id);
    const target = ids[0];

    const bound = await adminRequest(baseUrl, '/admin/api/identities/bindings', {
      method: 'POST',
      body: { sessionKey: 'sess_del_guard', identityId: target }
    });
    assert.equal(bound.status, 200, bound.text);

    const refused = await adminRequest(baseUrl, `/admin/api/identities/${target}`, { method: 'DELETE' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.error.code, 'identity_in_use');

    const forced = await adminRequest(baseUrl, `/admin/api/identities/${target}?force=true`, { method: 'DELETE' });
    assert.equal(forced.status, 200, forced.text);
    assert.equal(forced.json.ok, true);

    const after = await getIdentities(baseUrl);
    assert.equal(after.items.some((item) => item.id === target), false);
    const bindings = await adminRequest(baseUrl, '/admin/api/identities/bindings?limit=50');
    assert.equal(bindings.json.items.some((entry) => entry.sessionKey === 'sess_del_guard'), false);
  });
});

test('bindings：手工绑定/分页/解绑；routing/router 契约', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const generated = await adminRequest(baseUrl, '/admin/api/identities/generate', {
      method: 'POST',
      body: { count: 3 }
    });
    const ids = generated.json.items.map((item) => item.id);

    for (let index = 0; index < 3; index += 1) {
      const res = await adminRequest(baseUrl, '/admin/api/identities/bindings', {
        method: 'POST',
        body: { sessionKey: `sess_page_${index}`, identityId: ids[index] }
      });
      assert.equal(res.status, 200, res.text);
    }

    const page1 = await adminRequest(baseUrl, '/admin/api/identities/bindings?limit=2&offset=0');
    assert.equal(page1.status, 200);
    assert.equal(page1.json.items.length, 2);
    assert.ok(page1.json.total >= 3);
    const page2 = await adminRequest(baseUrl, '/admin/api/identities/bindings?limit=2&offset=2');
    assert.equal(page2.json.items.length, 1);
    const tooLarge = await adminRequest(baseUrl, '/admin/api/identities/bindings?limit=9999');
    assert.ok(tooLarge.status === 200 || tooLarge.status === 400);

    const unbound = await adminRequest(baseUrl, '/admin/api/identities/bindings/sess_page_0', { method: 'DELETE' });
    assert.equal(unbound.status, 200);
    const after = await adminRequest(baseUrl, '/admin/api/identities/bindings?limit=50');
    assert.equal(after.json.items.some((entry) => entry.sessionKey === 'sess_page_0'), false);

    const routing = await adminRequest(baseUrl, '/admin/api/identities/routing');
    assert.equal(routing.status, 200);
    assert.ok(['hash', 'least-loaded'].includes(routing.json.strategy));
    assert.equal(typeof routing.json.saltPresent, 'boolean');
    assert.ok(Array.isArray(routing.json.perIdentity));
    assert.ok(routing.json.totals);

    const switched = await adminRequest(baseUrl, '/admin/api/identities/router', {
      method: 'PATCH',
      body: { strategy: 'least-loaded' }
    });
    assert.equal(switched.status, 200, switched.text);
    const routing2 = await adminRequest(baseUrl, '/admin/api/identities/routing');
    assert.equal(routing2.json.strategy, 'least-loaded');

    const invalid = await adminRequest(baseUrl, '/admin/api/identities/router', {
      method: 'PATCH',
      body: { strategy: 'random' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_identity');
  });
});

test('subscription：POST 绑定 / DELETE 解除', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const created = await adminRequest(baseUrl, '/admin/api/identities', {
      method: 'POST',
      body: { label: '订阅身份' }
    });
    const id = created.json.identity.id;

    const bound = await adminRequest(baseUrl, `/admin/api/identities/${id}/subscription`, {
      method: 'POST',
      body: { token: plusToken() }
    });
    assert.equal(bound.status, 200, bound.text);
    assert.equal(bound.json.identity.subscribed, true);
    assert.ok(bound.json.subscription);
    assert.equal(bound.json.subscription.tier, 'plus');
    assert.ok(!bound.text.includes('fake-signature'));

    const cleared = await adminRequest(baseUrl, `/admin/api/identities/${id}/subscription`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.identity.subscribed, false);

    const invalid = await adminRequest(baseUrl, `/admin/api/identities/${id}/subscription`, {
      method: 'POST',
      body: { token: 'not-a-jwt' }
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.json.error.code, 'token_invalid');
  });
});

test('会话 identityId/identityLabel 透出；healthz.identityPool；overview.identities', async () => {
  const dataDir = await tempDataDir();
  await withServer({ withIdentities: true, dataDir }, async ({ baseUrl }) => {
    const session = await adminRequest(baseUrl, '/admin/api/test/sessions', {
      method: 'POST',
      body: { title: 'QA 池会话' }
    });
    assert.equal(session.status, 201, session.text);
    const sessionId = session.json.session.id;
    // v2.29：创建会话时不再预绑定身份，身份在首次消息请求后回填
    assert.equal(session.json.session.identityId, null, '创建会话时不应预绑定身份');
    assert.equal(session.json.session.identityLabel, null);

    const message = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { content: '你好' }
    });
    assert.equal(message.status, 200, message.text);

    const list = await adminRequest(baseUrl, '/admin/api/test/sessions');
    const listed = list.json.items.find((item) => item.id === sessionId);
    assert.ok(listed);
    assert.ok(listed.identityId, '请求后列表应带 identityId');
    assert.ok(listed.identityLabel, '请求后列表应带 identityLabel');

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.json.session.identityId, listed.identityId);

    const health = await adminRequest(baseUrl, '/healthz');
    assert.equal(health.status, 200);
    assert.ok(health.json.identityPool, 'healthz.identityPool missing');
    for (const key of ['total', 'enabled', 'subscribed', 'busy']) {
      assert.equal(typeof health.json.identityPool[key], 'number', `healthz.identityPool.${key}`);
    }

    const overview = await adminRequest(baseUrl, '/admin/api/overview');
    assert.ok(overview.json.identities, 'overview.identities missing');
    assert.ok(overview.json.identities.pool);
    assert.ok(Array.isArray(overview.json.identities.items));
  });
});

test('未注入身份池 → identities 端点 503 identity_pool_unavailable', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/admin/api/identities');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'identity_pool_unavailable');
  });
});
