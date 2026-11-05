/**
 * task-77/task-78：图片-only 输出 + 跨轮图片上下文持久化回归。
 *
 * 约定（v2.58）：
 * - `/v1/responses` 图片-only：output 同时有 message/文本与非空 `image_generation_call.result`；
 *   流式有 `response.image_generation_call.*` 与 `response.completed`；不能只有占位文本。
 * - chat/completions 图片-only：`message.images` 为真实 data URI；history assistant images 保留。
 * - 同 session 下一轮客户端只回占位文本（无 image part）时，从 `conversation_state.images_json`
 *   恢复真实图片挂到最后一条 user；history 不把图片降级成普通文本。
 * - 连续图片追加、去重（最多 8 张），旧图不丢。
 * 全程 mock DuckClient，不访问真实 duck.ai。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startTestServer, v1Request, adminRequest, makeConfig, collectSSE } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { createResponseStore } from '../src/openai/responses-store.js';
import { createHistoryStore } from '../src/history.js';
import { createNullLogger } from '../src/logger.js';
import { buildUpstreamMessages } from '../src/duck/index.js';

const PLACEHOLDER = '已生成 1 张图片（base64 位于 image_generation_call.result 字段）。';

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-image-only-'));
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

function imageOnly(extra = {}) {
  return { textDeltas: [], images: [{ b64: PNG_1X1_B64, format: 'png', model: 'gpt-image-2' }], ...extra };
}

function imageParts(messages) {
  return buildUpstreamMessages(messages || [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part && part.type === 'image');
}

function imagesInMessages(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) =>
    Array.isArray(message?.images) ? message.images : []
  );
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

function assistantImages(historyItem) {
  return (historyItem.messages || [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => (Array.isArray(message.images) ? message.images : []));
}

function allHistoryImages(historyItem) {
  return (historyItem.messages || []).flatMap((message) => (Array.isArray(message.images) ? message.images : []));
}

/* ------------------------------------------------------------------ */
/* 1) /v1/responses 图片-only（非流式 + 流式）                            */
/* ------------------------------------------------------------------ */

test('responses 图片-only（非流式）：image_generation_call.result + 文本都在，history images 保留', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-image-only-resp';
  try {
    env.duck.enqueueChat(imageOnly());
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: '画一只橘猫', tools: [{ type: 'image_generation' }] }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    const types = (payload.output || []).map((item) => item.type);
    assert.ok(types.includes('message'), `应包含 message item：${types}`);
    assert.ok(types.includes('image_generation_call'), `应包含 image_generation_call：${types}`);
    const image = payload.output.find((item) => item.type === 'image_generation_call');
    assert.equal(image.status, 'completed');
    assert.equal(image.result, PNG_1X1_B64);
    assert.ok(payload.output_text && payload.output_text.length > 0, 'output_text 不能为空（不能只有图片）');

    const history = await historyEntry(env, sessionKey);
    const images = assistantImages(history);
    assert.equal(images.length, 1, 'history assistant 应保留图片');
    assert.equal(images[0].b64, PNG_1X1_B64);
    assert.equal(images[0].format, 'png');
  } finally {
    await env.cleanup();
  }
});

test('responses 图片-only（流式）：image_generation_call.completed/output_item + response.completed 图片', async () => {
  const env = await setup();
  try {
    env.duck.enqueueChat(imageOnly());
    const { response, events } = await collectSSE(env.baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: '画一只橘猫', tools: [{ type: 'image_generation' }], stream: true }
    });
    assert.equal(response.status, 200);
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.includes('response.image_generation_call.in_progress'), names.join(','));
    assert.ok(names.includes('response.image_generation_call.completed'), names.join(','));
    assert.ok(names.includes('response.output_item.added'), names.join(','));
    assert.equal(names.at(-1), 'response.completed');
    const payloads = events.filter((event) => event.json && typeof event.json === 'object').map((event) => event.json);
    const imageDone = payloads.find(
      (payload) => payload.type === 'response.image_generation_call.completed' && typeof payload.result === 'string'
    );
    assert.ok(imageDone, '缺少带 result 的 image_generation_call.completed');
    assert.equal(imageDone.result, PNG_1X1_B64);
    const completed = payloads.at(-1).response;
    const imageItem = (completed.output || []).find((item) => item.type === 'image_generation_call');
    assert.ok(imageItem, '最终 output 应有 image item');
    assert.equal(imageItem.result, PNG_1X1_B64);
    assert.ok(completed.output_text && completed.output_text.length > 0);
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2) chat/completions 图片-only                                        */
/* ------------------------------------------------------------------ */

test('chat 图片-only：message.images 有真实 data URI，history images 保留', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-image-only-chat';
  try {
    env.duck.enqueueChat(imageOnly());
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只橘猫' }],
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(res.status, 200, res.text);
    const message = res.json.choices[0].message;
    assert.ok(Array.isArray(message.images) && message.images.length === 1, 'message.images 应有图片');
    const image = message.images[0];
    const url = image.image_url?.url || image.url || image.b64_json;
    assert.match(String(url), /^(data:image\/(png|jpeg|jpg);base64,|[A-Za-z0-9+/=]+$)/, '应是 data URI 或 base64');
    if (image.image_url?.url) assert.match(image.image_url.url, /^data:image\/png;base64,/);
    assert.ok(image.b64_json, '应有 b64_json');

    const history = await historyEntry(env, sessionKey);
    const images = assistantImages(history);
    assert.equal(images.length, 1);
    assert.equal(images[0].b64, PNG_1X1_B64);
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3) 跨轮占位文本：真实 image part 不丢                                  */
/* ------------------------------------------------------------------ */

test('responses 跨轮：客户端只回占位文本，上游仍带真实 image part；history 不降级', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-image-replay-resp';
  try {
    env.duck.enqueueChat(imageOnly());
    env.duck.enqueueChat({ textDeltas: ['这是上一张图的说明。'] });
    const first = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: '画一只橘猫', tools: [{ type: 'image_generation' }] }
    });
    assert.equal(first.status, 200, first.text);

    // 下一轮：客户端只回放占位文本，不含 image_generation_call / image part
    const second = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: PLACEHOLDER }
    });
    assert.equal(second.status, 200, second.text);
    const messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    const parts = imageParts(messages);
    assert.ok(parts.length >= 1, '上游应恢复真实 image part');
    assert.match(String(parts[0].image || ''), /^data:image\/png;base64,/);
    const flatText = JSON.stringify(messages);
    assert.ok(flatText.includes('（上一轮生成的图片）'), '占位文本应被替换为图片标记');
    assert.ok(!flatText.includes(PLACEHOLDER), '不应把占位文本作为普通 user 文本发送');

    const history = await historyEntry(env, sessionKey);
    const images = allHistoryImages(history);
    assert.ok(images.length >= 1, 'history 应保留图片（assistant 或回放 user 上的 images）');
    assert.equal(images[0].b64, PNG_1X1_B64);
    const historyText = JSON.stringify((history.messages || []).map((message) => ({ role: message.role, content: message.content })));
    assert.ok(!historyText.includes(PLACEHOLDER), 'history 不应把图片降级为占位文本');
  } finally {
    await env.cleanup();
  }
});

test('chat 跨轮：同 session 占位文本回放时上游仍带真实 image part', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-image-replay-chat';
  try {
    env.duck.enqueueChat(imageOnly());
    env.duck.enqueueChat({ textDeltas: ['已结合上一张图回答。'] });
    const first = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只橘猫' }],
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(first.status, 200, first.text);

    const second = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: PLACEHOLDER }] }
    });
    assert.equal(second.status, 200, second.text);
    const messages = env.duck.calls.chat.at(-1)?.params?.messages || [];
    const parts = imageParts(messages);
    assert.ok(parts.length >= 1, 'chat 上游应恢复真实 image part');
    assert.match(String(parts[0].image || ''), /^data:image\/png;base64,/);
    assert.ok(!JSON.stringify(messages).includes(PLACEHOLDER), '不应回放占位文本');

    const history = await historyEntry(env, sessionKey);
    assert.ok(allHistoryImages(history).length >= 1, 'history 应保留图片（可回放在 user 上）');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 4) 连续两轮图片不丢                                                  */
/* ------------------------------------------------------------------ */

test('连续两轮图片：第二轮再生成后，第三轮上游同时保留 A+B 图片', async () => {
  const env = await setup();
  const sessionKey = 'sess-qa-image-two-turns';
  const PNG_A = PNG_1X1_B64;
  const PNG_B = Buffer.from(PNG_1X1_B64, 'base64').toString('base64'); // 同图用于去重场景会丢，改用不同图片
  // 构造第二张可区分的 2x2 PNG（纯红），避免被去重
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 2, height: 2 });
  png.data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const SECOND_B64 = PNG.sync.write(png).toString('base64');
  try {
    env.duck.enqueueChat(imageOnly());
    env.duck.enqueueChat({ textDeltas: [], images: [{ b64: SECOND_B64, format: 'png' }] });
    env.duck.enqueueChat({ textDeltas: ['两张图都保留。'] });

    const first = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: '画第一张图', tools: [{ type: 'image_generation' }] }
    });
    assert.equal(first.status, 200, first.text);

    // 第二轮：客户端只回占位文本，再生成第二张图
    const second = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: `${PLACEHOLDER} 再画一张红色的图`, tools: [{ type: 'image_generation' }] }
    });
    assert.equal(second.status, 200, second.text);
    const secondPayload = JSON.parse(second.text);
    const secondImage = (secondPayload.output || []).find((item) => item.type === 'image_generation_call');
    assert.equal(secondImage?.result, SECOND_B64);

    // 第三轮：继续普通问题（占位文本回放）→ 上游应同时带 A+B
    const third = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: `${PLACEHOLDER} 描述这两张图` }
    });
    assert.equal(third.status, 200, third.text);
    const parts = imageParts(env.duck.calls.chat.at(-1)?.params?.messages || []);
    assert.ok(parts.length >= 2, `上游应保留两张图片（实际 ${parts.length}）`);
    const { PNG: PngReader } = await import('pngjs');
    const decoded = parts.map((part) => {
      const b64 = String(part.image || '').split(',')[1] || '';
      return PngReader.sync.read(Buffer.from(b64, 'base64'));
    });
    const dims = decoded.map((png) => `${png.width}x${png.height}`);
    assert.ok(dims.includes('1x1'), `应包含第一张 1x1 图（实际 ${dims.join(',')}）`);
    assert.ok(dims.includes('2x2'), `应包含第二张 2x2 图（实际 ${dims.join(',')}）`);

    const history = await historyEntry(env, sessionKey);
    const b64s = allHistoryImages(history).map((image) => image.b64);
    assert.ok(b64s.includes(PNG_A), 'history 应保留第一张图');
    assert.ok(b64s.includes(SECOND_B64), 'history 应保留第二张图');
  } finally {
    await env.cleanup();
  }
});
