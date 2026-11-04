/**
 * v2.21：客户端显式压缩 API `POST /v1/compact` + 会话上限 409（不自动压缩）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, v1Request } from './helpers/test-server.js';
import { OpenAIError } from '../src/openai/errors.js';

function conversation(rounds = 4) {
  const messages = [];
  for (let index = 0; index < rounds; index += 1) {
    messages.push({ role: 'user', content: `用户第 ${index + 1} 轮：请记住编号 ${index + 1}。` });
    messages.push({ role: 'assistant', content: `已记住编号 ${index + 1}。` });
  }
  return messages;
}

test('POST /v1/compact：返回摘要 + 保留最近消息，且摘要请求携带历史', async () => {
  await withServer({}, async ({ baseUrl, duck }) => {
    const messages = [
      { role: 'system', content: '你是一个助手。' },
      ...conversation(5),
      { role: 'user', content: '最后一问' }
    ];
    const res = await v1Request(baseUrl, '/v1/compact', {
      method: 'POST',
      body: { messages, model: 'gpt-6-luna', keep_recent_messages: 2, max_summary_chars: 1200 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.object, 'compaction');
    assert.equal(typeof res.json.summary.text, 'string');
    assert.ok(res.json.summary.text.length > 0);
    assert.equal(res.json.summary.trigger, 'client');
    assert.ok(res.json.summary.covered_message_count >= 1);
    assert.ok(Array.isArray(res.json.kept_messages));
    assert.equal(res.json.kept_messages.length, 2, 'keep_recent_messages 应保留 2 条');
    assert.equal(res.json.usage.input_chars > 0, true);
    assert.ok(duck.calls.summarize.length >= 1, '应调用上游摘要');
    const summarizeCall = duck.calls.summarize.at(-1)?.request || {};
    assert.ok(Array.isArray(summarizeCall.messages) && summarizeCall.messages.length >= 8, '摘要历史应包含多轮消息');
    assert.equal(summarizeCall.maxSummaryChars, 1200);
  });
});

test('POST /v1/compact：无可压缩历史 → 400 nothing_to_compact', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/compact', {
      method: 'POST',
      body: {
        messages: [
          { role: 'user', content: '只有一条' },
          { role: 'assistant', content: '也只有一条' }
        ],
        keep_recent_messages: 2
      }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'nothing_to_compact');
  });
});

test('POST /v1/compact：body 非对象 → 400', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/compact', { method: 'POST', body: [] });
    assert.equal(res.status, 400);
  });
});

test('会话上限：上游返回 409 conversation_limit_reached 时不再自动裁剪重试，附带 hint', async () => {
  await withServer({}, async ({ baseUrl, duck }) => {
    const limitError = new OpenAIError('conversation limit reached', {
      status: 409,
      type: 'invalid_request_error',
      code: 'conversation_limit_reached'
    });
    duck.enqueueChat({ error: limitError });
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: conversation(6) }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'conversation_limit_reached');
    assert.match(String(res.json.error.hint || ''), /\/v1\/compact/, '409 应提示客户端调用 /v1/compact');
    // 只调用一次上游：不再自动 trim + 重试。
    assert.equal(duck.calls.chat.length, 1, `不应自动重试（实际 ${duck.calls.chat.length} 次）`);
  });
});
