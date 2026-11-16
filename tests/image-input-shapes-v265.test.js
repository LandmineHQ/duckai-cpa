/**
 * v2.65：图片入参形状归一化回归。
 *
 * 背景：客户端用 Anthropic/LiteLLM 风格的 base64 形状传图时
 * （`{type:'image', source:{type:'base64', media_type, data}}`、
 *   `{type:'image', data, mime_type}`）图片被「消息解析组件」静默丢弃——
 *   既没有转发上游多模态，也没有写进会话历史（管理台 #/history 看不到附件）。
 *
 * 约定（v2.65）：
 * - `normalizeImagePart` / `normalizeContentParts` 支持：
 *   OpenAI image_url/input_image（字符串或 {url}）、Anthropic source.base64、
 *   平铺 base64（data/b64 + mime_type/media_type/format）、input_file（mimeType=image/*）。
 * - SSRF 策略不变：只接受 data URL / 内联 base64，不下载远程 URL；
 *   远程 http(s) URL → 400 `image_url_remote_unsupported`（不再静默丢图）。
 * - 修复后 chat 与 responses 两个端点：图片都能进上游 + 进会话历史。
 * 全程 mock DuckClient，不访问真实 duck.ai。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startTestServer, v1Request, adminRequest, makeConfig } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64, JPEG_PARTIAL_B64 } from './helpers/mock-duck.js';
import { createHistoryStore } from '../src/history.js';
import { createNullLogger } from '../src/logger.js';
import { buildUpstreamMessages } from '../src/duck/index.js';
import { normalizeImagePart, normalizeContentParts } from '../src/openai/chat.js';

const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_B64}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_PARTIAL_B64}`;

/** 全部内联 base64 形状（矩阵 A–F/H）→ 期望 MIME + 还原出的 base64。 */
const INLINE_SHAPES = {
  'A image_url{url:data}': { part: { type: 'image_url', image_url: { url: PNG_DATA_URL } }, mime: 'image/png', b64: PNG_1X1_B64 },
  'B image_url:data': { part: { type: 'image_url', image_url: PNG_DATA_URL }, mime: 'image/png', b64: PNG_1X1_B64 },
  'C input_image:data': { part: { type: 'input_image', image_url: PNG_DATA_URL }, mime: 'image/png', b64: PNG_1X1_B64 },
  'D input_image{url:data}': {
    part: { type: 'input_image', image_url: { url: PNG_DATA_URL } },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'E image+source.base64': {
    part: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'E2 source.data(无 media_type，按魔数)': {
    part: { type: 'image', source: { type: 'base64', data: PNG_1X1_B64 } },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'F image+data/mime_type': {
    part: { type: 'image', data: PNG_1X1_B64, mime_type: 'image/png' },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'F2 image+data/media_type': {
    part: { type: 'image', data: PNG_1X1_B64, media_type: 'image/png' },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'F3 image+b64+format': { part: { type: 'image', b64: PNG_1X1_B64, format: 'png' }, mime: 'image/png', b64: PNG_1X1_B64 },
  'F4 image+data/mimeType': {
    part: { type: 'image', data: PNG_1X1_B64, mimeType: 'image/png' },
    mime: 'image/png',
    b64: PNG_1X1_B64
  },
  'H image_url:jpeg data url': { part: { type: 'image_url', image_url: JPEG_DATA_URL }, mime: 'image/jpeg', b64: JPEG_PARTIAL_B64 }
};

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-imgshapes-'));
  const logger = createNullLogger();
  const config = makeConfig();
  const history = await createHistoryStore({ dataDir, config, logger });
  const duck = new MockDuckClient();
  const server = await startTestServer({ config, dataDir, duck, history, logger, cleanup: false });
  return {
    ...server,
    duck,
    history,
    async cleanup() {
      await server.close?.();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/** 上游实际收到的图片（DuckClient.chat params.messages[].images）。 */
function upstreamImages(duck) {
  const messages = duck.calls?.chat?.[0]?.params?.messages || [];
  return messages.flatMap((message) => (Array.isArray(message.images) ? message.images : []));
}

/** 上游最终发出的 image part（经 buildUpstreamMessages，JPEG 会转 PNG）。 */
function upstreamImageParts(duck) {
  const messages = duck.calls?.chat?.[0]?.params?.messages || [];
  return buildUpstreamMessages(messages)
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part && part.type === 'image');
}

async function onlyHistoryItem(env) {
  const list = await adminRequest(env.baseUrl, '/admin/api/history');
  assert.equal(list.status, 200, list.text);
  const items = (list.json.groups || []).flatMap((group) => group.items || []);
  assert.equal(items.length, 1, `应只有 1 条会话历史，实际 ${items.length}`);
  const detail = await adminRequest(env.baseUrl, `/admin/api/history/${items[0].id}`);
  assert.equal(detail.status, 200, detail.text);
  return detail.json.item;
}

function historyImages(historyItem) {
  return (historyItem.messages || []).flatMap((message) => (Array.isArray(message.images) ? message.images : []));
}

/* ------------------------------------------------------------------ */
/* 1) 单元：形状归一化                                                  */
/* ------------------------------------------------------------------ */

test('normalizeImagePart：A–F/H 所有内联 base64 形状都能识别（不再静默丢弃）', () => {
  for (const [label, { part, mime, b64 }] of Object.entries(INLINE_SHAPES)) {
    const image = normalizeImagePart(part);
    assert.ok(image, `${label} 应被识别为图片`);
    assert.equal(image.mimeType, mime, `${label} MIME`);
    assert.equal(image.dataUrl, `data:${mime};base64,${b64}`, `${label} 应还原出原始 base64`);
  }
});

test('normalizeContentParts：文本 + Anthropic/LiteLLM 图片 part 同时保留', () => {
  const normalized = normalizeContentParts([
    { type: 'text', text: '这两张图有什么不同？' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } },
    { type: 'image', data: JPEG_PARTIAL_B64, mime_type: 'image/jpeg' }
  ]);
  assert.equal(normalized.text, '这两张图有什么不同？');
  assert.equal(normalized.images.length, 2, '两张图片都要保留');
  assert.equal(normalized.images[0].mimeType, 'image/png');
  assert.equal(normalized.images[1].mimeType, 'image/jpeg');
  assert.ok(!normalized.text.includes(PNG_1X1_B64), 'base64 不能混进文本');
});

test('normalizeImagePart：input_file 只有 image/*（或图片扩展名）才按图片处理', () => {
  const fromDataUrl = normalizeImagePart({
    type: 'input_file',
    filename: 'a.png',
    mime_type: 'image/png',
    file_data: PNG_DATA_URL
  });
  assert.ok(fromDataUrl);
  assert.equal(fromDataUrl.mimeType, 'image/png');
  assert.equal(fromDataUrl.dataUrl, PNG_DATA_URL);

  const fromB64 = normalizeImagePart({
    type: 'input_file',
    filename: 'b.png',
    mimeType: 'image/png',
    data: PNG_1X1_B64
  });
  assert.ok(fromB64);
  assert.equal(fromB64.dataUrl, PNG_DATA_URL);

  const byExtension = normalizeImagePart({ type: 'input_file', filename: 'c.png', data: PNG_1X1_B64 });
  assert.ok(byExtension, '无 mimeType 时按 .png 扩展名识别');
  assert.equal(byExtension.mimeType, 'image/png');

  // 非图片附件不受影响（PDF/文本仍走文件流程，不在这里变成图片）
  assert.equal(normalizeImagePart({ type: 'input_file', filename: 'doc.pdf', mime_type: 'application/pdf', data: 'JVBERi0=' }), null);
  assert.equal(normalizeImagePart({ type: 'input_file', filename: 'notes.txt', mime_type: 'text/plain', data: 'aGVsbG8=' }), null);
  assert.equal(normalizeImagePart({ type: 'input_file', file_id: 'file_abc' }), null, '只有 file_id 时无法读取内容');
});

test('normalizeImagePart：远程 http(s) URL 明确报错（不下载、不静默丢图）', () => {
  const cases = [
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'image_url', image_url: 'https://example.com/a.png' },
    { type: 'input_image', image_url: 'http://127.0.0.1:9/a.png' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    { type: 'input_file', filename: 'a.png', mime_type: 'image/png', file_url: 'https://example.com/a.png' }
  ];
  for (const part of cases) {
    assert.throws(
      () => normalizeImagePart(part),
      (error) => {
        assert.equal(error.status, 400, JSON.stringify(part));
        assert.equal(error.code, 'image_url_remote_unsupported', JSON.stringify(part));
        assert.match(error.message, /远程图片 URL/);
        return true;
      }
    );
  }
  // 不认识的非 URL 字符串仍按旧行为忽略（不引入新的失败面）
  assert.equal(normalizeImagePart({ type: 'image_url', image_url: { url: 'ignored' } }), null);
  assert.equal(normalizeImagePart({ type: 'image', data: '', mime_type: 'image/png' }), null);
});

/* ------------------------------------------------------------------ */
/* 2) 集成：/v1/chat/completions                                       */
/* ------------------------------------------------------------------ */

test('chat 端点：Anthropic source.base64 图片进上游 + 进历史', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图里有几行字？' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);

    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1, '上游应收到 1 张图片');
    assert.equal(images[0].dataUrl, PNG_DATA_URL);
    assert.equal(upstreamImageParts(env.duck).length, 1, '上游 messages 应含真实 image part');

    const historyItem = await onlyHistoryItem(env);
    const stored = historyImages(historyItem);
    assert.equal(stored.length, 1, '会话历史应保存 1 张图片');
    assert.equal(stored[0].b64, PNG_1X1_B64);
    assert.equal(stored[0].format, 'png');
  } finally {
    await env.cleanup();
  }
});

test('chat 端点：平铺 data+mime_type 图片进上游 + 进历史', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '看图说话' }, { type: 'image', data: PNG_1X1_B64, mime_type: 'image/png' }]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);

    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1, '上游应收到 1 张图片');
    assert.equal(images[0].dataUrl, PNG_DATA_URL);

    const stored = historyImages(await onlyHistoryItem(env));
    assert.equal(stored.length, 1, '会话历史应保存 1 张图片');
    assert.equal(stored[0].b64, PNG_1X1_B64);
  } finally {
    await env.cleanup();
  }
});

test('chat 端点：jpeg 内联 base64 → MIME 保留 image/jpeg，上游最后转 PNG', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '描述颜色' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_PARTIAL_B64 } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1);
    assert.equal(images[0].dataUrl, JPEG_DATA_URL);
    // duck 层只接受 PNG/WebP：转发前统一转 PNG
    const parts = upstreamImageParts(env.duck);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].mimeType, 'image/png');
    const stored = historyImages(await onlyHistoryItem(env));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].format, 'jpeg');
  } finally {
    await env.cleanup();
  }
});

test('chat 端点：远程图片 URL → 400 image_url_remote_unsupported 且不调用上游', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '看看这张图' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]
          }
        ]
      }
    });
    assert.equal(res.status, 400, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.error.code, 'image_url_remote_unsupported');
    assert.equal(env.duck.calls.chat.length, 0, '不应转发上游（也不应尝试下载）');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3) 集成：/v1/responses                                              */
/* ------------------------------------------------------------------ */

test('responses 端点：content part 的 Anthropic source.base64 进上游 + 进历史', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: '这张图里有几行字？' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);

    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1, '上游应收到 1 张图片');
    assert.equal(images[0].dataUrl, PNG_DATA_URL);

    const stored = historyImages(await onlyHistoryItem(env));
    assert.equal(stored.length, 1, '会话历史应保存 1 张图片');
    assert.equal(stored[0].b64, PNG_1X1_B64);
    assert.equal(stored[0].format, 'png');
  } finally {
    await env.cleanup();
  }
});

test('responses 端点：content part 的平铺 data+mime_type 进上游 + 进历史', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '看图说话' }, { type: 'image', data: PNG_1X1_B64, mime_type: 'image/png' }]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1, '上游应收到 1 张图片');
    assert.equal(images[0].dataUrl, PNG_DATA_URL);

    const stored = historyImages(await onlyHistoryItem(env));
    assert.equal(stored.length, 1, '会话历史应保存 1 张图片');
    assert.equal(stored[0].b64, PNG_1X1_B64);
  } finally {
    await env.cleanup();
  }
});

test('responses 端点：顶层 input_file（mimeType=image/png）进上游 + 进历史', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '看看这个附件' },
          { type: 'input_file', filename: 'a.png', mime_type: 'image/png', file_data: PNG_DATA_URL }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const images = upstreamImages(env.duck);
    assert.equal(images.length, 1, '上游应收到 1 张图片');
    assert.equal(images[0].dataUrl, PNG_DATA_URL);

    const stored = historyImages(await onlyHistoryItem(env));
    assert.equal(stored.length, 1, '会话历史应保存 1 张图片');
    assert.equal(stored[0].b64, PNG_1X1_B64);
  } finally {
    await env.cleanup();
  }
});

test('responses 端点：input_file 内联 base64（data+mimeType）也进上游', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '描述这个附件' },
          { type: 'input_file', filename: 'b.png', mimeType: 'image/png', data: PNG_1X1_B64 }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(upstreamImages(env.duck).length, 1);
  } finally {
    await env.cleanup();
  }
});

test('responses 端点：远程图片 URL → 400 image_url_remote_unsupported 且不调用上游', async () => {
  const env = await setup();
  try {
    const res = await v1Request(env.baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '看看这张图' }, { type: 'image_url', image_url: 'https://example.com/a.png' }]
          }
        ]
      }
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(JSON.parse(res.text).error.code, 'image_url_remote_unsupported');
    assert.equal(env.duck.calls.chat.length, 0);
  } finally {
    await env.cleanup();
  }
});
