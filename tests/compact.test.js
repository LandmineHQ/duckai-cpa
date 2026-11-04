/**
 * v2.11 compact 协议层（task-41，`src/duck/compact.js`）+ 模型上下文能力（`src/duck/models.js`）。
 *
 * 按 duck-protocol 最终签名：
 *   buildSummaryPrompt / serializeMessages / estimateChars / estimateTokens / shouldCompact / summarizeMessages
 *   getModelCapabilities / getApiModelCatalog 的 contextWindowChars/maxInputChars/maxOutputTokens/capabilities
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSummaryPrompt,
  serializeMessages,
  estimateChars,
  estimateTokens,
  shouldCompact,
  summarizeMessages,
  DEFAULT_MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  MAX_SUMMARY_PROMPT_CHARS
} from '../src/duck/compact.js';
import { getModelCapabilities, getApiModelCatalog } from '../src/duck/models.js';
import { DuckError } from '../src/duck/index.js';

const MESSAGES = [
  { role: 'user', content: '帮我把订单 A-102 改成明天发货' },
  { role: 'assistant', content: '好的，已记录订单 A-102 明天发货，需要保留发票地址。', reasoning: '内部推理不应出现在摘要输入' },
  { role: 'reasoning', content: '这段 reasoning 必须跳过' },
  { role: 'user', content: '另外提醒我周四给客户回电' },
  { role: 'assistant', content: '' }
];

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    defaultModel: 'gpt-6-luna',
    async chat(params) {
      calls.push(params);
      if (overrides.error) throw overrides.error;
      if (overrides.empty) return { cleanContent: '' };
      return {
        cleanContent: overrides.text ?? '  - 订单 A-102 明天发货\n- 周四回电客户  ',
        model: overrides.model ?? 'gpt-6-luna',
        finishReason: overrides.finishReason ?? 'stop'
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/* prompt / 序列化                                                      */
/* ------------------------------------------------------------------ */

test('buildSummaryPrompt：关键指令齐全；maxSummaryChars 写入并 clamp 200–20000', () => {
  const prompt = buildSummaryPrompt();
  for (const re of [
    /user goals/i,
    /confirmed facts/i,
    /decisions/i,
    /pending work/i,
    /key numbers, identifiers, constraints/i,
    /Do not invent or guess/i,
    /plain text only/i,
    /dominant language/i,
    new RegExp(`under ${DEFAULT_MAX_SUMMARY_CHARS} characters`)
  ]) {
    assert.match(prompt, re);
  }
  assert.ok(!/existing summary/i.test(prompt), '无 previousSummary 时不应有 merge 指令');

  const custom = buildSummaryPrompt({ maxSummaryChars: 500 });
  assert.match(custom, /under 500 characters/);
  assert.match(buildSummaryPrompt({ maxSummaryChars: 10 }), new RegExp(`under ${MIN_SUMMARY_CHARS} characters`));
  assert.match(buildSummaryPrompt({ maxSummaryChars: 999999 }), new RegExp(`under ${MAX_SUMMARY_PROMPT_CHARS} characters`));

  const incremental = buildSummaryPrompt({ previousSummary: '旧摘要：订单 A-102 待发货' });
  assert.match(incremental, /existing summary/i);
  assert.match(incremental, /merge new information/i);
  assert.match(incremental, /do not repeat unchanged details/i);
});

test('serializeMessages：role 行格式，跳过 reasoning 与空 content', () => {
  const text = serializeMessages(MESSAGES);
  assert.match(text, /\[user\] 帮我把订单 A-102 改成明天发货/);
  assert.match(text, /\[assistant\] 好的，已记录订单 A-102 明天发货/);
  assert.match(text, /\[user\] 另外提醒我周四给客户回电/);
  assert.ok(!text.includes('内部推理不应出现在摘要输入'), 'assistant.reasoning 不应被序列化');
  assert.ok(!text.includes('这段 reasoning 必须跳过'), 'role=reasoning 应跳过');
});

test('estimateChars/estimateTokens/shouldCompact', () => {
  assert.equal(estimateChars(MESSAGES), MESSAGES[0].content.length + MESSAGES[1].content.length + MESSAGES[3].content.length);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens(300), 100);

  const small = [{ role: 'user', content: 'hi' }];
  assert.equal(shouldCompact(small, { triggerChars: 100 }), false);
  assert.equal(shouldCompact(small, { triggerChars: 2 }), true);
});

/* ------------------------------------------------------------------ */
/* summarizeMessages                                                   */
/* ------------------------------------------------------------------ */

test('summarizeMessages：单条 user、reasoningEffort=none、跳过 reasoning、返回字段与 usage', async () => {
  const client = fakeClient();
  const result = await summarizeMessages(client, MESSAGES, { model: 'gpt-6-luna' });
  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.model, 'gpt-6-luna');
  assert.equal(params.reasoningEffort, 'none');
  assert.equal(params.messages.length, 1, '只发一条 user 消息');
  assert.equal(params.messages[0].role, 'user');
  assert.match(params.messages[0].content, /Conversation to summarize:/);
  assert.match(params.messages[0].content, /订单 A-102/);
  assert.ok(!params.messages[0].content.includes('这段 reasoning 必须跳过'));

  assert.equal(result.ok, true);
  assert.equal(result.text, '  - 订单 A-102 明天发货\n- 周四回电客户  '.trim());
  assert.equal(result.summary, result.text);
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.coveredMessageCount, 3, '只统计可序列化消息');
  assert.equal(result.previousSummaryUsed, false);
  assert.ok(result.inputChars > 0 && result.outputChars > 0);
  assert.equal(result.usage.inputChars, result.inputChars);
  assert.equal(result.usage.outputChars, result.outputChars);
  assert.equal(result.finishReason, 'stop');
});

test('summarizeMessages：previousSummary 出现在 prompt 且 previousSummaryUsed=true（增量）', async () => {
  const client = fakeClient({ text: '- 更新后的摘要' });
  const result = await summarizeMessages(client, MESSAGES, { previousSummary: '旧摘要：订单 A-102 待发货' });
  const content = client.calls[0].messages[0].content;
  assert.match(content, /Existing summary/i);
  assert.match(content, /旧摘要：订单 A-102 待发货/);
  assert.equal(result.previousSummaryUsed, true);
  assert.equal(result.text, '- 更新后的摘要');
});

test('summarizeMessages：空 messages / 非法 client → DuckError invalid_request（不可重试）', async () => {
  for (const call of [
    () => summarizeMessages(fakeClient(), [])
  ]) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof DuckError);
      assert.equal(error.type, 'invalid_request');
      assert.equal(error.retriable, false);
      return true;
    });
  }
  await assert.rejects(
    () => summarizeMessages(null, MESSAGES),
    (error) => error instanceof DuckError && error.type === 'invalid_request'
  );
});

test('summarizeMessages：失败映射（DuckError 原样 / 普通 Error → summary_failed / 空摘要 → empty_summary）', async () => {
  const original = new DuckError('429 from upstream', { status: 429, type: 'rate_limit', retriable: true });
  await assert.rejects(
    () => summarizeMessages(fakeClient({ error: original }), MESSAGES),
    (error) => error === original
  );
  await assert.rejects(
    () => summarizeMessages(fakeClient({ error: new Error('boom') }), MESSAGES),
    (error) => {
      assert.ok(error instanceof DuckError);
      assert.equal(error.type, 'summary_failed');
      assert.equal(error.status, 502);
      assert.equal(error.retriable, true);
      return true;
    }
  );
  await assert.rejects(
    () => summarizeMessages(fakeClient({ empty: true }), MESSAGES),
    (error) => error instanceof DuckError && error.type === 'empty_summary' && error.retriable === true
  );
});

test('summarizeMessages：超长输入截断标记；maxSummaryChars 硬截断；signal 透传', async () => {
  const longMessages = [{ role: 'user', content: 'x'.repeat(50000) }];
  const truncClient = fakeClient({ text: '- 摘要' });
  await summarizeMessages(truncClient, longMessages, { inputCharsLimit: 1000 });
  assert.match(truncClient.calls[0].messages[0].content, /\[\.\.\.earlier conversation truncated\.\.\.\]/, '超预算应截断并加标记');

  const controller = new AbortController();
  const signalClient = fakeClient({ text: 'y'.repeat(5000) });
  const result = await summarizeMessages(signalClient, MESSAGES, { maxSummaryChars: 200, signal: controller.signal });
  assert.equal(signalClient.calls[0].signal, controller.signal, 'signal 应透传');
  assert.ok(result.text.length <= 200, `maxSummaryChars 应硬截断（实际 ${result.text.length}）`);
  assert.equal(result.outputChars, result.text.length);
});

/* ------------------------------------------------------------------ */
/* 模型上下文能力                                                       */
/* ------------------------------------------------------------------ */

test('getModelCapabilities：contextWindowChars/maxInputChars/maxOutputTokens/capabilities 齐全；别名与未知模型', () => {
  const luna = getModelCapabilities('gpt-6-luna');
  assert.ok(luna);
  assert.equal(luna.model, 'gpt-6-luna');
  assert.equal(luna.tier, 'free');
  assert.equal(luna.paid, false);
  assert.equal(luna.contextWindowChars, 20000);
  assert.equal(luna.maxInputChars, 19500);
  assert.equal(luna.maxOutputTokens, 4096);
  assert.equal(typeof luna.maxOutputTokensEstimated, 'boolean');
  assert.deepEqual(luna.reasoningEfforts, ['none', 'low']);
  assert.equal(luna.capabilities.webSearch, true);
  assert.equal(luna.capabilities.imageGeneration, true);
  assert.equal(luna.capabilities.contextWindowChars, 20000);

  const alias = getModelCapabilities('gpt-6');
  assert.ok(alias);
  assert.equal(alias.model, 'gpt-6-luna', '别名应解析到同一模型');

  assert.equal(getModelCapabilities('no-such-model'), null);
});

test('getApiModelCatalog：每个模型带 context 字段与 capabilities；付费模型标记 paid', () => {
  const catalog = getApiModelCatalog();
  const items = Array.isArray(catalog) ? catalog : catalog.items || catalog.models || [];
  assert.ok(items.length > 0);
  for (const model of items) {
    assert.equal(typeof model.contextWindowChars, 'number');
    assert.equal(typeof model.maxInputChars, 'number');
    assert.equal(typeof model.maxOutputTokens, 'number');
    assert.equal(typeof model.maxOutputTokensEstimated, 'boolean');
    assert.ok(model.capabilities && typeof model.capabilities === 'object');
    assert.equal(typeof model.capabilities.webSearch, 'boolean');
    assert.equal(typeof model.capabilities.imageGeneration, 'boolean');
  }
  const paid = items.find((model) => model.paid === true);
  assert.ok(paid, '应存在付费模型且 paid=true');
  assert.ok(['plus', 'pro'].includes(paid.tier));
});

/* ------------------------------------------------------------------ */
/* 原生 summarize（duck.ai /duckchat/v1/summarize 优先）                 */
/* ------------------------------------------------------------------ */

test('summarizeMessages：client.summarizeNative 存在时优先原生，不调用 chat；previousSummary 传 {text,version}', async () => {
  const calls = [];
  const nativeCalls = [];
  const client = {
    defaultModel: 'gpt-5.4-mini',
    async chat() {
      calls.push('chat');
      throw new Error('should not call chat');
    },
    async summarizeNative(params) {
      nativeCalls.push(params);
      return { text: '- 原生摘要', version: 2, coveredPairCount: 5, fixedCostWindowUsage: { inputChars: 1200, outputChars: 20 } };
    }
  };
  const result = await summarizeMessages(client, MESSAGES, {
    previousSummary: { text: '旧摘要', version: 1 }
  });
  assert.equal(calls.length, 0, '原生成功不应调用 chat');
  assert.equal(nativeCalls.length, 1);
  assert.deepEqual(nativeCalls[0].previousSummary, { text: '旧摘要', version: 1 });
  assert.equal(result.native, true);
  assert.equal(result.fallbackReason, null);
  assert.equal(result.text, '- 原生摘要');
  assert.equal(result.summaryVersion, 2);
  assert.equal(result.coveredPairCount, 5);
  assert.deepEqual(result.fixedCostWindowUsage, { inputChars: 1200, outputChars: 20 });
  assert.equal(result.previousSummaryVersion, 1);
});

test('summarizeMessages：原生失败（非 418/429）→ 回退 chat，native:false + fallbackReason', async () => {
  const client = {
    defaultModel: 'gpt-5.4-mini',
    async summarizeNative() {
      throw new Error('native summarize failed');
    },
    async chat() {
      return { cleanContent: '- 回退摘要', model: 'gpt-6-luna', finishReason: 'stop' };
    }
  };
  const result = await summarizeMessages(client, MESSAGES);
  assert.equal(result.native, false);
  assert.equal(typeof result.fallbackReason, 'string');
  assert.equal(result.text, '- 回退摘要');
});

test('summarizeMessages：原生 418/429 不回退（chat 不调用，原样抛出）', async () => {
  for (const status of [418, 429]) {
    const calls = [];
    const error = new DuckError('rate limited', { status: 502, type: 'rate_limit', retriable: true });
    error.transportStatus = status;
    const client = {
      defaultModel: 'gpt-5.4-mini',
      async summarizeNative() {
        throw error;
      },
      async chat() {
        calls.push('chat');
        return { cleanContent: '不应调用' };
      }
    };
    await assert.rejects(
      () => summarizeMessages(client, MESSAGES),
      (thrown) => thrown === error
    );
    assert.equal(calls.length, 0, status + ' 不应回退 chat');
  }
});

test('summarizeMessages：不支持压缩的模型（gpt-6-luna）跳过原生，chat 回退并标记 compaction_unsupported_model', async () => {
  const calls = [];
  const client = {
    defaultModel: 'gpt-6-luna',
    async summarizeNative() {
      calls.push('native');
      return { text: '不应调用原生', version: 1 };
    },
    async chat() {
      calls.push('chat');
      return { cleanContent: '- 回退摘要', model: 'gpt-6-luna', finishReason: 'stop' };
    }
  };
  const result = await summarizeMessages(client, MESSAGES);
  assert.deepEqual(calls, ['chat'], '不支持模型不应尝试原生');
  assert.equal(result.native, false);
  assert.equal(result.fallbackReason, 'compaction_unsupported_model');
  assert.equal(result.text, '- 回退摘要');
});
