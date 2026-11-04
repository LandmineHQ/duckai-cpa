/**
 * v2.21：上游入口检测（ERR_BN_LIMIT "unsupported entrypoint"）相关修复的单测。
 *
 * 证据：真实浏览器 x-vqd-hash-1 的 meta.stack 指向当前部署的
 * https://duck.ai/dist/duckai-dist/entry.duckai.<hash>.js；我们之前发的是 Node 本地
 * file:///.../src/duck/challenge.js 帧。这里保证：
 *   - _entrypointStack() 使用当前入口 bundle 路径、浏览器形态；
 *   - DUCKAI_NATIVE_STACK=1 可回退到原生 stack（排障用）；
 *   - x-fe-signals 不再是空 events。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChallengeManager, buildFeSignals } from '../src/duck/challenge.js';
import { DuckClient } from '../src/duck/index.js';

test('challenge meta.stack：使用当前 entry bundle 的浏览器形态帧', () => {
  const manager = new ChallengeManager({ baseUrl: 'https://duck.ai', timeoutMs: 5000 });
  manager._entryBundlePath = '/dist/duckai-dist/entry.duckai.965285ea097e2b920cc8.js';
  const stack = manager._entrypointStack();
  assert.match(stack, /^Error\nat l \(https:\/\/duck\.ai\/dist\/duckai-dist\/entry\.duckai\.[a-f0-9]+\.js:2:\d+\)/);
  assert.match(stack, /at async https:\/\/duck\.ai\/dist\/duckai-dist\/entry\.duckai\./);
  assert.ok(!stack.includes('file:///'), '不应包含本地文件路径');
  assert.ok(!stack.includes('node:internal'), '不应包含 Node 内部帧');
});

test('challenge meta.stack：未知 entry 时使用默认 dist 路径，而不是本地路径', () => {
  const manager = new ChallengeManager({ baseUrl: 'https://duck.ai', timeoutMs: 5000 });
  const stack = manager._entrypointStack();
  assert.match(stack, /https:\/\/duck\.ai\/dist\/duckai-dist\/entry\.duckai\./);
});

test('challenge meta.stack：DUCKAI_NATIVE_STACK=1 回退原生 stack（排障开关）', () => {
  const manager = new ChallengeManager({ baseUrl: 'https://duck.ai', timeoutMs: 5000 });
  const previous = process.env.DUCKAI_NATIVE_STACK;
  process.env.DUCKAI_NATIVE_STACK = '1';
  try {
    const stack = manager._entrypointStack();
    assert.match(stack, /challenge\.js|test-server|entrypoint-meta/, '原生 stack 应包含本地帧');
  } finally {
    if (previous === undefined) delete process.env.DUCKAI_NATIVE_STACK;
    else process.env.DUCKAI_NATIVE_STACK = previous;
  }
});

test('x-fe-signals：首次请求带 startNewChat_free + trusted action，之后仅 action', () => {
  const client = new DuckClient({ baseUrl: 'https://duck.ai', defaultModel: 'gpt-6-luna' });
  const first = client._feSignalsEvents();
  const names = first.map((event) => event.name);
  assert.deepEqual(names, ['startNewChat_free', 'action']);
  const action = first.find((event) => event.name === 'action');
  assert.equal(action.trusted, true);
  assert.equal(typeof action.delta, 'number');

  const second = client._feSignalsEvents();
  assert.deepEqual(second.map((event) => event.name), ['action']);
  assert.equal(second[0].trusted, true);
});

test('x-fe-signals：DUCKAI_EMPTY_SIGNALS=1 保留空 events（对照/排障）', () => {
  const client = new DuckClient({ baseUrl: 'https://duck.ai', defaultModel: 'gpt-6-luna' });
  const previous = process.env.DUCKAI_EMPTY_SIGNALS;
  process.env.DUCKAI_EMPTY_SIGNALS = '1';
  try {
    assert.deepEqual(client._feSignalsEvents(), []);
  } finally {
    if (previous === undefined) delete process.env.DUCKAI_EMPTY_SIGNALS;
    else process.env.DUCKAI_EMPTY_SIGNALS = previous;
  }
});

test('buildFeSignals：base64(JSON{start,events,end}) 可解析', () => {
  const events = [{ name: 'action', delta: 12, trusted: true }];
  const decoded = JSON.parse(Buffer.from(buildFeSignals(events), 'base64').toString('utf8'));
  assert.deepEqual(decoded.events, events);
  assert.equal(typeof decoded.start, 'number');
  assert.equal(typeof decoded.end, 'number');
});
