/**
 * v2.11 官方恢复码明文查看/下载 + 脱敏边界（task-46）。
 *
 * 契约（待 api-core 最终确认，先按 Lead 任务口径）：
 *   - GET /admin/api/sync/official-recovery-code → {officialRecoveryCode:{configured,hasCode,code,source,length,updatedAt,preview?}}
 *     已配置返回完整 code（与 data/pairing.json 一致）、source=pairing|manual；未配置 configured:false/code:null
 *   - GET .../download → 200 + Content-Disposition(attachment; filename=...)，body 为完整 code；未配置 404 recovery_code_not_configured；无 token 401
 *   - 其它 /sync 响应与错误/日志不含完整 code
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, adminRequest, request } from './helpers/test-server.js';
import { createPairingStore } from '../src/admin/pairing.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const OFFICIAL_CODE = Buffer.from(
  JSON.stringify({ recovery: { user_id: 'reveal-user-1', secret: 'reveal-secret-1' } }),
  'utf8'
).toString('base64url');

async function runReveal(initialCode, assertions) {
  const dataDir = path.join(os.tmpdir(), `duckai-qa-reveal-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(dataDir, { recursive: true });
  const store = await createPairingStore({ dataDir });
  try {
    if (initialCode) await store.setRecoveryCode(initialCode, { source: 'pairing' });
    await withServer({ pairing: { pairingStore: store } }, async (env) => {
      await assertions({ env, store });
    });
  } finally {
    await store.close?.();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

test('GET official-recovery-code：已配置返回完整 code/source/length（与存储一致）', async () => {
  await runReveal(OFFICIAL_CODE, async ({ env, store }) => {
    const res = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(res.status, 200, res.text);
    const info = res.json.officialRecoveryCode;
    assert.equal(info.configured, true);
    assert.equal(info.code, OFFICIAL_CODE, '应返回完整 code');
    assert.equal(info.length, OFFICIAL_CODE.length);
    assert.ok(['pairing', 'manual'].includes(info.source), `source 应为 pairing/manual（实际 ${info.source}）`);
    assert.equal(await store.getRecoveryCode(), OFFICIAL_CODE);
  });
});

test('GET official-recovery-code：未配置 configured:false/code:null；PUT 后变为 manual', async () => {
  await runReveal(null, async ({ env }) => {
    const empty = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.json.officialRecoveryCode.configured, false);
    assert.equal(empty.json.officialRecoveryCode.code ?? null, null);

    const saved = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code', {
      method: 'PUT',
      body: { code: OFFICIAL_CODE }
    });
    assert.equal(saved.status, 200, saved.text);
    const after = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(after.json.officialRecoveryCode.configured, true);
    assert.equal(after.json.officialRecoveryCode.code, OFFICIAL_CODE);
    assert.equal(after.json.officialRecoveryCode.source, 'manual');

    const cleared = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code', { method: 'DELETE' });
    assert.equal(cleared.status, 200, cleared.text);
    const emptyAgain = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(emptyAgain.json.officialRecoveryCode.configured, false);
    assert.equal(emptyAgain.json.officialRecoveryCode.code ?? null, null);
  });
});

test('download：200 + Content-Disposition + 内容等于完整 code；未配置 404；无 token 401', async () => {
  await runReveal(OFFICIAL_CODE, async ({ env }) => {
    const download = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code/download');
    assert.equal(download.status, 200, download.text);
    const disposition = download.headers.get('content-disposition') || '';
    assert.match(disposition, /attachment/i, `Content-Disposition 应 attachment（实际 ${disposition}）`);
    assert.match(disposition, /filename="duckduckgo-official-recovery-code-.*\.txt"/, '文件名应为 duckduckgo-official-recovery-code-*.txt');
    assert.match(String(download.headers.get('content-type') || ''), /text\/plain/, 'Content-Type 应为 text/plain');
    assert.equal(download.headers.get('cache-control'), 'no-store', '应 Cache-Control: no-store');
    assert.equal(download.text.trim(), OFFICIAL_CODE, '下载内容应等于完整 code');
    assert.equal(download.text, OFFICIAL_CODE + '\n', '下载内容为 code + 换行');

    const unauthorized = await request(env.baseUrl, '/admin/api/sync/official-recovery-code/download');
    assert.equal(unauthorized.status, 401, unauthorized.text);
  });

  await runReveal(null, async ({ env }) => {
    const missing = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code/download');
    assert.equal(missing.status, 404, missing.text);
    assert.equal(missing.json?.error?.code, 'recovery_code_not_configured');
  });
});

test('脱敏边界：其它 /sync 响应与错误不含完整 code', async () => {
  await runReveal(OFFICIAL_CODE, async ({ env }) => {
    for (const pathName of [
      '/admin/api/sync',
      '/admin/api/sync/pairing',
      '/admin/api/sync/server-devices',
      '/admin/api/sync/device-slots'
    ]) {
      const res = await adminRequest(env.baseUrl, pathName);
      if (res.status === 200) {
        assert.ok(!res.text.includes(OFFICIAL_CODE), `${pathName} 不应包含完整恢复码`);
      }
    }
    const invalid = await adminRequest(env.baseUrl, '/admin/api/sync/official-recovery-code', {
      method: 'PUT',
      body: {}
    });
    assert.equal(invalid.status, 400);
    assert.ok(!invalid.text.includes(OFFICIAL_CODE), '错误响应不应包含完整恢复码');
  });
});
