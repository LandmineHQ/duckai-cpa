/**
 * OpenAI 兼容层：POST /v1/responses（Responses API，非流式 + 流式）。
 *
 * 覆盖：
 *   - 非流式 response 对象（object/status/output/output_text/usage/annotations）
 *   - input 字符串/消息数组、instructions 注入、reasoning.effort、tools web_search/image_generation
 *   - 流式官方事件序列 + sequence_number 严格递增 + url_citation 注解事件 + 图片事件 + 错误事件
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  withServer,
  makeConfig,
  request,
  v1Request,
  collectSSE,
  decodeImageBase64,
  isPNG
} from './helpers/test-server.js';
import { MockDuckClient, DEFAULT_SOURCES, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { DuckError } from '../src/duck/index.js';

const ADMIN = {};

function newDuck(chat = {}) {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, ...chat };
  return duck;
}

function streamJson(events) {
  return events.filter((event) => event.json).map((event) => event.json);
}

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */

test('非流式：response 对象结构 + instructions 注入 + 参数透传', async () => {
  const duck = newDuck({ textDeltas: ['天空', '是', '蓝色', '的'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '为什么天空是蓝色的？', instructions: '请简洁回答' }
    });
    assert.equal(res.status, 200);
    const body = res.json;
    assert.match(body.id, /^resp_/);
    assert.equal(body.object, 'response');
    assert.equal(typeof body.created_at, 'number');
    assert.equal(body.status, 'completed');
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.output_text, '天空是蓝色的');
    assert.ok(Array.isArray(body.output));

    const messageItem = body.output.find((item) => item.type === 'message');
    assert.ok(messageItem, 'missing message output item');
    assert.equal(messageItem.role, 'assistant');
    assert.equal(messageItem.status, 'completed');
    assert.equal(messageItem.content[0].type, 'output_text');
    assert.equal(messageItem.content[0].text, '天空是蓝色的');
    assert.deepEqual(messageItem.content[0].annotations, []);

    assert.equal(typeof body.usage.input_tokens, 'number');
    assert.equal(typeof body.usage.output_tokens, 'number');
    assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens);
    assert.deepEqual(body.annotations, []);

    // 指令以 inline 方式进入首条 user 消息
    const messages = duck.calls.chat[0].params.messages;
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /\[系统指令\] 请简洁回答/);
    assert.match(messages[0].content, /\[用户\] 为什么天空是蓝色的？/);
  });
});

test('非流式：input 消息数组 + reasoning.effort + tools web_search 注解', async () => {
  const duck = newDuck({
    textDeltas: ['纽约', '今天', '约12°C'],
    reasoningDeltas: ['需要', '查询天气'],
    sources: DEFAULT_SOURCES
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        reasoning: { effort: 'low' },
        tools: [{ type: 'web_search' }],
        input: [
          { role: 'system', content: '你是天气助手' },
          { role: 'user', content: [{ type: 'input_text', text: '纽约今天天气？' }] }
        ]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-duckai-reasoning-effort'), 'low');
    assert.equal(duck.calls.chat[0].params.reasoningEffort, 'low');
    assert.equal(duck.calls.chat[0].params.webSearch, true);

    const messageItem = res.json.output.find((item) => item.type === 'message');
    const part = messageItem.content[0];
    assert.equal(part.text, '纽约今天约12°C');
    assert.equal(part.annotations.length, 2);
    assert.equal(part.annotations[0].type, 'url_citation');
    assert.equal(part.annotations[0].url_citation.url, DEFAULT_SOURCES[0].url);
    assert.equal(res.json.annotations.length, 2);

    const reasoningItem = res.json.output.find((item) => item.type === 'reasoning');
    assert.ok(reasoningItem, 'reasoning summary item missing');
    assert.equal(reasoningItem.summary[0].type, 'summary_text');
    assert.equal(reasoningItem.summary[0].text, '需要查询天气');
  });
});

test('非流式：tools image_generation → output_item image_generation_call（b64 可解码）', async () => {
  const duck = newDuck({
    textDeltas: ['画好了'],
    images: [{ b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024, modelDisplayName: 'GPT Image 2' }]
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: '画一只戴墨镜的鸭子',
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(duck.calls.chat[0].params.imageGeneration, true);
    const imageItem = res.json.output.find((item) => item.type === 'image_generation_call');
    assert.ok(imageItem, 'missing image_generation_call output item');
    assert.equal(imageItem.status, 'completed');
    assert.ok(isPNG(decodeImageBase64(imageItem.result)));
  });
});

test('请求校验：input 缺失/空、未知 input item、非法 reasoning.effort', async () => {
  const duck = newDuck();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const post = (body) => v1Request(baseUrl, '/v1/responses', { method: 'POST', body });

    const noInput = await post({ model: 'gpt-6-luna' });
    assert.equal(noInput.status, 400);
    assert.match(noInput.json.error.message, /"input"/);

    const emptyInput = await post({ model: 'gpt-6-luna', input: [] });
    assert.equal(emptyInput.status, 400);

    const badItem = await post({ model: 'gpt-6-luna', input: [{ type: 'function_call', name: 'x' }] });
    assert.equal(badItem.status, 400);
    assert.match(badItem.json.error.message, /input/i);

    const badEffort = await post({ model: 'gpt-6-luna', input: 'hi', reasoning: { effort: 'extreme' } });
    assert.equal(badEffort.status, 400);
    assert.equal(badEffort.json.error.code, 'invalid_reasoning_effort');

    assert.equal(duck.calls.chat.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */

test('流式：官方事件序列 + sequence_number 递增 + 文本增量', async () => {
  const duck = newDuck({ textDeltas: ['你', '好', '！'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: '打个招呼', stream: true }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const named = events.filter((event) => event.event);
    const sequence = named.map((event) => event.event);
    assert.equal(sequence[0], 'response.created');
    assert.equal(sequence[1], 'response.in_progress');
    assert.ok(sequence.includes('response.output_item.added'));
    assert.ok(sequence.includes('response.content_part.added'));
    assert.ok(sequence.filter((name) => name === 'response.output_text.delta').length >= 3);
    assert.ok(sequence.includes('response.output_text.done'));
    assert.ok(sequence.includes('response.content_part.done'));
    assert.ok(sequence.includes('response.output_item.done'));
    assert.equal(sequence.at(-1), 'response.completed');

    // 每个事件都带 type 与递增 sequence_number
    const payloads = named.map((event) => event.json);
    payloads.forEach((payload, index) => {
      assert.equal(payload.type, named[index].event, 'event name must match payload.type');
      assert.equal(payload.sequence_number, index, 'sequence_number must be contiguous from 0');
    });

    const text = payloads
      .filter((payload) => payload.type === 'response.output_text.delta')
      .map((payload) => payload.delta)
      .join('');
    assert.equal(text, '你好！');

    const completed = payloads.at(-1).response;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.object, 'response');
    assert.equal(completed.output_text, '你好！');
    const messageItem = completed.output.find((item) => item.type === 'message');
    assert.equal(messageItem.content[0].type, 'output_text');
    assert.equal(messageItem.content[0].text, '你好！');
    assert.ok(completed.usage);
    assert.equal(typeof completed.usage.output_tokens, 'number');
  });
});

test('流式：web_search → output_text.annotation.added（url_citation）+ completed.annotations', async () => {
  const duck = newDuck({ textDeltas: ['纽约', '12°C'], sources: DEFAULT_SOURCES });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/responses', {
      body: {
        model: 'gpt-6-luna',
        input: '纽约天气',
        stream: true,
        tools: [{ type: 'web_search' }]
      }
    });
    assert.equal(duck.calls.chat[0].params.webSearch, true);
    const payloads = streamJson(events);
    const annotationEvents = payloads.filter((payload) => payload.type === 'response.output_text.annotation.added');
    assert.equal(annotationEvents.length, 2);
    assert.equal(annotationEvents[0].annotation.type, 'url_citation');
    assert.equal(annotationEvents[0].annotation.url_citation.url, DEFAULT_SOURCES[0].url);
    assert.equal(annotationEvents[0].annotation_index, 0);

    const completed = payloads.at(-1).response;
    assert.equal(completed.annotations.length, 2);
    const part = completed.output.find((item) => item.type === 'message').content[0];
    assert.equal(part.annotations.length, 2);

    // 注解事件必须在 output_text.done 之前
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.indexOf('response.output_text.annotation.added') < names.indexOf('response.output_text.done'));
  });
});

test('流式：image_generation → response.image_generation_call.* 事件 + 最终 output item', async () => {
  const duck = newDuck({
    textDeltas: ['好的'],
    images: [{ b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024 }]
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/responses', {
      body: {
        model: 'gpt-6-luna',
        input: '画鸭子',
        stream: true,
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(duck.calls.chat[0].params.imageGeneration, true);
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.includes('response.image_generation_call.in_progress'));
    assert.ok(names.includes('response.image_generation_call.completed'));
    assert.equal(names.at(-1), 'response.completed');

    const payloads = streamJson(events);
    const done = payloads.find(
      (payload) =>
        payload.type === 'response.image_generation_call.completed' && typeof payload.result === 'string'
    );
    assert.ok(done, 'missing image_generation_call.completed with result');
    assert.ok(isPNG(decodeImageBase64(done.result)));

    const completed = payloads.at(-1).response;
    const imageItem = completed.output.find((item) => item.type === 'image_generation_call');
    assert.ok(imageItem);
    assert.equal(imageItem.status, 'completed');
  });
});

test('流式：首事件前上游错误 → 直接 HTTP JSON（429/502），不进入 SSE', async () => {
  const duck = newDuck({
    error: new DuckError('匿名额度已用尽', { status: 429, type: 'ERR_RATE_LIMIT', retriable: true })
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: 'hi', stream: true }
    });
    assert.equal(res.status, 429);
    assert.match(String(res.headers.get('content-type')), /application\/json/);
    assert.equal(res.json.error.type, 'rate_limit_exceeded');
    assert.equal(res.json.error.code, 'rate_limit_exceeded');
    assert.doesNotMatch(res.text, /response\.failed|response\.completed/);
  });
});

test('流式：已开始流式后上游错误 → response.failed + error 事件，且无 response.completed', async () => {
  const duck = newDuck({
    textDeltas: ['部分'],
    errorAfterText: new DuckError('中间断开', { status: 500, type: 'upstream_failure', retriable: true })
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: 'hi', stream: true }
    });
    assert.equal(response.status, 200);
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.includes('response.failed'));
    assert.ok(names.includes('error'));
    assert.ok(!names.includes('response.completed'));

    const failed = streamJson(events).find((payload) => payload.type === 'response.failed');
    assert.equal(failed.response.status, 'failed');
    assert.ok(failed.response.error);
    assert.equal(failed.response.error.code, 'upstream_failure');

    const errorEvent = streamJson(events).find((payload) => payload.type === 'error');
    assert.equal(errorEvent.code, 'upstream_failure');
  });
});

test('流式：推理 summary 事件（response.reasoning_summary_text.*）', async () => {
  const duck = newDuck({ textDeltas: ['答案'], reasoningDeltas: ['思考', '过程'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: 'hi', stream: true, reasoning: { effort: 'low' } }
    });
    const names = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(names.includes('response.reasoning_summary_part.added'));
    assert.ok(names.includes('response.reasoning_summary_text.delta'));
    assert.ok(names.includes('response.reasoning_summary_text.done'));

    const payloads = streamJson(events);
    const deltas = payloads
      .filter((payload) => payload.type === 'response.reasoning_summary_text.delta')
      .map((payload) => payload.delta)
      .join('');
    assert.equal(deltas, '思考过程');

    const completed = payloads.at(-1).response;
    const reasoningItem = completed.output.find((item) => item.type === 'reasoning');
    assert.ok(reasoningItem);
    assert.equal(reasoningItem.summary[0].text, '思考过程');
  });
});
