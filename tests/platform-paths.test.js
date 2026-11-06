/**
 * windows 平台分支（bun exe）：编译态路径解析单测。
 *
 * 覆盖：
 *  - `detectCompiled()` 能识别 Bun standalone 虚拟根（Windows `~BUN` / POSIX `$bunfs`）；
 *  - `resolveAppLayout()` 在源码运行与编译 exe 两种形态下的 APP_ROOT/EXE_DIR/dataBase；
 *  - `resolvePaths()` 保持源码运行旧行为，并支持编译 exe 的数据目录基准（exe 目录）；
 *  - DUCKAI_CPA_DATA_DIR / DUCKAI_CPA_CONFIG_PATH 的相对/绝对路径语义。
 *
 * 这里不启动 exe、不做真实 bun 编译（由 scripts/verify-exe.mjs / QA 实机验证覆盖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  detectCompiled,
  resolveAppLayout,
  IS_COMPILED,
  APP_ROOT,
  EXE_DIR,
  DEFAULT_DATA_BASE,
  PLATFORM
} from '../src/platform.js';
import { PROJECT_ROOT, resolvePaths } from '../src/config.js';

const CWD = path.resolve(process.cwd());
const FS_ROOT = path.parse(CWD).root;
const VIRTUAL_ROOT = path.join(FS_ROOT, '~BUN', 'root');
const FAKE_EXE = path.join(CWD, 'dist', 'windows-x64', 'duckai-cpa.exe');

test('detectCompiled：识别 bun standalone 虚拟根', () => {
  assert.equal(detectCompiled(VIRTUAL_ROOT), true, 'Windows ~BUN 虚拟根应判定为编译态');
  assert.equal(detectCompiled('/$bunfs/root'), true, 'POSIX $bunfs 虚拟根应判定为编译态');
  assert.equal(detectCompiled(path.join(CWD, 'src')), false, '普通源码目录不应判定为编译态');
  assert.equal(detectCompiled(''), false);
  assert.equal(detectCompiled(null), false);
});

test('resolveAppLayout：源码运行保持仓库根布局', () => {
  const layout = resolveAppLayout({
    moduleDir: path.join(CWD, 'src'),
    execPath: path.join(CWD, 'node.exe'),
    compiled: false
  });
  assert.equal(layout.compiled, false);
  assert.equal(layout.appRoot, CWD);
  assert.equal(layout.exeDir, CWD);
  assert.equal(layout.dataBase, CWD);
});

test('resolveAppLayout：编译 exe 使用虚拟根资源 + exe 目录数据', () => {
  const layout = resolveAppLayout({ moduleDir: VIRTUAL_ROOT, execPath: FAKE_EXE });
  assert.equal(layout.compiled, true);
  assert.equal(layout.appRoot, VIRTUAL_ROOT, '嵌入资源根应为虚拟根');
  assert.equal(layout.exeDir, path.dirname(FAKE_EXE), 'exe 目录应是可写数据基准');
  assert.equal(layout.dataBase, path.dirname(FAKE_EXE));
});

test('platform 常量：Node 测试进程为源码形态', () => {
  assert.equal(IS_COMPILED, false);
  assert.equal(APP_ROOT, PROJECT_ROOT, '源码运行时 PROJECT_ROOT 与 APP_ROOT 一致');
  assert.equal(EXE_DIR, CWD);
  assert.equal(DEFAULT_DATA_BASE, CWD);
  assert.deepEqual(PLATFORM, {
    isCompiled: false,
    appRoot: CWD,
    exeDir: CWD,
    dataBase: CWD
  });
});

test('resolvePaths：源码运行默认路径保持旧行为', () => {
  const paths = resolvePaths({});
  assert.equal(paths.rootDir, PROJECT_ROOT);
  assert.equal(paths.dataDir, path.join(PROJECT_ROOT, 'data'));
  assert.equal(paths.configPath, path.join(PROJECT_ROOT, 'data', 'config.json'));
  assert.equal(paths.examplePath, path.join(PROJECT_ROOT, 'config', 'config.example.json'));
  assert.equal(paths.webDir, path.join(PROJECT_ROOT, 'web'));
  assert.equal(paths.packagePath, path.join(PROJECT_ROOT, 'package.json'));
});

test('resolvePaths：编译 exe 的数据目录基准为 exe 目录', () => {
  const exeDir = path.dirname(FAKE_EXE);
  const paths = resolvePaths({}, VIRTUAL_ROOT, exeDir);
  assert.equal(paths.rootDir, VIRTUAL_ROOT, '只读资源根仍为虚拟根');
  assert.equal(paths.dataDir, path.join(exeDir, 'data'), '数据默认写到 exe 同目录 data/');
  assert.equal(paths.configPath, path.join(exeDir, 'data', 'config.json'));
  assert.equal(paths.examplePath, path.join(VIRTUAL_ROOT, 'config', 'config.example.json'));
  assert.equal(paths.webDir, path.join(VIRTUAL_ROOT, 'web'));
});

test('resolvePaths：DUCKAI_CPA_DATA_DIR 相对路径基于数据基准解析', () => {
  const exeDir = path.dirname(FAKE_EXE);
  const relative = resolvePaths({ DUCKAI_CPA_DATA_DIR: 'portable-data' }, VIRTUAL_ROOT, exeDir);
  assert.equal(relative.dataDir, path.join(exeDir, 'portable-data'));
  assert.equal(relative.configPath, path.join(exeDir, 'portable-data', 'config.json'));

  const absoluteDir = path.join(CWD, 'abs-data');
  const absolute = resolvePaths({ DUCKAI_CPA_DATA_DIR: absoluteDir }, VIRTUAL_ROOT, exeDir);
  assert.equal(absolute.dataDir, absoluteDir, '绝对路径不受数据基准影响');
});

test('resolvePaths：DUCKAI_CPA_CONFIG_PATH 相对路径基于数据基准解析', () => {
  const exeDir = path.dirname(FAKE_EXE);
  const paths = resolvePaths({ DUCKAI_CPA_CONFIG_PATH: 'conf/runtime.json' }, VIRTUAL_ROOT, exeDir);
  assert.equal(paths.configPath, path.join(exeDir, 'conf', 'runtime.json'));
});
