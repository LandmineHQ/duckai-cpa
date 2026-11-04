/**
 * v2.39：网关级 function calling（OpenAI tools[].function）+ MCP 工具（auto 模式）。
 *
 * 上游 duck.ai 没有 tools schema 通道：网关注入提示词协议、解析模型输出、把 tool_calls
 * 返回给客户端（client 模式）或直接调用 MCP server 执行（auto 模式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { withServer, makeConfig, v1Request, collectSSE } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { parseToolCall, buildToolProtocol, buildUpstreamConversation } from '../src/openai/function-calling.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    }
  }
];

const TOOL_CALL_TEXT = '{"tool_call":{"name":"get_weather","arguments":{"city":"北京"}}}';

function functionCallingConfig(overrides = {}) {
  const config = makeConfig();
  config.tools = {
    ...(config.tools || {}),
    functionCalling: { enabled: true, mode: 'client', maxRounds: 4 },
    mcp: { enabled: false, timeoutMs: 5000, servers: [] },
    ...overrides
  };
  return config;
}

/** 极简 HTTP MCP server：initialize / tools/list / tools/call（返回 echo:<text>）。 */
async function startMockMcpHttp() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const method = payload.method;
    calls.push(method);
    const respond = (body) => {
      const data = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(data);
    };
    if (method === 'initialize') {
      respond({
        jsonrpc: '2.0',
        id: payload.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } }
      });
      return;
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (method === 'tools/list') {
      respond({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          tools: [
            {
              name: 'get_weather',
              description: '查询指定城市的天气',
              inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
          ]
        }
      });
      return;
    }
    if (method === 'tools/call') {
      respond({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: `echo:${payload.params?.arguments?.city || ''}` }], isError: false }
      });
      return;
    }
    res.writeHead(400);
    res.end('bad request');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: async () => new Promise((resolve) => server.close(resolve))
  };
}

async function createMcpManagerFor(url) {
  const { createMcpManager } = await import('../src/tools/mcp-client.js');
  return createMcpManager({
    config: { enabled: true, timeoutMs: 5000, servers: [{ name: 'mock', transport: 'http', url }] },
    logger: { info() {}, warn() {}, debug() {} }
  });
}

test('function calling（client 模式）：返回 tool_calls + finish_reason=tool_calls，客户端回传 tool 后继续', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [TOOL_CALL_TEXT] });
  duck.enqueueChat({ textDeltas: ['北京今天晴，24°C。'] });

  await withServer({ duck, config: functionCallingConfig() }, async ({ baseUrl }) => {
    // 第一轮：模型要求调用工具
    let res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '北京天气？' }], tools: TOOLS }
    });
    assert.equal(res.status, 200);
    let payload = JSON.parse(res.text);
    let choice = payload.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, null);
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].type, 'function');
    assert.equal(choice.message.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: '北京' });

    // 网关应把工具协议注入上游系统提示词
    const firstCall = duck.calls.chat.at(-1);
    const systemText = JSON.stringify(firstCall.params?.messages || []);
    assert.ok(systemText.includes('工具调用协议'), '应注入工具调用协议');
    assert.ok(systemText.includes('get_weather'), '应包含工具名');

    // 第二轮：客户端执行后回传 role:"tool" + assistant tool_calls
    res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        messages: [
          { role: 'user', content: '北京天气？' },
          {
            role: 'assistant',
            content: null,
            tool_calls: payload.choices[0].message.tool_calls
          },
          { role: 'tool', tool_call_id: payload.choices[0].message.tool_calls[0].id, name: 'get_weather', content: '北京今天晴，24°C' }
        ],
        tools: TOOLS
      }
    });
    assert.equal(res.status, 200);
    payload = JSON.parse(res.text);
    choice = payload.choices[0];
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(choice.message.content, '北京今天晴，24°C。');
    assert.equal(choice.message.tool_calls, undefined);
  });
});

test('function calling（auto 模式）：网关调用 MCP server，执行结果回填后返回最终回答', async () => {
  const mcpServer = await startMockMcpHttp();
  const mcp = await createMcpManagerFor(mcpServer.url);
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [TOOL_CALL_TEXT] });
  duck.enqueueChat({ textDeltas: ['北京今天晴，24°C（MCP 工具结果）。'] });

  try {
    await withServer(
      {
        duck,
        config: functionCallingConfig({ functionCalling: { enabled: true, mode: 'auto', maxRounds: 4 } }),
        mcp
      },
      async ({ baseUrl }) => {
        const res = await v1Request(baseUrl, '/v1/chat/completions', {
          method: 'POST',
          body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '北京天气？' }], tools: TOOLS }
        });
        assert.equal(res.status, 200);
        const payload = JSON.parse(res.text);
        const choice = payload.choices[0];
        assert.equal(choice.finish_reason, 'stop');
        assert.equal(choice.message.content, '北京今天晴，24°C（MCP 工具结果）。');
        assert.equal(choice.message.tool_calls, undefined, 'auto 模式不向客户端暴露 tool_calls');

        // MCP server 应收到 tools/call
        assert.ok(mcpServer.calls.includes('tools/call'), `MCP 调用序列: ${mcpServer.calls.join(',')}`);
        // 第二次上游调用应包含工具结果
        const secondCall = duck.calls.chat.at(-1);
        const promptText = JSON.stringify(secondCall.params?.messages || []);
        assert.ok(promptText.includes('tool_result'), '工具结果应回填给模型');
        assert.ok(promptText.includes('echo:北京'), '工具结果内容应回填');
      }
    );
  } finally {
    await mcpServer.close();
  }
});

test('function calling（流式 client 模式）：chunk.delta.tool_calls + finish_reason=tool_calls', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [TOOL_CALL_TEXT] });
  await withServer({ duck, config: functionCallingConfig() }, async ({ baseUrl }) => {
    const { response, events } = await collectSSE(baseUrl, '/v1/chat/completions', {
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '北京天气？' }], tools: TOOLS, stream: true }
    });
    assert.equal(response.status, 200);
    const toolChunks = events
      .filter((event) => event.json && event.json.choices && event.json.choices[0]?.delta?.tool_calls)
      .flatMap((event) => event.json.choices[0].delta.tool_calls);
    assert.ok(toolChunks.length >= 1, '流式应包含 tool_calls delta');
    assert.equal(toolChunks[0].function.name, 'get_weather');
    const finishChunks = events.filter((event) => event.json && event.json.choices && event.json.choices[0]?.finish_reason);
    assert.equal(finishChunks.at(-1).json.choices[0].finish_reason, 'tool_calls');
  });
});

test('function-calling 工具协议与解析：中文/代码块/未知工具容错', () => {
  const tools = [
    { name: 'get_weather', description: '天气', parameters: { type: 'object' } },
    { name: 'search', description: '搜索', parameters: { type: 'object' } }
  ];
  const protocol = buildToolProtocol(tools);
  assert.match(protocol, /工具调用协议/);
  assert.match(protocol, /get_weather/);
  assert.match(protocol, /search/);

  assert.deepEqual(parseToolCall('```json\n{"tool_call":{"name":"get_weather","arguments":{"city":"北京"}}}\n```', tools), {
    name: 'get_weather',
    arguments: { city: '北京' }
  });
  assert.deepEqual(parseToolCall('<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>', tools), {
    name: 'search',
    arguments: { q: 'x' }
  });
  assert.equal(parseToolCall('{"tool_call":{"name":"not_defined","arguments":{}}}', tools), null);
  assert.equal(parseToolCall('普通回答，不需要工具', tools), null);

  const converted = buildUpstreamConversation([
    { role: 'user', content: '问题' },
    { role: 'tool', name: 'get_weather', content: '晴' }
  ]);
  assert.equal(converted[1].role, 'user');
  assert.match(converted[1].content, /tool_result/);
});
