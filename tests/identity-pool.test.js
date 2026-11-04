/**
 * v2.4 身份池模块级单测（docs/IDENTITY-POOL.md §1–§4）。
 *
 * 覆盖：
 *   - 迁移 identity.json → id_default（原文件保留、activeId 指向）
 *   - generate 3 个身份唯一性（journeyId/deviceId/指纹）；列表脱敏
 *   - create/update/activate/rotate/exportIdentity→importIdentity 往返
 *   - 删除被绑定/active → 409 identity_in_use；force 清理绑定
 *   - bindings 持久化 + 重启不变；unbind 后重新路由
 *   - hash 路由公式（salt 固定时精确断言）、确定性、跨重启一致
 *   - 付费模型：无 subscribed 候选 → 403 model_requires_subscription；有 → 只路由 subscribed
 *   - 每身份队列：同身份串行(rps=1)/异身份并行、queueLimit→429 queue_full、queueTimeoutMs→429 queue_timeout、queueStats
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createIdentityStore } from '../src/duck/identity.js';
import {
  createPool,
  loadPoolModule,
  poolSummary,
  poolItems,
  resolveSession,
  expectedHashIdentity
} from './helpers/identity-pool-module.js';

async function tempDataDir(prefix = 'duckai-qa-pool') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function seedIdentityFile(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const store = await createIdentityStore({ dataDir, config: {} });
  const raw = store.getRaw();
  await store.flush?.();
  return raw;
}

function itemId(result) {
  return result?.identity?.id || result?.id || result?.item?.id || null;
}

function resolveId(result) {
  if (!result) return null;
  return result.identityId || result.identity?.id || result.id || null;
}

test('迁移：identity.json → id_default，activeId 指向，原文件保留', async () => {
  const dataDir = await tempDataDir();
  try {
    const raw = await seedIdentityFile(dataDir);
    const originalText = await fs.readFile(path.join(dataDir, 'identity.json'), 'utf8');

    const { pool, modulePath } = await createPool({ dataDir });
    assert.ok(modulePath.includes('identity-pool'));
    try {
      const summary = poolSummary(pool);
      assert.ok(summary);
      assert.equal(summary.activeId, 'id_default');
      assert.ok((summary.total ?? summary.identities ?? 0) >= 1);

      const items = poolItems(pool);
      const def = items.find((item) => item.id === 'id_default');
      assert.ok(def, '缺少 id_default');
      assert.equal(def.label, '默认身份');
      assert.equal(def.journeyId, raw.journeyId);
      assert.equal(def.fingerprint, raw.durableStream.fingerprint);

      assert.equal(await fs.readFile(path.join(dataDir, 'identity.json'), 'utf8'), originalText, '原 identity.json 应保留');
      // v2.69：SQLite 是唯一来源，不再生成 identity-pool.json 快照。
      await assert.rejects(fs.access(path.join(dataDir, 'identity-pool.json')), (error) => error.code === 'ENOENT');
      await fs.access(path.join(dataDir, 'duckai.db'));
      assert.equal(pool.getFileInfo?.().source, 'sqlite');
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('generate 3 个身份：journeyId/deviceId/指纹互不相同，列表脱敏且元数据正确', async () => {
  const dataDir = await tempDataDir();
  try {
    const { pool } = await createPool({ dataDir, config: { pool: { maxIdentities: 20 } } });
    try {
      const generated = await pool.generate({ count: 3, labelPrefix: '分身' });
      const genItems = Array.isArray(generated) ? generated : generated?.items || [];
      assert.ok(Array.isArray(genItems) && genItems.length === 3, `generate 返回异常: ${JSON.stringify(generated).slice(0, 200)}`);
      const items = poolItems(pool);
      assert.ok(items.length >= 4, `expected >=4（含默认）, got ${items.length}`);
      const journeys = new Set(items.map((item) => item.journeyId));
      const devices = new Set(items.map((item) => item.deviceId));
      const fingerprints = new Set(items.map((item) => item.fingerprint));
      assert.equal(journeys.size, items.length);
      assert.equal(devices.size, items.length);
      assert.equal(fingerprints.size, items.length);

      const text = JSON.stringify(items);
      assert.ok(!text.includes('privateKeyJwk'), 'list 泄漏 privateKeyJwk');
      assert.ok(!text.includes('"token"'), 'list 泄漏 token');

      for (const item of genItems) assert.match(String(item.label), /^分身/);
      assert.ok(items.every((item) => item.queue && typeof item.queue.waiting === 'number'));

      const summary = poolSummary(pool);
      assert.equal(summary.total, items.length);
      assert.equal(summary.enabled, items.filter((item) => item.enabled !== false).length);
      assert.equal(typeof summary.bindingCount, 'number');
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CRUD：create/update/activate/rotate/exportIdentity→importIdentity 往返', async () => {
  const dataDir = await tempDataDir();
  try {
    const { pool } = await createPool({ dataDir });
    try {
      const created = await pool.create({ label: '手动身份' });
      const id = itemId(created);
      assert.ok(id, `create 未返回 id: ${JSON.stringify(created).slice(0, 200)}`);

      const updated = await pool.update(id, { label: '改名' });
      assert.equal((updated?.identity || updated).label, '改名');

      await pool.activate(id);
      assert.equal(poolSummary(pool).activeId, id);

      const before = pool.get(id);
      const rotated = await pool.rotate(id, 'journey');
      const rotatedItem = rotated?.identity || rotated;
      assert.notEqual(rotatedItem.journeyId, before.journeyId);
      assert.equal(rotatedItem.deviceId, before.deviceId, 'scope=journey 不应改 deviceId');
      assert.notEqual(pool.get(id).journeyId, before.journeyId);

      const exported = await pool.exportIdentity(id);
      const doc = exported?.identity || exported;
      assert.ok(doc?.journeyId, 'export 缺 journeyId');
      assert.ok(doc?.durableStream?.privateKeyJwk, 'export 应含完整私钥');

      const dataDirB = await tempDataDir('duckai-qa-pool-import');
      try {
        const { pool: poolB } = await createPool({ dataDir: dataDirB });
        try {
          const imported = await poolB.importIdentity(doc, { label: '导入身份' });
          const importedId = itemId(imported);
          const importedItem = poolB.get(importedId);
          assert.ok(importedItem);
          assert.equal(importedItem.journeyId, doc.journeyId);
          assert.equal(importedItem.fingerprint, doc.durableStream.fingerprint);
          assert.equal(importedItem.label, '导入身份');
        } finally {
          await poolB.close?.();
        }
      } finally {
        await fs.rm(dataDirB, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('删除被绑定/active 身份 → 409 identity_in_use；force 清理绑定', async () => {
  const dataDir = await tempDataDir();
  try {
    const { pool } = await createPool({ dataDir });
    try {
      const generated = await pool.generate({ count: 2 });
      const ids = (Array.isArray(generated) ? generated : generated.items).map((item) => item.id);
      const target = ids[0];
      await pool.bind('sess_guard', target);

      await assert.rejects(
        () => pool.remove(target, {}),
        (error) => {
          assert.equal(error.status, 409);
          assert.equal(error.code, 'identity_in_use');
          return true;
        }
      );
      // activeId 也不可直接删除
      await assert.rejects(
        () => pool.remove(poolSummary(pool).activeId, {}),
        (error) => error.status === 409 && error.code === 'identity_in_use'
      );

      await pool.remove(target, { force: true });
      assert.equal(poolItems(pool).some((item) => item.id === target), false);
      assert.equal(pool.getBinding('sess_guard'), null, 'force 删除应清理绑定');
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('bindings：持久化 + 重启后不变；unbind 后可重新路由', async () => {
  const dataDir = await tempDataDir();
  try {
    const first = await createPool({ dataDir });
    let boundId;
    try {
      const generated = await first.pool.generate({ count: 3 });
      boundId = (Array.isArray(generated) ? generated : generated.items)[0].id;
      const binding = await first.pool.bind('sess_persist_1', boundId);
      assert.equal(binding?.identityId ?? first.pool.getBinding('sess_persist_1')?.identityId, boundId);
    } finally {
      await first.pool.close?.();
    }

    const second = await createPool({ dataDir });
    try {
      const list = await second.pool.listBindings({ limit: 10, offset: 0 });
      assert.ok(Array.isArray(list.items));
      const found = list.items.find((entry) => entry.sessionKey === 'sess_persist_1');
      assert.ok(found, '重启后绑定丢失');
      assert.equal(found.identityId, boundId);
      assert.equal(typeof found.createdAt, 'number');
      assert.equal(typeof found.updatedAt, 'number');
      assert.equal(list.total, list.items.length);

      await second.pool.unbind('sess_persist_1');
      assert.equal(second.pool.getBinding('sess_persist_1'), null);
      const after = await second.pool.listBindings({ limit: 10 });
      assert.equal(after.items.some((entry) => entry.sessionKey === 'sess_persist_1'), false);
    } finally {
      await second.pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('hash 路由：公式精确、同一 session 恒定、跨重启一致', async () => {
  const dataDir = await tempDataDir();
  const fixedSalt = 'deadbeefcafe0001';
  try {
    const first = await createPool({ dataDir });
    let resolvedId;
    try {
      await first.pool.generate({ count: 4 });
      await first.pool.setRouter({ strategy: 'hash', salt: fixedSalt });
      const candidates = poolItems(first.pool)
        .filter((item) => item.enabled !== false)
        .map((item) => item.id)
        .sort();
      const expected = expectedHashIdentity('sess_hash_det', fixedSalt, candidates);
      resolvedId = resolveId(await resolveSession(first.pool, { sessionKey: 'sess_hash_det' }));
      assert.equal(resolvedId, expected, 'hash 公式与契约不一致');
      assert.equal(
        resolveId(await resolveSession(first.pool, { sessionKey: 'sess_hash_det' })),
        expected,
        '同一 session 两次路由不一致'
      );
      // 已绑定后切换 salt 不影响既有绑定（影响新绑定）
      await first.pool.setRouter({ salt: '0badf00dcafe0002' });
      assert.equal(resolveId(await resolveSession(first.pool, { sessionKey: 'sess_hash_det' })), expected);
    } finally {
      await first.pool.close?.();
    }

    const second = await createPool({ dataDir });
    try {
      assert.equal(
        resolveId(await resolveSession(second.pool, { sessionKey: 'sess_hash_det' })),
        resolvedId,
        '重启后绑定变化'
      );
    } finally {
      await second.pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('付费模型：无 subscribed 候选 → 403 model_requires_subscription；有则只路由 subscribed', async () => {
  const dataDir = await tempDataDir();
  try {
    const { pool } = await createPool({ dataDir, config: { pool: { maxIdentities: 20 } } });
    try {
      await pool.generate({ count: 3 });
      await assert.rejects(
        () => resolveSession(pool, { sessionKey: 'sess_paid', paidModel: true }),
        (error) => {
          assert.equal(error.status, 403);
          assert.equal(error.code, 'model_requires_subscription');
          return true;
        }
      );

      const target = poolItems(pool)[1];
      await pool.update(target.id, { subscribed: true });
      const resolved = await resolveSession(pool, { sessionKey: 'sess_paid', paidModel: true });
      assert.equal(resolveId(resolved), target.id);

      const free = await resolveSession(pool, { sessionKey: 'sess_free', paidModel: false });
      assert.ok(resolveId(free));
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* 每身份队列（mock runtime）                                          */
/* ------------------------------------------------------------------ */

function makeRuntimeFactory(delayMs = 300) {
  const calls = [];
  const createRuntime = (record, ctx) => {
    const client = {
      chat: (params, handlers) => {
        calls.push({ identityId: ctx.identityId, at: Date.now(), params });
        return new Promise((resolve) => setTimeout(() => resolve({ content: 'ok' }), delayMs));
      }
    };
    return { identityId: ctx.identityId, identity: record, client };
  };
  return { createRuntime, calls };
}

test('每身份队列：同身份串行（rps=1、inFlight≤1）、不同身份并行、queueStats', async () => {
  const dataDir = await tempDataDir();
  try {
    const { createRuntime, calls } = makeRuntimeFactory(300);
    const { pool } = await createPool({ dataDir, config: { pool: { queueLimit: 50 } }, createRuntime });
    try {
      const generated = await pool.generate({ count: 3 });
      const [idA, idB, idC] = (Array.isArray(generated) ? generated : generated.items).map((item) => item.id);

      // 同身份并发 2 次 → 串行（rps=1，第二次开始 ≥1000ms）
      await Promise.all([
        pool.run(idA, (runtime) => runtime.client.chat({ prompt: 'a1' }, {})),
        pool.run(idA, (runtime) => runtime.client.chat({ prompt: 'a2' }, {}))
      ]);
      const sameIdentityCalls = calls.filter((call) => call.identityId === idA);
      assert.equal(sameIdentityCalls.length, 2);
      const gap = sameIdentityCalls[1].at - sameIdentityCalls[0].at;
      assert.ok(gap >= 900, `同身份两次开始间隔应 ≥1000ms（实际 ${gap}ms）`);
      const statsA = pool.queueStats(idA);
      assert.equal(statsA.maxConcurrent, 1);
      assert.ok(statsA.inFlight <= 1);
      assert.ok(statsA.peakInFlight <= 1, `peakInFlight=${statsA.peakInFlight}`);
      assert.ok(statsA.totalWaitMs >= 0);

      // 不同身份并发 → 并行（开始间隔远小于 1000ms）
      const before = calls.length;
      await Promise.all([
        pool.run(idB, (runtime) => runtime.client.chat({ prompt: 'pb' }, {})),
        pool.run(idC, (runtime) => runtime.client.chat({ prompt: 'pc' }, {}))
      ]);
      const parallelCalls = calls.slice(before);
      assert.equal(parallelCalls.length, 2);
      const startB = parallelCalls.find((call) => call.identityId === idB)?.at;
      const startC = parallelCalls.find((call) => call.identityId === idC)?.at;
      assert.ok(startB && startC, '不同身份调用缺失');
      assert.ok(Math.abs(startB - startC) < 600, `不同身份应并行（间隔 ${Math.abs(startB - startC)}ms）`);

      const byIdentity = pool.queueStats();
      assert.ok(byIdentity.byIdentity[idA]);
      assert.ok(byIdentity.byIdentity[idB]);
      assert.ok(byIdentity.byIdentity[idC]);
      assert.ok(byIdentity.totals);
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('每身份队列：queueLimit → 429 queue_full；queueTimeoutMs → 429 queue_timeout', async () => {
  const dataDir = await tempDataDir();
  try {
    const createRuntime = (record, ctx) => ({
      identityId: ctx.identityId,
      client: {
        chat: () => new Promise((resolve) => setTimeout(() => resolve({ content: 'slow' }), 2500))
      }
    });
    const { pool } = await createPool({
      dataDir,
      config: { pool: { queueLimit: 1, queueTimeoutMs: 600 } },
      createRuntime
    });
    try {
      const generated = await pool.generate({ count: 1 });
      const id = (Array.isArray(generated) ? generated : generated.items)[0].id;

      // 第一个占住 inFlight，第二个排队，第三个 → queue_full
      const first = pool.run(id, (runtime) => runtime.client.chat({}, {}));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = pool.run(id, (runtime) => runtime.client.chat({}, {}));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(
        () => pool.run(id, (runtime) => runtime.client.chat({}, {})),
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.code, 'queue_full');
          assert.ok(Number(error.retryAfterMs) >= 0);
          return true;
        }
      );
      // 排队者超时 → queue_timeout（600ms < 2500ms）
      await assert.rejects(
        () => second,
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.code, 'queue_timeout');
          return true;
        }
      );
      await first.catch(() => {});
    } finally {
      await pool.close?.();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
