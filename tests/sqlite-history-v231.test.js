/**
 * v2.31：SQLite 迁移 + 会话历史 + 身份额度 + 连接测试批量删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig } from './helpers/test-server.js';
import { createHistoryStore } from '../src/history.js';
import { openDatabase, closeAllDatabases } from '../src/db.js';
import { fetchIdentityUsage } from '../src/duck/usage.js';

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

function adminHeaders() {
  return { authorization: `Bearer ${makeConfig().auth.adminToken}`, 'content-type': 'application/json' };
}

test('会话历史：写入 / 按身份分组 / 详情 / 保留天数清理', async () => {
  const dataDir = tmpDir('qa-history');
  await fs.mkdir(dataDir, { recursive: true });
  const config = makeConfig();
  config.history = { retentionDays: 30 };
  const history = await createHistoryStore({ dataDir, config, logger: { info() {}, warn() {} } });

  const first = history.record({
    identityId: 'id_a',
    sessionKey: 'sess_1',
    model: 'gpt-6-luna',
    systemPrompt: '你是助手',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' }
    ]
  });
  assert.ok(first?.id, '应写入成功');

  // 同一会话追加 → 更新同一行
  history.record({
    identityId: 'id_a',
    sessionKey: 'sess_1',
    model: 'gpt-6-luna',
    systemPrompt: '你是助手',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' }
    ]
  });
  // 另一个身份
  history.record({
    identityId: 'id_b',
    sessionKey: 'sess_2',
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: '另一个身份' }]
  });

  const list = history.list();
  assert.equal(list.total, 2, '同会话应合并为 1 条');
  const ids = list.groups.map((group) => group.identityId).sort();
  assert.deepEqual(ids, ['id_a', 'id_b']);
  const groupA = list.groups.find((group) => group.identityId === 'id_a');
  assert.equal(groupA.items[0].messageCount, 4, '追加后消息数应为 4');

  const detail = history.get(groupA.items[0].id);
  assert.equal(detail.systemPrompt, '你是助手');
  assert.equal(detail.messages[3].content, '第二答');

  // 保留策略：把 id_b 改成 40 天前 → prune 只删它
  const db = await openDatabase({ dataDir });
  db.db.prepare('UPDATE history SET updated_at = ? WHERE identity_id = ?').run(Date.now() - 40 * 86400000, 'id_b');
  const removed = history.prune();
  assert.equal(removed, 1);
  assert.equal(history.stats().total, 1);
  closeAllDatabases();
});

test('身份额度：付费身份解析 windows；无 token / 无 window 返回 unsupported', async () => {
  const ok = await fetchIdentityUsage({
    token: 't',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: '0',
          fixedCostWindowUsage: {
            windows: [
              { id: 'day', percentUsed: 33.3, resetAt: '2026-11-04T00:00:00.000Z', isBlocked: false },
              { id: 'iso_week', percentUsed: 4.8, resetAt: '2026-11-09T00:00:00.000Z' }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });
  assert.equal(ok.supported, true);
  assert.equal(ok.windows.length, 2);
  assert.equal(ok.windows[0].label, '每日限额');
  assert.equal(Math.round(ok.windows[0].percentUsed), 33);

  const free = await fetchIdentityUsage({
    token: 't',
    fetchImpl: async () => new Response(JSON.stringify({ status: '0' }), { status: 200 })
  });
  assert.equal(free.supported, false, 'free 身份没有 fixedCostWindowUsage');

  const noToken = await fetchIdentityUsage({ token: '' });
  assert.equal(noToken.supported, false);
});

test('API：/admin/api/history 列表 + 详情 + 删除', async () => {
  const dataDir = tmpDir('qa-history-api');
  await fs.mkdir(dataDir, { recursive: true });
  const history = await createHistoryStore({ dataDir, config: makeConfig(), logger: { info() {}, warn() {} } });
  history.record({
    identityId: 'id_api',
    sessionKey: 'sess_api',
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'API 历史' }]
  });

  await withServer({ history }, async ({ baseUrl }) => {
    let res = await fetch(`${baseUrl}/admin/api/history`, { headers: adminHeaders() });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.total, 1);
    assert.equal(list.groups[0].identityId, 'id_api');

    const id = list.groups[0].items[0].id;
    res = await fetch(`${baseUrl}/admin/api/history/${id}`, { headers: adminHeaders() });
    assert.equal(res.status, 200);
    const detail = await res.json();
    assert.equal(detail.item.messages[0].content, 'API 历史');

    res = await fetch(`${baseUrl}/admin/api/history/${id}`, { method: 'DELETE', headers: adminHeaders() });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/admin/api/history/${id}`, { headers: adminHeaders() });
    assert.equal(res.status, 404);
  });
});

test('API：连接测试批量删除 /admin/api/test/sessions/bulk-delete', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const created = [];
    for (const title of ['批量A', '批量B', '批量C']) {
      const res = await fetch(`${baseUrl}/admin/api/test/sessions`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ title })
      });
      assert.equal(res.status, 201);
      created.push((await res.json()).session.id);
    }

    const res = await fetch(`${baseUrl}/admin/api/test/sessions/bulk-delete`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ ids: created })
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.deletedCount, 3);

    const list = await (await fetch(`${baseUrl}/admin/api/test/sessions`, { headers: adminHeaders() })).json();
    assert.equal((list.items || []).length, 0);

    // 空 ids → 400
    const invalid = await fetch(`${baseUrl}/admin/api/test/sessions/bulk-delete`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ ids: [] })
    });
    assert.equal(invalid.status, 400);
  });
});
