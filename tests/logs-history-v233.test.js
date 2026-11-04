/**
 * v2.33：日志可追溯（sessionKey/identity/requestId）+ /v1/responses 写入会话历史 + 一次请求一次上游调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig, v1Request, collectSSE } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';
import { createHistoryStore } from '../src/history.js';

function tmpDir(prefix) {
  return path.join(process.cwd(), 'data', 'tmp', `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
}

function adminHeaders() {
  return { authorization: `Bearer ${makeConfig().auth.adminToken}`, 'content-type': 'application/json' };
}

async function listUpstreamLogs(baseUrl) {
  const res = await fetch(`${baseUrl}/admin/api/logs?kind=upstream&limit=50`, { headers: adminHeaders() });
  return await res.json();
}

test('一次 /v1/responses 请求只产生一条 upstream 日志（sessionKey/requestId/身份齐全）', async () => {
  const dataDir = tmpDir('qa-v233-logs');
  await fs.mkdir(dataDir, { recursive: true });
  const duck = new MockDuckClient();
  await withServer({ duck, dataDir, withIdentities: true }, async ({ baseUrl }) => {
    const sessionKey = 'v233-one-call';
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': sessionKey },
      body: { model: 'gpt-6-luna', input: '只回复：收到', stream: false }
    });
    assert.equal(res.status, 200);

    const logs = await listUpstreamLogs(baseUrl);
    const items = (logs.items || []).filter((item) => item.endpoint === 'POST /v1/responses');
    assert.equal(items.length, 1, `一次请求应只记录一次上游调用，实际 ${items.length}`);
    const item = items[0];
    assert.equal(item.sessionKey, sessionKey, '日志应带 sessionKey');
    assert.ok(item.requestId, '日志应带 requestId');
    assert.ok(item.identityId, '日志应带绑定身份');
  });
});

test('/v1/responses（流式/非流式）都写入会话历史', async () => {
  const dataDir = tmpDir('qa-v233-history');
  await fs.mkdir(dataDir, { recursive: true });
  const history = await createHistoryStore({ dataDir, config: makeConfig(), logger: { info() {}, warn() {} } });
  const duck = new MockDuckClient();

  await withServer({ duck, history, dataDir }, async ({ baseUrl }) => {
    const nonStreamKey = 'v233-history-nonstream';
    let res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      headers: { 'x-session-id': nonStreamKey },
      body: { model: 'gpt-6-luna', input: '第一问', stream: false }
    });
    assert.equal(res.status, 200);

    const streamKey = 'v233-history-stream';
    const { response } = await collectSSE(baseUrl, '/v1/responses', {
      headers: { 'x-session-id': streamKey },
      body: { model: 'gpt-6-luna', input: '第二问', stream: true }
    });
    assert.equal(response.status, 200);

    const listed = history.list({ limit: 50 });
    const byKey = new Map();
    for (const group of listed.groups) {
      for (const item of group.items) byKey.set(item.sessionKey, item);
    }
    assert.ok(byKey.has(nonStreamKey), '非流式 /v1/responses 应写入历史');
    assert.ok(byKey.has(streamKey), '流式 /v1/responses 应写入历史');

    const detail = history.get(byKey.get(nonStreamKey).id);
    assert.equal(detail.messages[0].content, '第一问');
    assert.equal(detail.messages.at(-1).role, 'assistant');
  });
});
