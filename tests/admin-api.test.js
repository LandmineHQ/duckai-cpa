/**
 * v2 Admin API 契约（docs/ADMIN_API_V2.md，admin 部分）。
 *
 * 覆盖：overview（service/upstream.queue/stats 拆分/models/recent 拆分）、
 * config（脱敏/深合并/live 生效/restartRequired/ignored/reset）、
 * keys 生命周期（201、managed key 可用于 /v1）、models、health、
 * 错误路由（404/405）、旧 POST /admin/api/test 已 404。
 *
 * 日志拆分见 tests/logs-split.test.js；会话式测试见 tests/sessions.test.js。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, request, v1Request, adminRequest, adminHeaders } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

function chat(baseUrl) {
  return v1Request(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
  });
}

test('GET /admin/api/overview：service/upstream.queue/stats 拆分/models/recent 拆分', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    await chat(baseUrl);
    await adminRequest(baseUrl, '/admin/api/health');

    const res = await adminRequest(baseUrl, '/admin/api/overview');
    assert.equal(res.status, 200);
    const body = res.json;

    assert.equal(body.service.name, 'duckai-cpa');
    assert.equal(typeof body.service.version, 'string');
    assert.equal(typeof body.service.uptimeSec, 'number');

    assert.equal(typeof body.upstream.ok, 'boolean');
    assert.equal(body.upstream.challengeOk, true);
    assert.equal(typeof body.upstream.latencyMs, 'number');
    const queue = body.upstream.queue;
    assert.ok(queue, 'overview.upstream.queue missing');
    for (const field of ['waiting', 'inFlight', 'rps', 'maxConcurrent', 'limit', 'avgWaitMs']) {
      assert.equal(typeof queue[field], 'number', `queue.${field} must be a number`);
    }
    assert.ok('lastStartAt' in queue);

    assert.ok(body.stats.upstream, 'stats.upstream missing');
    assert.ok(body.stats.admin, 'stats.admin missing');
    assert.equal(body.stats.upstream.requests, 1);
    assert.ok(body.stats.admin.requests >= 1);
    assert.equal('requests' in body.stats, false, 'legacy flat stats must be removed');

    assert.ok(Array.isArray(body.recentUpstream));
    assert.ok(Array.isArray(body.recentAdmin));
    assert.equal(body.recentUpstream.length, 1);
    assert.ok(body.recentAdmin.length >= 1);

    assert.ok(Array.isArray(body.models) && body.models.length >= 10);
    const opus = body.models.find((model) => model.id === 'claude-opus-5-5');
    assert.ok(opus, 'paid model missing from overview.models');
    assert.equal(opus.paid, true);
  });
});

test('GET/PUT /admin/api/config：脱敏、深合并、live 生效、restartRequired、ignored', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const get = await adminRequest(baseUrl, '/admin/api/config');
    assert.equal(get.status, 200);
    assert.ok(get.json.config);
    assert.equal(get.json.config.auth.adminToken, 'sk-***');
    assert.ok(get.json.config.upstream, 'config.upstream must exist');
    assert.equal('required' in get.json.config.auth, false);

    // 深合并：只改 tools.webSearch + upstream.rps
    const put = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { tools: { webSearch: false }, upstream: { rps: 2 } }
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);
    assert.equal(put.json.config.tools.webSearch, false);
    assert.equal(put.json.config.tools.imageGeneration, true);
    assert.equal(put.json.config.upstream.rps, 2);

    // 配置立即生效：v2.22 默认策略是静默丢弃（不报错），请求继续
    const disabled = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'web_search' }]
      }
    });
    assert.equal(disabled.status, 200, disabled.text);
    const upstreamCall = duck.calls.chat.at(-1);
    assert.equal(upstreamCall.params.webSearch, false, '服务端关闭的 tool 应被丢弃');

    // 需要重启的字段
    const restart = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { server: { port: 9999 } }
    });
    assert.equal(restart.status, 200);
    assert.equal(restart.json.restartRequired, true);

    // 不可编辑字段被忽略并回报
    const ignored = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { 'foo.bar': 1, logging: { level: 'warn' } }
    });
    assert.equal(ignored.status, 200);
    assert.ok(Array.isArray(ignored.json.ignored));
    assert.ok(ignored.json.ignored.includes('foo.bar'));
    assert.equal(ignored.json.config.logging.level, 'warn');

    // 非法值
    const invalid = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { tools: { webSearch: 'yes' } }
    });
    assert.equal(invalid.status, 400);
  });
});

test('POST /admin/api/config/reset：恢复默认且保留 admin token', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { tools: { webSearch: false }, upstream: { rps: 7 } }
    });
    const reset = await adminRequest(baseUrl, '/admin/api/config/reset', { method: 'POST', body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.ok, true);
    assert.equal(reset.json.config.tools.webSearch, true);
    assert.equal(reset.json.config.upstream.rps, 1);
    assert.equal(reset.json.config.auth.adminToken, 'sk-***');
    assert.equal(typeof reset.json.restartRequired, 'boolean');

    const health = await adminRequest(baseUrl, '/admin/api/health');
    assert.equal(health.status, 200);
  });
});

test('API Key 生命周期：创建(201)→列表预览→吊销→失效', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const empty = await adminRequest(baseUrl, '/admin/api/keys');
    assert.equal(empty.status, 200);
    assert.ok(Array.isArray(empty.json.items));

    const created = await adminRequest(baseUrl, '/admin/api/keys', {
      method: 'POST',
      body: { label: 'my-agent' }
    });
    assert.equal(created.status, 201);
    assert.match(created.json.key, /^sk-duck-/);
    assert.equal(created.json.label, 'my-agent');
    assert.equal(typeof created.json.createdAt, 'number');

    const list = await adminRequest(baseUrl, '/admin/api/keys');
    const item = list.json.items.find((entry) => entry.id === created.json.id);
    assert.ok(item, 'created key missing from list');
    assert.equal(item.key, undefined, 'plaintext key must not be listed');
    assert.match(item.keyPreview, /^sk-duck-/);
    assert.ok('lastUsedAt' in item);
    assert.ok('requestCount' in item);

    // managed key 可用于 /v1/*
    const used = await request(baseUrl, '/v1/models', {
      headers: { authorization: `Bearer ${created.json.key}` }
    });
    assert.equal(used.status, 200);

    const deleted = await adminRequest(baseUrl, `/admin/api/keys/${created.json.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.ok, true);

    const revoked = await request(baseUrl, '/v1/models', {
      headers: { authorization: `Bearer ${created.json.key}` }
    });
    assert.equal(revoked.status, 401);

    const missing = await adminRequest(baseUrl, '/admin/api/keys/key_does_not_exist', { method: 'DELETE' });
    assert.equal(missing.status, 404);
  });
});

test('GET /admin/api/models 与 /admin/api/health', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const models = await adminRequest(baseUrl, '/admin/api/models');
    assert.equal(models.status, 200);
    assert.ok(Array.isArray(models.json.items));
    const luna = models.json.items.find((model) => model.id === 'gpt-6-luna');
    assert.ok(luna);
    for (const field of ['id', 'name', 'createdBy', 'modelType', 'reasoningEfforts', 'tools', 'tiers', 'default']) {
      assert.ok(field in luna, `model entry missing ${field}`);
    }
    assert.equal(luna.paid, false);
    assert.equal(luna.default, true);

    const health = await adminRequest(baseUrl, '/admin/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.upstream.ok, true);
    assert.equal(health.json.upstream.challengeOk, true);
    assert.equal(typeof health.json.version, 'string');
  });
});

test('Admin 路由错误：未知端点 404、方法不允许 405 + Allow、旧 /admin/api/test 404', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const unknown = await adminRequest(baseUrl, '/admin/api/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'not_found');

    const wrongMethod = await request(baseUrl, '/admin/api/overview', {
      method: 'POST',
      headers: adminHeaders(),
      body: {}
    });
    assert.equal(wrongMethod.status, 405);
    assert.match(String(wrongMethod.headers.get('allow')), /GET/);

    const legacyTest = await adminRequest(baseUrl, '/admin/api/test', {
      method: 'POST',
      body: { prompt: 'hi', stream: true }
    });
    assert.equal(legacyTest.status, 404, 'v1 single-shot test endpoint must be removed');
  });
});
