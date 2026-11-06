/**
 * Phase 0（task-83）：后端 HTTP/SSE 黑盒契约基线。
 *
 * 只加测试，不改 src。全部使用 mock DuckClient、离线；覆盖：
 * - 公共路由 / 静态资源 / SPA fallback / 路径穿越
 * - /v1 与 /admin/api 的 auth / method / unknown path 状态矩阵
 * - JSON 错误 envelope、4MB body 限制、无效 JSON
 * - CORS 开启/关闭
 * - chat SSE 与 responses SSE 的关键顺序
 * - session_history_mismatch 错误码
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, request, v1Request, adminRequest, collectSSE, makeConfig } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';

const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

function ssePayload(event) {
  if (!event) return null;
  if (event.json && typeof event.json === 'object') return event.json;
  if (typeof event.data === 'string') {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }
  return null;
}

function assertOpenAIEnvelope(res, { status, code, type = null, param = null } = {}) {
  assert.equal(res.status, status, `HTTP ${res.status}: ${res.text?.slice(0, 300)}`);
  assert.ok(res.json && typeof res.json === 'object', '错误响应必须是 JSON 对象');
  assert.ok(res.json.error && typeof res.json.error === 'object', '错误响应应有 error 对象');
  assert.equal(res.json.error.code, code);
  if (type) assert.equal(res.json.error.type, type);
  if (param !== false) assert.ok('param' in res.json.error, 'error 应包含 param 字段');
  assert.equal(typeof res.json.error.message, 'string');
}

/* ------------------------------------------------------------------ */
/* 1. 公共路由 / 静态资源                                              */
/* ------------------------------------------------------------------ */

test('公共路由：/healthz、/、/favicon.ico 的状态与 content-type 基线', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const health = await request(baseUrl, '/healthz');
    assert.equal(health.status, 200);
    assert.match(String(health.headers.get('content-type')), /application\/json/);
    assert.equal(health.json.ok, true);
    assert.equal(typeof health.json.service, 'string');
    assert.equal(typeof health.json.version, 'string');
    assert.ok('upstream' in health.json);

    const healthHead = await request(baseUrl, '/healthz', { method: 'HEAD' });
    assert.equal(healthHead.status, 200);
    assert.equal(healthHead.text, '');

    const intro = await request(baseUrl, '/');
    assert.equal(intro.status, 200);
    assert.match(String(intro.headers.get('content-type')), /text\/html/);
    assert.match(intro.text, /<html/i);

    const favicon = await request(baseUrl, '/favicon.ico');
    assert.equal(favicon.status, 204);
    assert.equal(favicon.text, '');
  });
});

test('静态资源：/admin 构建产物、assets 200、SPA fallback、缺失 asset 404', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const index = await request(baseUrl, '/admin');
    assert.equal(index.status, 200);
    assert.match(String(index.headers.get('content-type')), /text\/html/);
    const ref = index.text.match(/(?:src|href)="([^"]+\.js)"/);
    assert.ok(ref, '/admin 应引用构建 JS 资源');

    const bundlePath = ref[1].startsWith('/') ? ref[1] : `/admin/${ref[1]}`;
    const bundle = await request(baseUrl, bundlePath);
    assert.equal(bundle.status, 200, `asset ${bundlePath} 应可访问`);
    assert.match(String(bundle.headers.get('content-type')), /javascript/);

    // SPA fallback：无扩展名的前端路由 → index.html
    const spa = await request(baseUrl, '/admin/identities');
    assert.equal(spa.status, 200);
    assert.match(spa.text, /<html/i);

    // assets/ 下缺失文件 → 404，不 fallback
    const missing = await request(baseUrl, '/admin/assets/not-exists-qa.js');
    assert.equal(missing.status, 404);
  });
});

test('静态路径穿越：编码反斜杠/点段不泄漏仓库文件', async () => {
  await withServer({}, async ({ baseUrl }) => {
    for (const candidate of ['/admin/..%5cpackage.json', '/admin/%2e%2e%5cpackage.json', '/admin/..%2fpackage.json']) {
      const res = await request(baseUrl, candidate);
      assert.ok([400, 403, 404].includes(res.status), `${candidate} 应被拒绝（实际 ${res.status}）`);
      assert.ok(!res.text.includes('"duckai-cpa"') && !res.text.includes('"name": "duckai-cpa"'), `${candidate} 不应泄漏 package.json`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. auth / method / unknown path 矩阵                                */
/* ------------------------------------------------------------------ */

test('auth 基线：/v1 无 key/错 key 401；/admin 无 token/错 token 401；CORS 预检免鉴权', async () => {
  await withServer({}, async ({ baseUrl, apiKey }) => {
    assertOpenAIEnvelope(await request(baseUrl, '/v1/models'), { status: 401, code: 'invalid_api_key', type: 'authentication_error' });
    assertOpenAIEnvelope(await request(baseUrl, '/v1/models', { headers: { authorization: 'Bearer wrong-key' } }), {
      status: 401,
      code: 'invalid_api_key'
    });
    // x-api-key 也可鉴权
    const viaHeader = await request(baseUrl, '/v1/models', { headers: { 'x-api-key': apiKey } });
    assert.equal(viaHeader.status, 200);

    assertOpenAIEnvelope(await request(baseUrl, '/admin/api/overview'), { status: 401, code: 'invalid_admin_token', type: 'authentication_error' });
    assertOpenAIEnvelope(await request(baseUrl, '/admin/api/overview', { headers: { authorization: 'Bearer wrong-admin' } }), {
      status: 401,
      code: 'invalid_admin_token'
    });
    // API key 不能替代 admin token
    const apiKeyAsAdmin = await request(baseUrl, '/admin/api/overview', { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(apiKeyAsAdmin.status, 401);

    // OPTIONS 预检不需要鉴权
    const preflight = await request(baseUrl, '/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' }
    });
    assert.equal(preflight.status, 204);
  });
});

test('method/path 矩阵：405+Allow、未知 /v1 404、未知 admin 404、未知模型 404', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const modelsPost = await v1Request(baseUrl, '/v1/models', { method: 'POST' });
    assertOpenAIEnvelope(modelsPost, { status: 405, code: 'method_not_allowed', type: 'invalid_request_error' });
    assert.equal(modelsPost.headers.get('allow'), 'GET, HEAD');

    const chatGet = await v1Request(baseUrl, '/v1/chat/completions', { method: 'GET' });
    assertOpenAIEnvelope(chatGet, { status: 405, code: 'method_not_allowed' });
    assert.equal(chatGet.headers.get('allow'), 'POST');

    const unknownV1 = await v1Request(baseUrl, '/v1/not-a-real-endpoint');
    assertOpenAIEnvelope(unknownV1, { status: 404, code: 'not_found', type: 'invalid_request_error' });

    const unknownModel = await v1Request(baseUrl, '/v1/models/not-a-real-model');
    assertOpenAIEnvelope(unknownModel, { status: 404, code: 'model_not_found' });

    const unknownAdmin = await adminRequest(baseUrl, '/admin/api/not-a-real-endpoint');
    assertOpenAIEnvelope(unknownAdmin, { status: 404, code: 'not_found' });

    const root = await request(baseUrl, '/');
    const rootPost = await request(baseUrl, '/', { method: 'POST' });
    assert.equal(rootPost.status, 405);
    assert.equal(root.status, 200);
  });
});

/* ------------------------------------------------------------------ */
/* 3. body 限制 / JSON envelope / CORS                                 */
/* ------------------------------------------------------------------ */

test('body 限制：超过 4MB 返回 413 payload_too_large JSON envelope', async () => {
  await withServer({}, async ({ baseUrl, apiKey }) => {
    const tooLarge = 'x'.repeat(4 * 1024 * 1024 + 16);
    const res = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      raw: tooLarge
    });
    assertOpenAIEnvelope(res, { status: 413, code: 'payload_too_large', type: 'invalid_request_error' });
  });
});

test('无效 JSON：400 invalid_json JSON envelope', async () => {
  await withServer({}, async ({ baseUrl, apiKey }) => {
    const invalid = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      raw: '{not-json'
    });
    assertOpenAIEnvelope(invalid, { status: 400, code: 'invalid_json', type: 'invalid_request_error' });
  });
});

test('CORS：默认开启时 preflight/实际响应带允许头；关闭后无 CORS 头', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const preflight = await request(baseUrl, '/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(String(preflight.headers.get('access-control-allow-methods')), /POST/);
    assert.match(String(preflight.headers.get('access-control-allow-headers')), /Authorization/);
    assert.match(String(preflight.headers.get('access-control-expose-headers')), /X-Request-Id/);

    const normal = await v1Request(baseUrl, '/v1/models', { headers: { origin: 'http://localhost:3000' } });
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get('access-control-allow-origin'), '*');
  });

  const config = makeConfig({ server: { cors: false } });
  await withServer({ config }, async ({ baseUrl, apiKey }) => {
    const preflight = await request(baseUrl, '/v1/chat/completions', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const normal = await request(baseUrl, '/v1/models', { headers: { authorization: `Bearer ${apiKey}`, origin: 'http://localhost:3000' } });
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get('access-control-allow-origin'), null);
  });
});

/* ------------------------------------------------------------------ */
/* 4. SSE 事件顺序基线                                                 */
/* ------------------------------------------------------------------ */

test('chat SSE：role 帧 → delta → finish_reason → [DONE]，chunk 元数据一致', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['你', '好'], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } }
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    assert.ok(events.length >= 4);
    const doneIndex = events.findIndex((event) => String(event.data || '').trim() === '[DONE]');
    assert.ok(doneIndex > 0, '最后应有 [DONE]');
    assert.equal(doneIndex, events.length - 1, '[DONE] 必须是最后一帧');
    const payloads = events
      .filter((event, index) => index !== doneIndex)
      .map(ssePayload)
      .filter(Boolean);

    const roleIndex = payloads.findIndex((payload) => payload.choices?.[0]?.delta?.role === 'assistant');
    assert.equal(roleIndex, 0, '第一帧应是 assistant role');
    const finishIndex = payloads.findIndex((payload) => payload.choices?.[0]?.finish_reason);
    assert.ok(finishIndex > 0, '应有 finish_reason 帧');
    const deltaTexts = payloads
      .filter((payload) => payload.choices?.[0]?.delta?.content)
      .map((payload) => payload.choices[0].delta.content);
    assert.deepEqual(deltaTexts, ['你', '好']);
    const usageFrame = payloads.find((payload) => payload.usage && Number.isFinite(payload.usage.total_tokens));
    assert.ok(usageFrame, 'include_usage 时应下发 usage 帧');
    assert.ok(usageFrame.usage.total_tokens >= 0);
    assert.ok(Number.isFinite(usageFrame.usage.prompt_tokens) && Number.isFinite(usageFrame.usage.completion_tokens));
    assert.ok(payloads.every((payload) => typeof payload.id === 'string' && payload.object === 'chat.completion.chunk'));
  });
});

test('responses SSE：response.created → output_item.added → delta → completed，sequence_number 递增', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['你好'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: 'hi', stream: true }
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.equal(names[0], 'response.created');
    assert.ok(names.includes('response.output_item.added'));
    assert.ok(names.includes('response.output_text.delta'));
    assert.equal(names.at(-1), 'response.completed');

    const payloads = events.filter((event) => event.json && typeof event.json === 'object').map((event) => event.json);
    const seqs = payloads.map((payload) => payload.sequence_number).filter((value) => Number.isInteger(value));
    assert.ok(seqs.length >= 4);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index] > seqs[index - 1], 'sequence_number 必须严格递增');
    }
    const completed = payloads.at(-1).response;
    assert.equal(completed.status, 'completed');
    assert.ok(Array.isArray(completed.output));
  });
});

/* ------------------------------------------------------------------ */
/* 5. 关键错误码矩阵                                                   */
/* ------------------------------------------------------------------ */

test('错误码矩阵：invalid_api_key / not_found / method_not_allowed / payload_too_large / session_history_mismatch', async () => {
  await withServer({}, async ({ baseUrl }) => {
    assertOpenAIEnvelope(await request(baseUrl, '/v1/models'), { status: 401, code: 'invalid_api_key' });
    assertOpenAIEnvelope(await v1Request(baseUrl, '/v1/unknown'), { status: 404, code: 'not_found' });
    assertOpenAIEnvelope(await v1Request(baseUrl, '/v1/models', { method: 'DELETE' }), { status: 405, code: 'method_not_allowed' });

    // session_history_mismatch：先建 session，再发同长冲突历史
    const sessionKey = 'sess-qa-phase0-contract';
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '原始问题' }] }
    });
    assert.equal(first.status, 200, first.text);
    const conflict = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '完全不同的问题' },
          { role: 'assistant', content: '不同的回答' }
        ]
      }
    });
    assertOpenAIEnvelope(conflict, { status: 409, code: 'session_history_mismatch', type: 'invalid_request_error' });
  });
});
