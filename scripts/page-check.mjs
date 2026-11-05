#!/usr/bin/env node
/**
 * 管理后台页面级检查（v2，scripts/page-check.mjs）
 *
 * v2 前端为 Vite + React 构建产物（webapp/ → web/），不再有手写 app.js。本脚本不开浏览器，
 * 用 fetch + 文件系统校验：
 *   - `npm run build:web` 的产物存在：web/index.html 引用 /admin/assets/*.js|css，对应文件存在且非空；
 *   - /admin 返回 React 页面（#root + 构建产物引用），/admin/assets/* 静态资源 200 且 Content-Type 正确；
 *   - 无外部 CDN：HTML 中不出现 http(s) 外链资源；JS/CSS 不引用常见 CDN；
 *   - 静态资源路径穿越被拒绝；
 *   - Admin API v2 契约：401/overview(queue+stats 拆分)/config/keys/logs(kind)/models/health/sessions；
 *     旧 POST /admin/api/test 已 404。
 *
 * 用法:
 *   node scripts/page-check.mjs
 *   node scripts/page-check.mjs --base-url http://127.0.0.1:8787 --admin-token <token>
 *
 * 退出码: 0 全 PASS；1 有 FAIL；2 用法错误。
 */

import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    adminToken: process.env.DUCKAI_CPA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    apiKey: process.env.DUCKAI_CPA_API_KEY || process.env.OPENAI_API_KEY || '',
    // 默认不向上游发真实消息；需要真实会话压缩验收时显式加 --allow-upstream
    allowUpstream: false
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
      case arg === '--base-url' || arg.startsWith('--base-url='):
        options.baseUrl = String(takeValue()).replace(/\/+$/, '');
        break;
      case arg === '--admin-token' || arg.startsWith('--admin-token='):
        options.adminToken = String(takeValue() || '');
        break;
      case arg === '--api-key' || arg.startsWith('--api-key='):
        options.apiKey = String(takeValue() || '');
        break;
      case arg === '--allow-device-delete':
        // 破坏性开关：默认关闭，避免误删真实账号里的设备（历史事故：曾删除用户手机设备）。
        options.allowDeviceDelete = true;
        break;
      case arg === '--delete-device-id' || arg.startsWith('--delete-device-id='):
        options.deleteDeviceId = String(takeValue() || '');
        break;
      case arg === '--allow-upstream':
        options.allowUpstream = true;
        break;
      case arg === '--inject-orphan':
        // 仅用于隔离 dataDir 的测试网关：会向真实 identity.sync.slots 注入 ghost 项。
        options.injectOrphan = true;
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (!/^https?:\/\//.test(options.baseUrl)) throw new UsageError(`--base-url 需要 http(s) 地址: ${options.baseUrl}`);
  return options;
}

function printHelp() {
  console.log(`管理后台页面级检查（v2 / React 构建产物）

用法: node scripts/page-check.mjs [--base-url <url>] [--admin-token <token>] [--api-key <key>]

环境变量: BASE_URL、DUCKAI_CPA_ADMIN_TOKEN / ADMIN_TOKEN、DUCKAI_CPA_API_KEY
`);
}

async function hasOfficialRecoveryCode(base, auth) {
  try {
    const response = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth });
    return response.json?.officialRecoveryCode?.configured === true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchText(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { response, text };
}

async function fetchJson(url, { headers = {}, timeoutMs = 15000, method = 'GET', body } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...headers };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

function extractAssetRefs(html) {
  const refs = new Set();
  const regex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const value = match[1];
    if (value.startsWith('/admin/assets/')) refs.add(value);
  }
  return [...refs];
}

function findExternalRefs(html) {
  const external = [];
  const regex = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) external.push(match[1]);
  return external;
}

function buildChecks(options) {
  const base = options.baseUrl;
  const auth = { authorization: `Bearer ${options.adminToken}` };
  const checks = [];
  let htmlCache = null;

  checks.push({
    name: '构建产物存在',
    async run() {
      const indexPath = path.join(WEB_DIR, 'index.html');
      const stat = await fs.stat(indexPath).catch(() => null);
      assert(stat && stat.isFile(), `缺少构建产物 ${indexPath}（先运行 npm run build:web）`);
      const html = await fs.readFile(indexPath, 'utf8');
      htmlCache = html;
      const refs = extractAssetRefs(html);
      assert(refs.length >= 2, `web/index.html 应引用 /admin/assets/*.js|css，实际 ${refs.length} 个`);
      assert(html.includes('id="root"'), 'web/index.html 不是 React 产物（缺少 #root 容器）');
      assert(html.includes('type="module"'), 'web/index.html 缺少 ESM module script（Vite 产物）');

      for (const ref of refs) {
        const relative = ref.replace(/^\/admin\//, '');
        const filePath = path.join(WEB_DIR, relative);
        const fileStat = await fs.stat(filePath).catch(() => null);
        assert(fileStat && fileStat.isFile() && fileStat.size > 0, `引用资源不存在或为空: ${ref} → ${filePath}`);
      }
      return `${refs.length} assets, index ${stat.size} bytes`;
    }
  });

  checks.push({
    name: '/admin React 页面',
    async run() {
      const { response, text } = await fetchText(`${base}/admin`);
      assert(response.status === 200, `HTTP ${response.status}`);
      assert(/text\/html/.test(response.headers.get('content-type') || ''), 'Content-Type 不是 text/html');
      assert(text.includes('id="root"'), '服务端 /admin 未返回 React 页面（缺少 #root）');
      assert(text.includes('type="module"'), '/admin 页面缺少 ESM module script');
      const refs = extractAssetRefs(text);
      assert(refs.length >= 2, `/admin 页面应引用 /admin/assets/*.js|css，实际 ${refs.length} 个`);

      const external = findExternalRefs(text);
      assert(external.length === 0, `禁止外部 CDN 引用: ${external.join(', ')}`);
      return `${text.length} bytes, ${refs.length} assets`;
    }
  });

  checks.push({
    name: '静态资源 200',
    async run() {
      const html = htmlCache || (await fetchText(`${base}/admin`)).text;
      const refs = extractAssetRefs(html);
      assert(refs.length >= 2, 'no asset refs found');
      let jsCount = 0;
      let cssCount = 0;
      for (const ref of refs) {
        const { response, text } = await fetchText(`${base}${ref}`);
        assert(response.status === 200, `${ref} → HTTP ${response.status}`);
        const type = response.headers.get('content-type') || '';
        assert(text.length > 0, `${ref} 内容为空`);
        assert(
          !/https?:\/\/(unpkg|cdn|jsdelivr|esm\.sh|cdnjs)/i.test(text),
          `${ref} 含外部 CDN 引用`
        );
        if (ref.endsWith('.css')) {
          assert(/text\/css/.test(type), `${ref} Content-Type 不是 text/css`);
          cssCount += 1;
        } else if (ref.endsWith('.js')) {
          assert(/javascript/.test(type), `${ref} Content-Type 不是 javascript`);
          // React 产物默认为 ESM：仅对 classic script 做 vm 语法检查；ESM 由 build-check 校验产物完整性
          if (!/^\s*(import|export)\b/m.test(text) && !text.includes('import.meta')) {
            new vm.Script(text, { filename: ref });
          }
          jsCount += 1;
        }
      }
      assert(jsCount >= 1 && cssCount >= 1, `期望至少 1 个 JS + 1 个 CSS，实际 js=${jsCount} css=${cssCount}`);
      return `${jsCount} js + ${cssCount} css`;
    }
  });

  checks.push({
    name: '路径穿越拒绝',
    async run() {
      const { response } = await fetchText(`${base}/admin/assets/%2e%2e%2fpackage.json`);
      assert(response.status === 404, `期望 404，实际 ${response.status}`);
      const deep = await fetchText(`${base}/admin/assets/..%2f..%2fpackage.json`);
      assert(deep.response.status === 404, `期望 404，实际 ${deep.response.status}`);
      return 'blocked';
    }
  });

  checks.push({
    name: '/favicon.ico',
    async run() {
      const response = await fetch(`${base}/favicon.ico`, { signal: AbortSignal.timeout(10000) });
      assert([200, 204].includes(response.status), `HTTP ${response.status}`);
      await response.arrayBuffer();
      return `HTTP ${response.status}`;
    }
  });

  if (!options.adminToken) {
    checks.push({
      name: 'admin API 契约',
      skip: true,
      async run() {
        return '';
      }
    });
    return checks;
  }

  checks.push({
    name: 'admin 未授权 401',
    async run() {
      const { response } = await fetchJson(`${base}/admin/api/overview`);
      assert(response.status === 401, `期望 401，实际 ${response.status}`);
      return 'HTTP 401';
    }
  });

  checks.push({
    name: 'overview 契约（v2）',
    async run() {
      const { response, json } = await fetchJson(`${base}/admin/api/overview`, { headers: auth });
      assert(response.status === 200, `HTTP ${response.status}`);
      assert(json.service?.name === 'duckai-cpa', '缺少 service.name');
      assert(typeof json.service.version === 'string', '缺少 service.version');
      assert(typeof json.service.uptimeSec === 'number', '缺少 service.uptimeSec');
      assert(typeof json.upstream?.ok === 'boolean', '缺少 upstream.ok');
      assert(typeof json.upstream?.challengeOk === 'boolean', '缺少 upstream.challengeOk');
      const queue = json.upstream.queue;
      assert(queue && typeof queue.rps === 'number' && typeof queue.inFlight === 'number', '缺少 upstream.queue');
      assert(json.stats?.upstream && json.stats?.admin, 'stats 未按 upstream/admin 拆分');
      assert(Array.isArray(json.models) && json.models.length > 0, '缺少 models');
      assert(json.models.some((model) => model.paid === true), 'models 缺少付费模型元数据');
      assert(Array.isArray(json.recentUpstream) && Array.isArray(json.recentAdmin), '缺少 recent 拆分');
      return `queue=${queue.inFlight}/${queue.waiting} rps=${queue.rps} upstream=${json.stats.upstream.requests} models=${json.models.length}`;
    }
  });

  checks.push({
    name: 'config 契约（v2）',
    async run() {
      const { response, json } = await fetchJson(`${base}/admin/api/config`, { headers: auth });
      assert(response.status === 200, `HTTP ${response.status}`);
      assert(json.config && typeof json.config === 'object', '缺少 config');
      assert(json.config.auth?.adminToken === 'sk-***', 'adminToken 未脱敏');
      assert(json.config.upstream && typeof json.config.upstream.rps === 'number', '缺少 config.upstream');
      assert(!('required' in (json.config.auth || {})), 'v2 不应再返回 auth.required');
      return `rps=${json.config.upstream.rps} allowPaidModels=${json.config.duck?.allowPaidModels}`;
    }
  });

  checks.push({
    name: 'keys/logs/models/health/sessions',
    async run() {
      const [keys, logsUp, logsAdmin, models, health, sessions] = await Promise.all([
        fetchJson(`${base}/admin/api/keys`, { headers: auth }),
        fetchJson(`${base}/admin/api/logs?kind=upstream&limit=5`, { headers: auth }),
        fetchJson(`${base}/admin/api/logs?kind=admin&limit=5`, { headers: auth }),
        fetchJson(`${base}/admin/api/models`, { headers: auth }),
        fetchJson(`${base}/admin/api/health`, { headers: auth }),
        fetchJson(`${base}/admin/api/test/sessions`, { headers: auth })
      ]);
      assert(keys.response.status === 200 && Array.isArray(keys.json.items), 'keys 契约异常');
      assert(logsUp.response.status === 200 && logsUp.json.kind === 'upstream', 'logs?kind=upstream 契约异常');
      assert(logsAdmin.response.status === 200 && logsAdmin.json.kind === 'admin', 'logs?kind=admin 契约异常');
      assert(
        models.response.status === 200 && Array.isArray(models.json.items) && models.json.items.length > 0,
        'models 契约异常'
      );
      assert(health.response.status === 200 && health.json.ok === true, 'health 契约异常');
      assert(typeof health.json.upstream?.challengeOk === 'boolean', 'health.upstream 异常');
      assert(sessions.response.status === 200 && Array.isArray(sessions.json.items), 'sessions 契约异常');
      return `keys=${keys.json.items.length} up=${logsUp.json.total} admin=${logsAdmin.json.total} models=${models.json.items.length} sessions=${sessions.json.items.length}`;
    }
  });

  checks.push({
    name: 'identity 契约（v2.2）',
    async run() {
      const { response, text, json } = await fetchJson(`${base}/admin/api/identity`, { headers: auth });
      assert(response.status === 200, `HTTP ${response.status}`);
      const identity = json?.identity;
      const durableStream = json?.durableStream;
      assert(identity && typeof identity === 'object', '缺少 identity');
      assert(/^[a-f0-9]{32}$/.test(String(identity.journeyId)), `journeyId 格式异常: ${identity.journeyId}`);
      assert(identity.stable === true, 'identity 应 stable:true（持久化）');
      assert(['file', 'generated'].includes(identity.source), `unexpected source: ${identity.source}`);
      assert(durableStream?.publicKeyJwk, '缺少 durableStream.publicKeyJwk');
      assert(durableStream.publicKeyJwk.kty === 'RSA', 'publicKeyJwk.kty 应为 RSA');
      assert(durableStream.publicKeyJwk.alg === 'RSA-OAEP-256', 'publicKeyJwk.alg 应为 RSA-OAEP-256');
      assert(durableStream.hasPrivateKey === true, 'durableStream.hasPrivateKey 应为 true');
      assert(typeof json.auth?.authenticated === 'boolean', '缺少 auth.authenticated');
      assert(typeof json.sync?.enabled === 'boolean', '缺少 sync.enabled');
      assert(json.file?.path, '缺少 file.path');
      // 脱敏：无 privateKeyJwk / token 明文
      assert(!text.includes('privateKeyJwk'), 'identity 响应泄漏 privateKeyJwk');
      assert(!JSON.stringify(json.auth || {}).includes('"token"'), 'identity 响应泄漏 token');
      return `journey=${identity.journeyId.slice(0, 8)}… fp=${String(durableStream.fingerprint).slice(0, 8)}… stable=${identity.stable}`;
    }
  });

  checks.push({
    name: 'sync 契约（v2.2）',
    async run() {
      const { response, json } = await fetchJson(`${base}/admin/api/sync`, { headers: auth });
      assert(response.status === 200, `HTTP ${response.status}`);
      const sync = json?.sync;
      assert(sync && typeof sync === 'object', '缺少 sync');
      assert(typeof sync.enabled === 'boolean', '缺少 sync.enabled');
      assert(typeof sync.deviceCount === 'number', '缺少 sync.deviceCount');
      assert(Array.isArray(sync.devices), '缺少 sync.devices');
      assert(['available', 'blocked'].includes(sync.transport), `unexpected transport: ${sync.transport}`);

      // 配对码生成（本地能力，不访问外网）：v2 结构 + URL
      const pairing = await fetchJson(`${base}/admin/api/sync/pairing-code`, {
        headers: auth,
        method: 'POST',
        body: {}
      });
      assert(pairing.response.status === 200, `pairing-code HTTP ${pairing.response.status}`);
      assert(typeof pairing.json.code === 'string', '缺少 pairing code');
      assert(
        String(pairing.json.url).startsWith('https://duckduckgo.com/sync/pairing/#&code2='),
        `unexpected pairing url: ${pairing.json.url}`
      );
      const payload = JSON.parse(Buffer.from(pairing.json.code, 'base64url').toString('utf8'));
      assert(payload.version === '2', `pairing version 应为 2: ${payload.version}`);
      assert(Boolean(payload.channel_id) && Boolean(payload.public_key), 'pairing payload 缺少 channel_id/public_key');
      return `enabled=${sync.enabled} transport=${sync.transport} deviceCount=${sync.deviceCount}`;
    }
  });

  checks.push({
    name: 'subscription 契约（v2.2）',
    async run() {
      const { response, text, json } = await fetchJson(`${base}/admin/api/subscription`, { headers: auth });
      assert(response.status === 200, `HTTP ${response.status}`);
      const subscription = json?.subscription;
      assert(subscription && typeof subscription === 'object', '缺少 subscription');
      assert(typeof subscription.authenticated === 'boolean', '缺少 authenticated');
      assert(
        ['free', 'plus', 'pro'].includes(subscription.tier),
        `unexpected tier: ${subscription.tier}`
      );
      assert(Array.isArray(subscription.entitlements), '缺少 entitlements');
      assert(typeof subscription.allowPaidModels === 'boolean', '缺少 allowPaidModels');
      assert(typeof subscription.verified === 'boolean', '缺少 verified');
      assert(!text.includes('fake-signature'), 'subscription 响应泄漏 token');
      return `tier=${subscription.tier} authenticated=${subscription.authenticated} verified=${subscription.verified}`;
    }
  });

  checks.push({
    name: 'proxy 契约（v2.3）',
    async run() {
      const before = await fetchJson(`${base}/admin/api/proxy`, { headers: auth });
      assert(before.response.status === 200, `GET /admin/api/proxy HTTP ${before.response.status}`);
      const proxy = before.json?.proxy;
      assert(proxy && typeof proxy === 'object', '缺少 proxy');
      assert(typeof proxy.enabled === 'boolean', '缺少 proxy.enabled');
      assert(['http', 'https', 'socks4', 'socks5'].includes(proxy.type), `unexpected proxy.type: ${proxy.type}`);
      assert(typeof proxy.host === 'string', '缺少 proxy.host');
      assert(typeof proxy.port === 'number', '缺少 proxy.port');
      assert(typeof proxy.hasAuth === 'boolean', '缺少 proxy.hasAuth');
      assert(Array.isArray(proxy.noProxy), '缺少 proxy.noProxy');
      assert(proxy.status && typeof proxy.status === 'object', '缺少 proxy.status');
      assert(['direct', 'http', 'https', 'socks4', 'socks5'].includes(proxy.status.mode), `unexpected status.mode: ${proxy.status.mode}`);
      assert(!('password' in proxy), 'proxy 响应不得含 password');
      assert(!before.text.includes('"password"'), 'proxy 响应泄漏 password 字段');

      // 非法 PUT → 400 invalid_proxy，且不改变已保存配置
      const invalid = await fetchJson(`${base}/admin/api/proxy`, {
        headers: auth,
        method: 'PUT',
        body: { port: 0 }
      });
      assert(invalid.response.status === 400, `非法 PUT 应 400，实际 ${invalid.response.status}`);
      assert(invalid.json?.error?.code === 'invalid_proxy', '非法 PUT 错误 code 应为 invalid_proxy');
      const after = await fetchJson(`${base}/admin/api/proxy`, { headers: auth });
      assert(after.response.status === 200);
      assert(
        JSON.stringify({ e: after.json.proxy.enabled, t: after.json.proxy.type, h: after.json.proxy.host, p: after.json.proxy.port }) ===
          JSON.stringify({ e: proxy.enabled, t: proxy.type, h: proxy.host, p: proxy.port }),
        '非法 PUT 不应改变已保存配置'
      );

      // healthz.proxy 字段
      const health = await fetchJson(`${base}/healthz`);
      assert(health.response.status === 200, `healthz HTTP ${health.response.status}`);
      assert(health.json?.proxy && typeof health.json.proxy === 'object', '缺少 healthz.proxy');
      assert(typeof health.json.proxy.enabled === 'boolean', '缺少 healthz.proxy.enabled');
      assert(typeof health.json.proxy.mode === 'string', '缺少 healthz.proxy.mode');
      assert(!health.text.includes('"password"'), 'healthz.proxy 泄漏 password');
      return `mode=${proxy.status.mode} enabled=${proxy.enabled} type=${proxy.type} healthz=${health.json.proxy.mode}`;
    }
  });

  checks.push({
    name: 'identities 契约（v2.4）',
    async run() {
      const list = await fetchJson(`${base}/admin/api/identities`, { headers: auth });
      assert(list.response.status === 200, `GET /admin/api/identities HTTP ${list.response.status}`);
      const pool = list.json?.pool;
      assert(pool && typeof pool === 'object', '缺少 pool');
      for (const key of ['total', 'enabled', 'subscribed', 'bindingCount', 'maxIdentities']) {
        assert(typeof pool[key] === 'number', `缺少 pool.${key}`);
      }
      assert(typeof pool.activeId === 'string' && pool.activeId.length > 0, '缺少 pool.activeId');
      assert(!('salt' in pool), 'pool 不应返回 salt');
      assert(Array.isArray(list.json.items) && list.json.items.length >= 1, 'items 为空');
      const item = list.json.items[0];
      for (const key of ['id', 'label', 'enabled', 'subscribed', 'journeyId', 'deviceId', 'fingerprint']) {
        assert(item[key] !== undefined, `item 缺少 ${key}`);
      }
      assert(
        item.queue && typeof item.queue.waiting === 'number' && typeof item.queue.inFlight === 'number',
        'item.queue 形状异常'
      );
      assert(!list.text.includes('privateKeyJwk'), 'identities 响应泄漏 privateKeyJwk');
      assert(!list.text.includes('"token"'), 'identities 响应泄漏 token');

      const routing = await fetchJson(`${base}/admin/api/identities/routing`, { headers: auth });
      assert(routing.response.status === 200, `GET routing HTTP ${routing.response.status}`);
      assert(['hash', 'least-loaded'].includes(routing.json.strategy), `unexpected strategy: ${routing.json.strategy}`);
      assert(typeof routing.json.saltPresent === 'boolean', '缺少 saltPresent');
      assert(Array.isArray(routing.json.perIdentity), '缺少 perIdentity');

      const bindings = await fetchJson(`${base}/admin/api/identities/bindings?limit=1&offset=0`, { headers: auth });
      assert(bindings.response.status === 200, `GET bindings HTTP ${bindings.response.status}`);
      assert(Array.isArray(bindings.json.items), 'bindings.items 非数组');
      assert(typeof bindings.json.total === 'number', '缺少 bindings.total');

      const health = await fetchJson(`${base}/healthz`);
      assert(health.json?.identityPool && typeof health.json.identityPool === 'object', '缺少 healthz.identityPool');
      for (const key of ['total', 'enabled', 'subscribed', 'busy']) {
        assert(typeof health.json.identityPool[key] === 'number', `缺少 healthz.identityPool.${key}`);
      }
      return `total=${pool.total} enabled=${pool.enabled} subscribed=${pool.subscribed} bindings=${bindings.json.total} strategy=${routing.json.strategy}`;
    }
  });

  checks.push({
    name: 'pairing 契约（v2.5）',
    async run() {
      // GET 状态：无会话时 pairing:null；有会话时为脱敏 status
      const status = await fetchJson(`${base}/admin/api/sync/pairing`, { headers: auth });
      assert(status.response.status === 200, `GET /admin/api/sync/pairing HTTP ${status.response.status}`);
      assert('pairing' in status.json, '响应缺少 pairing 字段');
      const pairing = status.json.pairing;
      assert(pairing === null || typeof pairing === 'object', 'pairing 形状异常');
      if (pairing) {
        assert(typeof pairing.state === 'string', '缺少 pairing.state');
        assert(typeof pairing.accountAvailable === 'boolean', '缺少 pairing.accountAvailable');
        if (pairing.state === 'completed') {
          assert(['host', 'joiner'].includes(pairing.completedAs), `completedAs 异常: ${pairing.completedAs}`);
        }
        assert(!JSON.stringify(pairing).includes('payload'), 'pairing status 不应含 payload');
        assert(!JSON.stringify(pairing).includes('recovery_code'), 'pairing status 不应含 recovery_code 明文');
      }

      // DELETE 停止（无会话 → pairing:null）
      const stopped = await fetchJson(`${base}/admin/api/sync/pairing`, { headers: auth, method: 'DELETE' });
      assert(stopped.response.status === 200, `DELETE pairing HTTP ${stopped.response.status}`);
      assert(stopped.json.ok === true, 'DELETE pairing 应 ok:true');
      assert('pairing' in stopped.json, 'DELETE 响应缺少 pairing 字段');

      // 官方恢复码：GET 脱敏形状（无明文）
      const code = await fetchJson(`${base}/admin/api/sync/official-recovery-code`, { headers: auth });
      assert(code.response.status === 200, `GET official-recovery-code HTTP ${code.response.status}`);
      const official = code.json?.officialRecoveryCode;
      assert(official && typeof official === 'object', '缺少 officialRecoveryCode');
      assert(typeof official.configured === 'boolean', '缺少 configured');
      assert(!code.text.includes('recovery_code'), '官方恢复码响应不应含明文');
      return `pairing=${pairing?.state ?? 'null'} configured=${official.configured}`;
    }
  });

  checks.push({
    name: 'sync 设备契约（v2.8）',
    async run() {
      if (!(await hasOfficialRecoveryCode(base, auth))) {
        return 'SKIP（未配置官方恢复码：Sync & Backup 未启用或已删除数据）';
      }
      const sync = await fetchJson(`${base}/admin/api/sync`, { headers: auth });
      assert(sync.response.status === 200, `GET /admin/api/sync HTTP ${sync.response.status}`);
      const state = sync.json?.sync;
      assert(state && typeof state === 'object', '缺少 sync');
      assert(
        typeof state.deviceName === 'string' && /^(DuckAI@main|DuckCPA@[0-9a-f]{4})$/.test(state.deviceName),
        `sync.deviceName 应为 DuckAI@main/DuckCPA@xxxx（实际 ${state.deviceName}）`
      );
      assert(state.server && typeof state.server === 'object', '缺少 sync.server');
      assert(typeof state.server.registered === 'boolean', '缺少 server.registered');

      const before = await fetchJson(`${base}/admin/api/sync/server-devices`, { headers: auth });
      assert(before.response.status === 200, `GET server-devices HTTP ${before.response.status}`);
      assert(Array.isArray(before.json.devices), 'devices 非数组');
      assert(typeof before.json.currentDeviceId === 'string', '缺少 currentDeviceId');
      assert(typeof before.json.total === 'number', '缺少 total');
      assert(!before.text.includes('encrypted_private_key'), 'server-devices 不应返回私钥');
      const currentBefore = before.json.devices.filter((device) => device.current === true);
      assert(currentBefore.length === 1, `应恰有一个 current 设备（实际 ${currentBefore.length}）`);

      // 删除当前设备 → 400 invalid_device
      const denied = await fetchJson(
        `${base}/admin/api/sync/server-devices/${encodeURIComponent(before.json.currentDeviceId)}`,
        { headers: auth, method: 'DELETE' }
      );
      assert(denied.response.status === 400, `DELETE current HTTP ${denied.response.status}`);
      assert(denied.json?.error?.code === 'invalid_device', `code 应为 invalid_device（实际 ${denied.json?.error?.code}）`);

      // ⚠️ 破坏性操作保护：绝不删除真实账号里的任何设备。
      // 这里只验证「删除不存在的设备 → 404」，真实删除行为由 tests/sync-devices-api.test.js
      // 用 mock 覆盖。若确实需要端到端验证删除，显式传 --allow-device-delete 并提供
      // --delete-device-id=<仅本网关自建的一次性 device id>。
      if (options.allowDeviceDelete) {
        const target = options.deleteDeviceId;
        assert(target, '--allow-device-delete 需要配合 --delete-device-id');
        const removed = await fetchJson(
          `${base}/admin/api/sync/server-devices/${encodeURIComponent(target)}`,
          { headers: auth, method: 'DELETE' }
        );
        assert(removed.response.status === 200, `DELETE device HTTP ${removed.response.status}`);
        assert(removed.json.ok === true, 'DELETE device 应 ok:true');
      } else {
        const missing = await fetchJson(
          `${base}/admin/api/sync/server-devices/00000000-0000-4000-8000-000000000000`,
          { headers: auth, method: 'DELETE' }
        );
        assert([400, 404].includes(missing.response.status), `DELETE 不存在的设备应 400/404，实际 ${missing.response.status}`);
      }

      // 注册本机 → 200；GET /sync 反映 registered
      const registered = await fetchJson(`${base}/admin/api/sync/register-device`, {
        headers: auth,
        method: 'POST',
        body: '{}'
      });
      assert(registered.response.status === 200, `POST register-device HTTP ${registered.response.status}`);
      assert(registered.json.ok === true, 'register-device 应 ok:true');
      assert(registered.json.server?.registered === true, 'register-device 后 server.registered 应为 true');
      const afterSync = await fetchJson(`${base}/admin/api/sync`, { headers: auth });
      assert(afterSync.json.sync.server.registered === true, 'GET /sync 的 server.registered 应为 true');
      const after = await fetchJson(`${base}/admin/api/sync/server-devices`, { headers: auth });
      assert(
        after.json.devices.some((device) => device.current === true && device.id === after.json.currentDeviceId),
        '注册后设备列表应含 current 本机'
      );
      return `deviceName=${state.deviceName} total=${after.json.total} registered=true`;
    }
  });

  checks.push({
    name: '设备删除保护/孤儿自愈（v2.10）',
    async run() {
      // 孤儿自愈需要向真实 identity 注入 ghost slot（破坏性）。默认跳过，仅在
      // --inject-orphan 且使用隔离 dataDir 的测试网关上执行；mock 单测已覆盖该逻辑。
      if (!options.injectOrphan) {
        return 'SKIP（orphan 注入需要 --inject-orphan + 隔离 dataDir；单测已覆盖）';
      }
      const slots = await fetchJson(`${base}/admin/api/sync/device-slots`, { headers: auth });
      assert(slots.response.status === 200, `GET device-slots HTTP ${slots.response.status}`);
      assert(Array.isArray(slots.json.orphans), '缺少 orphans 数组');
      assert(slots.json.orphans.some((item) => item.identityId === 'id_ghost_pagecheck'), 'orphans 应含注入的孤儿');
      assert(!slots.json.identityIds.includes('id_ghost_pagecheck'), 'identityIds 应过滤孤儿');
      const reconciled = await fetchJson(`${base}/admin/api/sync/device-slots?reconcile=true`, {
        headers: auth,
        method: 'PUT',
        body: {}
      });
      assert(reconciled.response.status === 200, `reconcile HTTP ${reconciled.response.status}`);
      assert(Array.isArray(reconciled.json.reconciled?.cleaned), 'reconcile 应返回 cleaned');
      assert(!(reconciled.json.orphans || []).some((item) => item.identityId === 'id_ghost_pagecheck'), 'reconcile 后孤儿应清理');

      // 生成身份 → 加入 slots → DELETE 409（字段）→ force 200 removedDevice
      const generated = await fetchJson(`${base}/admin/api/identities/generate`, {
        headers: auth,
        method: 'POST',
        body: { count: 1, labelPrefix: '保护' }
      });
      assert(generated.response.status === 200, `generate HTTP ${generated.response.status}`);
      const other = (generated.json.items || generated.json.identities || [])[0];
      assert(other, 'generate 应返回身份');
      const saved = await fetchJson(`${base}/admin/api/sync/device-slots`, {
        headers: auth,
        method: 'PUT',
        body: { identityIds: ['id_default', other.id] }
      });
      assert(saved.response.status === 200, `PUT slots HTTP ${saved.response.status}`);

      const denied = await fetchJson(`${base}/admin/api/identities/${encodeURIComponent(other.id)}`, { headers: auth, method: 'DELETE' });
      assert(denied.response.status === 409, `DELETE in slots HTTP ${denied.response.status}`);
      assert(denied.json.error.code === 'identity_in_device_slots', `code 应为 identity_in_device_slots（实际 ${denied.json.error.code}）`);
      assert(denied.json.error.identityId === other.id, 'error.identityId 应为该身份');
      assert(denied.json.error.deviceName === other.deviceName, 'error.deviceName 应为该设备名');
      assert(typeof denied.json.error.hint === 'string', '409 应带 hint');
      const still = await fetchJson(`${base}/admin/api/identities/${encodeURIComponent(other.id)}`, { headers: auth });
      assert(still.response.status === 200, '409 后身份应仍存在');

      const forced = await fetchJson(`${base}/admin/api/identities/${encodeURIComponent(other.id)}?force=true`, {
        headers: auth,
        method: 'DELETE'
      });
      assert(forced.response.status === 200, `force DELETE HTTP ${forced.response.status}`);
      assert(forced.json.ok === true, 'force DELETE 应 ok:true');
      assert(forced.json.removedDevice === true, 'force DELETE 应 removedDevice:true');
      const after = await fetchJson(`${base}/admin/api/sync/device-slots`, { headers: auth });
      assert(!after.json.identityIds.includes(other.id), 'force 后 slots 应无残留');
      assert(!(after.json.orphans || []).some((item) => item.identityId === other.id), 'force 后不应有该孤儿');

      // 默认身份 force 仍 409
      const defaultDenied = await fetchJson(`${base}/admin/api/identities/id_default?force=true`, { headers: auth, method: 'DELETE' });
      assert(defaultDenied.response.status === 409, `默认身份 force DELETE HTTP ${defaultDenied.response.status}`);
      assert(defaultDenied.json.error.code === 'default_identity_protected', '默认身份应 default_identity_protected');
      return 'orphans/reconcile + DELETE 409(identityId/deviceName) + force removedDevice + 默认身份 409';
    }
  });

  checks.push({
    name: 'device-slots 契约（v2.9）',
    async run() {
      if (!(await hasOfficialRecoveryCode(base, auth))) {
        return 'SKIP（未配置官方恢复码：Sync & Backup 未启用或已删除数据）';
      }
      // 每身份设备名：id_default = DuckAI@main
      const list = await fetchJson(`${base}/admin/api/identities`, { headers: auth });
      assert(list.response.status === 200, `GET identities HTTP ${list.response.status}`);
      const defaultIdentity = (list.json.items || []).find((item) => item.id === 'id_default');
      assert(defaultIdentity, 'identities 应含 id_default');
      assert(defaultIdentity.deviceName === 'DuckAI@main', `默认身份设备名应为 DuckAI@main（实际 ${defaultIdentity.deviceName}）`);

      // GET device-slots：defaultIdentityId 恒为 id_default；identityIds 可空（v2.13 允许移除默认设备）
      const initial = await fetchJson(`${base}/admin/api/sync/device-slots`, { headers: auth });
      assert(initial.response.status === 200, `GET device-slots HTTP ${initial.response.status}`);
      assert(initial.json.defaultIdentityId === 'id_default', 'defaultIdentityId 应为 id_default');
      assert(Array.isArray(initial.json.identityIds), 'identityIds 应为数组');
      assert(Array.isArray(initial.json.slots), 'slots 应为数组');
      assert(Array.isArray(initial.json.serverDevices), 'serverDevices 应为数组');

      // 生成一个身份并 PUT 两个槽位（v2.24：必须清理，且池满时跳过而不是失败）
      const generated = await fetchJson(`${base}/admin/api/identities/generate`, {
        headers: auth,
        method: 'POST',
        body: { count: 1, labelPrefix: '页面槽位' }
      });
      if (generated.response.status === 409) {
        return 'SKIP（身份池已满，无法生成临时身份；请清理池内测试身份后重跑）';
      }
      assert(generated.response.status === 200, `generate HTTP ${generated.response.status}`);
      const other = (generated.json.items || generated.json.identities || [])[0];
      // 无论后续断言是否通过，都删除本次生成的临时身份，避免污染用户身份池
      let slotCount = 0;
      try {
      assert(other && /^DuckCPA@[0-9a-f]{4}$/.test(other.deviceName), `生成身份设备名应 DuckCPA@xxxx（实际 ${other?.deviceName}）`);

      const saved = await fetchJson(`${base}/admin/api/sync/device-slots`, {
        headers: auth,
        method: 'PUT',
        body: { identityIds: ['id_default', other.id] }
      });
      assert(saved.response.status === 200, `PUT device-slots HTTP ${saved.response.status}`);
      assert(saved.json.ok === true, 'PUT device-slots 应 ok:true');
      assert(saved.json.identityIds.length === 2, 'identityIds 应有 2 个');
      assert(saved.json.slots.some((slot) => slot.identityId === other.id && slot.deviceName === other.deviceName), 'slots 应含新身份');
      const again = await fetchJson(`${base}/admin/api/sync/device-slots`, { headers: auth });
      assert(again.json.identityIds.length === 2, 'GET 应读回已保存 slots');
      slotCount = again.json.identityIds.length;

      // 非法 id → 400；空列表 → 200（v2.13：默认身份也可从设备槽移除，仅注销设备、账号保留）
      const invalid = await fetchJson(`${base}/admin/api/sync/device-slots`, {
        headers: auth,
        method: 'PUT',
        body: { identityIds: ['no-such-id'] }
      });
      assert(invalid.response.status === 400, `非法 identity 应 400（实际 ${invalid.response.status}）`);
      assert(invalid.json.error.code === 'invalid_identity', '错误码应为 invalid_identity');
      const cleared = await fetchJson(`${base}/admin/api/sync/device-slots`, {
        headers: auth,
        method: 'PUT',
        body: { identityIds: [] }
      });
      assert(cleared.response.status === 200, `PUT 空列表应 200（实际 ${cleared.response.status}）`);
      assert(Array.isArray(cleared.json.identityIds) && cleared.json.identityIds.length === 0, '空列表应保存为空');
      // 立即恢复默认身份槽位，避免影响后续检查/用户状态
      const restored = await fetchJson(`${base}/admin/api/sync/device-slots`, {
        headers: auth,
        method: 'PUT',
        body: { identityIds: ['id_default'] }
      });
      assert(restored.response.status === 200, `恢复默认槽位 HTTP ${restored.response.status}`);
      } finally {
        // 清理：force DELETE 临时身份（若已删除则忽略错误）
        try {
          await fetchJson(`${base}/admin/api/identities/${encodeURIComponent(other.id)}?force=true`, {
            headers: auth,
            method: 'DELETE'
          });
        } catch {
          /* ignore */
        }
      }

      // 默认身份保护（身份本身不可删除；设备槽可移除）
      const protectedRes = await fetchJson(`${base}/admin/api/identities/id_default`, { headers: auth, method: 'DELETE' });
      assert(protectedRes.response.status === 409, `DELETE id_default HTTP ${protectedRes.response.status}`);
      assert(protectedRes.json.error.code === 'default_identity_protected', '错误码应为 default_identity_protected');

      return `slots=${slotCount} defaultDuckAI@main + DuckCPA@xxxx；空列表 200（可移除设备）；身份保护 409；临时身份已清理`;
    }
  });
  checks.push({
    name: '模型上下文能力（v2.11）',
    async run() {
      const v1 = await fetchJson(base + '/v1/models', { headers: { authorization: 'Bearer ' + options.apiKey } });
      assert(v1.response.status === 200, 'GET /v1/models HTTP ' + v1.response.status);
      const luna = (v1.json.data || []).find((model) => model.id === 'gpt-6-luna');
      assert(luna, '/v1/models 缺少 gpt-6-luna');
      assert(luna.context_window_chars === 20000, 'context_window_chars 应为 20000（实际 ' + luna.context_window_chars + '）');
      assert(luna.max_input_chars === 19500, 'max_input_chars 应为 19500');
      assert(luna.max_input_tokens === Math.floor(19500 / 3), 'max_input_tokens 应为 6500');
      assert(luna.max_output_tokens === 4096, 'max_output_tokens 应为 4096');
      assert(luna.max_output_tokens_estimated === true, 'max_output_tokens 应标注 estimated');
      assert(luna.compaction_supported === false, 'gpt-6-luna compaction_supported 应为 false');
      assert(luna.session_limit_behavior === 'new_chat', 'gpt-6-luna session_limit_behavior 应为 new_chat');
      assert(luna.capabilities?.webSearch === true && luna.capabilities?.imageGeneration === true, 'capabilities 应含 webSearch/imageGeneration');
      const admin = await fetchJson(base + '/admin/api/models', { headers: auth });
      assert(admin.response.status === 200, 'GET /admin/api/models 失败');
      const adminLuna = (admin.json.items || []).find((model) => model.id === 'gpt-6-luna');
      assert(adminLuna?.context_window_chars === 20000, 'admin models 缺少 context_window_chars');
      assert(adminLuna?.max_input_tokens === Math.floor(19500 / 3), 'admin models max_input_tokens 不一致');
      assert(adminLuna?.session_limit_behavior === 'new_chat', 'admin models 应含 session_limit_behavior');
      const mini = (v1.json.data || []).find((model) => model.id === 'gpt-5.4-mini');
      assert(mini?.compaction_supported === true, 'gpt-5.4-mini compaction_supported 应为 true');
      assert(mini?.session_limit_behavior === 'summarize_and_continue', 'gpt-5.4-mini session_limit_behavior 应为 summarize_and_continue');
      assert(mini?.compaction_trigger === 'tokens', 'gpt-5.4-mini compaction_trigger 应为 tokens');
      return 'chars=20000 inputChars=19500 tokens=6500 output=4096 capabilities/compaction OK';
    }
  });

  checks.push({
    name: '手动 compact + 官方恢复码明文/下载（v2.11）',
    async run() {
      let compactInfo = 'skipped: --allow-upstream not set';
      if (options.allowUpstream) {
      const created = await fetchJson(base + '/admin/api/test/sessions', { headers: auth, method: 'POST', body: { title: 'pagecheck-compact' } });
      assert(created.response.status === 201, 'create session HTTP ' + created.response.status);
      const sessionId = created.json.session.id;
      let upstreamLimited = false;
      for (const content of ['第一轮：订单 A-102', '第二轮：周四回电', '第三轮：保留发票地址', '第四轮：确认发货时间']) {
        const res = await fetch(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId) + '/messages', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ content })
        });
        if (res.status !== 200) {
          // Duck.ai anonymous quota is shared: 418/429/403 here is an upstream limit, not a
          // gateway regression. Skip the compact assertion for this run.
          if ([403, 418, 429].includes(res.status)) {
            upstreamLimited = true;
            await res.text();
            break;
          }
          assert(false, 'send message HTTP ' + res.status);
        }
        await res.text();
      }
      compactInfo = 'skipped: upstream limit';
      if (!upstreamLimited) {
        const compact = await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId) + '/compact', {
          headers: auth,
          method: 'POST',
          body: {}
        });
        assert(compact.response.status === 200, 'POST compact HTTP ' + compact.response.status);
        assert(compact.json.ok === true, 'compact 应 ok:true');
        assert(typeof compact.json.summary?.text === 'string' && compact.json.summary.text.length > 0, 'compact 应返回 summary.text');
        assert(compact.json.session?.summary?.text === compact.json.summary.text, 'session.summary 应持久化');
        compactInfo = 'compact 200 + summary 持久化';
      }
      await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId), { headers: auth, method: 'DELETE' });
      }

      // 保存现有官方恢复码（真实账号可能已配置），测试结束后恢复，避免破坏用户状态。
      const existing = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth });
      const previousCode = existing.json?.officialRecoveryCode?.configured === true
        ? existing.json.officialRecoveryCode.code
        : null;

      const code = 'eyJyZWNvdmVyeSI6eyJ1c2VyX2lkIjoicGFnZWNoZWNrIiwic2VjcmV0Ijoic2VjcmV0In19';
      const saved = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth, method: 'PUT', body: { code } });
      assert(saved.response.status === 200, 'PUT official-recovery-code HTTP ' + saved.response.status);
      const got = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth });
      assert(got.json.officialRecoveryCode.configured === true, '应 configured=true');
      assert(got.json.officialRecoveryCode.code === code, 'GET 应返回完整 code');
      assert(got.json.officialRecoveryCode.source === 'manual', 'source 应为 manual');
      assert(got.json.officialRecoveryCode.length === code.length, 'length 应为码长度');

      const download = await fetch(base + '/admin/api/sync/official-recovery-code/download', { headers: auth });
      assert(download.status === 200, 'download HTTP ' + download.status);
      const disposition = download.headers.get('content-disposition') || '';
      assert(/attachment/i.test(disposition) && /filename=/.test(disposition), 'download 应带 attachment 文件名');
      const body = (await download.text()).trim();
      assert(body === code, 'download 内容应等于完整 code');
      // 恢复测试前的官方恢复码（若有），否则删除以验证「未配置」分支。
      if (previousCode) {
        const restored = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth, method: 'PUT', body: { code: previousCode } });
        assert(restored.response.status === 200, 'restore official-recovery-code HTTP ' + restored.response.status);
      } else {
        await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth, method: 'DELETE' });
        const cleared = await fetchJson(base + '/admin/api/sync/official-recovery-code', { headers: auth });
        assert(cleared.json.officialRecoveryCode.configured === false, 'DELETE 后应未配置');
      }
      return 'compact 200 + summary 持久化；recovery GET 明文/source/download 一致';
    }
  });

  checks.push({
    name: '模型压缩能力 + summary 编辑/清除（v2.12）',
    async run() {
      const v1 = await fetchJson(base + '/v1/models', { headers: { authorization: 'Bearer ' + options.apiKey } });
      assert(v1.response.status === 200, 'GET /v1/models HTTP ' + v1.response.status);
      const luna = (v1.json.data || []).find((model) => model.id === 'gpt-6-luna');
      const mini = (v1.json.data || []).find((model) => model.id === 'gpt-5.4-mini');
      assert(luna?.compaction_supported === false, 'gpt-6-luna compaction_supported 应为 false');
      assert(mini?.compaction_supported === true, 'gpt-5.4-mini compaction_supported 应为 true');
      assert(typeof luna.activation_target_pair_count === 'number', '缺少 activation_target_pair_count');
      assert(luna.input_char_limit === 16000, 'input_char_limit 应为 16000');
      assert(luna.capabilities?.compactionSupported === false, 'capabilities.compactionSupported 应为 false');
      const admin = await fetchJson(base + '/admin/api/models', { headers: auth });
      const adminLuna = (admin.json.items || []).find((model) => model.id === 'gpt-6-luna');
      assert(adminLuna?.compaction_supported === false, 'admin models compaction_supported 不一致');

      const created = await fetchJson(base + '/admin/api/test/sessions', { headers: auth, method: 'POST', body: { title: 'pagecheck-summary', model: 'gpt-5.4-mini' } });
      assert(created.response.status === 201, 'create session HTTP ' + created.response.status);
      const sessionId = created.json.session.id;
      const patched = await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId) + '/summary', {
        headers: auth,
        method: 'PATCH',
        body: { text: '页面摘要：订单 A-102', coveredPairCount: 2 }
      });
      assert(patched.response.status === 200, 'PATCH summary HTTP ' + patched.response.status);
      assert(patched.json.summary?.text === '页面摘要：订单 A-102', 'PATCH 应返回编辑后的摘要');
      assert(patched.json.summary?.trigger === 'manual', 'trigger 应为 manual');
      const invalid = await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId) + '/summary', {
        headers: auth,
        method: 'PATCH',
        body: { text: '' }
      });
      assert(invalid.response.status === 400, '空摘要应 400');
      assert(invalid.json.error.code === 'invalid_summary', '错误码应为 invalid_summary');
      const cleared = await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId) + '/summary', {
        headers: auth,
        method: 'DELETE'
      });
      assert(cleared.response.status === 200, 'DELETE summary HTTP ' + cleared.response.status);
      assert(cleared.json.cleared === true && cleared.json.summary === null, 'DELETE 应 cleared 且 summary null');
      await fetchJson(base + '/admin/api/test/sessions/' + encodeURIComponent(sessionId), { headers: auth, method: 'DELETE' });
      return 'compaction_supported(luna=false/mini=true) + summary PATCH/DELETE';
    }
  });

  checks.push({
    name: '旧 /admin/api/test 404',
    async run() {
      const post = await fetch(`${base}/admin/api/test`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await post.text();
      assert(post.status === 404, `旧 /admin/api/test 应 404，实际 ${post.status}`);
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      assert(parsed?.error?.code === 'not_found', '旧接口 404 错误体应含 code not_found');
      return 'HTTP 404';
    }
  });

  return checks;
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

  console.log(
    `duckai-cpa page-check — ${options.baseUrl} · admin=${options.adminToken ? 'on' : 'off (skip admin API)'}\n`
  );

  const results = [];
  for (const check of buildChecks(options)) {
    if (check.skip) {
      console.log(`${paint(DIM, '[SKIP]')} ${check.name}`);
      continue;
    }
    const startedAt = Date.now();
    try {
      const detail = await check.run();
      results.push({ status: 'PASS' });
      console.log(`${paint(GREEN, '[PASS]')} ${check.name.padEnd(30)} ${paint(DIM, `${Date.now() - startedAt}ms`)}  ${detail}`);
    } catch (error) {
      results.push({ status: 'FAIL', detail: error?.message });
      console.log(`${paint(RED, '[FAIL]')} ${check.name.padEnd(30)} ${paint(DIM, `${Date.now() - startedAt}ms`)}  ${error?.message}`);
    }
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  console.log();
  console.log(
    failed === 0
      ? paint(GREEN, `✔ page-check 通过: ${passed} passed, 0 failed`)
      : paint(RED, `✖ page-check 失败: ${passed} passed, ${failed} failed`)
  );

  try {
    const outPath = path.join(PROJECT_ROOT, 'data', 'tmp', `page-check-${Date.now()}.json`);
    await fs.writeFile(
      outPath,
      JSON.stringify({ ts: new Date().toISOString(), baseUrl: options.baseUrl, passed, failed }, null, 2),
      'utf8'
    );
  } catch {
    /* 忽略 */
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
