/**
 * task-79/task-80：网关 authoritative session（canonical + client diff + append）。
 *
 * BREAK：客户端只提供 session id + 新输入；网关维护 canonical，旧历史只用于 diff。
 * - chat：full replay 只 append 新 user；只发最新 user 也 append；assistant 写回 canonical。
 * - responses：同 session delta/full + previous_response_id append，不重复。
 * - 冲突 → 409 `session_history_mismatch`；显式 fork/epoch 可重建。
 * - history 来自 canonical，不丢旧消息/图片/工具；普通轮次 upstream 前缀稳定。
 * - 旧 conversation_state（无 client_json）初始化不炸。
 * 全程 mock DuckClient，不访问真实 duck.ai。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startTestServer, v1Request, adminRequest, makeConfig } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { createResponseStore } from '../src/openai/responses-store.js';
import { createHistoryStore } from '../src/history.js';
import { createNullLogger } from '../src/logger.js';
import { openDatabase } from '../src/db.js';

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-auth-session-'));
  const logger = createNullLogger();
  const config = makeConfig();
  const responsesStore = await createResponseStore({ dataDir, config, logger });
  const history = await createHistoryStore({ dataDir, config, logger });
  const duck = new MockDuckClient();
  const server = await startTestServer({ config, dataDir, duck, responsesStore, history, logger, cleanup: false });
  return {
    ...server,
    duck,
    responsesStore,
    history,
    logger,
    dataDir,
    async cleanup() {
      await server.close?.();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function chatMessages(messages) {
  return (messages || []).map((message) => ({ role: message.role, content: message.content, tool_calls: message.tool_calls }));
}

function upstreamText(messages) {
  return JSON.stringify(messages);
}

async function chatTurn(env, sessionKey, body, headers = {}) {
  return v1Request(env.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-session-id': sessionKey, ...headers },
    body: { model: 'gpt-6-luna', ...body }
  });
}

/* ------------------------------------------------------------------ */
/* 1) chat：首轮 full + 第二轮 full replay → 只 append 新 user          */
/* ------------------------------------------------------------------ */

test('chat full replay：第二轮只 append 新 user，前缀逐字节稳定，assistant 写回 canonical', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-chat-full';
  try {
    env.duck.enqueueChat({ textDeltas: ['第一轮回答'] });
    env.duck.enqueueChat({ textDeltas: ['第二轮回答'] });
    const first = await chatTurn(env, sessionKey, { messages: [{ role: 'user', content: '第一轮问题' }] });
    assert.equal(first.status, 200, first.text);
    const assistant1 = first.json.choices[0].message.content;
    assert.equal(first.headers.get('x-session-id'), sessionKey);
    assert.ok(first.headers.get('x-session-epoch') != null, '应回写 X-Session-Epoch');
    const turn1 = env.duck.calls.chat[0].params.messages;

    const second = await chatTurn(env, sessionKey, {
      messages: [
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: assistant1 },
        { role: 'user', content: '第二轮问题' }
      ]
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.choices[0].message.content, '第二轮回答');
    const turn2 = env.duck.calls.chat.at(-1).params.messages;
    assert.deepEqual(turn2.slice(0, turn1.length), turn1, '第二轮 upstream 前缀应逐字节稳定');
    assert.equal(turn2[turn1.length].role, 'assistant');
    assert.equal(turn2[turn1.length].content, assistant1, '应追加第一轮 assistant');
    assert.equal(turn2.at(-1).content, '第二轮问题');

    const state = await env.responsesStore.getConversation(sessionKey);
    const canonical = state.canonical || [];
    const users = canonical.filter((message) => message.role === 'user').map((message) => message.content);
    assert.deepEqual(users, ['第一轮问题', '第二轮问题'], 'canonical 不应重复第一轮 user');
    assert.ok(canonical.some((message) => message.role === 'assistant' && message.content === '第一轮回答'));
    assert.ok(canonical.some((message) => message.role === 'assistant' && message.content === '第二轮回答'));
    assert.ok(Array.isArray(state.client) && state.client.length >= 3, '应保存 client_json');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2) chat：第二轮只发最新 user → append                                */
/* ------------------------------------------------------------------ */

test('chat delta：只发最新 user 也能 append 到 canonical，不重建旧消息', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-chat-delta';
  try {
    env.duck.enqueueChat({ textDeltas: ['回答一'] });
    env.duck.enqueueChat({ textDeltas: ['回答二'] });
    const first = await chatTurn(env, sessionKey, { messages: [{ role: 'user', content: '问题一' }] });
    assert.equal(first.status, 200, first.text);
    const second = await chatTurn(env, sessionKey, { messages: [{ role: 'user', content: '问题二' }] });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.choices[0].message.content, '回答二');
    const messages = env.duck.calls.chat.at(-1).params.messages;
    const text = upstreamText(messages);
    assert.ok(text.includes('问题一') && text.includes('回答一'), '上游应保留第一轮');
    assert.ok(text.includes('问题二'), '上游应包含新 user');
    const state = await env.responsesStore.getConversation(sessionKey);
    const users = (state.canonical || []).filter((message) => message.role === 'user').map((message) => message.content);
    assert.deepEqual(users, ['问题一', '问题二'], 'canonical 不应因 delta 丢失/重复旧消息');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3) responses：同 session delta/full + previous_response_id           */
/* ------------------------------------------------------------------ */

test('responses previous_response_id + 同 session：delta 只 append 新 input', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-resp-chain';
  try {
    env.duck.enqueueChat({ textDeltas: ['第一轮回答'] });
    env.duck.enqueueChat({ textDeltas: ['第二轮回答'] });
    env.duck.enqueueChat({ textDeltas: ['第三轮回答'] });
    const first = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: '第一轮问题' }
    });
    assert.equal(first.status, 200, first.text);
    const firstPayload = JSON.parse(first.text);
    const turn1 = env.duck.calls.chat[0].params.messages;

    const second = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', previous_response_id: firstPayload.id, input: '第二轮问题' }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).output_text, '第二轮回答');
    const turn2 = env.duck.calls.chat.at(-1).params.messages;
    assert.deepEqual(turn2.slice(0, turn1.length), turn1, 'responses 第二轮前缀应稳定');
    assert.ok(upstreamText(turn2).includes('第二轮问题'));

    // 第三轮 full replay（同 session，不带 previous id）也不重复
    const secondPayload = JSON.parse(second.text);
    const third = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '第一轮问题' },
          { role: 'assistant', content: '第一轮回答' },
          { role: 'user', content: '第二轮问题' },
          { role: 'assistant', content: '第二轮回答' },
          { role: 'user', content: '第三轮问题' }
        ]
      }
    });
    assert.equal(third.status, 200, third.text);
    const state = await env.responsesStore.getConversation(sessionKey);
    const users = (state.canonical || []).filter((message) => message.role === 'user').map((message) => message.content);
    assert.deepEqual(users, ['第一轮问题', '第二轮问题', '第三轮问题'], 'canonical 不应重复旧 user');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 4) 冲突 → 409 session_history_mismatch；显式 fork 可重建             */
/* ------------------------------------------------------------------ */

test('session 冲突：不匹配历史 → 409 session_history_mismatch；fork/epoch 可重建', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-conflict';
  try {
    env.duck.enqueueChat({ textDeltas: ['原始回答'] });
    env.duck.enqueueChat({ textDeltas: ['冲突后回答'] });
    env.duck.enqueueChat({ textDeltas: ['fork 后回答'] });
    const first = await chatTurn(env, sessionKey, { messages: [{ role: 'user', content: '原始问题' }] });
    assert.equal(first.status, 200, first.text);

    const conflict = await chatTurn(env, sessionKey, {
      messages: [
        { role: 'user', content: '完全不同的历史' },
        { role: 'assistant', content: '不同回答' },
        { role: 'user', content: '新问题' }
      ]
    });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.json.error.code, 'session_history_mismatch');

    // 显式 fork：新的 epoch 允许重建
    const fork = await chatTurn(env, sessionKey, {
      messages: [{ role: 'user', content: 'fork 新会话问题' }]
    }, { 'x-session-fork': 'true' });
    assert.equal(fork.status, 200, fork.text);
    assert.ok(Number(fork.headers.get('x-session-epoch')) >= 1, 'fork 后 epoch 应递增');
    const state = await env.responsesStore.getConversation(sessionKey);
    const users = (state.canonical || []).filter((message) => message.role === 'user').map((message) => message.content);
    assert.deepEqual(users, ['fork 新会话问题'], 'fork 后 canonical 应重建');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 5) history 来自 canonical：旧消息/图片不丢，v2.58 占位恢复仍工作      */
/* ------------------------------------------------------------------ */

test('history canonical：旧消息/图片不丢，跨轮占位图片仍可恢复', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-history';
  try {
    env.duck.enqueueChat({ textDeltas: [], images: [{ b64: PNG_1X1_B64, format: 'png' }] });
    env.duck.enqueueChat({ textDeltas: ['已结合图片回答'] });
    const first = await chatTurn(env, sessionKey, {
      messages: [{ role: 'user', content: '画一张图' }],
      tools: [{ type: 'image_generation' }]
    });
    assert.equal(first.status, 200, first.text);

    // 第二轮只回占位文本 → 从 canonical 恢复图片，且旧 user/assistant 不丢
    const second = await chatTurn(env, sessionKey, {
      messages: [{ role: 'user', content: '已生成 1 张图片（base64 位于 image_generation_call.result 字段）。继续说明图片' }]
    });
    assert.equal(second.status, 200, second.text);
    const upstream = env.duck.calls.chat.at(-1).params.messages;
    assert.ok(upstreamText(upstream).includes('画一张图'), '上游应保留第一轮 user');
    const imageMessage = upstream.find((message) => Array.isArray(message.images) && message.images.length);
    assert.ok(imageMessage, '上游应恢复真实图片');
    assert.equal(imageMessage.images[0].b64, PNG_1X1_B64);

    const historyList = await adminRequest(env.baseUrl, '/admin/api/history');
    const item = (historyList.json.groups || []).flatMap((group) => group.items).find((entry) => entry.sessionKey === sessionKey);
    assert.ok(item, 'history 应包含会话');
    const detail = await adminRequest(env.baseUrl, `/admin/api/history/${item.id}`);
    const images = (detail.json.item.messages || []).flatMap((message) => (Array.isArray(message.images) ? message.images : []));
    assert.ok(images.some((image) => image.b64 === PNG_1X1_B64), 'history 应保留图片');
    const contents = (detail.json.item.messages || []).map((message) => String(message.content || '')).join('\n');
    assert.ok(contents.includes('画一张图'), 'history 应保留旧 user');
    assert.ok(contents.includes('已结合图片回答'), 'history 应保留旧 assistant');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 6) 旧 conversation_state（无 client_json）初始化不炸                   */
/* ------------------------------------------------------------------ */

test('旧 state 无 client_json：请求同 session 不炸，canonical 以旧内容初始化', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-auth-legacy';
  try {
    const db = await openDatabase({ dataDir: env.dataDir, logger: env.logger });
    const oldCanonical = [
      { role: 'user', content: '旧 user 内容' },
      { role: 'assistant', content: '旧 assistant 内容' }
    ];
    db.db
      .prepare(
        `INSERT INTO conversation_state(session_key, model, mode, system_prompt, canonical_json, upstream_json, tools_hash, compression_json, context_pdf_scope, compacted_at, images_json, client_json, client_hash, epoch, first_user_hash, updated_at, expires_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionKey,
        'gpt-6-luna',
        'auto',
        null,
        JSON.stringify(oldCanonical),
        JSON.stringify(oldCanonical.map((message) => ({ role: message.role, content: message.content }))),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        Date.now(),
        null
      );

    env.duck.enqueueChat({ textDeltas: ['新回答'] });
    const res = await chatTurn(env, sessionKey, { messages: [{ role: 'user', content: '新问题' }] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.choices[0].message.content, '新回答');
    const state = await env.responsesStore.getConversation(sessionKey);
    assert.ok((state.canonical || []).some((message) => message.content === '旧 user 内容'), '旧 canonical 应保留');
    assert.ok((state.canonical || []).some((message) => message.content === '新问题'), '新 user 应 append');
  } finally {
    await env.cleanup();
  }
});
