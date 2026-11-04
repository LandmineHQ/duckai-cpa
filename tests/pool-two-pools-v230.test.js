/**
 * v2.30：双池路由（free 池 / 付费池，只绑定一次）+ 会话绑定缓存 TTL + 池设置 API。
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
function jwt({ tier = 'pro' } = {}) {
  return `${b64({ alg: 'none' })}.${b64({
    email: 'pool-test@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    entitlements: [{ product: 'Duck.ai', name: tier }]
  })}.sig`;
}

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

async function makePool({ config = makeConfig() } = {}) {
  const { createIdentityPool } = await import('../src/duck/identity-pool.js');
  const dataDir = tmpDir('qa-pool-v230');
  await fs.mkdir(dataDir, { recursive: true });
  const pool = await createIdentityPool({
    dataDir,
    config,
    logger: { info() {}, warn() {}, debug() {} },
    createRuntime: (record, ctx) => ({ identityId: ctx.identityId, identity: record, client: {}, queueWaitMs: 0 })
  });
  await pool.init?.();
  return { pool, dataDir };
}

test('双池路由：free 模型只绑 free 身份，切付费模型改绑订阅身份，再切回改绑 free', async () => {
  const { pool } = await makePool();
  const generated = await pool.generate({ count: 3, labelPrefix: '双池' });
  const ids = (generated?.items || generated || []).map((item) => item.id);
  assert.equal(ids.length, 3);

  // 给第一个身份绑定订阅（付费池）
  const { createSubscriptionStore } = await import('../src/admin/subscriptions.js');
  const dataDir = tmpDir('qa-pool-v230-subs');
  await fs.mkdir(dataDir, { recursive: true });
  const subscriptions = await createSubscriptionStore({ dataDir, logger: { info() {}, warn() {} } });
  const added = await subscriptions.add({ token: jwt({ tier: 'pro' }), label: '双池订阅' });
  await pool.bindSubscriptionToIdentity(ids[0], added.subscription.id, await subscriptions.getRaw(added.subscription.id));

  const key = 'testsession:two-pool';
  const freeRoute = await pool.routeDetailed(key, { paidModel: false });
  assert.notEqual(freeRoute.identityId, ids[0], 'free 模型不应绑定到订阅身份（free 池优先）');
  assert.equal((await pool.getSettings()).bindingsTotal >= 1, true);

  const paidRoute = await pool.routeDetailed(key, { paidModel: true });
  assert.equal(paidRoute.identityId, ids[0], '付费模型应改绑到订阅身份');
  assert.equal(paidRoute.rebound, true);
  assert.equal(paidRoute.reboundFrom, freeRoute.identityId);

  // 再发免费 → 改绑回 free 池
  const backRoute = await pool.routeDetailed(key, { paidModel: false });
  assert.notEqual(backRoute.identityId, ids[0], '切回免费模型应改绑回 free 池');
  assert.equal(backRoute.rebound, true);

  // 重复请求同一池 → 只复用绑定，不再改绑
  const again = await pool.routeDetailed(key, { paidModel: false });
  assert.equal(again.identityId, backRoute.identityId);
  assert.equal(again.rebound, false, '同一池内应复用绑定而不是重新绑定');
  await pool.dispose?.();
});

test('绑定缓存：TTL 内复用；超过 TTL 未使用自动解除并重新路由', async () => {
  const { pool } = await makePool();
  const generated = await pool.generate({ count: 2, labelPrefix: 'TTL' });
  const ids = (generated?.items || generated || []).map((item) => item.id);
  const key = 'testsession:ttl';
  const first = await pool.routeDetailed(key, { paidModel: false });
  assert.ok(first.identityId);

  // 篡改绑定时间：8 天前（默认 TTL 7 天）
  const poolState = pool._pool;
  poolState.bindings[key].updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const removed = pool.pruneBindings();
  assert.equal(removed, 1, '应清理过期绑定');
  assert.equal(pool._pool.bindings[key], undefined);

  // 再次请求 → 重新绑定（新绑定）
  const second = await pool.routeDetailed(key, { paidModel: false });
  assert.ok(second.identityId);
  assert.ok(pool._pool.bindings[key]);
  await pool.dispose?.();
});

test('池设置：getSettings 返回 bindingTtlDays；配置 0 表示永不过期', async () => {
  const config = makeConfig();
  config.pool = { ...(config.pool || {}), bindingTtlDays: 0 };
  const { pool } = await makePool({ config });
  assert.equal((await pool.getSettings()).bindingTtlDays, 0);
  // 0 = 永不过期：把绑定改成很久以前，也不应被清理
  const generated = await pool.generate({ count: 1, labelPrefix: 'NOEXP' });
  const ids = (generated?.items || generated || []).map((item) => item.id);
  const key = 'testsession:no-expire';
  await pool.routeDetailed(key, { paidModel: false });
  pool._pool.bindings[key].updatedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
  assert.equal(pool.pruneBindings(), 0, '0 表示永不过期');
  assert.ok(pool._pool.bindings[key]);
  await pool.dispose?.();
});

test('API：GET/PUT /admin/api/identities/settings（TTL 可配置、校验非法值）', async () => {
  const H = () => ({ authorization: `Bearer ${makeConfig().auth.adminToken}`, 'content-type': 'application/json' });
  await withServer({ pool: true, withIdentities: true }, async ({ baseUrl }) => {
    let res = await fetch(`${baseUrl}/admin/api/identities/settings`, { headers: H() });
    assert.equal(res.status, 200);
    const settings = await res.json();
    assert.equal(settings.bindingTtlDays, 7, '默认 7 天');

    res = await fetch(`${baseUrl}/admin/api/identities/settings`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ bindingTtlDays: 3 })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bindingTtlDays, 3);

    res = await fetch(`${baseUrl}/admin/api/identities/settings`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ bindingTtlDays: -5 })
    });
    assert.equal(res.status, 400, '非法值应被拒绝');

    res = await fetch(`${baseUrl}/admin/api/identities/settings`, { headers: H() });
    assert.equal((await res.json()).bindingTtlDays, 3, '非法请求不应修改原值');
  });
});
