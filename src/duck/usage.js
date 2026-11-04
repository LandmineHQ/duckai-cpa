/**
 * v2.31：查询付费身份的用量额度。
 *
 * 源码依据：duck.ai 前端「Settings → Usage」读取的是 `GET /duckchat/v1/status` 响应里的
 * `fixedCostWindowUsage.windows`（窗口 id：six_hours / day / iso_week / month），
 * 每项含 `percentUsed / resetAt / isBlocked / isBypassable`；
 * 匿名（free）身份该字段缺失，因此 free 身份无法查询额度。
 *
 * 注意：`/duckchat/v1/usage` 是前端开发用的「模拟用量」控制端点（POST/DELETE），不是查询接口。
 */
const STATUS_URL = 'https://duck.ai/duckchat/v1/status';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const WINDOW_LABELS = {
  six_hours: '6 小时限额',
  day: '每日限额',
  iso_week: '每周限额',
  month: '每月限额'
};

/**
 * 查询一个身份 token 的额度窗口。
 * @param {{ token?: string, fetchImpl?: Function|null, timeoutMs?: number }} options
 * @returns {Promise<{supported: boolean, windows: Array<object>, fetchedAt: number}>}
 */
export async function fetchIdentityUsage(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (!token) return { supported: false, windows: [], fetchedAt: Date.now() };
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : (url, init) => fetch(url, init);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 15000) : null;
  let response;
  try {
    response = await fetchImpl(STATUS_URL, {
      method: 'GET',
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://duck.ai/',
        origin: 'https://duck.ai',
        authorization: `Bearer ${token}`
      },
      ...(controller ? { signal: controller.signal } : {})
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || !response.ok) {
    throw new Error(`status HTTP ${response ? response.status : 'unknown'}`);
  }
  const payload = await response.json().catch(() => null);
  const windows = payload?.fixedCostWindowUsage?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    return { supported: false, windows: [], fetchedAt: Date.now() };
  }
  return {
    supported: true,
    windows: windows
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        label: WINDOW_LABELS[item.id] || item.id,
        percentUsed: Number.isFinite(Number(item.percentUsed)) ? Math.max(0, Number(item.percentUsed)) : 0,
        resetAt: typeof item.resetAt === 'string' ? item.resetAt : null,
        isBlocked: item.isBlocked === true,
        isBypassable: item.isBypassable === true
      })),
    fetchedAt: Date.now()
  };
}
