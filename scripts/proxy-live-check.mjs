#!/usr/bin/env node
/**
 * v2.3 代理真实联调（scripts/proxy-live-check.mjs）
 *
 * 对**运行中的网关**验证本机代理（默认 127.0.0.1:10808，同时支持 HTTP CONNECT 与 SOCKS5）：
 *   1) GET /admin/api/proxy 保存当前配置；
 *   2) PUT 启用 HTTP 代理 → POST /proxy/test（临时 dispatcher）→ 期望 ok:true、status:200、exitIp 存在；
 *   3) PUT 切到 SOCKS5 → POST /proxy/test → 期望 ok:true、exitIp 存在；
 *   4) /healthz 的 proxy.mode/active 与配置一致；
 *   5) GET /admin/api/sync → transport 应为 available（代理可达 duckduckgo.com）；
 *   6) 恢复原代理配置并复核。
 *
 * 环境守卫（避免 CI 无代理时失败）：
 *   - 默认**不执行**（探测到代理也只输出 BLOCKED，提示加 --with-proxy）；
 *   - `--with-proxy` 或 `QA_WITH_PROXY=1` 时才实际改动配置并测试；
 *   - 代理端口不可达时：BLOCKED（退出码 0），不算失败。
 *
 * 用法:
 *   node scripts/proxy-live-check.mjs --base-url http://127.0.0.1:8787 --admin-token <token> --with-proxy
 *   node scripts/proxy-live-check.mjs --proxy-host 127.0.0.1 --proxy-port 10808 --with-proxy
 *
 * 退出码：0 = 全 PASS / BLOCKED；1 = 有 FAIL；2 = 用法错误。
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    adminToken: process.env.DUCKAI_CPA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    proxyHost: process.env.QA_PROXY_HOST || '127.0.0.1',
    proxyPort: Number(process.env.QA_PROXY_PORT || 10808),
    withProxy: process.env.QA_WITH_PROXY === '1',
    skipRestore: false,
    out: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const eq = arg.indexOf('=');
      if (eq !== -1) return arg.slice(eq + 1);
      index += 1;
      return argv[index];
    };
    switch (true) {
      case arg === '-h' || arg === '--help':
        options.help = true;
        break;
      case arg === '--with-proxy':
        options.withProxy = true;
        break;
      case arg === '--skip-restore':
        options.skipRestore = true;
        break;
      case arg === '--base-url' || arg.startsWith('--base-url='):
        options.baseUrl = String(takeValue()).replace(/\/+$/, '');
        break;
      case arg === '--admin-token' || arg.startsWith('--admin-token='):
        options.adminToken = String(takeValue() || '');
        break;
      case arg === '--proxy-host' || arg.startsWith('--proxy-host='):
        options.proxyHost = String(takeValue());
        break;
      case arg === '--proxy-port' || arg.startsWith('--proxy-port='):
        options.proxyPort = Number(takeValue()) || options.proxyPort;
        break;
      case arg === '--out' || arg.startsWith('--out='):
        options.out = String(takeValue());
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (!/^https?:\/\//.test(options.baseUrl)) throw new UsageError(`--base-url 需要 http(s) 地址: ${options.baseUrl}`);
  if (!options.adminToken) throw new UsageError('需要 --admin-token 或 $DUCKAI_CPA_ADMIN_TOKEN');
  return options;
}

function printHelp() {
  console.log(`v2.3 代理真实联调（本机 10808 HTTP/SOCKS5）

用法: node scripts/proxy-live-check.mjs --admin-token <token> [选项]

选项:
  --base-url <url>      网关地址（默认 $BASE_URL 或 http://127.0.0.1:8787）
  --admin-token <tok>   admin token（必需）
  --proxy-host <host>   本机代理 host（默认 127.0.0.1）
  --proxy-port <port>   本机代理 port（默认 10808）
  --with-proxy          真正的环境守卫：没有它只做探测并输出 BLOCKED
  --skip-restore        测试后不恢复原代理配置（默认恢复）
  --out <file>          结果 JSON 输出路径（默认 data/tmp/proxy-live-check-<ts>.json）
`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snippet(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, reason) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true, 'connected'));
    socket.on('timeout', () => done(false, 'timeout'));
    socket.on('error', (error) => done(false, error.code || error.message));
  });
}

/** 本地构造一个语法合法的 v2 配对码（仅用于强制触发 transport 重探测，pair 预期 501/503） */
function makePairingCode() {
  const payload = {
    version: '2',
    channel_id: crypto.randomUUID(),
    public_key: Buffer.from('qa-probe-public-key').toString('base64url')
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makeClient(options) {
  const auth = { authorization: `Bearer ${options.adminToken}` };
  async function request(pathName, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
    const init = { method, headers: { ...auth, ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${options.baseUrl}${pathName}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  }
  return { request };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`错误: ${error.message}\n`);
    printHelp();
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  const client = makeClient(options);
  const startedAt = Date.now();
  console.log(
    `duckai-cpa proxy-live-check — gateway ${options.baseUrl} · proxy ${options.proxyHost}:${options.proxyPort} · guard=${
      options.withProxy ? 'on' : 'off'
    }\n`
  );

  const results = [];
  const record = (name, status, detail) => {
    results.push({ name, status, detail });
    const label =
      status === 'PASS' ? paint(GREEN, '[PASS]') : status === 'BLOCKED' ? paint(YELLOW, '[BLOCKED]') : paint(RED, '[FAIL]');
    console.log(`${label} ${name.padEnd(26)} ${detail || ''}`);
  };

  const probe = await probeTcp(options.proxyHost, options.proxyPort);
  if (!probe.ok) {
    record('代理端口可达', 'BLOCKED', `${options.proxyHost}:${options.proxyPort} 不可达（${probe.reason}）`);
    return finish(results, startedAt, options, 0);
  }
  record('代理端口可达', 'PASS', `${options.proxyHost}:${options.proxyPort}`);

  if (!options.withProxy) {
    record('真实代理联调', 'BLOCKED', '环境守卫：未传 --with-proxy / QA_WITH_PROXY=1，未修改网关配置');
    return finish(results, startedAt, options, 0);
  }

  // 保存原配置
  let original = null;
  const before = await client.request('/admin/api/proxy');
  if (before.status === 200 && before.json?.proxy) {
    original = before.json.proxy;
    record('读取当前代理配置', 'PASS', `enabled=${original.enabled} type=${original.type} ${original.host || '-'}:${original.port || '-'}`);
  } else {
    record('读取当前代理配置', 'FAIL', `HTTP ${before.status}: ${snippet(before.text)}`);
    return finish(results, startedAt, options, 1);
  }

  try {
    for (const type of ['http', 'socks5']) {
      const put = await client.request('/admin/api/proxy', {
        method: 'PUT',
        body: {
          enabled: true,
          type,
          host: options.proxyHost,
          port: options.proxyPort,
          noProxy: []
        }
      });
      if (put.status !== 200 || put.json?.ok !== true) {
        record(`PUT 启用 ${type}`, 'FAIL', `HTTP ${put.status}: ${snippet(put.text)}`);
        continue;
      }
      record(`PUT 启用 ${type}`, 'PASS', `mode=${put.json.proxy?.status?.mode}`);

      const tested = await client.request('/admin/api/proxy/test', {
        method: 'POST',
        body: {
          type,
          host: options.proxyHost,
          port: options.proxyPort,
          noProxy: []
        },
        timeoutMs: 90000
      });
      const result = tested.json || {};
      if (tested.status !== 200) {
        record(`POST test ${type}`, 'FAIL', `HTTP ${tested.status}: ${snippet(tested.text)}`);
        continue;
      }
      assert(result.ok === true, `${type} 测试未成功: ${snippet(tested.text, 240)}`);
      assert(result.status === 200, `${type} 目标 status 非 200: ${result.status}`);
      assert(Number(result.latencyMs) > 0, `${type} latencyMs 异常: ${result.latencyMs}`);
      assert(typeof result.exitIp === 'string' && result.exitIp.length > 0, `${type} 缺少 exitIp`);
      record(
        `POST test ${type}`,
        'PASS',
        `status=${result.status} latency=${result.latencyMs}ms exitIp=${result.exitIp} mode=${result.mode}`
      );

      const health = await client.request('/healthz');
      assert(health.status === 200, `healthz HTTP ${health.status}`);
      assert(health.json?.proxy?.enabled === true, 'healthz.proxy.enabled 应为 true');
      assert(health.json?.proxy?.mode === type, `healthz.proxy.mode 应为 ${type}，实际 ${health.json?.proxy?.mode}`);
      assert(health.json?.proxy?.active === true, 'healthz.proxy.active 应为 true');
      record(`healthz proxy ${type}`, 'PASS', `mode=${health.json.proxy.mode} active=${health.json.proxy.active}`);
    }

    // sync transport 应为 available（代理可访问 duckduckgo.com）。
    // 注意 IdentityStore 对 transport 探测有 ~30s 缓存；若刚切换代理后仍读到旧 blocked，
    // 用 POST /sync/pair（内部 force 重探测）作为权威判定：available → 501 sync_handshake_unimplemented。
    let sync = await client.request('/admin/api/sync');
    let transport = sync.status === 200 ? sync.json?.sync?.transport : null;
    let viaPairProbe = false;
    if (transport === 'blocked') {
      try {
        const pairingCode = makePairingCode();
        const paired = await client.request('/admin/api/sync/pair', { method: 'POST', body: { code: pairingCode } });
        if (paired.status === 501 && paired.json?.error?.code === 'sync_handshake_unimplemented') {
          viaPairProbe = true;
          sync = await client.request('/admin/api/sync');
          transport = sync.status === 200 ? sync.json?.sync?.transport : transport;
        } else if (paired.status === 503) {
          transport = 'blocked';
        }
      } catch {
        /* 保持原 transport */
      }
    }
    if (sync.status === 200 && sync.json?.sync) {
      record(
        'sync transport',
        transport === 'available' ? 'PASS' : 'FAIL',
        `transport=${transport}${viaPairProbe ? '（pair force 探测 501→available）' : ''}${
          transport === 'available' ? '' : '（期望 available；若刚切换代理请等 transport 缓存 30s 后重试）'
        }`
      );
    } else {
      record('sync transport', 'BLOCKED', `/admin/api/sync HTTP ${sync.status}（接口不可用，跳过）`);
    }
  } catch (error) {
    record('真实代理联调', 'FAIL', error?.message || String(error));
  } finally {
    if (!options.skipRestore && original) {
      try {
        const restore = await client.request('/admin/api/proxy', {
          method: 'PUT',
          body: {
            enabled: original.enabled,
            type: original.type,
            host: original.host,
            port: original.port,
            noProxy: original.noProxy,
            testUrl: original.testUrl,
            ipCheckUrl: original.ipCheckUrl
          }
        });
        const ok = restore.status === 200 && restore.json?.ok === true;
        record('恢复原代理配置', ok ? 'PASS' : 'FAIL', `HTTP ${restore.status}: ${snippet(restore.text)}`);
        if (ok) {
          await sleep(200);
          const health = await client.request('/healthz');
          const mode = health.json?.proxy?.mode;
          record('恢复后 healthz', mode === (original.enabled ? original.type : 'direct') ? 'PASS' : 'FAIL', `mode=${mode}`);
        }
      } catch (error) {
        record('恢复原代理配置', 'FAIL', error?.message || String(error));
      }
    }
  }

  const failed = results.filter((item) => item.status === 'FAIL').length;
  return finish(results, startedAt, options, failed > 0 ? 1 : 0);
}

async function finish(results, startedAt, options, exitCode) {
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  const blocked = results.filter((item) => item.status === 'BLOCKED').length;
  const totalMs = Date.now() - startedAt;
  console.log();
  const line = `proxy-live-check: ${passed} passed, ${failed} failed, ${blocked} blocked (${(totalMs / 1000).toFixed(1)}s)`;
  console.log(failed > 0 ? paint(RED, `✖ ${line}`) : blocked > 0 ? paint(YELLOW, `⚠ ${line}`) : paint(GREEN, `✔ ${line}`));

  const outPath = options.out || path.join(PROJECT_ROOT, 'data', 'tmp', `proxy-live-check-${Date.now()}.json`);
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          baseUrl: options.baseUrl,
          proxy: { host: options.proxyHost, port: options.proxyPort },
          guarded: !options.withProxy,
          results,
          summary: { passed, failed, blocked, totalMs }
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`报告: ${outPath}`);
  } catch (error) {
    console.error(`写入报告失败: ${error.message}`);
  }
  if (blocked > 0 && failed === 0) {
    console.log(paint(YELLOW, '提示：BLOCKED 表示当前环境未启用/无代理联调条件，不算失败。'), DIM ? '' : '');
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
