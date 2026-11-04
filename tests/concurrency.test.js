/**
 * v2.5 会话并发（按身份并行 / 同身份串行 / 同会话忙锁）。
 *
 * 覆盖：
 *   - 两个测试会话绑定**不同身份** → 并行，总耗时 ≈ max（mock duck 延迟不同）
 *   - 同一身份的两个会话 → 串行（rps=1），总耗时 ≈ sum 且 peakInFlight=1
 *   - 同一会话并发发送 → 409 session_busy
 *   - SSE done 消息带 identityId / queueWaitMs
 *   - `/v1` + 不同 X-Session-Id（不同身份）并行；同身份串行
 *   - upstream/admin 日志带 identityId / queueWaitMs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { startTestServer, collectSSE, adminRequest, v1Request, waitFor } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

async function tempDataDir(prefix = 'duckai-qa-concurrency') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function donePayload(events) {
  const done = events.map((event) => event.json).find((payload) => payload && payload.type === 'done');
  return done || null;
}

async function createSession(baseUrl, title) {
  const res = await adminRequest(baseUrl, '/admin/api/test/sessions', { method: 'POST', body: { title } });
  assert.equal(res.status, 201, res.text);
  return res.json.session;
}

async function bindSession(pool, sessionId, identityId) {
  await pool.bind(sessionId, identityId);
  return pool.getBinding(sessionId);
}

test('不同身份的两个测试会话并行：总耗时 ≈ max 而非 sum；done 带 identityId/queueWaitMs', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, withIdentities: true, cleanup: false });
  try {
    const pool = server.identityPool;
    const generated = await pool.generate({ count: 2 });
    const [idA, idB] = (Array.isArray(generated) ? generated : generated.items).map((item) => item.id);

    const sessionA = await createSession(server.baseUrl, '并发A');
    const sessionB = await createSession(server.baseUrl, '并发B');
    await bindSession(pool, sessionA.id, idA);
    await bindSession(pool, sessionB.id, idB);

    duck.resetObservations();
    duck.enqueueChat({ delayMs: 500, textDeltas: ['A 完成'] });
    duck.enqueueChat({ delayMs: 500, textDeltas: ['B 完成'] });

    const startedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      collectSSE(server.baseUrl, `/admin/api/test/sessions/${sessionA.id}/messages`, {
        headers: { authorization: `Bearer ${server.adminToken}` },
        body: { content: '问题A' },
        timeoutMs: 20000
      }),
      collectSSE(server.baseUrl, `/admin/api/test/sessions/${sessionB.id}/messages`, {
        headers: { authorization: `Bearer ${server.adminToken}` },
        body: { content: '问题B' },
        timeoutMs: 20000
      })
    ]);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 1100, `不同身份应并行：总耗时 ${elapsed}ms（期望 ≈ max(500,500) 而非 sum）`);
    assert.ok(duck.maxInFlight >= 2, `mock 上游应观测到并行（maxInFlight=${duck.maxInFlight}）`);

    const doneA = donePayload(resultA.events);
    const doneB = donePayload(resultB.events);
    assert.ok(doneA && doneB, '缺少 done 事件');
    assert.equal(doneA.message.identityId, idA);
    assert.equal(doneB.message.identityId, idB);
    assert.ok(Number.isFinite(Number(doneA.message.queueWaitMs)), 'done.message.queueWaitMs 缺失');
    assert.ok(Number.isFinite(Number(doneB.message.queueWaitMs)), 'done.message.queueWaitMs 缺失');

    const logs = await adminRequest(server.baseUrl, '/admin/api/logs?kind=upstream&limit=20');
    const entries = logs.json.items.filter((item) => item.identityId);
    assert.ok(entries.length >= 2, 'upstream 日志应带 identityId');
    assert.ok(new Set(entries.map((item) => item.identityId)).size >= 2, '两个身份应都出现在日志');
    assert.ok(entries.every((item) => Number.isFinite(Number(item.queueWaitMs))), '日志缺少 queueWaitMs');
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('同一身份的两个会话串行（rps=1）：总耗时 ≥ 1000ms 且 peakInFlight=1', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, withIdentities: true, cleanup: false });
  try {
    const pool = server.identityPool;
    const generated = await pool.generate({ count: 2 });
    const [sharedId] = (Array.isArray(generated) ? generated : generated.items).map((item) => item.id);

    const sessionA = await createSession(server.baseUrl, '串行A');
    const sessionB = await createSession(server.baseUrl, '串行B');
    await bindSession(pool, sessionA.id, sharedId);
    await bindSession(pool, sessionB.id, sharedId);

    duck.resetObservations();
    duck.enqueueChat({ delayMs: 200, textDeltas: ['A'] });
    duck.enqueueChat({ delayMs: 200, textDeltas: ['B'] });

    const startedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      collectSSE(server.baseUrl, `/admin/api/test/sessions/${sessionA.id}/messages`, {
        headers: { authorization: `Bearer ${server.adminToken}` },
        body: { content: '问题A' },
        timeoutMs: 20000
      }),
      collectSSE(server.baseUrl, `/admin/api/test/sessions/${sessionB.id}/messages`, {
        headers: { authorization: `Bearer ${server.adminToken}` },
        body: { content: '问题B' },
        timeoutMs: 20000
      })
    ]);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed >= 1000, `同身份应串行（rps=1）：总耗时 ${elapsed}ms`);
    assert.equal(duck.maxInFlight, 1, `同身份 peakInFlight 应为 1，实际 ${duck.maxInFlight}`);
    const stats = pool.queueStats(sharedId);
    assert.ok(stats.peakInFlight <= 1, `身份队列 peakInFlight=${stats.peakInFlight}`);
    assert.ok(stats.totalWaitMs >= 700, `queued 请求应有等待（totalWaitMs=${stats.totalWaitMs}）`);

    const waits = [donePayload(resultA.events)?.message?.queueWaitMs, donePayload(resultB.events)?.message?.queueWaitMs].map(Number);
    assert.ok(waits.some((value) => value >= 700), `应有请求 queueWaitMs ≥700（实际 ${waits.join(',')}）`);
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('同一会话并发发送 → 第二次 409 session_busy', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, withIdentities: true, cleanup: false });
  try {
    const session = await createSession(server.baseUrl, '忙锁');
    duck.resetObservations();
    duck.enqueueChat({ delayMs: 1200, textDeltas: ['慢'] });

    const first = collectSSE(server.baseUrl, `/admin/api/test/sessions/${session.id}/messages`, {
      headers: { authorization: `Bearer ${server.adminToken}` },
      body: { content: '第一个' },
      timeoutMs: 20000
    });
    await waitFor(() => duck.calls.chat.length >= 1, { timeoutMs: 5000, intervalMs: 20 });

    const second = await adminRequest(server.baseUrl, `/admin/api/test/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { content: '第二个' }
    });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.error.code, 'session_busy');

    const result = await first;
    assert.ok(donePayload(result.events), '第一次流应正常完成');
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('/v1 不同 X-Session-Id（不同身份）并行；同身份串行', async () => {
  const dataDir = await tempDataDir();
  const duck = new MockDuckClient();
  const server = await startTestServer({ duck, dataDir, withIdentities: true, cleanup: false });
  try {
    const pool = server.identityPool;
    const generated = await pool.generate({ count: 3 });
    const ids = (Array.isArray(generated) ? generated : generated.items).map((item) => item.id);
    const body = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] };

    // 预热：让 3 个 sessionKey 先各自绑定身份（无延迟）
    duck.resetObservations();
    for (const key of ['sess_par_1', 'sess_par_2', 'sess_serial_1', 'sess_serial_2']) {
      await v1Request(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'X-Session-Id': key },
        body
      });
    }
    const bindings = ['sess_par_1', 'sess_par_2', 'sess_serial_1', 'sess_serial_2'].map((key) => pool.getBinding(key)?.identityId);
    assert.ok(bindings.every(Boolean), '预热后应有绑定');

    // 不同身份并行：挑两个不同身份绑定
    const distinct = [...new Set(bindings)];
    assert.ok(distinct.length >= 2, `应至少两个身份（实际 ${bindings.join(',')}）`);
    const keyFor = (identityId) => ['sess_par_1', 'sess_par_2', 'sess_serial_1', 'sess_serial_2'].find((key) => pool.getBinding(key)?.identityId === identityId);
    const keyA = keyFor(distinct[0]);
    const keyB = keyFor(distinct[1]);
    // 用 pool.bind 手工修正，确保两个 key 分属不同身份
     await pool.bind(keyA, distinct[0]);
    await pool.bind(keyB, distinct[1]);
    // 预热请求会占用各身份的 rps=1 门控（lastStartedAt）；等待窗口过去再计时，避免把门控等待算进并行耗时
    await new Promise((resolve) => setTimeout(resolve, 1150));

    duck.resetObservations();
    duck.enqueueChat({ delayMs: 400, textDeltas: ['p1'] });
    duck.enqueueChat({ delayMs: 400, textDeltas: ['p2'] });
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      v1Request(server.baseUrl, '/v1/chat/completions', { method: 'POST', headers: { 'X-Session-Id': keyA }, body }),
      v1Request(server.baseUrl, '/v1/chat/completions', { method: 'POST', headers: { 'X-Session-Id': keyB }, body })
    ]);
    const parallelElapsed = Date.now() - t0;
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.ok(parallelElapsed < 900, `不同身份应并行（${parallelElapsed}ms）`);
    assert.ok(duck.maxInFlight >= 2, `maxInFlight=${duck.maxInFlight}`);

    // 同身份串行：把两个 key 绑到同一身份（且该身份当前空闲）
    await pool.bind(keyA, distinct[0]);
    await pool.bind(keyB, distinct[0]);
    duck.resetObservations();
    duck.enqueueChat({ delayMs: 150, textDeltas: ['s1'] });
    duck.enqueueChat({ delayMs: 150, textDeltas: ['s2'] });
    const t1 = Date.now();
    await Promise.all([
      v1Request(server.baseUrl, '/v1/chat/completions', { method: 'POST', headers: { 'X-Session-Id': keyA }, body }),
      v1Request(server.baseUrl, '/v1/chat/completions', { method: 'POST', headers: { 'X-Session-Id': keyB }, body })
    ]);
    const serialElapsed = Date.now() - t1;
    assert.ok(serialElapsed >= 1000, `同身份应串行（${serialElapsed}ms）`);
    assert.equal(duck.maxInFlight, 1, `同身份 maxInFlight 应为 1，实际 ${duck.maxInFlight}`);
  } finally {
    await server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
