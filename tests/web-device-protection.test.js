/**
 * v2.10 前端（jsdom + 真实构建产物）：设备列表独立卡片 / 删除 409 弹窗 / force 请求 / 孤儿提示+清理。
 *
 * 断言：
 *   - 身份页有独立卡片 `ddg-device-list-card`，内含设备槽两栏（左身份池设备/右设备槽）
 *   - 身份池删除在 slots 的身份 → 409 `identity_in_device_slots` → 弹窗「该身份正在设备列表中」，
 *     两个操作「先去设备列表移除」「移除设备并删除（force）」；force 确认后请求带 ?force=true
 *   - device-slots 返回 orphans → 「发现 N 个已失效身份的设备」+「清理」→ 请求 ?reconcile=true，清理后横幅消失
 *   - 全程无 console 报错
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
    sync: {
      enabled: true,
      deviceId: 'u-default',
      deviceName: 'DuckAI@main',
      deviceCount: 2,
      devices: [],
      transport: 'available',
      pairingCode: null,
      recoveryCode: null
    },
    file: { path: 'data/identity.json', bytes: 1, updatedAt: now }
  };
}

function buildFetchMock(options = {}) {
  const state = {
    deletes: [],
    deleteStatus: 'conflict',
    reconcileCalls: [],
    orphans: options.orphans || [],
    slotIds: ['id_default', 'id_2'],
    fetches: []
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const buildSlots = () => ({
    defaultIdentityId: 'id_default',
    identityIds: state.slotIds.filter((id) => !state.orphans.some((orphan) => orphan.identityId === id)),
    slots: state.slotIds
      .filter((id) => !state.orphans.some((orphan) => orphan.identityId === id))
      .map((identityId) => {
        const identity = IDENTITIES.find((item) => item.id === identityId);
        return {
          identityId,
          deviceId: identity?.deviceId ?? null,
          deviceName: identity?.deviceName ?? null,
          type: 'browser',
          registered: false,
          matchedIdentityId: identityId
        };
      }),
    serverDevices: [],
    orphans: state.orphans,
    server: { registered: false, userId: null, deviceId: 'u-default', deviceName: 'DuckAI@main', devices: [], lastError: null }
  });

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String(init.method || 'GET').toUpperCase();
    state.fetches.push({ method, pathname, search: url.search });
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
        items: IDENTITIES.filter((item) => !state.deletes.some((entry) => entry.id === item.id) || entry.force !== true)
      });
    }
    if (pathname === '/identity' && method === 'GET') return json(identityState());
    if (pathname === '/sync' && method === 'GET') {
      const base = identityState();
      return json({ sync: { ...base.sync, server: { registered: state.slotsLoaded, userId: 'u', deviceId: 'u-default', deviceName: 'DuckAI@main', devices: [], lastError: null } } });
    }
    if (pathname === '/subscription') return json({ subscription: { authenticated: false, email: null, tier: 'free', entitlements: [], expiresAt: null } });
    if (pathname === '/sync/official-recovery-code') {
      return json({ officialRecoveryCode: { configured: false, hasCode: false, updatedAt: null, preview: null, length: 0 } });
    }
    if (pathname === '/sync/pairing') return json({ pairing: null });
    if (pathname === '/sync/server-devices') return json({ devices: [], currentDeviceId: 'u-default', total: 0, server: null });
    if (pathname === '/sync/device-slots' && method === 'GET') {
      if (url.searchParams.get('reconcile') === 'true') {
        state.reconcileCalls.push(url.search);
        state.orphans = [];
      }
      return json(buildSlots());
    }
    if (pathname === '/sync/device-slots' && method === 'PUT') {
      if (url.searchParams.get('reconcile') === 'true') {
        state.reconcileCalls.push(url.search);
        state.orphans = [];
        return json({ ok: true, ...buildSlots() });
      }
      state.slotIds = Array.isArray(body.identityIds) ? body.identityIds : state.slotIds;
      return json({ ok: true, ...buildSlots() });
    }
    const deleteMatch = pathname.match(/^\/identities\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      const id = decodeURIComponent(deleteMatch[1]);
      const force = url.searchParams.get('force') === 'true';
      state.deletes.push({ id, force });
      if (!force && state.deleteStatus === 'conflict') {
        return json(
          {
            error: {
              message: 'identity is used by DuckDuckGo device slots',
              type: 'invalid_request_error',
              code: 'identity_in_device_slots',
              hint: '该身份在 DuckDuckGo 设备列表中，请先在设备列表移除后再删除（或使用 ?force=true）',
              identityId: id,
              deviceName: IDENTITIES.find((item) => item.id === id)?.deviceName ?? null
            }
          },
          409
        );
      }
      return json({ ok: true, id, removedDevice: true });
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

async function mountPage(hash, options = {}) {
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

  const mock = buildFetchMock(options);
  globalThis.fetch = mock.fetchImpl;
  const bundleUrl = pathToFileURL(await loadBundlePath()).href;
  await import(`${bundleUrl}?qa=${Date.now()}`);

  const text = () => window.document.body.textContent || '';
  const waitFor = async (predicate, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const startedAt = Date.now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${opts.label || 'condition'}`);
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
  const clickText = (needle) => {
    const button = [...window.document.querySelectorAll('button,[role="button"]')].find((el) =>
      (el.textContent || '').trim().includes(needle)
    );
    click(button);
  };
  return { window, errors, state: mock.state, text, waitFor, waitForText, byTestId, waitForTestId, click, clickText };
}

test('身份页：设备列表独立卡片（ddg-device-list-card）含两栏设备槽；Sync&Backup 卡不再含拖拽区', async () => {
  const env = await mountPage('#/identity');
  try {
    await env.waitForTestId('ddg-device-list-card');
    const card = env.byTestId('ddg-device-list-card');
    assert.ok(card, '应有独立设备列表卡片');
    assert.ok(card.querySelector('[data-testid="device-slots-left"]'), '卡片内应有左栏');
    assert.ok(card.querySelector('[data-testid="device-slots-right"]'), '卡片内应有右栏');
    assert.ok((card.textContent || '').includes('DuckDuckGo 设备列表'));
    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});

test('身份池：删除在 slots 的身份 → 409 弹窗两操作；force 请求带 ?force=true', async () => {
  const env = await mountPage('#/identities');
  try {
    await env.waitForText('分身1');
    const rows = [...env.window.document.querySelectorAll('tr')];
    const row = rows.find((item) => (item.textContent || '').includes('DuckCPA@b2c4'));
    assert.ok(row, '应找到分身1行');
    const deleteButton = [...row.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '删除');
    env.click(deleteButton);
    await env.waitForText('删除身份「分身1」？');
    env.clickText('删除'); // 确认删除 → 后端 409

    await env.waitForTestId('identity-slots-conflict-dialog');
    const dialog = env.byTestId('identity-slots-conflict-dialog');
    assert.ok((dialog.textContent || '').includes('该身份正在设备列表中'));
    assert.ok(dialog.querySelector('[data-testid="go-device-list"]'), '应有「先去设备列表移除」');
    assert.ok(dialog.querySelector('[data-testid="force-delete-identity"]'), '应有 force 删除');
    assert.equal(env.state.deletes.length, 1);
    assert.equal(env.state.deletes[0].force, false);

    // force 路径 → 二次确认 → DELETE ?force=true
    env.click(dialog.querySelector('[data-testid="force-delete-identity"]'));
    await env.waitForText('强制删除并注销设备');
    env.clickText('强制删除并注销设备');
    await env.waitFor(() => env.state.deletes.some((entry) => entry.force === true), { label: 'force delete' });
    const forced = env.state.deletes.find((entry) => entry.force === true);
    assert.equal(forced.id, 'id_2');
    await env.waitForText('已移除设备并删除身份', 8000);
    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});

test('孤儿自愈：orphans 提示 + 清理请求 ?reconcile=true，清理后横幅消失', async () => {
  const env = await mountPage('#/identity', { orphans: [{ identityId: 'id_ghost', deviceId: null, deviceName: null, reason: 'missing' }] });
  try {
    await env.waitForTestId('device-orphans-banner');
    const banner = env.byTestId('device-orphans-banner');
    assert.ok((banner.textContent || '').includes('发现 1 个已失效身份的设备'));
    env.click(banner.querySelector('button[aria-label="清理失效设备"]'));
    await env.waitFor(() => env.state.reconcileCalls.length === 1, { label: 'reconcile call' });
    assert.equal(env.state.reconcileCalls[0], '?reconcile=true');
    await env.waitFor(() => !env.byTestId('device-orphans-banner'), { label: 'banner gone' });
    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});
