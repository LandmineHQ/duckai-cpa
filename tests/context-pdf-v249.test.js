/**
 * v2.49：PDF 溢出 + tokenizer usage。
 * 规则：文本输入 >20k 字符时，把历史移入会话 PDF；当前 user 保留文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, v1Request, adminRequest } from './helpers/test-server.js';
import { createHistoryStore } from '../src/history.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MockDuckClient } from './helpers/mock-duck.js';
import { spillMessagesToPdf } from '../src/openai/context-spill.js';
import { createContextPdf } from '../src/openai/context-pdf.js';
import { countTextTokens, countMessagesTokens } from '../src/openai/tokens.js';
import { buildUpstreamMessages } from '../src/duck/index.js';

const BIG = 'A'.repeat(25000);

test('tokenizer：文本/消息 token 估算', () => {
  assert.ok(countTextTokens('hello world') >= 1);
  assert.ok(countTextTokens('中文内容测试') >= 1);
  assert.ok(countMessagesTokens([{ role: 'user', content: 'hello' }]) >= 1);
});

test('spill：历史移入 PDF，当前 user 保留并附带 file part', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: BIG },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '当前问题' }
  ];
  const spill = await spillMessagesToPdf(messages, { inputCharLimit: 20000, maxPages: 15 });
  assert.ok(spill);
  assert.equal(spill.pdf.pages <= 15, true);
  assert.equal(spill.movedMessages, 2);
  const kept = spill.messages.at(-1);
  assert.equal(kept.role, 'user');
  assert.ok(kept.content.startsWith('当前问题'));
  assert.match(kept.content, /conversation-context\.pdf/);
  assert.ok(Array.isArray(kept.files) && kept.files.length === 1);
  assert.equal(kept.files[0].mimeType, 'application/pdf');
  assert.ok(kept.files[0].b64.startsWith('JVBERi0'));
  const upstream = buildUpstreamMessages(spill.messages);
  const filePart = upstream
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((part) => part && part.type === 'file');
  assert.ok(filePart, 'upstream 应包含 file part');
  assert.equal(filePart.mimeType, 'application/pdf');
});

test('chat：>20k 文本自动 PDF 溢出，usage 使用 tokenizer', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['ok'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: '当前问题' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.usage.estimation, 'tokenizer');
    assert.ok(payload.usage.prompt_tokens > 0);
    const duckMessages = duck.calls.chat[0].params.messages;
    const lastUser = [...duckMessages].reverse().find((message) => message.role === 'user');
    assert.ok(lastUser.files && lastUser.files.length === 1, '最后一条 user 应带 PDF file');
    const upstream = buildUpstreamMessages(duckMessages);
    const filePart = upstream
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part && part.type === 'file');
    assert.ok(filePart);
    assert.equal(filePart.mimeType, 'application/pdf');
  });
});

test('responses：>20k 文本自动 PDF 溢出', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['ok'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { type: 'message', role: 'user', content: BIG },
          { type: 'message', role: 'assistant', content: 'old answer' },
          { type: 'message', role: 'user', content: '当前问题' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.usage.estimation, 'tokenizer');
    const duckMessages = duck.calls.chat[0].params.messages;
    const filePart = buildUpstreamMessages(duckMessages)
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part && part.type === 'file');
    assert.ok(filePart);
    assert.equal(filePart.mimeType, 'application/pdf');
  });
});



test('PDF 生成：文本分页 + 图片嵌入', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const result = await createContextPdf({
    messages: [
      { role: 'user', content: '请参考这张图', images: [{ b64: png, format: 'png' }] },
      { role: 'assistant', content: '已收到' }
    ],
    maxPages: 15
  });
  assert.ok(result.pages >= 2);
  assert.equal(result.imageCount, 1);
  assert.ok(result.buffer.includes(Buffer.from('/Subtype /Image')));
});


test('历史记录包含 PDF 附件元数据（前端可渲染 chip）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-v249-pdf-history-'));
  const history = await createHistoryStore({ dataDir, config: { history: { retentionDays: 30 } }, logger: null });
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['ok'] });
  await withServer({ duck, dataDir, history }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v249-pdf-history' },
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: BIG },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: '当前问题' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const list = await adminRequest(baseUrl, '/admin/api/history');
    const item = (list.json.groups || []).flatMap((group) => group.items).find((entry) => entry.sessionKey === 'sess-v249-pdf-history');
    assert.ok(item);
    const detail = await adminRequest(baseUrl, `/admin/api/history/${item.id}`);
    const user = detail.json.item.messages.find((message) => message.role === 'user');
    assert.ok(user.files && user.files.length === 1, '历史 user 消息应带 files 元数据');
    assert.equal(user.files[0].mimeType, 'application/pdf');
    assert.ok(user.files[0].pages >= 1);
    assert.ok(!JSON.stringify(detail.json.item.messages).includes('JVBERi0'), '历史不应存 PDF base64');
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});


test('同一会话复用同一 context PDF，不每轮重新生成', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  duck.enqueueChat({ textDeltas: ['A2'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v249-reuse' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: BIG }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'Q1' }] }
    });
    assert.equal(first.status, 200, first.text);
    const firstPdf = duck.calls.chat[0].params.messages.find((m) => m.role === 'user')?.files?.[0]?.b64;
    assert.ok(firstPdf);
    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v249-reuse' },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: BIG }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }] }
    });
    assert.equal(second.status, 200, second.text);
    const secondPdf = duck.calls.chat.at(-1).params.messages.find((m) => m.role === 'user')?.files?.[0]?.b64;
    assert.equal(secondPdf, firstPdf, '第二轮应复用同一个 context PDF');
  });
});


test('两个 PDF：client-tools.pdf + context-history.pdf', async () => {
  const spill = await spillMessagesToPdf([{ role: 'user', content: BIG }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'Q' }], {
    inputCharLimit: 20000, maxPages: 15, toolProtocol: '[工具调用协议] read_file', toolNames: ['read_file']
  });
  assert.ok(spill);
  const files = spill.messages.at(-1).files;
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.filename).sort(), ['client-tools.pdf', 'conversation-context.pdf']);
});

test('Responses 同一会话复用同一 context PDF', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['A1'] });
  duck.enqueueChat({ textDeltas: ['A2'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST', headers: { 'x-session-id': 'sess-v249-resp-reuse' },
      body: { model: 'gpt-6-luna', input: [
        { type: 'message', role: 'user', content: BIG },
        { type: 'message', role: 'assistant', content: 'old' },
        { type: 'message', role: 'user', content: 'Q1' }
      ] }
    });
    assert.equal(first.status, 200, first.text);
    const firstPdf = duck.calls.chat[0].params.messages.find((m) => m.role === 'user')?.files?.[0]?.b64;
    assert.ok(firstPdf);
    const second = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST', headers: { 'x-session-id': 'sess-v249-resp-reuse' },
      body: { model: 'gpt-6-luna', input: [
        { type: 'message', role: 'user', content: BIG },
        { type: 'message', role: 'assistant', content: 'old' },
        { type: 'message', role: 'user', content: 'Q1' },
        { type: 'message', role: 'assistant', content: 'A1' },
        { type: 'message', role: 'user', content: 'Q2' }
      ] }
    });
    assert.equal(second.status, 200, second.text);
    const secondPdf = duck.calls.chat.at(-1).params.messages.find((m) => m.role === 'user')?.files?.[0]?.b64;
    assert.equal(secondPdf, firstPdf, 'Responses 第二轮应复用同一个 context PDF');
  });
});
