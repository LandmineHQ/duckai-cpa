#!/usr/bin/env node
/**
 * Windows exe 端到端验证脚本（scripts/verify-exe.mjs）
 *
 * 目标：对 bun 编译产物 `dist/windows-x64/duckai-cpa.exe`（单文件，内嵌 web/ +
 * config/config.example.json + package.json）做一次可复用的黑盒验收；也可用
 * `--node src/index.js` 走完全相同的断言，先自测脚本本身（dev 服务器）。
 *
 * 核心行为：
 *   1. 使用独立端口（默认 18000-18999 随机空闲端口；不碰 8787）和独立数据目录
 *      （默认 <repo>/data/tmp/exe-verify-<时间戳>-<随机>）。
 *   2. exe 模式：把 exe 复制到临时运行目录再启动（验证单文件可脱离仓库运行）；
 *      node 模式：`node <entry>`，cwd=仓库根，并显式注入 DUCKAI_CPA_DATA_DIR。
 *   3. 子进程 env：DUCKAI_CPA_PORT / DUCKAI_CPA_HOST=127.0.0.1 /
 *      DUCKAI_CPA_DATA_DIR=<绝对路径>；继承环境中的 DUCKAI_CPA_* 与 HTTP_ADAPTER
 *      会被剔除，保证结果确定（不受宿主机环境变量影响）。
 *   4. stdout/stderr 落盘到 <运行目录>/logs/server-{1,2}.{stdout,stderr}.log；
 *      失败时打印最后 30 行（token 已脱敏）。
 *   5. 首次启动从 stdout 解析 admin_<hex> / sk-... 形式的 adminToken 与 API Key
 *      （解析不到则回退 <dataDir>/config.json 的 auth.adminToken / auth.apiKeys）；
 *      报告里 token 只显示前 8 位。
 *   6. 轮询 http://127.0.0.1:<port>/healthz 直到 2xx 或超时。注意：src/index.js 的
 *      /healthz 固定返回 200（ok:true），offline / 上游初始化失败时只是
 *      upstream.ok=false，因此可直接用于就绪探测；/admin/api/overview 只用于断言 d。
 *   7. 断言 a)~g)（外加 h) 附加项：重启后默认 API Key 仍可用），输出 PASS/FAIL
 *      表与退出码（0=PASS，1=FAIL，2=用法/环境错误）。
 *   8. 默认结束子进程并清理 <repo>/data/tmp 下的本次临时运行目录；--keep 保留
 *      进程与目录。显式 --data-dir 指向 data/tmp 之外时不会被删除。
 *
 * 零外部依赖：只用 node:http / node:fs / node:child_process / node:path /
 * node:crypto / node:url 等 Node 内置模块。
 *
 * 用法：
 *   node scripts/verify-exe.mjs                       # 验证默认 exe
 *   node scripts/verify-exe.mjs --exe dist/windows-x64/duckai-cpa.exe --port 18787
 *   node scripts/verify-exe.mjs --node src/index.js --data-dir data/tmp/exe-verify-selfcheck
 *   node scripts/verify-exe.mjs --keep                # 保留进程 + 数据/日志目录
 *
 * 详细文档：docs/WINDOWS-EXE-VERIFICATION.md
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DATA_TMP_DIR = path.join(PROJECT_ROOT, 'data', 'tmp');
const DEFAULT_EXE = path.join(PROJECT_ROOT, 'dist', 'windows-x64', 'duckai-cpa.exe');
const DEFAULT_NODE_ENTRY = 'src/index.js';
const IS_WINDOWS = process.platform === 'win32';
const MAX_HTTP_BODY = 16 * 1024 * 1024;

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

/** 断言清单（顺序即执行/展示顺序）。 */
const EXPECTED_CHECKS = [
  ['a', 'GET /healthz 返回 200 且 JSON ok=true'],
  ['b', 'GET /admin/ 200 且 HTML 引用 /admin/assets/'],
  ['c', 'HTML 引用的静态资源全部 200 且 content-type 合理'],
  ['d', 'GET /admin/api/overview?token=… 200 且含 service.version'],
  ['e', 'GET /v1/models（Bearer API Key）200 且 data 非空'],
  ['f', '数据目录存在 config.json 与 duckai.db'],
  ['g', '重启后 adminToken 一致且 /admin/ 仍 200'],
  ['h', '附加：重启后默认 API Key 仍可用']
];

/* ------------------------------------------------------------------ */
/* 参数解析 / 帮助                                                      */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    mode: 'exe',
    exe: DEFAULT_EXE,
    nodeEntry: null,
    port: null,
    dataDir: null,
    timeoutMs: 90000,
    keep: false,
    help: false
  };
  const splitEq = (arg) => {
    const index = arg.indexOf('=');
    return index === -1 ? [arg, undefined] : [arg.slice(0, index), arg.slice(index + 1)];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--keep') {
      options.keep = true;
      continue;
    }
    const [name, inline] = splitEq(arg);
    const takeValue = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${name} 缺少参数值`);
      return argv[i];
    };
    switch (name) {
      case '--exe': {
        if (options.mode === 'node') throw new Error('--exe 与 --node 不能同时使用');
        options.exe = takeValue();
        options.mode = 'exe';
        break;
      }
      case '--node': {
        if (options.mode === 'exe' && options.exe !== DEFAULT_EXE) {
          throw new Error('--exe 与 --node 不能同时使用');
        }
        options.mode = 'node';
        if (inline !== undefined) {
          options.nodeEntry = inline;
        } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
          i += 1;
          options.nodeEntry = argv[i];
        } else {
          options.nodeEntry = DEFAULT_NODE_ENTRY;
        }
        break;
      }
      case '--port': {
        const raw = takeValue();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`--port 必须是 1-65535 的整数，收到 "${raw}"`);
        }
        options.port = port;
        break;
      }
      case '--data-dir': {
        options.dataDir = takeValue();
        if (!options.dataDir.trim()) throw new Error('--data-dir 不能为空');
        break;
      }
      case '--timeout': {
        const raw = takeValue();
        const timeoutMs = Number(raw);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
          throw new Error(`--timeout 必须是 1000-600000 的毫秒数，收到 "${raw}"`);
        }
        options.timeoutMs = Math.trunc(timeoutMs);
        break;
      }
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  if (options.mode === 'node' && !options.nodeEntry) options.nodeEntry = DEFAULT_NODE_ENTRY;
  return options;
}

function printHelp() {
  console.log(`duckai-cpa Windows exe 端到端验证（verify-exe.mjs）

用法:
  node scripts/verify-exe.mjs [选项]

选项:
  --exe <path>       待验证 exe（默认 dist/windows-x64/duckai-cpa.exe，相对路径按仓库根解析）
  --node [entry]     改为验证 node 入口（默认 src/index.js；同一套断言，用于脚本自测）
  --port <port>      监听端口（默认 18000-18999 随机空闲端口；显式指定时被占用会直接报错）
  --data-dir <dir>   数据目录（默认 <repo>/data/tmp/exe-verify-<时间戳>-<随机>；
                     相对路径按仓库根解析；node 模式会显式注入 DUCKAI_CPA_DATA_DIR）
  --timeout <ms>     启动/重启就绪超时（默认 90000，范围 1000-600000）
  --keep             结束后保留子进程、数据目录与日志（默认终止进程并清理 data/tmp 下临时目录）
  -h, --help         显示帮助

示例:
  node scripts/verify-exe.mjs
  node scripts/verify-exe.mjs --exe dist/windows-x64/duckai-cpa.exe --port 18787
  node scripts/verify-exe.mjs --node src/index.js --data-dir data/tmp/exe-verify-selfcheck
  node scripts/verify-exe.mjs --keep

退出码: 0 = 全部 PASS；1 = 存在 FAIL；2 = 用法/环境错误（参数、exe 缺失、端口占用等）。
`);
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function truncate(text, maxLength = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

function formatDuration(ms) {
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

/** 终端显示宽度（CJK 字符按 2 列计），用于对齐 PASS/FAIL 表。 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) || 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function statFile(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** child 路径是否位于 parent 目录内（含相等）。 */
function isInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** token 脱敏：只展示前 8 位。 */
function maskToken(token) {
  if (typeof token !== 'string' || !token) return '(未获取)';
  return `${token.slice(0, 8)}…（长度 ${token.length}）`;
}

/** 把日志中的完整 admin token / API Key 替换成脱敏形式（失败诊断输出用）。 */
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\badmin_[0-9a-fA-F]{16,}\b/g, (match) => `${match.slice(0, 8)}…(redacted)`)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, (match) => `${match.slice(0, 8)}…(redacted)`);
}

function readConfigJson(dataDir) {
  return parseJson(readTextFile(path.join(dataDir, 'config.json')));
}

function extractTokens(text) {
  const adminTokens = new Set();
  const apiKeys = new Set();
  for (const match of String(text ?? '').matchAll(/\badmin_[0-9a-fA-F]{16,}\b/g)) {
    adminTokens.add(match[0]);
  }
  // API Key 实际格式：sk-duck-<base64url>；token 可能以 '-'/'_' 结尾，因此不用尾部 \b。
  for (const match of String(text ?? '').matchAll(/sk-[A-Za-z0-9_-]{20,}/g)) {
    apiKeys.add(match[0]);
  }
  return { adminTokens: [...adminTokens], apiKeys: [...apiKeys] };
}

function readChildLogs(child) {
  const paths = child?.__logPaths || {};
  return {
    stdout: readTextFile(paths.out),
    stderr: readTextFile(paths.err)
  };
}

function readChildLogsText(child) {
  const logs = readChildLogs(child);
  return `${logs.stdout}\n${logs.stderr}`;
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端（node:http，零依赖）                                     */
/* ------------------------------------------------------------------ */

function httpRequest(urlString, { method = 'GET', headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers }
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total <= MAX_HTTP_BODY) chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            bytes: total,
            truncated: total > MAX_HTTP_BODY
          });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP 请求超时（${timeoutMs}ms）：${urlString}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 用 http server 绑定测试端口是否空闲（不依赖 node:net；带超时，避免极端情况下永不返回）。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    let settled = false;
    let timer = null;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        // 未开始监听时 close 会抛 ERR_SERVER_NOT_RUNNING，忽略。
      }
      resolve(free);
    };
    timer = setTimeout(() => finish(false), 3000);
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function resolvePort(explicitPort) {
  if (explicitPort !== null) {
    if (await isPortFree(explicitPort)) return explicitPort;
    throw new Error(
      `--port ${explicitPort} 已被占用，请换一个端口（不指定时脚本会在 18000-18999 内随机选空闲端口）`
    );
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = crypto.randomInt(18000, 19000);
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error('未能在 18000-18999 范围内找到空闲端口，请用 --port 显式指定');
}

async function waitPortReleased(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true;
    await delay(250);
  }
  throw new Error(`端口 ${port} 在 ${formatDuration(timeoutMs)} 内未释放（旧进程可能未完全退出）`);
}

/* ------------------------------------------------------------------ */
/* 子进程管理                                                          */
/* ------------------------------------------------------------------ */

function buildChildEnv({ port, dataDir }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    // 剔除宿主机可能存在的覆盖项，保证验证结果只由本脚本控制。
    if (upper.startsWith('DUCKAI_CPA_')) continue;
    if (upper === 'HTTP_ADAPTER') continue;
    env[key] = value;
  }
  env.DUCKAI_CPA_PORT = String(port);
  env.DUCKAI_CPA_HOST = '127.0.0.1';
  env.DUCKAI_CPA_DATA_DIR = dataDir;
  return env;
}

/**
 * 启动子进程。stdout/stderr 直接重定向到文件 fd（而非管道），这样 --keep 时
 * 父进程退出后子进程仍可继续写日志；读取日志统一走文件。
 */
function spawnServer({ round, state, options, env }) {
  const outPath = path.join(state.logsDir, `server-${round}.stdout.log`);
  const errPath = path.join(state.logsDir, `server-${round}.stderr.log`);
  fs.writeFileSync(outPath, '');
  fs.writeFileSync(errPath, '');
  const outFd = fs.openSync(outPath, 'a');
  const errFd = fs.openSync(errPath, 'a');
  let child;
  try {
    child = spawn(state.command, state.args, {
      cwd: state.cwd,
      env,
      windowsHide: true,
      detached: options.keep === true,
      stdio: ['ignore', outFd, errFd]
    });
  } finally {
    // 句柄已复制给子进程，父进程这侧可以关闭。
    try {
      fs.closeSync(outFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(errFd);
    } catch {
      // ignore
    }
  }
  child.__spawnError = null;
  child.__round = round;
  child.__logPaths = { out: outPath, err: errPath };
  child.on('error', (error) => {
    child.__spawnError = error;
  });
  if (options.keep) child.unref();
  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let timer = null;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** 结束子进程：优先 child.kill()，Windows 上未退出则 taskkill /T /F。 */
async function stopChild(child, { timeoutMs = 5000 } = {}) {
  if (!child) return { stopped: true, already: true };
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, already: true };
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  let exited = await waitForExit(child, timeoutMs);
  if (!exited && IS_WINDOWS && child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000
      });
    } catch {
      // ignore
    }
    exited = await waitForExit(child, timeoutMs);
  }
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    exited = await waitForExit(child, 3000);
  }
  return { stopped: exited, already: false };
}

/**
 * 轮询 /healthz 直到 2xx。注意：网关的 /healthz 在离线降级时依然返回 200，
 * 因此这里只看 HTTP 状态码；上游健康度由 JSON upstream.ok 反映（不作为失败条件）。
 */
async function waitForReady(child, { port, timeoutMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.__spawnError) {
      throw new Error(`子进程启动失败：${child.__spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await delay(150);
      throw new Error(`子进程提前退出（exitCode=${child.exitCode}, signal=${child.signalCode}）`);
    }
    try {
      const response = await httpRequest(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 3000 });
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, ms: Date.now() - startedAt };
      }
    } catch {
      // 端口尚未监听：继续等待。
    }
    await delay(500);
  }
  throw new Error(`启动超时：${timeoutMs}ms 内 /healthz 未返回 2xx`);
}

/**
 * 首次启动的 token 解析：
 *   1) 优先从 stdout/stderr 解析（admin_<hex> / sk-...）；
 *   2) 解析失败回退 <dataDir>/config.json 的 auth.adminToken / auth.apiKeys。
 * 返回 { token, apiKey, tokenSource, apiKeySource }，token 不落盘、不完整打印。
 */
async function resolveFirstRunTokens(state, options) {
  // 非首次启动（数据目录里已有 config.json）不会重新打印 token，只需等待 3s
  // 确认 stdout 没有；首次启动正常会在就绪后几毫秒内打印，最多等 15s。
  const waitMs = state.preExistingConfig
    ? 3000
    : Math.min(15000, Math.max(5000, Math.floor(options.timeoutMs / 4)));
  const deadline = Date.now() + waitMs;
  let parsed = { adminTokens: [], apiKeys: [] };
  while (Date.now() < deadline) {
    parsed = extractTokens(readChildLogsText(state.child));
    if (parsed.adminTokens.length > 0 && parsed.apiKeys.length > 0) break;
    await delay(250);
  }
  const config = readConfigJson(state.dataDir);
  const configToken = typeof config?.auth?.adminToken === 'string' ? config.auth.adminToken : null;
  const configKeys = Array.isArray(config?.auth?.apiKeys)
    ? config.auth.apiKeys.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const token = parsed.adminTokens[0] || configToken || null;
  const apiKey = parsed.apiKeys[0] || configKeys[0] || null;
  return {
    token,
    apiKey,
    tokenSource: parsed.adminTokens.length > 0 ? 'stdout' : token ? 'config.json' : '未获取',
    apiKeySource: parsed.apiKeys.length > 0 ? 'stdout' : apiKey ? 'config.json' : '未获取'
  };
}

/* ------------------------------------------------------------------ */
/* 断言执行 / 输出                                                     */
/* ------------------------------------------------------------------ */

function addResult(state, id, name, status, detail, ms) {
  state.results.push({
    id,
    name,
    status,
    detail: String(detail ?? ''),
    ms: Number(ms) || 0
  });
}

async function runCheck(state, id, name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    addResult(state, id, name, 'PASS', detail, Date.now() - startedAt);
    const line = `  ${paint(GREEN, 'PASS')}  ${padDisplay(`${id}) ${name}`, 52)}  ${paint(
      DIM,
      `${Date.now() - startedAt}ms`
    )}  ${detail}`;
    console.log(line);
  } catch (error) {
    addResult(state, id, name, 'FAIL', error?.message || String(error), Date.now() - startedAt);
    console.log(
      `  ${paint(RED, 'FAIL')}  ${padDisplay(`${id}) ${name}`, 52)}  ${paint(
        DIM,
        `${Date.now() - startedAt}ms`
      )}  ${paint(RED, error?.message || String(error))}`
    );
  }
}

function fillMissingResults(state) {
  for (const [id, name] of EXPECTED_CHECKS) {
    if (state.results.some((result) => result.id === id)) continue;
    const reason = state.fatalError ? state.fatalError.message : '前置步骤失败，未执行';
    addResult(state, id, name, 'FAIL', `未执行：${reason}`, 0);
  }
}

function printResults(state) {
  console.log('');
  console.log(paint(DIM, '─'.repeat(96)));
  console.log('断言结果：');
  for (const result of state.results) {
    const status = result.status === 'PASS' ? paint(GREEN, 'PASS') : paint(RED, 'FAIL');
    const ms = result.ms > 0 ? `${result.ms}ms` : '-';
    console.log(
      `  ${status}  ${padDisplay(`${result.id}) ${result.name}`, 52)}  ${paint(DIM, padDisplay(ms, 6))}  ${
        result.status === 'PASS' ? result.detail : paint(RED, result.detail)
      }`
    );
  }
  const passed = state.results.filter((result) => result.status === 'PASS').length;
  const failed = state.results.length - passed;
  const verdict = failed === 0 ? paint(GREEN, 'PASS') : paint(RED, 'FAIL');
  console.log(paint(DIM, '─'.repeat(96)));
  console.log(
    `结果: ${verdict} ${passed}/${state.results.length}（总耗时 ${formatDuration(Date.now() - state.startedAt)}）`
  );
}

function printLogTail(state, round, maxLines = 30) {
  const logPaths = state.logPathsByRound[round];
  if (!logPaths) return;
  for (const [kind, filePath] of [
    ['stdout', logPaths.out],
    ['stderr', logPaths.err]
  ]) {
    const text = readTextFile(filePath);
    const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      console.log(`  [server-${round}.${kind}] （空）`);
      continue;
    }
    const tail = lines.slice(-maxLines);
    console.log(`  [server-${round}.${kind}] 最后 ${tail.length} 行（token 已脱敏）：`);
    for (const line of tail) console.log(`    ${redactSecrets(line)}`);
  }
}

function printDiagnostics(state) {
  const failures = state.results.filter((result) => result.status === 'FAIL');
  if (failures.length === 0 && !state.fatalError) return;
  console.log('');
  console.log(paint(RED, '----- 失败诊断 -----'));
  for (const failure of failures) {
    console.log(`${paint(RED, '✖')} ${failure.id}) ${failure.name}`);
    console.log(`  ${failure.detail}`);
  }
  if (state.fatalError) {
    console.log('');
    console.log('致命错误：');
    console.log(redactSecrets(state.fatalError.stack || state.fatalError.message || String(state.fatalError)));
  }
  console.log('');
  console.log('子进程日志（最后 30 行）：');
  for (const round of Object.keys(state.logPathsByRound)) {
    printLogTail(state, Number(round), 30);
  }
}

function printHeader(state, options) {
  console.log(paint(DIM, '='.repeat(96)));
  console.log('duckai-cpa Windows exe 端到端验证（scripts/verify-exe.mjs）');
  console.log(
    `模式      : ${
      options.mode === 'node'
        ? `node（自测，入口 ${path.relative(PROJECT_ROOT, state.target) || state.target}）`
        : 'Windows exe（复制到临时目录运行）'
    }`
  );
  console.log(`目标      : ${state.target}`);
  console.log(`端口      : ${state.port}`);
  console.log(`数据目录  : ${state.dataDir}${state.dataDirIsDefault ? '（默认，随运行目录清理）' : '（显式指定）'}`);
  console.log(`运行目录  : ${state.runDir}`);
  console.log(`日志目录  : ${state.logsDir}`);
  console.log(`启动超时  : ${options.timeoutMs}ms`);
  console.log(
    `清理策略  : ${
      options.keep
        ? '--keep（结束后保留子进程、数据目录与日志）'
        : '默认（结束后终止子进程；清理 data/tmp 下的临时运行目录）'
    }`
  );
  console.log(paint(DIM, '='.repeat(96)));
  console.log('');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

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

  // ---- 目标校验（先校验，避免无谓地创建临时目录） ----
  let targetPath;
  if (options.mode === 'node') {
    targetPath = path.resolve(PROJECT_ROOT, options.nodeEntry || DEFAULT_NODE_ENTRY);
    if (!isFile(targetPath)) {
      console.error(`错误: --node 入口不存在: ${targetPath}`);
      return 2;
    }
  } else {
    targetPath = path.resolve(PROJECT_ROOT, options.exe);
    if (!isFile(targetPath)) {
      console.error(`错误: exe 不存在: ${targetPath}`);
      console.error('提示: 先构建 exe（scripts/build-exe.mjs），或用 --node src/index.js 做脚本自测。');
      return 2;
    }
  }

  // ---- 端口 ----
  let port;
  try {
    port = await resolvePort(options.port);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    return 2;
  }

  // ---- 目录 ----
  const stamp = timestamp();
  const runDir = path.join(DATA_TMP_DIR, `exe-verify-${stamp}-${crypto.randomBytes(2).toString('hex')}`);
  const logsDir = path.join(runDir, 'logs');
  const dataDir = options.dataDir === null ? runDir : path.resolve(PROJECT_ROOT, options.dataDir);

  const state = {
    options,
    port,
    runDir,
    logsDir,
    dataDir,
    dataDirIsDefault: options.dataDir === null,
    preExistingConfig: false,
    target: targetPath,
    command: null,
    args: [],
    cwd: null,
    child: null,
    results: [],
    fatalError: null,
    startedAt: Date.now(),
    firstToken: null,
    firstTokenSource: '未获取',
    firstApiKey: null,
    firstApiKeySource: '未获取',
    logPathsByRound: {}
  };

  printHeader(state, options);

  if (options.mode === 'node' && !fs.existsSync(path.join(PROJECT_ROOT, 'web', 'index.html'))) {
    console.log(
      paint(
        YELLOW,
        '[警告] node 模式依赖仓库内 web/index.html（npm run build:web），当前未找到；断言 b/c 可能失败。'
      )
    );
  }
  if (!options.dataDirIsDefault && fs.existsSync(path.join(dataDir, 'config.json'))) {
    console.log(
      paint(
        YELLOW,
        `[提示] 数据目录已存在 config.json（非首次启动）：stdout 不会重新打印 adminToken/API Key，脚本将回退读取 config.json。`
      )
    );
  }

  let exitCode = 1;
  // 全局看门狗：离线沙箱里上游初始化偶发卡住时，保证验证进程与子进程不会无限残留。
  // 正常路径会在 finally 里 clearTimeout。
  const watchdogMs = options.timeoutMs * 2 + 120000;
  const watchdog = setTimeout(() => {
    console.error(
      paint(
        RED,
        `\n[看门狗] 验证总耗时超过 ${formatDuration(watchdogMs)}，强制终止子进程并退出（退出码 1）。`
      )
    );
    const pid = state.child?.pid;
    if (pid) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 8000
        });
      } catch {
        // ignore
      }
    }
    process.exit(1);
  }, watchdogMs);
  watchdog.unref?.();
  try {
    await fsp.mkdir(logsDir, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });

    // 在 spawn 前记录是否已有 config.json：非首次启动时网关不会重新打印 token。
    state.preExistingConfig = fs.existsSync(path.join(dataDir, 'config.json'));

    if (options.mode === 'exe') {
      // 复制到临时目录运行：验证 exe 是“单文件”产物，不依赖仓库内的 src/、web/、config/。
      const appDir = path.join(runDir, 'app');
      await fsp.mkdir(appDir, { recursive: true });
      const copiedExe = path.join(appDir, path.basename(targetPath));
      const sourceStat = await fsp.stat(targetPath);
      await fsp.copyFile(targetPath, copiedExe);
      state.command = copiedExe;
      state.args = [];
      state.cwd = appDir;
      console.log(`[准备] 已复制 exe 到临时目录: ${copiedExe}（${formatBytes(sourceStat.size)}）`);
    } else {
      state.command = process.execPath;
      state.args = [targetPath];
      state.cwd = PROJECT_ROOT;
      console.log(
        `[准备] node 模式: "${process.execPath}" "${targetPath}"（cwd=${PROJECT_ROOT}，DUCKAI_CPA_DATA_DIR=${dataDir}）`
      );
    }

    const env1 = buildChildEnv({ port, dataDir });

    /* -------------------------- 第一次启动 -------------------------- */
    console.log(`[启动 1] ${options.mode === 'exe' ? `"${state.command}"` : `node ${path.relative(PROJECT_ROOT, targetPath)}`}`);
    const child1 = spawnServer({ round: 1, state, options, env: env1 });
    state.child = child1;
    state.logPathsByRound[1] = child1.__logPaths;

    const ready1 = await waitForReady(child1, { port, timeoutMs: options.timeoutMs });
    console.log(`[就绪 1] /healthz 2xx（${ready1.ms}ms，pid=${child1.pid}）`);

    const tokens = await resolveFirstRunTokens(state, options);
    state.firstToken = tokens.token;
    state.firstTokenSource = tokens.tokenSource;
    state.firstApiKey = tokens.apiKey;
    state.firstApiKeySource = tokens.apiKeySource;
    console.log(`[令牌] adminToken = ${maskToken(tokens.token)}（来源：${tokens.tokenSource}）`);
    console.log(`[令牌] API Key    = ${maskToken(tokens.apiKey)}（来源：${tokens.apiKeySource}）`);
    console.log('');

    const baseUrl = `http://127.0.0.1:${port}`;

    /* ----------------------------- 断言 a~f ----------------------------- */
    await runCheck(state, 'a', EXPECTED_CHECKS[0][1], async () => {
      const response = await httpRequest(`${baseUrl}/healthz`);
      assert(response.status === 200, `/healthz 期望 200，实际 ${response.status}`);
      const json = parseJson(response.body);
      assert(json && typeof json === 'object', '/healthz 响应不是合法 JSON');
      assert(json.ok === true, `/healthz JSON ok 不为 true（实际 ${JSON.stringify(json.ok)}）`);
      const upstreamOk = json?.upstream?.ok;
      return `status=200, ok=true, upstream.ok=${upstreamOk}${
        upstreamOk === false ? '（离线降级，属正常）' : ''
      }`;
    });

    let assetRefs = [];
    await runCheck(state, 'b', EXPECTED_CHECKS[1][1], async () => {
      const response = await httpRequest(`${baseUrl}/admin/`);
      assert(response.status === 200, `/admin/ 期望 200，实际 ${response.status}`);
      const contentType = String(response.headers['content-type'] || '');
      assert(/^text\/html/i.test(contentType), `/admin/ content-type 不是 text/html（${contentType || '空'}）`);
      assert(
        response.body.includes('/admin/assets/'),
        '/admin/ HTML 未包含 /admin/assets/ 引用（web 构建产物缺失或 exe 未内嵌 web/）'
      );
      assetRefs = extractAssetRefs(response.body);
      assert(assetRefs.length > 0, '未能从 /admin/ HTML 中解析出 /admin/assets/ 静态资源引用');
      const names = assetRefs.map((ref) => path.basename(new URL(toAssetUrl(baseUrl, ref)).pathname));
      return `status=200, text/html, ${assetRefs.length} 个资源引用（${names.join(', ')}）`;
    });

    await runCheck(state, 'c', EXPECTED_CHECKS[2][1], async () => {
      assert(assetRefs.length > 0, '前置断言 b 未产出资源引用，无法校验静态资源');
      let jsCount = 0;
      let cssCount = 0;
      const details = [];
      for (const ref of assetRefs) {
        const url = toAssetUrl(baseUrl, ref);
        const response = await httpRequest(url, { timeoutMs: 15000 });
        assert(response.status === 200, `静态资源 ${ref} 期望 200，实际 ${response.status}`);
        const pathname = new URL(url).pathname;
        const extension = path.extname(pathname).toLowerCase();
        const contentType = String(response.headers['content-type'] || '');
        if (extension === '.js') {
          jsCount += 1;
          assert(/javascript/i.test(contentType), `JS 资源 ${ref} content-type 不合理：${contentType || '空'}`);
        } else if (extension === '.css') {
          cssCount += 1;
          assert(/^text\/css/i.test(contentType), `CSS 资源 ${ref} content-type 不合理：${contentType || '空'}`);
        } else if (extension === '.svg') {
          assert(/svg/i.test(contentType), `SVG 资源 ${ref} content-type 不合理：${contentType || '空'}`);
        }
        assert(response.bytes > 0, `静态资源 ${ref} 响应体为空`);
        details.push(`${path.basename(pathname)}(${formatBytes(response.bytes)})`);
      }
      assert(jsCount >= 1, 'HTML 未引用任何 JS 资源');
      assert(cssCount >= 1, 'HTML 未引用任何 CSS 资源');
      return `js=${jsCount}, css=${cssCount}（${details.join('；')}）`;
    });

    await runCheck(state, 'd', EXPECTED_CHECKS[3][1], async () => {
      assert(state.firstToken, '未获取 adminToken（stdout 与 config.json 均解析失败）');
      const response = await httpRequest(
        `${baseUrl}/admin/api/overview?token=${encodeURIComponent(state.firstToken)}`
      );
      assert(
        response.status === 200,
        `/admin/api/overview 期望 200，实际 ${response.status}（${truncate(response.body)}）`
      );
      const json = parseJson(response.body);
      assert(json && typeof json === 'object', '/admin/api/overview 响应不是合法 JSON');
      assert(json.service && typeof json.service === 'object', 'overview 缺少 service 对象');
      assert(typeof json.service.name === 'string' && json.service.name, 'overview 缺少 service.name');
      assert(
        typeof json.service.version === 'string' && json.service.version.trim(),
        'overview 缺少非空 service.version'
      );
      assert(json.upstream && typeof json.upstream === 'object', 'overview 缺少 upstream 对象');
      return `service.name=${json.service.name}, service.version=${json.service.version}, upstream.ok=${json.upstream.ok}`;
    });

    await runCheck(state, 'e', EXPECTED_CHECKS[4][1], async () => {
      assert(state.firstApiKey, '未获取 API Key（stdout 与 config.json 均解析失败）');
      const response = await httpRequest(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${state.firstApiKey}` }
      });
      assert(
        response.status === 200,
        `/v1/models 期望 200，实际 ${response.status}（${truncate(response.body)}）`
      );
      const json = parseJson(response.body);
      assert(json && Array.isArray(json.data), '/v1/models 响应缺少 data 数组');
      assert(json.data.length > 0, '/v1/models 的 data 数组为空');
      const sample = json.data.slice(0, 3).map((model) => model.id).join(', ');
      return `models=${json.data.length}（${sample}${json.data.length > 3 ? ', …' : ''}）`;
    });

    await runCheck(state, 'f', EXPECTED_CHECKS[5][1], async () => {
      const configPath = path.join(dataDir, 'config.json');
      const dbPath = path.join(dataDir, 'duckai.db');
      const configStat = statFile(configPath);
      const dbStat = statFile(dbPath);
      assert(configStat, `数据目录缺少 config.json：${configPath}`);
      assert(configStat.size > 0, `config.json 为空：${configPath}`);
      assert(dbStat, `数据目录缺少 duckai.db（SQLite 未初始化）：${dbPath}`);
      assert(dbStat.size > 0, `duckai.db 为空：${dbPath}`);
      const config = parseJson(readTextFile(configPath));
      assert(config && typeof config === 'object', 'config.json 不是合法 JSON');
      assert(
        typeof config?.auth?.adminToken === 'string' && config.auth.adminToken,
        'config.json 缺少 auth.adminToken'
      );
      assert(
        config.auth.adminToken === state.firstToken,
        `config.json 中的 adminToken 与首次运行不一致（${maskToken(config.auth.adminToken)} vs ${maskToken(
          state.firstToken
        )}）`
      );
      return `config.json=${formatBytes(configStat.size)}, duckai.db=${formatBytes(dbStat.size)}`;
    });

    /* ----------------------------- 重启 ----------------------------- */
    const restart = { ok: false, error: null, readyMs: null };
    try {
      console.log('');
      console.log('[重启] 停止第一个进程，等待端口释放…');
      const stopped = await stopChild(child1);
      assert(stopped.stopped, `第一个进程未能正常结束（pid=${child1.pid}）`);
      state.child = null;
      await waitPortReleased(port, 15000);

      const env2 = buildChildEnv({ port, dataDir });
      console.log(
        `[重启] 使用同一数据目录重新启动: ${options.mode === 'exe' ? `"${state.command}"` : `node ${path.relative(PROJECT_ROOT, targetPath)}`}`
      );
      const child2 = spawnServer({ round: 2, state, options, env: env2 });
      state.child = child2;
      state.logPathsByRound[2] = child2.__logPaths;
      const ready2 = await waitForReady(child2, { port, timeoutMs: options.timeoutMs });
      restart.ok = true;
      restart.readyMs = ready2.ms;
      console.log(`[就绪 2] 重启后 /healthz 2xx（${ready2.ms}ms，pid=${child2.pid}）`);
    } catch (error) {
      restart.error = error;
      console.log(paint(RED, `[重启] 失败：${error.message}`));
    }

    /* ----------------------------- 断言 g~h ----------------------------- */
    await runCheck(state, 'g', EXPECTED_CHECKS[6][1], async () => {
      assert(restart.ok, `重启失败：${restart.error?.message || '未知错误'}`);
      const config = readConfigJson(dataDir);
      assert(config && config.auth && typeof config.auth.adminToken === 'string', '重启后 config.json 缺少 auth.adminToken');
      assert(
        config.auth.adminToken === state.firstToken,
        `重启后 adminToken 与首次运行不一致（${maskToken(config.auth.adminToken)} vs ${maskToken(
          state.firstToken
        )}）`
      );
      const response = await httpRequest(`${baseUrl}/admin/`);
      assert(response.status === 200, `重启后 /admin/ 期望 200，实际 ${response.status}`);
      assert(response.body.includes('/admin/assets/'), '重启后 /admin/ HTML 未包含 /admin/assets/ 引用');
      return `adminToken 一致（${maskToken(state.firstToken)}）, /admin/ 200`;
    });

    await runCheck(state, 'h', EXPECTED_CHECKS[7][1], async () => {
      assert(restart.ok, `重启失败：${restart.error?.message || '未知错误'}`);
      assert(state.firstApiKey, '未获取 API Key，无法验证持久化');
      const response = await httpRequest(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${state.firstApiKey}` }
      });
      assert(
        response.status === 200,
        `重启后 /v1/models 期望 200，实际 ${response.status}（${truncate(response.body)}）`
      );
      const json = parseJson(response.body);
      assert(json && Array.isArray(json.data) && json.data.length > 0, '重启后 /v1/models 的 data 数组为空');
      return `models=${json.data.length}（默认 API Key 已持久化）`;
    });
  } catch (error) {
    state.fatalError = error;
  } finally {
    // 清理子进程（--keep 时保留最后启动的进程，供人工排查）
    if (state.child && !options.keep) {
      const stopped = await stopChild(state.child);
      if (!stopped.stopped) {
        console.log(paint(YELLOW, `[警告] 子进程（pid=${state.child.pid}）未能完全终止`));
      }
      state.child = null;
    } else if (state.child && options.keep) {
      console.log(paint(YELLOW, `[保留] 子进程仍在运行：pid=${state.child.pid}`));
    }

    fillMissingResults(state);
    printResults(state);
    printDiagnostics(state);

    const failed = state.results.filter((result) => result.status === 'FAIL').length;
    exitCode = failed === 0 ? 0 : 1;

    console.log('');
    console.log(`数据目录: ${state.dataDir}`);
    console.log(`日志目录: ${state.logsDir}`);

    if (options.keep) {
      console.log(paint(YELLOW, '[保留] --keep：子进程、数据目录与日志均已保留，请手动结束进程并清理。'));
    } else if (isInside(DATA_TMP_DIR, state.runDir)) {
      try {
        await fsp.rm(state.runDir, { recursive: true, force: true });
        console.log(`[清理] 已删除临时运行目录: ${state.runDir}`);
        if (!state.dataDirIsDefault) {
          // 只有显式 --data-dir 位于 data/tmp 下（即临时验证目录）才自动删除；
          // 位于 data/tmp 之外的用户目录绝不删除。
          const dataDirUnderTmp =
            isInside(DATA_TMP_DIR, state.dataDir) &&
            path.resolve(state.dataDir) !== path.resolve(DATA_TMP_DIR) &&
            path.resolve(state.dataDir) !== path.resolve(state.runDir);
          if (dataDirUnderTmp) {
            await fsp.rm(state.dataDir, { recursive: true, force: true });
            console.log(`[清理] 已删除 --data-dir（位于 data/tmp 下）: ${state.dataDir}`);
          } else {
            console.log(
              paint(YELLOW, `[保留] 显式 --data-dir 位于 data/tmp 之外，未自动删除: ${state.dataDir}`)
            );
          }
        }
      } catch (error) {
        console.log(paint(YELLOW, `[警告] 清理临时运行目录失败：${error.message}`));
      }
    } else {
      console.log(paint(YELLOW, `[保留] 运行目录不在 data/tmp 下，未自动删除: ${state.runDir}`));
    }

    clearTimeout(watchdog);
    console.log('');
    console.log(`退出码: ${exitCode}（0=PASS，1=FAIL，2=用法/环境错误）`);
  }

  return exitCode;
}

function extractAssetRefs(html) {
  const refs = new Set();
  const regex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const ref = match[1];
    if (
      ref.startsWith('/admin/assets/') ||
      ref.startsWith('./assets/') ||
      ref.startsWith('assets/') ||
      /^https?:\/\/[^"']+\/admin\/assets\//i.test(ref)
    ) {
      refs.add(ref);
    }
  }
  return [...refs];
}

function toAssetUrl(baseUrl, ref) {
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('/')) return `${baseUrl}${ref}`;
  return `${baseUrl}/admin/${ref.replace(/^\.?\//, '')}`;
}

/* ------------------------------------------------------------------ */

main()
  .then((code) => {
    process.exitCode = code;
    // 兜底：正常情况下事件循环自然退出；若节点被意外的句柄拖住，最多等 5s 强制退出。
    const forceExit = setTimeout(() => process.exit(code), 5000);
    forceExit.unref?.();
  })
  .catch((error) => {
    console.error('未捕获异常：');
    console.error(redactSecrets(error?.stack || error?.message || String(error)));
    process.exitCode = 1;
  });
