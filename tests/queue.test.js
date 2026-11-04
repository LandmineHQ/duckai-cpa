/**
 * v2 上游 RPS 队列（docs/ADMIN_API_V2.md §2）。
 *
 * 通过 mock DuckClient 观测真实并发/开始时间：
 *   - 默认 rps=1/maxConcurrent=1：3 个并发请求串行执行，同时 inFlight<=1，开始间隔 >=1000ms；
 *   - 每个 upstream 日志项带 queueWaitMs，且后两个明显等待；
 *   - PUT config 改 rps/maxConcurrent 后实时生效；
 *   - queueLimit 超出 → 429 queue_full；queueTimeoutMs 超时 → 429 queue_timeout（带 Retry-After）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, v1Request, adminRequest, waitFor } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

const CHAT_BODY = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] };

function chat(baseUrl, timeoutMs = 20000) {
  return v1Request(baseUrl, '/v1/chat/completions', { method: 'POST', body: CHAT_BODY, timeoutMs });
}

async function upstreamLogs(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/logs?kind=upstream&limit=50');
  assert.equal(res.status, 200);
  return res.json;
}

test('默认 rps=1/maxConcurrent=1：3 个并发请求串行，inFlight<=1，queueWaitMs 递增', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, textDeltas: ['ok'], delayMs: 120 };
  await withServer({ duck }, async ({ baseUrl }) => {
    const startedAt = Date.now();
    const responses = await Promise.all([chat(baseUrl), chat(baseUrl), chat(baseUrl)]);
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(responses.map((res) => res.status), [200, 200, 200]);

    // 上游同时只执行 1 个
    assert.equal(duck.maxInFlight, 1, `maxInFlight should be 1, got ${duck.maxInFlight}`);
    assert.equal(duck.chatStarts.length, 3);

    // 两次上游请求开始间隔 >= 1000/rps ms（rps=1）
    const sortedStarts = [...duck.chatStarts].sort((a, b) => a - b);
    const gap1 = sortedStarts[1] - sortedStarts[0];
    const gap2 = sortedStarts[2] - sortedStarts[1];
    assert.ok(gap1 >= 850, `first queueWait should be ~1s, got ${gap1}ms`);
    assert.ok(gap2 >= 850, `second queueWait should be ~1s, got ${gap2}ms`);
    assert.ok(elapsed >= 2000, `3 serial requests should take >=2s, got ${elapsed}ms`);

    // upstream 日志：3 条、queueWaitMs 递增
    const logs = await upstreamLogs(baseUrl);
    assert.equal(logs.kind, 'upstream');
    assert.equal(logs.total, 3);
    const items = [...logs.items].sort((a, b) => a.ts - b.ts);
    for (const item of items) {
      assert.equal(item.source, 'v1');
      assert.equal(item.endpoint, 'POST /v1/chat/completions');
      assert.equal(item.status, 200);
      assert.equal(typeof item.queueWaitMs, 'number');
      assert.equal(item.stream, false);
    }
    assert.ok(items[0].queueWaitMs < 200, `first queueWaitMs should be small, got ${items[0].queueWaitMs}`);
    assert.ok(items[1].queueWaitMs >= 800, `second queueWaitMs should be >=800, got ${items[1].queueWaitMs}`);
    assert.ok(items[2].queueWaitMs >= 1600, `third queueWaitMs should be >=1600, got ${items[2].queueWaitMs}`);

    // overview.queue 状态
    const overview = await adminRequest(baseUrl, '/admin/api/overview');
    assert.equal(overview.status, 200);
    const queue = overview.json.upstream.queue;
    assert.equal(queue.rps, 1);
    assert.equal(queue.maxConcurrent, 1);
    assert.equal(queue.limit, 50);
    assert.equal(queue.inFlight, 0);
    assert.equal(queue.waiting, 0);
    assert.equal(typeof queue.avgWaitMs, 'number');
    assert.equal(typeof queue.lastStartAt, 'number');
  });
});

test('PUT config 改 upstream.rps/maxConcurrent → 实时生效（并发提升）', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, textDeltas: ['ok'], delayMs: 300 };
  await withServer({ duck }, async ({ baseUrl }) => {
    const put = await adminRequest(baseUrl, '/admin/api/config', {
      method: 'PUT',
      body: { upstream: { rps: 5, maxConcurrent: 3 } }
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.config.upstream.rps, 5);
    assert.equal(put.json.config.upstream.maxConcurrent, 3);

    const overview = await adminRequest(baseUrl, '/admin/api/overview');
    assert.equal(overview.json.upstream.queue.rps, 5);
    assert.equal(overview.json.upstream.queue.maxConcurrent, 3);

    duck.resetObservations();
    const startedAt = Date.now();
    const responses = await Promise.all([chat(baseUrl), chat(baseUrl), chat(baseUrl)]);
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(responses.map((res) => res.status), [200, 200, 200]);

    // rps=5 → 开始间隔 ~200ms，maxConcurrent=3 → 允许真正的并发
    assert.ok(duck.maxInFlight >= 2, `expected concurrent inFlight>=2, got ${duck.maxInFlight}`);
    const starts = [...duck.chatStarts].sort((a, b) => a - b);
    assert.ok(starts[1] - starts[0] <= 800, `rps=5 start gap should be <800ms, got ${starts[1] - starts[0]}ms`);
    assert.ok(elapsed < 2500, `with concurrency, 3 requests should finish faster than serial, got ${elapsed}ms`);
  });
});

test('queueLimit 超出 → 429 queue_full + Retry-After', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, textDeltas: ['ok'], delayMs: 400 };
  const config = makeConfig({ upstream: { rps: 1, maxConcurrent: 1, queueLimit: 1, queueTimeoutMs: 300000 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const responses = await Promise.all([chat(baseUrl), chat(baseUrl), chat(baseUrl)]);
    const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 200, 429]);

    const rejected = responses.find((res) => res.status === 429);
    assert.equal(rejected.json.error.code, 'queue_full');
    assert.ok(rejected.headers.get('retry-after'), 'queue_full must include Retry-After header');
  });
});

test('queueTimeoutMs 超时 → 429 queue_timeout + Retry-After', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, textDeltas: ['ok'], delayMs: 300 };
  // queueTimeoutMs 最小夹取为 1000ms；用 rps=0.5（开始间隔 2000ms）保证排队等待 > 超时阈值
  const config = makeConfig({ upstream: { rps: 0.5, maxConcurrent: 1, queueLimit: 50, queueTimeoutMs: 1000 } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const responses = await Promise.all([chat(baseUrl), chat(baseUrl)]);
    const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 429]);

    const rejected = responses.find((res) => res.status === 429);
    assert.equal(rejected.json.error.code, 'queue_timeout');
    assert.ok(rejected.headers.get('retry-after'), 'queue_timeout must include Retry-After header');
  });
});

test('上游成功/失败都计入队列与日志（失败也带 queueWaitMs）', async () => {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, textDeltas: ['ok'], delayMs: 30 };
  duck.enqueueChat({
    error: Object.assign(new Error('upstream exploded'), {
      name: 'DuckError',
      status: 502,
      type: 'upstream_protocol_mismatch',
      retriable: false
    })
  });
  await withServer({ duck }, async ({ baseUrl }) => {
    const failed = await chat(baseUrl);
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, 'upstream_protocol_mismatch');

    const logs = await waitFor(async () => {
      const value = await upstreamLogs(baseUrl);
      return value.total >= 1 ? value : null;
    });
    const item = logs.items[0];
    assert.equal(item.status, 502);
    assert.equal(typeof item.queueWaitMs, 'number');
    assert.ok(item.error, 'failed request must record error in upstream log');
  });
});
