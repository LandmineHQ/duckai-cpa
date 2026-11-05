/**
 * task-72/task-73：会话 canonical 状态 + Codex 手动压缩 marker 的 PDF 回归。
 *
 * 规则（v2.51）：
 * - marker 消息（任意角色，含精确子串）之前的旧对话 + 摘要 → conversation-context.pdf；
 * - hot = marker 消息 + marker 之后的消息（含当前 user）；旧 user 不再作为普通消息发送/保存；
 * - 有 client tools 时 client-tools.pdf 始终附带；两个 PDF 都挂在 hot 的第一条 user；
 * - 同一 session（X-Session-Id / conversation_id / prompt_cache_key）压缩前后不变；
 * - 后续普通轮次复用同一 context PDF（不重新生成）。
 * 全程 mock DuckClient，不访问真实 duck.ai。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startTestServer, v1Request, adminRequest, makeConfig } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { createResponseStore } from '../src/openai/responses-store.js';
import { createHistoryStore } from '../src/history.js';
import { createNullLogger } from '../src/logger.js';
import { pdfScopeKey } from '../src/openai/context-spill.js';

const MARKER =
  'Another language model started to solve this problem and produced a summary of its thinking process. ' +
  'SUMMARY: QA-MARKER-SUMMARY user was inspecting PDF files and asked for a listing.';
const OLD_TURN1 = 'QA-OLD-TURN1-UNIQUE please read the PDF files in /tmp/qa-old';
const OLD_BEFORE_MARKER = 'QA-OLD-BEFORE-MARKER-UNIQUE this sentence must not survive in history';
const OLD_RESPONSES = 'QA-OLD-RESPONSES-UNIQUE read all PDFs before answering';
const BIG = `${OLD_TURN1}\n${'A'.repeat(26000)}`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  }
];

const RESPONSES_TOOLS = [
  {
    type: 'function',
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
];

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') ? String(part.text || '') : '')).join('\n');
  }
  return '';
}

function allFiles(messages = []) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => (Array.isArray(message?.files) ? message.files : []));
}

function firstUserWithFiles(messages = []) {
  return (Array.isArray(messages) ? messages : []).find((message) => message?.role === 'user' && Array.isArray(message.files) && message.files.length);
}

function historyMessageContent(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => String(message.content || ''))
    .join('\n');
}

function assertHistoryCompressed(messages, oldText, label) {
  assert.ok(!historyMessageContent(messages).includes(oldText), label + '：历史消息正文不应残留旧 user');
  assert.ok(!JSON.stringify(messages).includes('JVBERi0'), label + '：历史不应保存 PDF base64');
}

function contentText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => messageText(message))
    .join('\n');
}

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-manual-compact-'));
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
    async cleanup() {
      await server.close?.();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function historyEntry(env, sessionKey) {
  const list = await adminRequest(env.baseUrl, '/admin/api/history');
  assert.equal(list.status, 200, list.text);
  const items = (list.json.groups || []).flatMap((group) => group.items);
  const matches = items.filter((item) => item.sessionKey === sessionKey);
  assert.equal(matches.length, 1, `会话 ${sessionKey} 应只有一条历史记录（实际 ${matches.length}）`);
  const detail = await adminRequest(env.baseUrl, `/admin/api/history/${matches[0].id}`);
  assert.equal(detail.status, 200, detail.text);
  return detail.json.item;
}

function assertBothPdfsOnFirstUser(messages, { contextText = null } = {}) {
  const names = allFiles(messages).map((file) => file.filename);
  assert.ok(names.includes('client-tools.pdf'), `缺少 client-tools.pdf：${JSON.stringify(names)}`);
  assert.ok(names.includes('conversation-context.pdf'), `缺少 conversation-context.pdf：${JSON.stringify(names)}`);
  const firstUser = firstUserWithFiles(messages);
  assert.ok(firstUser, '应有 user 消息携带 PDF');
  const userFiles = (firstUser.files || []).map((file) => file.filename);
  assert.ok(userFiles.includes('client-tools.pdf') && userFiles.includes('conversation-context.pdf'), '两个 PDF 应挂在同一第一条 user');
  const contextFile = allFiles(messages).find((file) => file.filename === 'conversation-context.pdf');
  assert.ok(contextFile.b64.startsWith('JVBERi0'), 'context PDF 应是合法 PDF base64');
  if (contextText) {
    assert.ok(String(contextFile.text || '').includes(contextText), `context PDF 文本应包含 ${contextText}`);
  }
  return contextFile;
}

/* ------------------------------------------------------------------ */
/* 1) chat：首轮长会话带 tools → 第二轮机压 marker → 第三轮复用        */
/* ------------------------------------------------------------------ */

test('chat 手动压缩：双 PDF/同一 session/历史只留压缩后视图/后续轮复用 PDF', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-manual-compact-01';
  try {
    env.duck.enqueueChat({ textDeltas: ['A1'] });
    env.duck.enqueueChat({ textDeltas: ['A2'] });
    env.duck.enqueueChat({ textDeltas: ['A3'] });

    // 第 1 轮：长会话 + tools → 自动 PDF 溢出（两个 PDF）
    const first = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'OLD-ASSISTANT-TURN1' },
          { role: 'user', content: '第一轮问题' }
        ]
      }
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.headers.get('x-session-id'), sessionKey, '响应头应回写同一 session');
    const turn1Files = allFiles(env.duck.calls.chat[0]?.params?.messages);
    assert.ok(turn1Files.some((file) => file.filename === 'client-tools.pdf'), '首轮应有 client-tools.pdf');
    assert.ok(turn1Files.some((file) => file.filename === 'conversation-context.pdf'), '首轮长会话应有 context PDF');
    assert.ok(String(turn1Files.find((file) => file.filename === 'conversation-context.pdf').text || '').includes(OLD_TURN1));

    // 第 2 轮：旧历史 + Codex 摘要 marker + 新 user（同一 session）
    const second = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        messages: [
          { role: 'user', content: `短旧历史：${OLD_BEFORE_MARKER}` },
          { role: 'assistant', content: 'OLD-ASSISTANT-BEFORE-MARKER' },
          { role: 'user', content: MARKER },
          { role: 'user', content: '压缩后的新问题：继续列目录' }
        ]
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.headers.get('x-session-id'), sessionKey);
    const turn2Messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    const turn2Files = allFiles(turn2Messages);
    const contextFile = assertBothPdfsOnFirstUser(turn2Messages, { contextText: OLD_BEFORE_MARKER });
    assert.ok(String(contextFile.text || '').includes('QA-MARKER-SUMMARY'), 'context PDF 应包含摘要全文');
    assert.ok(!contentText(turn2Messages).includes(OLD_BEFORE_MARKER), 'hot 文本不应残留旧 user');
    assert.ok(!contentText(turn2Messages).includes('OLD-ASSISTANT-BEFORE-MARKER'), 'hot 文本不应残留旧 assistant');
    assert.ok(contentText(turn2Messages).includes(MARKER), 'hot 应包含 marker 摘要消息');
    assert.ok(contentText(turn2Messages).includes('压缩后的新问题'), 'hot 应包含当前 user');

    const scope = pdfScopeKey({ kind: 'chat', sessionKey });
    const pdfAfterTurn2 = await env.responsesStore.getContextPdf(scope);
    assert.ok(pdfAfterTurn2?.pdfB64, 'context PDF 应持久化');
    assert.ok(String(pdfAfterTurn2.textContent || '').includes(OLD_BEFORE_MARKER));
    const conversation = await env.responsesStore.getConversation(sessionKey);
    assert.ok(conversation, 'canonical conversation 应持久化');
    assert.ok(!JSON.stringify(conversation.canonical).includes(OLD_BEFORE_MARKER), 'canonical 不应保留旧 user');
    assert.equal(conversation.compression?.trigger, 'manual');
    assert.equal(conversation.compression?.summaryHash?.length > 0, true);
    assert.ok(conversation.compression?.coveredMessageCount >= 2);
    assert.equal(conversation.contextPdfScope, scope);

    // 历史：同一 session、只保留压缩后视图
    const historyAfterTurn2 = await historyEntry(env, sessionKey);
    assert.equal(historyAfterTurn2.sessionKey, sessionKey, '压缩后 sessionKey 不变');
    assertHistoryCompressed(historyAfterTurn2.messages, OLD_BEFORE_MARKER, '第 2 轮历史');
    assert.ok(JSON.stringify(historyAfterTurn2.messages).includes('QA-MARKER-SUMMARY'), '历史应保留摘要/marker 视图');
    assert.equal(historyAfterTurn2.injection?.compression?.trigger, 'manual');
    assert.equal(historyAfterTurn2.injection?.protocolKind, 'client-tools-pdf');
    assert.ok(historyAfterTurn2.injection?.contextPdf?.pages >= 1, '历史 injection 应带 context PDF 元数据');
    assert.ok(historyAfterTurn2.injection?.contextPdf?.bytes > 0);
    assert.ok(historyAfterTurn2.injection?.compression?.coveredMessageCount >= 2);

    // 第 3 轮：普通轮次（无 marker）→ 复用同一 context PDF，不重新生成
    const pdfUpdatedBefore = pdfAfterTurn2.updatedAt;
    env.duck.enqueueChat({ textDeltas: ['A3'] });
    const third = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', tools: TOOLS, messages: [{ role: 'user', content: '继续：第三个问题' }] }
    });
    assert.equal(third.status, 200, third.text);
    const turn3Messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    const turn3Files = allFiles(turn3Messages);
    const turn3Context = turn3Files.find((file) => file.filename === 'conversation-context.pdf');
    assert.ok(turn3Context, '普通轮次应继续附带 context PDF');
    assert.equal(turn3Context.b64, contextFile.b64, '普通轮次应复用同一 context PDF（b64 相同）');
    assert.ok(String(turn3Context.text || '').includes(OLD_BEFORE_MARKER), '复用的 PDF 仍应包含压缩前内容');
    const pdfAfterTurn3 = await env.responsesStore.getContextPdf(scope);
    assert.equal(pdfAfterTurn3.updatedAt, pdfUpdatedBefore, '普通轮次不应重建 context PDF（updatedAt 不变）');

    const historyAfterTurn3 = await historyEntry(env, sessionKey);
    assert.equal(historyAfterTurn3.sessionKey, sessionKey);
    assertHistoryCompressed(historyAfterTurn3.messages, OLD_BEFORE_MARKER, '第 3 轮历史');
    assert.equal(historyAfterTurn3.injection?.contextPdf?.reused, true, '普通轮次应标记 context PDF 复用');
    assert.ok(historyMessageContent(historyAfterTurn3.messages).includes('继续：第三个问题'), '历史应包含普通轮次的新 user');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2) 会话标识三组：X-Session-Id / conversation_id / prompt_cache_key   */
/* ------------------------------------------------------------------ */

async function runIdentifierScenario(identifier) {
  const env = await setup();
  const key = identifier.value;
  try {
    env.duck.enqueueChat({ textDeltas: ['A1'] });
    env.duck.enqueueChat({ textDeltas: ['A2'] });
    const firstHeaders = identifier.header ? { 'x-session-id': key } : {};
    const firstBody = identifier.bodyField ? { [identifier.bodyField]: key } : {};
    const first = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: firstHeaders,
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        ...firstBody,
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'OLD-ASSISTANT-TURN1' },
          { role: 'user', content: '第一轮问题' }
        ]
      }
    });
    assert.equal(first.status, 200, `${identifier.name} 首轮 HTTP ${first.status}: ${first.text}`);
    assert.equal(first.headers.get('x-session-id'), key, `${identifier.name} 响应头应回写稳定 session`);
    assert.ok(allFiles(env.duck.calls.chat[0]?.params?.messages).some((file) => file.filename === 'conversation-context.pdf'));

    const second = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: firstHeaders,
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        ...firstBody,
        messages: [
          { role: 'user', content: `旧历史：${OLD_BEFORE_MARKER}` },
          { role: 'assistant', content: 'OLD-ASSISTANT-BEFORE-MARKER' },
          { role: 'user', content: MARKER },
          { role: 'user', content: '新问题' }
        ]
      }
    });
    assert.equal(second.status, 200, `${identifier.name} 压缩轮 HTTP ${second.status}: ${second.text}`);
    assert.equal(second.headers.get('x-session-id'), key, `${identifier.name} 压缩后 session 不变`);
    const turn2Messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    assertBothPdfsOnFirstUser(turn2Messages, { contextText: OLD_BEFORE_MARKER });
    assert.ok(!contentText(turn2Messages).includes(OLD_BEFORE_MARKER), `${identifier.name} hot 不应残留旧 user`);

    const history = await historyEntry(env, key);
    assert.equal(history.sessionKey, key, `${identifier.name} 历史 sessionKey 不变`);
    assertHistoryCompressed(history.messages, OLD_BEFORE_MARKER, identifier.name + ' 历史');
    assert.equal(history.injection?.compression?.trigger, 'manual');
  } finally {
    await env.cleanup();
  }
}

test('会话标识：X-Session-Id 压缩前后同一 session', async () => {
  await runIdentifierScenario({ name: 'X-Session-Id', header: true, value: 'sess-qa-ident-header' });
});

test('会话标识：body conversation_id 压缩前后同一 session', async () => {
  await runIdentifierScenario({ name: 'conversation_id', bodyField: 'conversation_id', value: 'sess-qa-ident-conv-id' });
});

test('会话标识：body prompt_cache_key（Codex 默认）压缩前后同一 session', async () => {
  await runIdentifierScenario({ name: 'prompt_cache_key', bodyField: 'prompt_cache_key', value: 'pc-qa-ident-0001' });
});

/* ------------------------------------------------------------------ */
/* 3) Responses 链路手动压缩                                           */
/* ------------------------------------------------------------------ */

test('/v1/responses 手动压缩：双 PDF/历史压缩视图/同一 session', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-manual-compact-responses';
  try {
    env.duck.enqueueChat({ textDeltas: ['R1'] });
    env.duck.enqueueChat({ textDeltas: ['R2'] });

    const first = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: RESPONSES_TOOLS,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: BIG }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OLD-RESPONSES-ASSISTANT' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮问题' }] }
        ]
      }
    });
    assert.equal(first.status, 200, first.text);
    assert.ok(allFiles(env.duck.calls.chat[0]?.params?.messages).some((file) => file.filename === 'conversation-context.pdf'));

    const second = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: RESPONSES_TOOLS,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: `旧历史：${OLD_RESPONSES}` }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OLD-RESPONSES-BEFORE-MARKER' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: MARKER }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '压缩后的问题' }] }
        ]
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.headers.get('x-session-id'), sessionKey);
    const messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    assertBothPdfsOnFirstUser(messages, { contextText: OLD_RESPONSES });
    assert.ok(!contentText(messages).includes(OLD_RESPONSES), 'responses hot 不应残留旧 user');

    const history = await historyEntry(env, sessionKey);
    assert.equal(history.sessionKey, sessionKey);
    assertHistoryCompressed(history.messages, OLD_RESPONSES, 'responses 历史');
    assert.equal(history.injection?.compression?.trigger, 'manual');
  } finally {
    await env.cleanup();
  }
});
