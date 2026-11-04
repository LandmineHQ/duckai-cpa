/**
 * OpenAI 兼容层：GET /v1/models 与路由/方法错误测试。
 * 用真实 createServer + 注入 mock DuckClient（不访问网络）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, request, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

test('GET /v1/models: OpenAI list 结构、默认模型、duck- 前缀与别名', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/models');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.json.object, 'list');
    assert.ok(Array.isArray(res.json.data));
    assert.ok(res.json.data.length >= 11, `expected full duck model catalog, got ${res.json.data.length}`);

    const luna = res.json.data.find((model) => model.id === 'gpt-6-luna');
    assert.ok(luna, 'gpt-6-luna must be listed');
    assert.equal(luna.object, 'model');
    assert.equal(typeof luna.created, 'number');
    assert.equal(luna.owned_by, 'OpenAI');
    assert.equal(luna.created_by, 'OpenAI');
    assert.equal(luna.default, true);
    assert.equal(luna.reasoning, true);
    assert.ok(Array.isArray(luna.supportedReasoningEffort));
    assert.deepEqual(luna.supportedReasoningEffort, ['none', 'low']);
    assert.ok(luna.tools.includes('web_search'));
    assert.ok(luna.tools.includes('image_generation'));

    const prefixed = res.json.data.find((model) => model.id === 'duck-gpt-6-luna');
    assert.ok(prefixed, 'duck- prefixed ids must be exposed');
    assert.equal(prefixed.alias_of, 'gpt-6-luna');

    // 已裁决：配置别名（models.aliases）可被解析，但 /v1/models 只列 canonical + duck- 前缀。
    assert.equal(
      res.json.data.find((model) => model.id === 'gpt-6'),
      undefined,
      'configured aliases are resolvable but must not be listed'
    );

    // 每条都有最小必需字段
    for (const model of res.json.data) {
      assert.equal(typeof model.id, 'string');
      assert.equal(model.object, 'model');
      assert.equal(typeof model.created, 'number');
      assert.equal(typeof model.owned_by, 'string');
    }

    // v2.20：context / 压缩能力 / 会话上限行为字段
    assert.equal(luna.context_window_chars, 20000);
    assert.equal(luna.max_input_chars, 19500);
    assert.equal(luna.input_char_limit, 16000);
    assert.equal(typeof luna.context_window, 'number');
    assert.equal(luna.compaction_supported, false);
    assert.equal(luna.session_limit_behavior, 'new_chat', 'gpt-6-luna 不自动压缩 → 会话上限只能新开会话');
    assert.equal(luna.compaction_trigger, null);
    assert.equal(luna.compaction_threshold_tokens, null);
    assert.equal(typeof luna.max_output_tokens, 'number');
    assert.equal(luna.max_output_tokens_estimated, true);

    const mini = res.json.data.find((model) => model.id === 'gpt-5.4-mini');
    assert.ok(mini, 'gpt-5.4-mini must be listed');
    assert.equal(mini.compaction_supported, true);
    assert.equal(mini.session_limit_behavior, 'summarize_and_continue');
    assert.equal(mini.compaction_trigger, 'tokens');
    assert.ok(mini.capabilities && mini.capabilities.sessionLimitBehavior === 'summarize_and_continue');
    assert.ok(mini.capabilities && mini.capabilities.compactionTrigger === 'tokens');
  });
});

test('GET /v1/models/:id: 单个模型 / 404 错误结构', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const one = await v1Request(baseUrl, '/v1/models/gpt-6-luna');
    assert.equal(one.status, 200);
    assert.equal(one.json.id, 'gpt-6-luna');
    assert.equal(one.json.object, 'model');

    const missing = await v1Request(baseUrl, '/v1/models/not-a-model');
    assert.equal(missing.status, 404);
    assert.ok(missing.json.error);
    assert.equal(typeof missing.json.error.message, 'string');
    assert.equal(missing.json.error.type, 'invalid_request_error');
    assert.equal(missing.json.error.code, 'model_not_found');
  });
});

test('方法/路径错误：405 Allow、未知 /v1 路径 404、非法 JSON 400', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const wrongMethod = await v1Request(baseUrl, '/v1/chat/completions', { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.error.code, 'method_not_allowed');
    assert.match(String(wrongMethod.headers.get('allow')), /POST/);

    const unknown = await v1Request(baseUrl, '/v1/unknown-endpoint');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.type, 'invalid_request_error');

    const badJson = await v1Request(baseUrl, '/v1/chat/completions', { method: 'POST', raw: '{not json' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'invalid_json');
  });
});

test('健康检查 /healthz：上游 mock 状态与版本透出', async () => {
  const duck = new MockDuckClient();
  const config = makeConfig({ auth: { required: false, adminToken: 'test-admin-token-0123456789' } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await request(baseUrl, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.service, 'duckai-cpa');
    assert.equal(typeof res.json.version, 'string');
    assert.equal(typeof res.json.uptimeSec, 'number');
    assert.equal(res.json.upstream.ok, true);
    assert.equal(res.json.upstream.challengeOk, true);
    assert.equal(res.json.upstream.version, 'serp_20261030_223718_ET-61e4601227ece8af7a1ad4d69b79aafd35f91fae');
    assert.ok(duck.calls.health >= 1);
  });
});

test('CORS：配置开启时带允许头，OPTIONS 预检 204', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const normal = await v1Request(baseUrl, '/v1/models');
    assert.equal(normal.headers.get('access-control-allow-origin'), '*');

    const preflight = await v1Request(baseUrl, '/v1/chat/completions', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(String(preflight.headers.get('access-control-allow-headers')), /Authorization/);
    assert.match(String(preflight.headers.get('access-control-allow-methods')), /POST/);
  });
});

test('CORS 关闭：不带允许头（server.cors=false）', async () => {
  const config = makeConfig({
    server: { cors: false },
    auth: { required: false, adminToken: 'test-admin-token-0123456789' }
  });
  await withServer({ config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/models');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});


test('normalizeModelEntry：capabilities 显式给出 maxOutputTokens 时不再误标为估算值（v2.21 修复）', async () => {
  const { normalizeModelEntry } = await import('../src/openai/models.js');

  const fromCapabilities = normalizeModelEntry({
    model: 'upstream-model',
    capabilities: { maxOutputTokens: 8192, maxOutputTokensEstimated: false }
  });
  assert.equal(fromCapabilities.maxOutputTokens, 8192);
  assert.equal(fromCapabilities.maxOutputTokensEstimated, false, 'capabilities 给出真实值不应标 estimated');

  const fallback = normalizeModelEntry({ model: 'unknown-model' });
  assert.equal(fallback.maxOutputTokens, 4096);
  assert.equal(fallback.maxOutputTokensEstimated, true, '两个来源都没有时保持估算标记');

  const rawValue = normalizeModelEntry({ model: 'raw-model', maxOutputTokens: 2048 });
  assert.equal(rawValue.maxOutputTokens, 2048);
  assert.equal(rawValue.maxOutputTokensEstimated, false);
});
