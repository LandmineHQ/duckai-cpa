/**
 * duck.ai 前端 Recon 识别与漂移判断引擎（参考 bohrium-club-auto/internal/recon/snapshot.go）。
 *
 * 能力：
 *   1. HTML 噪声归一化：剥离每次请求随机变化的 nonce / requestId / 动态时间戳后计算 SHA256；
 *   2. 代码资源聚焦：自动跳过 png/jpg/woff2/svg/map 等大体积静态媒体，只追踪 HTML/JS/CSS/JSON；
 *   3. duck.ai 契约标记识别：探测入口版本、核心端点、协议头、generated-image/tool 契约与模型目录漂移；
 *   4. 结构化 Diff：输出 markerChanges、modelChanges、targetsChanged、added/removed/changed 与中文摘要。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProxyAgent } from 'undici';
import { PROJECT_ROOT } from '../config.js';
import { DUCK_MODELS } from '../duck/models.js';

export const DEFAULT_BASE_URL = 'https://duck.ai/';
export const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'recon', 'duckai-web');
export const DEFAULT_MANIFEST = path.join(DEFAULT_OUT_DIR, 'manifest.json');
export const DEFAULT_MAX_ASSETS = 80;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const SKIPPED_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|svg|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|map)(?:[?#].*)?$/i;

const CATALOG_MODEL_IDS = DUCK_MODELS.map((m) => m.model);
const CATALOG_MODEL_SET = new Set(CATALOG_MODEL_IDS);

// 识别 bundle 中常见的最新模型 ID 模式（仅扫描高置信度命名空间）
const CANDIDATE_MODEL_RES = [
  /["'](gpt-\d(?:\.\d+)?(?:-[a-z0-9]+){1,3})["']/g,
  /["'](claude-(?:haiku|sonnet|opus)-\d(?:-\d+)?)["']/g,
  /["'](mistral-[a-z0-9-]+)["']/g,
  /["'](tinfoil\/[a-zA-Z0-9._-]+)["']/g,
  /["'](o[134]-(?:mini|pro|preview)[a-z0-9-]*)["']/g
];

const MODEL_FALSE_POSITIVES = new Set([
  'gpt-4o-mini-2024',
  'mistral-7b-v0'
]);

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 归一化入口 HTML 中的动态噪声（nonce / 随机 request id / CSP 令牌），保留版本与脚本引用。
 */
export function normalizeHtmlForHash(html) {
  return String(html || '')
    .replace(/\s+nonce=["'][^"']*["']/gi, ' nonce="__NORM__"')
    .replace(/\s+data-request-id=["'][^"']*["']/gi, ' data-request-id="__NORM__"')
    .replace(/(__DDG_NONCE__|requestId|nonce)\s*[:=]\s*["'][A-Za-z0-9+/=._-]{8,}["']/gi, '$1="__NORM__"')
    .replace(/\r\n/g, '\n');
}

export function shouldFetchAsset(url, { includeMedia = false } = {}) {
  if (includeMedia) return true;
  return !SKIPPED_EXT_RE.test(String(url || ''));
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
  if (typeof options.fetchImpl === 'function') {
    const fetchImpl = options.fetchImpl;
    const timeoutMs = options.timeoutMs || 30000;
    return async function fetchWithInjected(url) {
      const response = await fetchImpl(url, {
        redirect: 'follow',
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
        contentType: String(response.headers?.get?.('content-type') || ''),
        etag: response.headers?.get?.('etag') || null,
        lastModified: response.headers?.get?.('last-modified') || null,
        buffer
      };
    };
  }
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
  for (const match of html.matchAll(/<(script|link)[^>]*?\s(?:src|href)=["']([^"']+)["']/gi)) {
    add(match[2]);
  }
  for (const match of html.matchAll(/\s(?:src|href)=["']([^"']+\.(?:m?js|css|json)(?:[?#][^"']*)?)["']/gi)) {
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
    /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
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
    if (url && /\.(?:css|m?js|json)(?:[?#]|$)/i.test(url.href)) refs.push(url.href);
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
 * 提取 duck.ai 协议契约标记与模型目录漂移信息。
 * @param {string} htmlText
 * @param {Array<{ url: string, text: string }>} textAssets
 */
export function extractContractMarkers(htmlText, textAssets = []) {
  const versionTag = htmlText.match(/data-version-tag=["']([^"']+)["']/i)?.[1] || null;
  const versionSha = htmlText.match(/data-version-sha=["']([^"']+)["']/i)?.[1] || null;
  const legacyVersion = htmlText.match(/data-version=["']([^"']+)["']/i)?.[1] || null;
  const beVersion = htmlText.match(/__DDG_BE_VERSION__\s*=\s*["']([^"']+)["']/i)?.[1] || null;
  const feChatHash = htmlText.match(/__DDG_FE_CHAT_HASH__\s*=\s*["']([^"']+)["']/i)?.[1] || null;

  const entryBundleUrls = [];
  for (const m of htmlText.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)) {
    if (m[1]) entryBundleUrls.push(m[1]);
  }

  const corpus = [htmlText, ...textAssets.map((a) => a.text || '')].join('\n');

  const markers = {
    versionTag: versionTag || legacyVersion || beVersion || null,
    versionSha: versionSha || feChatHash || null,
    beVersion,
    feChatHash,
    entryBundleUrls: entryBundleUrls.slice(0, 12),

    // 核心 API 端点
    chatEndpoint: corpus.includes('/duckchat/v1/chat'),
    statusEndpoint: corpus.includes('/duckchat/v1/status'),
    capabilitiesEndpoint: corpus.includes('/duckchat/v1/capabilities'),
    summarizeEndpoint: corpus.includes('/duckchat/v1/summarize'),
    authTokenEndpoint: corpus.includes('/duckchat/v1/auth/token'),

    // 请求头与核心契约字段
    vqdChallengeHeader: corpus.includes('x-vqd-hash-1'),
    feVersionHeader: corpus.includes('x-fe-version'),
    feSignalsHeader: corpus.includes('x-fe-signals'),
    continuationHeader: corpus.includes('x-duckai-continuation') || corpus.includes('resubmit-context'),
    consentPurposesHeader: corpus.includes('x-duckai-consent-purposes'),
    durableStream: corpus.includes('durableStream'),
    generatedImagePart: corpus.includes('generated-image'),
    generateImageTool: corpus.includes('GenerateImage'),
    webSearchTool: corpus.includes('WebSearch'),
    readDocumentTool: corpus.includes('ReadDocument'),
    locationPromptTool: corpus.includes('LocationPrompt')
  };

  // 模型扫描
  const detectedSet = new Set();
  for (const id of CATALOG_MODEL_IDS) {
    if (corpus.includes(id)) detectedSet.add(id);
  }
  for (const re of CANDIDATE_MODEL_RES) {
    for (const match of corpus.matchAll(re)) {
      const candidate = String(match[1] || '').trim();
      if (!candidate || candidate.length > 64 || MODEL_FALSE_POSITIVES.has(candidate)) continue;
      if (/[A-Z]{4,}/.test(candidate)) continue;
      detectedSet.add(candidate);
    }
  }
  const detectedModels = [...detectedSet].sort();
  const unknownModels = detectedModels.filter((id) => !CATALOG_MODEL_SET.has(id));
  const missingCatalogModels =
    textAssets.length > 0 ? CATALOG_MODEL_IDS.filter((id) => !detectedSet.has(id)) : [];

  return {
    ...markers,
    catalogCount: CATALOG_MODEL_IDS.length,
    detectedModels,
    unknownModels,
    missingCatalogModels
  };
}

/**
 * 抓取 duck.ai 线上页面与脚本包快照。
 */
export async function takeSnapshot(options = {}, mode = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const base = new URL(baseUrl);
  const fetcher = createFetcher(options);
  const maxAssets = Number.isFinite(Number(options.maxAssets)) ? Math.max(1, Number(options.maxAssets)) : DEFAULT_MAX_ASSETS;
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : DEFAULT_MAX_BYTES;
  const includeMedia = options.includeMedia === true;

  const assets = [];
  const bodies = new Map();
  const textAssets = [];
  const seen = new Set();
  const queue = [];
  const skippedExternal = [];
  const skippedMedia = [];
  let totalBytes = 0;

  const enqueue = (raw) => {
    const url = normalizeUrl(raw, baseUrl);
    if (!url) return;
    if (url.href === base.href || url.href === base.href.replace(/\/$/, '')) return;
    if (!options.includeExternal && url.origin !== base.origin) {
      if (!skippedExternal.includes(url.href)) skippedExternal.push(url.href);
      return;
    }
    if (!shouldFetchAsset(url.href, { includeMedia })) {
      if (!skippedMedia.includes(url.href)) skippedMedia.push(url.href);
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
  try {
    options.onEntryAccepted?.({ url: html.url, status: html.status });
  } catch {
    /* ignore */
  }
  totalBytes += html.buffer.length;
  const htmlText = html.buffer.toString('utf8');
  const normalizedHtml = normalizeHtmlForHash(htmlText);
  const htmlRecord = {
    url: html.url,
    localPath: safeRelativePath(html.url),
    status: html.status,
    contentType: html.contentType,
    etag: html.etag,
    lastModified: html.lastModified,
    size: html.buffer.length,
    rawSha256: sha256(html.buffer),
    sha256: sha256(Buffer.from(normalizedHtml, 'utf8'))
  };
  assets.push(htmlRecord);
  bodies.set(htmlRecord.url, html.buffer);

  for (const ref of extractHtmlRefs(htmlText, html.url)) enqueue(ref);
  for (const match of htmlText.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc=/i.test(match[0])) {
      for (const ref of extractScriptRefs(match[1], html.url)) enqueue(ref);
    }
  }

  while (queue.length && assets.length < maxAssets) {
    const url = queue.shift();
    let response;
    try {
      response = await fetcher(url);
    } catch (error) {
      if (!options.tolerant) throw new Error(`fetch asset failed: ${url}: ${error.message}`);
      assets.push({ url, status: 0, error: error.message, size: 0, sha256: null });
      continue;
    }
    if (!response.ok) {
      if (!options.tolerant) throw new Error(`fetch asset failed: HTTP ${response.status} ${url}`);
      assets.push({ url: response.url, status: response.status, contentType: response.contentType, size: response.buffer.length, sha256: null });
      continue;
    }
    if (response.buffer.length > maxBytes) {
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
      textAssets.push({ url: response.url, text });
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

  const markers = extractContractMarkers(htmlText, textAssets);
  const version =
    markers.versionTag && markers.versionSha
      ? `${markers.versionTag}-${markers.versionSha}`
      : markers.versionTag || markers.versionSha || null;

  const manifest = {
    schemaVersion: 2,
    fetchedAt: new Date().toISOString(),
    baseUrl,
    version,
    targets: {
      entryUrl: baseUrl,
      finalUrl: htmlRecord.url,
      status: htmlRecord.status,
      htmlSha256: htmlRecord.sha256,
      rawHtmlSha256: htmlRecord.rawSha256,
      versionTag: markers.versionTag,
      versionSha: markers.versionSha
    },
    markers,
    html: htmlRecord,
    assets,
    skippedExternal,
    skippedMediaCount: skippedMedia.length,
    totalBytes,
    truncated: queue.length > 0
  };

  if (mode.write) {
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    await fs.mkdir(outDir, { recursive: true });
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

export async function loadManifest(outDir = DEFAULT_OUT_DIR, manifestPath = null) {
  const file = manifestPath || path.join(outDir, 'manifest.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getReconStatus({ outDir = DEFAULT_OUT_DIR, manifestPath = null } = {}) {
  const manifest = await loadManifest(outDir, manifestPath);
  if (!manifest) {
    return {
      baselineExists: false,
      outDir,
      manifestPath: manifestPath || path.join(outDir, 'manifest.json'),
      capturedAt: null,
      entryUrl: DEFAULT_BASE_URL,
      version: null,
      targets: null,
      markers: null,
      assetCount: 0,
      totalBytes: 0,
      catalogCount: CATALOG_MODEL_IDS.length
    };
  }
  return {
    baselineExists: true,
    outDir,
    manifestPath: manifestPath || path.join(outDir, 'manifest.json'),
    capturedAt: manifest.fetchedAt || null,
    entryUrl: manifest.baseUrl || DEFAULT_BASE_URL,
    version: manifest.version || null,
    targets: manifest.targets || {
      entryUrl: manifest.baseUrl || DEFAULT_BASE_URL,
      finalUrl: manifest.html?.url || null,
      status: manifest.html?.status ?? 200,
      htmlSha256: manifest.html?.sha256 || null,
      versionTag: manifest.markers?.versionTag || manifest.version || null,
      versionSha: manifest.markers?.versionSha || null
    },
    markers: manifest.markers || null,
    assetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
    totalBytes: manifest.totalBytes || 0,
    catalogCount: CATALOG_MODEL_IDS.length
  };
}

const COMPARED_MARKER_KEYS = [
  'versionTag',
  'versionSha',
  'beVersion',
  'feChatHash',
  'chatEndpoint',
  'statusEndpoint',
  'capabilitiesEndpoint',
  'summarizeEndpoint',
  'authTokenEndpoint',
  'vqdChallengeHeader',
  'feVersionHeader',
  'feSignalsHeader',
  'continuationHeader',
  'consentPurposesHeader',
  'durableStream',
  'generatedImagePart',
  'generateImageTool',
  'webSearchTool',
  'readDocumentTool',
  'locationPromptTool'
];

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

  const baseMarkers = baseline.markers || {};
  const liveMarkers = current.markers || {};
  const markerChanges = [];
  for (const key of COMPARED_MARKER_KEYS) {
    const before = baseMarkers[key] ?? null;
    const after = liveMarkers[key] ?? null;
    if (before !== after) {
      markerChanges.push({ key, before, after });
    }
  }

  const baseModels = new Set(Array.isArray(baseMarkers.detectedModels) ? baseMarkers.detectedModels : []);
  const liveModels = new Set(Array.isArray(liveMarkers.detectedModels) ? liveMarkers.detectedModels : []);
  const modelAdded = [...liveModels].filter((id) => !baseModels.has(id)).sort();
  const modelRemoved = [...baseModels].filter((id) => !liveModels.has(id)).sort();
  const modelChanges = {
    added: modelAdded,
    removed: modelRemoved,
    unknownLive: Array.isArray(liveMarkers.unknownModels) ? liveMarkers.unknownModels : []
  };

  const baseHtmlSha = baseline.targets?.htmlSha256 || baseline.html?.sha256 || null;
  const liveHtmlSha = current.targets?.htmlSha256 || current.html?.sha256 || null;
  const targetsChanged = baseHtmlSha !== liveHtmlSha || baseline.version !== current.version;
  const same =
    !added.length &&
    !removed.length &&
    !changed.length &&
    !targetsChanged &&
    markerChanges.length === 0 &&
    modelAdded.length === 0 &&
    modelRemoved.length === 0;

  let summary;
  if (same) {
    summary = '未检测到变化：页面归一化哈希、契约标记与静态资源均与基线完全一致。';
  } else {
    const parts = [];
    if (baseline.version !== current.version) parts.push(`版本变更 (${baseline.version || '未知'} → ${current.version || '未知'})`);
    else if (targetsChanged) parts.push('入口 HTML 发生变化');
    if (markerChanges.length) parts.push(`${markerChanges.length} 项契约标记变更`);
    if (modelChanges.unknownLive.length) parts.push(`发现 ${modelChanges.unknownLive.length} 个未收录模型`);
    if (added.length) parts.push(`新增 ${added.length} 个资源`);
    if (removed.length) parts.push(`移除 ${removed.length} 个资源`);
    if (changed.length) parts.push(`${changed.length} 个资源内容变动`);
    summary = `检测到线上变动：${parts.join('，')}。`;
  }

  return {
    baselineExists: true,
    same,
    versionChanged: baseline.version !== current.version,
    targetsChanged,
    baselineVersion: baseline.version || null,
    currentVersion: current.version || null,
    baselineFetchedAt: baseline.fetchedAt || null,
    currentFetchedAt: current.fetchedAt || null,
    markerChanges,
    modelChanges,
    added,
    removed,
    changed,
    summary,
    currentMarkers: liveMarkers,
    currentTargets: current.targets || null
  };
}

export async function compareLive(options = {}) {
  const baseline = await loadManifest(options.outDir || DEFAULT_OUT_DIR, options.manifest);
  const current = await takeSnapshot(options, { write: false });
  if (!baseline) {
    return {
      baselineExists: false,
      same: false,
      versionChanged: false,
      targetsChanged: false,
      baselineVersion: null,
      currentVersion: current.version || null,
      baselineFetchedAt: null,
      currentFetchedAt: current.fetchedAt || null,
      markerChanges: [],
      modelChanges: {
        added: current.markers?.detectedModels || [],
        removed: [],
        unknownLive: current.markers?.unknownModels || []
      },
      added: current.assets || [],
      removed: [],
      changed: [],
      summary: '本地尚无 Recon 基线，已采集当前线上标记；可点击「拉取基线」固化本次快照。',
      currentMarkers: current.markers || null,
      currentTargets: current.targets || null
    };
  }
  return compareManifests(baseline, current);
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
    delayMs: 80,
    timeoutMs: 30000,
    includeExternal: false,
    includeMedia: false,
    tolerant: true,
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
    else if (arg === '--include-media') options.includeMedia = true;
    else if (arg === '--tolerant') options.tolerant = true;
    else if (arg === '--strict') options.tolerant = false;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.baseUrl = String(options.baseUrl);
  options.manifest = options.manifest || path.join(options.outDir, 'manifest.json');
  return options;
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
  --delay-ms <n>        请求间隔（默认 80）
  --timeout-ms <n>      单请求超时（默认 30000）
  --include-external    同时抓取第三方域名资源
  --include-media       同时抓取图片与字体等静态资源
  --strict              单个资源失败立即中止
  --json                输出 JSON（compare）
  -h, --help            显示帮助`);
}

export default {
  DEFAULT_BASE_URL,
  DEFAULT_OUT_DIR,
  DEFAULT_MANIFEST,
  sha256,
  normalizeHtmlForHash,
  shouldFetchAsset,
  extractContractMarkers,
  takeSnapshot,
  loadManifest,
  getReconStatus,
  compareManifests,
  compareLive,
  parseArgs,
  printHelp
};
