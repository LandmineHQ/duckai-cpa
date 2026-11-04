/**
 * OpenAI 兼容层：POST /v1/images/generations。
 * 覆盖 b64_json / url=data URL 两种响应格式、n 参数、prompt 校验、上游错误映射。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, request, v1Request, decodeImageBase64, isPNG } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { DuckError } from '../src/duck/index.js';

const ADMIN = {};

test('b64_json（默认）：data[0].b64_json 可解码为 PNG，模型与 prompt 透传', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { model: 'gpt-6-luna', prompt: '画一只戴墨镜的卡通鸭子', n: 1 }
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.created, 'number');
    assert.ok(Array.isArray(res.json.data));
    assert.equal(res.json.data.length, 1);
    const bytes = decodeImageBase64(res.json.data[0].b64_json);
    assert.ok(isPNG(bytes), 'b64_json must decode to PNG magic bytes');
    assert.equal(duck.calls.imageGeneration.length, 1);
    assert.equal(duck.calls.imageGeneration[0].params.prompt, '画一只戴墨镜的卡通鸭子');
    assert.equal(duck.calls.imageGeneration[0].params.model, 'gpt-6-luna');
  });
});

test('response_format:"url" → data URL（data:image/png;base64,...）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: '一只鸭子', response_format: 'url' }
    });
    assert.equal(res.status, 200);
    const url = res.json.data[0].url;
    assert.match(url, /^data:image\/png;base64,/);
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    assert.ok(isPNG(bytes));
    assert.equal(res.json.data[0].b64_json, undefined);
  });
});

test('n=2：调用上游两次并返回两张图片', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: '两只鸭子', n: 2 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.length, 2);
    assert.equal(duck.calls.imageGeneration.length, 2);
  });
});

test('请求校验：prompt 必填、n 范围、response_format、size、未知模型', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const post = (body) => v1Request(baseUrl, '/v1/images/generations', { method: 'POST', body });

    const noPrompt = await post({});
    assert.equal(noPrompt.status, 400);
    assert.equal(noPrompt.json.error.code, 'prompt_required');

    const badN = await post({ prompt: 'x', n: 0 });
    assert.equal(badN.status, 400);
    assert.equal(badN.json.error.code, 'invalid_n');

    const badFormat = await post({ prompt: 'x', response_format: 'binary' });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.json.error.code, 'invalid_response_format');

    const badSize = await post({ prompt: 'x', size: 'huge' });
    assert.equal(badSize.status, 400);
    assert.equal(badSize.json.error.code, 'invalid_size');

    const unknownModel = await post({ prompt: 'x', model: 'gpt-404' });
    assert.equal(unknownModel.status, 400);
    assert.equal(unknownModel.json.error.code, 'model_not_found');

    assert.equal(duck.calls.imageGeneration.length, 0);
  });
});

test('配置关闭图片工具：400 tool_disabled', async () => {
  const duck = new MockDuckClient();
  const config = makeConfig({ ...ADMIN, tools: { imageGeneration: false } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: 'x' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'tool_disabled');
  });
});

test('上游无图片：400 no_image_returned；上游限流：429', async () => {
  const duck = new MockDuckClient();
  duck.imageBehavior = { images: [] };
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: 'x' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'no_image_returned');
  });

  const limited = new MockDuckClient();
  limited.imageBehavior = { error: new DuckError('rate limited', { status: 429, type: 'ERR_RATE_LIMIT', retriable: true }) };
  await withServer({ duck: limited, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { prompt: 'x' }
    });
    assert.equal(res.status, 429);
    assert.equal(res.json.error.code, 'rate_limit_exceeded');
    assert.equal(res.json.error.type, 'rate_limit_exceeded');
  });
});
