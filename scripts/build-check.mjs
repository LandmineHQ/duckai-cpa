#!/usr/bin/env node
/**
 * 前端构建产物完整性检查（v2，scripts/build-check.mjs）
 *
 * 校验 `npm run build:web`（Vite + React → web/）的产物是否完整、可被 /admin 直接使用：
 *   1. web/index.html 存在，含 #root 与 ESM module script；
 *   2. index.html 中所有 /admin/assets/*.js|css 引用在后端磁盘上存在且非空；
 *   3. 至少 1 个 JS + 1 个 CSS；JS 为 Vite 产物（含 hashed chunk 引用时对应文件存在）；
 *   4. 无外部 CDN（index/assets 中不出现 unpkg/jsdelivr/cdnjs/cdn 等外链）；
 *   5. 无 v1 手写残留（web/assets/app.js、web/assets/style.css 不应存在——v2 构建会 emptyOutDir）；
 *   6. webapp/vite.config.ts 的 base/outDir 与契约一致（/admin/、../web）。
 *
 * 用法:
 *   node scripts/build-check.mjs            # 只校验现有产物（CI/CI 后置检查）
 *   node scripts/build-check.mjs --build    # 先执行 npm run build:web 再校验
 *
 * 退出码: 0 全 PASS；1 有 FAIL；2 用法/构建失败。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const ASSETS_DIR = path.join(WEB_DIR, 'assets');

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

function parseArgs(argv) {
  const options = { build: false, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--build') options.build = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`前端构建产物完整性检查

用法: node scripts/build-check.mjs [--build]

选项:
  --build   先执行 npm run build:web，再校验产物
  -h        显示帮助
`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** 执行 npm run build:web（stdio inherit 以兼容沙箱：不使用管道）。 */
function runBuild() {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', 'build:web'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function extractRefs(html) {
  const refs = new Set();
  const regex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const value = match[1];
    if (value.startsWith('/admin/assets/') || value.startsWith('./assets/')) refs.add(value);
  }
  return [...refs];
}

/** 从 JS 文本中抽取 Vite 产物内部的相对 chunk 引用（./chunk-xxx.js 或 "chunk-xxx.js"）。 */
function extractJsChunkRefs(jsText) {
  const refs = new Set();
  const patterns = [
    /["']\.\/([A-Za-z0-9_.-]+\.(?:js|css))["']/g,
    /["']([A-Za-z0-9_.-]+\.(?:js|css))["']/g
  ];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(jsText)) !== null) {
      const name = match[1];
      if (/^(chunk|index|vendor|react)[A-Za-z0-9_.-]*\.(?:js|css)$/.test(name)) refs.add(name);
    }
  }
  return [...refs];
}

const EXTERNAL_CDN_RE = /(unpkg\.com|cdn\.jsdelivr\.net|jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh)/i;

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

  console.log(`duckai-cpa build-check — web dir: ${WEB_DIR}${options.build ? ' (with npm run build:web)' : ''}\n`);

  if (options.build) {
    console.log(paint(DIM, '> npm run build:web'));
    const code = await runBuild();
    if (code !== 0) {
      console.error(paint(RED, `✖ build-check 失败: npm run build:web 退出码 ${code}`));
      return 2;
    }
    console.log();
  }

  const checks = [];
  const run = async (name, fn) => {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS' });
      console.log(`${paint(GREEN, '[PASS]')} ${name.padEnd(28)} ${paint(DIM, `${Date.now() - startedAt}ms`)}  ${detail || ''}`);
    } catch (error) {
      checks.push({ name, status: 'FAIL' });
      console.log(`${paint(RED, '[FAIL]')} ${name.padEnd(28)} ${paint(DIM, `${Date.now() - startedAt}ms`)}  ${error?.message}`);
    }
  };

  let html = null;
  let refs = [];

  await run('web/index.html', async () => {
    html = await readFile(path.join(WEB_DIR, 'index.html'));
    assert(html, `缺少 ${path.join(WEB_DIR, 'index.html')}（先运行 npm run build:web）`);
    assert(html.includes('id="root"'), 'index.html 不是 React 产物（缺少 #root）');
    assert(html.includes('type="module"'), 'index.html 缺少 ESM module script');
    refs = extractRefs(html);
    assert(refs.length >= 2, `index.html 应引用 >=2 个 /admin/assets/*.js|css，实际 ${refs.length}`);
    return `${html.length} bytes, ${refs.length} refs`;
  });

  await run('引用资源完整性', async () => {
    assert(refs.length > 0, 'no refs to check');
    let js = 0;
    let css = 0;
    const details = [];
    for (const ref of refs) {
      const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
      const filePath = path.join(ASSETS_DIR, fileName);
      const size = await fileSize(filePath);
      assert(size !== null, `引用资源不存在: ${ref}`);
      assert(size > 0, `引用资源为空: ${ref}`);
      details.push(`${fileName}(${size}B)`);
      if (fileName.endsWith('.js')) js += 1;
      if (fileName.endsWith('.css')) css += 1;
    }
    assert(js >= 1, '缺少入口 JS 产物');
    assert(css >= 1, '缺少 CSS 产物');
    return details.join(', ');
  });

  await run('chunk 引用完整性', async () => {
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    let checked = 0;
    for (const ref of jsRefs) {
      const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
      const jsText = await readFile(path.join(ASSETS_DIR, fileName));
      assert(jsText, `无法读取 ${fileName}`);
      for (const chunk of extractJsChunkRefs(jsText)) {
        const size = await fileSize(path.join(ASSETS_DIR, chunk));
        assert(size !== null, `${fileName} 引用的 chunk 缺失: ${chunk}`);
        checked += 1;
      }
    }
    return `checked ${checked} chunk refs`;
  });

  await run('无外部 CDN', async () => {
    assert(html, 'index.html missing');
    assert(!EXTERNAL_CDN_RE.test(html), 'index.html 含外部 CDN 引用');
    for (const ref of refs) {
      const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
      const text = await readFile(path.join(ASSETS_DIR, fileName));
      assert(text !== null, `无法读取 ${fileName}`);
      assert(!EXTERNAL_CDN_RE.test(text), `${fileName} 含外部 CDN 引用`);
    }
    return 'no cdn references';
  });

  await run('无 v1 手写残留', async () => {
    for (const legacy of ['app.js', 'style.css']) {
      const size = await fileSize(path.join(ASSETS_DIR, legacy));
      assert(size === null, `v1 残留文件仍存在: web/assets/${legacy}（构建应 emptyOutDir）`);
    }
    return 'clean';
  });

  await run('v2.1 retry UI 文案', async () => {
    // v2.1：会话消息需有「重新生成/重试」入口，构建产物中应能 grep 到相关文案/逻辑
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const texts = [];
    for (const ref of jsRefs) {
      const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
      const jsText = await readFile(path.join(ASSETS_DIR, fileName));
      assert(jsText, `无法读取 ${fileName}`);
      texts.push(jsText);
    }
    const bundle = texts.join('\n');
    const hasChinese = /重新生成|重试/.test(bundle);
    const hasRetryLogic = /retryOf|retriedFrom|\/retry\b|retryMessage|regenerate|retry/i.test(bundle);
    assert(hasChinese || hasRetryLogic, '构建产物未包含「重新生成/重试」相关文案或逻辑');
    return `${hasChinese ? '中文文案' : ''}${hasChinese && hasRetryLogic ? ' + ' : ''}${hasRetryLogic ? 'retry 逻辑' : ''}`;
  });

  await run('v2.2 身份页文案', async () => {
    // v2.2：侧边栏/页面需有「身份 / Sync & Backup / 订阅」入口与文案
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '身份', re: /身份/ },
      { label: 'Sync/备份', re: /Sync|同步|备份/ },
      { label: '订阅', re: /订阅|DuckDuckGo Plus|subscription/i },
      { label: 'identity API', re: /\/admin\/api\/identity|\/identity\b/i }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少身份页文案/逻辑: ${missing.join(', ')}`);
    return '身份 + Sync/备份 + 订阅 文案/逻辑';
  });

  await run('v2.3 代理页文案', async () => {
    // v2.3：侧边栏/页面需有「代理」入口与 HTTP/SOCKS/出口 IP/noProxy 等文案
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '代理', re: /代理|Proxy/i },
      { label: 'HTTP/HTTPS', re: /HTTP(S)?/i },
      { label: 'SOCKS', re: /SOCKS(4|5)?/i },
      { label: '出口 IP', re: /出口\s*IP|exit\s*ip/i },
      { label: 'noProxy', re: /noProxy|不走代理|跳过代理/i },
      { label: 'proxy API', re: /\/admin\/api\/proxy|\/proxy\/test/i }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少代理页文案/逻辑: ${missing.join(', ')}`);
    return '代理 + HTTP/SOCKS + 出口 IP + noProxy 文案/逻辑';
  });

  await run('v2.4 身份池/二维码文案', async () => {
    // v2.4：身份池页 + 身份页二维码（扫码配对）、identities API、路由/绑定信息
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '身份池', re: /身份池|identity\s*pool/i },
      { label: '二维码/扫码', re: /二维码|扫码|扫描|qr\s*code/i },
      { label: 'identities API', re: /\/identities/i },
      { label: '绑定/路由', re: /bindings|routing|绑定|路由/i },
      { label: 'QR 生成', re: /toDataURL|data:image\/png|qrcode/i }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少身份池/二维码文案或逻辑: ${missing.join(', ')}`);
    return '身份池 + 二维码/扫码 + identities API + 绑定/路由';
  });

  await run('v2.5 并发/配对文案', async () => {
    // v2.5：会话并发（每会话独立流/生成中徽章/同会话忙提示）+ 扫码配对（主机握手/官方恢复码）
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '生成中徽章', re: /生成中/ },
      { label: '同会话忙提示', re: /该会话正在生成中|session_busy/ },
      { label: '并发/流式', re: /并发|streaming|流式/i },
      { label: '配对/扫码', re: /配对|扫码/i },
      { label: 'pairing API', re: /\/sync\/pairing|\/official-recovery-code/i },
      { label: '停止生成', re: /停止/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少并发/配对文案或逻辑: ${missing.join(', ')}`);
    return '生成中 + 同会话忙 + 并发流式 + 配对/扫码 + pairing API';
  });

  await run('v2.8 设备列表/轮换警告文案', async () => {
    // v2.8：DuckDuckGo 服务端设备列表（注册/删除/本机）+ 设备名称 + 轮换二次确认（不可恢复/身份丢失）
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '设备列表', re: /设备列表/ },
      { label: '注册本机/注册设备', re: /注册本机|注册设备|注册到 DuckDuckGo/i },
      { label: 'My Devices/设备同步文案', re: /My Devices/i },
      { label: 'DuckCPA 设备名', re: /DuckCPA@/ },
      { label: '设备名称', re: /设备名称/ },
      { label: 'server-devices/register-device API', re: /\/sync\/server-devices|\/sync\/register-device/ },
      { label: '轮换警告（不可恢复）', re: /不可恢复/ },
      { label: '身份丢失提示', re: /身份.*丢失/ },
      { label: '两次确认', re: /第 1 \/ 2 步|两次确认|二次确认/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少设备/轮换文案或逻辑: ${missing.join(', ')}`);
    return '设备列表 + 注册/删除 + 设备名称 + server-devices API + 不可恢复/身份丢失 + 两步确认';
  });

  await run('v2.9 设备名/设备槽文案', async () => {
    // v2.9：每身份设备名（DuckAI@main / DuckCPA@） + 设备槽两栏拖拽（待加入/已注册/未保存/保存/429）
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '设备名称列', re: /设备名称/ },
      { label: '默认身份不可删除', re: /默认 · 不可删除|默认身份不可删除/ },
      { label: '身份池设备/设备槽', re: /身份池设备|设备槽/ },
      { label: '拖拽', re: /拖拽/ },
      { label: '待加入/已注册', re: /待加入|已注册/ },
      { label: 'DuckAI@main', re: /DuckAI@main/ },
      { label: '未保存提示', re: /有未保存更改|未保存/ },
      { label: '保存设备槽位', re: /保存设备槽位/ },
      { label: '限流文案', re: /限流中/ },
      { label: 'device-slots API', re: /\/sync\/device-slots/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少设备名/设备槽文案或逻辑: ${missing.join(', ')}`);
    return '设备名称 + 默认不可删除 + 设备槽拖拽 + 待加入/已注册 + DuckAI@main + 未保存/保存 + 限流';
  });

  await run('v2.10 删除保护/孤儿文案', async () => {
    // v2.10：设备列表独立卡片 + 删除 409 弹窗（先去移除/force）+ 孤儿清理提示
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '设备列表独立卡片', re: /ddg-device-list-card|DuckDuckGo 设备列表/ },
      { label: '409 冲突弹窗', re: /该身份正在设备列表中|identity_in_device_slots/ },
      { label: '先去设备列表移除', re: /先去设备列表移除/ },
      { label: 'force 删除', re: /移除设备并删除（force）|强制删除并注销设备/ },
      { label: '孤儿提示', re: /已失效身份的设备/ },
      { label: '孤儿清理', re: /清理失效设备/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, `构建产物缺少删除保护/孤儿文案或逻辑: ${missing.join(', ')}`);
    return '设备列表卡片 + 409 弹窗 + force + 孤儿提示/清理';
  });

  await run('v2.11 compact/上下文/恢复码文案', async () => {
    // v2.11：模型上下文行 + compact（按钮/摘要/自动压缩） + 官方恢复码完整展示/二维码
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '上下文约/估算 tokens', re: /上下文约|估算 tokens/ },
      { label: '压缩会话按钮', re: /压缩会话|compact-session/ },
      { label: '会话摘要/已压缩', re: /会话摘要|已压缩/ },
      { label: '自动压缩提示', re: /自动压缩|上下文已压缩/ },
      { label: '复制摘要', re: /复制摘要/ },
      { label: '官方恢复码完整展示', re: /official-recovery-code-full|复制官方恢复码/ },
      { label: '扫描恢复码/二维码', re: /扫描恢复码|查看恢复码二维码/ },
      { label: '下载恢复码二维码', re: /下载恢复码二维码 PNG/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, '构建产物缺少 v2.11 文案或逻辑: ' + missing.join(', '));
    return '上下文约 + 压缩会话 + 摘要徽章 + 自动压缩 + 官方恢复码/二维码';
  });

  await run('v2.12 摘要折叠块/压缩能力文案', async () => {
    // v2.12：摘要折叠块（展开/编辑/清除/复制） + 模型压缩能力标识（支持/不支持自动压缩）
    assert(refs.length > 0, 'no refs');
    const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
    const bundle = (
      await Promise.all(
        jsRefs.map(async (ref) => {
          const fileName = ref.replace(/^\/admin\/assets\//, '').replace(/^\.\/assets\//, '');
          return (await readFile(path.join(ASSETS_DIR, fileName))) || '';
        })
      )
    ).join('\n');
    const checks = [
      { label: '上下文摘要', re: /上下文摘要/ },
      { label: '展开/收起摘要', re: /展开摘要|收起摘要/ },
      { label: '编辑摘要', re: /编辑摘要/ },
      { label: '清除压缩', re: /清除压缩/ },
      { label: '复制摘要', re: /复制摘要/ },
      { label: '支持自动压缩', re: /支持自动压缩/ },
      { label: '不支持自动压缩', re: /不支持自动压缩/ },
      { label: '摘要折叠块 testid', re: /summary-card|summary-card-toggle/ }
    ];
    const missing = checks.filter((check) => !check.re.test(bundle)).map((check) => check.label);
    assert(missing.length === 0, '构建产物缺少 v2.12 摘要/压缩能力文案: ' + missing.join(', '));
    return '上下文摘要 + 展开/编辑/清除 + 支持/不支持自动压缩';
  });

  await run('vite 配置契约', async () => {
    const config = await readFile(path.join(PROJECT_ROOT, 'webapp', 'vite.config.ts'));
    assert(config, '缺少 webapp/vite.config.ts');
    assert(/base\s*:\s*["']\/admin\/["']/.test(config), 'vite base 必须为 "/admin/"');
    // 允许 `outDir: "../web"` 或 `outDir: path.resolve(rootDir, '../web')`
    assert(
      /outDir\s*:\s*(?:["']\.\.\/web["']|path\.resolve\([^)]*\.\.\/web[^)]*\))/.test(config),
      'vite outDir 必须指向 "../web"'
    );
    return 'base=/admin/ outDir=../web';
  });

  const failed = checks.filter((check) => check.status === 'FAIL').length;
  const passed = checks.length - failed;
  console.log();
  if (failed === 0) {
    console.log(paint(GREEN, `✔ build-check 通过: ${passed} passed, 0 failed`));
    return 0;
  }
  console.log(paint(RED, `✖ build-check 失败: ${passed} passed, ${failed} failed`));
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
