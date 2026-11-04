/**
 * v2 免费 / 付费模型（docs/ADMIN_API_V2.md §4）。
 *
 * 断言：
 *   - /v1/models 每项含 paid/tier/available/requires_subscription/display_name/
 *     supported_reasoning_efforts/tools；
 *   - 免费 6 个（available=true）、付费 4 个（默认 available=false, requires_subscription=true）；
 *   - 默认 allowPaidModels=false：请求付费模型 → 403 model_requires_subscription（不触达上游）；
 *   - allowPaidModels=true：放行到上游；上游 ERR_ACCOUNT_LIMIT → 403 upstream_subscription_required。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, v1Request } from './helpers/test-server.js';
import { MockDuckClient } from './helpers/mock-duck.js';

const FREE_MODELS = [
  'gpt-6-luna',
  'gpt-5.4-mini',
  'claude-haiku-4-5',
  'mistral-small-2603',
  'tinfoil/gpt-oss-120b',
  'tinfoil/gemma4-31b'
];
const PAID_MODELS = ['gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5-5', 'claude-opus-5-5'];

function findModel(models, id) {
  return models.find((model) => model.id === id);
}

function chatBody(model, content = 'hi') {
  return { model, messages: [{ role: 'user', content }] };
}

test('/v1/models：免费/付费字段齐全且分类正确（默认 allowPaidModels=false）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/models');
    assert.equal(res.status, 200);
    assert.equal(res.json.object, 'list');
    const models = res.json.data;
    assert.ok(Array.isArray(models) && models.length >= 10);

    // 每项字段齐全
    for (const model of models) {
      assert.equal(typeof model.paid, 'boolean', `${model.id}.paid must be boolean`);
      assert.equal(typeof model.tier, 'string', `${model.id}.tier must be string`);
      assert.equal(typeof model.available, 'boolean', `${model.id}.available must be boolean`);
      assert.equal(
        typeof model.requires_subscription,
        'boolean',
        `${model.id}.requires_subscription must be boolean`
      );
      assert.equal(typeof model.display_name, 'string', `${model.id}.display_name must be string`);
      assert.ok(
        Array.isArray(model.supported_reasoning_efforts),
        `${model.id}.supported_reasoning_efforts must be array`
      );
      assert.ok(Array.isArray(model.tools), `${model.id}.tools must be array`);
      assert.equal(typeof model.owned_by, 'string');
    }

    for (const id of FREE_MODELS) {
      const model = findModel(models, id);
      assert.ok(model, `free model ${id} missing`);
      assert.equal(model.paid, false, `${id} should be free`);
      assert.equal(model.available, true, `${id} should be available`);
      assert.equal(model.requires_subscription, false, `${id} should not require subscription`);
    }

    for (const id of PAID_MODELS) {
      const model = findModel(models, id);
      assert.ok(model, `paid model ${id} missing`);
      assert.equal(model.paid, true, `${id} should be paid`);
      assert.equal(model.available, false, `${id} should be unavailable by default`);
      assert.equal(model.requires_subscription, true, `${id} should require subscription`);
    }

    const opus = findModel(models, 'claude-opus-5-5');
    assert.equal(opus.tier, 'pro');
    assert.equal(opus.reasoning, true);
    assert.ok(opus.tools.includes('web_search'));
  });
});

test('默认 allowPaidModels=false：付费模型请求 → 403 model_requires_subscription，不触达上游', async () => {
  for (const id of ['claude-opus-5-5', 'gpt-5.6-sol']) {
    const duck = new MockDuckClient();
    await withServer({ duck }, async ({ baseUrl }) => {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: chatBody(id)
      });
      assert.equal(res.status, 403, `${id} should be rejected with 403`);
      assert.equal(res.json.error.type, 'model_unavailable');
      assert.equal(res.json.error.code, 'model_requires_subscription');
      assert.equal(res.json.error.param, 'model');
      assert.match(res.json.error.message, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(duck.calls.chat.length, 0, 'paid model request must not reach DuckClient');
    });
  }

  // responses / images 同样受付费拦截
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const responses = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'claude-opus-5-5', input: 'hi' }
    });
    assert.equal(responses.status, 403);
    assert.equal(responses.json.error.code, 'model_requires_subscription');

    const images = await v1Request(baseUrl, '/v1/images/generations', {
      method: 'POST',
      body: { model: 'claude-opus-5-5', prompt: 'a duck' }
    });
    assert.equal(images.status, 403);
    assert.equal(images.json.error.code, 'model_requires_subscription');

    assert.equal(duck.calls.chat.length + duck.calls.imageGeneration.length, 0);
  });
});

test('免费模型默认放行（gpt-6-luna 与别名 gpt-6）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    for (const model of ['gpt-6-luna', 'gpt-6']) {
      const res = await v1Request(baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: chatBody(model)
      });
      assert.equal(res.status, 200, `free model ${model} should pass`);
      assert.equal(res.json.choices[0].message.content.length > 0, true);
    }
    assert.equal(duck.calls.chat.length, 2);
    assert.equal(duck.calls.chat[1].params.model, 'gpt-6-luna', 'alias gpt-6 resolves to gpt-6-luna');
  });
});

test('allowPaidModels=true：付费模型放行到上游；上游 ERR_ACCOUNT_LIMIT → 403 upstream_subscription_required', async () => {
  const duck = new MockDuckClient();
  const config = makeConfig({ duck: { allowPaidModels: true } });
  await withServer({ duck, config }, async ({ baseUrl }) => {
    const ok = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: chatBody('claude-opus-5-5', 'hi')
    });
    assert.equal(ok.status, 200, 'allowPaidModels=true must let paid model through');
    assert.equal(duck.calls.chat.length, 1);
    assert.equal(duck.calls.chat[0].params.model, 'claude-opus-5-5');
  });

  const limited = new MockDuckClient();
  limited.chatBehavior = {
    ...limited.chatBehavior,
    error: Object.assign(new Error('account limit: subscription required'), {
      name: 'DuckError',
      status: 403,
      type: 'ERR_ACCOUNT_LIMIT',
      retriable: false
    })
  };
  await withServer({ duck: limited, config }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: chatBody('gpt-5.6-terra')
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'upstream_subscription_required');
  });
});

test('未知模型仍 400 model_not_found（与付费拦截区分）', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const res = await v1Request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: chatBody('gpt-404-not-exist')
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'model_not_found');
    assert.equal(duck.calls.chat.length, 0);
  });
});

test('admin /admin/api/models 同样暴露付费元数据', async () => {
  const duck = new MockDuckClient();
  await withServer({ duck }, async ({ baseUrl }) => {
    const { adminRequest } = await import('./helpers/test-server.js');
    const res = await adminRequest(baseUrl, '/admin/api/models');
    assert.equal(res.status, 200);
    const opus = res.json.items.find((model) => model.id === 'claude-opus-5-5');
    assert.ok(opus);
    assert.equal(opus.paid, true);
    assert.equal(opus.requires_subscription, true);
    assert.equal(opus.default, false);
  });
});
