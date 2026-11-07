#!/usr/bin/env node
/**
 * duckai-cpa 多平台单文件二进制构建脚本（scripts/build-exe.mjs）。
 *
 * 使用 Bun 的 `bun build --compile` 把 src/index.js 及其完整依赖图打包为单个可执行文件，
 * 同时把管理后台产物 web/、默认配置 config/、package.json 作为 asset 嵌入到二进制
 * 的只读虚拟根（Windows `B:\~BUN\root\`，Linux/macOS `/$bunfs/root`）中。
 *
 * 用法（Node 24 或 Bun >= 1.4.4 均可运行）：
 *   node scripts/build-exe.mjs [选项]
 *   bun  scripts/build-exe.mjs [选项]
 *
 * 默认目标 = 当前构建机（win32-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64）；
 * 其他目标通过 --target 指定（Bun 会下载对应平台的运行时，交叉编译产物不能在本机运行）。
 *
 * 选项：
 *   --target=<bun-target>  目标：bun-windows-x64 | bun-linux-x64 | bun-linux-arm64 |
 *                          bun-linux-x64-musl | bun-linux-arm64-musl |
 *                          bun-darwin-x64 | bun-darwin-arm64（默认=当前构建机）
 *   --skip-web-build       跳过 web/ 产物检查（CI 中已单独执行 npm run build:web）
 *   --force-web-build      强制重新执行 npm run build:web
 *   --skip-trim            不传 --trim（不裁剪未使用的 Bun 内置模块，产物更大）
 *   --no-assets            不嵌入 web/、config/、package.json（仅调试用）
 *   --outfile=<path>       自定义输出路径（默认 dist/<target>/duckai-cpa[.exe]）
 *   -h, --help             显示帮助
 *
 * 环境变量：
 *   BUN_BIN                指定 Bun 可执行文件（必须 >= 1.4.4；--trim / --asset 是新版参数）
 *
 * 说明：
 *   - Bun 1.3.x 不支持 --trim / --asset，会直接构建失败，故脚本强制校验 >= 1.4.4。
 *   - 构建前会幂等修改 node_modules/css-tree 的两个文件（仅本地 node_modules，不提交），
 *     否则 Bun 打包后的二进制在运行时无法解析 createRequire(import.meta.url) 的模块。
 *   - Linux 的 glibc 目标用于 Debian/Ubuntu 系镜像；musl 目标用于 Alpine 极简镜像。
 *   - 输出目录会写入 RUN-README.txt（运行方式/数据目录/管理后台地址），便于随二进制分发。
 *   - 受限环境下 stdio 管道（pipe）可能被拒绝（Windows EPERM），因此需要捕获输出的
 *     子进程都通过临时文件重定向实现，不使用管道。
 *
 * 退出码：0 成功；1 失败（参数错误、环境不满足、bun build 失败、产物无效等）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ENTRY = 'src/index.js';
const MINIMUM_BUN = [1, 4, 4];

/**
 * 支持的 Bun standalone 目标。
 * - windows/linux/darwin：官方平台名；linux 分 glibc 与 musl（Alpine 极简镜像用 musl）。
 * - dirName 是 dist 下的输出目录；binaryName 是默认产物文件名。
 */
const TARGETS = Object.freeze({
  'bun-windows-x64': {
    label: 'Windows x64',
    platform: 'win32',
    arch: 'x64',
    dirName: 'windows-x64',
    binaryName: 'duckai-cpa.exe'
  },
  'bun-linux-x64': {
    label: 'Linux x64（glibc）',
    platform: 'linux',
    arch: 'x64',
    dirName: 'linux-x64',
    binaryName: 'duckai-cpa'
  },
  'bun-linux-arm64': {
    label: 'Linux arm64（glibc）',
    platform: 'linux',
    arch: 'arm64',
    dirName: 'linux-arm64',
    binaryName: 'duckai-cpa'
  },
  'bun-linux-x64-musl': {
    label: 'Linux x64（musl / Alpine）',
    platform: 'linux',
    arch: 'x64',
    dirName: 'linux-x64-musl',
    binaryName: 'duckai-cpa'
  },
  'bun-linux-arm64-musl': {
    label: 'Linux arm64（musl / Alpine）',
    platform: 'linux',
    arch: 'arm64',
    dirName: 'linux-arm64-musl',
    binaryName: 'duckai-cpa'
  },
  'bun-darwin-x64': {
    label: 'macOS x64（Intel）',
    platform: 'darwin',
    arch: 'x64',
    dirName: 'darwin-x64',
    binaryName: 'duckai-cpa'
  },
  'bun-darwin-arm64': {
    label: 'macOS arm64（Apple Silicon）',
    platform: 'darwin',
    arch: 'arm64',
    dirName: 'darwin-arm64',
    binaryName: 'duckai-cpa'
  }
});

const HOST_TARGETS = Object.freeze({
  'win32-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64'
});

/** 当前构建机默认目标（无法推断时返回 null，需要显式 --target）。 */
function defaultTargetForHost() {
  return HOST_TARGETS[`${process.platform}-${process.arch}`] || null;
}

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

/**
 * jsdom 的 computed-style.js 在模块顶层用 `__dirname` + fs 读取 default-stylesheet.css。
 * `bun build --compile` 会把 CommonJS 的 `__dirname` 内联为**构建机绝对路径**，
 * 因此换一台机器运行（或交叉编译到别的平台）就会 ENOENT。构建时把 CSS 内容直接内联，
 * 让单文件二进制不依赖构建机的 node_modules 路径。
 */
const JSDOM_STYLESHEET_PATCH = {
  label: 'jsdom/lib/jsdom/living/css/helpers/computed-style.js',
  file: path.join(
    PROJECT_ROOT,
    'node_modules',
    'jsdom',
    'lib',
    'jsdom',
    'living',
    'css',
    'helpers',
    'computed-style.js'
  ),
  cssFile: path.join(PROJECT_ROOT, 'node_modules', 'jsdom', 'lib', 'jsdom', 'browser', 'default-stylesheet.css')
};

/** jsdom 同步 XHR worker（require.resolve 会被 Bun 固化为构建机路径）。 */
const JSDOM_XHR_PATCH = {
  label: 'jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js',
  file: path.join(PROJECT_ROOT, 'node_modules', 'jsdom', 'lib', 'jsdom', 'living', 'xhr', 'XMLHttpRequest-impl.js')
};

/**
 * css-tree/lib/data.js 用 createRequire(import.meta.url) 读取 mdn-data JSON。
 * 编译后的二进制里 import.meta.url 指向 exe/虚拟根，createRequire 找不到包；
 * 改成静态 JSON import 后由打包器内联（与 data-patch.js / version.js 同类问题）。
 */
const CSS_TREE_DATA_PATCH = {
  label: 'css-tree/lib/data.js',
  file: path.join(PROJECT_ROOT, 'node_modules', 'css-tree', 'lib', 'data.js'),
  marker: "import mdnAtrules from 'mdn-data/css/at-rules.json' with { type: 'json' };"
};




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
    target: null,
    outfile: null,
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
    } else if (arg === '--target') {
      const value = argv[index + 1];
      if (!value) throw new Error('--target 需要一个 Bun 目标名');
      options.target = value;
      index += 1;
    } else if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length);
      if (!value) throw new Error('--target= 后面需要一个目标名');
      options.target = value;
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
  if (options.outfile) options.outfile = path.resolve(PROJECT_ROOT, options.outfile);
  return options;
}

/**
 * 解析/校验目标，并补全默认输出路径。
 * @param {ReturnType<typeof parseArgs>} options
 */
function resolveTarget(options) {
  const requested = options.target ? String(options.target).trim() : null;
  const target = requested || defaultTargetForHost();
  if (!target) {
    throw new Error(
      `无法根据当前构建机（${process.platform}-${process.arch}）推断默认目标，请显式指定 --target=[${Object.keys(TARGETS).join('|')}]`
    );
  }
  const info = TARGETS[target];
  if (!info) {
    throw new Error(`未知 --target "${target}"。可选值：\n  ${Object.keys(TARGETS).join('\n  ')}`);
  }
  if (!options.outfile) {
    options.outfile = path.join(PROJECT_ROOT, 'dist', info.dirName, info.binaryName);
  }
  options.target = target;
  return { target, info };
}

function printHelp() {
  console.log(`duckai-cpa 多平台单文件二进制构建脚本

用法:
  node scripts/build-exe.mjs [选项]
  bun  scripts/build-exe.mjs [选项]     # 需要 Bun >= 1.4.4

选项:
  --target=<bun-target>  构建目标（默认=当前构建机）：
                           bun-windows-x64       Windows x64
                           bun-linux-x64         Linux x64（glibc：Debian/Ubuntu）
                           bun-linux-arm64       Linux arm64（glibc）
                           bun-linux-x64-musl    Linux x64（musl：Alpine 极简镜像）
                           bun-linux-arm64-musl  Linux arm64（musl）
                           bun-darwin-x64        macOS x64（Intel）
                           bun-darwin-arm64      macOS arm64（Apple Silicon）
  --skip-web-build    跳过 web/ 产物检查（CI 中已单独执行 npm run build:web）
  --force-web-build   强制重新执行 npm run build:web
  --skip-trim         不传 --trim（产物更大；仅排障用）
  --no-assets         不嵌入 web/、config/、package.json（仅调试用）
  --outfile=<path>    自定义输出路径（默认 dist/<target>/duckai-cpa[.exe]）
  -h, --help          显示本帮助

环境变量:
  BUN_BIN             指定 Bun 可执行文件（必须 >= 1.4.4）

示例:
  node scripts/build-exe.mjs                                  # 当前平台
  node scripts/build-exe.mjs --target=bun-linux-x64           # Linux x64（glibc）
  node scripts/build-exe.mjs --target=bun-linux-x64-musl      # Alpine 镜像用
  node scripts/build-exe.mjs --target=bun-darwin-arm64        # macOS Apple Silicon
  node scripts/build-exe.mjs --skip-web-build
  $env:BUN_BIN = "C:\\\\bun\\\\bun.exe"; npm run build:bin
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

/** 内联 jsdom 默认样式表 + 延迟解析同步 XHR worker（Bun 打包后无构建机路径）。 */
function applyJsdomPatches() {
  applyJsdomStylesheetPatch();
  applyJsdomXhrPatch();
  applyCssTreeDataPatch();
}

/**
 * css-tree/lib/data.js：createRequire(import.meta.url) → 静态 JSON import。
 * 否则编译后在别的机器/平台会报 "Cannot find module 'mdn-data/css/at-rules.json'"。
 */
function applyCssTreeDataPatch() {
  const { label, file, marker } = CSS_TREE_DATA_PATCH;
  if (!fs.existsSync(file)) {
    warn(`${label} 不存在（css-tree 未安装或目录结构变化），跳过`);
    return;
  }
  const current = readTextFileSafe(file);
  if (current.includes(marker)) {
    info(`${label}: 已是静态 JSON import，跳过`);
    return;
  }
  const pattern =
    /import \{ createRequire \} from 'module';\r?\nimport patch from '\.\/data-patch\.js';\r?\n\r?\nconst require = createRequire\(import\.meta\.url\);\r?\nconst mdnAtrules = require\('mdn-data\/css\/at-rules\.json'\);\r?\nconst mdnProperties = require\('mdn-data\/css\/properties\.json'\);\r?\nconst mdnSyntaxes = require\('mdn-data\/css\/syntaxes\.json'\);/;
  if (!pattern.test(current)) {
    throw new Error(
      `${label} 的结构与预期不符（css-tree 版本变化？），无法应用 mdn-data 静态 import 补丁；请更新 scripts/build-exe.mjs`
    );
  }
  const replacement = [
    "import patch from './data-patch.js';",
    "import mdnAtrules from 'mdn-data/css/at-rules.json' with { type: 'json' };",
    "import mdnProperties from 'mdn-data/css/properties.json' with { type: 'json' };",
    "import mdnSyntaxes from 'mdn-data/css/syntaxes.json' with { type: 'json' };"
  ].join('\n');
  fs.writeFileSync(file, current.replace(pattern, replacement), 'utf8');
  info(`${label}: 已改为静态 JSON import（避免 createRequire 在编译后找不到 mdn-data）`);
}

/**
 * jsdom 的 XMLHttpRequest-impl.js 在模块顶层调用 `require.resolve("./xhr-sync-worker.js")`；
 * Bun --compile 会把它固化为构建机绝对路径，运行时启动即报 "Cannot find package ..."。
 * 改为懒解析：只有真正使用同步 XHR 时才尝试解析/启动 worker（duck.ai 挑战不使用同步 XHR）。
 */
function applyJsdomXhrPatch() {
  const file = JSDOM_XHR_PATCH.file;
  const { label } = JSDOM_XHR_PATCH;
  if (!fs.existsSync(file)) {
    warn(`${label} 不存在（jsdom 未安装或目录结构变化），跳过`);
    return;
  }
  const current = readTextFileSafe(file);
  if (current.includes('duckai-cpa: lazy sync worker')) {
    info(`${label}: 已是懒解析补丁，跳过`);
    return;
  }
  const markerLine = 'const syncWorkerFile = require.resolve("./xhr-sync-worker.js");';
  if (!current.includes(markerLine) || !current.includes('new Worker(syncWorkerFile)')) {
    throw new Error(
      `${label} 的结构与预期不符（jsdom 版本变化？），无法应用同步 XHR worker 补丁；请更新 scripts/build-exe.mjs`
    );
  }
  const replacement = `// duckai-cpa: lazy sync worker (Bun --compile would inline the build machine path)
let syncWorkerFile = null;
function resolveSyncWorkerFile() {
  if (syncWorkerFile === null) {
    syncWorkerFile = require.resolve("./xhr-sync-worker.js");
  }
  return syncWorkerFile;
}`;
  let next = current.replace(markerLine, replacement);
  if (!next.includes('duckai-cpa: lazy sync worker')) {
    throw new Error(`${label}: 同步 XHR worker 补丁写入失败`);
  }
  next = next.replace('new Worker(syncWorkerFile)', 'new Worker(resolveSyncWorkerFile())');
  if (!next.includes('new Worker(resolveSyncWorkerFile())')) {
    throw new Error(`${label}: getSyncWorker() 替换失败`);
  }
  fs.writeFileSync(file, next, 'utf8');
  info(`${label}: 已改为懒解析同步 XHR worker（避免构建机路径在别的机器 ENOENT）`);
}
/**
 * 内联 jsdom 的默认样式表：Bun 会把 CJS `__dirname` 内联为构建机绝对路径，
 * 换机器/换平台运行会 ENOENT。内联后二进制不再依赖构建机的 node_modules 路径。
 */
function applyJsdomStylesheetPatch() {
  const { label, file, cssFile } = JSDOM_STYLESHEET_PATCH;
  if (!fs.existsSync(file)) {
    warn(`${label} 不存在（jsdom 未安装或目录结构变化），跳过；否则二进制在别的机器可能启动失败。`);
    return;
  }
  const current = readTextFileSafe(file);
  if (current.includes('duckai-cpa: embed default-stylesheet')) {
    info(`${label}: 已是内联内容，跳过`);
    return;
  }
  let css;
  try {
    css = fs.readFileSync(cssFile, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 jsdom 默认样式表 ${cssFile}: ${error.message}`);
  }
  const pattern =
    /const defaultStyleSheet = fs\.readFileSync\(\r?\n\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\r?\n\s*\{ encoding: "utf-8" \}\r?\n\);/;
  if (!pattern.test(current)) {
    throw new Error(
      `${label} 的结构与预期不符（jsdom 版本变化？），无法内联 default-stylesheet.css；请更新 scripts/build-exe.mjs 的补丁`
    );
  }
  const replacement =
    '// duckai-cpa: embed default-stylesheet (Bun --compile inlines __dirname to the build machine path)\n' +
    `const defaultStyleSheet = ${JSON.stringify(css)};`;
  fs.writeFileSync(file, current.replace(pattern, replacement), 'utf8');
  info(`${label}: 已内联 default-stylesheet.css（移除构建机 __dirname 依赖）`);
}

/* ------------------------------------------------------------------ */
/* bun build                                                            */
/* ------------------------------------------------------------------ */

const toPosix = (value) => value.split(path.sep).join('/');

function buildBunArgs(packageJson, options, targetInfo) {
  const args = ['build', DEFAULT_ENTRY, '--compile'];
  if (!options.skipTrim) args.push('--trim');
  args.push(`--target=${options.target}`);
  if (!options.noAssets) {
    args.push('--asset=web', '--asset=config', '--asset=package.json');
  }
  args.push(`--outfile=${toPosix(path.relative(PROJECT_ROOT, options.outfile))}`);
  // Windows 专属 PE 元数据；Linux/macOS 目标不传这些参数。
  // 保留控制台（不加 --windows-hide-console）：首次启动需要打印 adminToken / API Key。
  if (targetInfo.platform === 'win32') {
    args.push('--windows-title', WINDOWS_TITLE);
    args.push('--windows-publisher', WINDOWS_PUBLISHER);
    args.push('--windows-version', toWindowsVersion(packageJson.version));
    args.push('--windows-description', WINDOWS_DESCRIPTION);
  }
  return args;
}

/** 读取文件头用于校验产物格式。 */
function readMagicBytes(file, length = 4) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

const BINARY_MAGICS = Object.freeze({
  win32: [[0x4d, 0x5a]], // MZ
  linux: [[0x7f, 0x45, 0x4c, 0x46]], // \x7fELF
  darwin: [
    [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit LE
    [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit LE
    [0xca, 0xfe, 0xba, 0xbe] // Mach-O universal (fat)
  ]
});

function assertBinaryFormat(outfile, targetInfo) {
  const magic = readMagicBytes(outfile, 4);
  const expected = BINARY_MAGICS[targetInfo.platform] || [];
  const ok = expected.some((sig) => sig.length <= magic.length && sig.every((byte, index) => magic[index] === byte));
  if (!ok) {
    throw new Error(
      `产物格式与目标不符（${targetInfo.label}，文件头 ${magic.toString('hex')}）；Bun 可能回退到了本机平台`
    );
  }
  return magic;
}

/** 生成随二进制分发的 RUN-README.txt。 */
function writeRunReadme(outfile, targetInfo) {
  const readmePath = path.join(path.dirname(outfile), 'RUN-README.txt');
  const runLine =
    targetInfo.platform === 'win32'
      ? 'Windows: 双击 duckai-cpa.exe（或在 PowerShell 执行 .\\duckai-cpa.exe）'
      : 'Linux/macOS: chmod +x duckai-cpa && ./duckai-cpa';
  const runtimeNote =
    targetInfo.platform === 'win32'
      ? '- 未签名单文件，Windows SmartScreen 可能提示「更多信息 → 仍要运行」。'
      : targetInfo.platform === 'darwin'
        ? '- 未签名二进制：首次运行如被 Gatekeeper 拦截，可右键打开或用 `xattr -d com.apple.quarantine ./duckai-cpa`。'
        : targetInfo.dirName.endsWith('-musl')
          ? '- musl 目标：用于 Alpine 等 musl 环境（极简镜像）。'
          : '- glibc 目标：用于 Debian/Ubuntu 等 glibc 环境（Alpine 请用 musl 目标）。';
  const content = `DuckAI CPA — ${targetInfo.label} 单文件版

运行:
  ${runLine}
  首次启动会在二进制同目录生成 data/config.json，并打印 adminToken 与默认 API Key。

地址:
  管理后台:   http://127.0.0.1:8787/admin/
  OpenAI 兼容: http://127.0.0.1:8787/v1
  健康检查:   http://127.0.0.1:8787/healthz

环境变量:
  DUCKAI_CPA_DATA_DIR      数据目录（默认 <二进制所在目录>/data）
  DUCKAI_CPA_CONFIG_PATH   配置文件路径（默认 <数据目录>/config.json）
  DUCKAI_CPA_HOST          监听地址（默认 127.0.0.1）
  DUCKAI_CPA_PORT          监听端口（默认 8787）
  DUCKAI_CPA_ADMIN_TOKEN   覆盖管理后台 token

说明:
${runtimeNote}
  - 数据目录含 adminToken / API Key，请勿提交或外传。
  - 构建与排障见仓库 docs/BINARY-BUILDS.md。
`;
  fs.writeFileSync(readmePath, content, 'utf8');
  info(`已写入说明文件：${readmePath}`);
}

function verifyOutput(outfile, elapsedMs, targetInfo) {
  let stat;
  try {
    stat = fs.statSync(outfile);
  } catch {
    throw new Error(`构建命令已结束，但产物不存在：${outfile}`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`产物无效（不是文件或大小为 0）：${outfile}`);
  }
  assertBinaryFormat(outfile, targetInfo);
  const megabytes = stat.size / 1000 / 1000;
  info(`产物路径：${paint(GREEN, outfile)}`);
  info(`产物大小：${megabytes.toFixed(1)} MB（${stat.size.toLocaleString('en-US')} 字节）`);
  info(`构建耗时：${(elapsedMs / 1000).toFixed(1)} 秒`);
  writeRunReadme(outfile, targetInfo);
  return stat;
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

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  info(paint(CYAN, 'duckai-cpa 多平台单文件二进制构建'));
  info(paint(DIM, `仓库根: ${PROJECT_ROOT}`));

  step(1, 4, '检查构建环境');
  const packageJson = readPackageJson();
  const { target, info: targetInfo } = resolveTarget(options);
  const hostTarget = defaultTargetForHost();
  if (hostTarget && target !== hostTarget) {
    warn(
      `交叉编译：目标 ${target}（${targetInfo.label}），当前构建机默认目标是 ${hostTarget}；` +
        '产物无法在本机直接运行，请用目标平台或 CI 做运行验证。'
    );
  }
  const bun = resolveBun();
  info(`Bun: ${bun.command}（版本 ${bun.rawVersion}，来源: ${bun.source}）`);
  info(`目标: ${targetInfo.label}（${target}）`);
  info(`输出: ${options.outfile}`);
  if (targetInfo.platform === 'win32') {
    info(`Windows 版本号: ${toWindowsVersion(packageJson.version)}（package.json version=${packageJson.version ?? '未设置'}）`);
  }

  step(2, 4, '检查管理后台产物（web/）');
  await ensureWebAssets(options);

  step(3, 4, '应用 node_modules 补丁（Bun 打包/跨机器兼容，幂等）');
  applyNodeModulesPatches();
  applyJsdomPatches();

  step(4, 4, '编译并校验可执行文件');
  fs.mkdirSync(path.dirname(options.outfile), { recursive: true });
  const args = buildBunArgs(packageJson, options, targetInfo);
  if (options.skipTrim) warn('--skip-trim：产物会明显变大。');
  if (options.noAssets) {
    warn(
      '--no-assets：产物将不包含 web/、config/、package.json，运行时缺少管理后台与默认配置（仅调试用）。'
    );
  }
  const elapsedMs = await runBunBuild(bun.command, args);
  verifyOutput(options.outfile, elapsedMs, targetInfo);

  info('');
  info(paint(GREEN, '构建成功。'));
  info(`可直接分发：${options.outfile}`);
  info(`同目录说明文件：${path.join(path.dirname(options.outfile), 'RUN-README.txt')}`);
}

main().catch((error) => {
  console.error('');
  console.error(paint(RED, `构建失败: ${error.message}`));
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
