/**
 * v2.2 DuckDuckGo 订阅（docs/IDENTITY-SYNC.md §3.3）。
 *
 * 模块级（src/duck/auth.js）：entitlementsToTier / parseSubscriptionToken / AuthError。
 * HTTP 级（/admin/api/subscription*）：
 *   - 合法伪造 JWT（payload 可解析）→ activate 解析 email/tier=plus/expiresAt；
 *   - 过期 → 422 token_expired；格式非法 → 422 token_invalid；
 *   - GET 字段完整；DELETE 注销回 free；verify 返回 verified 状态；
 *   - 响应不泄漏 token 明文。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { parseSubscriptionToken, entitlementsToTier, AuthError } from '../src/duck/auth.js';
import { withServer, adminRequest } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

function b64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** 构造三段式 JWT；签名无意义（payload 可解析即可，服务端按契约只解析 payload）。 */
function makeJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  return `${b64url(header)}.${b64url(payload)}.${Buffer.from('fake-signature').toString('base64url')}`;
}

function plusPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    api: 'Duck.ai',
    email: 'qa-plus@example.com',
    sub: 'user-1',
    exp: now + 3600,
    iat: now,
    entitlements: [{ product: 'Duck.ai', name: 'plus' }],
    ...overrides
  };
}

async function tempDataDir() {
  return path.join(os.tmpdir(), `duckai-qa-sub-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/* ------------------------------------------------------------------ */
/* 模块级                                                              */
/* ------------------------------------------------------------------ */

test('entitlementsToTier：Duck.ai plus/pro → plus/pro，其它 → free', () => {
  assert.equal(entitlementsToTier([{ product: 'Duck.ai', name: 'plus' }]), 'plus');
  assert.equal(entitlementsToTier([{ product: 'Duck.ai', name: 'pro' }]), 'pro');
  assert.equal(entitlementsToTier([{ product: 'Other', name: 'plus' }]), 'free');
  assert.equal(entitlementsToTier([]), 'free');
  assert.equal(entitlementsToTier(null), 'free');
});

test('parseSubscriptionToken：合法 payload 可解析；非法 token 抛 AuthError', () => {
  const payload = plusPayload();
  const token = makeJwt(payload);
  const parsed = parseSubscriptionToken(token);
  assert.ok(parsed && typeof parsed === 'object');
  const email = parsed.email ?? parsed.payload?.email;
  const tier = parsed.tier ?? parsed.payload?.tier;
  const exp = parsed.expiresAt ?? parsed.exp ?? parsed.payload?.exp;
  assert.equal(email, 'qa-plus@example.com');
  assert.equal(tier, 'plus');
  // expiresAt 可能为 ISO 字符串或秒级时间戳，统一换算后比较
  const expSeconds = typeof exp === 'number' ? exp : Math.floor(new Date(exp).getTime() / 1000);
  assert.equal(expSeconds, payload.exp);

  assert.equal(typeof AuthError, 'function');
  for (const invalid of ['not-a-jwt', 'a.b', `${b64url({ a: 1 })}.${b64url({ b: 2 })}.sig`, '']) {
    let threw = null;
    let returned = null;
    try {
      returned = parseSubscriptionToken(invalid);
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof AuthError || (returned && returned.ok === false), `invalid token accepted: ${invalid}`);
    if (threw) assert.ok(['token_invalid', 'token_expired'].includes(threw.code), `unexpected code: ${threw.code}`);
  }
});

/* ------------------------------------------------------------------ */
/* HTTP 级                                                             */
/* ------------------------------------------------------------------ */

async function getSubscription(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/subscription');
  assert.equal(res.status, 200, `HTTP ${res.status}: ${res.text}`);
  return res.json.subscription;
}

test('activate 合法 token → email/tier=plus/expiresAt；GET 字段完整且不泄漏 token', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const initial = await getSubscription(baseUrl);
    assert.equal(initial.authenticated, false);
    assert.equal(initial.tier, 'free');
    assert.equal(typeof initial.allowPaidModels, 'boolean');

    const payload = plusPayload();
    const token = makeJwt(payload);
    const activated = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
      method: 'POST',
      body: { token }
    });
    assert.equal(activated.status, 200, activated.text);
    assert.equal(activated.json.ok, true);
    const subscription = activated.json.subscription;
    assert.equal(subscription.authenticated, true);
    assert.equal(subscription.email, 'qa-plus@example.com');
    assert.equal(subscription.tier, 'plus');
    const expiresSeconds =
      typeof subscription.expiresAt === 'number'
        ? subscription.expiresAt
        : Math.floor(new Date(subscription.expiresAt).getTime() / 1000);
    assert.equal(expiresSeconds, payload.exp);
    assert.ok(Array.isArray(subscription.entitlements));
    assert.equal(typeof subscription.verified, 'boolean');
    assert.equal(typeof subscription.allowPaidModels, 'boolean');
    // v2.2：verified 仅表示「token 本地解析 + 上游可达」（duck.ai 匿名 /status 不校验 Bearer）
    assert.equal(subscription.verifyScope, 'reachability');
    assert.equal(typeof subscription.verifyNote, 'string');

    const current = await getSubscription(baseUrl);
    assert.equal(current.authenticated, true);
    assert.equal(current.email, 'qa-plus@example.com');
    assert.equal(current.tier, 'plus');
    assert.equal(current.verifyScope, 'reachability');

    const identity = await adminRequest(baseUrl, '/admin/api/identity');
    assert.equal(identity.json.auth.authenticated, true);
    assert.equal(identity.json.auth.tier, 'plus');
    assert.equal(identity.json.auth.verifyScope, 'reachability');
    assert.ok(!identity.text.includes(token), 'identity response leaked token');
    assert.ok(!activated.text.includes(token), 'activate response leaked token');
  });
});

test('activate 错误：过期 → 422 token_expired；非法 → 422 token_invalid', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const expired = makeJwt(plusPayload({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const expiredRes = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
      method: 'POST',
      body: { token: expired }
    });
    assert.equal(expiredRes.status, 422, expiredRes.text);
    assert.equal(expiredRes.json.error.code, 'token_expired');

    for (const invalid of ['not-a-jwt', 'a.b', `${b64url({ header: true })}.!!!.sig`, '']) {
      const res = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
        method: 'POST',
        body: { token: invalid }
      });
      assert.equal(res.status, 422, `expected 422 for ${invalid}: ${res.text}`);
      assert.equal(res.json.error.code, 'token_invalid');
    }
  });
});

test('DELETE 注销 → 回到 free；GET/identity 状态同步', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const token = makeJwt(plusPayload());
    const activated = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
      method: 'POST',
      body: { token }
    });
    assert.equal(activated.status, 200);

    const deleted = await adminRequest(baseUrl, '/admin/api/subscription', { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.ok, true);
    assert.equal(deleted.json.subscription.authenticated, false);
    assert.equal(deleted.json.subscription.tier, 'free');

    const after = await getSubscription(baseUrl);
    assert.equal(after.authenticated, false);
    assert.equal(after.tier, 'free');
    assert.equal(after.email ?? null, null);

    const identity = await adminRequest(baseUrl, '/admin/api/identity');
    assert.equal(identity.json.auth.authenticated, false);
    assert.equal(identity.json.auth.tier, 'free');
  });
});

test('POST /admin/api/subscription/verify：返回 verified 状态（在线校验失败不 500）', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const token = makeJwt(plusPayload());
    await adminRequest(baseUrl, '/admin/api/subscription/activate', { method: 'POST', body: { token } });

    const verified = await adminRequest(baseUrl, '/admin/api/subscription/verify', { method: 'POST', body: {} });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.ok, true);
    assert.equal(typeof verified.json.subscription.verified, 'boolean');
    assert.equal(verified.json.subscription.verifyScope, 'reachability');
    if (verified.json.subscription.verified === false) {
      assert.equal(typeof verified.json.subscription.verifyError, 'string');
    }
  });
});

test('pro 档位解析：entitlements name=pro → tier=pro', async () => {
  const dataDir = await tempDataDir();
  await withServer({ duck: new MockDuckClient(), dataDir, identity: true }, async ({ baseUrl }) => {
    const token = makeJwt(
      plusPayload({ entitlements: [{ product: 'Duck.ai', name: 'pro' }], email: 'qa-pro@example.com' })
    );
    const res = await adminRequest(baseUrl, '/admin/api/subscription/activate', {
      method: 'POST',
      body: { token }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.subscription.tier, 'pro');
    assert.equal(res.json.subscription.email, 'qa-pro@example.com');
  });
});
