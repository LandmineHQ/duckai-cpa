/**
 * v2 会话式连接测试（docs/ADMIN_API_V2.md §5）。
 *
 * 覆盖：
 *   - sessions CRUD（列表/创建/详情/更新/删除，自动标题）；
 *   - 连续 3 轮消息：服务端按 session.messages 拼接历史传给 DuckClient；
 *   - SSE 事件：session/delta/reasoning/search/image/done（error 场景单独用例）；
 *   - 刷新/重启后持久化（data/testsessions.json）；
 *   - 上限（100 会话淘汰最旧、每会话 200 条消息）；
 *   - 旧 POST /admin/api/test 已 404（BREAKING）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  startTestServer,
  withServer,
  request,
  adminRequest,
  adminHeaders,
  collectSSE,
  decodeImageBase64,
  isPNG
} from './helpers/test-server.js';
import { MockDuckClient, DEFAULT_SOURCES, PNG_1X1_B64 } from './helpers/mock-duck.js';

/** 把 gateway 传给 DuckClient 的 messages 归一化为 `role:text` 便于断言。 */
function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (part && typeof part === 'object' ? part.text || '' : String(part || '')))
        .join('');
    }
    return `${message.role}:${text}`;
  });
}

function jsonEvents(events) {
  return events.filter((event) => event.json).map((event) => event.json);
}

async function createSession(baseUrl, patch = {}) {
  const res = await adminRequest(baseUrl, '/admin/api/test/sessions', { method: 'POST', body: patch });
  return res;
}

async function postMessage(baseUrl, sessionId, body) {
  return collectSSE(baseUrl, `/admin/api/test/sessions/${sessionId}/messages`, {
    headers: adminHeaders(),
    body,
    timeoutMs: 30000
  });
}

test('sessions CRUD：创建(201)→列表→详情→PATCH→删除', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {
      title: '我的会话',
      model: 'gpt-6-luna',
      reasoningEffort: 'low',
      webSearch: true,
      imageGeneration: false
    });
    assert.equal(created.status, 201);
    const session = created.json.session;
    assert.match(session.id, /^sess_/);
    assert.equal(session.title, '我的会话');
    assert.equal(session.model, 'gpt-6-luna');
    assert.equal(session.reasoningEffort, 'low');
    assert.equal(session.webSearch, true);
    assert.equal(session.imageGeneration, false);
    assert.equal(typeof session.createdAt, 'number');
    assert.equal(typeof session.updatedAt, 'number');

    const list = await adminRequest(baseUrl, '/admin/api/test/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    const item = list.json.items[0];
    assert.equal(item.id, session.id);
    assert.equal(item.title, '我的会话');
    assert.equal(item.messageCount, 0);

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${session.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.session.id, session.id);
    assert.deepEqual(detail.json.messages, []);

    const patched = await adminRequest(baseUrl, `/admin/api/test/sessions/${session.id}`, {
      method: 'PATCH',
      body: { title: '改名', model: 'gpt-5.4-mini', webSearch: false }
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.session.title, '改名');
    assert.equal(patched.json.session.model, 'gpt-5.4-mini');
    assert.equal(patched.json.session.webSearch, false);

    const deleted = await adminRequest(baseUrl, `/admin/api/test/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.ok, true);

    const after = await adminRequest(baseUrl, `/admin/api/test/sessions/${session.id}`);
    assert.equal(after.status, 404);
    const listAfter = await adminRequest(baseUrl, '/admin/api/test/sessions');
    assert.deepEqual(listAfter.json.items, []);
  });
});

test('连续 3 轮：服务端拼接历史 + SSE session/delta/done + 持久化到 session', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['回答', '一'] });
  duck.enqueueChat({ textDeltas: ['回答二'] });
  duck.enqueueChat({ textDeltas: ['回答三'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, { model: 'gpt-6-luna' });
    assert.equal(created.status, 201);
    const sessionId = created.json.session.id;

    const rounds = ['第一轮', '第二轮', '第三轮'];
    for (let index = 0; index < rounds.length; index += 1) {
      const { response, events } = await postMessage(baseUrl, sessionId, { content: rounds[index] });
      assert.equal(response.status, 200);
      assert.match(String(response.headers.get('content-type')), /text\/event-stream/);

      const payloads = jsonEvents(events);
      const first = payloads[0];
      assert.equal(first.type, 'session');
      assert.equal(first.sessionId, sessionId);
      assert.match(first.userMessageId, /^msg_/);
      assert.match(first.assistantMessageId, /^msg_/);

      const deltaText = payloads
        .filter((payload) => payload.type === 'delta')
        .map((payload) => payload.text)
        .join('');
      assert.ok(deltaText.length > 0, 'delta events must carry text');

      const done = payloads.find((payload) => payload.type === 'done');
      assert.ok(done, 'missing done event');
      assert.equal(done.message.id, first.assistantMessageId);
      assert.equal(done.message.role, 'assistant');
      assert.equal(done.message.content, deltaText);
      assert.equal(done.message.model, 'gpt-6-luna');
      assert.equal(typeof done.latencyMs, 'number');
      assert.equal(typeof done.queueWaitMs, 'number');
      assert.ok(!payloads.some((payload) => payload.type === 'error'));
    }

    // 服务端拼接历史：第 1/2/3 轮传给 DuckClient 的 messages 逐轮递增
    assert.equal(duck.calls.chat.length, 3);
    assert.deepEqual(normalizeMessages(duck.calls.chat[0].messages), ['user:第一轮']);
    assert.deepEqual(normalizeMessages(duck.calls.chat[1].messages), ['user:第一轮', 'assistant:回答一', 'user:第二轮']);
    assert.deepEqual(normalizeMessages(duck.calls.chat[2].messages), [
      'user:第一轮',
      'assistant:回答一',
      'user:第二轮',
      'assistant:回答二',
      'user:第三轮'
    ]);

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.messages.length, 6);
    assert.deepEqual(
      detail.json.messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    );
    for (const message of detail.json.messages.filter((entry) => entry.role === 'assistant')) {
      assert.match(message.id, /^msg_/);
      assert.equal(typeof message.content, 'string');
      assert.equal(typeof message.ts, 'number');
      assert.equal(message.finishReason, 'stop');
      assert.ok(Array.isArray(message.sources));
      assert.ok(Array.isArray(message.images));
    }
    // 列表 messageCount 同步
    const list = await adminRequest(baseUrl, '/admin/api/test/sessions');
    assert.equal(list.json.items[0].messageCount, 6);
  });
});

test('SSE 富事件：reasoning/search/image 在 done 之前且写入 assistant 消息', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    textDeltas: ['答案'],
    reasoningDeltas: ['思考', '过程'],
    sources: DEFAULT_SOURCES,
    images: [{ b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024 }]
  });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, { reasoningEffort: 'low', webSearch: true, imageGeneration: true });
    const sessionId = created.json.session.id;

    const { events } = await postMessage(baseUrl, sessionId, { content: '查询并画图' });
    const payloads = jsonEvents(events);
    const types = payloads.map((payload) => payload.type);
    assert.equal(types[0], 'session');
    assert.ok(types.includes('reasoning'));
    assert.ok(types.includes('search'));
    assert.ok(types.includes('image'));
    assert.ok(types.includes('delta'));
    assert.equal(types.at(-1), 'done');

    const reasoningText = payloads
      .filter((payload) => payload.type === 'reasoning')
      .map((payload) => payload.text)
      .join('');
    assert.equal(reasoningText, '思考过程');

    const searchEvent = payloads.find((payload) => payload.type === 'search');
    assert.equal(searchEvent.results.length, 2);
    assert.equal(searchEvent.results[0].url, DEFAULT_SOURCES[0].url);

    const imageEvent = payloads.find((payload) => payload.type === 'image');
    assert.equal(imageEvent.format, 'png');
    assert.ok(isPNG(decodeImageBase64(imageEvent.b64)));

    const done = payloads.at(-1);
    assert.equal(done.message.reasoning, '思考过程');
    assert.equal(done.message.sources.length, 2);
    assert.equal(done.message.images.length, 1);
    assert.ok(isPNG(decodeImageBase64(done.message.images[0].b64)));
  });
});

test('自动标题：未传 title 时取首条用户消息前 30 字符', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['好'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;
    const content = '这是第一条用户消息，应该被用作会话标题的前三十个字符用于自动命名测试';
    await postMessage(baseUrl, sessionId, { content });

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.json.session.title, content.slice(0, 30));
  });
});

test('上游失败（首事件前）→ HTTP JSON 错误 + 会话记录错误 assistant 消息', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    error: Object.assign(new Error('rate limited by upstream'), {
      name: 'DuckError',
      status: 429,
      type: 'ERR_RATE_LIMIT',
      retriable: true
    })
  });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;

    const res = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { content: '会失败的消息' }
    });
    assert.equal(res.status, 429, 'pre-stream failure must be a JSON error, not HTTP 200 SSE');
    assert.equal(res.json.error.code, 'rate_limit_exceeded');

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.messages.length, 2, 'user message + failed assistant message should be persisted');
    const assistant = detail.json.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.finishReason, 'error');
    assert.ok(assistant.error, 'assistant message must record error');
  });
});

test('SSE error（已开始流式后失败）→ error 事件 + 无 done，会话记录错误 assistant 消息', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    textDeltas: ['部分'],
    errorAfterText: Object.assign(new Error('stream broke mid-way'), {
      name: 'DuckError',
      status: 429,
      type: 'ERR_RATE_LIMIT',
      retriable: true
    })
  });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;

    const { response, events } = await postMessage(baseUrl, sessionId, { content: '会中途失败的消息' });
    assert.equal(response.status, 200);
    const payloads = jsonEvents(events);
    const types = payloads.map((payload) => payload.type);
    assert.ok(types.includes('error'), 'missing error event');
    assert.ok(!types.includes('done'), 'must not emit done after error');

    const error = payloads.find((payload) => payload.type === 'error');
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limit_exceeded');
    assert.ok(error.message.length > 0);

    const detail = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.messages.length, 2);
    const assistant = detail.json.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.finishReason, 'error');
    assert.ok(assistant.error, 'assistant message must record error');
  });
});

test('持久化：重启服务后会话与消息仍在（SQLite test_sessions）', async () => {
  const dataDir = path.join(os.tmpdir(), `duckai-qa-sessions-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['持久化回答'] });

  const first = await startTestServer({ duck, dataDir, cleanup: false });
  let sessionId;
  try {
    const created = await createSession(first.baseUrl, { title: '持久化会话' });
    sessionId = created.json.session.id;
    await postMessage(first.baseUrl, sessionId, { content: '你好' });
    // v2.40：持久化到 SQLite（test_sessions 表），等待 debounce 写入
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    await first.close();
  }
  // 不再生成 testsessions.json
  const legacyFile = await fs.readFile(path.join(dataDir, 'testsessions.json'), 'utf8').catch(() => '');
  assert.equal(legacyFile, '', '不应再生成 testsessions.json');

  const second = await startTestServer({ duck: new MockDuckClient(), dataDir, cleanup: true });
  try {
    const list = await adminRequest(second.baseUrl, '/admin/api/test/sessions');
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.items[0].id, sessionId);
    assert.equal(list.json.items[0].messageCount, 2);

    const detail = await adminRequest(second.baseUrl, `/admin/api/test/sessions/${sessionId}`);
    assert.equal(detail.json.messages.length, 2);
    assert.equal(detail.json.messages[0].content, '你好');
    assert.equal(detail.json.messages[1].content, '持久化回答');
  } finally {
    await second.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('上限：最多 100 个会话（超出淘汰最旧）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    let firstId = null;
    for (let index = 0; index < 101; index += 1) {
      const res = await createSession(baseUrl, { title: `s${index}` });
      assert.equal(res.status, 201);
      if (index === 0) firstId = res.json.session.id;
    }
    const list = await adminRequest(baseUrl, '/admin/api/test/sessions');
    assert.equal(list.json.items.length, 100);
    assert.ok(!list.json.items.some((item) => item.id === firstId), 'oldest session should be evicted');
    assert.ok(list.json.items.some((item) => item.title === 's100'), 'newest session should exist');
  });
});

test('上限：每会话最多 200 条消息（sessions store 层面拒绝第 201 条）', async () => {
  const dataDir = path.join(os.tmpdir(), `duckai-qa-msglimit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { createSessionsStore } = await import('../src/admin/sessions.js');
  let sessions;
  try {
    sessions = createSessionsStore({ dataDir, config: {} });
    await sessions.init?.();
    const session = await sessions.createSession({ title: 'limit' });
    for (let index = 0; index < 200; index += 1) {
      await sessions.appendMessage(session.id, {
        id: `msg_${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: String(index)
      });
    }
    // 第 201 条被拒绝（400 session_message_limit，不静默丢弃）
    await assert.rejects(
      sessions.appendMessage(session.id, { id: 'msg_200', role: 'user', content: '201' }),
      (error) => {
        assert.equal(error.code, 'session_message_limit');
        assert.equal(error.status, 400);
        return true;
      }
    );
    const loaded = await sessions.getSession(session.id);
    assert.equal(loaded.messages.length, 200);
    await sessions.flush?.();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('旧 POST /admin/api/test 已删除 → 404 not_found（BREAKING）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/admin/api/test', {
      method: 'POST',
      body: { prompt: 'hi', stream: true }
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'not_found');
    assert.equal(res.json.error.type, 'invalid_request_error');
    assert.equal(duck.calls.chat.length, 0);
  });
});

/* ================================================================== */
/* v2.1：重新生成（retry）+ reasoningEncrypted                         */
/* ================================================================== */

async function retryMessage(baseUrl, sessionId, messageId, body = {}) {
  return collectSSE(baseUrl, `/admin/api/test/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}/retry`, {
    headers: adminHeaders(),
    body,
    timeoutMs: 30000
  });
}

async function sessionMessages(baseUrl, sessionId) {
  const res = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}`);
  assert.equal(res.status, 200, `session detail HTTP ${res.status}`);
  return res.json.messages;
}

/** 发一条消息并返回 { sessionEvent, done }。 */
async function sendRound(baseUrl, sessionId, content) {
  const { events } = await postMessage(baseUrl, sessionId, { content });
  const payloads = jsonEvents(events);
  return {
    sessionEvent: payloads.find((payload) => payload.type === 'session'),
    done: payloads.find((payload) => payload.type === 'done'),
    payloads
  };
}

test('v2.1 retry：重试最后一轮成功（SSE retryOf / done.retriedFrom / 消息替换）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['第一版'] });
  duck.enqueueChat({ textDeltas: ['第二版'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, { model: 'gpt-6-luna' });
    const sessionId = created.json.session.id;
    const round = await sendRound(baseUrl, sessionId, '你好');
    const assistantId = round.sessionEvent.assistantMessageId;

    const before = await sessionMessages(baseUrl, sessionId);
    assert.equal(before.length, 2);
    assert.equal(before[1].id, assistantId);

    const { response, events } = await retryMessage(baseUrl, sessionId, assistantId);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const payloads = jsonEvents(events);
    const sessionEvent = payloads.find((payload) => payload.type === 'session');
    assert.ok(sessionEvent, 'missing session event');
    assert.equal(sessionEvent.retryOf, assistantId);
    assert.equal(sessionEvent.sessionId, sessionId);

    const done = payloads.find((payload) => payload.type === 'done');
    assert.ok(done, 'missing done event');
    assert.equal(done.message.content, '第二版');
    assert.equal(done.message.retriedFrom, assistantId);
    assert.notEqual(done.message.id, assistantId);

    const after = await sessionMessages(baseUrl, sessionId);
    assert.equal(after.length, 2, 'retry last turn replaces the assistant message');
    assert.equal(after[0].role, 'user');
    assert.equal(after[1].id, done.message.id);
    assert.equal(after[1].content, '第二版');
  });
});

test('v2.1 retry：重试中间轮 → 截断该 assistant 及其后所有消息', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  duck.enqueueChat({ textDeltas: ['A2'] });
  duck.enqueueChat({ textDeltas: ['A3'] });
  duck.enqueueChat({ textDeltas: ['A2-new'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, { model: 'gpt-6-luna' });
    const sessionId = created.json.session.id;
    const u1 = await sendRound(baseUrl, sessionId, '第一轮');
    const u2 = await sendRound(baseUrl, sessionId, '第二轮');
    await sendRound(baseUrl, sessionId, '第三轮');

    const full = await sessionMessages(baseUrl, sessionId);
    assert.equal(full.length, 6);
    assert.deepEqual(
      normalizeMessages(full.map((message) => ({ role: message.role, content: message.content }))),
      ['user:第一轮', 'assistant:A1', 'user:第二轮', 'assistant:A2', 'user:第三轮', 'assistant:A3']
    );

    const targetAssistant = u2.sessionEvent.assistantMessageId; // a2
    const { events } = await retryMessage(baseUrl, sessionId, targetAssistant);
    const payloads = jsonEvents(events);
    const sessionEvent = payloads.find((payload) => payload.type === 'session');
    assert.equal(sessionEvent.retryOf, targetAssistant);
    const done = payloads.find((payload) => payload.type === 'done');
    assert.equal(done.message.content, 'A2-new');
    assert.equal(done.message.retriedFrom, targetAssistant);

    const truncated = await sessionMessages(baseUrl, sessionId);
    assert.deepEqual(
      normalizeMessages(truncated.map((message) => ({ role: message.role, content: message.content }))),
      ['user:第一轮', 'assistant:A1', 'user:第二轮', 'assistant:A2-new'],
      'messages after the retried turn must be dropped'
    );
    // 截断后重试时传给上游的历史只到目标轮 user 消息
    assert.deepEqual(normalizeMessages(duck.calls.chat[3].messages), [
      'user:第一轮',
      'assistant:A1',
      'user:第二轮'
    ]);

    // 重试第一轮（最早的 assistant）：只剩 user1 + 新 assistant
    duck.enqueueChat({ textDeltas: ['A1-new'] });
    const a1 = u1.sessionEvent.assistantMessageId;
    const { events: events2 } = await retryMessage(baseUrl, sessionId, a1);
    assert.ok(jsonEvents(events2).some((payload) => payload.retryOf === a1));
    const onlyFirst = await sessionMessages(baseUrl, sessionId);
    assert.deepEqual(
      normalizeMessages(onlyFirst.map((message) => ({ role: message.role, content: message.content }))),
      ['user:第一轮', 'assistant:A1-new']
    );
    assert.deepEqual(normalizeMessages(duck.calls.chat[4].messages), ['user:第一轮']);
  });
});

test('v2.1 retry：重试 429 错误 assistant 成功，清理 error 状态', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    error: Object.assign(new Error('rate limited'), {
      name: 'DuckError',
      status: 429,
      type: 'ERR_RATE_LIMIT',
      retriable: true
    })
  });
  duck.enqueueChat({ textDeltas: ['重试成功'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, { model: 'gpt-6-luna' });
    const sessionId = created.json.session.id;

    const first = await adminRequest(baseUrl, `/admin/api/test/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { content: '会失败的消息' }
    });
    assert.equal(first.status, 429);
    const failedMessages = await sessionMessages(baseUrl, sessionId);
    assert.equal(failedMessages.length, 2);
    assert.equal(failedMessages[1].role, 'assistant');
    assert.equal(failedMessages[1].finishReason, 'error');
    assert.ok(failedMessages[1].error);
    const errorAssistantId = failedMessages[1].id;

    const { events } = await retryMessage(baseUrl, sessionId, errorAssistantId);
    const payloads = jsonEvents(events);
    const sessionEvent = payloads.find((payload) => payload.type === 'session');
    assert.equal(sessionEvent.retryOf, errorAssistantId);
    const done = payloads.find((payload) => payload.type === 'done');
    assert.equal(done.message.content, '重试成功');
    assert.equal(done.message.retriedFrom, errorAssistantId);
    assert.ok(!done.message.error, 'successful retry must not carry error field');

    const after = await sessionMessages(baseUrl, sessionId);
    assert.equal(after.length, 2);
    assert.equal(after[1].id, done.message.id);
    assert.ok(!after[1].error);
    assert.equal(after[1].finishReason, 'stop');
  });
});

test('v2.1 retry：错误分支 404 message_not_found / 409 message_not_assistant / 400 invalid_history', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;
    const round = await sendRound(baseUrl, sessionId, '你好');
    const userMessageId = round.sessionEvent.userMessageId;

    const missing = await adminRequest(
      baseUrl,
      `/admin/api/test/sessions/${sessionId}/messages/msg_does_not_exist/retry`,
      { method: 'POST', body: {} }
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'message_not_found');

    const notAssistant = await adminRequest(
      baseUrl,
      `/admin/api/test/sessions/${sessionId}/messages/${userMessageId}/retry`,
      { method: 'POST', body: {} }
    );
    assert.equal(notAssistant.status, 409);
    assert.equal(notAssistant.json.error.code, 'message_not_assistant');

    const missingSession = await adminRequest(baseUrl, '/admin/api/test/sessions/sess_nope/messages/msg_x/retry', {
      method: 'POST',
      body: {}
    });
    assert.equal(missingSession.status, 404);
    assert.equal(missingSession.json.error.code, 'session_not_found');
  });

  // invalid_history：直接注入会话 store 构造「assistant 前没有 user」的非法历史
  const dataDir = path.join(os.tmpdir(), `duckai-qa-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { createSessionsStore } = await import('../src/admin/sessions.js');
  const sessions = createSessionsStore({ dataDir, config: {} });
  try {
    const session = await sessions.createSession({ title: 'invalid' });
    await sessions.appendMessage(session.id, {
      id: 'msg_assistant_only',
      role: 'assistant',
      content: '孤立回复',
      finishReason: 'stop'
    });
    const loaded = await sessions.getSession(session.id);
    const assistantId = loaded.messages[0].id;
    await withServer({ duck: new MockDuckClient(), sessions }, async ({ baseUrl }) => {
      const res = await adminRequest(
        baseUrl,
        `/admin/api/test/sessions/${session.id}/messages/${assistantId}/retry`,
        { method: 'POST', body: {} }
      );
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_history');
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('v2.1 retry：会话正在流式时并发重试 → 409 session_busy', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  duck.enqueueChat({ textDeltas: ['慢速', '回答', '输出'], perEventDelayMs: 250 });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;
    const round = await sendRound(baseUrl, sessionId, '第一轮');
    const assistantId = round.sessionEvent.assistantMessageId;

    // 第二轮消息正在流式输出（目标 a1 仍存在）；此时对 a1 发起 retry 应被 busy 锁拒绝
    const streamingTurn = postMessage(baseUrl, sessionId, { content: '第二轮' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const concurrent = await adminRequest(
      baseUrl,
      `/admin/api/test/sessions/${sessionId}/messages/${assistantId}/retry`,
      { method: 'POST', body: {}, timeoutMs: 5000 }
    );
    assert.equal(concurrent.status, 409, `expected 409 session_busy, got ${concurrent.status}`);
    assert.equal(concurrent.json.error.code, 'session_busy');

    // 并发被拒后，第一轮流式应正常完成，历史不被破坏
    const { events } = await streamingTurn;
    assert.ok(jsonEvents(events).some((payload) => payload.type === 'done'));
    const messages = await sessionMessages(baseUrl, sessionId);
    assert.equal(messages.length, 4, 'concurrent retry must not corrupt session history');
    assert.deepEqual(
      messages.map((message) => `${message.role}:${message.content}`),
      ['user:第一轮', 'assistant:A1', 'user:第二轮', 'assistant:慢速回答输出']
    );
  });
});

test('v2.1 reasoningEncrypted：持久化 + GET/SSE 透出', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['加密档回答'], reasoningEncrypted: true });
  duck.enqueueChat({ textDeltas: ['明文推理回答'], reasoningDeltas: ['明文'], reasoningEncrypted: false });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;

    // 1) 上游仅返回加密摘要：reasoning="" 且 reasoningEncrypted=true（SSE + GET 均透出）
    const first = await sendRound(baseUrl, sessionId, '加密推理');
    assert.equal(first.done.message.reasoning, '');
    assert.equal(first.done.message.reasoningEncrypted, true);
    let stored = await sessionMessages(baseUrl, sessionId);
    assert.equal(stored[1].reasoningEncrypted, true);

    // 2) 上游返回明文 reasoning：reasoning 返回且 reasoningEncrypted=false
    const second = await sendRound(baseUrl, sessionId, '明文推理');
    assert.equal(second.done.message.reasoning, '明文');
    assert.equal(second.done.message.reasoningEncrypted, false);
    stored = await sessionMessages(baseUrl, sessionId);
    assert.equal(stored[3].reasoningEncrypted, false);
    assert.equal(stored[3].reasoning, '明文');
  });
});

test('v2.1 retry 失败语义：首事件前 → HTTP JSON；流中 → SSE error 且无 done', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  duck.enqueueChat({
    error: Object.assign(new Error('rate limited'), {
      name: 'DuckError',
      status: 429,
      type: 'ERR_RATE_LIMIT',
      retriable: true
    })
  });
  duck.enqueueChat({ textDeltas: ['部分'], errorAfterText: Object.assign(new Error('mid fail'), {
    name: 'DuckError',
    status: 502,
    type: 'upstream_protocol_mismatch',
    retriable: false
  }) });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await createSession(baseUrl, {});
    const sessionId = created.json.session.id;
    const round = await sendRound(baseUrl, sessionId, '你好');
    const assistantId = round.sessionEvent.assistantMessageId;

    // 首事件前失败 → HTTP JSON（不写 SSE 头；目标 assistant 被替换为 error assistant）
    const beforeStream = await adminRequest(
      baseUrl,
      `/admin/api/test/sessions/${sessionId}/messages/${assistantId}/retry`,
      { method: 'POST', body: {}, timeoutMs: 10000 }
    );
    assert.equal(beforeStream.status, 429);
    assert.match(String(beforeStream.headers.get('content-type')), /application\/json/);
    assert.equal(beforeStream.json.error.code, 'rate_limit_exceeded');

    const erroredMessages = await sessionMessages(baseUrl, sessionId);
    assert.equal(erroredMessages.length, 2);
    const errorAssistantId = erroredMessages[1].id;
    assert.ok(erroredMessages[1].error);

    // 流中失败 → SSE error 事件且无 done（重试目标已被替换为 error assistant）
    const { events } = await retryMessage(baseUrl, sessionId, errorAssistantId);
    const payloads = jsonEvents(events);
    assert.ok(payloads.some((payload) => payload.type === 'error'), 'missing error event');
    assert.ok(!payloads.some((payload) => payload.type === 'done'), 'must not emit done after mid-stream error');
    const errored = await sessionMessages(baseUrl, sessionId);
    assert.equal(errored.length, 2);
    assert.equal(errored[1].finishReason, 'error');
    assert.ok(errored[1].error);
  });
});
