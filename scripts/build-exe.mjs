#!/usr/bin/env node
/**
 * duckai-cpa Windows x64 单文件 exe 构建脚本（scripts/build-exe.mjs）。
 *
 * 使用 Bun 的 `bun build --compile` 把 src/index.js 及其完整依赖图打包为单个
 * duckai-cpa.exe，同时把管理后台产物 web/、默认配置 config/、package.json
 * 作为 asset 嵌入到 exe 的只读虚拟根（B:\~BUN\root\）中。
 *
 * 用法（Node 24 或 Bun >= 1.4.4 均可运行）：
 *   node scripts/build-exe.mjs [选项]
 *   bun  scripts/build-exe.mjs [选项]
 *
 * 选项：
 *   --skip-web-build    跳过 web/ 产物检查（CI 中已单独执行 npm run build:web）
 *   --force-web-build   强制重新执行 npm run build:web
 *   --skip-trim         不传 --trim（不裁剪未使用的 Bun 内置模块，产物明显更大）
 *   --no-assets         不嵌入 web/、config/、package.json（仅调试用）
 *   --outfile=<path>    自定义输出路径（默认 dist/windows-x64/duckai-cpa.exe）
 *   -h, --help          显示帮助
 *
 * 环境变量：
 *   BUN_BIN             指定 Bun 可执行文件（必须 >= 1.4.4；--trim / --asset 是新版隐藏参数）
 *
 * 说明：
 *   - Bun 1.3.x 不支持隐藏参数 --trim / --asset，会直接构建失败，故脚本强制校验 >= 1.4.4。
 *   - 构建前会幂等修改 node_modules/css-tree 的两个文件（仅本地 node_modules，不提交），
 *     否则 Bun 打包后的 exe 在运行时无法解析 createRequire(import.meta.url) 的模块。
 *   - 沙箱/受限环境下 stdio 管道（pipe）可能被拒绝（Windows EPERM），因此本脚本
 *     所有需要捕获输出的子进程都通过临时文件重定向实现，不使用管道。
 *
 * 退出码：0 成功；1 失败（参数错误、环境不满足、bun build 失败、产物缺失等）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUTFILE = path.join(PROJECT_ROOT, 'dist', 'windows-x64', 'duckai-cpa.exe');
const DEFAULT_ENTRY = 'src/index.js';
const MINIMUM_BUN = [1, 4, 4];
const WINDOWS_TARGET = 'bun-windows-x64';
const WINDOWS_TITLE = 'DuckAI CPA';
const WINDOWS_PUBLISHER = 'duckai-cpa';
const WINDOWS_DESCRIPTION = 'DuckAI CPA - OpenAI-compatible gateway for Duck.ai';

/**
 * 需要在 node_modules 中打的两个 css-tree 补丁。
 * 原文件用 createRequire(import.meta.url) + require 读取 JSON，Bun 打包成 exe 后
 * 运行时找不到对应模块；替换为 import assertions 形式后即可被打包器静态处理。
 */
const NODE_MODULES_PATCHES = [
  {
    label: 'css-tree/lib/data-patch.js',
    file: path.join(PROJECT_ROOT, 'node_modules', 'css-tree', 'lib', 'data-patch.js'),
    content: "import patch from '../data/patch.json' with { type: 'json' };\n\nexport default patch;\n"
  },
  {
    label: 'css-tree/lib/version.js',
    file: path.join(PROJECT_ROOT, 'node_modules', 'css-tree', 'lib', 'version.js'),
    content: "import pkg from '../package.json' with { type: 'json' };\n\nexport const { version } = pkg;\n"
  }
];

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

/* ------------------------------------------------------------------ */
/* 参数解析与帮助                                                       */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    skipWebBuild: false,
    forceWebBuild: false,
    skipTrim: false,
    noAssets: false,
    outfile: DEFAULT_OUTFILE,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--skip-web-build') {
      options.skipWebBuild = true;
    } else if (arg === '--force-web-build') {
      options.forceWebBuild = true;
    } else if (arg === '--skip-trim') {
      options.skipTrim = true;
    } else if (arg === '--no-assets') {
      options.noAssets = true;
    } else if (arg === '--outfile') {
      const value = argv[index + 1];
      if (!value) throw new Error('--outfile 需要一个路径参数');
      options.outfile = value;
      index += 1;
    } else if (arg.startsWith('--outfile=')) {
      const value = arg.slice('--outfile='.length);
      if (!value) throw new Error('--outfile= 后面需要一个路径');
      options.outfile = value;
    } else {
      throw new Error(`未知参数: ${arg}（使用 --help 查看用法）`);
    }
  }
  if (options.skipWebBuild && options.forceWebBuild) {
    throw new Error('--skip-web-build 与 --force-web-build 不能同时使用');
  }
  options.outfile = path.resolve(PROJECT_ROOT, options.outfile);
  return options;
}

function printHelp() {
  console.log(`duckai-cpa Windows x64 单文件 exe 构建脚本

用法:
  node scripts/build-exe.mjs [选项]
  bun  scripts/build-exe.mjs [选项]     # 需要 Bun >= 1.4.4

选项:
  --skip-web-build    跳过 web/ 产物检查（CI 中已单独执行 npm run build:web）
  --force-web-build   强制重新执行 npm run build:web
  --skip-trim         不传 --trim（产物更大；仅排障用）
  --no-assets         不嵌入 web/、config/、package.json（仅调试用）
  --outfile=<path>    自定义输出路径（默认 dist/windows-x64/duckai-cpa.exe）
  -h, --help          显示本帮助

环境变量:
  BUN_BIN             指定 Bun 可执行文件（必须 >= 1.4.4）

示例:
  node scripts/build-exe.mjs
  node scripts/build-exe.mjs --skip-web-build
  $env:BUN_BIN = "C:\\bun\\bun.exe"; npm run build:exe
`);
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function info(message) {
  console.log(message);
}

function warn(message) {
  console.warn(paint(YELLOW, `警告: ${message}`));
}

function step(index, total, message) {
  console.log(`\n${paint(CYAN, `[${index}/${total}]`)} ${message}`);
}

/* ------------------------------------------------------------------ */
/* 子进程工具（无管道，兼容受限沙箱）                                     */
/* ------------------------------------------------------------------ */

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 捕获子进程输出。不使用 stdio: 'pipe'（受限 Windows 沙箱下创建命名管道会 EPERM），
 * 而是把 stdout/stderr 重定向到临时文件，执行完再读回。
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, error?: Error}}
 */
function captureCommand(command, args, { timeout = 60000 } = {}) {
  let tempDir = null;
  let stdoutFd = null;
  let stderrFd = null;
  try {
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckai-cpa-build-'));
    } catch {
      // 系统临时目录不可写时退回到仓库 node_modules/.cache（已被 .gitignore 覆盖）。
      const cacheDir = path.join(PROJECT_ROOT, 'node_modules', '.cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      tempDir = fs.mkdtempSync(path.join(cacheDir, 'duckai-cpa-build-'));
    }
    const stdoutPath = path.join(tempDir, 'stdout.txt');
    const stderrPath = path.join(tempDir, 'stderr.txt');
    stdoutFd = fs.openSync(stdoutPath, 'w');
    stderrFd = fs.openSync(stderrPath, 'w');
    const result = spawnSync(command, args, {
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      timeout
    });
    fs.closeSync(stdoutFd);
    stdoutFd = null;
    fs.closeSync(stderrFd);
    stderrFd = null;
    const stdout = readTextFileSafe(stdoutPath);
    const stderr = readTextFileSafe(stderrPath);
    return { ok: result.status === 0, status: result.status, stdout, stderr, error: result.error };
  } finally {
    if (stdoutFd !== null) {
      try {
        fs.closeSync(stdoutFd);
      } catch {
        /* ignore */
      }
    }
    if (stderrFd !== null) {
      try {
        fs.closeSync(stderrFd);
      } catch {
        /* ignore */
      }
    }
    if (tempDir !== null) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function parseVersionTuple(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(actual, minimum) {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function formatVersion(tuple) {
  return tuple.join('.');
}

/* ------------------------------------------------------------------ */
/* Bun 定位与版本校验                                                    */
/* ------------------------------------------------------------------ */

function normalizeBunCommand(value) {
  const trimmed = String(value).trim();
  // 带路径分隔符的相对路径按当前工作目录解析；纯命令名（如 bun / bun.exe）交给 PATH。
  if (/[\\/]/.test(trimmed) && !path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return trimmed;
}

function detectBun(command) {
  const captured = captureCommand(command, ['--version'], { timeout: 30000 });
  const stderr = String(captured.stderr || '').trim();
  if (captured.error) {
    if (captured.error.code === 'ENOENT') {
      return { found: false, reason: '未找到可执行文件' };
    }
    return {
      found: false,
      reason: `${captured.error.code || '执行失败'}: ${String(captured.error.message || '').trim()}`
    };
  }
  if (!captured.ok) {
    return {
      found: false,
      reason: `执行 ${command} --version 失败（退出码 ${captured.status}）${stderr ? `: ${stderr}` : ''}`
    };
  }
  const raw = String(captured.stdout || '').trim().split(/\r?\n/)[0].trim();
  const tuple = parseVersionTuple(raw);
  if (!tuple) {
    return { found: false, reason: `无法解析版本输出: ${raw || '（空）'}` };
  }
  return { found: true, raw, tuple };
}

/**
 * 按优先级选择 Bun：BUN_BIN > 脚本自身由 Bun 运行时的 process.execPath > PATH 中的 bun。
 * BUN_BIN 是用户显式指定，若不可用或版本过低则直接报错，不再回退，避免悄悄用错版本。
 */
function resolveBun() {
  const envBun = String(process.env.BUN_BIN || '').trim();
  const candidates = [];
  const addCandidate = (command, source, required = false) => {
    if (!command) return;
    if (candidates.some((item) => item.command.toLowerCase() === command.toLowerCase())) return;
    candidates.push({ command, source, required });
  };

  if (envBun) addCandidate(normalizeBunCommand(envBun), '环境变量 BUN_BIN', true);

  const execBase = path.basename(process.execPath).toLowerCase();
  if (/^bun(\.exe)?$/.test(execBase)) {
    addCandidate(process.execPath, '当前脚本由 Bun 运行（process.execPath）');
  }

  addCandidate(process.platform === 'win32' ? 'bun.exe' : 'bun', 'PATH');

  const problems = [];
  for (const candidate of candidates) {
    const probe = detectBun(candidate.command);
    if (!probe.found) {
      const message = `${candidate.source}: ${probe.reason}`;
      if (candidate.required) {
        throw new Error(`BUN_BIN 指定的 Bun 无法使用（${message}）。请把 BUN_BIN 指向 Bun >= 1.4.4 的可执行文件。`);
      }
      problems.push(message);
      continue;
    }
    if (!isVersionAtLeast(probe.tuple, MINIMUM_BUN)) {
      const message =
        `${candidate.source} 的 Bun 版本为 ${probe.raw}，低于要求的 >= ${formatVersion(MINIMUM_BUN)}` +
        '（--trim / --asset 需要 Bun >= 1.4.4）';
      if (candidate.required) {
        throw new Error(`${message}。请升级 Bun，或让 BUN_BIN 指向 Bun >= 1.4.4。`);
      }
      problems.push(message);
      continue;
    }
    return { command: candidate.command, source: candidate.source, rawVersion: probe.raw };
  }

  const details = problems.length > 0 ? `\n已尝试:\n${problems.map((item) => `  - ${item}`).join('\n')}` : '';
  throw new Error(
    `未找到可用的 Bun（需要 >= ${formatVersion(MINIMUM_BUN)}）。${details}\n` +
      '请安装 Bun >= 1.4.4（https://bun.sh），或通过环境变量 BUN_BIN 指向其可执行文件。\n' +
      'Bun 1.3.x 不支持 --trim / --asset，构建会失败。'
  );
}

/* ------------------------------------------------------------------ */
/* package.json / Windows 元数据                                        */
/* ------------------------------------------------------------------ */

function readPackageJson() {
  const packagePath = path.join(PROJECT_ROOT, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(packagePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 ${packagePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\ufeff/, ''));
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON: ${error.message}`);
  }
}

/** 把 semver 版本（如 0.1.0 / 1.2.3-beta.4）转成 Windows 要求的 4 段版本号。 */
function toWindowsVersion(version) {
  const match = String(version || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const parts = [match?.[1], match?.[2], match?.[3]].map((value) => {
    const number = Number(value ?? 0);
    return Math.min(Math.max(Number.isFinite(number) ? Math.trunc(number) : 0, 0), 65535);
  });
  parts.push(0);
  return parts.join('.');
}

/* ------------------------------------------------------------------ */
/* web/ 产物                                                           */
/* ------------------------------------------------------------------ */

function runNpmBuildWeb() {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', 'build:web'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build:web 失败（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）`));
    });
  });
}

async function ensureWebAssets(options) {
  const webIndex = path.join(PROJECT_ROOT, 'web', 'index.html');
  const exists = fs.existsSync(webIndex);
  if (options.forceWebBuild) {
    info('--force-web-build：强制重新执行 npm run build:web');
    await runNpmBuildWeb();
  } else if (exists) {
    info('web/index.html 已存在，跳过 npm run build:web（可用 --force-web-build 强制重建）');
    return;
  } else if (options.skipWebBuild) {
    warn('web/index.html 不存在，但指定了 --skip-web-build：跳过 web 构建，exe 将缺少管理后台（web/ 不会被嵌入）。');
    return;
  } else {
    info('web/index.html 不存在：执行 npm run build:web');
    await runNpmBuildWeb();
  }
  if (!fs.existsSync(webIndex)) {
    throw new Error('web 构建结束但 web/index.html 仍不存在，请检查 npm run build:web 的输出');
  }
}

/* ------------------------------------------------------------------ */
/* node_modules 补丁                                                    */
/* ------------------------------------------------------------------ */

function normalizePatchText(text) {
  return String(text).replace(/\r\n/g, '\n').trim();
}

function applyNodeModulesPatches() {
  const cssTreeDir = path.join(PROJECT_ROOT, 'node_modules', 'css-tree');
  if (!fs.existsSync(cssTreeDir)) {
    warn('node_modules/css-tree 不存在（依赖是否已安装？），跳过补丁；若构建失败请先执行 npm ci。');
    return;
  }
  for (const patch of NODE_MODULES_PATCHES) {
    if (!fs.existsSync(patch.file)) {
      warn(`${patch.label} 不存在，跳过补丁（css-tree 结构可能已变化）。`);
      continue;
    }
    const current = readTextFileSafe(patch.file);
    if (normalizePatchText(current) === normalizePatchText(patch.content)) {
      info(`${patch.label}: 已是补丁内容，跳过`);
      continue;
    }
    fs.writeFileSync(patch.file, patch.content, 'utf8');
    info(`${patch.label}: 已写入补丁（createRequire → import JSON，Bun 打包后可解析）`);
  }
}

/* ------------------------------------------------------------------ */
/* bun build                                                            */
/* ------------------------------------------------------------------ */

const toPosix = (value) => value.split(path.sep).join('/');

function buildBunArgs(packageJson, options) {
  const args = ['build', DEFAULT_ENTRY, '--compile'];
  if (!options.skipTrim) args.push('--trim');
  args.push(`--target=${WINDOWS_TARGET}`);
  if (!options.noAssets) {
    args.push('--asset=web', '--asset=config', '--asset=package.json');
  }
  args.push(`--outfile=${toPosix(path.relative(PROJECT_ROOT, options.outfile))}`);
  // Windows 元数据；保留控制台（不加 --windows-hide-console）：首次启动需要打印 adminToken / API Key。
  args.push('--windows-title', WINDOWS_TITLE);
  args.push('--windows-publisher', WINDOWS_PUBLISHER);
  args.push('--windows-version', toWindowsVersion(packageJson.version));
  args.push('--windows-description', WINDOWS_DESCRIPTION);
  return args;
}

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part}"` : part))
    .join(' ');
}

function runBunBuild(bunPath, args) {
  return new Promise((resolve, reject) => {
    info(paint(DIM, `$ ${formatCommand(bunPath, args)}`));
    const startedAt = Date.now();
    const child = spawn(bunPath, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      windowsHide: true
    });
    child.on('error', (error) => reject(new Error(`无法启动 Bun（${bunPath}）：${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Date.now() - startedAt);
        return;
      }
      reject(new Error(`bun build 失败：退出码 ${code}${signal ? `，信号 ${signal}` : ''}`));
    });
  });
}

function verifyOutput(outfile, elapsedMs) {
  let stat;
  try {
    stat = fs.statSync(outfile);
  } catch {
    throw new Error(`构建命令已结束，但产物不存在：${outfile}`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`产物无效（不是文件或大小为 0）：${outfile}`);
  }
  const megabytes = stat.size / 1000 / 1000;
  info(`产物路径：${paint(GREEN, outfile)}`);
  info(`产物大小：${megabytes.toFixed(1)} MB（${stat.size.toLocaleString('en-US')} 字节）`);
  info(`构建耗时：${(elapsedMs / 1000).toFixed(1)} 秒`);
  return stat;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  info(paint(CYAN, 'duckai-cpa Windows x64 单文件 exe 构建'));
  info(paint(DIM, `仓库根: ${PROJECT_ROOT}`));

  step(1, 4, '检查构建环境');
  if (process.platform !== 'win32') {
    throw new Error(
      `本脚本只支持在 Windows 上构建（当前平台 ${process.platform}）。` +
        'CI 请使用 windows-latest，见 .github/workflows/build-windows-exe.yml。'
    );
  }
  const packageJson = readPackageJson();
  const bun = resolveBun();
  info(`Bun: ${bun.command}（版本 ${bun.rawVersion}，来源: ${bun.source}）`);
  info(`输出: ${options.outfile}`);
  info(`Windows 版本号: ${toWindowsVersion(packageJson.version)}（package.json version=${packageJson.version ?? '未设置'}）`);

  step(2, 4, '检查管理后台产物（web/）');
  await ensureWebAssets(options);

  step(3, 4, '应用 css-tree node_modules 补丁（Bun 打包兼容，幂等）');
  applyNodeModulesPatches();

  step(4, 4, '编译并校验可执行文件');
  fs.mkdirSync(path.dirname(options.outfile), { recursive: true });
  const args = buildBunArgs(packageJson, options);
  if (options.skipTrim) warn('--skip-trim：产物会明显变大。');
  if (options.noAssets) {
    warn('--no-assets：exe 将不包含 web/、config/、package.json，运行时缺少管理后台与默认配置（仅调试用）。');
  }
  const elapsedMs = await runBunBuild(bun.command, args);
  verifyOutput(options.outfile, elapsedMs);

  info('');
  info(paint(GREEN, '构建成功。'));
  info(`可直接分发：${options.outfile}`);
}

main().catch((error) => {
  console.error('');
  console.error(paint(RED, `构建失败: ${error.message}`));
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
