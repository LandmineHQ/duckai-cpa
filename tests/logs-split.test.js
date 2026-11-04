/**
 * v2 日志/统计拆分（docs/ADMIN_API_V2.md §3）。
 *
 * 断言：
 *   - upstream 日志只记录上游请求（source=v1|admin-test），admin 日志只记录 /admin/api/*；
 *   - 两者分别分页、分别清空，互不影响；
 *   - overview.stats.upstream / stats.admin 字段拆分；旧的顶层扁平 stats 已删除；
 *   - overview.recentUpstream / recentAdmin；upstream 项含 queueWaitMs/rateLimited/error。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, request, v1Request, adminRequest, adminHeaders } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

function chat(baseUrl, prompt = 'hi') {
  return v1Request(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: prompt }] }
  });
}

test('upstream 与 admin 日志分离：内容、字段、分页互不混淆', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    // 2 条上游请求
    await chat(baseUrl, 'first');
    await chat(baseUrl, 'second');
    // 2 条 admin 请求
    await adminRequest(baseUrl, '/admin/api/health');
    await adminRequest(baseUrl, '/admin/api/models');

    const upstream = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=10');
    assert.equal(upstream.status, 200);
    assert.equal(upstream.json.kind, 'upstream');
    assert.equal(upstream.json.total, 2);
    for (const item of upstream.json.items) {
      assert.equal(item.source, 'v1');
      assert.equal(item.endpoint, 'POST /v1/chat/completions');
      assert.ok(!String(item.endpoint).includes('/admin/'));
      assert.equal(typeof item.queueWaitMs, 'number');
      assert.equal(typeof item.latencyMs, 'number');
      assert.equal(typeof item.rateLimited, 'boolean');
      assert.ok('error' in item);
      assert.ok('stream' in item);
    }

    const admin = await adminRequest(baseUrl, '/admin/api/logs?kind=admin&limit=10');
    assert.equal(admin.status, 200);
    assert.equal(admin.json.kind, 'admin');
    assert.ok(admin.json.total >= 2);
    for (const item of admin.json.items) {
      assert.ok(
        String(item.endpoint).includes('/admin/api/'),
        `admin log must not contain upstream endpoint: ${item.endpoint}`
      );
      assert.match(String(item.method), /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/);
      assert.equal(typeof item.latencyMs, 'number');
      assert.ok('error' in item);
    }

    // 缺省 kind = upstream
    const defaultKind = await adminRequest(baseUrl, '/admin/api/logs?limit=10');
    assert.equal(defaultKind.json.kind, 'upstream');
    assert.equal(defaultKind.json.total, 2);

    // 分页：upstream total 2，limit=1 offset=1 取到另一条
    const page1 = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=1&offset=0');
    const page2 = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=1&offset=1');
    assert.equal(page1.json.items.length, 1);
    assert.equal(page2.json.items.length, 1);
    assert.notEqual(page1.json.items[0].id, page2.json.items[0].id);
    const beyond = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=1&offset=50');
    assert.deepEqual(beyond.json.items, []);
    assert.equal(beyond.json.total, 2);
  });
});

test('清空互不影响：DELETE kind=admin 不动 upstream，反之亦然', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    await chat(baseUrl);
    await adminRequest(baseUrl, '/admin/api/health');

    const clearedAdmin = await adminRequest(baseUrl, '/admin/api/logs?kind=admin', { method: 'DELETE' });
    assert.equal(clearedAdmin.status, 200);
    assert.equal(clearedAdmin.json.ok, true);
    assert.equal(clearedAdmin.json.kind, 'admin');

    const upstreamAfter = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=10');
    assert.equal(upstreamAfter.json.total, 1, 'upstream logs must be untouched by admin clear');

    const adminAfter = await adminRequest(baseUrl, '/admin/api/logs?kind=admin&limit=10');
    assert.ok(
      adminAfter.json.items.every((item) => String(item.endpoint).includes('/admin/api/logs')),
      `business admin logs must be cleared (only logs-endpoint calls may remain): ${JSON.stringify(adminAfter.json.items.map((item) => item.endpoint))}`
    );

    await chat(baseUrl);
    const clearedUpstream = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream', { method: 'DELETE' });
    assert.equal(clearedUpstream.status, 200);
    assert.equal(clearedUpstream.json.kind, 'upstream');

    const upstreamCleared = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=10');
    assert.equal(upstreamCleared.json.total, 0);

    const adminStill = await adminRequest(baseUrl, '/admin/api/logs?kind=admin&limit=10');
    assert.ok(adminStill.json.total >= 1, 'admin logs must not be cleared by upstream clear');
  });
});

test('stats 拆分：overview.stats.upstream / stats.admin，旧扁平字段删除', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    await chat(baseUrl);
    await chat(baseUrl);
    await adminRequest(baseUrl, '/admin/api/health');
    await adminRequest(baseUrl, '/admin/api/models');

    const overview = await adminRequest(baseUrl, '/admin/api/overview');
    assert.equal(overview.status, 200);
    const stats = overview.json.stats;
    assert.ok(stats, 'overview.stats missing');
    assert.ok(stats.upstream, 'stats.upstream missing');
    assert.ok(stats.admin, 'stats.admin missing');
    assert.equal(stats.upstream.requests, 2);
    assert.equal(typeof stats.upstream.errors, 'number');
    assert.equal(typeof stats.upstream.avgLatencyMs, 'number');
    assert.equal(typeof stats.upstream.byModel, 'object');
    assert.equal(typeof stats.upstream.byEndpoint, 'object');
    assert.ok('rateLimitCount' in stats.upstream);
    assert.ok('lastErrorAt' in stats.upstream);

    assert.ok(stats.admin.requests >= 2);
    assert.equal(typeof stats.admin.errors, 'number');
    assert.equal(typeof stats.admin.avgLatencyMs, 'number');
    assert.equal(typeof stats.admin.byEndpoint, 'object');

    // v1 扁平字段删除（BREAKING）
    for (const legacy of ['requests', 'errors', 'avgLatencyMs', 'byModel', 'byEndpoint']) {
      assert.equal(legacy in stats, false, `legacy stats.${legacy} must be removed`);
    }

    assert.ok(Array.isArray(overview.json.recentUpstream), 'recentUpstream missing');
    assert.ok(Array.isArray(overview.json.recentAdmin), 'recentAdmin missing');
    assert.equal(overview.json.recentUpstream.length, 2);
    assert.ok(overview.json.recentAdmin.length >= 2);
  });
});

test('upstream 日志记录限流：rateLimited=true + error 字段', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    error: Object.assign(new Error('rate limited by upstream'), {
      name: 'DuckError',
      status: 429,
      type: 'ERR_RATE_LIMIT',
      retriable: true
    })
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await chat(baseUrl);
    assert.equal(res.status, 429);

    const logs = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=10');
    assert.equal(logs.json.total, 1);
    const item = logs.json.items[0];
    assert.equal(item.status, 429);
    assert.equal(item.rateLimited, true);
    assert.ok(item.error, 'error field must be recorded');
    assert.ok(String(item.error).length > 0);
  });
});
