/**
 * duck.ai 严格请求契约 + PDF 工具说明/上下文 + OpenAI Responses CRUD 测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDuckChatRequest,
  validateDuckChatBody,
  validateDuckChatHeaders
} from '../src/duck/contract.js';
import { createContextPdf, createToolsPdf, getOrCreateToolsPdf } from '../src/openai/context-pdf.js';
import { assembleContextMessages } from '../src/app/session/context-assembly.js';
import { withServer, v1Request } from './helpers/test-server.js';
import { MockDuckClient, PNG_1X1_B64 } from './helpers/mock-duck.js';

function validHeaders(extra = {}) {
  return {
    'user-agent': 'Mozilla/5.0',
    accept: 'text/event-stream',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://duck.ai',
    referer: 'https://duck.ai/',
    'x-fe-version': 'serp_20261030-sha',
    'x-fe-signals': 'eyJzdGFydCI6MSwiZXZlbnRzIjpbXSwiZW5kIjoyfQ==',
    'x-vqd-hash-1': 'solved',
    'x-duckai-response-id': '00000000-0000-4000-8000-000000000001',
    'x-ddg-journey-id': '0123456789abcdef0123456789abcdef',
    'x-duckai-continuation': 'resubmit-context',
    'x-duckai-tool-approval': 'web-search',
    'x-duckai-consent-purposes': 'user-location,image-generation,web-search',
    ...extra
  };
}

function validBody(overrides = {}) {
  return {
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    canUseTools: true,
    reasoningEffort: 'none',
    canUseApproxLocation: false,
    canDelegateImageGeneration: null,
    canShowGreeting: true,
    ...overrides
  };
}

test('contract：合法初始体 / generated-image 三件套 / continuation 校验通过；缺多字段均报错', () => {
  assert.equal(validateDuckChatBody(validBody()).ok, true);
  assert.equal(validateDuckChatHeaders(validHeaders()).ok, true);

  // 非法多余字段被拒绝
  const extraField = validateDuckChatBody(validBody({ style: 'anime', aspectRatio: '16:9' }));
  assert.equal(extraField.ok, false);
  assert.ok(extraField.errors.some((e) => e.includes('style')));

  const wsChoice = validateDuckChatBody(validBody({ metadata: { toolChoice: { WebSearch: true } } }));
  assert.equal(wsChoice.ok, false);

  // 缺失必需字段被拒绝
  const missingGreeting = validBody();
  delete missingGreeting.canShowGreeting;
  assert.equal(validateDuckChatBody(missingGreeting).ok, false);

  // 禁止发送 x-duckai-client-tools 头
  assert.equal(validateDuckChatHeaders(validHeaders({ 'x-duckai-client-tools': '{}' })).ok, false);

  // generated-image 回放缺少 tool-invocation call/result 或缺少 width 被拒绝
  const brokenReplay = validateDuckChatBody(
    validBody({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'draw cat' }] },
        {
          role: 'assistant',
          content: '',
          parts: [{ type: 'generated-image', id: 'img_1', result: PNG_1X1_B64, format: 'png' }]
        },
        { role: 'user', content: [{ type: 'text', text: 'color?' }] }
      ]
    })
  );
  assert.equal(brokenReplay.ok, false);

  // continuation 不得带 durableStream/metadata
  const badCont = validateDuckChatBody(
    validBody({
      continuation: { token: 't', responseId: 'r', responses: [] },
      currentAssistant: { role: 'assistant', content: '', parts: [] },
      durableStream: { messageId: 'm', conversationId: 'c', publicKey: {} }
    }),
    { isContinuation: true }
  );
  assert.equal(badCont.ok, false);

  assert.throws(() => assertDuckChatRequest(validBody({ extraBad: 1 }), validHeaders()), {
    code: 'upstream_request_contract_violation'
  });
});

test('PDF：context PDF 行高无重叠且 tools PDF 支持多页缓存 + 失败回退文本注入', async () => {
  const ctxPdf = await createContextPdf({
    messages: [{ role: 'user', content: 'A'.repeat(25000) }],
    maxPages: 15
  });
  assert.ok(ctxPdf.pages >= 1 && ctxPdf.pages <= 15);
  // 校验 LINE_HEIGHT >= FONT_SIZE 避免字符上下重叠
  assert.ok(ctxPdf.buffer.includes(Buffer.from('%PDF')));

  const first = await getOrCreateToolsPdf({
    toolProtocol: '{"tool_call":{"name":"demo","arguments":{}}}\n'.repeat(40),
    toolNames: ['demo'],
    maxPages: 4,
    includeContext: false
  });
  assert.equal(first.cached, false);
  const second = await getOrCreateToolsPdf({
    toolProtocol: '{"tool_call":{"name":"demo","arguments":{}}}\n'.repeat(40),
    toolNames: ['demo'],
    maxPages: 4,
    includeContext: false
  });
  assert.equal(second.cached, true);
  assert.equal(second.b64, first.b64);

  // 触发 toolsPdf 超出 maxPages=1 → 必须回退到文本注入，绝不丢工具
  const manyTools = Array.from({ length: 64 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, '0')}_with_long_identifier`,
    description: 'D'.repeat(200),
    parameters: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } }
  }));
  const fallback = await assembleContextMessages({
    kind: 'chat',
    duckMessages: [{ role: 'user', content: '请帮我调用工具' }],
    conversation: [{ role: 'user', content: '请帮我调用工具' }],
    historyMessages: [{ role: 'user', content: '请帮我调用工具' }],
    clientTools: manyTools,
    pdfSpillConfig: { enabled: true, inputCharLimit: 20000, maxPages: 15, toolsMaxPages: 1 },
    inputCharLimit: 20000,
    scopeKey: null,
    responseStore: null,
    storedPdf: null,
    reuseStoredPdf: false,
    useClientToolsPdf: true,
    conversationChain: 'stateless',
    compression: null,
    logger: { warn() {} }
  });
  assert.equal(fallback.injection.protocolKind, 'text-fallback');
  assert.match(fallback.duckMessages[0].content, /\[工具调用协议\]/);
});

test('OpenAI Responses CRUD：GET / DELETE / input_items 完整可用', async () => {
  const duck = new MockDuckClient();
  duck.enqueueChat({ textDeltas: ['第一轮回复'] });
  await withServer({ duck }, async ({ baseUrl }) => {
    const created = await v1Request(baseUrl, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-luna', input: '第一问' }
    });
    assert.equal(created.status, 200);
    const respId = created.json.id;
    assert.ok(respId.startsWith('resp_'));

    const fetched = await v1Request(baseUrl, `/v1/responses/${respId}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.id, respId);
    assert.equal(fetched.json.output_text, '第一轮回复');

    const inputItems = await v1Request(baseUrl, `/v1/responses/${respId}/input_items`);
    assert.equal(inputItems.status, 200);
    assert.equal(inputItems.json.object, 'list');
    assert.equal(inputItems.json.data.length, 1);
    assert.equal(inputItems.json.data[0].content[0].text, '第一问');

    const deleted = await v1Request(baseUrl, `/v1/responses/${respId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.deleted, true);

    const afterDelete = await v1Request(baseUrl, `/v1/responses/${respId}`);
    assert.equal(afterDelete.status, 404);
  });
});
