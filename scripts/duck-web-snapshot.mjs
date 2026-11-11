/**
 * duck.ai web source snapshot helpers.
 *
 * 设计目标：
 * - 只在本地 `recon/` 生成快照（recon/ 已被 .gitignore 忽略）；
 * - 从入口 HTML 开始，递归抓取同源 JS/CSS 及其引用的静态资源；
 * - 保存 manifest（URL / 本地路径 / sha256 / size / content-type）；
 * - compare 只读取/抓取线上版本并与 baseline manifest 比对，不写 baseline。
 *
 * 这不是绕过任何访问控制：只请求公开静态资源，顺序抓取并带延迟。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProxyAgent } from 'undici';

export const DEFAULT_BASE_URL = 'https://duck.ai/';
export const DEFAULT_OUT_DIR = 'recon/duckai-web';
export const DEFAULT_MANIFEST = path.join(DEFAULT_OUT_DIR, 'manifest.json');
export const DEFAULT_MAX_ASSETS = 500;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseUrl: process.env.DUCKAI_RECON_BASE_URL || DEFAULT_BASE_URL,
    outDir: process.env.DUCKAI_RECON_OUT || DEFAULT_OUT_DIR,
    manifest: null,
    proxy: undefined,
    noProxy: false,
    maxAssets: DEFAULT_MAX_ASSETS,
    maxBytes: DEFAULT_MAX_BYTES,
    delayMs: 100,
    timeoutMs: 30000,
    includeExternal: false,
    tolerant: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--base-url') options.baseUrl = take();
    else if (arg === '--out') options.outDir = take();
    else if (arg === '--manifest') options.manifest = take();
    else if (arg === '--proxy') options.proxy = take();
    else if (arg === '--no-proxy') options.noProxy = true;
    else if (arg === '--max-assets') options.maxAssets = Math.max(1, Math.trunc(Number(take())));
    else if (arg === '--max-bytes') options.maxBytes = Math.max(1024, Math.trunc(Number(take())));
    else if (arg === '--delay-ms') options.delayMs = Math.max(0, Math.trunc(Number(take())));
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(1000, Math.trunc(Number(take())));
    else if (arg === '--include-external') options.includeExternal = true;
    else if (arg === '--tolerant') options.tolerant = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.baseUrl = String(options.baseUrl);
  options.manifest = options.manifest || path.join(options.outDir, 'manifest.json');
  return options;
}

export function resolveProxy(options = {}) {
  if (options.noProxy) return null;
  if (options.proxy) return String(options.proxy);
  return (
    process.env.DUCKAI_RECON_PROXY ||
    process.env.DUCKAI_CPA_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

export function createFetcher(options = {}) {
  const proxy = resolveProxy(options);
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const timeoutMs = options.timeoutMs || 30000;
  return async function fetchAsset(url) {
    const response = await fetch(url, {
      redirect: 'follow',
      dispatcher,
      headers: {
        'user-agent': process.env.DUCKAI_CPA_USER_AGENT || DEFAULT_UA,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      url: response.url || url,
      status: response.status,
      ok: response.ok,
      contentType: String(response.headers.get('content-type') || ''),
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null,
      buffer
    };
  };
}

function normalizeUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function safeRelativePath(url) {
  const parsed = new URL(url);
  let pathname = parsed.pathname || '/';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_') || '_');
  let relative = path.join(parsed.hostname, ...segments);
  if (parsed.search) {
    const suffix = sha256(Buffer.from(parsed.search)).slice(0, 8);
    const ext = path.extname(relative);
    relative = `${relative.slice(0, relative.length - ext.length)}.${suffix}${ext}`;
  }
  return relative;
}

function extractHtmlRefs(html, baseUrl) {
  const refs = [];
  const add = (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (url) refs.push(url.href);
  };
  for (const match of html.matchAll(/<(script|link|img|source|video|audio)[^>]*?\s(?:src|href)=["']([^"']+)["']/gi)) {
    add(match[2]);
  }
  // <link rel="modulepreload" href="..."> 已在上面覆盖；这里兜底所有 href/src 属性。
  for (const match of html.matchAll(/\s(?:src|href)=["']([^"']+\.(?:js|mjs|css|png|jpg|jpeg|webp|svg|woff2?|json)(?:[?#][^"']*)?)["']/gi)) {
    add(match[1]);
  }
  return refs;
}

function extractScriptRefs(text, baseUrl) {
  const refs = [];
  const add = (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (url) refs.push(url.href);
  };
  const patterns = [
    /(?:^|[^\w$])(?:import|export)\s+(?:[^'"`]+?\s+from\s+)?["']([^"']+)["']/g,
    /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /sourceMappingURL=([^\s*]+)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) add(match[1]);
  }
  return refs;
}

function extractCssRefs(text, baseUrl) {
  const refs = [];
  for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url) refs.push(url.href);
  }
  return refs;
}

function isCrawlableText(contentType, url) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('javascript') || type.includes('ecmascript')) return 'js';
  if (type.includes('text/css')) return 'css';
  if (type.includes('text/html')) return 'html';
  if (/\.(?:m?js)(?:[?#]|$)/i.test(url)) return 'js';
  if (/\.css(?:[?#]|$)/i.test(url)) return 'css';
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 抓取线上快照。
 * @param {ReturnType<typeof parseArgs>} options
 * @param {{write?: boolean}} [mode]
 */
export async function takeSnapshot(options = {}, mode = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const base = new URL(baseUrl);
  const fetcher = createFetcher(options);
  const assets = [];
  const bodies = new Map();
  const seen = new Set();
  const queue = [];
  const skippedExternal = [];
  let totalBytes = 0;

  const enqueue = (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (!url) return;
    if (url.href === base.href || url.href === base.href.replace(/\/$/, '')) return;
    if (!options.includeExternal && url.origin !== base.origin) {
      if (!skippedExternal.includes(url.href)) skippedExternal.push(url.href);
      return;
    }
    if (seen.has(url.href)) return;
    seen.add(url.href);
    queue.push(url.href);
  };

  const htmlUrl = base.href;
  seen.add(htmlUrl);
  const html = await fetcher(htmlUrl);
  if (!html.ok) {
    throw new Error(`fetch entry failed: HTTP ${html.status} ${htmlUrl}`);
  }
  totalBytes += html.buffer.length;
  const htmlRecord = {
    url: html.url,
    localPath: safeRelativePath(html.url),
    status: html.status,
    contentType: html.contentType,
    etag: html.etag,
    lastModified: html.lastModified,
    size: html.buffer.length,
    sha256: sha256(html.buffer)
  };
  assets.push(htmlRecord);
  bodies.set(htmlRecord.url, html.buffer);
  const htmlText = html.buffer.toString('utf8');
  for (const ref of extractHtmlRefs(htmlText, html.url)) enqueue(ref);
  for (const match of htmlText.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc=/i.test(match[0])) {
      for (const ref of extractScriptRefs(match[1], html.url)) enqueue(ref);
    }
  }
  const versionMatch = htmlText.match(/data-version=["']([^"']+)["']/i) || htmlText.match(/version["']?\s*[:=]\s*["']([0-9a-f]{8,})["']/i);

  while (queue.length && assets.length < options.maxAssets) {
    const url = queue.shift();
    let response;
    try {
      response = await fetcher(url);
    } catch (error) {
      if (!options.tolerant) throw new Error(`fetch asset failed: ${url}: ${error.message}`);
      assets.push({ url, status: 0, error: error.message, size: 0, sha256: null });
      continue;
    }
    if (!response.ok && !options.tolerant) {
      throw new Error(`fetch asset failed: HTTP ${response.status} ${url}`);
    }
    if (response.buffer.length > options.maxBytes) {
      if (!options.tolerant) throw new Error(`asset too large: ${url} (${response.buffer.length} bytes)`);
      assets.push({ url: response.url, status: response.status, contentType: response.contentType, size: response.buffer.length, sha256: null, skipped: 'too_large' });
      continue;
    }
    totalBytes += response.buffer.length;
    const record = {
      url: response.url,
      localPath: safeRelativePath(response.url),
      status: response.status,
      contentType: response.contentType,
      etag: response.etag,
      lastModified: response.lastModified,
      size: response.buffer.length,
      sha256: sha256(response.buffer)
    };
    assets.push(record);
    bodies.set(record.url, response.buffer);
    const kind = isCrawlableText(response.contentType, response.url);
    if (kind) {
      const text = response.buffer.toString('utf8');
      const refs =
        kind === 'html'
          ? extractHtmlRefs(text, response.url)
          : kind === 'css'
            ? extractCssRefs(text, response.url)
            : extractScriptRefs(text, response.url);
      for (const ref of refs) enqueue(ref);
    }
    if (options.delayMs) await sleep(options.delayMs);
  }

  const manifest = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    baseUrl,
    version: versionMatch ? versionMatch[1] : null,
    html: htmlRecord,
    assets,
    skippedExternal,
    totalBytes,
    truncated: queue.length > 0
  };

  if (mode.write) {
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    await fs.mkdir(outDir, { recursive: true });
    // 清空旧快照，避免删除的线上文件残留在 baseline 中。
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });
    for (const asset of assets) {
      if (!asset.localPath || !asset.sha256) continue;
      const destination = path.resolve(outDir, asset.localPath);
      if (!destination.startsWith(path.resolve(outDir) + path.sep)) {
        throw new Error(`unsafe local path: ${asset.localPath}`);
      }
      const body = bodies.get(asset.url);
      if (!body) continue;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, body);
    }
    const manifestPath = options.manifest || path.join(outDir, 'manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    manifest.manifestPath = manifestPath;
    manifest.outDir = outDir;
  }

  return manifest;
}

export function compareManifests(baseline, current) {
  const baselineAssets = new Map((baseline.assets || []).map((asset) => [asset.url, asset]));
  const currentAssets = new Map((current.assets || []).map((asset) => [asset.url, asset]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [url, asset] of currentAssets) {
    const old = baselineAssets.get(url);
    if (!old) added.push(asset);
    else if (old.sha256 !== asset.sha256 || old.status !== asset.status) changed.push({ ...asset, previous: old });
  }
  for (const [url, asset] of baselineAssets) {
    if (!currentAssets.has(url)) removed.push(asset);
  }
  return {
    same: !added.length && !removed.length && !changed.length && baseline.html?.sha256 === current.html?.sha256,
    versionChanged: baseline.version !== current.version,
    baselineVersion: baseline.version || null,
    currentVersion: current.version || null,
    added,
    removed,
    changed,
    baselineFetchedAt: baseline.fetchedAt || null,
    currentFetchedAt: current.fetchedAt || null
  };
}

export function printHelp(name) {
  console.log(`Usage: node scripts/${name} [options]

Options:
  --base-url <url>      入口地址（默认 ${DEFAULT_BASE_URL}）
  --out <dir>           快照目录（默认 ${DEFAULT_OUT_DIR}）
  --proxy <url>         代理（默认 DUCKAI_RECON_PROXY / DUCKAI_CPA_PROXY / HTTPS_PROXY）
  --no-proxy            不使用代理
  --max-assets <n>      最多抓取资源数（默认 ${DEFAULT_MAX_ASSETS}）
  --max-bytes <n>       单个资源上限（默认 ${DEFAULT_MAX_BYTES}）
  --delay-ms <n>        请求间隔（默认 100）
  --timeout-ms <n>      单请求超时（默认 30000）
  --include-external    同时抓取第三方域名资源
  --tolerant            资源错误时继续（HTML 失败仍中止）
  --json                输出 JSON（compare）
  -h, --help            显示帮助`);
}
