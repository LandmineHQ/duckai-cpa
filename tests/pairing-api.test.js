/**
 * v2.5 扫码配对 Admin API（`/admin/api/sync/pairing` + `/admin/api/sync/official-recovery-code`）。
 *
 * 用 mock PairingService 注入 `createServer({ pairing })`，验证 HTTP 契约：
 *   - POST 启动 → 200 字段齐全；GET 状态；DELETE 停止；无会话 GET/DELETE → pairing:null
 *   - 错误映射：sync_not_enabled 400 / pairing_in_progress 409 / network 503 sync_transport_unavailable / 其它 502
 *   - 未注入 → 503 pairing_unavailable
 *   - 官方恢复码 GET/PUT/DELETE（无明文、缺 code 400）
 *   - status 脱敏（messages 无 payload）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { withServer, adminRequest } from './helpers/test-server.js';

async function tempDataDir(prefix = 'duckai-qa-pairing-api') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function makePairingStatus(overrides = {}) {
  return {
    state: 'waiting',
    channelId: 'chan-qa-1',
    peerChannelId: null,
    peerName: null,
    peerKind: null,
    peerUserId: null,
    lastSeq: 0,
    // 真实 PairingService.status() 已 sanitize（无 payload）；mock 模仿脱敏后的形状
    messages: [{ dir: 'in', type: 'hello', at: 1, seq: 1 }],
    endReason: null,
    endDetail: null,
    completedAs: null,
    httpStatus: null,
    startedAt: Date.now(),
    expiresAt: Date.now() + 300000,
    expiresInMs: 300000,
    qrUrl: 'https://duckduckgo.com/sync/pairing/#&code2=abc',
    pairingCode: 'abc',
    accountAvailable: false,
    syncBase: 'https://sync.duckduckgo.com/sync',
    ...overrides
  };
}

function makePairingService(options = {}) {
  const state = { status: options.status ?? null, starts: 0, stops: 0 };
  const codeState = { configured: false, preview: null, length: 0, updatedAt: null };
  const service = {
    get active() {
      return Boolean(state.status);
    },
    async start() {
      if (options.startError) throw options.startError;
      state.starts += 1;
      state.status = makePairingStatus(options.startStatusOverrides);
      return {
        channelId: state.status.channelId,
        pairingCode: state.status.pairingCode,
        url: state.status.qrUrl,
        qrUrl: state.status.qrUrl,
        expiresAt: state.status.expiresAt,
        state: 'waiting',
        createdAt: state.status.startedAt,
        accountAvailable: false
      };
    },
    async status() {
      return state.status;
    },
    async stop() {
      state.stops += 1;
      const stopped = state.status ? { ...state.status, state: 'failed', endReason: 'aborted' } : null;
      state.status = null;
      return stopped;
    },
    pairingStore: {
      async getStatus() {
        return { ...codeState, hasCode: codeState.configured };
      },
      async getRecoveryCode() {
        return codeState.configured ? 'OFFICIAL-CODE-XYZ' : null;
      },
      async setRecoveryCode(code) {
        codeState.configured = true;
        codeState.length = code.length;
        codeState.preview = `${code.slice(0, 3)}…${code.slice(-2)}`;
        codeState.updatedAt = Date.now();
        return { ...codeState, hasCode: true };
      },
      async clearRecoveryCode() {
        codeState.configured = false;
        codeState.preview = null;
        codeState.length = 0;
        codeState.updatedAt = Date.now();
        return { ...codeState, hasCode: false };
      }
    },
    state
  };
  return service;
}

async function enableSync(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/sync/enable', { method: 'POST', body: {} });
  assert.equal(res.status, 200, `enable sync failed: ${res.text}`);
}

test('POST/GET/DELETE /admin/api/sync/pairing：启动→状态→停止；无会话时 pairing:null', async () => {
  const dataDir = await tempDataDir();
  const pairing = makePairingService();
  await withServer({ identity: true, pairing, dataDir }, async ({ baseUrl }) => {
    const empty = await adminRequest(baseUrl, '/admin/api/sync/pairing');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.pairing, null);

    // sync 未启用 → 400 sync_not_enabled（契约严格值）
    const denied = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method: 'POST', body: {} });
    assert.equal(denied.status, 400, denied.text);
    assert.equal(denied.json.error.code, 'sync_not_enabled');

    await enableSync(baseUrl);
    const started = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method: 'POST', body: {} });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.ok, true);
    assert.equal(started.json.state, 'waiting');
    assert.ok(started.json.channelId);
    assert.ok(String(started.json.url).startsWith('https://duckduckgo.com/sync/pairing/#&code2='));
    assert.equal(started.json.qrUrl, started.json.url);
    assert.ok(started.json.pairing);
    assert.equal(typeof started.json.accountAvailable, 'boolean');

    const status = await adminRequest(baseUrl, '/admin/api/sync/pairing');
    assert.equal(status.status, 200);
    assert.equal(status.json.pairing.state, 'waiting');
    // status 脱敏：messages 不含 payload
    assert.ok(Array.isArray(status.json.pairing.messages));
    assert.ok(!JSON.stringify(status.json.pairing).includes('SECRET-PAYLOAD'), 'pairing status 泄漏 payload');
    assert.ok(!JSON.stringify(status.json.pairing).includes('privateKey'), 'pairing status 泄漏私钥');

    const stopped = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method: 'DELETE' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.ok, true);
    assert.equal(stopped.json.pairing.state, 'failed');

    const after = await adminRequest(baseUrl, '/admin/api/sync/pairing');
    assert.equal(after.status, 200);
    assert.equal(after.json.pairing, null);
  });
});

test('错误映射：pairing_in_progress 409 / network 503 / 其它 502', async () => {
  const dataDir = await tempDataDir();
  for (const [error, expected] of [
    [Object.assign(new Error('busy'), { code: 'pairing_in_progress' }), 409],
    [Object.assign(new Error('offline'), { code: 'network' }), 503],
    [Object.assign(new Error('boom'), { code: 'write_channel_lost' }), 502]
  ]) {
    const pairing = makePairingService({ startError: error });
    await withServer({ identity: true, pairing, dataDir }, async ({ baseUrl }) => {
      await enableSync(baseUrl);
      const res = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method: 'POST', body: {} });
      assert.equal(res.status, expected, `${error.code}: ${res.text}`);
      if (expected === 409) assert.equal(res.json.error.code, 'pairing_in_progress');
      if (expected === 503) {
        assert.equal(res.json.error.code, 'sync_transport_unavailable');
        assert.equal(typeof res.json.error.hint, 'string', '503 应带 hint');
      }
      if (expected === 502) assert.equal(res.json.error.code, 'pairing_start_failed');
    });
  }
});

test('未注入 pairing → GET/POST/DELETE 503 pairing_unavailable', async () => {
  await withServer({}, async ({ baseUrl }) => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await adminRequest(baseUrl, '/admin/api/sync/pairing', { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 503, `${method}: ${res.text}`);
      assert.equal(res.json.error.code, 'pairing_unavailable');
    }
  });
});

test('官方恢复码：GET 无明文 / PUT 保存 / 缺 code 400 / DELETE 清除', async () => {
  const dataDir = await tempDataDir();
  const pairing = makePairingService();
  await withServer({ identity: true, pairing, dataDir }, async ({ baseUrl }) => {
    const initial = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.officialRecoveryCode.configured, false);
    assert.ok(!JSON.stringify(initial.json).includes('OFFICIAL-CODE-XYZ'));

    const invalid = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code', {
      method: 'PUT',
      body: {}
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_request');

    const saved = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code', {
      method: 'PUT',
      body: { code: 'OFFICIAL-CODE-XYZ' }
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.officialRecoveryCode.configured, true);
    assert.equal(saved.json.officialRecoveryCode.length, 'OFFICIAL-CODE-XYZ'.length);
    assert.ok(!JSON.stringify(saved.json).includes('OFFICIAL-CODE-XYZ'), '不应回显官方恢复码明文');

    const fetched = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code');
    assert.equal(fetched.json.officialRecoveryCode.configured, true);
    assert.ok(!JSON.stringify(fetched.json).includes('OFFICIAL-CODE-XYZ'));

    const cleared = await adminRequest(baseUrl, '/admin/api/sync/official-recovery-code', { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.ok, true);
    assert.equal(cleared.json.officialRecoveryCode.configured, false);
  });
});
