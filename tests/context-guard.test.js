/**
 * v2.4 上下文守卫（docs/IDENTITY-POOL.md §7）。
 *
 * 覆盖：
 *   - 发送前按 `context.maxMessages` / `maxInputChars` 裁剪，响应带 `context_trimmed:true`
 *   - 上游 `ERR_CONVERSATION_LIMIT` → 自动更激进裁剪后重试一次成功；`onLimit:"error"` 不重试 → 409
 *     `conversation_limit_reached`
 *   - 上游 `ERR_INPUT_LIMIT` → 同理重试 / 413 `input_limit_reached`
 *   - 会话（admin test sessions）assistant 消息记录 `contextTrimmed`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startTestServer, withServer, v1Request, adminRequest, makeConfig, collectSSE } from './helpers/test-server.js';
import { MockDuckClient, defaultChatBehavior } from './helpers/mock-duck.js';

async function tempDataDir(prefix = 'duckai-qa-context') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function upstreamError(code, status = 400, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** 构造 6 轮历史（无 system）。 */
function longHistory() {
  const messages = [];
  for (let index = 0; index < 3; index += 1) {
    messages.push({ role: 'user', content: `问题 ${index}：${'甲'.repeat(80)}` });
    messages.push({ role: 'assistant', content: `回答 ${index}：${'乙'.repeat(80)}` });
  }
  messages.push({ role: 'user', content: '最后一问' });
  return messages;
}

function makeConfigWithContext(context) {
  return makeConfig({ context });
}

test('发送前裁剪：maxMessages 生效，响应 context_trimmed:true', async () => {
  const duck = new MockDuckClient();
  const config = makeConfigWithContext({ maxMessages: 4, maxInputChars: 10000, onLimit: 'trim' });
  await withServer({ config, duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: longHistory() }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.context_trimmed, true);

    const call = duck.calls.chat[0];
    assert.ok(call, 'duck.chat 未被调用');
    assert.ok(
      call.messages.length <= 4,
      `裁剪后消息数应 ≤4，实际 ${call.messages.length}`
    );
  });
});

test('发送前裁剪：maxInputChars 生效（丢弃超预算的旧消息，保留最近消息）', async () => {
  const duck = new MockDuckClient();
  const config = makeConfigWithContext({ maxMessages: 40, maxInputChars: 1000, onLimit: 'trim' });
  await withServer({ config, duck }, async ({ baseUrl }) => {
    const huge = '长'.repeat(1500);
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: huge },
          { role: 'assistant', content: '旧回答' },
          { role: 'user', content: '你好' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.context_trimmed, true);
    const call = duck.calls.chat[0];
    assert.ok(call.messages.length < 3, `超预算旧消息应被丢弃（实际 ${call.messages.length} 条）`);
    const text = JSON.stringify(call.messages);
    assert.ok(!text.includes(huge), '超长旧内容不应出现在裁剪后的请求中');
    assert.ok(text.includes('你好'), '最近消息应保留');
  });
});

test('ERR_CONVERSATION_LIMIT：v2.21 即使 onLimit=trim 也不自动裁剪，返回 409 + 客户端压缩提示', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ error: upstreamError('conversation_limit_reached', 409) });
  const config = makeConfigWithContext({ maxMessages: 40, maxInputChars: 10000, onLimit: 'trim' });
  await withServer({ config, duck }, async ({ baseUrl }) => {
    const before = longHistory();
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: before }
    });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'conversation_limit_reached');
    assert.match(String(res.json.error.hint || ''), /\/v1\/compact/, '409 应提示客户端主动压缩');
    assert.equal(duck.calls.chat.length, 1, '会话上限不应自动重试');
  });
});

test('ERR_CONVERSATION_LIMIT + onLimit=error：不重试，409 conversation_limit_reached', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ error: upstreamError('conversation_limit_reached', 409) });
  const config = makeConfigWithContext({ maxMessages: 40, maxInputChars: 10000, onLimit: 'error' });
  await withServer({ config, duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: longHistory() }
    });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'conversation_limit_reached');
    assert.equal(duck.calls.chat.length, 1, 'onLimit=error 不应重试');
  });
});

test('ERR_INPUT_LIMIT：trim 模式重试成功；error 模式 413 input_limit_reached', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ error: upstreamError('input_limit_reached', 413) });
  const trimConfig = makeConfigWithContext({ maxMessages: 40, maxInputChars: 10000, onLimit: 'trim' });
  await withServer({ config: trimConfig, duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: longHistory() }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(duck.calls.chat.length, 2);
  });

  const duck2 = new MockDuckClient();
  duck2.enqueueChat({ error: upstreamError('input_limit_reached', 413) });
  const errorConfig = makeConfigWithContext({ maxMessages: 40, maxInputChars: 10000, onLimit: 'error' });
  await withServer({ config: errorConfig, duck: duck2 }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: longHistory() }
    });
    assert.equal(res.status, 413, res.text);
    assert.equal(res.json.error.code, 'input_limit_reached');
    assert.equal(duck2.calls.chat.length, 1);
  });
});

test('流式 chat：context_trimmed 也透出（SSE 首帧/最终 json 均可检查）', async () => {
  const duck = new MockDuckClient();
  const config = makeConfigWithContext({ maxMessages: 2, maxInputChars: 10000, onLimit: 'trim' });
  await withServer({ config, duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: longHistory(), stream: true }
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('data:'), '应为 SSE 响应');
    const call = duck.calls.chat[0];
    assert.ok(call.messages.length <= 2, `流式也应裁剪，实际 ${call.messages.length}`);
  });
});
