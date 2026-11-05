/**
 * v2.11 compact 后端（task-40）：自动/手动压缩、失败回退、ERR_CONVERSATION_LIMIT 重试、
 * `/v1` X-Session-Id summary 复用/重启保留、模型能力 API。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { withServer, adminRequest, makeConfig, readSSEResponse } from './helpers/test-server.js';
import { DuckError } from '../src/duck/index.js';

const SUMMARY_TEXT = '- 摘要：用户目标与已确认事实（mock）';

function compactConfig(overrides = {}) {
  return {
    context: {
      compact: {
        enabled: true,
        triggerChars: 1000,
        keepRecentMessages: 2,
        maxSummaryChars: 400,
        model: null,
        ...overrides
      }
    }
  };
}

function adminHeaders(env) {
  return { authorization: `Bearer ${env.adminToken}`, 'content-type': 'application/json' };
}

async function createSession(env, title = 'compact QA', model = null) {
  const res = await adminRequest(env.baseUrl, '/admin/api/test/sessions', { method: 'POST', body: { title, ...(model ? { model } : {}) } });
  assert.equal(res.status, 201, res.text);
  return res.json.session;
}

async function sendMessage(env, sessionId, content) {
  const res = await fetch(`${env.baseUrl}/admin/api/test/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: adminHeaders(env),
    body: JSON.stringify({ content })
  });
  const events = await readSSEResponse(res).catch(() => []);
  return { status: res.status, events };
}

function eventPayload(event) {
  if (!event) return null;
  if (event.json && typeof event.json === 'object') return event.json;
  if (typeof event.data === 'string') {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }
  return event.type ? event : null;
}

function doneEvent(events) {
  const found = [...events].reverse().map(eventPayload).find((payload) => payload && payload.type === 'done');
  return found || null;
}

async function getSession(env, sessionId) {
  const res = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(res.status, 200, res.text);
  return res.json.session;
}

async function v1Chat(env, { sessionKey, messages, stream = false, model = 'gpt-6-luna' }) {
  const res = await fetch(`${env.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      'content-type': 'application/json',
      ...(sessionKey ? { 'x-session-id': sessionKey } : {})
    },
    body: JSON.stringify({ model, messages, stream })
  });
  if (stream) {
    const events = await readSSEResponse(res).catch(() => []);
    return { status: res.status, events, json: null };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, events: [], json };
}

function lastChat(env) {
  const calls = env.duck.calls.chat;
  return calls[calls.length - 1]?.messages || [];
}

function chatText(env) {
  return JSON.stringify(lastChat(env));
}

/* ------------------------------------------------------------------ */
/* 自动压缩                                                            */
/* ------------------------------------------------------------------ */

test('未超 triggerChars 不压缩：无 summarize、done 无 compacted、历史完整发送', async () => {
  await withServer(
    { config: makeConfig(compactConfig({ triggerChars: 100000 })), duck: undefined },
    async (env) => {
      const session = await createSession(env);
      const { status, events } = await sendMessage(env, session.id, '你好，简单问题');
      assert.equal(status, 200);
      const done = doneEvent(events);
      assert.ok(done, '应有 done 事件');
      assert.ok(!done.compacted, '未超阈值不应 compacted');
      assert.equal(env.duck.calls.summarize.length, 0);
      assert.ok(!chatText(env).includes('[对话摘要]'));
    }
  );
});

test('超 triggerChars 自动压缩：done.compacted/summary、请求含摘要+最近消息、session.summary 持久化', async () => {
  await withServer({ config: makeConfig(compactConfig()) }, async (env) => {
    const session = await createSession(env, 'compact QA', 'gpt-5.4-mini');
    let done = null;
    for (let round = 0; round < 6; round += 1) {
      const result = await sendMessage(
        env,
        session.id,
        `第 ${round + 1} 轮：请记录订单 A-102 与客户回电安排。` + '背景信息与约束说明，需要保留关键数字和待办。'.repeat(21)
      );
      assert.equal(result.status, 200, `round ${round + 1} status`);
      done = doneEvent(result.events);
      assert.ok(done, `round ${round + 1} 应有 done`);
      if (done.compacted) break;
    }
    assert.ok(done?.compacted, '应触发自动压缩');
    assert.equal(done.summary?.text, SUMMARY_TEXT);
    assert.ok(done.summaryChars > 0);
    assert.ok(done.coveredMessageCount > 0);
    assert.ok(env.duck.calls.summarize.length >= 1, '应调用 summarizeMessages');
    assert.ok(chatText(env).includes('[对话摘要]'), '发往上游的 system 应含摘要块');
    assert.ok(chatText(env).includes(SUMMARY_TEXT), '摘要文本应进入上游请求');
    const latest = await getSession(env, session.id);
    assert.equal(latest.summary?.text, SUMMARY_TEXT, 'session.summary 应持久化');
    assert.ok(latest.summary.coveredMessageCount > 0);
    assert.equal(typeof latest.summary.updatedAt, 'number');
  });
});

test('摘要失败回退：请求仍成功、不标记 compacted、summary 不落库（warn）', async () => {
  await withServer({ config: makeConfig(compactConfig()) }, async (env) => {
    env.duck.summarizeBehavior = { error: new Error('summary upstream boom') };
    const session = await createSession(env);
    let sawCompacted = false;
    for (let round = 0; round < 5; round += 1) {
      const result = await sendMessage(
        env,
        session.id,
        `第 ${round + 1} 轮：长对话内容用于触发压缩（失败回退场景）。` + '更多背景与约束。'.repeat(8)
      );
      assert.equal(result.status, 200, `round ${round + 1} 应成功（回退裁剪）`);
      const done = doneEvent(result.events);
      if (done?.compacted) sawCompacted = true;
    }
    assert.equal(sawCompacted, false, '摘要失败不应标记 compacted');
    const sessionState = await getSession(env, session.id);
    assert.equal(sessionState.summary ?? null, null, '失败时不应持久化 summary');
  });
});

/* ------------------------------------------------------------------ */
/* 手动 compact                                                        */
/* ------------------------------------------------------------------ */

test('手动 compact：200 返回 summary 并持久化；重复幂等；404/400 错误码', async () => {
  await withServer({ config: makeConfig(compactConfig({ triggerChars: 100000 })) }, async (env) => {
    const session = await createSession(env);
    for (let round = 0; round < 4; round += 1) {
      await sendMessage(env, session.id, `第 ${round + 1} 轮内容：订单 A-102，周四回电。` + '约束与待办说明。'.repeat(8));
    }
    const first = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/compact`, {
      method: 'POST',
      body: {}
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.summary.text, SUMMARY_TEXT);
    assert.ok(first.json.summaryChars > 0);
    assert.ok(first.json.coveredMessageCount > 0);
    assert.equal(first.json.session.summary.text, SUMMARY_TEXT);

    const stored = await getSession(env, session.id);
    assert.equal(stored.summary.text, SUMMARY_TEXT);

    const second = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/compact`, {
      method: 'POST',
      body: {}
    });
    assert.equal(second.status, 200, '重复 compact 不应报错');
    assert.ok(second.json.summary.text.length > 0);

    const missing = await adminRequest(env.baseUrl, '/admin/api/test/sessions/sess_missing/compact', {
      method: 'POST',
      body: {}
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'session_not_found');

    const empty = await createSession(env, 'empty');
    const nothing = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(empty.id)}/compact`, {
      method: 'POST',
      body: {}
    });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.json.error.code, 'nothing_to_compact');
  });
});

test('ERR_CONVERSATION_LIMIT：v2.21 不再自动压缩/重试，返回 409 + 客户端压缩提示', async () => {
  await withServer({ config: makeConfig(compactConfig({ triggerChars: 100000 })) }, async (env) => {
    const session = await createSession(env);
    for (let round = 0; round < 4; round += 1) {
      await sendMessage(env, session.id, `第 ${round + 1} 轮：建立长历史，用于 limit 重试。` + '长历史内容填充。'.repeat(8));
    }
    env.duck.enqueueChat({
      error: new DuckError('conversation limit reached', {
        status: 409,
        type: 'conversation_limit',
        code: 'conversation_limit_reached',
        retriable: false
      })
    });
    const beforeSummaries = env.duck.calls.summarize.length;
    const beforeChats = env.duck.calls.chat.length;
    const res = await fetch(`${env.baseUrl}/admin/api/test/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: adminHeaders(env),
      body: JSON.stringify({ content: '继续：触发上游 limit 后不再自动压缩。' })
    });
    const text = await res.text();
    assert.equal(res.status, 409, `会话上限应原样返回 409（实际 ${res.status}）：${text.slice(0, 200)}`);
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    assert.equal(payload?.error?.code, 'conversation_limit_reached');
    assert.match(String(payload?.error?.hint || ''), /\/v1\/compact/, '409 应提示客户端主动压缩');
    assert.equal(env.duck.calls.summarize.length, beforeSummaries, '不应自动调用摘要');
    assert.equal(env.duck.calls.chat.length, beforeChats + 1, '不应自动重试上游');
  });
});

/* ------------------------------------------------------------------ */
/* /v1 X-Session-Id + 重启保留                                          */
/* ------------------------------------------------------------------ */

test('/v1 X-Session-Id：自动压缩、summary 复用、重启后保留', async () => {
  const dataDir = path.join(process.cwd(), 'data', 'tmp', `qa-compact-${crypto.randomBytes(4).toString('hex')}`);
  const v1Model = 'gpt-5.4-mini';
  const messages = [];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${index + 1} 条历史内容：订单 A-102 与客户回电，长度足够触发压缩。` + '背景信息与约束说明。'.repeat(12)
    });
  }
  const sessionKey = 'sess_qa_compact_1';
  try {
    await withServer(
      { config: makeConfig(compactConfig()), dataDir, cleanup: false },
      async (env) => {
        const first = await v1Chat(env, { sessionKey, messages, model: v1Model });
        assert.equal(first.status, 200, JSON.stringify(first.json));
        assert.equal(first.json.compacted, true, '首次请求应自动压缩');
        assert.equal(first.json.summary?.text, SUMMARY_TEXT);
        assert.ok(first.json.summary_chars > 0);
        assert.ok(chatText(env).includes('[对话摘要]'));

        // 第二次：短消息（低于阈值）应复用 summary
        const before = env.duck.calls.chat.length;
        // v2.59 authoritative session：同 session 只发最新 user（delta），不发无前缀短历史。
        const second = await v1Chat(env, {
          sessionKey,
          model: v1Model,
          messages: [{ role: 'user', content: '继续：简短追问。' }]
        });
        assert.equal(second.status, 200);
        assert.equal(env.duck.calls.chat.length, before + 1);
        assert.ok(chatText(env).includes(SUMMARY_TEXT), '第二次请求应复用 summary');
        assert.equal(second.json.compacted, true, '复用 summary 也应标记 compacted');
      }
    );

    // 重启：同 dataDir 新 server
    await withServer(
      { config: makeConfig(compactConfig()), dataDir, cleanup: false },
      async (env) => {
        const restarted = await v1Chat(env, {
          sessionKey,
          model: v1Model,
          messages: [{ role: 'user', content: '重启后继续。' }]
        });
        assert.equal(restarted.status, 200);
        assert.ok(chatText(env).includes(SUMMARY_TEXT), '重启后应从 SQLite 恢复 summary');
        // v2.40：不再生成 chat-summaries.json（持久化在 data/duckai.db 的 chat_summaries 表）
        const legacyFile = await fs.readFile(path.join(dataDir, 'chat-summaries.json'), 'utf8').catch(() => '');
        assert.equal(legacyFile, '', '不应再生成 chat-summaries.json');
      }
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* 模型能力 API                                                        */
/* ------------------------------------------------------------------ */

test('模型能力：/v1/models 与 /admin/api/models 均含 context/capabilities 字段', async () => {
  await withServer({}, async (env) => {
    const v1 = await fetch(`${env.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${env.apiKey}` } });
    assert.equal(v1.status, 200);
    const v1Json = await v1.json();
    const v1Luna = v1Json.data.find((model) => model.id === 'gpt-6-luna');
    assert.ok(v1Luna, '应含 gpt-6-luna');
    assert.equal(v1Luna.context_window_chars, 20000);
    assert.equal(v1Luna.max_input_chars, 19500);
    assert.equal(v1Luna.max_input_tokens, Math.floor(19500 / 3));
    assert.equal(v1Luna.max_output_tokens, 4096);
    assert.equal(typeof v1Luna.max_output_tokens_estimated, 'boolean');
    assert.equal(v1Luna.capabilities.webSearch, true);
    assert.equal(v1Luna.capabilities.imageGeneration, true);
    assert.equal(v1Luna.capabilities.tier, 'free');

    const admin = await adminRequest(env.baseUrl, '/admin/api/models');
    assert.equal(admin.status, 200);
    const adminLuna = (admin.json.items || []).find((model) => model.id === 'gpt-6-luna');
    assert.ok(adminLuna);
    assert.equal(adminLuna.context_window_chars, 20000);
    assert.equal(adminLuna.max_input_tokens, Math.floor(19500 / 3));
    assert.equal(adminLuna.capabilities.webSearch, true);
  });
});
