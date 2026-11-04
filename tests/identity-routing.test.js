/**
 * v2.4 路由集成（docs/IDENTITY-POOL.md §2/§4）。
 *
 * 覆盖：
 *   - `X-Session-Id` 相同 → 多次请求同一 identityId（会话绑定永久固定，响应/日志可验证）
 *   - 不同 session → 各自绑定（可不同身份）；无 sessionKey → 不写绑定
 *   - 重启（同 dataDir 重建 pool/server）后同一 sessionKey 仍映射同一 identityId
 *   - 付费模型：allowPaidModels=true 但池内无 subscribed → 403 model_requires_subscription；
 *     标记 subscribed 后 → 200 且绑定到该身份
 *   - 测试会话（sess_xxx）**请求后**绑定 identityId（v2.29 起不再创建即绑定）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startTestServer, v1Request, adminRequest, makeConfig } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

async function tempDataDir(prefix = 'duckai-qa-routing') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function chatBody(extra = {}) {
  return {
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra
  };
}

async function upstreamLogs(baseUrl, limit = 20) {
  const res = await adminRequest(baseUrl, `/admin/api/logs?kind=upstream&limit=${limit}`);
  assert.equal(res.status, 200, res.text);
  return res.json.items;
}

test('X-Session-Id 相同 → 多次请求同一 identityId；不同 session 可不同；无 header 不绑定', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, withIdentities: true, cleanup: false });
  try {
    const pool = server.identityPool;
    const generated = await pool.generate({ count: 4 });
    assert.equal(Array.isArray(generated) ? generated.length : generated.items.length, 4);

    const sessionKey = 'sess_route_alpha';
    for (let index = 0; index < 3; index += 1) {
      const res = await v1Request(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'X-Session-Id': sessionKey },
        body: chatBody()
      });
      assert.equal(res.status, 200, res.text);
    }
    const binding = pool.getBinding(sessionKey);
    assert.ok(binding, 'X-Session-Id 应产生绑定');
    const logs = await upstreamLogs(server.baseUrl, 10);
    const sessionLogs = logs.filter((entry) => entry.identityId);
    assert.ok(sessionLogs.length >= 3, 'upstream 日志应带 identityId');
    assert.ok(sessionLogs.every((entry) => entry.identityId === binding.identityId));

    // 不同 session → 各自绑定（存在即合法，可能相同也可能不同）
    const otherKey = 'sess_route_beta';
    const other = await v1Request(server.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': otherKey },
      body: chatBody()
    });
    assert.equal(other.status, 200);
    assert.ok(pool.getBinding(otherKey));

    // 无 header → 不写绑定
    const beforeCount = (await pool.listBindings({ limit: 1000 })).total;
    const noHeader = await v1Request(server.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: chatBody()
    });
    assert.equal(noHeader.status, 200);
    const afterCount = (await pool.listBindings({ limit: 1000 })).total;
    assert.equal(afterCount, beforeCount, '无 sessionKey 不应新增绑定');
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('重启后同一 sessionKey 映射不变（绑定持久化）', async () => {
  const dataDir = await tempDataDir();
  const first = await startTestServer({ duck: new MockDuckClient(), dataDir, withIdentities: true, cleanup: false });
  let boundId;
  try {
    await first.identityPool.generate({ count: 3 });
    const res = await v1Request(first.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': 'sess_restart_route' },
      body: chatBody()
    });
    assert.equal(res.status, 200);
    boundId = first.identityPool.getBinding('sess_restart_route').identityId;
  } finally {
    await first.close();
  }

  const second = await startTestServer({ duck: new MockDuckClient(), dataDir, withIdentities: true, cleanup: true });
  try {
    const binding = second.identityPool.getBinding('sess_restart_route');
    assert.ok(binding, '重启后绑定丢失');
    assert.equal(binding.identityId, boundId);
    const res = await v1Request(second.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': 'sess_restart_route' },
      body: chatBody()
    });
    assert.equal(res.status, 200);
    const logs = await upstreamLogs(second.baseUrl, 5);
    assert.ok(logs.some((entry) => entry.identityId === boundId), '重启后请求应路由到原身份');
  } finally {
    await second.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('付费模型：无订阅身份 → 403 model_requires_subscription；绑定订阅身份后 → 200 且走该身份', async () => {
  const dataDir = await tempDataDir();
  const config = makeConfig({ duck: { allowPaidModels: true } });
  const server = await startTestServer({ config, duck: new MockDuckClient(), dataDir, withIdentities: true, cleanup: true });
  try {
    const pool = server.identityPool;
    await pool.generate({ count: 2 });

    const denied = await v1Request(server.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': 'sess_paid_route' },
      body: chatBody({ model: 'gpt-5.6-terra' })
    });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.json.error.code, 'model_requires_subscription');

    // 订阅一个身份（不走 HTTP，直接池操作，避免 verify 网络）
    const target = pool.list()[entpool(pool)];
    await pool.update(target.id, { subscribed: true });

    const allowed = await v1Request(server.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': 'sess_paid_allowed', 'X-Session-Id2': 'x' },
      body: chatBody({ model: 'gpt-5.6-terra' })
    });
    assert.equal(allowed.status, 200, allowed.text);
    const binding = pool.getBinding('sess_paid_allowed');
    assert.equal(binding.identityId, target.id);

    // 免费模型不受影响
    const free = await v1Request(server.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Session-Id': 'sess_free_route' },
      body: chatBody()
    });
    assert.equal(free.status, 200);
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

function entpool(pool) {
  // 选一个非 active 的身份，避免依赖哈希结果
  const items = pool.list();
  const activeId = pool.getSummary().activeId;
  return items.findIndex((item) => item.id !== activeId);
}

test('测试会话：创建不绑定，首条消息后回填 identityId/identityLabel（sess_xxx 作为 sessionKey）', async () => {
  const dataDir = await tempDataDir();
  await startTestServer({ duck: new MockDuckClient(), dataDir, withIdentities: true, cleanup: true }).then(async (server) => {
    try {
      const created = await adminRequest(server.baseUrl, '/admin/api/test/sessions', {
        method: 'POST',
        body: { title: '绑定会话' }
      });
      assert.equal(created.status, 201, created.text);
      const session = created.json.session;
      assert.match(session.id, /^sess_/);
      assert.equal(session.identityId, null, '创建时不应预绑定身份（v2.29）');
      assert.equal(server.identityPool.getBinding(session.id), null);

      const message = await adminRequest(server.baseUrl, `/admin/api/test/sessions/${session.id}/messages`, {
        method: 'POST',
        body: { content: '你好' }
      });
      assert.equal(message.status, 200, message.text);

      const detail = await adminRequest(server.baseUrl, `/admin/api/test/sessions/${session.id}`);
      assert.ok(detail.json.session.identityId, '请求后应回填 identityId');
      assert.ok(detail.json.session.identityLabel, '请求后应回填 identityLabel');
      const binding = server.identityPool.getBinding(session.id);
      assert.ok(binding, '请求后应产生 session→identity 绑定');
      assert.equal(binding.identityId, detail.json.session.identityId);
    } finally {
      await server.close();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
