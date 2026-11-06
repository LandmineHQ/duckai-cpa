/**
 * windows 平台分支（bun exe）：运行形态 / 路径检测。
 *
 * 项目有两种运行形态：
 *  1. 源码运行（Node 24 或 `bun src/index.js`）：
 *     - APP_ROOT = 仓库根目录；
 *     - 数据目录默认 `<仓库根>/data`（保持旧行为）。
 *  2. `bun build --compile` 生成的 standalone exe：
 *     - 打包后所有模块共享 `import.meta.url`，指向 exe 自身；
 *     - `--asset` 嵌入的 `web/`、`config/`、`package.json` 位于
 *       `dirname(import.meta.url)`（Bun 的只读虚拟根：Windows 形如
 *       `B:\~BUN\root`，POSIX 形如 `/$bunfs/root`）；
 *     - 虚拟根不可写，运行时数据必须落到 exe 所在目录（便携模式）：
 *       `<exeDir>/data`，可用 `DUCKAI_CPA_DATA_DIR` 覆盖。
 *
 * 本模块只做纯路径计算，不读文件、不依赖 Bun API，便于单元测试。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Bun standalone 虚拟根标记（Windows: ~BUN；POSIX: $bunfs）。 */
const STANDALONE_ROOT_PATTERN = /[\\/](?:~BUN|\$bunfs)(?:[\\/]|$)/;

/**
 * 判断某个模块目录是否位于 Bun standalone 的虚拟根内。
 * @param {string} moduleDir
 * @returns {boolean}
 */
export function detectCompiled(moduleDir) {
  if (typeof moduleDir !== 'string' || !moduleDir) return false;
  return STANDALONE_ROOT_PATTERN.test(moduleDir.replace(/^file:\/+/i, ''));
}

/**
 * 计算应用布局（可注入参数，方便测试编译形态）。
 * @param {{ moduleDir: string, execPath: string, compiled?: boolean }} input
 */
export function resolveAppLayout({ moduleDir, execPath, compiled = detectCompiled(moduleDir) }) {
  const dir = path.resolve(moduleDir);
  const appRoot = compiled ? dir : path.resolve(dir, '..');
  const exeDir = compiled ? path.dirname(path.resolve(execPath)) : appRoot;
  return {
    compiled,
    /** 只读资源根：开发时是仓库根，编译后是嵌入资源所在的虚拟根。 */
    appRoot,
    /** 可执行文件目录（开发时等于仓库根）。 */
    exeDir,
    /** 数据目录基准：开发时仓库根（旧行为），编译后为 exe 目录。 */
    dataBase: exeDir
  };
}

const LAYOUT = resolveAppLayout({ moduleDir: MODULE_DIR, execPath: process.execPath });

/** 是否运行在 bun 编译的 standalone exe 中。 */
export const IS_COMPILED = LAYOUT.compiled;

/** 只读的应用资源根（web/、config/、package.json 所在目录）。 */
export const APP_ROOT = LAYOUT.appRoot;

/** 可执行文件所在目录（开发时为仓库根）。 */
export const EXE_DIR = LAYOUT.exeDir;

/** 运行时数据目录的默认基准（`<dataBase>/data`）。 */
export const DEFAULT_DATA_BASE = LAYOUT.dataBase;

export const PLATFORM = Object.freeze({
  isCompiled: IS_COMPILED,
  appRoot: APP_ROOT,
  exeDir: EXE_DIR,
  dataBase: DEFAULT_DATA_BASE
});

export default PLATFORM;
