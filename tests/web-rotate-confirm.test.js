/**
 * v2.8 前端：轮换身份两次确认（jsdom + 真实构建产物）。
 *
 * 断言：
 *   - 点「轮换」→ 第 1 步对话框（第 1 / 2 步）
 *   - 「继续」→ 第 2 步对话框，文案含「不可恢复」/「身份丢失」
 *   - 「取消」→ 不调用 POST /admin/api/identity/rotate
 *   - 再次进入并「确认轮换（不可恢复）」→ 调用一次 rotate（scope=all），页面显示 identityLost 警告/note
 *   - 全程无 console 报错
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function identityPayload(deviceName = 'DuckCPA@a1b2') {
  const now = Date.now();
  return {
    identity: {
      deviceId: '11111111-2222-4333-8444-555555555555',
      deviceName,
      journeyId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fingerprint: 'bbbbbbbbbbbbbbbb',
      stable: true,
      source: 'file',
      hostname: 'qa-host',
      createdAt: now - 86400000,
      rotatedAt: null
    },
    durableStream: { enabled: true, hasPrivateKey: true, fingerprint: 'bbbbbbbbbbbbbbbb', version: '0.2.0' },
    auth: { hasCookies: false, hasToken: false },
    sync: {
      enabled: false,
      deviceId: '11111111-2222-4333-8444-555555555555',
      deviceName,
      deviceCount: 0,
      devices: [],
      lastSyncAt: null,
      transport: 'available',
      pairingCode: null,
      recoveryCode: null
    },
    file: { path: 'data/identity.json', bytes: 1024, updatedAt: now }
  };
}

function buildFetchMock(options = {}) {
  const state = {
    rotateCalls: [],
    deleteCalls: [],
    fetches: [],
    deviceName: 'DuckCPA@a1b2',
    syncEnabled: options.syncEnabled === true,
    devices: options.devices || []
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String(init.method || 'GET').toUpperCase();
    state.fetches.push({ method, pathname });
    const readBody = () => {
      try {
        return JSON.parse(String(init.body || '{}'));
      } catch {
        return {};
      }
    };

    if (pathname === '/identity' && method === 'GET') return json(identityPayload(state.deviceName));
    if (pathname === '/sync' && method === 'GET') {
      const base = identityPayload(state.deviceName);
      return json({
        sync: {
          ...base.sync,
          enabled: state.syncEnabled,
          deviceName: state.deviceName,
          devices: state.devices.map((device) => ({ id: device.id, name: device.name, type: device.type })),
          server: {
            registered: false,
            userId: null,
            deviceId: base.identity.deviceId,
            deviceName: state.deviceName,
            serverDeviceId: null,
            registeredAt: null,
            lastLoginAt: null,
            devices: [],
            lastError: null
          }
        }
      });
    }
    if (pathname === '/subscription') {
      return json({ subscription: { authenticated: false, email: null, tier: 'free', entitlements: [], expiresAt: null } });
    }
    if (pathname === '/sync/official-recovery-code') {
      return json({ officialRecoveryCode: { configured: false, hasCode: false, updatedAt: null, preview: null, length: 0 } });
    }
    if (pathname === '/sync/server-devices' && method === 'GET') {
      const devices = state.devices.map((device) => ({ ...device, current: device.id === 'dev-self' }));
      return json({
        devices,
        currentDeviceId: 'dev-self',
        total: devices.length,
        server: { registered: state.devices.length > 0, userId: 'u-1', deviceName: state.deviceName, devices }
      });
    }
    if (pathname.startsWith('/sync/server-devices/') && method === 'DELETE') {
      state.deleteCalls.push(pathname.split('/').pop());
      return json({ ok: true });
    }
    if (pathname === '/sync/pairing') {
      return json({ pairing: null });
    }
    if (pathname === '/identity/rotate' && method === 'POST') {
      state.rotateCalls.push(readBody());
      state.deviceName = 'DuckCPA@c3d4';
      return json({
        ok: true,
        ...identityPayload('DuckCPA@c3d4'),
        identityLost: true,
        note: '轮换会丢弃当前 journeyId/durableStream 密钥，旧身份无法恢复'
      });
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

async function mountIdentityPage(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/admin/#/identity',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error?.message}`));
  window.console.error = (...args) => {
    errors.push(`console.error: ${args.map(String).join(' ')}`);
  };
  window.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {}
  });
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
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.localStorage.setItem('duckai_cpa_admin_token', 'qa-admin-token');

  for (const key of [
    'document',
    'navigator',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'HTMLElement',
    'HTMLTextAreaElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
    'HTMLSelectElement',
    'HTMLOptionElement',
    'HTMLDivElement',
    'HTMLSpanElement',
    'HTMLImageElement',
    'HTMLLabelElement',
    'HTMLUListElement',
    'HTMLLIElement',
    'HTMLCanvasElement',
    'HTMLFormElement',
    'NodeFilter',
    'SVGSVGElement',
    'SVGElement',
    'Element',
    'Node',
    'CustomEvent',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'InputEvent',
    'DragEvent',
    'WheelEvent',
    'TouchEvent',
    'ClipboardEvent',
    'MutationObserver',
    'getComputedStyle',
    'Response',
    'ReadableStream',
    'TextEncoder',
    'DOMRect',
    'DOMRectReadOnly',
    'Range',
    'Selection',
    'DocumentFragment',
    'XMLHttpRequest',
    'FormData',
    'Blob',
    'File',
    'Image'
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

  const mock = buildFetchMock(options);
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
  const clickTestId = (testId) => click(byTestId(testId));
  const clickRotateButton = () => {
    const button = [...window.document.querySelectorAll('button,[role="button"]')].find((el) =>
      (el.textContent || '').includes('轮换')
    );
    click(button);
  };
  return { window, errors, state: mock.state, text, waitFor, waitForText, byTestId, waitForTestId, click, clickTestId, clickRotateButton };
}

async function closeDom(env) {
  env.window.close();
}

test('轮换身份：两次确认；第二步含不可恢复/身份丢失；取消不调 API', async () => {
  const env = await mountIdentityPage();
  try {
    await env.waitForText('身份');
    await env.waitForText('轮换');

    // 第一次确认：第 1 步
    env.clickRotateButton();
    await env.waitForTestId('rotate-step1-dialog');
    assert.ok(env.text().includes('第 1 / 2 步'), '第 1 步应提示 1/2');
    assert.equal(env.state.rotateCalls.length, 0);

    // 继续 → 第 2 步（危险确认）
    env.clickTestId('rotate-continue');
    await env.waitForTestId('rotate-step2-dialog');
    const step2 = env.byTestId('rotate-step2-dialog').textContent || '';
    assert.match(step2, /不可恢复/, `第 2 步应含「不可恢复」（实际：${step2.slice(0, 120)}）`);
    assert.match(step2, /身份.*丢失/, `第 2 步应含「身份丢失」语义（实际：${step2.slice(0, 120)}）`);

    // 取消 → 不调 API
    env.clickTestId('rotate-cancel');
    await env.waitFor(() => !env.byTestId('rotate-step2-dialog'), { label: 'step2 closed' });
    assert.equal(env.state.rotateCalls.length, 0, '取消后不应调用 rotate API');

    // 再次进入并确认 → 调用一次 rotate，显示 identityLost 警告
    env.clickRotateButton();
    await env.waitForTestId('rotate-step1-dialog');
    env.clickTestId('rotate-continue');
    await env.waitForTestId('rotate-step2-dialog');
    env.clickTestId('rotate-confirm');
    await env.waitFor(() => env.state.rotateCalls.length === 1, { label: 'rotate called' });
    assert.deepEqual(env.state.rotateCalls[0], { scope: 'all' });
    await env.waitForText('身份已丢失', 5000);

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    await closeDom(env);
  }
});
