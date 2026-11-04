/**
 * v2.12 compact 触发语义（task-47，`src/duck/compact.js`）：
 * isCompactionSupported / getActivationTargetPairCount / shouldCompact / parseCompactMarkers。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_MODELS,
  FALLBACK_MIN_NEW_PAIRS,
  isCompactionSupported,
  getActivationTargetPairCount,
  countPairs,
  shouldCompact,
  parseCompactMarkers
} from '../src/duck/compact.js';

function pairs(count) {
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({ role: 'user', content: `问题 ${index + 1}` });
    messages.push({ role: 'assistant', content: `回答 ${index + 1}` });
  }
  return messages;
}

test('isCompactionSupported：白名单模型 true、gpt-6-luna false、未知 false、internal-only 需 internalTier', () => {
  assert.ok(COMPACTION_MODELS.includes('gpt-5.4-mini'));
  assert.ok(COMPACTION_MODELS.includes('claude-sonnet-4-6'));
  assert.equal(isCompactionSupported('gpt-5.4-mini'), true);
  assert.equal(isCompactionSupported('claude-sonnet-4-6'), true);
  assert.equal(isCompactionSupported('gpt-6-luna'), false);
  assert.equal(isCompactionSupported('mistral-small-2603'), false);
  assert.equal(isCompactionSupported(''), false);
  // internal-only 模型默认 false，internalTier=true 时 true
  assert.equal(isCompactionSupported('claude-haiku-5-5'), false);
  assert.equal(isCompactionSupported('claude-haiku-5-5', { internalTier: true }), true);
  assert.equal(isCompactionSupported('claude-haiku-5-5', true), true);
});

test('getActivationTargetPairCount：数字/对象（capabilities/modelConfig）读取，非法 null', () => {
  assert.equal(getActivationTargetPairCount(6), 6);
  assert.equal(getActivationTargetPairCount({ activationTargetPairCount: 5 }), 5);
  assert.equal(getActivationTargetPairCount({ capabilities: { activationTargetPairCount: 4 } }), 4);
  assert.equal(getActivationTargetPairCount({ modelConfig: { activationTargetPairCount: 3 } }), 3);
  assert.equal(getActivationTargetPairCount({ capabilities: { compaction: { activationTargetPairCount: 2 } } }), 2);
  assert.equal(getActivationTargetPairCount(null), null);
  assert.equal(getActivationTargetPairCount({}), null);
  assert.equal(getActivationTargetPairCount({ activationTargetPairCount: -1 }), null);
  assert.equal(getActivationTargetPairCount(1.5), null);
});

test('countPairs：按消息条数/2 向下取整', () => {
  assert.equal(countPairs([]), 0);
  assert.equal(countPairs(pairs(3)), 3);
  assert.equal(countPairs([{ role: 'user', content: 'a' }]), 0);
  assert.equal(countPairs([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]), 1);
});

test('shouldCompact（activationTargetPairCount）：target > covered 且 target <= activePairs 才触发', () => {
  const base = { model: 'gpt-5.4-mini', activationTargetPairCount: 4 };
  assert.equal(shouldCompact({ ...base, pairCount: 3, coveredPairCount: 0 }), false, 'pairs 3 < target 4');
  assert.equal(shouldCompact({ ...base, pairCount: 4, coveredPairCount: 0 }), true, 'pairs 4 >= target 4');
  assert.equal(shouldCompact({ ...base, pairCount: 5, coveredPairCount: 3 }), true, 'target > covered');
  assert.equal(shouldCompact({ ...base, pairCount: 5, coveredPairCount: 4 }), false, 'target === covered 不触发');
  assert.equal(shouldCompact({ ...base, pairCount: 5, coveredPairCount: 5 }), false);
  assert.equal(shouldCompact({ ...base, pairCount: 10, coveredPairCount: 0 }), true);
});

test('shouldCompact（无 activation 的 fallback）：activePairs>=4 且新增 pairs>=4', () => {
  const base = { model: 'gpt-5.4-mini' };
  assert.equal(FALLBACK_MIN_NEW_PAIRS, 4);
  assert.equal(shouldCompact({ ...base, pairCount: 3, coveredPairCount: 0 }), false, 'pairs 3 < 4');
  assert.equal(shouldCompact({ ...base, pairCount: 4, coveredPairCount: 0 }), true, 'pairs 4 且新增 4');
  assert.equal(shouldCompact({ ...base, pairCount: 4, coveredPairCount: 1 }), false, '新增 3 < 4');
  assert.equal(shouldCompact({ ...base, pairCount: 8, coveredPairCount: 4 }), true, '新增 4');
  assert.equal(shouldCompact({ ...base, pairCount: 8, coveredPairCount: 5 }), false, '新增 3');
});

test('shouldCompact：不支持压缩的模型（gpt-6-luna）恒 false；不支持模型也不因 chars 触发', () => {
  assert.equal(shouldCompact({ model: 'gpt-6-luna', pairCount: 20, coveredPairCount: 0 }), false);
  assert.equal(shouldCompact({ model: 'gpt-6-luna', pairCount: 20, coveredPairCount: 0, triggerChars: 10 }), false);
  assert.equal(shouldCompact(pairs(20), { model: 'gpt-6-luna', triggerChars: 10 }), false);
});

test('shouldCompact：messages 形式 + 旧 triggerChars 仅作网关兜底（支持模型）', () => {
  const messages = pairs(2); // 2 pairs
  assert.equal(shouldCompact(messages, { model: 'gpt-5.4-mini' }), false, 'pairs 2 未达 fallback');
  assert.equal(shouldCompact(messages, { model: 'gpt-5.4-mini', triggerChars: 100000 }), false);
  assert.equal(shouldCompact(messages, { model: 'gpt-5.4-mini', triggerChars: 5 }), true, 'chars 兜底触发');
});

/* ------------------------------------------------------------------ */
/* parseCompactMarkers                                                 */
/* ------------------------------------------------------------------ */

function encodedJson(value) {
  return encodeURIComponent(JSON.stringify(value));
}

test('parseCompactMarkers：SUMMARY_REFRESH_HINT（URL 编码 JSON）解析 targetPairCount/thresholdTokens', () => {
  const hint = {
    baseCoveredPairCount: 2,
    targetPairCount: 6,
    thresholdTokens: 12000,
    trigger: 'tokens'
  };
  const text = `回答正文[SUMMARY_REFRESH_HINT:${encodedJson(hint)}]`;
  const parsed = parseCompactMarkers(text);
  assert.deepEqual(parsed.summaryRefreshHint, {
    baseCoveredPairCount: 2,
    targetPairCount: 6,
    trigger: 'tokens',
    thresholdTokens: 12000
  });
  assert.ok(parsed.markers.includes('SUMMARY_REFRESH_HINT'));
  assert.equal(parsed.summaryInvalid, false);
});

test('parseCompactMarkers：SUMMARY_INVALID / LIMIT_CONVERSATION / FIXED_COST_WINDOW_USAGE', () => {
  const usage = { inputChars: 1000, outputChars: 50 };
  const text = `x[SUMMARY_INVALID][LIMIT_CONVERSATION][FIXED_COST_WINDOW_USAGE:${encodedJson(usage)}]`;
  const parsed = parseCompactMarkers(text);
  assert.equal(parsed.summaryInvalid, true);
  assert.equal(parsed.limitConversation, true);
  assert.deepEqual(parsed.fixedCostWindowUsage, usage);
  assert.deepEqual(
    [...parsed.markers].sort(),
    ['FIXED_COST_WINDOW_USAGE', 'LIMIT_CONVERSATION', 'SUMMARY_INVALID'].sort()
  );
});

test('parseCompactMarkers：非法/缺失/数组输入安全；无标记返回空状态', () => {
  const malformed = parseCompactMarkers('[SUMMARY_REFRESH_HINT:%7Bbad-json][FIXED_COST_WINDOW_USAGE:not-json]');
  assert.equal(malformed.summaryRefreshHint, null, '非法 JSON 应忽略');
  assert.equal(malformed.fixedCostWindowUsage, null);

  const empty = parseCompactMarkers('普通回答，无标记');
  assert.equal(empty.summaryRefreshHint, null);
  assert.equal(empty.summaryInvalid, false);
  assert.equal(empty.limitConversation, false);
  assert.deepEqual(empty.markers, []);

  const arrays = parseCompactMarkers([`a[SUMMARY_REFRESH_HINT:${encodedJson({ targetPairCount: 4, trigger: 'tokens' })}]`, '[LIMIT_CONVERSATION]']);
  assert.equal(arrays.summaryRefreshHint.targetPairCount, 4);
  assert.equal(arrays.limitConversation, true);
  assert.equal(arrays.summaryRefreshHint.baseCoveredPairCount, undefined);

  const invalidTrigger = parseCompactMarkers(`[SUMMARY_REFRESH_HINT:${encodedJson({ targetPairCount: 4, trigger: 'chars' })}]`);
  assert.equal(invalidTrigger.summaryRefreshHint, null, 'trigger 非 tokens 应忽略');
});
