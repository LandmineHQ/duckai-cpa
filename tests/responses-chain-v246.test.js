/**
 * v2.46：Responses API response chaining（previous_response_id）
 * - 网关保存 response 的 conversation + output items；
 * - 下一轮只发新 input，也能重建与完整回放一致的上下文；
 * - tool / image 链路同样可用（图片回放仍走 PNG 转换）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOOL_TEXT = '{"tool_call":{"name":"read_file","arguments":{"path":"package.json"}}}';
const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

test('previous_response_id：只发新 input 也能带上完整历史', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['第一轮回答'] });
  duck.enqueueChat({ textDeltas: ['第二轮回答'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '第一轮问题' }
    });
    assert.equal(first.status, 200, first.text);
    const firstPayload = JSON.parse(first.text);
    assert.ok(firstPayload.id);
    assert.equal(firstPayload.store, true);

    const second = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', previous_response_id: firstPayload.id, input: '第二轮问题' }
    });
    assert.equal(second.status, 200, second.text);
    const secondPayload = JSON.parse(second.text);
    assert.equal(secondPayload.previous_response_id, firstPayload.id);
    assert.equal(secondPayload.output_text, '第二轮回答');

    const messages = duck.calls.chat.at(-1).params.messages;
    const text = JSON.stringify(messages);
    assert.ok(text.includes('第一轮问题'), '应包含第一轮 user');
    assert.ok(text.includes('第一轮回答'), '应包含第一轮 assistant');
    assert.ok(text.includes('第二轮问题'), '应包含第二轮 user');
  });
});

test('previous_response_id：function_call_output 链式回传', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  duck.enqueueChat({ textDeltas: ['package.json 用途是项目元数据。'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '读取 package.json', tools: [TOOL] }
    });
    assert.equal(first.status, 200, first.text);
    const firstPayload = JSON.parse(first.text);
    const call = (firstPayload.output || []).find((item) => item.type === 'function_call');
    assert.ok(call);

    const second = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        previous_response_id: firstPayload.id,
        input: [{ type: 'function_call_output', call_id: call.call_id, output: '{"name":"duckai-cpa"}' }]
      }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).output_text, 'package.json 用途是项目元数据。');
    const text = JSON.stringify(duck.calls.chat.at(-1).params.messages);
    assert.ok(text.includes('tool_result'), '应回放工具结果');
    assert.ok(text.includes('read_file'), '应回放工具调用');
  });
});

test('previous_response_id：生图后继续编辑（图片上下文仍保留）', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [], images: [{ b64: PNG, format: 'jpeg' }] });
  duck.enqueueChat({ textDeltas: ['已生成水彩版本。'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '画一只戴帽子的橘猫', tools: [{ type: 'image_generation' }] }
    });
    assert.equal(first.status, 200, first.text);
    const firstPayload = JSON.parse(first.text);
    const image = (firstPayload.output || []).find((item) => item.type === 'image_generation_call');
    assert.ok(image);

    const second = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', previous_response_id: firstPayload.id, input: '把上一张图改成水彩风格' }
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(JSON.parse(second.text).output_text, '已生成水彩版本。');

    const messages = duck.calls.chat.at(-1).params.messages;
    const userWithImage = messages.find((message) => Array.isArray(message.images) && message.images.length);
    assert.ok(userWithImage, '链式回放应包含图片');
    const { buildUpstreamMessages } = await import('../src/duck/index.js');
    const upstream = buildUpstreamMessages(messages);
    const imagePart = upstream
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part.type === 'image');
    assert.ok(imagePart);
    assert.equal(imagePart.mimeType, 'image/png');
  });
});

test('previous_response_id：store:false 不保存、未知/过期 id → 400', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['ok'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '你好', store: false }
    });
    assert.equal(first.status, 200, first.text);
    const firstPayload = JSON.parse(first.text);
    assert.equal(firstPayload.store, false);

    const missing = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', previous_response_id: firstPayload.id, input: '继续' }
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, 'previous_response_not_found');

    const unknown = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', previous_response_id: 'resp_missing', input: '继续' }
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.code, 'previous_response_not_found');
  });
});
