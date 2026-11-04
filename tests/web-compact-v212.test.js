/**
 * v2.12 compact 摘要折叠块前端（jsdom + 真实构建产物）：
 * 默认折叠/展开显示/复制、编辑 PATCH、清除 DELETE（确认）、头部徽章联动、
 * 模型「支持自动压缩/不支持自动压缩」标识、自动压缩提示条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SUMMARY_TEXT = '- 摘要：订单 A-102 与客户回电';

function model(id, extra = {}) {
  return {
    id,
    name: id,
    display_name: id,
    paid: false,
    tier: 'free',
    context_window_chars: 16000,
    max_input_chars: 16000,
    input_char_limit: 16000,
    max_output_tokens: 4096,
    max_output_tokens_estimated: true,
    compaction_supported: id === 'gpt-5.4-mini',
    activation_target_pair_count: 0,
    capabilities: {
      webSearch: true,
      imageGeneration: true,
      reasoningEfforts: ['none', 'low'],
      tier: 'free',
      contextWindowChars: 16000,
      maxInputChars: 16000,
      maxOutputTokens: 4096,
      maxOutputTokensEstimated: true,
      compactionSupported: id === 'gpt-5.4-mini',
      activationTargetPairCount: 0,
      inputCharLimit: 16000
    },
    ...extra
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
    summary: { text: SUMMARY_TEXT, version: 1, coveredMessageCount: 3, coveredPairCount: 2, trigger: 'manual', updatedAt: now },
    pendingCompaction: null,
    summaryInvalid: false
  };
}

function buildFetchMock() {
  const state = {
    fetches: [],
    summaryPatch: [],
    summaryDelete: 0,
    summaries: SUMMARY_TEXT,
    pendingCompaction: null
  };
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
  const currentSession = () => ({ ...sessionSummary(), summary: state.summaries ? { ...sessionSummary().summary, text: state.summaries } : null, pendingCompaction: state.pendingCompaction });

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
    if (pathname === '/models') return json({ items: [model('gpt-6-luna'), model('gpt-5.4-mini')], default: 'gpt-6-luna' });
    if (pathname === '/config') return json({ config: { duck: { defaultModel: 'gpt-6-luna', allowPaidModels: false }, prompts: {}, tools: {}, auth: {}, context: { compact: {} } } });
    if (pathname === '/identities') return json({ pool: { total: 1, activeId: 'id_default' }, items: [{ id: 'id_default', label: '默认身份' }] });
    if (pathname === '/overview') return json({ service: {}, queue: {}, stats: {}, models: [], recent: { upstream: [], admin: [] } });
    if (pathname === '/health') return json({ ok: true, upstream: { challengeOk: true } });
    if (pathname === '/test/sessions' && method === 'GET') return json({ items: [currentSession()] });
    if (pathname === '/test/sessions/sess_a' && method === 'GET') return json({ session: currentSession(), messages: [{ id: 'm1', role: 'user', content: '历史问题' }, { id: 'm2', role: 'assistant', content: '历史回答' }] });
    if (pathname === '/test/sessions/sess_a' && method === 'PATCH') return json({ session: { ...currentSession(), ...body } });
    if (pathname === '/test/sessions/sess_a/summary' && method === 'PATCH') {
      state.summaryPatch.push(body);
      state.summaries = String(body.text || '').trim();
      return json({ ok: true, summary: { ...sessionSummary().summary, text: state.summaries, trigger: 'manual' }, session: currentSession() });
    }
    if (pathname === '/test/sessions/sess_a/summary' && method === 'DELETE') {
      state.summaryDelete += 1;
      state.summaries = null;
      state.pendingCompaction = null;
      return json({ ok: true, cleared: true, summary: null, session: currentSession() });
    }
    if (pathname === '/test/sessions/sess_a/compact' && method === 'POST') {
      state.summaries = '- 压缩后的摘要';
      return json({ ok: true, summary: { text: state.summaries, coveredMessageCount: 4, trigger: 'manual' }, summaryChars: 8, coveredMessageCount: 4, session: currentSession() });
    }
    if (pathname === '/test/sessions/sess_a/messages' && method === 'POST') {
      const assistant = { id: 'a1', role: 'assistant', content: '自动压缩后的回答', ts: Date.now(), compacted: true, summaryChars: 12, coveredMessageCount: 2 };
      return makeSSE([
        [0, { type: 'session', sessionId: 'sess_a', userMessageId: 'u1', assistantMessageId: 'a1' }],
        [20, { type: 'delta', text: '自动压缩后的回答' }],
        [40, { type: 'done', message: assistant, latencyMs: 5, queueWaitMs: 0, compacted: true, summaryChars: 12, coveredMessageCount: 2, summary: { text: '自动摘要', version: 1, coveredMessageCount: 2 } }]
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
    const target = [...window.document.querySelectorAll('button,[role="button"]')].find((el) => (el.textContent || '').trim().includes(needle));
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

test('摘要折叠块：默认折叠→展开显示/复制→编辑 PATCH→清除 DELETE（确认）；头部徽章联动', async () => {
  const env = await mountPlayground();
  try {
    // 选中会话
    await env.waitForText('会话A');
    env.clickText('会话A');
    await env.waitForTestId('summary-card');

    // 默认折叠：有 toggle，无 body
    const toggle = env.byTestId('summary-card-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', '默认应折叠');
    assert.equal(env.byTestId('summary-card-body'), null);
    assert.ok((toggle.textContent || '').includes('展开摘要'));
    assert.match(toggle.textContent || '', /上下文摘要 · 覆盖 3 条消息/);

    // 头部徽章 → 展开折叠块
    await env.waitForTestId('summary-badge');
    env.click(env.byTestId('summary-badge'));
    await env.waitForTestId('summary-card-body');
    assert.equal(env.byTestId('summary-card-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal((env.byTestId('summary-card-text').textContent || '').trim(), SUMMARY_TEXT);
    assert.ok([...env.window.document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('复制摘要')));

    // 编辑 → PATCH /summary
    env.click(env.byTestId('edit-summary-button'));
    await env.waitForTestId('summary-edit-dialog');
    const editArea = env.byTestId('summary-edit-textarea');
    const setter = Object.getOwnPropertyDescriptor(env.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editArea, '编辑后的摘要：订单 A-102');
    editArea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    env.click(env.byTestId('summary-edit-save'));
    await env.waitFor(() => env.state.summaryPatch.length === 1, { label: 'summary patch' });
    assert.equal(env.state.summaryPatch[0].text, '编辑后的摘要：订单 A-102');
    await env.waitForText('摘要已更新', 8000);

    // 清除 → 确认 → DELETE /summary，折叠块消失
    await env.waitForTestId('summary-card-body');
    env.click(env.byTestId('clear-summary-button'));
    await env.waitForText('清除压缩并恢复完整消息');
    const clearButtons = [...env.window.document.querySelectorAll('button')].filter((el) => (el.textContent || '').trim() === '清除压缩');
    env.click(clearButtons[clearButtons.length - 1]);
    await env.waitFor(() => env.state.summaryDelete === 1, { label: 'summary delete' });
    await env.waitFor(() => !env.byTestId('summary-card'), { label: 'summary card removed' });
    await env.waitFor(() => !env.byTestId('summary-badge'), { label: 'summary badge removed' });

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});

test('模型压缩能力标识：gpt-6-luna 显示「不支持自动压缩」，模型列表含 gpt-5.4-mini「支持自动压缩」', async () => {
  const env = await mountPlayground();
  try {
    await env.waitForText('上下文约', 10000);
    await env.waitForText('不支持自动压缩', 8000);
    assert.ok(env.text().includes('支持自动压缩'), '模型中应有支持自动压缩标识（下拉/工具栏）');
    await env.waitForText('会话A');
    env.clickText('会话A');
    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    env.window.close();
  }
});
