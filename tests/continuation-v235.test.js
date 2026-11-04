/**
 * v2.35：continuation（LocationPrompt / 工具审批）请求体契约。
 *
 * 背景：2026-11-04 上游把「显式 toolChoice.WebSearch + continuation」判为
 * 409 continuation-restart-required: incompatible；浏览器抓包显示 continuation 应：
 *   - 不带 metadata / durableStream
 *   - currentAssistant.parts 回放 reasoning part（含 encryptedText）
 *   - canUseApproxLocation 在同意 user-location 后为 true
 * 本测试用 fetch mock 模拟「首帧 -> continuation 帧 -> 续传成功」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckClient } from '../src/duck/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const CHALLENGE_B64 = Buffer.from(fixture('challenge.captured.js'), 'utf8').toString('base64');
const TEXT_SSE = fixture(path.join('sse', 'text-stream.sse'));
const BASE_URL = 'https://duck.ai';
const VERSION_TAG = 'serp_20261030_223718_ET';
const VERSION_SHA = '61e4601227ece8af7a1ad4d69b79aafd35f91fae';
const PAGE_HTML = `<!doctype html><html data-version-tag="${VERSION_TAG}" data-version-sha="${VERSION_SHA}"><head></head><body></body></html>`;

const APPROVAL_SSE = [
  'data: {"role":"reasoning","state":"done","summaryText":["需要先确认位置"],"encryptedText":"gAAAA-encrypted-blob","id":"rs_test_1","sourceUpstreamId":"u10","sourceModelId":"gpt-6-luna"}',
  '',
  'data: {"role":"continuation","action":"success","token":"continuation-token-1","replayPolicy":"existing-consent-fallback","pendingActions":[{"kind":"approval","toolCallId":"call_1","approvalId":"approval-1","toolName":"LocationPrompt","purpose":"user-location"}]}',
  '',
  ''
].join('\n');

function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const call = {
      url,
      pathname: url.pathname,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(call);
    return handler(call, calls);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const textResponse = (body, headers = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const sseResponse = (body) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vqd-hash-1': CHALLENGE_B64 } });

function makeClient() {
  return new DuckClient({
    baseUrl: BASE_URL,
    defaultModel: 'gpt-6-luna',
    timeoutMs: 20000,
    humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, concurrency: 1, maxRetries: 0, retryBaseDelayMs: 0, rateLimitCooldownMs: 100, rateLimitWaitMs: 1000 },
    challenge: { timeoutMs: 15000, solveTimeoutMs: 15000 }
  });
}

test('continuation：审批回放格式与浏览器一致（无 metadata/durableStream，带 reasoning part 与 canUseApproxLocation）', async () => {
  let chatCount = 0;
  const routes = (call) => {
    if (call.pathname === '/') return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (call.pathname === '/duckchat/v1/status') {
      return textResponse('{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}', { 'x-vqd-hash-1': CHALLENGE_B64 });
    }
    if (call.pathname === '/duckchat/v1/capabilities') return textResponse('{"accessLevel":"public","flags":{}}');
    if (call.pathname === '/duckchat/v1/chat') {
      chatCount += 1;
      return sseResponse(chatCount === 1 ? APPROVAL_SSE : TEXT_SSE);
    }
    return new Response('not found', { status: 404 });
  };
  const mock = installFetchMock(routes);
  try {
    const client = makeClient();
    await client.init();
    const result = await client.chat(
      { model: 'gpt-6-luna', messages: [{ role: 'user', content: '今天天气怎么样？' }], approxLocation: true },
      { onTextDelta() {} }
    );
    assert.equal(chatCount, 2, '应发生一次 continuation 重发');

    const chatCalls = mock.calls.filter((call) => call.pathname === '/duckchat/v1/chat');
    const first = chatCalls[0].body;
    const second = chatCalls[1].body;

    // 首次请求：不再强制 WebSearch toolChoice
    assert.equal(first.metadata, undefined, '不应带 metadata.toolChoice');
    assert.equal(first.canUseTools, true);
    // 定位开关开启时初始发 null（允许上游询问），审批通过后才发 true\n    assert.equal(first.canUseApproxLocation, null, '定位开关开启时初始应为 null');
    assert.equal(first.canShowGreeting, true);

    // continuation：浏览器形状
    assert.ok(second.continuation, '续传请求应带 continuation');
    assert.equal(second.continuation.token, 'continuation-token-1');
    assert.equal(second.continuation.responseId, chatCalls[0].headers['x-duckai-response-id']);
    assert.deepEqual(second.continuation.responses, [{ kind: 'approval', approvalId: 'approval-1', approved: true }]);
    assert.equal(second.canUseApproxLocation, true, '同意定位后应为 true');
    assert.equal(second.canDelegateImageGeneration, null);
    assert.equal(second.durableStream, undefined, '续传不带 durableStream');
    assert.equal(second.metadata, undefined, '续传不带 metadata');
    assert.equal(second.currentAssistant.role, 'assistant');
    assert.equal(second.currentAssistant.content, '');
    assert.equal(second.currentAssistant.parts.length, 1);
    assert.equal(second.currentAssistant.parts[0].type, 'reasoning');
    assert.equal(second.currentAssistant.parts[0].encryptedText, 'gAAAA-encrypted-blob');
    assert.equal(second.currentAssistant.parts[0].id, 'rs_test_1');

    assert.ok(result.content.length > 0, '续传后的文本应合并进结果');
  } finally {
    mock.restore();
  }
});

test('continuation：定位开关关闭时，LocationPrompt 审批为 approved:false（不报错、模型改用无定位回答）', async () => {
  let chatCount = 0;
  const routes = (call) => {
    if (call.pathname === '/') return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (call.pathname === '/duckchat/v1/status') {
      return textResponse('{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}', { 'x-vqd-hash-1': CHALLENGE_B64 });
    }
    if (call.pathname === '/duckchat/v1/capabilities') return textResponse('{"accessLevel":"public","flags":{}}');
    if (call.pathname === '/duckchat/v1/chat') {
      chatCount += 1;
      return sseResponse(chatCount === 1 ? APPROVAL_SSE : TEXT_SSE);
    }
    return new Response('not found', { status: 404 });
  };
  const mock = installFetchMock(routes);
  try {
    const client = makeClient();
    await client.init();
    const result = await client.chat(
      { model: 'gpt-6-luna', messages: [{ role: 'user', content: '今天天气怎么样？' }], approxLocation: false },
      { onTextDelta() {} }
    );
    const chatCalls = mock.calls.filter((call) => call.pathname === '/duckchat/v1/chat');
    const second = chatCalls[1].body;
    assert.deepEqual(second.continuation.responses, [{ kind: 'approval', approvalId: 'approval-1', approved: false }]);
    assert.equal(second.canUseApproxLocation, false, '拒绝定位时应显式发 false');
    assert.ok(result.content.length > 0);
    assert.deepEqual(
      (result.approvals || []).map((item) => item.approved),
      [false],
      '结果应记录审批为拒绝'
    );
  } finally {
    mock.restore();
  }
});