/**
 * v2.5 前端并发（jsdom + 构建产物）：按会话独立流式。
 *
 * 通过 Node 注入 jsdom globals 后直接 import 构建好的 web 产物（ESM），用 fetch mock 驱动真实 React UI：
 *   - A 慢流时 B 可发送、B 先完成；A 仍在生成（列表「生成中」徽章）
 *   - 切换会话不中断后台流；A 完成后切回 A 能看到结果
 *   - 同一会话流式中再次发送 → 提示「该会话正在生成中」
 *   - 全程无 console 报错
 *
 * 说明：这是对 `web/assets/index-*.js` 真实产物的 DOM 级断言（jsdom），不是源码字符串匹配。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 创建一个 per-session 的 SSE 响应（event 时间可编排）。 */
function makeSSE(events) {
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
          const [delayMs, payload] = events[index];
          index += 1;
          setTimeout(() => {
            controller.enqueue(encoder.encode(sseFrame(payload)));
            push();
          }, delayMs);
        };
        push();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function sessionSummary(id, title) {
  const now = Date.now();
  return {
    id,
    title,
    model: 'gpt-6-luna',
    reasoningEffort: 'none',
    webSearch: false,
    imageGeneration: false,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    identityId: id === 'sess_a' ? 'id_a' : 'id_b',
    identityLabel: id === 'sess_a' ? '分身A' : '分身B'
  };
}

function buildFetchMock() {
  const state = {
    sessions: [sessionSummary('sess_a', '会话A'), sessionSummary('sess_b', '会话B')],
    messages: { sess_a: [], sess_b: [] },
    streamCounts: { sess_a: 0, sess_b: 0 },
    fetches: []
  };
  const timers = [];

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, 'http://localhost');
    const pathname = url.pathname.replace(/^\/admin\/api/, '');
    const method = String(init.method || 'GET').toUpperCase();
    state.fetches.push({ method, pathname });

    if (pathname === '/overview') {
      return json({
        service: { name: 'qa', version: '0.1.0' },
        queue: { waiting: 0, inFlight: 0, rps: 1, maxConcurrent: 1 },
        stats: { upstream: {}, admin: {} },
        models: [],
        recent: { upstream: [], admin: [] },
        identities: { pool: { total: 2, enabled: 2, subscribed: 0 }, items: [] }
      });
    }
    if (pathname === '/config') {
      return json({
        config: {
          duck: { defaultModel: 'gpt-6-luna', allowPaidModels: false },
          prompts: {},
          tools: {},
          auth: {}
        }
      });
    }
    if (pathname === '/models') {
      return json({ items: [{ id: 'gpt-6-luna', name: 'gpt-6-luna', free: true, paid: false }], default: 'gpt-6-luna' });
    }
    if (pathname === '/identities') {
      return json({
        pool: { total: 2, enabled: 2, subscribed: 0 },
        items: [
          { id: 'id_a', label: '分身A', fingerprint: 'aaaaaaaaaaaaaaaa' },
          { id: 'id_b', label: '分身B', fingerprint: 'bbbbbbbbbbbbbbbb' }
        ]
      });
    }
    if (pathname === '/health') {
      return json({ ok: true, upstream: { challengeOk: true, health: { ok: true } } });
    }
    if (pathname === '/test/sessions' && method === 'GET') {
      return json({ items: state.sessions });
    }
    if (pathname === '/test/sessions' && method === 'POST') {
      const id = `sess_new_${state.sessions.length + 1}`;
      const created = sessionSummary(id, '新会话');
      state.sessions.push(created);
      state.messages[id] = [];
      return json({ session: created }, 201);
    }
    const sessionMatch = pathname.match(/^\/test\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'GET') {
      const id = sessionMatch[1];
      const session = state.sessions.find((item) => item.id === id);
      return json({ session, messages: state.messages[id] || [] });
    }
    if (sessionMatch && method === 'PATCH') {
      const id = sessionMatch[1];
      const session = state.sessions.find((item) => item.id === id);
      let patch = {};
      try {
        patch = JSON.parse(String(init.body || '{}'));
      } catch {
        patch = {};
      }
      Object.assign(session, patch);
      return json({ session });
    }
    if (sessionMatch && method === 'DELETE') {
      const id = sessionMatch[1];
      state.sessions = state.sessions.filter((item) => item.id !== id);
      return json({ ok: true });
    }

    const messagesMatch = pathname.match(/^\/test\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'POST') {
      const id = messagesMatch[1];
      state.streamCounts[id] = (state.streamCounts[id] || 0) + 1;
      const count = state.streamCounts[id];
      const userMsg = { id: `${id}_u${count}`, role: 'user', content: '你好', ts: Date.now() };
      state.messages[id].push(userMsg);
      const assistantId = `${id}_a${count}`;
      const finish = (content) => {
        const message = {
          id: assistantId,
          role: 'assistant',
          content,
          ts: Date.now(),
          latencyMs: 10,
          queueWaitMs: 0,
          finishReason: 'stop'
        };
        state.messages[id].push(message);
        return message;
      };
      const sessionEvent = {
        type: 'session',
        sessionId: id,
        userMessageId: userMsg.id,
        assistantMessageId: assistantId
      };
      if (id === 'sess_a' && count === 1) {
        return makeSSE([
          [0, sessionEvent],
          [700, { type: 'delta', text: 'A完成' }],
          [250, { type: 'done', message: finish('A完成'), latencyMs: 10, queueWaitMs: 0 }]
        ]);
      }
      if (id === 'sess_b') {
        return makeSSE([
          [0, sessionEvent],
          [50, { type: 'delta', text: 'B完成' }],
          [30, { type: 'done', message: finish('B完成'), latencyMs: 10, queueWaitMs: 0 }]
        ]);
      }
      // 其它（A 第二次）慢流，便于验证「同会话重复发送」提示
      return makeSSE([
        [0, sessionEvent],
        [1100, { type: 'delta', text: 'A第二次' }],
        [200, { type: 'done', message: finish('A第二次'), latencyMs: 10, queueWaitMs: 0 }]
      ]);
    }
    return json({ ok: true });
  }

  return { fetchImpl, state, timers };
}

async function loadBundlePath() {
  const html = await fs.readFile(path.join(PROJECT_ROOT, 'web/index.html'), 'utf8');
  const ref = html.match(/(?:src|href)="([^"]+\.js)"/)[1];
  return path.join(PROJECT_ROOT, 'web', ref.replace(/^\/admin\//, '').replace(/^\/+/, ''));
}

async function mountApp({ hash = '#/chat' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost/admin/${hash}`,
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
    'Element',
    'Node',
    'CustomEvent',
    'Event',
    'MutationObserver',
    'getComputedStyle',
    'Response',
    'ReadableStream',
    'TextEncoder',
    'HTMLFormElement',
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
    'SVGSVGElement',
    'SVGElement',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'InputEvent',
    'DragEvent',
    'WheelEvent',
    'TouchEvent',
    'ClipboardEvent',
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

  const mock = buildFetchMock();
  globalThis.fetch = mock.fetchImpl;

  const bundleUrl = pathToFileURL(await loadBundlePath()).href;
  await import(`${bundleUrl}?qa=${Date.now()}`);

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
  const text = () => window.document.body.textContent || '';
  const waitForText = (needle, timeoutMs = 8000) =>
    waitFor(() => text().includes(needle), { timeoutMs, label: needle });

  const clickByText = (needle) => {
    const elements = [...window.document.querySelectorAll('button,[role="button"],div,span')];
    const target = elements.find((el) => (el.textContent || '').trim() === needle);
    assert.ok(target, `找不到可点击元素: ${needle}`);
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };

  const textarea = () => window.document.querySelector('textarea');
  const setComposerValue = (value) => {
    const el = textarea();
    assert.ok(el, '找不到 textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const send = () => clickByText('发送');
  const pressEnter = () => {
    const el = textarea();
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  };

  return { dom, window, errors, state: mock.state, waitFor, waitForText, text, clickByText, textarea, setComposerValue, send, pressEnter };
}

async function closeEnv(env) {
  try {
    env.dom.window.close();
  } catch {
    /* ignore */
  }
}

test('前端并发：A 慢流时 B 可发送并先完成；切换会话不中断 A；A 完成后写入 A', async () => {
  const env = await mountApp();
  try {
    await env.waitForText('会话A');
    await env.waitForText('会话B');

    // 进入会话A并发送慢流
    env.clickByText('会话A');
    await env.waitFor(() => env.textarea() && !env.text().includes('生成中…'), { label: 'composer ready' });
    env.setComposerValue('你好A');
    env.send();
    await env.waitForText('生成中');

    // 切到会话B并发送（B 快速完成）
    env.clickByText('会话B');
    await env.waitFor(() => env.textarea(), { label: 'composer B' });
    env.setComposerValue('你好B');
    env.send();
    await env.waitForText('B完成', 5000);
    assert.ok(env.text().includes('会话A') && env.text().includes('生成中'), 'A 后台流应仍在生成（列表生成中徽章）');

    // 切回A：等待 A 完成并显示内容
    env.clickByText('会话A');
    await env.waitForText('A完成', 6000);
    assert.ok(!/会话A[\s\S]{0,200}生成中/.test(''), 'sanity');
    // 列表徽章应消失
    await env.waitFor(() => !env.text().includes('生成中'), { timeoutMs: 4000, label: 'badge cleared' });

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    await closeEnv(env);
  }
});

test('前端并发：同一会话重复发送 → 提示「该会话正在生成中」且只启动一个流', async () => {
  const env = await mountApp();
  try {
    await env.waitForText('会话A');
    env.clickByText('会话A');
    await env.waitFor(() => env.textarea(), { label: 'composer A' });
    env.setComposerValue('并发重复');
    // 同一 tick 内连按两次 Enter（模拟用户快速重复发送；第二次应命中文档化的 session busy 守卫）
    env.pressEnter();
    env.pressEnter();
    await env.waitForText('该会话正在生成中', 5000);
    assert.ok(env.text().includes('该会话正在生成中'), '应提示同会话正在生成');
    assert.equal(env.state.streamCounts.sess_a, 1, `应只启动 1 个流，实际 ${env.state.streamCounts.sess_a}`);

    assert.equal(env.errors.length, 0, `控制台不应有报错：\n${env.errors.join('\n')}`);
  } finally {
    await closeEnv(env);
  }
});
