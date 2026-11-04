/**
 * v2.25 订阅「免复制 JWT」登录会话。
 *
 * 背景（源码分析见 docs/SUBSCRIPTION-LOGIN.md）：
 * duck.ai 网页端拿 DuckDuckGo 订阅 token 的方式是
 *   GET https://quack.duckduckgo.com/api/auth/v2/token?grant_type=refresh_token
 *       &client_id=fb417741-decf-4b1d-a614-32898aa8ecca   (credentials: include)
 * 返回 `{ access_token }`；401 表示未登录。Electron 端则用 `GET /duckchat/v1/auth/token`。
 * 二者都依赖 **duckduckgo.com 的登录 cookie**，Node 侧拿不到，所以只能由「已登录的浏览器」代取。
 *
 * 本模块提供一次性登录会话：管理页生成会话 + 书签脚本（bookmarklet）；
 * 用户在 duck.ai 页面点书签 → 书签取 token 并 POST 回网关 → 会话完成 → 自动保存订阅，
 * 用户无需手动复制 JWT。
 *
 * 安全边界：
 *  - sessionId 为 24 字节随机 hex，TTL 5 分钟，单次使用；
 *  - capture 端点只接受「未过期 + 未使用」的会话，token 只写入 data/subscriptions.json（0600）；
 *  - capture 端点不回显 token，只回订阅的脱敏视图。
 */

import crypto from 'node:crypto';

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 50;
/**
 * duck.ai 页面内可用的「同源」取 token 端点。
 * ⚠️ 不能用 `https://quack.duckduckgo.com/api/auth/v2/token`：duck.ai 的 CSP
 * `connect-src` 不含 duckduckgo.com（实测 "Failed to fetch"），浏览器内必须走同源端点。
 * 该端点需要 DuckDuckGo 登录 cookie，未登录返回 `{}`（无 access_token）。
 */
const SAME_ORIGIN_TOKEN_ENDPOINT = '/duckchat/v1/auth/token';
/** 直连端点（仅 Node 侧参考/文档用途；浏览器内会被 CSP 拦截）。 */
const TOKEN_ENDPOINT =
  'https://quack.duckduckgo.com/api/auth/v2/token?grant_type=refresh_token&client_id=fb417741-decf-4b1d-a614-32898aa8ecca';

/** @type {Map<string, {id:string, createdAt:number, expiresAt:number, status:string, result:any, error:any, source:string}>} */
const sessions = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now && session.status === 'waiting') {
      session.status = 'expired';
    }
    // 过期 10 分钟后的会话直接丢弃
    if (session.expiresAt + 10 * 60 * 1000 <= now) sessions.delete(id);
  }
  // 上限保护（丢弃最旧的已完成/过期会话）
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const session of ordered) {
      if (sessions.size <= MAX_SESSIONS) break;
      if (session.status !== 'waiting') sessions.delete(session.id);
    }
  }
}

/**
 * 构造「一行脚本」：在 duck.ai 页面取 token 并交回网关（不含 javascript: 前缀）。
 *
 * 交回方式（按可靠性排序）：
 *  1) 直接 `fetch` 网关的 capture 端点（若浏览器允许公网页面访问本机）；
 *  2) 否则 `window.open(<relayUrl>&token=...)` 在新标签打开管理台，由管理台同源提交——
 *     Chrome 的 Local Network Access 会拦截 (1)，但**顶层导航不受限**，所以 (2) 是兜底主路径。
 */
export function buildScript({ sessionId, captureUrl, relayUrl }) {
  const target = `${relayUrl}${String(relayUrl).includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(
    sessionId
  )}&token=`;
  const code = `(async()=>{try{
const r=await fetch(${JSON.stringify(SAME_ORIGIN_TOKEN_ENDPOINT)},{credentials:'include'});
const j=await r.json().catch(()=>({}));
const t=j&&j.access_token;
if(!t){alert(r.status===401?'未登录：请先在 duck.ai 登录 DuckDuckGo 账号':'未获取到 token：请确认已登录 DuckDuckGo（返回空说明未登录）');return;}
try{
const res=await fetch(${JSON.stringify(captureUrl)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(
    sessionId
  )},token:t})});
const out=await res.json().catch(()=>({}));
if(out&&out.ok){alert('订阅已绑定：'+(out.subscription&&out.subscription.tier||'')+' '+(out.subscription&&out.subscription.email||''));return;}
}catch(e){/* 本机访问被浏览器拦截 → 回退到打开管理台 */}
window.open(${JSON.stringify(target)}+encodeURIComponent(t),'_blank');
alert('已在新标签打开管理台，请回到管理台查看「已绑定」提示。');
}catch(e){alert('捕获失败：'+(e&&e.message||e));}})();`;
  // 书签/控制台脚本必须是单行：把模板里的换行与缩进压掉
  return code.replace(/\r?\n/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 书签（bookmarklet）：`javascript:` + URL 编码。
 * ⚠️ Chrome 在地址栏**粘贴** `javascript:` 会剥离前缀变成搜索，
 * 必须「拖到书签栏」或「右键 → 添加到书签」，或用 consoleScript 在 Console 执行。
 */
export function buildBookmarklet({ sessionId, captureUrl, relayUrl }) {
  const oneLine = buildScript({ sessionId, captureUrl, relayUrl });
  return `javascript:${encodeURIComponent(oneLine).replace(/'/g, '%27')}`;
}

/**
 * 创建登录会话。
 * @param {{ origin: string, source?: string }} options
 */
export function createLoginSession({ origin, source = 'bookmarklet' }) {
  pruneExpired();
  const id = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session = {
    id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    status: 'waiting',
    result: null,
    error: null,
    source
  };
  sessions.set(id, session);
  const base = String(origin || '').replace(/\/+$/, '');
  const captureUrl = `${base}/admin/api/subscriptions/capture`;
  const relayUrl = `${base}/admin/#/subscriptions?login=${id}`;
  return {
    ok: true,
    sessionId: id,
    status: session.status,
    createdAt: now,
    expiresAt: session.expiresAt,
    ttlMs: SESSION_TTL_MS,
    captureUrl,
    relayUrl,
    tokenEndpoint: TOKEN_ENDPOINT,
    bookmarklet: buildBookmarklet({ sessionId: id, captureUrl, relayUrl }),
    // 控制台脚本（不含 javascript: 前缀）：粘贴到 duck.ai 的 DevTools Console 执行
    consoleScript: buildScript({ sessionId: id, captureUrl, relayUrl }),
    steps: [
      '在浏览器打开 https://duck.ai/ 并登录 DuckDuckGo 账号（需已订阅 Plus/Pro）',
      '把「捕获订阅」链接拖到书签栏（Ctrl+Shift+B 显示书签栏），或右键该链接「添加到书签」',
      '在 duck.ai 页面点击该书签 —— 不要粘贴到地址栏（Chrome 会把 javascript: 变成搜索）',
      '不便添加书签时：在 duck.ai 按 F12 打开 Console，粘贴「控制台脚本」并回车',
      '本页会自动检测到绑定完成（每 2 秒轮询，5 分钟内有效）'
    ]
  };
}

/**
 * 宽松解析用户粘贴的内容，取出订阅 token：
 *  - 纯 JWT；
 *  - `Bearer <jwt>`；
 *  - `{"access_token":"<jwt>"}` 等包含 access_token/token 字段的 JSON（可嵌套）；
 *  - 上述内容被 Markdown 代码块包裹也可以。
 * @param {unknown} input
 * @returns {string} 提取到的 token（未找到时返回原始文本）
 */
export function normalizeTokenInput(input) {
  if (typeof input !== 'string') return '';
  const fence = String.fromCharCode(96, 96, 96); // ```
  let text = input.trim();
  if (!text) return '';
  if (text.startsWith(fence)) {
    text = text
      .replace(/^[`]{3}[a-zA-Z]*\s*/, '')
      .replace(/\s*[`]{3}$/, '')
      .trim();
  }
  if (text.toLowerCase().startsWith('bearer ')) text = text.slice(7).trim();
  if (text.split('.').length === 3 && /^[A-Za-z0-9_.-]+$/.test(text)) return text;
  try {
    const parsed = JSON.parse(text);
    const queue = [parsed];
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      for (const [key, value] of Object.entries(current)) {
        if (
          (key === 'access_token' || key === 'accessToken' || key === 'token' || key === 'jwt') &&
          typeof value === 'string' &&
          value.split('.').length === 3
        ) {
          return value.trim();
        }
        if (value && typeof value === 'object') queue.push(value);
      }
    }
  } catch {
    /* 不是 JSON，按原始文本返回 */
  }
  return text;
}

/** 读取会话（不存在返回 null）。 */
export function getLoginSession(id) {
  pruneExpired();
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  const remainingMs = Math.max(0, session.expiresAt - Date.now());
  return {
    ok: true,
    sessionId: session.id,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    remainingMs,
    result: session.result,
    error: session.error
  };
}

/** 取消会话。 */
export function cancelLoginSession(id) {
  const session = sessions.get(String(id || ''));
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.status === 'waiting') session.status = 'cancelled';
  return { ok: true, sessionId: session.id, status: session.status };
}

/** 标记会话完成（供路由在写入订阅后调用）。 */
export function completeLoginSession(id, result) {
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  session.status = 'completed';
  session.result = result;
  return session;
}

/** 标记会话失败。 */
export function failLoginSession(id, error) {
  const session = sessions.get(String(id || ''));
  if (!session) return null;
  session.status = 'failed';
  session.error = error;
  return session;
}

/** 供测试用：清空会话。 */
export function resetLoginSessions() {
  sessions.clear();
}
