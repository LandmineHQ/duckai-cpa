/**
 * 挑战求解环境仿真单测（v2.62）。
 *
 * duck.ai 的 x-vqd-hash-1 挑战每次会随机抽一组“环境探针”suite，其中部分 suite 会读取页面状态：
 *   - `window.top.document.querySelector('#jsa')`（sandbox + srcdoc 里的 CSP meta）
 *   - `window.top.__DDG_BE_VERSION__` / `window.top.__DDG_FE_CHAT_HASH__`
 *   - 元素布局指标（offsetWidth / getBoundingClientRect / scrollHeight > 0）
 * 这些值会以 `String(seed + 通过项数)` 的形式进入 client_hashes，上游会精确校验；
 * 在扁平的空 jsdom window 里求解会得到错误的指纹 → 418 ERR_CHALLENGE。
 *
 * 本文件用构造的挑战 JS 断言：仿真环境（#jsa iframe + 页面全局变量 + 布局 shim）算出的
 * client_hashes 与真实浏览器一致；legacyChallengeEnv 仍复现旧的错误值（对照）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ChallengeManager, sha256Base64 } from '../src/duck/challenge.js';

const BASE_URL = 'https://duck.ai';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const VERSION_TAG = 'serp_20261105_231819_ET';
const VERSION_SHA = 'c39b3b66f4b9cba5d91c2529f5647c6095f9a7';

const PAGE_HTML = `<!doctype html><html data-version-tag="${VERSION_TAG}" data-version-sha="${VERSION_SHA}"><head></head><body></body></html>`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/** 构造一个返回固定 server_hashes/meta 的挑战；client_hashes 由页面状态计算。 */
function makeChallenge(computeClientHashes) {
  return `(async function(){ const clientHashes = await (${computeClientHashes.toString()})(); return { server_hashes: ['s1','s2','s3'], client_hashes: clientHashes, signals: {}, meta: { v: '4', challenge_id: 'env-test', timestamp: '1', debug: 'x' } }; })()`;
}

/** #jsa iframe / 页面全局变量 suite：4 项检查，seed=1000。 */
const PAGE_STATE_FN = async function () {
  const iframe = window.top.document.querySelector('#jsa');
  const doc = iframe && (iframe.contentDocument || iframe.contentWindow.document);
  const meta = doc && doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const checks = [
    !!meta && meta.getAttribute('content') === "default-src 'none'; script-src 'unsafe-inline';",
    !!iframe && iframe.getAttribute('sandbox') === 'allow-scripts allow-same-origin',
    Object.prototype.hasOwnProperty.call(window.top, '__DDG_BE_VERSION__'),
    Object.prototype.hasOwnProperty.call(window.top, '__DDG_FE_CHAT_HASH__')
  ];
  const score = checks.map(Number).reduce((sum, value) => sum + value, 1000);
  return [
    navigator.userAgent,
    String(score),
    String(window !== window.top),
    String(window.top.__DDG_BE_VERSION__ || ''),
    String(window.top.__DDG_FE_CHAT_HASH__ || '')
  ];
};

/** 元素布局 suite：5 项检查，seed=1000（真实浏览器全部通过）。 */
const LAYOUT_FN = async function () {
  const div = document.createElement('div');
  div.style.cssText = 'display:inline-block;padding:8px;position:absolute;visibility:hidden;';
  div.textContent = 'x';
  document.body.appendChild(div);
  const rect = div.getBoundingClientRect();
  const computed = getComputedStyle(div);
  const checks = [
    div.offsetWidth > 0,
    div.offsetHeight > 0,
    rect.width > 0 && rect.height > 0,
    computed.getPropertyValue('display').length > 0,
    div.scrollHeight > 0
  ];
  document.body.removeChild(div);
  const score = checks.map(Number).reduce((sum, value) => sum + value, 1000);
  return [navigator.userAgent, String(score), String(0)];
};

function installFetchMock(challengeJs, { versionTag = VERSION_TAG, versionSha = VERSION_SHA } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const challengeB64 = b64(challengeJs);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ pathname: url.pathname, headers: init.headers || {} });
    if (url.pathname === '/') {
      const html = versionTag === null ? '<html><head></head><body></body></html>' : `<!doctype html><html data-version-tag="${versionTag}" data-version-sha="${versionSha}"><head></head><body></body></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/duckchat/v1/status') {
      return new Response('{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-vqd-hash-1': challengeB64 }
      });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

async function solveOne(options = {}, mockOptions = {}) {
  const challenge = makeChallenge(options.compute || PAGE_STATE_FN);
  const mock = installFetchMock(challenge, mockOptions);
  try {
    const manager = new ChallengeManager({
      baseUrl: BASE_URL,
      userAgent: USER_AGENT,
      timeoutMs: 5000,
      solveTimeoutMs: 20000,
      logger: null,
      ...options.manager
    });
    await manager.init();
    const lease = await manager.acquire({ reason: 'test' });
    try {
      return JSON.parse(Buffer.from(lease.header, 'base64').toString('utf8'));
    } finally {
      lease.release();
    }
  } finally {
    mock.restore();
  }
}

test('页面状态 suite：#jsa iframe + CSP/meta + 页面全局变量均被识别（client_hash=seed+4）', async () => {
  const payload = await solveOne();
  assert.equal(payload.client_hashes.length, 5);
  // 首项仍是 UA 的 SHA-256+base64
  assert.equal(payload.client_hashes[0], sha256Base64(USER_AGENT));
  // 1000 + 4 项检查全部通过
  assert.equal(payload.client_hashes[1], sha256Base64('1004'), 'page-state suite must see #jsa iframe + page globals');
  // 挑战表达式在 iframe 内执行：window !== window.top
  assert.equal(payload.client_hashes[2], sha256Base64('true'));
  // __DDG_* 取自首页 data-version-tag / data-version-sha
  assert.equal(payload.client_hashes[3], sha256Base64(VERSION_TAG));
  assert.equal(payload.client_hashes[4], sha256Base64(VERSION_SHA));
});

test('布局 suite：offsetWidth/getBoundingClientRect/scrollHeight 被 shim 为正（client_hash=seed+5）', async () => {
  const payload = await solveOne({ compute: LAYOUT_FN });
  assert.equal(payload.client_hashes[1], sha256Base64('1005'), 'layout suite must see positive layout metrics');
});

test('legacyChallengeEnv：复现旧扁平 window 的错误指纹（对照，不作为默认路径）', async () => {
  const pageState = await solveOne({ manager: { legacyChallengeEnv: true } });
  assert.equal(pageState.client_hashes[1], sha256Base64('1000'), 'legacy flat window fails all page-state probes');
  assert.equal(pageState.client_hashes[2], sha256Base64('false'));

  const layout = await solveOne({ compute: LAYOUT_FN, manager: { legacyChallengeEnv: true } });
  assert.equal(layout.client_hashes[1], sha256Base64('1001'), 'legacy jsdom only passes the computed-style probe');
});
