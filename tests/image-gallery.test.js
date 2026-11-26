/**
 * 图片工坊（ChatGPT Images 风格）提示词引擎与 SQLite 画廊 Admin API 测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { composeImagePrompt } from '../src/openai/image-prompt.js';
import { withServer, adminRequest } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';

test('composeImagePrompt：正确组装风格/画幅/光影，auto 且无选项时保持原句', () => {
  assert.equal(composeImagePrompt({ prompt: '一只橘猫' }), '一只橘猫');
  const rich = composeImagePrompt({
    prompt: '霓虹雨夜街角',
    style: 'cyberpunk',
    aspectRatio: '16:9',
    mood: 'neon-night',
    negativePrompt: '模糊, 水印'
  });
  assert.match(rich, /Cyberpunk/);
  assert.match(rich, /16:9/);
  assert.match(rich, /nocturnal lighting/);
  assert.match(rich, /Avoid: 模糊, 水印/);
});

test('images admin API：presets / generate（不带非法字段）/ gallery / 微调 parentId / 删除', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({
    images: [{ b64: PNG_1X1_B64, format: 'png', id: 'up_img_1', moderationToken: 'mod_1', width: 1024, height: 1024, modelDisplayName: 'GPT Image' }]
  });
  duck.enqueueChat({
    images: [{ b64: PNG_1X1_B64, format: 'png', id: 'up_img_2', width: 1024, height: 1024 }]
  });

  await withServer({ duck }, async ({ baseUrl }) => {
    const presetsRes = await adminRequest(baseUrl, '/admin/api/images/presets');
    assert.equal(presetsRes.status, 200);
    assert.ok(presetsRes.json.styles.length >= 10);
    assert.ok(presetsRes.json.aspectRatios.length >= 5);
    assert.ok(presetsRes.json.models.some((m) => m.id === 'gpt-6-luna'));

    // 首次生成（带风格/画幅，断言 duck.calls.chat[0].params 没有多余非标字段）
    const gen1 = await adminRequest(baseUrl, '/admin/api/images/generate', {
      method: 'POST',
      body: {
        prompt: '太空柴犬',
        style: '3d-render',
        aspectRatio: '16:9',
        mood: 'golden-hour',
        model: 'gpt-6-luna'
      }
    });
    assert.equal(gen1.status, 200, gen1.text);
    assert.equal(gen1.json.items.length, 1);
    const createdId = gen1.json.items[0].id;
    const call1 = duck.calls.chat[0].params;
    assert.equal(call1.imageGeneration, true);
    assert.equal(call1.style, undefined);
    assert.equal(call1.aspectRatio, undefined);
    assert.match(call1.messages[0].content, /16:9/);

    // 基于画廊作品继续微调（parentId → assistant 携带 kind:'generated' 原图回放）
    const gen2 = await adminRequest(baseUrl, '/admin/api/images/generate', {
      method: 'POST',
      body: {
        prompt: '给它戴上一顶小皇冠',
        style: '3d-render',
        parentId: createdId,
        model: 'gpt-6-luna'
      }
    });
    assert.equal(gen2.status, 200, gen2.text);
    const call2Messages = duck.calls.chat[1].params.messages;
    assert.equal(call2Messages.length, 3);
    assert.equal(call2Messages[1].role, 'assistant');
    assert.equal(call2Messages[1].images[0].kind, 'generated');
    assert.equal(call2Messages[1].images[0].id, 'up_img_1');

    // 画廊列表与删除
    const list = await adminRequest(baseUrl, '/admin/api/images/gallery');
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 2);

    const del = await adminRequest(baseUrl, `/admin/api/images/gallery/${createdId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, true);

    const listAfter = await adminRequest(baseUrl, '/admin/api/images/gallery');
    assert.equal(listAfter.json.items.length, 1);
  });
});
