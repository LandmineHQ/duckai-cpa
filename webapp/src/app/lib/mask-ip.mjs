/**
 * IP 脱敏工具（前端展示用）。
 *
 * 管理后台会展示代理出口 IP 等敏感信息；默认全部脱敏，点击后才由组件显示真实值，
 * 避免截图/屏幕共享时意外泄露。这里只做纯字符串处理，便于 node:test 直接单测。
 */

/**
 * 是否像 IPv4 地址（只做展示用途，不做严格校验）。
 * @param {string} value
 */
function looksLikeIpv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

/**
 * 是否像 IPv6 地址（含 "::" 压缩形式）。
 * @param {string} value
 */
function looksLikeIpv6(value) {
  return value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
}

/**
 * 把 IP 变成脱敏展示文本：
 *   - IPv4: 仅保留第一段，其余用 `***` 替代（如 `203.0.113.10` → `70.***.***.***`）
 *   - IPv6: 仅保留前两组，其余用 `***` 替代
 *   - 空值: `—`
 *   - 其它（主机名/异常文本）: `***`
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function maskIp(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '—';
  if (looksLikeIpv4(raw)) {
    const firstOctet = raw.split('.')[0];
    return `${firstOctet}.***.***.***`;
  }
  if (looksLikeIpv6(raw)) {
    const groups = raw.split(':').filter((group) => group !== '');
    // 压缩形式（如 ::1）信息量太少，直接整体脱敏
    if (groups.length < 3) return '***';
    const visible = groups.slice(0, 2).join(':');
    return `${visible}:***:***:***`;
  }
  // 非 IP 的文本不直接展示，避免意外泄露（例如代理测试错误里带出的地址）
  return '***';
}

export default maskIp;
