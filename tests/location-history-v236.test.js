/**
 * v2.36：定位开关（tools.location）+ 会话历史工具调用/图片记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig, v1Request } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';
import { createHistoryStore } from '../src/history.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

test('配置：tools.location 默认关闭，可 PUT 开启（boolean 校验）', () => {
  assert.equal(DEFAULT_CONFIG.tools.location, false, '默认不允许定位');
  const normalized = normalizeConfig({ tools: { location: true } });
  assert.equal(normalized.tools.location, true);
  const fallback = normalizeConfig({});
  assert.equal(fallback.tools.location, false);
  assert.equal(normalizeConfig({ tools: { location: true } }).tools.location, true);
});

test('历史存储：保存工具调用 / 图片 / 思考过程 / 来源（并自动补「图片生成」工具记录）', async () => {
  const dataDir = tmpDir('qa-v236-history');
  await fs.mkdir(dataDir, { recursive: true });
  const history = await createHistoryStore({ dataDir, config: makeConfig(), logger: { info() {}, warn() {} } });
  assert.equal(history.available, true);

  history.record({
    identityId: 'id_test',
    sessionKey: 'v236-history-extras',
    model: 'gpt-6-luna',
    messages: [
      { role: 'user', content: '画一只橘猫' },
      {
        role: 'assistant',
        content: '',
        reasoning: '先构图',
        images: [{ b64: PNG_1X1_B64, format: 'png', model: 'GPT Image 2' }],
        toolCalls: [{ name: 'LocationPrompt', result: '已拒绝' }],
        sources: [{ url: 'https://example.com', title: 'Example' }]
      }
    ],
    ts: Date.now()
  });

  const listed = history.list({ limit: 10 });
  const item = listed.groups.flatMap((group) => group.items).find((entry) => entry.sessionKey === 'v236-history-extras');
  assert.ok(item, '应能查到历史记录');
  const detail = history.get(item.id);
  const assistant = detail.messages.at(-1);
  assert.equal(assistant.images.length, 1);
  assert.equal(assistant.images[0].format, 'png');
  assert.equal(assistant.reasoning, '先构图');
  assert.equal(assistant.sources[0].url, 'https://example.com');
  assert.ok(
    assistant.toolCalls.some((call) => call.name === 'LocationPrompt' && call.result === '已拒绝'),
    '应保留位置调用记录'
  );
  assert.ok(
    assistant.toolCalls.some((call) => /generate|image/i.test(call.name)),
    '有图片时应自动补图片生成工具记录'
  );
});

test('API：GET /admin/api/config 暴露 tools.location 默认 false，PUT 可开启', async () => {
  const dataDir = tmpDir('qa-v236-config-api');
  await fs.mkdir(dataDir, { recursive: true });
  await withServer({ dataDir }, async ({ baseUrl }) => {
    const headers = { authorization: `Bearer ${makeConfig().auth.adminToken}`, 'content-type': 'application/json' };
    let res = await fetch(`${baseUrl}/admin/api/config`, { headers });
    let payload = await res.json();
    assert.equal(payload.config.tools.location, false);

    res = await fetch(`${baseUrl}/admin/api/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ tools: { location: true } })
    });
    assert.equal(res.status, 200);
    payload = await res.json();
    assert.equal(payload.config.tools.location, true);
  });
});

test('聊天：v1 请求历史里带工具调用与图片（MockDuck 生图）', async () => {
  const dataDir = tmpDir('qa-v236-chat-history');
  await fs.mkdir(dataDir, { recursive: true });
  const history = await createHistoryStore({ dataDir, config: makeConfig(), logger: { info() {}, warn() {} } });
  const duck = new MockDuckClient();
  duck.chatBehavior = { textDeltas: [], images: [{ b64: PNG_1X1_B64, format: 'png' }] };

  await withServer({ duck, history, dataDir }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-session-id': 'v236-chat-image' },
      body: {
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: '画一只橘猫' }],
        tools: [{ type: 'image_generation' }]
      }
    });
    assert.equal(res.status, 200);

    const listed = history.list({ limit: 10 });
    const item = listed.groups.flatMap((group) => group.items).find((entry) => entry.sessionKey === 'v236-chat-image');
    assert.ok(item, 'v1 请求应写入历史');
    const detail = history.get(item.id);
    const assistant = detail.messages.at(-1);
    assert.equal(assistant.images.length, 1);
    assert.ok(Array.isArray(assistant.toolCalls));
  });
});
