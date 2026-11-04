/**
 * v2.9 前端（jsdom + 真实构建产物）：身份池设备名列 / 默认身份删除禁用 / 设备槽拖拽保存。
 *
 * 断言（按 web-dashboard-2 最终 UI 契约）：
 *   - 身份池表头「设备名称」；默认身份 DuckAI@main + 「默认 · 不可删除」，删除按钮 disabled
 *   - 身份页设备槽两栏：左「身份池设备」/ 右「DuckDuckGo 设备列表 / 设备槽」，默认身份初始在右侧
 *   - 拖拽 id_2 从左到右 → 「有未保存更改」；点「保存设备槽位」→ PUT {identityIds:['id_default','id_2']}，
 *     成功 toast「设备槽位已保存并生效」，保存后「已保存」
 *   - 429：再拖出默认身份并保存 → 显示「DuckDuckGo Sync 限流中，请 5 秒后重试」
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

const IDENTITIES = [
  {
    id: 'id_default',
    label: '默认身份',
    deviceName: 'DuckAI@main',
    deviceId: 'u-default',
    journeyId: 'a'.repeat(32),
    fingerprint: 'b'.repeat(32),
    enabled: true,
    active: true,
    subscribed: false,
    authTier: 'free',
    sessions: 0,
    queue: { waiting: 0, inFlight: 0 }
  },
  {
    id: 'id_2',
    label: '分身1',
    deviceName: 'DuckCPA@b2c4',
    deviceId: 'u-2',
    journeyId: 'c'.repeat(32),
    fingerprint: 'd'.repeat(32),
    enabled: true,
    active: false,
    subscribed: false,
    authTier: 'free',
    sessions: 0,
    queue: { waiting: 0, inFlight: 0 }
  }
];

function identityState() {
  const now = Date.now();
  return {
    identity: {
      deviceId: 'u-default',
      deviceName: 'DuckAI@main',
      journeyId: 'a'.repeat(32),
      fingerprint: 'b'.repeat(32),
      stable: true,
      source: 'file',
      hostname: 'qa-host',
      createdAt: now - 86400000,
      rotatedAt: null
    },
    durableStream: { enabled: true, hasPrivateKey: true, fingerprint: 'b'.repeat(32), version: '0.2.0' },
    auth: { hasCookies: false, hasToken: false },
    sync: { enabled: true, deviceId: 'u-default', deviceName: 'DuckAI@main', deviceCount: 0, devices: [], transport: 'available', pairingCode: null, recoveryCode: null },
    file: { path: 'data/identity.json', bytes: 1, updatedAt: now }
  };
}

function buildFetchMock() {
  const state = {
    fetches: [],
    saveCalls: [],
    identityIds: ['id_default'],
    rateLimit: false
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const buildSlots = () => {
    const slots = state.identityIds.map((identityId) => {
      const identity = IDENTITIES.find((item) => item.id === identityId);
      return {
        identityId,
        deviceId: identity?.deviceId ?? null,
        deviceName: identity?.deviceName ?? null,
        type: 'browser',
        registered: false,
        matchedIdentityId: identityId
      };
    });
    return {
      defaultIdentityId: 'id_default',
      identityIds: [...state.identityIds],
      slots,
      serverDevices: [],
      server: { registered: false, userId: null, deviceId: 'u-default', deviceName: 'DuckAI@main', devices: [], lastError: null }
    };
  };

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String(init.method || 'GET').toUpperCase();
    state.fetches.push({ method, pathname });
    const body = (() => {
      try {
        return JSON.parse(String(init.body || '{}'));
      } catch {
        return {};
      }
    })();

    if (pathname === '/identities' && method === 'GET') {
      return json({
        pool: { total: 2, enabled: 2, subscribed: 0, activeId: 'id_default', bindingCount: 0, maxIdentities: 20 },
        items: IDENTITIES
      });
    }
    if (pathname === '/identity' && method === 'GET') return json(identityState());
    if (pathname === '/sync' && method === 'GET') {
      const base = identityState();
      return json({
        sync: {
          ...base.sync,
          enabled: true,
          deviceName: 'DuckAI@main',
          devices: [],
          server: { registered: false, userId: null, deviceId: 'u-default', deviceName: 'DuckAI@main', devices: [], lastError: null }
        }
      });
    }
    if (pathname === '/subscription') return json({ subscription: { authenticated: false, email: null, tier: 'free', entitlements: [], expiresAt: null } });
    if (pathname === '/sync/official-recovery-code') {
      return json({ officialRecoveryCode: { configured: false, hasCode: false, updatedAt: null, preview: null, length: 0 } });
    }
    if (pathname === '/sync/pairing') return json({ pairing: null });
    if (pathname === '/sync/server-devices') return json({ devices: [], currentDeviceId: 'u-default', total: 0, server: null });
    if (pathname === '/sync/device-slots' && method === 'GET') return json(buildSlots());
    if (pathname === '/sync/device-slots' && method === 'PUT') {
      state.saveCalls.push(body);
      if (state.rateLimit) {
        return json(
          {
            error: {
              message: 'DuckDuckGo Sync is rate-limiting logins',
              type: 'rate_limit_error',
              code: 'sync_rate_limited',
              retryAfterMs: 5000,
              hint: '请稍后重试'
            }
          },
          429
        );
      }
      state.identityIds = Array.isArray(body.identityIds) ? [...body.identityIds] : [];
      return json({ ok: true, ...buildSlots() });
    }
    return json({ ok: true });
  }
  return { fetchImpl, state };
}

async function loadBundlePath() {
  const html = await fs.readFile(path.join(PROJECT_ROOT, 'web/index.html'), 'utf8');
  const ref = html.match(/(?:src|href)="([^"]+\.js)"/)[1];
  return path.join(PROJECT_ROOT, 'web', ref.replace(/^\/admin\//, '').replace(/^\/+/, ''));
}

async function mountPage(hash) {
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
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.localStorage.setItem('duckai_cpa_admin_token', 'qa-admin-token');

  for (const key of [
    'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement',
    'HTMLSelectElement', 'HTMLOptionElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLImageElement',
    'HTMLLabelElement', 'HTMLUListElement', 'HTMLLIElement', 'HTMLCanvasElement', 'HTMLFormElement',
    'SVGSVGElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'Event', 'MouseEvent',
    'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'DragEvent', 'WheelEvent',
    'TouchEvent', 'ClipboardEvent', 'MutationObserver', 'getComputedStyle', 'Response', 'ReadableStream',
    'TextEncoder', 'DOMRect', 'DOMRectReadOnly', 'Range', 'Selection', 'DocumentFragment', 'XMLHttpRequest',
    'FormData', 'Blob', 'File', 'Image'
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

  const mock = buildFetchMock();
  globalThis.fetch = mock.fetchImpl;
  const bundleUrl = pathToFileURL(await loadBundlePath()).href;
  await import(`${bundleUrl}?qa=${Date.now()}`);

  const text = () => window.document.body.textContent || '';
  const waitFor = async (predicate, options = {}) => {
    const timeoutMs = options.timeoutMs ?? 8000;
    const startedAt = Date.now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${options.label || 'condition'}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  const waitForText = (needle, timeoutMs = 8000) => waitFor(() => text().includes(needle), { timeoutMs, label: needle });
  const byTestId = (testId) => window.document.querySelector(`[data-testid="${testId}"]`);
  const waitForTestId = (testId, timeoutMs = 8000) => waitFor(() => byTestId(testId), { timeoutMs, label: testId });
  const click = (element) => {
    assert.ok(element, '点击目标不存在');
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const drag = (fromElement, toElement) => {
    const dataTransfer = {
      data: {},
      effectAllowed: 'move',
      setData(type, value) {
        this.data[type] = value;
      },
      getData(type) {
        return this.data[type] || '';
      }
    };
    const start = new window.Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });
    fromElement.dispatchEvent(start);
    const over = new window.Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
    toElement.dispatchEvent(over);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    toElement.dispatchEvent(drop);
  };
  return { window, errors, state: mock.state, text, waitFor, waitForText, byTestId, waitForTestId, click, drag };
}

test('身份池：设备名称列显示 DuckAI@main/DuckCPA@xxxx；默认身份删除禁用', async () => {
  const env = await mountPage('#/identities');
  try {
    await env.waitForText('设备名称');
    await env.waitForText('DuckAI@main');
    await env.waitForText('DuckCPA@b2c4');
    await env.waitForText('默认 · 不可删除');
    const rows = [...env.window.document.querySelectorAll('tr')];
    const defaultRow = rows.find((row) => (row.textContent || '').includes('DuckAI@main'));
    assert.ok(defaultRow, '应有默认身份行');
    const deleteButton = [...defaultRow.querySelectorAll('button')].find((button) => (button.getAttribute('aria-label') || '') === '删除');
    assert.ok(deleteButton, '默认行应有删除按钮');
    assert.equal(deleteButton.disabled, true, '默认身份删除按钮应 disabled');
    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});

test('设备槽：按钮加入/移除、未保存提示、保存 payload、保存后刷新；429 文案', async () => {
  const env = await mountPage('#/identity');
  try {
    await env.waitForTestId('device-slots-left');
    await env.waitForTestId('device-slots-right');
    await env.waitForTestId('device-slot-right-id_default', 8000);

    // 左栏含 id_2，右栏含 id_default
    assert.ok(env.byTestId('device-slot-left-id_2'), '左栏应含 id_2');
    assert.ok(env.byTestId('device-slot-right-id_default'), '右栏应含默认身份');
    assert.equal(env.byTestId('device-slots-clean')?.textContent?.includes('已保存'), true);

    // v2.18：按钮「加入」（不再支持拖拽）
    env.click(env.window.document.querySelector('[aria-label="加入设备 DuckCPA@b2c4"]'));
    await env.waitForTestId('device-slot-right-id_2');
    await env.waitForTestId('device-slots-dirty');
    assert.ok(env.byTestId('device-slots-dirty').textContent.includes('有未保存更改'));

    // 保存
    env.click(env.window.document.querySelector('[aria-label="保存设备槽位"]'));
    await env.waitFor(() => env.state.saveCalls.length === 1, { label: 'save called' });
    assert.deepEqual(env.state.saveCalls[0], { identityIds: ['id_default', 'id_2'] });
    await env.waitForText('设备槽位已保存并生效');
    await env.waitForTestId('device-slots-clean');
    // 保存后刷新（GET device-slots 至少 2 次）
    assert.ok(env.state.fetches.filter((item) => item.pathname === '/sync/device-slots' && item.method === 'GET').length >= 2);

    // 429：移除 id_2（默认身份必须保留），保存触发限流
    env.state.rateLimit = true;
    env.click(env.window.document.querySelector('[aria-label="移除设备 DuckCPA@b2c4"]'));
    await env.waitForTestId('device-slots-dirty');
    env.click(env.window.document.querySelector('[aria-label="保存设备槽位"]'));
    await env.waitFor(() => env.state.saveCalls.length === 2, { label: 'second save' });
    assert.deepEqual(env.state.saveCalls[1], { identityIds: ['id_default'] });
    await env.waitForText('限流中', 8000);
    assert.ok(env.text().includes('5 秒后重试'), `应提示 5 秒后重试（实际：${env.text().slice(-200)}）`);

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});
