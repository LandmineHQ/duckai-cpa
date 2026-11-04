/**
 * v2.28：duck.ai 默认提示词生成器（源码逻辑）+ prompts.source 配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDuckAiPrompt,
  normalizeDuckAiCustomization,
  promptOptionCatalog,
  resolveConfiguredPrompt,
  TONE_PROMPTS,
  LENGTH_PROMPTS,
  CLARIFY_PROMPT
} from '../src/duck/prompt.js';
import { withServer, makeConfig } from './helpers/test-server.js';

test('生成器：文案逐字对齐 duck.ai 源码（tone / length / clarity / 昵称）', () => {
  assert.equal(TONE_PROMPTS.Casual, 'Use a casual, relaxed tone in your responses.');
  assert.equal(TONE_PROMPTS.Professional, 'Use a professional, formal tone in your responses.');
  assert.equal(TONE_PROMPTS.Friendly, 'Use a friendly, warm, and approachable tone in your responses.');
  assert.equal(TONE_PROMPTS.Playful, 'Use a playful, fun, and lighthearted tone in your responses.');
  assert.equal(TONE_PROMPTS.Empathetic, 'Use an empathetic, understanding, and compassionate tone in your responses.');
  assert.match(TONE_PROMPTS.Ducky, /^You are duck\./);
  assert.equal(LENGTH_PROMPTS.Short, 'Keep your responses short.');
  assert.equal(
    LENGTH_PROMPTS.Shortest,
    'Keep your responses extremely brief and to the point. Prioritize brevity over detail.'
  );
  assert.match(CLARIFY_PROMPT, /^When the user's request is unclear or lacks necessary context, ask clarifying questions/);
});

test('生成器：拼接顺序与源码一致（role → userRole → 昵称 → tone → length → clarify → 附加）', () => {
  const prompt = buildDuckAiPrompt({
    assistantRole: 'Chef',
    userRole: 'Programmer',
    userName: '小许',
    assistantName: 'Ducky',
    tone: 'Casual',
    length: 'Short',
    shouldSeekClarity: true,
    additionalInstructions: '回答用中文。'
  });
  // 角色整段在最前
  assert.match(prompt, /^You are a highly-skilled Master Chef/);
  // 顺序校验
  const order = ['Refer to me as 小许.', 'Refer to yourself as Ducky.', TONE_PROMPTS.Casual, LENGTH_PROMPTS.Short, CLARIFY_PROMPT, '回答用中文。'];
  let cursor = -1;
  for (const part of order) {
    const idx = prompt.indexOf(part, cursor + 1);
    assert.ok(idx > cursor, `片段顺序错误：${part}`);
    cursor = idx;
  }
});

test('生成器：默认（无任何选项）为空串 = duck.ai 原生行为', () => {
  assert.equal(buildDuckAiPrompt(), '');
  assert.equal(buildDuckAiPrompt({ tone: 'Default', length: 'Default', assistantRole: 'Default', userRole: 'Default' }), '');
});

test('归一化：未知取值回退 Default，文本裁剪', () => {
  const normalized = normalizeDuckAiCustomization({
    tone: 'Nope',
    length: 'Shortest',
    assistantRole: 'Unknown role',
    userRole: 'Programmer',
    shouldSeekClarity: 'yes',
    userName: '  x  ',
    additionalInstructions: 'a'.repeat(3000)
  });
  assert.equal(normalized.tone, 'Default');
  assert.equal(normalized.length, 'Shortest');
  assert.equal(normalized.assistantRole, 'Default');
  assert.equal(normalized.userRole, 'Programmer');
  assert.equal(normalized.shouldSeekClarity, false, '非 true 布尔一律 false');
  assert.equal(normalized.userName, 'x');
  assert.equal(normalized.additionalInstructions.length, 2000);
});

test('configured prompt：source=duckai/custom/none + 缺省推断', () => {
  const duckaiConfig = { prompts: { source: 'duckai', duckai: { tone: 'Casual' } } };
  assert.equal(resolveConfiguredPrompt(duckaiConfig), TONE_PROMPTS.Casual);

  const customConfig = { prompts: { source: 'custom', defaultSystemPrompt: '你是助手。' } };
  assert.equal(resolveConfiguredPrompt(customConfig), '你是助手。');

  const noneConfig = { prompts: { source: 'none', defaultSystemPrompt: 'ignored' } };
  assert.equal(resolveConfiguredPrompt(noneConfig), '');

  // 缺省：有自定义提示词 → custom；没有 → duckai（v2.28.1 起默认）
  assert.equal(resolveConfiguredPrompt({ prompts: { defaultSystemPrompt: '自定义' } }), '自定义');
  assert.equal(resolveConfiguredPrompt({ prompts: {} }), '');
  assert.equal(resolveConfiguredPrompt({ prompts: { duckai: { tone: 'Casual' } } }), TONE_PROMPTS.Casual);
});

test('选项目录：7 tone / 3 length / 24 assistant role / 6 user role（从源码提取）', () => {
  const catalog = promptOptionCatalog();
  assert.equal(catalog.tones.length, 7);
  assert.equal(catalog.lengths.length, 3);
  assert.equal(catalog.assistant_roles.length, 24);
  assert.equal(catalog.user_roles.length, 6);
  assert.ok(catalog.assistant_roles.some((item) => item.id === 'Chef'));
  assert.ok(catalog.user_roles.some((item) => item.id === 'Programmer'));
});

test('API：GET /admin/api/prompts/duckai + POST preview', async () => {
  const H = {
    authorization: `Bearer ${makeConfig().auth.adminToken}`,
    'content-type': 'application/json'
  };
  await withServer({}, async ({ baseUrl }) => {
    let res = await fetch(`${baseUrl}/admin/api/prompts/duckai`, { headers: H });
    assert.equal(res.status, 200);
    const catalog = await res.json();
    assert.equal(catalog.tones.length, 7);

    res = await fetch(`${baseUrl}/admin/api/prompts/duckai/preview`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ customization: { tone: 'Professional', length: 'Shortest' } })
    });
    assert.equal(res.status, 200);
    const preview = await res.json();
    assert.equal(
      preview.prompt,
      `${TONE_PROMPTS.Professional} ${LENGTH_PROMPTS.Shortest}`
    );
    assert.equal(preview.length, preview.prompt.length);
  });
});

test('配置：prompts.source 可改、非法值被拒绝；默认 duckai', async () => {
  const H = {
    authorization: `Bearer ${makeConfig().auth.adminToken}`,
    'content-type': 'application/json'
  };
  await withServer({}, async ({ baseUrl }) => {
    const current = await (await fetch(`${baseUrl}/admin/api/config`, { headers: H })).json();
    assert.equal(current.config.prompts.source, 'duckai', '默认来源应为 duckai');

    let res = await fetch(`${baseUrl}/admin/api/config`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ prompts: { source: 'duckai', duckai: { tone: 'Casual' } } })
    });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.config.prompts.source, 'duckai');
    assert.equal(saved.config.prompts.duckai.tone, 'Casual');

    res = await fetch(`${baseUrl}/admin/api/config`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ prompts: { source: 'bogus' } })
    });
    assert.equal(res.status, 400, '非法 prompts.source 应被拒绝');
  });
});
