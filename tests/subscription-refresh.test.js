/**
 * v2.27：订阅自动续期（refresh token）+ 删除绑定订阅的身份必须 409。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig } from './helpers/test-server.js';
import { createSubscriptionStore } from '../src/admin/subscriptions.js';

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function jwt({ email = 'refresh-test@example.com', tier = 'plus', expSeconds = 3600 } = {}) {
  return `${b64({ alg: 'none' })}.${b64({
    email,
    exp: Math.floor(Date.now() / 1000) + expSeconds,
    entitlements: [{ product: 'Duck.ai', name: tier }]
  })}.sig`;
}

/** 假的 duck.ai token 端点：返回新 access token + 轮换 refresh cookie。 */
function makeStubFetch({ tier = 'pro', rotated = true } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.cookie || null });
    const headers = { 'content-type': 'application/json' };
    if (rotated) headers['set-cookie'] = 'ddg_auth_refresh_token=ROTATED_REFRESH_TOKEN; Path=/; HttpOnly';
    return new Response(JSON.stringify({ access_token: jwt({ tier }), expires_in: 14400, token_type: 'Bearer' }), {
      status: 200,
      headers
    });
  };
  return { impl, calls };
}

test('订阅自动续期：保存 refresh token → 强制刷新 → 新 token/到期时间/轮换', async () => {
  const dir = path.join(process.cwd(), 'data', 'tmp', `qa-refresh-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const { impl, calls } = makeStubFetch({ tier: 'pro' });
  const store = await createSubscriptionStore({ dataDir: dir, logger: { warn() {}, info() {} }, fetchImpl: impl });

  const added = await store.add({ token: jwt({ tier: 'plus' }), label: '续期测试' });
  const id = added.subscription.id;
  assert.equal(added.subscription.autoRefresh, false, '默认无 refresh token');

  const withToken = await store.setRefreshToken(id, 'a.b.c');
  assert.equal(withToken.autoRefresh, true);
  assert.ok(!('refreshToken' in withToken), '视图不得暴露 refresh token 明文');

  const result = await store.refreshAccessToken(id, { force: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.rotatedRefreshToken, true);
  assert.equal(result.subscription.tier, 'pro', 'tier 应更新为 pro');
  assert.equal(result.subscription.refreshCount, 1);
  assert.ok(result.subscription.expiresAt);
  assert.equal(calls.length, 1);
  assert.match(calls[0].cookie, /ddg_auth_refresh_token=a\.b\.c/);

  // 轮换后的 refresh token 应被保存（再刷一次不应失败）
  const second = await store.refreshAccessToken(id, { force: true });
  assert.equal(second.refreshed, true);
  assert.equal(second.subscription.refreshCount, 2);

  // 清除自动续期
  const cleared = await store.clearRefreshToken(id);
  assert.equal(cleared.autoRefresh, false);
  await assert.rejects(
    () => store.refreshAccessToken(id, { force: true }),
    (error) => error.code === 'refresh_token_missing'
  );
});

test('订阅自动续期：未到期且非 force 时跳过', async () => {
  const dir = path.join(process.cwd(), 'data', 'tmp', `qa-refresh-skip-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const { impl, calls } = makeStubFetch();
  const store = await createSubscriptionStore({ dataDir: dir, logger: { warn() {}, info() {} }, fetchImpl: impl });
  const added = await store.add({ token: jwt({ expSeconds: 3600 }), label: '未到期' });
  await store.setRefreshToken(added.subscription.id, 'a.b.c');
  const result = await store.refreshAccessToken(added.subscription.id);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'not_expiring');
  assert.equal(calls.length, 0, '未到期不应发起网络请求');
});

test('订阅自动续期：上游失败 → refresh_failed 且记录 refreshError', async () => {
  const dir = path.join(process.cwd(), 'data', 'tmp', `qa-refresh-fail-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const store = await createSubscriptionStore({
    dataDir: dir,
    logger: { warn() {}, info() {} },
    fetchImpl: async () => new Response('{"error":"bad"}', { status: 401 })
  });
  const added = await store.add({ token: jwt(), label: '失败' });
  await store.setRefreshToken(added.subscription.id, 'a.b.c');
  await assert.rejects(
    () => store.refreshAccessToken(added.subscription.id, { force: true }),
    (error) => error.code === 'refresh_failed'
  );
  const view = await store.get(added.subscription.id);
  assert.ok(view.refreshError && view.refreshError.includes('401'));
});

test('API：refresh-token 保存/清除 + refresh 端点 + listNeedingRefresh', async () => {
  const dir = path.join(process.cwd(), 'data', 'tmp', `qa-refresh-api-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const { impl } = makeStubFetch({ tier: 'pro' });
  const subscriptions = await createSubscriptionStore({ dataDir: dir, logger: { warn() {}, info() {} }, fetchImpl: impl });
  const added = await subscriptions.add({ token: jwt({ tier: 'pro' }), label: 'API 测试' });
  const id = added.subscription.id;
  const H = {
    authorization: `Bearer ${makeConfig().auth.adminToken}`,
    'content-type': 'application/json'
  };

  await withServer({ subscriptions }, async ({ baseUrl }) => {
    let res = await fetch(`${baseUrl}/admin/api/subscriptions/${id}/refresh-token`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ refreshToken: 'a.b.c' })
    });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.subscription.autoRefresh, true);

    res = await fetch(`${baseUrl}/admin/api/subscriptions/${id}/refresh?force=true`, { method: 'POST', headers: H });
    assert.equal(res.status, 200);
    const refreshed = await res.json();
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.subscription.tier, 'pro');

    res = await fetch(`${baseUrl}/admin/api/subscriptions`, { headers: H });
    const list = await res.json();
    assert.equal(list.items[0].autoRefresh, true);
    assert.equal(list.items[0].refreshCount, 1);

    res = await fetch(`${baseUrl}/admin/api/subscriptions/${id}/refresh-token`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subscription.autoRefresh, false);

    // 非法 refresh token → 400
    res = await fetch(`${baseUrl}/admin/api/subscriptions/${id}/refresh-token`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ refreshToken: 'not-a-jwt' })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_refresh_token');
  });
});

test('身份删除：绑定订阅 → 409 identity_has_subscription；解绑后可删', async () => {
  const dir = path.join(process.cwd(), 'data', 'tmp', `qa-refresh-ident-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const { impl } = makeStubFetch();
  const subscriptions = await createSubscriptionStore({ dataDir: dir, logger: { warn() {}, info() {} }, fetchImpl: impl });
  const added = await subscriptions.add({ token: jwt({ tier: 'pro' }), label: '绑定测试' });

  const H = {
    authorization: `Bearer ${makeConfig().auth.adminToken}`,
    'content-type': 'application/json'
  };

  await withServer({ subscriptions, pool: true, withIdentities: true }, async ({ baseUrl }) => {
    // 生成一个身份
    let res = await fetch(`${baseUrl}/admin/api/identities/generate`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ count: 1, labelPrefix: '测试' })
    });
    assert.equal(res.status, 200);
    const created = (await res.json()).items[0];
    const identityId = created.id;

    // 绑定订阅
    res = await fetch(`${baseUrl}/admin/api/identities/${identityId}/subscription`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ subscriptionId: added.subscription.id })
    });
    assert.equal(res.status, 200);

    // 删除 → 409 identity_has_subscription
    res = await fetch(`${baseUrl}/admin/api/identities/${identityId}`, { method: 'DELETE', headers: H });
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.error.code, 'identity_has_subscription');
    assert.equal(body.error.subscriptionId, added.subscription.id);
    assert.match(String(body.error.hint || ''), /解绑|force/);

    // 解绑后删除成功（默认身份/会话绑定不适用新生成身份）
    res = await fetch(`${baseUrl}/admin/api/identities/${identityId}/subscription`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/admin/api/identities/${identityId}`, { method: 'DELETE', headers: H });
    assert.equal(res.status, 200);
  });
});
