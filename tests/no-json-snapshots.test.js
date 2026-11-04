/**
 * v2.69：SQLite 迁移后不再生成冗余 JSON 快照。
 * 仅保留 config.json / identity.json / pairing.json 等运行/敏感文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer } from './helpers/test-server.js';
import { createSubscriptionStore } from '../src/admin/subscriptions.js';

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeSubscriptionToken() {
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({
      email: 'no-json@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      entitlements: [{ product: 'Duck.ai', name: 'plus' }]
    }),
    'sig'
  ].join('.');
}

async function assertMissing(file) {
  await assert.rejects(fs.access(file), (error) => error.code === 'ENOENT', `${path.basename(file)} 不应存在`);
}

test('v2.69：identity-pool/subscriptions/logs/usage 不再写 JSON 快照，SQLite 为唯一来源', async () => {
  await withServer({ identity: true, pool: true }, async (env) => {
    const { dataDir, identityPool, store } = env;

    // 身份池：启动后只写 duckai.db，不再写 identity-pool.json。
    await assertMissing(path.join(dataDir, 'identity-pool.json'));
    const fileInfo = identityPool.getFileInfo?.();
    assert.ok(fileInfo, '应有 getFileInfo');
    assert.equal(fileInfo.source, 'sqlite');
    assert.match(fileInfo.path, /duckai\.db$/);

    // 订阅：新增实体后也只有 SQLite，不再写 subscriptions.json。
    const subscriptions = await createSubscriptionStore({
      dataDir,
      logger: { warn() {}, info() {} }
    });
    const added = await subscriptions.add({ token: fakeSubscriptionToken(), label: 'no-json' });
    assert.ok(added?.subscription?.id);
    await assertMissing(path.join(dataDir, 'subscriptions.json'));

    // 日志/用量：SQLite 持久化后不再写 logs.json / usage.json。
    store.recordUpstream({
      model: 'gpt-6-luna',
      status: 200,
      tokens: { prompt: 3, completion: 4, total: 7 }
    });
    store.recordAdmin({ endpoint: 'GET /admin/api/overview', status: 200 });
    await store.flush();
    await assertMissing(path.join(dataDir, 'logs.json'));
    await assertMissing(path.join(dataDir, 'usage.json'));

    // SQLite 数据库仍然保留；config.json 只在保存配置时才写。
    await fs.access(path.join(dataDir, 'duckai.db'));
  });
});
