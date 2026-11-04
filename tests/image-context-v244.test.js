/**
 * v2.44：图片上下文（JPEG → PNG 归一化 / 生成图回放）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { withServer, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { toUpstreamPngDataUrl } from '../src/duck/image-convert.js';

function makeJpeg(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 200;
    data[index * 4 + 1] = 60;
    data[index * 4 + 2] = 40;
    data[index * 4 + 3] = 255;
  }
  return jpeg.encode({ width, height, data }, 80).data;
}

function decodePng(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return PNG.sync.read(Buffer.from(b64, 'base64'));
}

test('image-convert：JPEG 600×300 → PNG 且缩到 ≤512', () => {
  const jpegBuffer = makeJpeg(600, 300);
  const converted = toUpstreamPngDataUrl({ b64: jpegBuffer.toString('base64') }, { maxDimension: 512 });
  assert.ok(converted);
  assert.equal(converted.mimeType, 'image/png');
  assert.ok(converted.dataUrl.startsWith('data:image/png;base64,'));
  const png = decodePng(converted.dataUrl);
  assert.equal(png.width, 512);
  assert.equal(png.height, 256);
});

test('image-convert：小 PNG 原样可解码；未知格式返回 null', () => {
  const png = new PNG({ width: 2, height: 2 });
  png.data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const encoded = PNG.sync.write(png).toString('base64');
  const converted = toUpstreamPngDataUrl({ b64: encoded });
  assert.ok(converted);
  assert.equal(decodePng(converted.dataUrl).width, 2);
  assert.equal(toUpstreamPngDataUrl({ b64: Buffer.from('GIF89a').toString('base64') }), null);
});

test('chat JPEG 图片输入：转发上游前转成 PNG（避免 400）', async () => {
  const duck = new MockDuckClient();
  const jpegB64 = makeJpeg(600, 300).toString('base64');
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图是什么颜色？' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegB64}` } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const messages = duck.calls.chat[0].params.messages;
    const user = messages.find((message) => message.role === 'user');
    assert.ok(user.images?.length === 1);
    // 转换发生在 DuckClient 上传前（buildUpstreamMessages）
    const { buildUpstreamMessages } = await import('../src/duck/index.js');
    const upstream = buildUpstreamMessages(messages);
    const imagePart = upstream
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part.type === 'image');
    assert.ok(imagePart);
    assert.equal(imagePart.mimeType, 'image/png');
    assert.ok(imagePart.image.startsWith('data:image/png;base64,'));
    const png = decodePng(imagePart.image);
    assert.ok(Math.max(png.width, png.height) <= 512);
  });
});

test('responses 生成图回放（JPEG）→ 上游 image part 为 PNG', async () => {
  const duck = new MockDuckClient();
  const jpegB64 = makeJpeg(600, 300).toString('base64');
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '画一张图' },
          { type: 'image_generation_call', id: 'ig_1', status: 'completed', output_format: 'jpeg', result: jpegB64 },
          { role: 'user', content: '把这张图改成水彩风格，并描述颜色。' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const messages = duck.calls.chat[0].params.messages;
    const user = messages.find((message) => Array.isArray(message.images) && message.images.length);
    assert.ok(user, '应保留图片');
    const { buildUpstreamMessages } = await import('../src/duck/index.js');
    const upstream = buildUpstreamMessages(messages);
    const imagePart = upstream
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part.type === 'image');
    assert.ok(imagePart);
    assert.equal(imagePart.mimeType, 'image/png');
    const png = decodePng(imagePart.image);
    assert.ok(Math.max(png.width, png.height) <= 512);
  });
});
