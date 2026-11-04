/** v2.21：模型配置页 API（/admin/api/models/config）+ /v1/models 覆盖生效。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, makeConfig, request, v1Request } from './helpers/test-server.js';

async function adminRequest(baseUrl, pathName, options = {}) {
  return request(baseUrl, `/admin/api${pathName}`, {
    ...options,
    headers: { authorization: `Bearer ${makeConfig().auth.adminToken}`, ...(options.headers || {}) }
  });
}

test('GET /admin/api/models/config：返回每个模型的默认值/覆盖/生效值', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/models/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.object, 'model_config');
    assert.ok(Array.isArray(res.json.items) && res.json.items.length >= 10);
    const luna = res.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.ok(luna);
    assert.equal(luna.defaults.context_window_chars, 20000);
    assert.equal(luna.defaults.max_input_chars, 19500);
    assert.equal(luna.defaults.max_output_tokens, 4096);
    assert.equal(luna.compaction_supported, false);
    assert.equal(luna.session_limit_behavior, 'new_chat');
    assert.equal(luna.override, null);
    assert.equal(luna.effective.context_window_chars, 20000);
    const mini = res.json.items.find((item) => item.id === 'gpt-5.4-mini');
    assert.equal(mini.session_limit_behavior, 'summarize_and_continue');
    assert.ok(res.json.limits.context_window_chars.max >= 20000);
    assert.equal(res.json.defaults.context_window_chars, 20000);
  });
});

test('PUT /admin/api/models/config：覆盖写入后在 /v1/models 与管理模型列表生效', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const put = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { overrides: { 'gpt-6-luna': { context_window_chars: 32000, max_input_chars: 30000, max_output_tokens: 8192 } } }
    });
    assert.equal(put.status, 200);
    const luna = put.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.equal(luna.override.context_window_chars, 32000);
    assert.equal(luna.effective.context_window_chars, 32000);
    assert.equal(luna.effective.max_input_chars, 30000);
    assert.equal(luna.effective.max_output_tokens, 8192);
    assert.equal(luna.effective.max_output_tokens_estimated, false);

    const models = await v1Request(baseUrl, '/v1/models');
    const v1Luna = models.json.data.find((model) => model.id === 'gpt-6-luna');
    assert.equal(v1Luna.context_window_chars, 32000);
    assert.equal(v1Luna.max_input_chars, 30000);
    assert.equal(v1Luna.max_output_tokens, 8192);
    assert.equal(v1Luna.max_output_tokens_estimated, false);

    const admin = await adminRequest(baseUrl, '/models');
    const adminLuna = admin.json.items.find((model) => model.id === 'gpt-6-luna');
    assert.equal(adminLuna.max_output_tokens, 8192);

    // 恢复默认（null）
    const reset = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { overrides: { 'gpt-6-luna': null } }
    });
    assert.equal(reset.status, 200);
    const restored = reset.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.equal(restored.override, null);
    assert.equal(restored.effective.context_window_chars, 20000);
  });
});

test('PUT /admin/api/models/config：未知模型/越界值/字段关系错误 → 400', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const unknown = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { overrides: { 'not-a-model': { max_output_tokens: 1024 } } }
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.code, 'invalid_model_override');

    const outOfRange = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { overrides: { 'gpt-6-luna': { max_input_chars: 999999 } } }
    });
    assert.equal(outOfRange.status, 400);

    const relation = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { overrides: { 'gpt-6-luna': { context_window_chars: 1000, max_input_chars: 2000 } } }
    });
    assert.equal(relation.status, 400);
  });
});


/* ------------------------------------------------------------------ */
/* v2.22：每模型工具开关 + 不支持工具的处理策略 + 刷新上游能力           */
/* ------------------------------------------------------------------ */

test('GET /admin/api/models/config：返回每模型 tools（仅 supported 可开关）与 strict 开关', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/models/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.drop_unsupported_tool, true, '默认静默清理（不报错）');
    assert.deepEqual(res.json.tool_names, ['web_search', 'image_generation']);
    const luna = res.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.deepEqual(
      luna.tools.map((tool) => [tool.name, tool.supported, tool.enabled]),
      [
        ['web_search', true, true],
        ['image_generation', true, true]
      ]
    );
    // mistral 不支持任何工具 → UI 不显示开关
    const mistral = res.json.items.find((item) => item.id === 'mistral-small-2603');
    assert.equal(mistral.tools.filter((tool) => tool.supported).length, 0);
    assert.deepEqual(mistral.tools_supported, []);
  });
});

test('PUT /admin/api/models/config：关闭某模型工具后生效（/v1/models tools 减少）', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const put = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: { 'gpt-6-luna': { image_generation: false } } } }
    });
    assert.equal(put.status, 200, put.text);
    const luna = put.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.deepEqual(luna.tools_enabled, ['web_search']);
    assert.deepEqual(luna.tools_disabled, ['image_generation']);

    const models = await v1Request(baseUrl, '/v1/models');
    const v1Luna = models.json.data.find((model) => model.id === 'gpt-6-luna');
    assert.deepEqual(v1Luna.tools, ['web_search'], '/v1/models 只应暴露生效工具');
    assert.deepEqual(v1Luna.tools_supported, ['web_search', 'image_generation']);
    assert.deepEqual(v1Luna.tools_disabled, ['image_generation']);

    // 恢复
    const reset = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: {} } }
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.json.items.find((item) => item.id === 'gpt-6-luna').tools_enabled, [
      'web_search',
      'image_generation'
    ]);
  });
});

test('PUT /admin/api/models/config：dropUnsupported（静默清理）开关持久化', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const on = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { dropUnsupported: true } }
    });
    assert.equal(on.status, 200);
    assert.equal(on.json.drop_unsupported_tool, true);

    const get = await adminRequest(baseUrl, '/models/config');
    assert.equal(get.json.drop_unsupported_tool, true);

    const off = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { dropUnsupported: false } }
    });
    assert.equal(off.json.drop_unsupported_tool, false);
  });
});

test('PUT /admin/api/models/config：不支持的工具/未知模型/非布尔 → 400', async () => {
  await withServer({}, async ({ baseUrl }) => {
    // mistral 不支持任何工具 → 不允许开启
    const unsupported = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: { 'mistral-small-2603': { web_search: true } } } }
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.json.error.code, 'invalid_model_override');

    const unknownModel = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: { 'not-a-model': { web_search: true } } } }
    });
    assert.equal(unknownModel.status, 400);

    const nonBoolean = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: { 'gpt-6-luna': { web_search: 'yes' } } } }
    });
    assert.equal(nonBoolean.status, 400);

    const unknownTool = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: { tools: { perModel: { 'gpt-6-luna': { function_calling: true } } } }
    });
    assert.equal(unknownTool.status, 400);
  });
});

test('POST /admin/api/models/refresh：返回静态目录来源与上游能力快照', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/models/refresh', { method: 'POST' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.catalogSource, 'static');
    assert.match(String(res.json.catalogNote || ''), /静态|static/);
    assert.ok(res.json.modelCount >= 10);
    assert.equal(typeof res.json.probedAt, 'number');
    assert.equal(res.json.ok, true);
  });
});

test('POST /admin/api/models/config/reset：完整重置覆盖/工具/静默清理开关', async () => {
  await withServer({}, async ({ baseUrl }) => {
    // 先制造自定义状态
    const custom = await adminRequest(baseUrl, '/models/config', {
      method: 'PUT',
      body: {
        overrides: { 'gpt-6-luna': { max_output_tokens: 8192 } },
        tools: { dropUnsupported: false, perModel: { 'gpt-6-luna': { image_generation: false } } }
      }
    });
    assert.equal(custom.status, 200, custom.text);
    assert.equal(custom.json.drop_unsupported_tool, false);
    const lunaCustom = custom.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.equal(lunaCustom.tools_enabled.includes('image_generation'), false);

    const reset = await adminRequest(baseUrl, '/models/config/reset', { method: 'POST' });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.json.ok, true);
    assert.equal(reset.json.drop_unsupported_tool, true, '重置后恢复静默清理默认值');
    const luna = reset.json.items.find((item) => item.id === 'gpt-6-luna');
    assert.equal(luna.override, null);
    assert.deepEqual(luna.tools_enabled, ['web_search', 'image_generation']);

    // 持久化确认
    const again = await adminRequest(baseUrl, '/models/config');
    assert.equal(again.json.drop_unsupported_tool, true);
    assert.equal(again.json.items.find((item) => item.id === 'gpt-6-luna').override, null);
  });
});
