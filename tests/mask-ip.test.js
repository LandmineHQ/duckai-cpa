/**
 * 前端 IP 脱敏工具单测（webapp/src/app/lib/mask-ip.mjs）。
 * 目标：管理后台默认不展示完整出口 IP；只有点击 MaskedIp 组件按钮才显示真实值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { maskIp } from '../webapp/src/app/lib/mask-ip.mjs';

test('maskIp：IPv4 仅保留第一段，其余脱敏', () => {
  assert.equal(maskIp('203.0.113.10'), '203.***.***.***');
  assert.equal(maskIp('192.0.2.1'), '192.***.***.***');
});

test('maskIp：IPv6 仅保留前两组', () => {
  assert.equal(maskIp('2a01:4f8:1c1c:abcd::1'), '2a01:4f8:***:***:***');
  assert.equal(maskIp('::1'), '***');
});

test('maskIp：空值返回占位符，非 IP 文本不直接展示', () => {
  assert.equal(maskIp(''), '—');
  assert.equal(maskIp(null), '—');
  assert.equal(maskIp(undefined), '—');
  assert.equal(maskIp('proxy.example.com'), '***');
});

test('maskIp：脱敏结果不包含真实 IP 的后两段', () => {
  const masked = maskIp('203.0.113.10');
  assert.ok(!masked.includes('113'));
  assert.ok(!masked.includes('.10'));
});
