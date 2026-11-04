/**
 * v2.19 continuation（工具审批 / 可续传流）单元测试。
 *
 * 背景：问「洛杉矶天气怎么样」时，上游可能以 `continuation` 帧结束而不是 [DONE]；
 * 旧实现在严格模式下直接抛 502 "SSE stream ended without a [DONE] terminator"。
 * 现在必须：
 *  - 把 token + pendingActions(approval) 转成 responses=[{kind:'approval',approvalId,approved:true}]
 *  - 用 {continuation:{token,responseId,responses}, currentAssistant:{role,content,parts}} 重发
 *  - 合并两次流的内容并正常返回
 *  - client-output 类工具无法满足 → upstream_client_tool_unsupported
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DuckClient } from '../src/duck/index.js';

function sseResponse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vqd-hash-1': 'rolling-challenge' }
  });
}

function challengeStub(client) {
  // Avoid the real /status + jsdom challenge solver.
  client.challenge = {
    version: '1.2.3',
    async acquire() {
      return {
        header: 'solved-vqd',
        source: 'stub',
        commit() {},
        release() {}
      };
    },
    async ensureVersion() {
      return this.version;
    },
    stats() {
      return { lastSolveSource: 'stub', solves: 0 };
    },
    async invalidate() {}
  };
  client._respectRateLimit = async () => {};
}

test('continuation：approval 帧 → 自动批准并续传，合并内容', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init.headers, body });
    if (calls.length === 1) {
      return sseResponse([
        {
          action: 'success',
          role: 'continuation',
          token: 'cont-token-1',
          pendingActions: [{ kind: 'approval', approvalId: 'ap-1', purpose: 'user-location', toolName: 'LocationPrompt' }]
        }
      ]);
    }
    return sseResponse([
      { action: 'success', role: 'assistant', message: '洛杉矶今天晴，24°C。' },
      `[DONE]`
    ]);
  };
  const client = new DuckClient({
    baseUrl: 'https://sync.example.test',
    defaultModel: 'gpt-6-luna',
    fetchImpl,
    humanize: { minDelayMs: 0, maxDelayMs: 0 }
  });
  challengeStub(client);
  client._fetch = fetchImpl;

  // v2.36：定位默认关闭；显式开启才自动批准
  const result = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '洛杉矶天气怎么样' }], approxLocation: true });
  assert.equal(calls.length, 2, '应发起一次续传请求');
  assert.match(result.content, /洛杉矶/);
  const continuation = calls[1].body.continuation;
  assert.equal(continuation.token, 'cont-token-1');
  assert.equal(typeof continuation.responseId, 'string');
  assert.deepEqual(continuation.responses, [{ kind: 'approval', approvalId: 'ap-1', approved: true }]);
  assert.equal(calls[1].body.currentAssistant.role, 'assistant');
  assert.equal(typeof calls[1].body.currentAssistant.parts, 'object');
  assert.equal(calls[1].body.durableStream, undefined, '续传请求不应带 durableStream');
  assert.equal(
    calls[1].headers['x-duckai-response-id'],
    calls[0].headers['x-duckai-response-id'],
    `response id 应保持一致（${calls[0].headers['x-duckai-response-id']} vs ${calls[1].headers['x-duckai-response-id']}）`
  );
});

test('continuation：client-output 工具无法满足 → upstream_client_tool_unsupported', async () => {
  const fetchImpl = async () =>
    sseResponse([
      {
        action: 'success',
        role: 'continuation',
        token: 'cont-token-2',
        pendingActions: [{ kind: 'client-output', toolCallId: 'tc-1', toolName: 'SomeClientTool', contract: {}, input: {} }]
      }
    ]);
  const client = new DuckClient({
    baseUrl: 'https://sync.example.test',
    defaultModel: 'gpt-6-luna',
    fetchImpl,
    humanize: { minDelayMs: 0, maxDelayMs: 0 }
  });
  challengeStub(client);
  client._fetch = fetchImpl;
  await assert.rejects(
    () => client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.code, 'upstream_client_tool_unsupported');
      assert.equal(error.status, 502);
      assert.deepEqual(error.detail?.tools, ['SomeClientTool']);
      return true;
    }
  );
});
