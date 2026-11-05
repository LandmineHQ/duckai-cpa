/**
 * task-74/task-75：真正压缩（Codex marker / `/v1/compact`）只把摘要写入 context PDF；
 * 20k 自动溢出仍保留完整旧上下文（对照，不回归）。
 *
 * 约定（v2.57）：
 * - 自动溢出（>20k、无 marker）：context PDF = 完整旧上下文；
 * - Codex marker：context PDF 只含 `[CONVERSATION SUMMARY]\n<marker 摘要>`，旧 PDF 同 scope 覆盖；
 *   hot = marker 之后的消息（摘要不进 hot/user 文本）；
 * - /v1/compact：context PDF 只含 summary.text；同 session scope 覆盖并持久化 conversation_state；
 * - 后续普通轮次复用摘要 PDF（b64/updatedAt 不变）。
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

const OLD_CONTEXT = 'OLD-CONTEXT-UNIQUE this old history must be compressed away';
const SUMMARY_TEXT = 'QA-SUMMARY-ONLY-UNIQUE compressed summary text (no raw history)';
const MARKER_TEXT = `Another language model started to solve this problem and produced a summary of its thinking process. ${SUMMARY_TEXT}`;
const BIG = `${OLD_CONTEXT}\n${'A'.repeat(26000)}`;

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

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-summary-pdf-'));
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
    async cleanup() {
      await server.close?.();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') ? String(part.text || '') : ''))
      .join('\n');
  }
  return '';
}

function allFiles(messages = []) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => (Array.isArray(message?.files) ? message.files : []));
}

function firstUserWithFiles(messages = []) {
  return (Array.isArray(messages) ? messages : []).find((message) => message?.role === 'user' && Array.isArray(message.files) && message.files.length);
}

function contentText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map(messageText)
    .join('\n');
}

function assertBothPdfs(messages) {
  const names = allFiles(messages).map((file) => file.filename);
  assert.ok(names.includes('client-tools.pdf'), `缺少 client-tools.pdf：${JSON.stringify(names)}`);
  assert.ok(names.includes('conversation-context.pdf'), `缺少 conversation-context.pdf：${JSON.stringify(names)}`);
  const firstUser = firstUserWithFiles(messages);
  assert.ok(firstUser, '应有 user 消息携带 PDF');
  const userFiles = (firstUser.files || []).map((file) => file.filename);
  assert.ok(userFiles.includes('client-tools.pdf') && userFiles.includes('conversation-context.pdf'), '两个 PDF 应挂在同一第一条 user');
  return allFiles(messages).find((file) => file.filename === 'conversation-context.pdf');
}

async function historyEntry(env, sessionKey) {
  const list = await adminRequest(env.baseUrl, '/admin/api/history');
  assert.equal(list.status, 200, list.text);
  const items = (list.json.groups || []).flatMap((group) => group.items);
  const item = items.find((entry) => entry.sessionKey === sessionKey);
  assert.ok(item, `历史应包含会话 ${sessionKey}`);
  const detail = await adminRequest(env.baseUrl, `/admin/api/history/${item.id}`);
  assert.equal(detail.status, 200, detail.text);
  return detail.json.item;
}

function historyMessagesContent(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => String(message.content || ''))
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 1) 自动溢出基线：完整上下文 PDF                                       */
/* ------------------------------------------------------------------ */

test('自动溢出（>20k、无 marker）：context PDF 仍含完整旧上下文（不回归）', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-summary-baseline';
  try {
    env.duck.enqueueChat({ textDeltas: ['A1'] });
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'OLD-ASSISTANT-FULL-CONTEXT' },
          { role: 'user', content: '当前问题' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const scope = pdfScopeKey({ kind: 'chat', sessionKey });
    const pdf = await env.responsesStore.getContextPdf(scope);
    assert.ok(pdf?.textContent, '自动溢出应持久化 context PDF');
    assert.ok(pdf.textContent.includes(OLD_CONTEXT), '自动溢出 PDF 应含完整旧上下文');
    assert.ok(pdf.textContent.includes('OLD-ASSISTANT-FULL-CONTEXT'));
    const turnFiles = allFiles(env.duck.calls.chat[0]?.params?.messages);
    assert.ok(turnFiles.some((file) => file.filename === 'client-tools.pdf'));
    assert.equal(turnFiles.find((file) => file.filename === 'conversation-context.pdf').text.includes(OLD_CONTEXT), true);
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2) Codex marker 真正压缩：摘要 PDF 覆盖旧全文 PDF                     */
/* ------------------------------------------------------------------ */

test('Codex marker 真正压缩：摘要 PDF 覆盖旧完整上下文、hot/history 不残留、后续轮复用', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-summary-marker';
  try {
    env.duck.enqueueChat({ textDeltas: ['A1'] });
    env.duck.enqueueChat({ textDeltas: ['A2'] });
    env.duck.enqueueChat({ textDeltas: ['A3'] });

    // 第 1 轮：自动溢出 → 完整上下文 PDF（基线）
    const first = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'OLD-ASSISTANT-FULL-CONTEXT' },
          { role: 'user', content: '第一轮问题' }
        ]
      }
    });
    assert.equal(first.status, 200, first.text);
    const scope = pdfScopeKey({ kind: 'chat', sessionKey });
    const beforeCompact = await env.responsesStore.getContextPdf(scope);
    assert.ok(beforeCompact.textContent.includes(OLD_CONTEXT), '压缩前 context PDF 应含旧完整上下文');
    const oldB64 = beforeCompact.pdfB64;

    // 第 2 轮：旧历史 + marker 摘要 + 新 user → 真正压缩
    const second = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        tools: TOOLS,
        messages: [
          { role: 'user', content: `旧历史：${OLD_CONTEXT}` },
          { role: 'assistant', content: 'OLD-ASSISTANT-BEFORE-MARKER' },
          { role: 'user', content: MARKER_TEXT },
          { role: 'user', content: '压缩后的新问题' }
        ]
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.headers.get('x-session-id'), sessionKey);

    // 2a) PDF 只含摘要，旧完整上下文被覆盖
    const afterCompact = await env.responsesStore.getContextPdf(scope);
    assert.ok(afterCompact.textContent.includes(SUMMARY_TEXT), '压缩后 PDF 应含摘要文本');
    assert.ok(!afterCompact.textContent.includes(OLD_CONTEXT), '压缩后 PDF 不应含旧完整上下文');
    assert.ok(!afterCompact.textContent.includes('OLD-ASSISTANT-BEFORE-MARKER'));
    assert.notEqual(afterCompact.pdfB64, oldB64, '同 scope 的旧完整 PDF 应被摘要 PDF 覆盖');
    assert.ok(afterCompact.updatedAt > beforeCompact.updatedAt, '覆盖后 updated_at 应更新');

    // 2b) hot 不残留旧对话/不把摘要当普通 user 文本；两个 PDF 仍在
    const turn2Messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    const contextFile = assertBothPdfs(turn2Messages);
    assert.ok(contextFile.text.includes(SUMMARY_TEXT), '上游 context PDF 应含摘要');
    assert.ok(!contextFile.text.includes(OLD_CONTEXT), '上游 context PDF 不应含旧上下文');
    const hotText = contentText(turn2Messages);
    assert.ok(!hotText.includes(OLD_CONTEXT), 'hot 不应含旧 user');
    assert.ok(!hotText.includes('OLD-ASSISTANT-BEFORE-MARKER'), 'hot 不应含旧 assistant');
    assert.ok(!hotText.includes(SUMMARY_TEXT), 'hot 不应把摘要当普通 user/assistant 文本');
    assert.ok(hotText.includes('压缩后的新问题'), 'hot 应含 marker 之后的新 user');

    // 2c) 历史：压缩后视图 + compression 元数据；context PDF chip 文本为摘要
    const history = await historyEntry(env, sessionKey);
    const historyContent = historyMessagesContent(history.messages);
    assert.ok(!historyContent.includes(OLD_CONTEXT), '历史正文不应含旧 user');
    assert.ok(!historyContent.includes('OLD-ASSISTANT-BEFORE-MARKER'));
    assert.ok(!historyContent.includes(SUMMARY_TEXT), '历史正文不应把摘要当普通消息');
    assert.equal(history.injection?.compression?.trigger, 'manual');
    assert.ok(history.injection?.compression?.summaryHash);
    assert.ok(history.injection?.compression?.coveredMessageCount >= 2);
    assert.equal(history.injection?.protocolKind, 'client-tools-pdf');
    const historyPdfFile = (history.messages || [])
      .flatMap((message) => (Array.isArray(message.files) ? message.files : []))
      .find((file) => file.filename === 'conversation-context.pdf');
    assert.ok(historyPdfFile, '历史应保留 context PDF 元数据');
    assert.ok(String(historyPdfFile.text || '').includes(SUMMARY_TEXT), '历史 PDF chip 文本应为摘要');
    assert.ok(!String(historyPdfFile.text || '').includes(OLD_CONTEXT), '历史 PDF chip 不应含旧上下文');

    // 2d) 第 3 轮普通消息：复用摘要 PDF，不重建
    const third = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', tools: TOOLS, messages: [{ role: 'user', content: '继续：第三问' }] }
    });
    assert.equal(third.status, 200, third.text);
    const turn3Context = allFiles(env.duck.calls.chat.at(-1)?.params?.messages).find(
      (file) => file.filename === 'conversation-context.pdf'
    );
    assert.ok(turn3Context, '普通轮次应继续附带摘要 context PDF');
    assert.equal(turn3Context.b64, afterCompact.pdfB64, '普通轮次应复用摘要 PDF');
    assert.ok(turn3Context.text.includes(SUMMARY_TEXT));
    assert.ok(!turn3Context.text.includes(OLD_CONTEXT));
    const afterThird = await env.responsesStore.getContextPdf(scope);
    assert.equal(afterThird.updatedAt, afterCompact.updatedAt, '普通轮次不应重建摘要 PDF');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3) /v1/compact：摘要 PDF 只含 summary，不含原始长 messages             */
/* ------------------------------------------------------------------ */

test('/v1/compact：摘要 PDF 只含 summary、覆盖旧完整 PDF、后续同 session 复用', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-summary-compact-api';
  try {
    env.duck.enqueueChat({ textDeltas: ['A1'] });
    // 先产生旧完整上下文 PDF（自动溢出）
    const first = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: `${OLD_CONTEXT}\n${'B'.repeat(26000)}` },
          { role: 'assistant', content: 'OLD-COMPACT-ASSISTANT' },
          { role: 'user', content: '问题一' }
        ]
      }
    });
    assert.equal(first.status, 200, first.text);
    const scope = pdfScopeKey({ kind: 'chat', sessionKey });
    const oldPdf = await env.responsesStore.getContextPdf(scope);
    assert.ok(oldPdf.textContent.includes(OLD_CONTEXT), '压缩前应有完整旧上下文 PDF');

    // mock 摘要文本（不含旧上下文）
    env.duck.summarizeBehavior = { text: SUMMARY_TEXT, model: 'gpt-6-luna', coveredMessageCount: 4 };
    const compact = await v1Request(env.baseUrl, '/v1/compact', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        keep_recent_messages: 2,
        messages: [
          { role: 'user', content: `${OLD_CONTEXT}\n${'C'.repeat(22000)}` },
          { role: 'assistant', content: 'OLD-COMPACT-ASSISTANT' },
          { role: 'user', content: '问题二' },
          { role: 'assistant', content: '回答二' },
          { role: 'user', content: '最后一问' }
        ]
      }
    });
    assert.equal(compact.status, 200, compact.text);
    assert.equal(compact.json?.summary?.text, SUMMARY_TEXT);
    assert.equal(compact.json?.context_pdf?.filename, 'conversation-context.pdf');

    const compactPdf = await env.responsesStore.getContextPdf(scope);
    assert.equal(compactPdf.textContent, SUMMARY_TEXT, '摘要 PDF 只含 summary.text');
    assert.ok(!compactPdf.textContent.includes(OLD_CONTEXT), '摘要 PDF 不应含原始长 messages');
    assert.ok(!compactPdf.textContent.includes('OLD-COMPACT-ASSISTANT'));
    assert.notEqual(compactPdf.pdfB64, oldPdf.pdfB64, '摘要 PDF 应覆盖旧完整 PDF');
    const conversation = await env.responsesStore.getConversation(sessionKey);
    assert.equal(conversation?.compression?.trigger, 'compact');
    assert.equal(conversation?.contextPdfScope, scope);

    // 同 session 后续普通请求：复用摘要 PDF
    env.duck.enqueueChat({ textDeltas: ['A2'] });
    const next = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '继续普通问题' }] }
    });
    assert.equal(next.status, 200, next.text);
    const nextContext = allFiles(env.duck.calls.chat.at(-1)?.params?.messages).find(
      (file) => file.filename === 'conversation-context.pdf'
    );
    assert.ok(nextContext, '后续请求应挂载摘要 context PDF');
    assert.equal(nextContext.b64, compactPdf.pdfB64, '后续请求应复用 /v1/compact 生成的摘要 PDF');
    assert.ok(nextContext.text.includes(SUMMARY_TEXT));
    assert.ok(!nextContext.text.includes(OLD_CONTEXT));
    const afterNext = await env.responsesStore.getContextPdf(scope);
    assert.equal(afterNext.updatedAt, compactPdf.updatedAt, '后续请求不应重建摘要 PDF');
  } finally {
    await env.cleanup();
  }
});
