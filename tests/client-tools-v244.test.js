/**
 * v2.44：客户端工具桥（Completions ↔ Responses 自动转换）+ 图片输入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, v1Request, collectSSE } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

const RESPONSES_TOOL = {
  type: 'function',
  name: 'read_file',
  description: '读取文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
};

const TOOL_TEXT = '{"tool_call":{"name":"read_file","arguments":{"path":"src/index.js"}}}';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function newDuck() {
  return new MockDuckClient();
}

/* ------------------------------------------------------------------ */
/* Chat Completions                                                    */
/* ------------------------------------------------------------------ */

test('chat tools：返回 tool_calls，客户端 role:"tool" 回传后继续', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  duck.enqueueChat({ textDeltas: ['文件内容如下…'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '读取 src/index.js' }], tools: [READ_TOOL] }
    });
    assert.equal(first.status, 200, first.text);
    const payload = JSON.parse(first.text);
    const choice = payload.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, null);
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].type, 'function');
    assert.equal(choice.message.tool_calls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: 'src/index.js' });

    // 协议注入到上游最后一条 user 消息
    const upstream = JSON.stringify(duck.calls.chat[0].params.messages);
    assert.ok(upstream.includes('工具调用协议'));
    assert.ok(upstream.includes('read_file'));

    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '读取 src/index.js' },
          { role: 'assistant', content: null, tool_calls: choice.message.tool_calls },
          { role: 'tool', tool_call_id: choice.message.tool_calls[0].id, name: 'read_file', content: 'console.log(1)' }
        ],
        tools: [READ_TOOL]
      }
    });
    assert.equal(second.status, 200, second.text);
    const payload2 = JSON.parse(second.text);
    assert.equal(payload2.choices[0].finish_reason, 'stop');
    assert.equal(payload2.choices[0].message.content, '文件内容如下…');
    const secondPrompt = JSON.stringify(duck.calls.chat.at(-1).params.messages);
    assert.ok(secondPrompt.includes('tool_result'), '工具结果应回填上游');
  });
});

test('chat tools（流式）：delta.tool_calls + finish_reason=tool_calls', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '读文件' }], tools: [READ_TOOL], stream: true }
    });
    assert.equal(response.status, 200);
    const deltas = events
      .filter((event) => event.json?.choices?.[0]?.delta?.tool_calls)
      .flatMap((event) => event.json.choices[0].delta.tool_calls);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].function.name, 'read_file');
    const finish = events
      .filter((event) => event.json?.choices?.[0]?.finish_reason)
      .at(-1);
    assert.equal(finish.json.choices[0].finish_reason, 'tool_calls');
  });
});

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

test('responses tools：输出 function_call item；function_call_output 回传后继续', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  duck.enqueueChat({ textDeltas: ['这是文件内容。'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '读取 src/index.js', tools: [RESPONSES_TOOL] }
    });
    assert.equal(first.status, 200, first.text);
    const payload = JSON.parse(first.text);
    const call = (payload.output || []).find((item) => item.type === 'function_call');
    assert.ok(call, `应包含 function_call：${JSON.stringify(payload.output)}`);
    assert.equal(call.name, 'read_file');
    assert.equal(call.status, 'completed');
    assert.ok(call.call_id);
    assert.deepEqual(JSON.parse(call.arguments), { path: 'src/index.js' });

    const second = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '读取 src/index.js' },
          call,
          { type: 'function_call_output', call_id: call.call_id, output: 'console.log(1)' },
          { role: 'user', content: '总结一下' }
        ],
        tools: [RESPONSES_TOOL]
      }
    });
    assert.equal(second.status, 200, second.text);
    const payload2 = JSON.parse(second.text);
    assert.equal(payload2.output_text, '这是文件内容。');
    const prompt = JSON.stringify(duck.calls.chat.at(-1).params.messages);
    assert.ok(prompt.includes('tool_result'), 'function_call_output 应回填上游');
  });
});

test('responses tools（流式）：function_call 事件序列', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/responses', {
      body: { model: 'gpt-6-luna', input: '读文件', tools: [RESPONSES_TOOL], stream: true }
    });
    assert.equal(response.status, 200);
    const types = events.filter((event) => event.event).map((event) => event.event);
    assert.ok(types.includes('response.output_item.added'));
    assert.ok(types.includes('response.function_call_arguments.done'));
    const doneArgs = events.find((event) => event.event === 'response.function_call_arguments.done');
    assert.deepEqual(JSON.parse(doneArgs.json.arguments), { path: 'src/index.js' });
  });
});

/* ------------------------------------------------------------------ */
/* 图片输入                                                            */
/* ------------------------------------------------------------------ */

test('chat 图片输入：image_url data URL → 上游 images（供“修改上一张图”使用）', async () => {
  const duck = newDuck();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '把这张图改成水彩风格' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const messages = duck.calls.chat[0].params.messages;
    const user = messages.find((message) => message.role === 'user');
    assert.ok(Array.isArray(user.images) && user.images.length === 1, '应保留图片');
    assert.ok(user.images[0].dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(!user.content.includes('iVBORw0KGgo'), 'base64 不应混进文本');
  });
});

test('非 data URL 图片被忽略（不发起额外网络请求）', async () => {
  const duck = newDuck();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看看这张图' },
              { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const messages = duck.calls.chat[0].params.messages;
    const user = messages.find((message) => message.role === 'user');
    assert.equal(user.images, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* 协议自动转换（两种 tools 形状互通）                                 */
/* ------------------------------------------------------------------ */

test('chat 端点接受 Responses 形状 tools（自动归一化）', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '读文件' }], tools: [RESPONSES_TOOL] }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.choices[0].finish_reason, 'tool_calls');
    assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'read_file');
  });
});

test('responses 端点接受 Chat 形状 tools（自动归一化）', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '读文件', tools: [READ_TOOL] }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    const call = (payload.output || []).find((item) => item.type === 'function_call');
    assert.ok(call);
    assert.equal(call.name, 'read_file');
  });
});

test('关闭 tools.clientFunctionCalling 后不注入协议、不返回 tool_calls', async () => {
  const duck = newDuck();
  const config = makeConfig();
  config.tools = { ...(config.tools || {}), clientFunctionCalling: { enabled: false } };
  duck.chatBehavior.textDeltas = [TOOL_TEXT];
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '读文件' }], tools: [READ_TOOL] }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.equal(payload.choices[0].message.tool_calls, undefined);
    const prompt = JSON.stringify(duck.calls.chat[0].params.messages);
    assert.ok(!prompt.includes('工具调用协议'));
  });
});

test('tools 稳定前缀：第二轮请求里的历史消息与第一轮逐字节一致（利于上游 prompt cache）', async () => {
  const duck = newDuck();
  duck.enqueueChat({ textDeltas: ['第一轮回答'] });
  duck.enqueueChat({ textDeltas: ['第二轮回答'] });

  await withServer({ duck }, async ({ baseUrl }) => {
    const first = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '第一轮问题' }], tools: [READ_TOOL] }
    });
    assert.equal(first.status, 200, first.text);
    const assistantText = JSON.parse(first.text).choices[0].message.content;
    const turn1 = duck.calls.chat[0].params.messages;
    assert.ok(JSON.stringify(turn1).includes('工具调用协议'), '协议应在第一条 user');

    const second = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '第一轮问题' },
          { role: 'assistant', content: assistantText },
          { role: 'user', content: '第二轮问题' }
        ],
        tools: [READ_TOOL]
      }
    });
    assert.equal(second.status, 200, second.text);
    const turn2 = duck.calls.chat.at(-1).params.messages;

    // 前缀必须完全一致（旧消息不被改写），否则 duck.ai 前缀缓存会失效
    assert.deepEqual(
      turn2.slice(0, turn1.length),
      turn1,
      '第二轮的历史前缀应与第一轮相同'
    );
    assert.equal(JSON.stringify(turn2).match(/工具调用协议/g).length, 1, '协议只注入一次（第一条 user）');
  });
});
