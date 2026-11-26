/**
 * CDN Keepalive / 防超时离线测试（tests/cdn-keepalive.test.js）：
 *   1. SSE 空闲感知心跳：有正常 delta 时不插心跳，空闲 >= keepaliveMs 时发 `: keepalive\n\n`；
 *   2. 非流式 JSON 前导空白保活：慢响应期间收到前导 `' '`，最终 `JSON.parse` 仍完全合法；
 *   3. 前置错误保活边界：上游返回 200 前报错（如 429）保留精确 HTTP 429 状态码；
 *   4. 已提交 JSON 错误兜底：上游 200 后中途报错，响应体仍为合法 OpenAI error JSON；
 *   5. 工具模式流式：streamChatCompletionWithTools 与 streamResponseWithTools 在上游接受后立即发心跳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { withServer, API_KEY, makeConfig } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { DuckError } from '../src/duck/index.js';

function rawHttpPost(baseUrl, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...extraHeaders
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const TOOL = {
  type: 'function',
  function: {
    name: 'lookup_weather',
    description: '查询天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
};

test('非流式 JSON keepalive：慢响应输出前导空白且最终为合法 JSON（chat + responses + images）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['hello world'], streamDelayMs: 120 });
  duck.enqueueChat({ textDeltas: ['resp ok'], streamDelayMs: 120 });
  duck.imageBehavior = { ...duck.imageBehavior, streamDelayMs: 120 };

  const config = makeConfig({ http: { keepaliveIntervalMs: 30 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const chatRes = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.headers['x-accel-buffering'], 'no');
    assert.match(chatRes.text, /^\s+\{/);
    const chatJson = JSON.parse(chatRes.text);
    assert.equal(chatJson.choices[0].message.content, 'hello world');

    const respRes = await rawHttpPost(baseUrl, '/v1/responses', {
      model: 'gpt-6-luna',
      input: 'hi',
      stream: false
    });
    assert.equal(respRes.status, 200);
    assert.match(respRes.text, /^\s+\{/);
    const respJson = JSON.parse(respRes.text);
    assert.equal(respJson.output_text, 'resp ok');

    const imgRes = await rawHttpPost(baseUrl, '/v1/images/generations', {
      model: 'gpt-6-luna',
      prompt: 'sunset over ocean'
    });
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.text, /^\s+\{/);
    const imgJson = JSON.parse(imgRes.text);
    assert.ok(Array.isArray(imgJson.data) && imgJson.data.length === 1);
  });
});

test('前置错误保活边界：上游返回 200 前失败仍保留精确 HTTP 错误码', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    delayMs: 50,
    error: new DuckError('rate limited before accept', { status: 429, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' })
  });
  const config = makeConfig({ http: { keepaliveIntervalMs: 20 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    assert.equal(res.status, 429);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.error.type, 'rate_limit_exceeded');
  });
});

test('已提交 JSON keepalive 中途出错：仍写出完整 OpenAI 错误 JSON', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    streamDelayMs: 90,
    textDeltas: ['partial'],
    errorAfterText: new DuckError('stream broke mid-flight', { status: 502, type: 'upstream_error', code: 'upstream_error' })
  });
  const config = makeConfig({ http: { keepaliveIntervalMs: 25 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /^\s*\{/);
    const parsed = JSON.parse(res.text);
    assert.ok(parsed.error && typeof parsed.error.message === 'string');
  });
});

test('SSE 心跳：工具流式在慢上游阶段提前发出 : keepalive\n\n（chat + responses）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['答案1'], streamDelayMs: 110 });
  duck.enqueueChat({ textDeltas: ['答案2'], streamDelayMs: 110 });
  const config = makeConfig({ http: { keepaliveIntervalMs: 25 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const chatSse = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: '查天气' }],
      tools: [TOOL],
      stream: true
    });
    assert.equal(chatSse.status, 200);
    assert.equal(chatSse.headers['x-accel-buffering'], 'no');
    assert.match(chatSse.text, /: keepalive/);
    assert.match(chatSse.text, /答案1/);

    const respSse = await rawHttpPost(baseUrl, '/v1/responses', {
      model: 'gpt-6-luna',
      input: '查天气',
      tools: [TOOL],
      stream: true
    });
    assert.equal(respSse.status, 200);
    assert.match(respSse.text, /: keepalive/);
    assert.match(respSse.text, /答案2/);
  });
});
