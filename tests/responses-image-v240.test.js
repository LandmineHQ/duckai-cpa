/**
 * v2.40：/v1/responses 生图后继续对话 + 生图空消息兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, v1Request } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';

function newDuck(chat = {}) {
  const duck = new MockDuckClient();
  duck.chatBehavior = { ...duck.chatBehavior, ...chat };
  return duck;
}

test('/v1/responses 生图：只有图片时 output_text 非空 + message item 兜底', async () => {
  const duck = newDuck({ textDeltas: [], images: [{ b64: PNG_1X1_B64, format: 'png' }] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '画一只橘猫', tools: [{ type: 'image_generation' }] }
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.text);
    const types = (payload.output || []).map((item) => item.type);
    assert.ok(types.includes('image_generation_call'), `应包含 image_generation_call：${types}`);
    assert.ok(types.includes('message'), `应包含兜底 message：${types}`);
    assert.ok(payload.output_text && payload.output_text.length > 0, 'output_text 不能为空');
    const image = payload.output.find((item) => item.type === 'image_generation_call');
    assert.equal(image.result, PNG_1X1_B64);
  });
});

test('/v1/responses：下一轮 input 带上一轮 image_generation_call item → 200（不 400）', async () => {
  const duck = newDuck({ textDeltas: ['这只猫是橘色的。'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: {
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: '画一只戴帽子的橘猫' },
          {
            type: 'image_generation_call',
            id: 'ig_test',
            status: 'completed',
            result: PNG_1X1_B64,
            output_format: 'png'
          },
          { role: 'user', content: '继续：这只猫是什么颜色？' }
        ]
      }
    });
    assert.equal(res.status, 200, res.text);
    const payload = JSON.parse(res.text);
    assert.equal(payload.output_text, '这只猫是橘色的。');
    // 上游消息里应包含图片占位文本（不把 base64 塞进提示词）
    const lastCall = duck.calls.chat.at(-1);
    const promptText = JSON.stringify(lastCall.params.messages);
    assert.ok(promptText.includes('image_generation_call'), '应包含生图占位文本');
  });
});
