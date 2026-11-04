/**
 * v2.35：天气 continuation（LocationPrompt 审批）与图片响应格式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, v1Request, collectSSE } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { detectImageFormat, imageMimeType, imageDataUri } from '../src/duck/image-format.js';

/** 最小 JPEG（magic FF D8 FF E0），用于验证 MIME 修正。 */
const JPEG_1X1_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

test('图片格式探测：PNG / JPEG 魔数识别 + data URI MIME', () => {
  assert.equal(detectImageFormat(PNG_1X1_B64), 'png');
  assert.equal(detectImageFormat(JPEG_1X1_B64), 'jpeg');
  assert.equal(detectImageFormat('AAAA', 'png'), 'png');
  assert.equal(imageMimeType('jpeg'), 'image/jpeg');
  assert.equal(imageMimeType('jpg'), 'image/jpeg');
  assert.equal(imageMimeType('png'), 'image/png');
  assert.match(imageDataUri(JPEG_1X1_B64, 'jpeg'), /^data:image\/jpeg;base64,\/9j\//);
});

test('/v1/images/generations：b64_json + revised_prompt + 正确 MIME（上游误报 png 时按 JPEG 修正）', async () => {
  const duck = new MockDuckClient();
  // 上游帧里 format 写成 png，但内容是 JPEG → 网关应按魔数修正
  duck.imageBehavior = { images: [{ b64: JPEG_1X1_B64, format: 'png' }] };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: '一只橘猫', response_format: 'b64_json' }
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.text);
    assert.ok(Array.isArray(payload.data) && payload.data.length === 1);
    const item = payload.data[0];
    assert.equal(item.b64_json, JPEG_1X1_B64);
    assert.equal(item.revised_prompt, '一只橘猫');
    assert.equal(item.format, 'jpeg');
    assert.equal(item.mime_type, 'image/jpeg');

    // url 模式：data URI 必须是 image/jpeg
    const urlRes = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: '一只橘猫', response_format: 'url' }
    });
    const urlPayload = JSON.parse(urlRes.text);
    assert.match(urlPayload.data[0].url, /^data:image\/jpeg;base64,/);
  });
});

test('/v1/chat/completions 生图：message.images 输出 OpenAI 兼容的 image_url（data URI）+ b64_json', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = {
    textDeltas: [],
    reasoningDeltas: ['先想一下画面'],
    images: [{ b64: JPEG_1X1_B64, format: 'png' }]
  };
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只橘猫' }],
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.text);
    const message = payload.choices[0].message;
    assert.equal(message.role, 'assistant');
    assert.ok(Array.isArray(message.images) && message.images.length === 1);
    const image = message.images[0];
    assert.equal(image.type, 'image_url');
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(image.b64_json, JPEG_1X1_B64);
    assert.equal(image.format, 'jpeg');
    assert.equal(image.mime_type, 'image/jpeg');
  });
});

test('流式 /v1/chat/completions 生图：chunk.delta.images 也是 image_url 形状', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { textDeltas: ['好了'], images: [{ b64: JPEG_1X1_B64, format: 'png' }] };
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只橘猫' }],
        tools: [{ type: 'image_generation' }],
        stream: true
      }
    });
    assert.equal(response.status, 200);
    const images = events
      .filter((event) => event.json && event.json.choices)
      .flatMap((event) => event.json.choices[0]?.delta?.images || []);
    assert.ok(images.length >= 1, '流式响应应包含图片 chunk');
    assert.equal(images[0].type, 'image_url');
    assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
  });
});
