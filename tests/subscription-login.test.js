/**
 * v2.25：订阅「免复制 JWT」登录会话（bookmarklet 捕获）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withServer, makeConfig } from './helpers/test-server.js';
import { createSubscriptionStore } from '../src/admin/subscriptions.js';
import {
  createLoginSession,
  getLoginSession,
  completeLoginSession,
  failLoginSession,
  cancelLoginSession,
  resetLoginSessions,
  buildBookmarklet,
  buildScript,
  normalizeTokenInput
} from '../src/admin/subscription-login.js';

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 合成 Duck.ai 订阅 JWT（parseSubscriptionToken 不验签，只解析 claims）。 */
function makeToken({ tier = 'plus', email = 'login-test@example.com' } = {}) {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
    api: { id: 'test' },
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    entitlements: [{ product: 'Duck.ai', name: tier }]
  })}.sig`;
}

async function subscriptionEnv() {
  const dataDir = path.join(process.cwd(), 'data', 'tmp', `qa-sub-login-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dataDir, { recursive: true });
  const subscriptions = await createSubscriptionStore({
    dataDir,
    logger: { warn() {}, info() {}, debug() {} }
  });
  return { subscriptions };
}

function adminRequest(baseUrl, pathName, options = {}) {
  return fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      authorization: `Bearer ${makeConfig().auth.adminToken}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
}

test('登录会话：创建 / 查询 / 取消（TTL 5 分钟、一次性 ID）', () => {
  resetLoginSessions();
  const session = createLoginSession({ origin: 'http://127.0.0.1:8787' });
  assert.equal(session.ok, true);
  assert.match(session.sessionId, /^[0-9a-f]{48}$/);
  assert.equal(session.ttlMs, 5 * 60 * 1000);
  assert.equal(session.captureUrl, 'http://127.0.0.1:8787/admin/api/subscriptions/capture');
  assert.match(session.relayUrl, /login=/);
  assert.ok(session.bookmarklet.startsWith('javascript:'));
  assert.ok(session.steps.length >= 3);

  const decoded = decodeURIComponent(session.bookmarklet.slice('javascript:'.length));
  // v2.26：duck.ai 的 CSP connect-src 不含 duckduckgo.com，必须用同源 /duckchat/v1/auth/token
  assert.match(decoded, /\/duckchat\/v1\/auth\/token/);
  assert.ok(!decoded.includes('quack.duckduckgo.com'));
  assert.match(decoded, /subscriptions\/capture/);
  assert.match(decoded, /access_token/);

  const polled = getLoginSession(session.sessionId);
  assert.equal(polled.status, 'waiting');
  assert.ok(polled.remainingMs > 0);

  completeLoginSession(session.sessionId, { subscriptionId: 'sub_x', tier: 'plus', email: 'a@b.c' });
  assert.equal(getLoginSession(session.sessionId).status, 'completed');
  assert.equal(cancelLoginSession(session.sessionId).status, 'completed');

  resetLoginSessions();
  assert.equal(getLoginSession(session.sessionId), null);
});

test('登录会话：失败与未知 ID', () => {
  resetLoginSessions();
  const session = createLoginSession({ origin: 'http://127.0.0.1:8787' });
  failLoginSession(session.sessionId, { code: 'token_invalid' });
  const polled = getLoginSession(session.sessionId);
  assert.equal(polled.status, 'failed');
  assert.equal(polled.error.code, 'token_invalid');
  assert.equal(getLoginSession('deadbeef'), null);
  assert.equal(cancelLoginSession('deadbeef').ok, false);
  resetLoginSessions();
});

test('buildBookmarklet：包含 sessionId / 取 token 端点 / 回传端点', () => {
  const bookmarklet = buildBookmarklet({
    sessionId: 'abc123',
    captureUrl: 'http://127.0.0.1:8787/admin/api/subscriptions/capture',
    relayUrl: 'http://127.0.0.1:8787/admin/#/subscriptions?login=abc123'
  });
  assert.ok(bookmarklet.startsWith('javascript:'));
  const decoded = decodeURIComponent(bookmarklet.slice('javascript:'.length));
  assert.match(decoded, /abc123/);
  assert.match(decoded, /\/duckchat\/v1\/auth\/token/);
  assert.match(decoded, /127\.0\.0\.1:8787\/admin\/api\/subscriptions\/capture/);
  assert.match(decoded, /window\.open/);
  assert.ok(!decoded.includes('\n'), '书签脚本不应含换行');
});

test('API：创建会话 → capture 绑定订阅 → 轮询 completed', async () => {
  await withServer(await subscriptionEnv(), async ({ baseUrl }) => {
    const created = await adminRequest(baseUrl, '/admin/api/subscriptions/login-session', {
      method: 'POST',
      body: JSON.stringify({ origin: baseUrl })
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const session = JSON.parse(createdText);
    assert.ok(session.sessionId);
    assert.ok(session.bookmarklet.startsWith('javascript:'));

    const capture = await fetch(`${baseUrl}/admin/api/subscriptions/capture`, {
      method: 'POST',
      headers: { origin: 'https://duck.ai', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, token: makeToken() })
    });
    const captureText = await capture.text();
    assert.equal(capture.status, 200, captureText);
    assert.equal(capture.headers.get('access-control-allow-origin'), 'https://duck.ai');
    const captured = JSON.parse(captureText);
    assert.equal(captured.ok, true);
    // v2.28：默认名称应为绑定时间（MM-DD HH:mm），便于区分多次绑定
    assert.match(String(captured.subscription.label || ''), /^绑定 \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(captured.subscription.tier, 'plus');
    assert.equal(captured.subscription.email, 'login-test@example.com');
    assert.ok(!('token' in captured.subscription), 'capture 不应回显明文 token');

    const polledJson = await (
      await adminRequest(baseUrl, `/admin/api/subscriptions/login-session/${session.sessionId}`)
    ).json();
    assert.equal(polledJson.status, 'completed');
    assert.equal(polledJson.result.tier, 'plus');

    const listJson = await (await adminRequest(baseUrl, '/admin/api/subscriptions')).json();
    assert.ok((listJson.items || []).some((item) => item.email === 'login-test@example.com'));
  });
});

test('API：capture 校验（缺 sessionId / 未知会话 / 重复提交 / 非法 token）', async () => {
  await withServer(await subscriptionEnv(), async ({ baseUrl }) => {
    const capture = (body) =>
      fetch(`${baseUrl}/admin/api/subscriptions/capture`, {
        method: 'POST',
        headers: { origin: 'https://duck.ai', 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

    const missing = await capture({ token: makeToken() });
    assert.equal(missing.status, 400);

    const unknown = await capture({ sessionId: 'no-such-session', token: makeToken() });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'login_session_not_found');

    const created = await adminRequest(baseUrl, '/admin/api/subscriptions/login-session', {
      method: 'POST',
      body: JSON.stringify({ origin: baseUrl })
    });
    const session = await created.json();
    const bad = await capture({ sessionId: session.sessionId, token: 'not-a-token' });
    assert.equal(bad.status, 422);
    const polled = await (
      await adminRequest(baseUrl, `/admin/api/subscriptions/login-session/${session.sessionId}`)
    ).json();
    assert.equal(polled.status, 'failed');

    const created2 = await adminRequest(baseUrl, '/admin/api/subscriptions/login-session', {
      method: 'POST',
      body: JSON.stringify({ origin: baseUrl })
    });
    const session2 = await created2.json();
    const first = await capture({ sessionId: session2.sessionId, token: makeToken({ email: 'dup@example.com' }) });
    assert.equal(first.status, 200);
    const again = await capture({ sessionId: session2.sessionId, token: makeToken({ email: 'dup@example.com' }) });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'login_session_not_pending');
  });
});

test('buildScript：同源取 token + capture 优先、relay 兜底（v2.26）', () => {
  const relayUrl = 'http://127.0.0.1:8787/admin/#/subscriptions?login=abc';
  const script = buildScript({
    sessionId: 'abc',
    captureUrl: 'http://127.0.0.1:8787/admin/api/subscriptions/capture',
    relayUrl
  });
  assert.ok(!script.includes('\n'), '必须单行');
  // duck.ai 的 CSP connect-src 不含 duckduckgo.com → 必须用同源端点
  assert.match(script, /fetch\("\/duckchat\/v1\/auth\/token"/);
  assert.ok(!script.includes('quack.duckduckgo.com'), '浏览器内不能用 quack 端点（CSP 拦截）');
  assert.match(script, /admin\/api\/subscriptions\/capture/, '应有直连回传');
  assert.match(script, /window\.open/, '应有顶层导航兜底');
  assert.match(script, /token=/, 'relay URL 应携带 token');
});

test('normalizeTokenInput：JWT / Bearer / JSON / 嵌套 JSON / 代码块（v2.26）', () => {
  const jwt = 'aaa.bbb.ccc';
  assert.equal(normalizeTokenInput(jwt), jwt);
  assert.equal(normalizeTokenInput(`Bearer ${jwt}`), jwt);
  assert.equal(normalizeTokenInput(JSON.stringify({ access_token: jwt })), jwt);
  assert.equal(normalizeTokenInput(JSON.stringify({ data: { access_token: jwt } })), jwt);
  const fence = String.fromCharCode(96, 96, 96);
  assert.equal(normalizeTokenInput(`${fence}json\n${JSON.stringify({ access_token: jwt })}\n${fence}`), jwt);
  assert.equal(normalizeTokenInput(''), '');
});
