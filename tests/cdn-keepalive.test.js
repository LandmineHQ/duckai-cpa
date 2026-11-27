/**
 * CDN Keepalive / Pre-header 防超时离线测试（tests/cdn-keepalive.test.js）：
 *   1. SSE 空闲感知心跳：空闲 >= keepaliveMs 时发 `: keepalive\n\n`；
 *   2. 非流式 JSON 前导空白保活：慢响应期间收到前导 `' '`，最终 `JSON.parse` 仍完全合法；
 *   3. 前置错误保活边界：上游快速失败保留精确 HTTP 错误码（< preHeaderDelayMs）；
 *   4. 已提交 JSON/SSE 中途出错：仍写出完整 OpenAI 错误帧，且上游日志记准确非 200 状态码；
 *   5. Pre-header 延迟保活：上游 prefill / 队列慢于 preHeaderDelayMs 时提前发 HTTP 200 + 首条心跳/空白；
 *   6. 客户端/CDN 中途断开连接（499）：日志准确记为 499。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { withServer, API_KEY, makeConfig } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { DuckError } from '../src/duck/index.js';

function rawHttpPost(baseUrl, pathname, body, extraHeaders = {}, options = {}) {
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
        const headersAt = Date.now();
        let firstChunkAt = null;
        options.onHeaders?.({ res, req, headersAt });
        const chunks = [];
        res.on('data', (chunk) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          chunks.push(chunk);
          options.onChunk?.({ res, req, chunk, firstChunkAt });
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            headersAt,
            firstChunkAt,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
        res.on('close', () => {
          if (!res.complete) {
            resolve({
              aborted: true,
              status: res.statusCode,
              headers: res.headers,
              headersAt,
              firstChunkAt,
              text: Buffer.concat(chunks).toString('utf8')
            });
          }
        });
      }
    );
    req.on('error', (err) => {
      if (err?.code === 'ECONNRESET') {
        resolve({ aborted: true });
        return;
      }
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

async function waitForLog(store, predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = store.getLogs?.({ kind: 'upstream', limit: 100 })?.items || [];
    const match = items.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
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

  const config = makeConfig({ http: { keepaliveIntervalMs: 30, preHeaderKeepaliveDelayMs: 0 } });
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

test('前置错误保活边界：上游返回 200 前快速失败仍保留精确 HTTP 错误码', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    delayMs: 20,
    error: new DuckError('rate limited before accept', { status: 429, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' })
  });
  duck.enqueueChat({
    delayMs: 20,
    error: new DuckError('bad req before accept', { status: 400, type: 'upstream_error', code: 'upstream_protocol_mismatch' })
  });
  const config = makeConfig({
    upstream: { rps: 20, maxConcurrent: 4 },
    http: { keepaliveIntervalMs: 20, preHeaderKeepaliveDelayMs: 250 }
  });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    assert.equal(res.status, 429);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.error.type, 'rate_limit_exceeded');

    const sseRes = await rawHttpPost(baseUrl, '/v1/responses', {
      model: 'gpt-6-luna',
      input: 'hi',
      stream: true
    });
    assert.equal(sseRes.status, 502);
    const sseErr = JSON.parse(sseRes.text);
    assert.equal(sseErr.error.code, 'upstream_protocol_mismatch');
  });
});

test('已提交 JSON keepalive 中途出错：仍写出完整 OpenAI 错误 JSON 且日志记真实错误码', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    streamDelayMs: 90,
    textDeltas: ['partial'],
    errorAfterText: new DuckError('stream broke mid-flight', { status: 502, type: 'upstream_error', code: 'upstream_error' })
  });
  const config = makeConfig({ http: { keepaliveIntervalMs: 25, preHeaderKeepaliveDelayMs: 25 } });
  await withServer({ duck, config }, async ({ baseUrl, store }) => {
    const res = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /^\s+\{/);
    const parsed = JSON.parse(res.text);
    assert.ok(parsed.error && typeof parsed.error.message === 'string');

    const logItem = await waitForLog(store, (item) => item.endpoint === 'POST /v1/chat/completions');
    assert.equal(logItem?.status, 502);
  });
});

test('SSE 心跳：工具流式在慢上游阶段提前发出 : keepalive\\n\\n（chat + responses）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['答案1'], streamDelayMs: 110 });
  duck.enqueueChat({ textDeltas: ['答案2'], streamDelayMs: 110 });
  const config = makeConfig({ http: { keepaliveIntervalMs: 25, preHeaderKeepaliveDelayMs: 25 } });
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

test('Pre-header 延迟保活：上游 prefill 超时窗口前提前提交 HTTP 200 与首帧保活（stream + non-stream）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ delayMs: 220, textDeltas: ['Prefill Chat Stream'] });
  duck.enqueueChat({ delayMs: 220, textDeltas: ['Prefill Resp Stream'] });
  duck.enqueueChat({ delayMs: 220, textDeltas: ['Prefill Chat JSON'] });
  duck.enqueueChat({ delayMs: 220, textDeltas: ['Prefill Resp JSON'] });
  duck.imageBehavior = { ...duck.imageBehavior, delayMs: 220 };

  const config = makeConfig({ http: { keepaliveIntervalMs: 40, preHeaderKeepaliveDelayMs: 40 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const cases = [
      { path: '/v1/chat/completions', body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'big prompt' }] }, stream: true, want: 'Prefill Chat Stream', kind: 'chat' },
      { path: '/v1/responses', body: { model: 'gpt-6-luna', stream: true, input: 'big prompt' }, stream: true, want: 'Prefill Resp Stream', kind: 'chat' },
      { path: '/v1/chat/completions', body: { model: 'gpt-6-luna', stream: false, messages: [{ role: 'user', content: 'big prompt' }] }, stream: false, want: 'Prefill Chat JSON', kind: 'chat' },
      { path: '/v1/responses', body: { model: 'gpt-6-luna', stream: false, input: 'big prompt' }, stream: false, want: 'Prefill Resp JSON', kind: 'chat' },
      { path: '/v1/images/generations', body: { model: 'gpt-6-luna', prompt: 'slow mountain sunrise' }, stream: false, want: 'b64_json', kind: 'image' }
    ];

    let chatIdx = 0;
    for (const tc of cases) {
      const res = await rawHttpPost(baseUrl, tc.path, tc.body);
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-accel-buffering'], 'no');
      const acceptedAt =
        tc.kind === 'image' ? duck.calls.imageGeneration[0].acceptedAt : duck.calls.chat[chatIdx++].acceptedAt;
      assert.ok(acceptedAt && res.firstChunkAt, 'expected recorded acceptedAt and firstChunkAt');
      const leadMs = acceptedAt - res.firstChunkAt;
      assert.ok(leadMs >= 60, `expected pre-header keepalive >=60ms before upstream accepted, got ${leadMs}ms`);

      if (tc.stream) {
        assert.ok(res.text.startsWith(': keepalive\n\n'), `expected leading : keepalive comment, got ${JSON.stringify(res.text.slice(0, 40))}`);
        assert.ok(res.text.includes(tc.want));
      } else {
        assert.ok(res.text.startsWith(' '), `expected leading whitespace byte, got ${JSON.stringify(res.text.slice(0, 16))}`);
        const parsed = JSON.parse(res.text);
        assert.ok(JSON.stringify(parsed).includes(tc.want));
      }
    }
  });
});

test('Pre-header 提交后上游失败：发送规范 SSE/JSON 错误帧且上游日志记录真实 502 状态', async () => {
  const duck = new MockDuckClient();
  const slowErr = () => new DuckError('slow upstream 502', { status: 502, type: 'upstream_error', code: 'upstream_protocol_mismatch' });
  duck.enqueueChat({ delayMs: 120, error: slowErr() });
  duck.enqueueChat({ delayMs: 120, error: slowErr() });
  duck.enqueueChat({ delayMs: 120, error: slowErr() });

  const config = makeConfig({ http: { keepaliveIntervalMs: 35, preHeaderKeepaliveDelayMs: 35 } });
  await withServer({ duck, config }, async ({ baseUrl, store }) => {
    const respSse = await rawHttpPost(baseUrl, '/v1/responses', { model: 'gpt-6-luna', stream: true, input: 'slow fail' });
    assert.equal(respSse.status, 200);
    assert.match(respSse.text, /^: keepalive\n\n/);
    assert.match(respSse.text, /event: response\.failed/);
    assert.match(respSse.text, /upstream_protocol_mismatch/);

    const chatSse = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      stream: true,
      messages: [{ role: 'user', content: 'slow fail' }]
    });
    assert.equal(chatSse.status, 200);
    assert.match(chatSse.text, /^: keepalive\n\n/);
    assert.match(chatSse.text, /"upstream_protocol_mismatch"/);
    assert.match(chatSse.text, /data: \[DONE\]/);

    const chatJson = await rawHttpPost(baseUrl, '/v1/chat/completions', {
      model: 'gpt-6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'slow fail' }]
    });
    assert.equal(chatJson.status, 200);
    assert.match(chatJson.text, /^\s+\{/);
    const parsedErr = JSON.parse(chatJson.text);
    assert.equal(parsedErr.error.code, 'upstream_protocol_mismatch');

    const start = Date.now();
    let count502 = 0;
    while (Date.now() - start < 1500) {
      const items = store.getLogs?.({ kind: 'upstream', limit: 100 })?.items || [];
      count502 = items.filter((it) => it.status === 502).length;
      if (count502 >= 3) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(count502, 3, `expected 3 logged 502 entries, got ${count502}`);
  });
});

test('客户端/CDN 中途断开连接（499）：在 pre-header 提交后断开仍记录 499', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ delayMs: 400, textDeltas: ['too late'] });
  const config = makeConfig({ http: { keepaliveIntervalMs: 30, preHeaderKeepaliveDelayMs: 30 } });
  await withServer({ duck, config }, async ({ baseUrl, store }) => {
    await rawHttpPost(
      baseUrl,
      '/v1/chat/completions',
      { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'abort me' }] },
      {},
      {
        onChunk({ req }) {
          req.destroy();
        }
      }
    );
    const logItem = await waitForLog(store, (item) => item.status === 499);
    assert.equal(logItem?.status, 499);
  });
});
