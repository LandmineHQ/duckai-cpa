/**
 * v2.24：日志下载 / 日志保留策略 / token 消耗统计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, adminRequest, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

function admin(baseUrl, pathName, options = {}) {
  return adminRequest(baseUrl, '/admin/api' + pathName, options);
}

test('日志下载：upstream/admin × jsonl/csv/json，带附件头', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    // 产生一条上游日志
    await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }
    });

    for (const [kind, format] of [
      ['upstream', 'jsonl'],
      ['upstream', 'csv'],
      ['upstream', 'json'],
      ['admin', 'jsonl']
    ]) {
      const res = await admin(baseUrl, `/logs/download?kind=${kind}&format=${format}`);
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
      assert.ok(res.text.length > 0);
      if (format === 'csv') {
        assert.match(res.headers.get('content-type') || '', /text\/csv/);
        assert.match(res.text.split('\n')[0], /^ts,/);
      }
      if (format === 'jsonl') {
        assert.match(res.headers.get('content-type') || '', /ndjson/);
      }
      if (format === 'json') {
        assert.match(res.headers.get('content-type') || '', /application\/json/);
        const parsed = JSON.parse(res.text);
        assert.equal(parsed.kind, kind);
        assert.ok(Array.isArray(parsed.items));
      }
    }
  });
});

test('日志保留策略：GET/PUT，保存后立即裁剪，非法值 400', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck, config: makeConfig({ logging: { level: 'silent', maxEntries: 500, maxAgeDays: 7 } }) }, async ({ baseUrl }) => {
    const initial = await admin(baseUrl, '/logs/retention');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.maxEntries, 500);
    assert.equal(initial.json.maxAgeDays, 7);

    // 造 30 条日志
    for (let index = 0; index < 30; index += 1) {
      await v1Request(baseUrl, '/v1/models');
    }

    const put = await admin(baseUrl, '/logs/retention', {
      method: 'PUT',
      body: { maxEntries: 10, maxAgeDays: 30 }
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.maxEntries, 10);
    assert.equal(put.json.maxAgeDays, 30);
    assert.ok(put.json.upstreamCount <= 10, `应裁剪到 10 条以内，实际 ${put.json.upstreamCount}`);

    const after = await admin(baseUrl, '/logs?kind=upstream&limit=50');
    assert.ok(after.json.total <= 10);

    const bad = await admin(baseUrl, '/logs/retention', {
      method: 'PUT',
      body: { maxEntries: 5 }
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_log_retention');

    const badDays = await admin(baseUrl, '/logs/retention', {
      method: 'PUT',
      body: { maxAgeDays: 9999 }
    });
    assert.equal(badDays.status, 400);
  });
});

test('token 统计：/v1 请求后 /admin/api/usage 累计（分模型 + 分身份×模型）', async () => {
  const duck = new MockDuckClient({ chat: { textDeltas: ['你好', '世界'] } });
  await withServer(
    { duck },
    async ({ baseUrl }) => {
      const first = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'x-session-id': 'usage-a' },
        body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '你好，介绍一下你自己。' }] }
      });
      assert.equal(first.status, 200, first.text);

      const chat = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'x-session-id': 'usage-a' },
        body: { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: '继续。' }] }
      });
      assert.equal(chat.status, 200, chat.text);

      const usage = await admin(baseUrl, '/usage');
      assert.equal(usage.status, 200, usage.text);
      assert.ok(usage.json.total.total_tokens > 0, 'total_tokens 应大于 0');
      assert.ok(usage.json.total.requests >= 2);
      assert.ok(usage.json.byModel.length >= 1);
      const models = usage.json.byModel.map((item) => item.model);
      assert.ok(models.includes('gpt-6-luna'));
      assert.ok(Array.isArray(usage.json.byIdentity));
      assert.ok(usage.json.byIdentity.length >= 1, '应有身份维度记录');
      const identity = usage.json.byIdentity[0];
      assert.equal(typeof identity.identityId, 'string');
      assert.ok(Array.isArray(identity.byModel) && identity.byModel.length >= 1);

      // 模型过滤
      const filtered = await admin(baseUrl, '/usage?model=gpt-6-luna');
      assert.equal(filtered.status, 200);
      assert.equal(filtered.json.filter.model, 'gpt-6-luna');
      assert.ok(filtered.json.byModel.every((item) => item.model === 'gpt-6-luna'));

      // overview 里也带 tokens
      const overview = await admin(baseUrl, '/overview');
      assert.equal(overview.status, 200);
      assert.ok(overview.json.tokens, 'overview 应包含 tokens');
      assert.ok(overview.json.tokens.total.total_tokens > 0);
      assert.ok(overview.json.logRetention);
    }
  );
});

test('token 统计：日志里带 tokens 字段，清空日志不影响累计', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: '统计测试一次' }] }
    });
    const logs = await admin(baseUrl, '/logs?kind=upstream&limit=5');
    const withTokens = logs.json.items.find((item) => item.tokens);
    assert.ok(withTokens, '上游日志应包含 tokens');
    assert.ok(withTokens.tokens.total > 0);

    const before = await admin(baseUrl, '/usage');
    const beforeTotal = before.json.total.total_tokens;
    assert.ok(beforeTotal > 0);

    await admin(baseUrl, '/logs?kind=upstream', { method: 'DELETE' });

    const after = await admin(baseUrl, '/usage');
    assert.equal(after.json.total.total_tokens, beforeTotal, '清空日志不应影响 token 累计');
  });
});
