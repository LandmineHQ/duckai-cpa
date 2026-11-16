/**
 * v2.65：生成图回放被上游 400 时的兜底回归。
 *
 * 背景：生成图按 duck.ai 的 assistant `generated-image` part 回放，要求同一身份/会话；
 * 若会话被路由到另一个身份（无会话标识时的 least-loaded、额度冷却改绑、换模型换池等），
 * 上游会返回 400 ERR_BAD_REQUEST。此时必须自动回退到「PNG ≤512 当用户上传图」的旧通道，
 * 让请求成功（只牺牲清晰度），而不是把 400 暴露给客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DuckClient, buildUpstreamMessages } from '../src/duck/index.js';
import { PNG_1X1_B64 } from './helpers/mock-duck.js';

function makeClient() {
  const client = new DuckClient({
    baseUrl: 'https://duck.ai',
    defaultModel: 'gpt-6-luna',
    strictInit: false,
    // 不需要真实挑战/限流：直接替换底层执行与限流
    systemPromptMode: 'prefix'
  });
  client._respectRateLimit = async () => {};
  return client;
}

const conversation = [
  { role: 'user', content: '画一只橘猫' },
  {
    role: 'assistant',
    content: '',
    images: [{ b64: PNG_1X1_B64, format: 'png', kind: 'generated' }]
  },
  { role: 'user', content: '这张图是什么颜色？' }
];

function generatedPartsIn(body) {
  return (body.messages || [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
    .filter((part) => part && part.type === 'generated-image');
}

function userImagePartsIn(body) {
  return (body.messages || [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part && part.type === 'image');
}

test('v2.65 buildUpstreamMessages：generatedImageFallback 回退到 PNG ≤512 用户图 part', () => {
  const primary = buildUpstreamMessages(conversation);
  const generated = generatedPartsIn({ messages: primary });
  assert.equal(generated.length, 1, '默认按 generated-image 回放');
  assert.equal(generated[0].result, PNG_1X1_B64, '原样 base64');
  assert.ok(Number.isFinite(generated[0].width) && generated[0].width > 0, '必须带 width');
  assert.ok(Number.isFinite(generated[0].height) && generated[0].height > 0, '必须带 height');

  const fallback = buildUpstreamMessages(conversation, { generatedImageFallback: true });
  assert.equal(generatedPartsIn({ messages: fallback }).length, 0, '兜底路径不应再发 generated-image');
  const userImages = userImagePartsIn({ messages: fallback });
  assert.equal(userImages.length, 1, '兜底路径应把生成图当用户上传图发送');
  assert.equal(userImages[0].mimeType, 'image/png');
  assert.match(String(userImages[0].image), /^data:image\/png;base64,/);
});

test('v2.65 chat()：生成图回放被 400 时自动回退并重试一次', async () => {
  const client = makeClient();
  const bodies = [];
  client._executeChat = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    if (bodies.length === 1) {
      const error = new Error('upstream returned HTTP 400');
      error.status = 400;
      error.type = 'bad_request';
      error.code = 'bad_request';
      error.upstreamType = 'ERR_BAD_REQUEST';
      error.retriable = false;
      return { error };
    }
    return {
      value: { content: '橘色', images: [], toolCalls: [], sources: [], reasoning: '', rawEvents: [] }
    };
  };

  const result = await client.chat({ model: 'gpt-6-luna', messages: conversation });
  assert.equal(result.content, '橘色', '回退成功后应返回正常结果');
  assert.equal(bodies.length, 2, '应只重试一次');
  assert.equal(generatedPartsIn(bodies[0]).length, 1, '首次请求按 generated-image 回放');
  assert.equal(generatedPartsIn(bodies[1]).length, 0, '重试请求不再发 generated-image');
  assert.equal(userImagePartsIn(bodies[1]).length, 1, '重试请求改用 user image part（PNG ≤512）');
  assert.equal(client._stats.imageReplayFallbacks, 1, '应记录回退计数');
});

test('v2.65 chat()：回退请求仍失败时把错误暴露给调用方（不无限重试）', async () => {
  const client = makeClient();
  let calls = 0;
  client._executeChat = async () => {
    calls += 1;
    const error = new Error('upstream returned HTTP 400');
    error.status = 400;
    error.type = 'bad_request';
    error.code = 'bad_request';
    error.upstreamType = 'ERR_BAD_REQUEST';
    error.retriable = false;
    return { error };
  };
  await assert.rejects(() => client.chat({ model: 'gpt-6-luna', messages: conversation }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls, 2, '只应重试一次后失败');
});

test('v2.65 chat()：普通文本请求的 400 不触发图片回退', async () => {
  const client = makeClient();
  let calls = 0;
  client._executeChat = async () => {
    calls += 1;
    const error = new Error('upstream returned HTTP 400');
    error.status = 400;
    error.type = 'bad_request';
    error.code = 'bad_request';
    error.upstreamType = 'ERR_BAD_REQUEST';
    error.retriable = false;
    return { error };
  };
  await assert.rejects(() => client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '你好' }] }));
  assert.equal(calls, 1, '无生成图的请求不应重试');
  assert.equal(client._stats.imageReplayFallbacks, 0);
});
