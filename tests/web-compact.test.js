/**
 * v2.11 compact 前端（jsdom + 真实构建产物，playground/连接测试）：
 * 模型上下文行、手动压缩（loading/成功）、summary 徽章展开/复制、自动压缩提示条、无 console 报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SUMMARY_TEXT = '- 摘要：订单 A-102 与客户回电';

function modelInfo() {
  return {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    displayName: 'GPT-6 Luna',
    paid: false,
    tier: 'free',
    context_window_chars: 16000,
    max_input_chars: 16000,
    max_output_tokens: 4096,
    max_output_tokens_estimated: true,
    capabilities: {
      webSearch: true,
      imageGeneration: true,
      reasoningEfforts: ['none', 'low'],
      tier: 'free',
      contextWindowChars: 16000,
      maxInputChars: 16000,
      maxOutputTokens: 4096,
      maxOutputTokensEstimated: true
    }
  };
}

function sessionSummary() {
  const now = Date.now();
  return {
    id: 'sess_a',
    title: '会话A',
    model: 'gpt-6-luna',
    reasoningEffort: 'none',
    webSearch: false,
    imageGeneration: false,
    createdAt: now - 60000,
    updatedAt: now,
    messageCount: 6,
    summary: { text: SUMMARY_TEXT, version: 1, coveredMessageCount: 3, coveredPairCount: 2, model: 'gpt-6-luna', updatedAt: now },
    identityId: 'id_default',
    identityLabel: '默认身份'
  };
}

function buildFetchMock() {
  const state = { fetches: [], compactCalls: 0, streamCount: 0 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const sseFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  const makeSSE = (events) => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          let index = 0;
          const push = () => {
            if (index >= events.length) {
              controller.close();
              return;
            }
            const [delay, payload] = events[index];
            index += 1;
            setTimeout(() => {
              controller.enqueue(encoder.encode(sseFrame(payload)));
              push();
            }, delay);
          };
          push();
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
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

    if (pathname === '/models' && method === 'GET') return json({ items: [modelInfo()], default: 'gpt-6-luna' });
    if (pathname === '/config' && method === 'GET') {
      return json({
        config: {
          duck: { defaultModel: 'gpt-6-luna', allowPaidModels: false },
          prompts: {},
          tools: {},
          auth: {},
          context: { maxInputChars: 12000, maxMessages: 40, onLimit: 'trim', compact: { enabled: true, triggerChars: 12000 } }
        }
      });
    }
    if (pathname === '/identities' && method === 'GET') {
      return json({ pool: { total: 1, enabled: 1, activeId: 'id_default' }, items: [{ id: 'id_default', label: '默认身份', deviceName: 'DuckAI@main' }] });
    }
    if (pathname === '/overview') return json({ service: {}, queue: {}, stats: {}, models: [], recent: { upstream: [], admin: [] } });
    if (pathname === '/health') return json({ ok: true, upstream: { challengeOk: true } });
    if (pathname === '/test/sessions' && method === 'GET') return json({ items: [sessionSummary()] });
    if (pathname === '/test/sessions' && method === 'POST') return json({ session: sessionSummary() }, 201);
    if (pathname === '/test/sessions/sess_a' && method === 'GET') {
      return json({
        session: sessionSummary(),
        messages: [
          { id: 'm1', role: 'user', content: '历史问题' },
          { id: 'm2', role: 'assistant', content: '历史回答' }
        ]
      });
    }
    if (pathname === '/test/sessions/sess_a' && method === 'PATCH') {
      return json({ session: { ...sessionSummary(), ...body } });
    }
    if (pathname === '/test/sessions/sess_a/compact' && method === 'POST') {
      state.compactCalls += 1;
      const summary = { text: '- 手动压缩摘要', version: 1, coveredMessageCount: 4, model: 'gpt-6-luna', updatedAt: Date.now() };
      return json({ ok: true, summary, summaryChars: summary.text.length, coveredMessageCount: 4, session: { ...sessionSummary(), summary } });
    }
    if (pathname === '/test/sessions/sess_a/messages' && method === 'POST') {
      state.streamCount += 1;
      const assistant = {
        id: `a${state.streamCount}`,
        role: 'assistant',
        content: '自动压缩后的回答',
        ts: Date.now(),
        compacted: true,
        summaryChars: 12,
        coveredMessageCount: 2
      };
      return makeSSE([
        [0, { type: 'session', sessionId: 'sess_a', userMessageId: `u${state.streamCount}`, assistantMessageId: assistant.id }],
        [20, { type: 'delta', text: '自动压缩后的回答' }],
        [
          40,
          {
            type: 'done',
            message: assistant,
            latencyMs: 5,
            queueWaitMs: 0,
            compacted: true,
            summaryChars: 12,
            coveredMessageCount: 2,
            summary: { text: '自动摘要', version: 1, coveredMessageCount: 2 }
          }
        ]
      ]);
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

async function mountPlayground() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/admin/#/chat',
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

  const mock = buildFetchMock();
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
    const target = [...window.document.querySelectorAll('button,[role="button"],div[role="button"]')].find((el) =>
      (el.textContent || '').trim().includes(needle)
    );
    click(target);
  };
  const textarea = () => window.document.querySelector('textarea');
  const setComposerValue = (value) => {
    const el = textarea();
    assert.ok(el, '找不到 textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, errors, state: mock.state, text, waitFor, waitForText, byTestId, waitForTestId, click, clickText, textarea, setComposerValue };
}

test('compact 前端：模型上下文行、手动压缩 loading/成功、summary 徽章展开/复制、自动压缩提示条', async () => {
  const env = await mountPlayground();
  try {
    // 模型上下文行（工具栏）
    await env.waitForText('上下文约', 10000);
    assert.ok(env.text().includes('16,000'), '应显示 16,000 字符');
    assert.ok(env.text().includes('估算 tokens'), '应显示估算 tokens 说明');

    // 选中会话
    await env.waitForText('会话A');
    env.clickText('会话A');
    await env.waitForTestId('compact-session');
    await env.waitForTestId('summary-badge');
    assert.match(env.byTestId('summary-badge').textContent || '', /已压缩 · 覆盖 3 条/, 'summary 徽章应显示覆盖条数');

    // v2.12：头部徽章联动展开消息流顶部摘要折叠块
    env.click(env.byTestId('summary-badge'));
    await env.waitForTestId('summary-card-body');
    assert.ok((env.byTestId('summary-card-text').textContent || '').includes(SUMMARY_TEXT));
    assert.ok([...env.window.document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('复制摘要')));

    // 手动压缩：loading → 成功 toast
    env.click(env.byTestId('compact-session'));
    await env.waitFor(() => env.state.compactCalls === 1, { label: 'compact called' });
    await env.waitForText('已压缩上下文', 8000);
    assert.ok(env.state.fetches.some((item) => item.method === 'POST' && item.pathname.endsWith('/compact')));

    // 发送消息 → 自动压缩提示条
    env.setComposerValue('继续对话');
    env.clickText('发送');
    await env.waitForTestId('compaction-notice', 10000);
    assert.match(env.byTestId('compaction-notice').textContent || '', /上下文已压缩（覆盖 2 条消息）/);
    await env.waitForText('已自动压缩历史', 8000);

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});
