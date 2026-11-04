/**
 * v2.11 官方恢复码前端（jsdom + 真实构建产物）：完整 code 展示 / 复制 / 下载 / 二维码 Modal / 未配置提示。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OFFICIAL_CODE = Buffer.from(
  JSON.stringify({ recovery: { user_id: 'reveal-web-1', secret: 'reveal-web-secret-1' } }),
  'utf8'
).toString('base64url');

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

function buildFetchMock(options = {}) {
  const configured = options.configured === true;
  const state = { fetches: [], downloads: 0 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const official = configured
    ? {
        configured: true,
        hasCode: true,
        code: OFFICIAL_CODE,
        length: OFFICIAL_CODE.length,
        source: 'pairing',
        updatedAt: Date.now(),
        preview: `${OFFICIAL_CODE.slice(0, 4)}…${OFFICIAL_CODE.slice(-4)}`
      }
    : { configured: false, hasCode: false, code: null, length: 0, source: null, updatedAt: null, preview: null };

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String(init.method || 'GET').toUpperCase();
    state.fetches.push({ method, pathname });
    if (pathname === '/sync/official-recovery-code/download') {
      state.downloads += 1;
      return new Response(`${OFFICIAL_CODE}\n`, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="duckduckgo-official-recovery-code-qa.txt"'
        }
      });
    }
    if (pathname === '/identities') return json({ pool: { total: 1, enabled: 1, activeId: 'id_default' }, items: [] });
    if (pathname === '/identity' && method === 'GET') return json(identityState());
    if (pathname === '/sync' && method === 'GET') {
      const base = identityState();
      return json({ sync: { ...base.sync, server: { registered: false, userId: null, deviceId: 'u-default', deviceName: 'DuckAI@main', devices: [], lastError: null } } });
    }
    if (pathname === '/subscription') return json({ subscription: { authenticated: false, email: null, tier: 'free', entitlements: [], expiresAt: null } });
    if (pathname === '/sync/official-recovery-code' && method === 'GET') return json({ officialRecoveryCode: official });
    if (pathname === '/sync/official-recovery-code' && (method === 'PUT' || method === 'POST')) return json({ ok: true, officialRecoveryCode: official });
    if (pathname === '/sync/official-recovery-code' && method === 'DELETE') return json({ ok: true, officialRecoveryCode: { ...official, configured: false, hasCode: false, code: null } });
    if (pathname === '/sync/server-devices') return json({ devices: [], currentDeviceId: 'u-default', total: 0, server: null });
    if (pathname === '/sync/device-slots') {
      return json({ defaultIdentityId: 'id_default', identityIds: ['id_default'], slots: [], serverDevices: [], orphans: [], server: { registered: false, devices: [] } });
    }
    if (pathname === '/sync/pairing') return json({ pairing: null });
    return json({ ok: true });
  }
  return { fetchImpl, state };
}

async function loadBundlePath() {
  const html = await fs.readFile(path.join(PROJECT_ROOT, 'web/index.html'), 'utf8');
  const ref = html.match(/(?:src|href)="([^"]+\.js)"/)[1];
  return path.join(PROJECT_ROOT, 'web', ref.replace(/^\/admin\//, '').replace(/^\/+/, ''));
}

async function mountIdentity(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/admin/#/identity',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const errors = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error?.message}`));
  window.console.error = (...args) => errors.push(`console.error: ${args.map(String).join(' ')}`);
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.isSecureContext = true;
  // jsdom 无 canvas：qrcode 渲染只依赖 2d context + toDataURL，给最小 stub 以生成 data:image。
  const canvasContextStub = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'canvas') return null;
        if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
        if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
        if (prop === 'measureText') return () => ({ width: 0 });
        if (typeof prop === 'string' && prop in target) return target[prop];
        return () => undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    }
  );
  window.HTMLCanvasElement.prototype.getContext = () => canvasContextStub;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,' + Buffer.from('qa-qr-png').toString('base64');
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value) {
        copied.push(value);
      }
    }
  });
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
  globalThis.isSecureContext = true;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!globalThis.requestIdleCallback) {
    globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0);
    globalThis.cancelIdleCallback = (id) => clearTimeout(id);
  }
  const originalCreate = globalThis.URL?.createObjectURL;
  let objectUrls = 0;
  try {
    globalThis.URL.createObjectURL = () => {
      objectUrls += 1;
      return 'blob:qa-mock';
    };
    globalThis.URL.revokeObjectURL = () => {};
  } catch {
    /* ignore */
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
  return { window, errors, copied, state: mock.state, get objectUrls() { return objectUrls; }, text, waitFor, waitForText, byTestId, waitForTestId, click, clickText, restoreUrl: () => {
    if (originalCreate) globalThis.URL.createObjectURL = originalCreate;
  } };
}

test('官方恢复码：完整 code 展示、复制、下载、二维码 Modal（data:image、复制/下载/关闭）', async () => {
  const env = await mountIdentity({ configured: true });
  try {
    await env.waitForTestId('official-recovery-code-full');
    const codeEl = env.byTestId('official-recovery-code-full');
    assert.equal((codeEl.textContent || '').trim(), OFFICIAL_CODE, '应直接展示完整 code');
    assert.ok(env.text().includes('已配置'));

    // 复制完整 code
    env.clickText('复制官方恢复码');
    await env.waitFor(() => env.copied.includes(OFFICIAL_CODE), { label: 'copy full code' });

    // 下载
    env.click(env.window.document.querySelector('[aria-label="下载官方恢复码"]'));
    await env.waitFor(() => env.state.downloads === 1, { label: 'download called' });

    // 二维码 Modal
    env.click(env.byTestId('official-code-qr-button'));
    await env.waitForTestId('official-code-qr-dialog');
    await env.waitForText('扫描恢复码');
    await env.waitForTestId('official-code-qr-image');
    const img = env.byTestId('official-code-qr-image');
    assert.match(String(img.getAttribute('src') || ''), /^data:image\//, '二维码应为本地 data:image');
    assert.equal((env.byTestId('official-code-qr-text').textContent || '').trim(), OFFICIAL_CODE);
    assert.ok(env.window.document.querySelector('[aria-label="下载恢复码二维码 PNG"]'), '应有下载 PNG 按钮');
    assert.ok([...env.window.document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('复制恢复码')));
    const qrDownload = env.window.document.querySelector('[aria-label="下载恢复码二维码 PNG"]');
    assert.equal(qrDownload.disabled, false, '二维码生成后下载 PNG 应可用');
    env.click(qrDownload);
    await env.waitFor(() => env.objectUrls >= 1, { label: 'qr png download' });

    // Esc 关闭
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await env.waitFor(() => !env.byTestId('official-code-qr-dialog'), { label: 'dialog closed by Esc' });

    // 再次打开 → 关闭按钮
    env.click(env.byTestId('official-code-qr-button'));
    await env.waitForTestId('official-code-qr-dialog');
    env.clickText('关闭');
    await env.waitFor(() => !env.byTestId('official-code-qr-dialog'), { label: 'dialog closed by button' });

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.restoreUrl();
    env.window.close();
  }
});
