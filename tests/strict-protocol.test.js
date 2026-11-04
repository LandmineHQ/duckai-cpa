/**
 * v2 上游严格协议校验 + 错误映射（docs/ADMIN_API_V2.md §6）。
 *
 * Part A（duck 层，mock 全局 fetch）：DuckClient 对异常上游“立即中断”：
 *   - 成功响应 content-type 不是 text/event-stream / 缺滚动挑战头 → upstream_protocol_mismatch
 *   - SSE 行 JSON 解析失败 / 未知 role / 缺 [DONE] → upstream_protocol_mismatch
 *   - imageGeneration 结束无 success 图片 → upstream_no_image
 *   并断言上游请求 signal 被 abort。
 *
 * Part B（server 层，mock DuckClient 抛 DuckError）：错误码映射：
 *   upstream_protocol_mismatch/upstream_no_image → 502
 *   ERR_REFUSAL/moderation → 403 content_filter
 *   ERR_ANOMALY → 429 upstream_anomaly_check
 *   ERR_ACCOUNT_LIMIT → 403 upstream_subscription_required
 *   已开始流式后出错 → error 事件且无完成事件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DuckClient, DuckError, DEFAULT_USER_AGENT } from '../src/duck/index.js';
import {
  withServer,
  makeConfig,
  v1Request,
  collectSSE,
  apiHeaders
} from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';

/* ------------------------------------------------------------------ */
/* Part A：DuckClient 严格校验（mock fetch）                            */
/* ------------------------------------------------------------------ */

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');
const CHALLENGE_B64 = Buffer.from(
  fs.readFileSync(path.join(FIXTURE_DIR, 'challenge.captured.js'), 'utf8'),
  'utf8'
).toString('base64');
const TEXT_SSE = fs.readFileSync(path.join(FIXTURE_DIR, 'sse', 'text-stream.sse'), 'utf8');

const PAGE_HTML =
  '<!doctype html><html data-version-tag="serp_20261030_223718_ET" ' +
  'data-version-sha="61e4601227ece8af7a1ad4d69b79aafd35f91fae"><head></head><body></body></html>';

function installFetchMock(chatResponder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const call = { pathname: url.pathname, signal: init.signal, headers: init.headers || {} };
    calls.push(call);
    if (url.pathname === '/') {
      return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/duckchat/v1/status') {
      return new Response('{"status":"0"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-vqd-hash-1': CHALLENGE_B64 }
      });
    }
    if (url.pathname === '/duckchat/v1/capabilities') {
      return new Response('{"accessLevel":"public"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/duckchat/v1/chat') return chatResponder(call, calls);
    return new Response('not found', { status: 404 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function makeClient() {
  return new DuckClient({
    baseUrl: 'https://duck.ai',
    defaultModel: 'gpt-6-luna',
    timeoutMs: 15000,
    humanize: {
      minDelayMs: 0,
      maxDelayMs: 0,
      minIntervalMs: 0,
      concurrency: 1,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      rateLimitCooldownMs: 100,
      rateLimitWaitMs: 1000
    },
    challenge: { timeoutMs: 15000, solveTimeoutMs: 15000 }
  });
}

function sseResponse(body, headers = { 'x-vqd-hash-1': CHALLENGE_B64 }) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function lastChatCall(mock) {
  const calls = mock.calls.filter((call) => call.pathname === '/duckchat/v1/chat');
  return calls[calls.length - 1];
}

function assertStrictError(error, expectedCode) {
  assert.ok(error instanceof DuckError, `expected DuckError, got ${error && error.name}: ${error && error.message}`);
  assert.equal(error.status, 502, `expected status 502, got ${error.status}`);
  assert.equal(error.code || error.type, expectedCode, `expected code ${expectedCode}, got ${error.code || error.type}`);
}

async function runStrictCase(name, responder, expectedCode, options = {}) {
  const mock = installFetchMock(responder);
  try {
    const client = makeClient();
    await client.init();
    await assert.rejects(
      client.chat(
        {
          model: 'gpt-6-luna',
          imageGeneration: options.imageGeneration === true,
          messages: [{ role: 'user', content: 'hi' }]
        },
        {}
      ),
      (error) => {
        assertStrictError(error, expectedCode);
        return true;
      },
      `${name}: expected strict protocol failure`
    );
    const call = lastChatCall(mock);
    assert.ok(call, `${name}: no /chat request captured`);
    // 流中途发现协议错误 → 必须 abort；流结束后才判定（如图片缺失）不强制 abort。
    if (options.expectAbort !== false) {
      assert.equal(call.signal?.aborted, true, `${name}: upstream request signal must be aborted`);
    }
  } finally {
    mock.restore();
  }
}

test('严格校验：成功响应 content-type 非 text/event-stream → upstream_protocol_mismatch + abort', async () => {
  await runStrictCase(
    'wrong-content-type',
    () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    'upstream_protocol_mismatch'
  );
});

test('严格校验：成功响应缺少滚动挑战头 x-vqd-hash-1 → 立即中断', async () => {
  await runStrictCase(
    'missing-challenge-header',
    () => new Response(TEXT_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    'upstream_protocol_mismatch'
  );
});

test('严格校验：SSE 行 JSON 解析失败 → upstream_protocol_mismatch + abort', async () => {
  await runStrictCase(
    'malformed-json',
    () => sseResponse('data: {oops-not-json\n\ndata: [DONE]\n\n'),
    'upstream_protocol_mismatch'
  );
});

test('严格校验：未知事件 role（白名单外）→ upstream_protocol_mismatch + abort', async () => {
  await runStrictCase(
    'unknown-role',
    () => sseResponse('data: {"role":"totally-unknown","message":"x"}\n\ndata: [DONE]\n\n'),
    'upstream_protocol_mismatch'
  );
});

test('严格校验：缺少 [DONE] 结束标记 → upstream_protocol_mismatch + abort', async () => {
  await runStrictCase(
    'missing-done',
    () => sseResponse('data: {"role":"assistant","message":"hi"}\n\n'),
    'upstream_protocol_mismatch'
  );
});

test('严格校验：图片生成结束无 success 图片 → upstream_no_image', async () => {
  const noImageSse = [
    'data: {"role":"ui-component","state":"placement","name":"generate-image","toolCallId":"call_1"}',
    '',
    'data: {"role":"ui-component","state":"data","name":"generate-image","data":{"type":"image-partial","status":"partial","b64Image":"/9j/4AAQ"}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  await runStrictCase('image-without-success', () => sseResponse(noImageSse), 'upstream_no_image', {
    imageGeneration: true,
    // 图片缺失在流结束后才能判定（此时已无可中断的请求体），不强制 abort。
    expectAbort: false
  });
});

/* ------------------------------------------------------------------ */
/* Part B：server 层错误映射（mock DuckClient 抛 DuckError）             */
/* ------------------------------------------------------------------ */

function makeDuckError(code, { status = 502, type = 'upstream_error', message = 'upstream failure' } = {}) {
  const error = new DuckError(message, { status, type, retriable: false });
  error.code = code;
  error.status = status;
  error.type = type;
  return error;
}

function chat(baseUrl, model = 'gpt-6-luna') {
  return v1Request(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'hi' }] }
  });
}

test('错误映射：upstream_protocol_mismatch / upstream_no_image → 502 + 原 code', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, error: makeDuckError('upstream_protocol_mismatch') };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await chat(baseUrl);
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'upstream_protocol_mismatch');
    assert.equal(res.json.error.type, 'upstream_error');
  });

  const imageDuck = new MockDuckClient();
  imageDuck.imageBehavior = { error: makeDuckError('upstream_no_image') };
  await withServer({ duck: imageDuck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: 'draw a duck' }
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'upstream_no_image');
  });
});

test('错误映射：ERR_REFUSAL/moderation → 403 content_filter', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    error: makeDuckError('content_filter', { status: 403, type: 'ERR_REFUSAL', message: 'refused by upstream' })
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await chat(baseUrl);
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'content_filter');
  });
});

test('错误映射：ERR_ANOMALY → 429 upstream_anomaly_check', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    error: makeDuckError('upstream_anomaly_check', { status: 429, type: 'ERR_ANOMALY', message: 'anomaly check' })
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await chat(baseUrl);
    assert.equal(res.status, 429);
    assert.equal(res.json.error.code, 'upstream_anomaly_check');
  });
});

test('错误映射：ERR_ACCOUNT_LIMIT → 403 upstream_subscription_required', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    error: makeDuckError('upstream_subscription_required', {
      status: 403,
      type: 'ERR_ACCOUNT_LIMIT',
      message: 'account limit'
    })
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await chat(baseUrl);
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'upstream_subscription_required');
  });
});

test('已开始流式后出错：chat 只发 error 事件 + [DONE]，不发 finish_reason 完成帧', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    textDeltas: ['部分'],
    errorAfterText: makeDuckError('upstream_protocol_mismatch')
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      headers: apiHeaders(),
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(response.status, 200);
    const chunks = events.filter((event) => event.json).map((event) => event.json);
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === '部分'), 'partial content first');
    const errorEvent = events.find((event) => event.json?.error);
    assert.ok(errorEvent, 'missing error payload');
    assert.equal(errorEvent.json.error.code, 'upstream_protocol_mismatch');
    assert.equal(events.at(-1).data.trim(), '[DONE]');
    assert.ok(
      !chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'),
      'must not emit a fake completion frame'
    );
  });
});

test('已开始流式后出错：responses 只发 response.failed/error，无 response.completed', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    ...duck.chatBehavior,
    textDeltas: ['部分'],
    errorAfterText: makeDuckError('upstream_protocol_mismatch')
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/responses', {
      headers: apiHeaders(),
      body: { model: 'gpt-6-luna', input: 'hi', stream: true }
    });
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.includes('response.failed'));
    assert.ok(names.includes('error'));
    assert.ok(!names.includes('response.completed'));
  });
});

test('首事件前失败：严格协议错误直接返回 HTTP 502（不进入 SSE）', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, error: makeDuckError('upstream_protocol_mismatch') };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'upstream_protocol_mismatch');
    assert.doesNotMatch(res.text, /\[DONE\]/);
  });
});
