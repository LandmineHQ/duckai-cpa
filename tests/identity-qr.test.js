/**
 * v2.4 前端「身份池 / 二维码」静态与数据层验收（无需浏览器）。
 *
 * 覆盖：
 *   - 配对 URL（`#&code2=`）可被 qrcode 编码为 data:image/png;base64（页面二维码内容正确性）
 *   - 身份页源码包含二维码渲染（qrcode/toDataURL/<img src=data:image>）、配对码 URL 与下载/复制入口
 *   - 身份池页源码存在，并引用 /admin/api/identities（列表/generate/activate/rotate/bindings/routing 等）
 *   - 构建产物包含二维码与身份池 API 标记
 *
 * 说明：`npm test` 无浏览器，故 QR 的 DOM 结果在 E2E（Chrome devtools）单独验收；
 * 这里断言数据层（QR 编码真实可解码为 PNG）+ 源码/产物渲染路径，防止回归。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

import QRCode from 'qrcode';
import { buildPairingCode, buildPairingUrl } from '../src/duck/sync.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

async function readText(relativePath) {
  return fs.readFile(path.join(PROJECT_ROOT, relativePath), 'utf8').catch(() => null);
}

test('配对 URL 可由 qrcode 生成 PNG data URL（内容 = code2 URL）', async () => {
  const crypto = await import('node:crypto');
  const built = buildPairingCode({
    channelId: crypto.randomUUID(),
    publicKeyBase64Url: 'ZmFrZS1xYS1wdWJsaWMta2V5'
  });
  const url = buildPairingUrl(built.code);
  assert.ok(url.startsWith('https://duckduckgo.com/sync/pairing/#&code2='));

  const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '应为合法 PNG');

  // 同一 URL 编码稳定；不同 URL 输出不同
  const again = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
  assert.equal(again, dataUrl);
  const other = await QRCode.toDataURL(`${url}different`);
  assert.notEqual(other, dataUrl);
});

test('身份页源码包含二维码渲染（qrcode/toDataURL + img[data:image]）与配对码 URL', async () => {
  const source = (await readText('webapp/src/app/pages/identity.tsx')) || '';
  assert.ok(source.length > 0, '缺少 webapp/src/app/pages/identity.tsx');
  assert.match(source, /qrcode|QRCode|toDataURL/i, '身份页未引用二维码生成库');
  assert.match(source, /data:image|toDataURL/, '身份页未生成 data:image 二维码');
  assert.match(source, /<img|createElement\(['"]canvas['"]\)|canvas/i, '身份页未渲染二维码元素');
  assert.match(source, /pairingCode|pairing.*url|code2=/i, '身份页未使用配对 URL');
});

test('身份池页存在并引用 /admin/api/identities 端点', async () => {
  const source = (await readText('webapp/src/app/pages/identities.tsx')) || '';
  assert.ok(source.length > 0, '缺少 webapp/src/app/pages/identities.tsx');
  for (const marker of ['/identities', 'generate', 'activate', 'rotate', 'bindings', 'routing']) {
    assert.ok(source.includes(marker), `身份池页缺少 ${marker}`);
  }
  assert.match(source, /identityId|identityLabel/, '身份池页缺少 identityId/identityLabel');
});

test('侧边栏/路由包含身份池入口与二维码文案', async () => {
  const sidebar = (await readText('webapp/src/app/components/sidebar.tsx')) || '';
  const app = (await readText('webapp/src/app/App.tsx')) || '';
  const hashRoute = (await readText('webapp/src/app/lib/hash-route.ts')) || '';
  const combined = `${sidebar}\n${app}\n${hashRoute}`;
  assert.match(combined, /身份池/, '缺少「身份池」入口');
  assert.match(combined, /identities/, '缺少 identities 路由');
});

test('构建产物包含身份池与二维码标记', async () => {
  const html = await readText('web/index.html');
  assert.ok(html, '缺少 web/index.html（先 npm run build:web）');
  const jsRef = html.match(/(?:src|href)="([^"]+\.js)"/);
  assert.ok(jsRef, 'index.html 未引用 js 产物');
  const bundlePath = path.join(PROJECT_ROOT, 'web', jsRef[1].replace(/^\/admin\//, '').replace(/^\/+/, ''));
  const bundle = await fs.readFile(bundlePath, 'utf8');
  assert.match(bundle, /\/identities/, '构建产物缺少 identities API');
  assert.match(bundle, /身份池/, '构建产物缺少「身份池」文案');
  assert.match(bundle, /二维码|扫码/, '构建产物缺少「二维码/扫码」文案');
  assert.match(bundle, /toDataURL|data:image\/png/, '构建产物缺少二维码 data URL 生成');
});
