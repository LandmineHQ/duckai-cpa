/**
 * v2.29：连接测试要先发请求再绑定身份；付费模型需自动改绑到订阅身份。
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
function jwt({ tier = 'pro', email = 'routing-test@example.com' } = {}) {
  return `${b64({ alg: 'none' })}.${b64({
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    entitlements: [{ product: 'Duck.ai', name: tier }]
  })}.sig`;
}

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

const H = () => ({
  authorization: `Bearer ${makeConfig().auth.adminToken}`,
  'content-type': 'application/json'
});

test('identity-pool：绑定在 free 身份上时，付费模型请求自动改绑到订阅身份', async () => {
  const { createIdentityPool } = await import('../src/duck/identity-pool.js');
  const dataDir = tmpDir('qa-pool-rebind');
  await fs.mkdir(dataDir, { recursive: true });
  const pool = await createIdentityPool({
    dataDir,
    config: makeConfig(),
    logger: { info() {}, warn() {}, debug() {} },
    createRuntime: (record, ctx) => ({ identityId: ctx.identityId, identity: record, client: {}, queueWaitMs: 0 })
  });
  await pool.init?.();

  // 生成两个身份
  const generated = await pool.generate?.({ count: 2, labelPrefix: '路由测试' });
  const ids = (generated?.items || generated || []).map((item) => item.id).filter(Boolean);
  assert.ok(ids.length >= 2, `需要至少 2 个身份，实际 ${ids.length}`);
  const [first, second] = ids;

  // 绑定订阅到第二个身份
  const subscriptions = await createSubscriptionStore({
    dataDir,
    logger: { info() {}, warn() {} },
    fetchImpl: async () => new Response('{}', { status: 500 })
  });
  const added = await subscriptions.add({ token: jwt({ tier: 'pro' }), label: '路由测试订阅' });
  await pool.bindSubscriptionToIdentity(second, added.subscription.id, await subscriptions.getRaw(added.subscription.id));

  // 先把 session 绑定到第一个（free）身份
  const key = 'testsession:routing-rebind';
  const bound = await pool.routeDetailed(key, { paidModel: false });
  await pool.routeDetailed(key, { paidModel: false });
  assert.ok(bound.identityId);

  // 确保该 session 绑定的是 free 身份（若 hash 恰好选中订阅身份则跳过断言部分）
  const freeId = bound.identityId;

  // v2.30 起：付费请求默认改绑到订阅身份（不再 403）
  const routed = await pool.routeDetailed(key, { paidModel: true });
  assert.ok(routed.identityId);
  if (freeId !== second) {
    assert.equal(routed.identityId, second, '应改绑到订阅身份');
    assert.equal(routed.rebound, true);
    assert.equal(routed.reboundFrom, freeId);
  }
  // 再次路由→ 走绑定分支，保持订阅身份
  const again = await pool.routeDetailed(key, { paidModel: true });
  assert.equal(again.identityId, second);

  await pool.dispose?.();
});

test('API：创建测试会话不再预绑定身份；身份在消息请求后才回填', async () => {
  const dataDir = tmpDir('qa-session-bind');
  await fs.mkdir(dataDir, { recursive: true });
  const subscriptions = await createSubscriptionStore({ dataDir, logger: { info() {}, warn() {} } });
  const added = await subscriptions.add({ token: jwt({ tier: 'pro' }), label: '会话路由订阅' });

  await withServer(
    { subscriptions, pool: true, withIdentities: true },
    async ({ baseUrl }) => {
      // 生成身份并给其中一个绑定订阅
      let res = await fetch(`${baseUrl}/admin/api/identities/generate`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ count: 2, labelPrefix: '会话测试' })
      });
      assert.equal(res.status, 200);
      const created = (await res.json()).items;
      const target = created[created.length - 1];
      res = await fetch(`${baseUrl}/admin/api/identities/${target.id}/subscription`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ subscriptionId: added.subscription.id })
      });
      assert.equal(res.status, 200);

      // 创建会话：不应立即绑定身份
      res = await fetch(`${baseUrl}/admin/api/test/sessions`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ title: 'v229 会话' })
      });
      assert.equal(res.status, 201);
      const session = (await res.json()).session;
      assert.equal(session.identityId, null, '创建会话时不应预绑定身份');

      // 消息请求（mock 上游）后应回填身份
      res = await fetch(`${baseUrl}/admin/api/test/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ content: '你好' })
      });
      assert.equal(res.status, 200);
      res = await fetch(`${baseUrl}/admin/api/test/sessions/${session.id}`, { headers: H() });
      const detail = (await res.json()).session;
      assert.ok(detail.identityId, '请求后会话应回填实际路由的身份');

      // 清理
      res = await fetch(`${baseUrl}/admin/api/test/sessions/${session.id}`, { method: 'DELETE', headers: H() });
      assert.equal(res.status, 200);
      for (const item of created) {
        await fetch(`${baseUrl}/admin/api/identities/${item.id}?force=true`, { method: 'DELETE', headers: H() });
      }
    }
  );
});
