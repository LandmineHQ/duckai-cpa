/**
 * v2.32：额度耗尽 → 身份临时冷却（不解绑已有会话，按需改绑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig } from './helpers/test-server.js';
import { createIdentityPool } from '../src/duck/identity-pool.js';

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

async function makePool(config = makeConfig()) {
  const dataDir = tmpDir('qa-cooldown');
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

test('冷却：markCooldown 后该身份被排除，到期自动恢复，可手动解除', async () => {
  const { pool } = await makePool();
  const generated = await pool.generate({ count: 2, labelPrefix: '冷却' });
  const ids = (generated?.items || generated || []).map((item) => item.id);
  assert.equal(ids.length, 2);

  await pool.markCooldown(ids[0], { until: Date.now() + 60000, reason: 'quota_exhausted', scope: 'entity' });
  const summary = await pool.list();
  const coolingItem = summary.find((item) => item.id === ids[0]);
  assert.equal(coolingItem.cooling, true);
  assert.ok(coolingItem.cooldownUntil > Date.now());

  // 新会话只会落到未冷却身份（池里还有 id_default，断言「不是冷却身份」即可）
  for (let i = 0; i < 5; i += 1) {
    const route = await pool.routeDetailed(`testsession:cooldown-${i}`, { paidModel: false });
    assert.notEqual(route.identityId, ids[0], '冷却身份不应参与路由');
  }

  // 过期后自动恢复（直接把冷却时间改到过去，模拟时间流逝）
  pool._pool.identities.find((item) => item.id === ids[0]).cooldownUntil = Date.now() - 1000;
  assert.equal(pool.pruneCooldowns() >= 1, true);
  const after = await pool.list();
  assert.equal(after.find((item) => item.id === ids[0]).cooling, false);

  // 手动解除
  await pool.markCooldown(ids[0], { until: Date.now() + 60000, reason: 'quota_exhausted' });
  const cleared = await pool.clearCooldown(ids[0]);
  assert.equal(cleared.cleared, true);
  assert.equal((await pool.list()).find((item) => item.id === ids[0]).cooling, false);
  await pool.dispose?.();
});

test('按需改绑：会话绑定冷却身份时，请求到来才换绑并持久化；未请求的会话保持原绑定', async () => {
  const { pool } = await makePool();
  const generated = await pool.generate({ count: 2, labelPrefix: '按需' });
  const ids = (generated?.items || generated || []).map((item) => item.id);
  assert.equal(ids.length, 2);

  const sessionKey = 'testsession:lazy-rebind';
  const routed = await pool.routeDetailed(sessionKey, { paidModel: false });
  const boundId = routed.identityId;

  // 冷却当前绑定的身份（其他身份仍可用：池里还有另一个生成身份 + id_default）
  await pool.markCooldown(boundId, { until: Date.now() + 30000, reason: 'quota_exhausted' });

  // 绑定仍在（没有提前解绑）
  const bindingsBefore = await pool.listBindings({ limit: 10 });
  const binding = bindingsBefore.items.find((item) => item.sessionKey === sessionKey);
  assert.equal(binding.identityId, boundId, '冷却不会提前解绑已有会话');

  // 请求到来 → 按需改绑到其他身份
  const moved = await pool.routeDetailed(sessionKey, { paidModel: false });
  assert.notEqual(moved.identityId, boundId, '请求到来时应交给其他身份');
  assert.equal(moved.rebound, true);
  assert.equal(moved.reboundReason, 'quota_cooldown');
  const otherId = moved.identityId;

  // 已持久化新绑定
  const bindingsAfter = await pool.listBindings({ limit: 10 });
  assert.equal(bindingsAfter.items.find((item) => item.sessionKey === sessionKey).identityId, otherId);

  // 冷却身份恢复后，该会话仍留在新身份（除非新身份也冷却）——符合「交给其他身份后持久化」
  await pool.clearCooldown(boundId);
  const again = await pool.routeDetailed(sessionKey, { paidModel: false });
  assert.equal(again.identityId, otherId);
  await pool.dispose?.();
});

test('全部身份冷却 → 429 all_identities_cooling 且带 retryAfterMs', async () => {
  const { pool } = await makePool();
  await pool.generate({ count: 2, labelPrefix: '全冷' });
  // 把池内所有身份都打上冷却（池里还有 id_default）
  for (const item of await pool.list()) {
    await pool.markCooldown(item.id, { until: Date.now() + 120000, reason: 'quota_exhausted' });
  }
  let error = null;
  try {
    await pool.routeDetailed('testsession:all-cooling', { paidModel: false });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '应抛出错误');
  assert.equal(error.code, 'all_identities_cooling');
  assert.equal(error.status, 429);
  assert.ok(error.retryAfterMs > 0);
  await pool.dispose?.();
});

test('API：身份列表暴露 cooling 字段，DELETE /identities/:id/cooldown 解除', async () => {
  const dataDir = tmpDir('qa-cooldown-api');
  await fs.mkdir(dataDir, { recursive: true });
  await withServer({ pool: true, withIdentities: true, dataDir }, async ({ baseUrl, store }) => {
    const identityPool = store.identities;
    const generated = await identityPool.generate({ count: 1, labelPrefix: 'API冷却' });
    const generatedItems = generated?.items || generated || [];
    const identityId = generatedItems[0].id;
    await identityPool.markCooldown(identityId, { until: Date.now() + 60000, reason: 'quota_exhausted' });

    const headers = { authorization: `Bearer ${makeConfig().auth.adminToken}` };
    let res = await fetch(`${baseUrl}/admin/api/identities`, { headers });
    const list = await res.json();
    const item = (list.items || []).find((entry) => entry.id === identityId);
    assert.equal(item?.cooling, true, '列表应带 cooling');

    res = await fetch(`${baseUrl}/admin/api/identities/${identityId}/cooldown`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).cleared, true);

    res = await fetch(`${baseUrl}/admin/api/identities`, { headers });
    const after = (await res.json()).items.find((entry) => entry.id === identityId);
    assert.equal(after.cooling, false);
  });
});
