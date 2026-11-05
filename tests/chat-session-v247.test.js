/**
 * v2.47：Chat Completions 服务端会话（X-Session-Id）
 * - 网关保存 canonical conversation + 精确 upstream 前缀；
 * - 下一轮发完整历史时按前缀复用，只追加新消息；
 * - X-Conversation-Delta: true 支持只发新消息；
 * - 历史不匹配 → 409 conversation_session_conflict。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

const SESSION = 'sess-lock-stable';

test('chat session：完整历史前缀复用（旧消息不进过二次处理）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['第一轮回答'] });
  duck.enqueueChat({ textDeltas: ['第二轮回答'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': SESSION, 'x-conversation-mode': 'server' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '第一轮问题' }] }
    });
    assert.equal(first.status, 200, first.text);
    const assistant1 = JSON.parse(first.text).choices[0].message.content;
    const turn1 = duck.calls.chat[0].params.messages;

    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': SESSION, 'x-conversation-mode': 'server' },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '第一轮问题' },
          { role: 'assistant', content: assistant1 },
          { role: 'user', content: '第二轮问题' }
        ]
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).choices[0].message.content, '第二轮回答');
    const turn2 = duck.calls.chat.at(-1).params.messages;
    assert.deepEqual(turn2.slice(0, turn1.length), turn1, '第二轮应逐字节复用第一轮前缀');
    assert.equal(turn2[turn1.length].content, assistant1, '应追加第一轮 assistant');
    assert.equal(turn2.at(-1).content, '第二轮问题');
  });
});

test('chat session：X-Conversation-Delta 只发新消息', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['回答一'] });
  duck.enqueueChat({ textDeltas: ['回答二'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-delta', 'x-conversation-mode': 'server' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '问题一' }] }
    });
    assert.equal(first.status, 200, first.text);

    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-delta', 'x-conversation-delta': 'true' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '问题二' }] }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).choices[0].message.content, '回答二');
    const messages = duck.calls.chat.at(-1).params.messages;
    const flat = JSON.stringify(messages);
    assert.ok(flat.includes('问题一'), '应包含第一轮 user');
    assert.ok(flat.includes('回答一'), '应包含第一轮 assistant');
    assert.ok(flat.includes('问题二'), '应包含第二轮 user');
  });
});

test('chat session：历史不匹配 → 409 session_history_mismatch（v2.59 authoritative）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['ok'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-conflict', 'x-conversation-mode': 'server' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '原始问题' }] }
    });
    assert.equal(first.status, 200, first.text);

    // v2.59：更短的历史按 delta 处理；同长/更长的冲突历史才返回 session_history_mismatch。
    const conflict = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-conflict', 'x-conversation-mode': 'server' },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '完全不同的历史' },
          { role: 'assistant', content: '完全不同的回答' }
        ]
      }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'session_history_mismatch');
  });
});

test('chat session：tools 调用后继续（role:"tool" 增量）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['{"tool_call":{"name":"read_file","arguments":{"path":"package.json"}}}'] });
  duck.enqueueChat({ textDeltas: ['package.json 已读取。'] });

  const tools = [
    {
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
    }
  ];

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-tools', 'x-conversation-mode': 'server' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '读取 package.json' }], tools }
    });
    assert.equal(first.status, 200, first.text);
    const payload = JSON.parse(first.text);
    const call = payload.choices[0].message.tool_calls[0];
    assert.ok(call);

    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-tools', 'x-conversation-mode': 'server' },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '读取 package.json' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, name: 'read_file', content: '{"name":"duckai-cpa"}' }
        ],
        tools
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).choices[0].message.content, 'package.json 已读取。');
  });
});
