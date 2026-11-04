/**
 * v2.37：连接测试与会话历史共用消息展示（工具调用归一化 + 测试会话持久化）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeToolCalls } from '../src/openai/chat.js';

test('normalizeToolCalls：工具调用 + 审批决策 + 生成图片合并（去重/补图片生成记录）', () => {
  const list = normalizeToolCalls({
    toolCalls: [
      { name: 'WebSearch', callId: 'c1', args: { query: '天气' }, result: { citations: [] } },
      { name: 'GenerateImage', callId: 'c2' }
    ],
    approvals: [
      { toolName: 'LocationPrompt', purpose: 'user-location', approved: false },
      { toolName: 'Other', approved: null }
    ],
    images: [{ b64: 'x', format: 'jpeg' }]
  });

  assert.equal(list.length, 3, 'null 审批不出现；已有 GenerateImage 不重复补');
  assert.deepEqual(
    list.map((item) => item.name),
    ['WebSearch', 'GenerateImage', 'LocationPrompt']
  );
  assert.equal(list[0].args, '{"query":"天气"}');
  assert.equal(list[2].result, '已拒绝');

  const withImagesOnly = normalizeToolCalls({ images: [{ b64: 'x' }, { b64: 'y' }] });
  assert.deepEqual(withImagesOnly, [{ name: 'GenerateImage', result: '已生成 2 张图片' }]);
  assert.deepEqual(normalizeToolCalls({}), []);
});
