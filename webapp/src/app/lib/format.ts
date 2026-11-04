/** 展示层格式化工具。 */

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

export function normalizeTs(ts: number | string | null | undefined): number | null {
  // 后端部分字段是 ISO 字符串（如订阅 token 的 expiresAt），Number(iso) 会得到 NaN
  if (typeof ts === 'string' && ts.trim() && !/^\d+(\.\d+)?$/.test(ts.trim())) {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? value * 1000 : value;
}

export function formatTime(ts: number | null | undefined): string {
  const value = normalizeTs(ts);
  return value === null ? '—' : timeFormatter.format(new Date(value));
}

export function formatDateTime(ts: number | null | undefined): string {
  const value = normalizeTs(ts);
  return value === null ? '—' : dateTimeFormatter.format(new Date(value));
}

export function formatRelative(ts: number | null | undefined): string {
  const value = normalizeTs(ts);
  if (value === null) return '—';
  const diff = Date.now() - value;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(value);
}

export function formatDuration(ms: number | null | undefined): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatQueueWait(ms: number | null | undefined): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '0 ms';
  return formatDuration(value);
}

export function formatNumber(value: number | null | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try {
    return number.toLocaleString('zh-CN');
  } catch {
    return String(number);
  }
}

export function formatUptime(totalSeconds: number | null | undefined): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds} 秒`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分`);
  if (parts.length === 0) parts.push(`${seconds % 60} 秒`);
  return parts.join(' ');
}

export function truncate(text: string | null | undefined, max = 120): string {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function errorRate(errors: number | null | undefined, requests: number | null | undefined): string {
  const e = Number(errors) || 0;
  const r = Number(requests) || 0;
  if (r <= 0) return '0%';
  return `${((e / r) * 100).toFixed(1)}%`;
}

export function topEntries(map: Record<string, number> | undefined, limit = 5): Array<[string, number]> {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .filter(([, count]) => Number.isFinite(Number(count)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([key, count]) => [key, Number(count)]);
}

export function dataUrlForImage(image: { b64: string; format?: string }): string {
  const format = image.format && /^[a-z0-9.+-]{1,16}$/i.test(image.format) ? image.format.toLowerCase() : 'png';
  return `data:image/${format};base64,${image.b64}`;
}

/** 页面 URL 同源地址（示例代码用）。 */
export function gatewayOrigin(): string {
  try {
    const origin = window.location.origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    /* ignore */
  }
  return 'http://127.0.0.1:8787';
}
