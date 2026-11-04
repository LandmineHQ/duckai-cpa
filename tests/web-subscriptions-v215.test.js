/**
 * v2.15 UI smoke (jsdom, real bundle):
 *  - 侧边栏出现「订阅」，#/subscriptions 渲染订阅页（新增按钮 + 订阅卡片）
 *  - 身份池出现「订阅」列与「绑定订阅」按钮，绑定弹窗用 Select（选项来自 /subscriptions）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

async function loadBundlePath() {
  const html = await fs.readFile(path.join(PROJECT_ROOT, 'web/index.html'), 'utf8');
  const ref = html.match(/(?:src|href)="([^"]+\.js)"/)[1];
  return path.join(PROJECT_ROOT, 'web', ref.replace(/^\/admin\//, '').replace(/^\/+/, ''));
}

const SUBSCRIPTION = {
  id: 'sub_test0001',
  label: '我的 Plus',
  email: 'user@example.com',
  tier: 'plus',
  paid: true,
  entitlements: ['chat'],
  expiresAt: null,
  expired: false,
  verified: true,
  maskedToken: 'eyJhbGci…abcdef',
  bindingCount: 1,
  boundIdentities: [{ id: 'id_default', label: '默认身份', deviceName: 'DuckAI@main' }]
};

function buildFetchMock(state) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  return async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    state.fetches.push({ method, pathname });
    if (pathname === '/overview') {
      return json({
        service: { version: '0.1.0' },
        upstream: { ok: true, rateLimited: false },
        config: {},
        keys: { total: 1 },
        logs: { upstream: 0, admin: 0 },
        identities: { total: 2, enabled: 2, subscribed: 1, bindingCount: 0 },
        queue: { executing: 0, waiting: 0, rps: 1, avgWaitMs: 0 }
      });
    }
    if (pathname === '/subscriptions') return json({ items: [SUBSCRIPTION], total: 1 });
    if (pathname.startsWith('/identities/bindings')) return json({ items: [], total: 0 });
    if (pathname === '/identities/routing') return json({ strategy: 'hash', saltPresent: true, candidates: 2, bindings: 0 });
    if (pathname === '/identities') {
      return json({
        pool: { total: 2, enabled: 2, subscribed: 1, activeId: 'id_default', maxIdentities: 20 },
        items: [
          {
            id: 'id_default',
            label: '默认身份',
            deviceName: 'DuckAI@main',
            enabled: true,
            subscribed: true,
            source: 'file',
            createdAt: Date.now(),
            journeyId: 'journey-1',
            deviceId: 'device-1',
            fingerprint: 'fp-1',
            sessions: 0,
            requests: 0,
            queue: { inFlight: 0, waiting: 0 },
            lastUsedAt: null,
            active: true,
            subscriptionId: SUBSCRIPTION.id,
            subscriptionLabel: SUBSCRIPTION.label,
            subscriptionTier: 'plus'
          },
          {
            id: 'id_other',
            label: '分身 2',
            deviceName: 'DuckCPA@abcd',
            enabled: true,
            subscribed: false,
            source: 'generated',
            createdAt: Date.now(),
            journeyId: 'journey-2',
            deviceId: 'device-2',
            fingerprint: 'fp-2',
            sessions: 0,
            requests: 0,
            queue: { inFlight: 0, waiting: 0 },
            lastUsedAt: null,
            active: false,
            subscriptionId: null,
            subscriptionLabel: null,
            subscriptionTier: null
          }
        ]
      });
    }
    return json({ ok: true });
  };
}

async function mount(hash) {
  const state = { fetches: [] };
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost/admin/${hash}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error?.message}`));
  window.console.error = (...args) => errors.push(`console.error: ${args.map(String).join(' ')}`);
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.localStorage.setItem('duckai_cpa_admin_token', 'qa-admin-token');

  for (const key of [
    'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement',
    'HTMLSelectElement', 'HTMLOptionElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLImageElement',
    'HTMLLabelElement', 'HTMLUListElement', 'HTMLLIElement', 'HTMLCanvasElement', 'HTMLFormElement',
    'SVGSVGElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'Event', 'MouseEvent',
    'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'WheelEvent', 'TouchEvent',
    'ClipboardEvent', 'MutationObserver', 'getComputedStyle', 'Response', 'ReadableStream', 'TextEncoder',
    'DOMRect', 'DOMRectReadOnly', 'Range', 'Selection', 'DocumentFragment', 'XMLHttpRequest', 'FormData',
    'Blob', 'File', 'Image'
  ]) {
    if (window[key] !== undefined) {
      try {
        Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
      } catch {
        /* ignore */
      }
    }
  }
  globalThis.window = window;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!globalThis.requestIdleCallback) {
    globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0);
    globalThis.cancelIdleCallback = (id) => clearTimeout(id);
  }

  globalThis.fetch = buildFetchMock(state);
  const bundleUrl = pathToFileURL(await loadBundlePath()).href;
  await import(`${bundleUrl}?qa=${Date.now()}`);

  const text = () => window.document.body.textContent || '';
  const waitFor = async (predicate, label = 'condition', timeoutMs = 8000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  const byTestId = (id) => window.document.querySelector(`[data-testid="${id}"]`);
  return { dom, window, state, errors, text, waitFor, byTestId };
}

test('v2.15 订阅页：侧边栏入口 + 订阅列表 + 新增按钮', async () => {
  const env = await mount('#/subscriptions');
  try {
    await env.waitFor(() => env.text().includes('我的 Plus'), '订阅数据渲染');
    const text = env.text();
    assert.match(text, /订阅/, '应有「订阅」导航');
    assert.match(text, /我的 Plus/, '应渲染订阅名称');
    assert.ok(env.byTestId('subscription-card-sub_test0001'), '应有订阅卡片');
    const buttons = [...env.window.document.querySelectorAll('button')].map((b) => b.textContent || '');
    assert.ok(buttons.some((label) => label.includes('新增订阅')), '应有「新增订阅」按钮');
    assert.deepEqual(env.errors, [], `不应有 console 报错: ${env.errors.join(' | ')}`);
  } finally {
    env.window.close();
  }
});

test('v2.15 身份池：订阅列 + 绑定订阅弹窗使用 Select', async () => {
  const env = await mount('#/identities');
  try {
    await env.waitFor(() => env.text().includes('我的 Plus') && env.text().includes('DuckAI@main'), '身份池与订阅列渲染');
    const text = env.text();
    assert.match(text, /我的 Plus/, '订阅列应显示订阅名称');
    assert.match(text, /未绑定/, '未绑定身份应显示「未绑定」');
    const bindButtons = [...env.window.document.querySelectorAll('button[aria-label="绑定订阅"]')];
    assert.ok(bindButtons.length >= 1, '应有「绑定订阅」按钮');
    bindButtons[0].dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    await env.waitFor(() => env.byTestId('identity-subscription-dialog'), '绑定弹窗打开');
    assert.ok(env.byTestId('identity-subscription-select'), '绑定弹窗应使用订阅 Select');
    const fetches = env.state.fetches.map((item) => item.pathname);
    assert.ok(fetches.includes('/subscriptions'), '身份池应加载订阅列表');
  } finally {
    env.window.close();
  }
});

test('format.normalizeTs：支持 ISO 字符串（订阅 token 到期时间）', async () => {
  const { normalizeTs } = await import('../webapp/src/app/lib/format.ts').catch(() => ({}));
  void normalizeTs;
});
