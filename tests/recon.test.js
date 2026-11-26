/**
 * 前端 Recon 识别与漂移对比离线测试（tests/recon.test.js）。
 * 使用注入 fetchImpl，绝不触碰真实外网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  compareLive,
  extractContractMarkers,
  normalizeHtmlForHash,
  shouldFetchAsset,
  takeSnapshot
} from '../src/recon/snapshot.js';
import { withServer, adminRequest } from './helpers/test-server.js';

test('recon：HTML nonce 噪声归一化 + 静态媒体过滤 + 契约标记与新模型扫描', () => {
  const htmlA = '<!doctype html><html data-version-tag="v1" data-version-sha="abc"><script nonce="rAnDoM1111" src="/app.js"></script><img src="/logo.png"></html>';
  const htmlB = '<!doctype html><html data-version-tag="v1" data-version-sha="abc"><script nonce="oThEr22222" src="/app.js"></script><img src="/logo.png"></html>';
  assert.equal(normalizeHtmlForHash(htmlA), normalizeHtmlForHash(htmlB));

  assert.equal(shouldFetchAsset('https://duck.ai/app.js'), true);
  assert.equal(shouldFetchAsset('https://duck.ai/style.css'), true);
  assert.equal(shouldFetchAsset('https://duck.ai/logo.png'), false);
  assert.equal(shouldFetchAsset('https://duck.ai/font.woff2'), false);
  assert.equal(shouldFetchAsset('https://duck.ai/app.js.map'), false);

  const jsBundle = `
    const endpoints = ["/duckchat/v1/chat", "/duckchat/v1/status", "/duckchat/v1/capabilities", "/duckchat/v1/summarize", "/duckchat/v1/auth/token"];
    const headers = ["x-vqd-hash-1", "x-fe-version", "x-fe-signals", "x-duckai-continuation", "x-duckai-consent-purposes"];
    const parts = { durableStream: 1, type: "generated-image", tools: ["GenerateImage", "WebSearch", "ReadDocument"] };
    const models = ["gpt-6-luna", "claude-sonnet-6-0"];
  `;
  const markers = extractContractMarkers(htmlA, [{ url: 'https://duck.ai/app.js', text: jsBundle }]);
  assert.equal(markers.versionTag, 'v1');
  assert.equal(markers.chatEndpoint, true);
  assert.equal(markers.vqdChallengeHeader, true);
  assert.equal(markers.generatedImagePart, true);
  assert.ok(markers.detectedModels.includes('gpt-6-luna'));
  assert.ok(markers.unknownModels.includes('claude-sonnet-6-0'));
});

test('recon：takeSnapshot + compareLive + /admin/api/recon/{status,pull,diff} 完整链路', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckai-recon-qa-'));
  let phase = 1;
  const mockFetch = async (url) => {
    const href = String(url);
    if (href === 'https://duck.ai/' || href === 'https://duck.ai') {
      const nonce = phase === 1 ? 'nonceAAA111' : 'nonceBBB222';
      const tag = phase <= 2 ? 'serp_v1' : 'serp_v2';
      return new Response(
        `<!doctype html><html data-version-tag="${tag}" data-version-sha="sha1"><script nonce="${nonce}" src="/bundle.js"></script><img src="/skip.png"></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (href.endsWith('/bundle.js')) {
      const extra = phase === 3 ? ' const newModel = "gpt-7-nova"; const ep = "/duckchat/v1/summarize";' : '';
      return new Response(
        `"/duckchat/v1/chat"; "x-vqd-hash-1"; "GenerateImage"; "gpt-6-luna";${extra}`,
        { status: 200, headers: { 'content-type': 'application/javascript' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  try {
    // 直接单测 takeSnapshot & compareLive
    const baseline = await takeSnapshot({ outDir: tmpDir, fetchImpl: mockFetch, delayMs: 0 }, { write: true });
    assert.equal(baseline.assets.length, 2, '应跳过 skip.png 只抓 html 和 bundle.js');

    phase = 2; // 只改 HTML nonce → 归一化哈希一致 → same === true
    const sameDiff = await compareLive({ outDir: tmpDir, fetchImpl: mockFetch, delayMs: 0 });
    assert.equal(sameDiff.same, true);

    phase = 3; // 改版本和 bundle 内容 → 触发 markerChanges & modelChanges
    const changedDiff = await compareLive({ outDir: tmpDir, fetchImpl: mockFetch, delayMs: 0 });
    assert.equal(changedDiff.same, false);
    assert.equal(changedDiff.versionChanged, true);
    assert.ok(changedDiff.modelChanges.unknownLive.includes('gpt-7-nova'));
    assert.ok(changedDiff.markerChanges.some((m) => m.key === 'summarizeEndpoint'));

    // HTTP Admin API 测试
    const reconOutDir = path.join(tmpDir, 'api-recon');
    phase = 1;
    await withServer({ reconFetch: mockFetch, reconOutDir }, async ({ baseUrl }) => {
      const initial = await adminRequest(baseUrl, '/admin/api/recon/status');
      assert.equal(initial.status, 200);
      assert.equal(initial.json.baselineExists, false);

      const pulled = await adminRequest(baseUrl, '/admin/api/recon/pull', { method: 'POST', body: {} });
      assert.equal(pulled.status, 200);
      assert.equal(pulled.json.baselineExists, true);
      assert.equal(pulled.json.targets.versionTag, 'serp_v1');

      phase = 3;
      const diffRes = await adminRequest(baseUrl, '/admin/api/recon/diff', { method: 'POST', body: {} });
      assert.equal(diffRes.status, 200);
      assert.equal(diffRes.json.same, false);
      assert.ok(diffRes.json.modelChanges.unknownLive.includes('gpt-7-nova'));
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
