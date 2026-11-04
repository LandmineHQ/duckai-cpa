/**
 * OpenAI 兼容层：POST /v1/chat/completions（非流式 + 流式）。
 *
 * 通过 createServer 注入 mock DuckClient，验证：
 *   - 请求归一化（messages/system/developer、模型别名、reasoning_effort 映射）
 *   - 非流式 chat.completion 结构（content/usage/annotations/images）
 *   - 流式 chat.completion.chunk 结构（角色帧 → 文本增量 → finish_reason → [DONE]）
 *   - 搜索注解 url_citation、图片 b64_json、stream_options.include_usage
 *   - 上游错误映射（418→502、429→429、5xx→502）与请求校验错误
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

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */

test('非流式：chat.completion 结构 + 请求参数透传', async () => {
  const duck = newDuck({ textDeltas: ['你好', '，', '世界', '！'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '你好' }] }
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('x-duckai-model'), 'gpt-6-luna');
    assert.equal(res.headers.get('x-duckai-reasoning-effort'), 'none');

    const body = res.json;
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(body.object, 'chat.completion');
    assert.equal(typeof body.created, 'number');
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.choices.length, 1);
    const choice = body.choices[0];
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, '你好，世界！');
    assert.equal(choice.message.refusal, null);
    assert.equal(typeof body.usage.prompt_tokens, 'number');
    assert.equal(typeof body.usage.completion_tokens, 'number');
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
    assert.equal(body.usage.estimated, true);

    // 透传给 DuckClient 的参数
    assert.equal(duck.calls.chat.length, 1);
    const call = duck.calls.chat[0].params;
    assert.equal(call.model, 'gpt-6-luna');
    assert.equal(call.reasoningEffort, 'none');
    assert.equal(call.webSearch, false);
    assert.equal(call.imageGeneration, false);
    assert.deepEqual(call.messages, [{ role: 'user', content: '你好' }]);
  });
});

test('模型别名与默认模型：duck- 前缀 / gpt-6 / 省略 model', async () => {
  for (const requested of ['duck-gpt-6-luna', 'gpt-6', undefined]) {
    const duck = newDuck({ textDeltas: ['ok'] });
    await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      if (requested !== undefined) body.model = requested;
      const res = await v1Request(baseUrl, '/v1/chat/completions', { method: 'POST', body });
      assert.equal(res.status, 200, `requested=${requested}`);
      assert.equal(duck.calls.chat[0].params.model, 'gpt-6-luna');
    });
  }
});

test('reasoning_effort：支持档位透传、不支持档位降级、非法值 400', async () => {
  // low：gpt-6-luna 支持 → 原样透传
  const duck = newDuck();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-duckai-reasoning-effort'), 'low');
    assert.equal(duck.calls.chat[0].params.reasoningEffort, 'low');
  });

  // high：gpt-6-luna 只支持 none/low → 降级为 low 并标记
  const duck2 = newDuck();
  await withServer({ duck: duck2, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', reasoning_effort: 'HIGH', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-duckai-reasoning-effort'), 'low');
    assert.equal(res.headers.get('x-duckai-reasoning-adjusted'), 'true');
    assert.equal(duck2.calls.chat[0].params.reasoningEffort, 'low');
  });

  // 非法枚举 → 400
  const duck3 = newDuck();
  await withServer({ duck: duck3, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', reasoning_effort: 'ultra', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'invalid_reasoning_effort');
    assert.equal(duck3.calls.chat.length, 0, 'invalid request must not reach upstream');
  });
});

test('messages：system/developer 合并 + 多轮历史 + 数组 content + 引用标记清理', async () => {
  const duck = newDuck({ textDeltas: ['天气', '<citation src="0"></citation>', '晴'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'system', content: '你是简洁助手。' },
          { role: 'developer', content: '回答用中文。' },
          { role: 'user', content: [{ type: 'text', text: '北京天气？' }, { type: 'image_url', image_url: { url: 'ignored' } }] },
          { role: 'assistant', content: '正在查询。' },
          { role: 'user', content: '现在呢？' }
        ]
      }
    });
    assert.equal(res.status, 200);
    // 默认 prompts.mode=inline：系统指令拼进首条 user（duck.ai 拒绝 system role）
    const messages = duck.calls.chat[0].params.messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /^\[系统指令\] 你是简洁助手。/);
    assert.match(messages[0].content, /回答用中文。/);
    assert.match(messages[0].content, /\[用户\] 北京天气？/);
    assert.doesNotMatch(messages[0].content, /ignored/, '图片 part 被忽略');
    assert.deepEqual(messages[1], { role: 'assistant', content: '正在查询。' });
    assert.deepEqual(messages[2], { role: 'user', content: '现在呢？' });
    // 正文中的 citation 标记转为 [N]
    assert.equal(res.json.choices[0].message.content, '天气[0]晴');
  });
});

test('messages：prompts.mode=system 时以 system 角色前置', async () => {
  const duck = newDuck();
  const config = makeConfig({ ...ADMIN, prompts: { mode: 'system' } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' }
        ]
      }
    });
    assert.equal(res.status, 200);
    const messages = duck.calls.chat[0].params.messages;
    assert.deepEqual(messages[0], { role: 'system', content: 'be brief' });
    assert.deepEqual(messages[1], { role: 'user', content: 'hi' });
  });
});

test('联网搜索：tools:[{type:"web_search"}] → 触发上游 + url_citation 注解 + sources', async () => {
  const duck = newDuck({ textDeltas: ['纽约', '12°C'], sources: DEFAULT_SOURCES });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '纽约天气' }],
        tools: [{ type: 'web_search' }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(duck.calls.chat[0].params.webSearch, true);
    assert.equal(duck.calls.chat[0].params.imageGeneration, false);

    const message = res.json.choices[0].message;
    assert.ok(Array.isArray(message.annotations));
    assert.equal(message.annotations.length, 2);
    assert.deepEqual(message.annotations[0], {
      type: 'url_citation',
      url_citation: {
        url: DEFAULT_SOURCES[0].url,
        title: DEFAULT_SOURCES[0].title
      }
    });
    assert.ok(Array.isArray(message.sources));
    assert.equal(message.sources[0].url, DEFAULT_SOURCES[0].url);
  });
});

test('联网搜索：顶层 web_search:true 快捷开关等价于 tools', async () => {
  const duck = newDuck({ textDeltas: ['ok'], sources: DEFAULT_SOURCES });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], web_search: true }
    });
    assert.equal(res.status, 200);
    assert.equal(duck.calls.chat[0].params.webSearch, true);
    assert.equal(res.json.choices[0].message.annotations.length, 2);
  });
});

test('图片生成：tools:[{type:"image_generation"}] → message.images b64 可解码', async () => {
  const duck = newDuck({ textDeltas: ['画好了'], images: [{ b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024, modelDisplayName: 'GPT Image 2' }] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只鸭子' }],
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(duck.calls.chat[0].params.imageGeneration, true);
    const images = res.json.choices[0].message.images;
    assert.equal(images.length, 1);
    assert.equal(images[0].format, 'png');
    const bytes = decodeImageBase64(images[0].b64_json);
    assert.ok(bytes.length > 8);
    assert.ok(isPNG(bytes), 'b64_json must decode to PNG bytes');
  });
});

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */

test('流式：chunk 序列（角色帧 → 文本增量 → finish_reason → [DONE]）', async () => {
  const duck = newDuck({ textDeltas: ['你', '好', '，', '世界'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    assert.equal(events.at(-1).data.trim(), '[DONE]');
    const chunks = events.filter((event) => event.json);
    assert.ok(chunks.length >= 6, `expected several chunks, got ${chunks.length}`);

    const objects = chunks.map((event) => event.json);
    for (const chunk of objects) {
      assert.equal(chunk.object, 'chat.completion.chunk');
      assert.match(chunk.id, /^chatcmpl-/);
      assert.equal(typeof chunk.created, 'number');
      assert.equal(chunk.model, 'gpt-6-luna');
      assert.ok(Array.isArray(chunk.choices));
    }
    // 首个 chunk 带 role
    assert.deepEqual(objects[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(objects[0].choices[0].finish_reason, null);

    const text = objects
      .map((chunk) => chunk.choices[0]?.delta?.content || '')
      .join('');
    assert.equal(text, '你好，世界');

    const last = objects.at(-1);
    assert.deepEqual(last.choices[0].delta, {});
    assert.equal(last.choices[0].finish_reason, 'stop');
  });
});

test('流式：搜索注解/图片以 delta 帧下发，include_usage 追加 usage 帧', async () => {
  const duck = newDuck({
    textDeltas: ['答', '案'],
    sources: DEFAULT_SOURCES,
    images: [{ b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024 }]
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: {
        model: 'gpt-6-luna',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'web_search' }, { type: 'image_generation' }]
      }
    });
    assert.equal(response.status, 200);
    const objects = events.filter((event) => event.json).map((event) => event.json);

    const annotationChunk = objects.find((chunk) => chunk.choices?.[0]?.delta?.annotations);
    assert.ok(annotationChunk, 'missing annotations delta chunk');
    const annotation = annotationChunk.choices[0].delta.annotations[0];
    assert.equal(annotation.type, 'url_citation');
    assert.equal(annotation.url_citation.url, DEFAULT_SOURCES[0].url);

    const imageChunk = objects.find((chunk) => chunk.choices?.[0]?.delta?.images);
    assert.ok(imageChunk, 'missing images delta chunk');
    assert.ok(isPNG(decodeImageBase64(imageChunk.choices[0].delta.images[0].b64_json)));

    const usageChunk = objects.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
    assert.ok(usageChunk, 'include_usage must append a usage chunk with empty choices');
    assert.ok(usageChunk.usage);
    assert.equal(typeof usageChunk.usage.total_tokens, 'number');

    assert.equal(events.at(-1).data.trim(), '[DONE]');
  });
});

test('流式：推理增量 → delta.reasoning_content', async () => {
  const duck = newDuck({ textDeltas: ['答'], reasoningDeltas: ['先想', '一想'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', stream: true, reasoning_effort: 'low', messages: [{ role: 'user', content: 'hi' }] }
    });
    const objects = events.filter((event) => event.json).map((event) => event.json);
    const reasoning = objects
      .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content || '')
      .join('');
    assert.equal(reasoning, '先想一想');
  });
});

test('流式：首事件前上游失败 → 直接 HTTP JSON 错误（502/429），不进入 SSE', async () => {
  const duck = newDuck({ error: new DuckError('upstream exploded', { status: 500, type: 'upstream_failure', retriable: true }) });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 502);
    assert.match(String(res.headers.get('content-type')), /application\/json/);
    assert.equal(res.json.error.code, 'upstream_failure');
    assert.equal(res.json.error.type, 'upstream_error');
    assert.doesNotMatch(res.text, /\[DONE\]/);
  });

  const limited = newDuck({ error: new DuckError('rate limited', { status: 429, type: 'ERR_RATE_LIMIT', retriable: true }) });
  await withServer({ duck: limited, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 429);
    assert.equal(res.json.error.type, 'rate_limit_exceeded');
  });
});

test('流式：已经输出增量后上游失败 → SSE error payload + [DONE]', async () => {
  const duck = newDuck({
    textDeltas: ['部分回答'],
    errorAfterText: new DuckError('stream broke mid-way', { status: 500, type: 'upstream_failure', retriable: true })
  });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(response.status, 200);
    const chunks = events.filter((event) => event.json).map((event) => event.json);
    assert.ok(
      chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === '部分回答'),
      'partial content must be delivered before the error'
    );
    const errorEvent = events.find((event) => event.json?.error);
    assert.ok(errorEvent, 'missing error payload in stream');
    assert.equal(errorEvent.json.error.code, 'upstream_failure');
    assert.equal(errorEvent.json.error.type, 'upstream_error');
    assert.equal(events.at(-1).data.trim(), '[DONE]');
  });
});

/* ------------------------------------------------------------------ */
/* 错误映射与请求校验                                                  */
/* ------------------------------------------------------------------ */

test('错误映射：上游 418 → 502、429 → 429、超时 504 语义、retriable 头', async () => {
  const cases = [
    { code: 'ERR_CHALLENGE', status: 418, expected: 502, type: 'upstream_error' },
    { code: 'ERR_RATE_LIMIT', status: 429, expected: 429, type: 'rate_limit_exceeded', normalizedCode: 'rate_limit_exceeded' },
    { code: 'ETIMEDOUT', status: 408, expected: 504, type: 'upstream_timeout' },
    { code: 'boom', status: 500, expected: 502, type: 'upstream_error' }
  ];
  for (const testCase of cases) {
    const duck = newDuck({ error: new DuckError('upstream failure', { status: testCase.status, type: testCase.code, retriable: true }) });
    await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
      });
      assert.equal(res.status, testCase.expected, `upstream ${testCase.status}`);
      assert.equal(res.json.error.type, testCase.type);
      assert.equal(res.json.error.code, testCase.normalizedCode || testCase.code);
      assert.equal(res.headers.get('x-duckai-retriable'), 'true');
    });
  }
});

test('请求校验：空 messages / 非法 role / tool role / 未知模型 / 非对象 tools', async () => {
  const duck = newDuck();
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const post = (body) => v1Request(baseUrl, '/v1/chat/completions', { method: 'POST', body });

    const noMessages = await post({ model: 'gpt-6-luna' });
    assert.equal(noMessages.status, 400);
    assert.equal(noMessages.json.error.code, 'messages_required');

    const badRole = await post({ model: 'gpt-6-luna', messages: [{ role: 'robot', content: 'x' }] });
    assert.equal(badRole.status, 400);
    assert.equal(badRole.json.error.param, 'messages');

    const toolRole = await post({ model: 'gpt-6-luna', messages: [{ role: 'tool', content: 'x' }] });
    assert.equal(toolRole.status, 400);

    const unknownModel = await post({ model: 'gpt-404', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(unknownModel.status, 400);
    assert.equal(unknownModel.json.error.code, 'model_not_found');

    const badTools = await post({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'x' }],
      tools: 'web_search'
    });
    assert.equal(badTools.status, 400);
    assert.equal(badTools.json.error.code, 'invalid_tools');

    const unsupportedTool = await post({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }]
    });
    // v2.23：默认（dropUnsupported=true）静默清理不支持的 tool，请求继续
    assert.equal(unsupportedTool.status, 200, unsupportedTool.text);
    assert.equal(duck.calls.chat.length, 1, '默认策略下请求应继续执行');
    assert.equal(duck.calls.chat[0].params.webSearch, false, 'function tool 不应触发联网');
    assert.equal(duck.calls.chat[0].params.imageGeneration, false);
  });
});

test('工具校验：默认策略丢弃不可用工具；dropUnsupported=false 时才 400', async () => {
  // 1) 默认：服务端关闭 web_search → 静默丢弃，请求继续
  const duck = newDuck();
  const configOff = makeConfig({ ...ADMIN, tools: { webSearch: false } });
  await withServer({ duck, config: configOff }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(duck.calls.chat[0].params.webSearch, false, '服务端关闭的 tool 应被丢弃');
  });

  // 2) 默认：mistral-small-2603 不支持任何工具 → 丢弃，不报错
  const duck2 = newDuck();
  await withServer({ duck: duck2, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'mistral-small-2603', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(duck2.calls.chat[0].params.webSearch, false);
  });

  // 3) strict：服务端关闭 → 400 tool_disabled
  const duck3 = newDuck();
  await withServer(
    {
      duck: duck3,
      config: makeConfig({ ...ADMIN, tools: { webSearch: false }, models: { tools: { dropUnsupported: false } } })
    },
    async ({ baseUrl }) => {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'tool_disabled');
    }
  );

  // 4) strict：模型不支持 → 400 tool_not_supported（不触达上游）
  const duck4 = newDuck();
  await withServer(
    { duck: duck4, config: makeConfig({ ...ADMIN, models: { tools: { dropUnsupported: false } } }) },
    async ({ baseUrl }) => {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'mistral-small-2603', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'tool_not_supported');
      assert.equal(duck4.calls.chat.length, 0);
    }
  );

  // 5) strict：不支持的 tool 类型 → 400 unsupported_tool（function 已由网关支持，用 code_interpreter 验证）
  const duck5 = newDuck();
  await withServer(
    { duck: duck5, config: makeConfig({ ...ADMIN, models: { tools: { dropUnsupported: false } } }) },
    async ({ baseUrl }) => {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'gpt-6-luna',
          messages: [{ role: 'user', content: 'x' }],
          tools: [{ type: 'code_interpreter' }]
        }
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'unsupported_tool');
    }
  );
});

test('每模型工具开关：关闭 web_search 后请求不再联网；strict 时报错', async () => {
  const duck = newDuck();
  const config = makeConfig({
    ...ADMIN,
    models: { tools: { dropUnsupported: true, perModel: { 'gpt-6-luna': { web_search: false } } } }
  });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(duck.calls.chat[0].params.webSearch, false, '模型级开关关闭后不应联网');
  });

  const duck2 = newDuck();
  const strictConfig = makeConfig({
    ...ADMIN,
    models: { tools: { dropUnsupported: false, perModel: { 'gpt-6-luna': { web_search: false } } } }
  });
  await withServer({ duck: duck2, config: strictConfig }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search' }] }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'tool_not_supported');
  });
});

test('流式 citation 滤波器：跨 chunk 拆分的引用标记也能正确清理', async () => {
  // 标记被拆成多个 delta 下发（真实上游逐字符流式）
  const duck = newDuck({ textDeltas: ['坏', '天', '<cit', 'ation src="2"', '></citation>', '要', '下雨'] });
  await withServer({ duck, config: makeConfig({ ...ADMIN }) }, async ({ baseUrl }) => {
    const { events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'x' }] }
    });
    const objects = events.filter((event) => event.json).map((event) => event.json);
    const text = objects.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
    assert.equal(text, '坏天[2]要下雨');
    assert.doesNotMatch(text, /<citation|<\/citation>/);
  });
});
