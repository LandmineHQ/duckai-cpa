/**
 * v2.48：提示词注入可观测（历史元数据 / 日志 / 上游调试视图）+ 手动压缩保留工具轨迹。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { withServer, makeConfig, v1Request, adminRequest } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { createHistoryStore } from '../src/history.js';
import { normalizeCompactMessages } from '../src/openai/compact.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};
const TOOL_TEXT = '{"tool_call":{"name":"read_file","arguments":{"path":"package.json"}}}';

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('历史详情 / 日志 / 上游调试视图包含完整工具协议注入', async () => {
  const dataDir = await tempDir('qa-v248-inject-');
  const config = makeConfig();
  const history = await createHistoryStore({ dataDir, config, logger: null });
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['OK'] });

  await withServer({ duck, dataDir, history }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v248-inject', 'x-conversation-mode': 'server' },
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '帮我读 package.json' }],
        tools: [TOOL]
      }
    });
    assert.equal(res.status, 200, res.text);

    const list = await adminRequest(baseUrl, '/admin/api/history');
    const item = (list.json.groups || []).flatMap((group) => group.items).find((entry) => entry.sessionKey === 'sess-v248-inject');
    assert.ok(item, '历史列表应包含会话');
    const detail = await adminRequest(baseUrl, `/admin/api/history/${item.id}`);
    const injection = detail.json.item.injection;
    assert.ok(injection);
    assert.equal(injection.injected, true);
    assert.deepEqual(injection.clientTools, ['read_file']);
    assert.match(injection.protocolText, /工具调用协议/);
    assert.match(injection.protocolText, /read_file/);
    assert.match(injection.firstUserContent, /帮我读 package.json/);
    assert.match(injection.firstUserContent, /工具调用协议/);
    assert.ok(injection.upstreamMessageCount >= 1);

    // 上游调试视图（脱敏 JSON）
    const upstream = await adminRequest(baseUrl, `/admin/api/history/${item.id}/upstream`);
    assert.equal(upstream.status, 200, upstream.text);
    assert.equal(upstream.json.source, 'conversation_state');
    assert.ok(Array.isArray(upstream.json.messages));
    assert.ok(upstream.json.messageCount >= 1);
    assert.match(JSON.stringify(upstream.json.messages), /工具调用协议/);

    // 日志元数据
    const logs = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=50');
    const log = (logs.json.items || []).find((entry) => entry.endpoint === 'POST /v1/chat/completions');
    assert.ok(log);
    assert.equal(log.protocolInjected, true);
    assert.deepEqual(log.clientTools, ['read_file']);
    assert.ok(log.upstreamMessageCount >= 1);
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('Responses 历史也记录注入元数据', async () => {
  const dataDir = await tempDir('qa-v248-resp-');
  const config = makeConfig();
  const history = await createHistoryStore({ dataDir, config, logger: null });
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [TOOL_TEXT] });

  await withServer({ duck, dataDir, history }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v248-resp' },
      body: { model: 'gpt-6-luna', input: '读 package.json', tools: [TOOL] }
    });
    assert.equal(res.status, 200, res.text);
    const list = await adminRequest(baseUrl, '/admin/api/history');
    const item = (list.json.groups || []).flatMap((group) => group.items).find((entry) => entry.sessionKey === 'sess-v248-resp');
    assert.ok(item);
    const detail = await adminRequest(baseUrl, `/admin/api/history/${item.id}`);
    assert.equal(detail.json.item.injection.injected, true);
    assert.deepEqual(detail.json.item.injection.clientTools, ['read_file']);
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('手动压缩保留工具调用/工具结果文本', () => {
  const normalized = normalizeCompactMessages([
    { role: 'user', content: '读取 package.json' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '{"name":"duckai-cpa"}' },
    { role: 'user', content: '总结一下' }
  ]);
  const assistant = normalized.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant, '应保留 assistant 工具消息');
  assert.match(assistant.content, /\[tool_call\]/);
  assert.match(assistant.content, /read_file/);
  const toolResult = normalized.messages.find((message) => message.role === 'user' && message.content.includes('tool_result'));
  assert.ok(toolResult, 'role:"tool" 应编码为 [tool_result]');
  assert.match(toolResult.content, /duckai-cpa/);
});

test('上游调试视图对图片 data URL 脱敏', async () => {
  const dataDir = await tempDir('qa-v248-img-');
  const config = makeConfig();
  const history = await createHistoryStore({ dataDir, config, logger: null });
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: [], images: [{ b64: PNG, format: 'jpeg' }] });

  await withServer({ duck, dataDir, history }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'sess-v248-img', 'x-conversation-mode': 'server' },
      body: {
        model: 'gpt-6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图是什么颜色？' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }
            ]
          }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const list = await adminRequest(baseUrl, '/admin/api/history');
    const item = (list.json.groups || []).flatMap((group) => group.items).find((entry) => entry.sessionKey === 'sess-v248-img');
    assert.ok(item);
    const upstream = await adminRequest(baseUrl, `/admin/api/history/${item.id}/upstream`);
    assert.equal(upstream.status, 200, upstream.text);
    const text = JSON.stringify(upstream.json.messages);
    assert.match(text, /\[image data/);
    assert.ok(!text.includes(PNG), '不应返回完整图片 base64');
  });
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});
