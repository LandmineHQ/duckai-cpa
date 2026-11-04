/**
 * SSE 解析与事件归一化单测（src/duck/sse.js）。
 *
 * 用真实抓包回放（tests/fixtures/sse/*.sse，形态来自 recon/TEAM-NOTES.md）覆盖：
 * 文本增量、[PING]、[CHAT_TITLE]、tool-invocation call/result、data.citations、
 * role:"source"、ui-component generate-image（placement/partial/success）、
 * [DONE]、错误 action。并验证分块/CRLF/无结尾换行等流式边界。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseSSELine,
  readSSEStream,
  normalizeSSEPayload,
  normalizeUpstreamEvent,
  extractCitations,
  normalizeSources,
  collectCitationIds,
  stripCitationMarkers,
  citationsToMarkdown,
  consumeSSE,
  CITATION_MARKER_RE
} from '../src/duck/sse.js';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'sse');
const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

/** Build a ReadableStream from text, splitting into deliberately awkward chunks. */
function streamFromText(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
}

async function readAllRecords(text, chunkSize = 7) {
  const records = [];
  for await (const record of readSSEStream(streamFromText(text, chunkSize))) records.push(record);
  return records;
}

async function normalizeFixture(name, chunkSize = 7) {
  const records = await readAllRecords(fixture(name), chunkSize);
  const dataRecords = records.filter((record) => record.field === 'data');
  return dataRecords.flatMap((record) => normalizeSSEPayload(record.value));
}

/* ------------------------------------------------------------------ */
/* 行级解析                                                            */
/* ------------------------------------------------------------------ */

test('parseSSELine: 只识别 SSE 字段，忽略注释与非法行', () => {
  assert.deepEqual(parseSSELine('data: {"role":"assistant"}'), { field: 'data', value: '{"role":"assistant"}' });
  assert.deepEqual(parseSSELine('data:[DONE]'), { field: 'data', value: '[DONE]' });
  assert.deepEqual(parseSSELine('event: response.created'), { field: 'event', value: 'response.created' });
  assert.deepEqual(parseSSELine('id: 42'), { field: 'id', value: '42' });
  assert.deepEqual(parseSSELine('retry: 1000'), { field: 'retry', value: '1000' });
  assert.equal(parseSSELine(': keep-alive'), null);
  assert.equal(parseSSELine(''), null);
  assert.equal(parseSSELine('not an sse line'), null);
  assert.equal(parseSSELine('unknown: value'), null);
});

/* ------------------------------------------------------------------ */
/* 流式读取边界                                                        */
/* ------------------------------------------------------------------ */

test('readSSEStream: 任意分块边界都能逐行还原（text-stream fixture）', async () => {
  const records = await readAllRecords(fixture('text-stream.sse'), 3);
  assert.ok(records.length >= 10, `expected >=10 data records, got ${records.length}`);
  assert.ok(records.every((record) => record.field === 'data'));
  assert.equal(records[0].value, '[CHAT_TITLE:天空为什么是蓝色的]');
  assert.equal(records.at(-1).value, '[DONE]');
});

test('readSSEStream: 兼容 CRLF 与无结尾换行的最后一帧', async () => {
  const crlf = await readAllRecords('data: {"role":"assistant","message":"a"}\r\n\r\n', 11);
  assert.deepEqual(crlf, [{ field: 'data', value: '{"role":"assistant","message":"a"}' }]);

  const noTrailingNewline = await readAllRecords('data: {"a":1}', 4);
  assert.deepEqual(noTrailingNewline, [{ field: 'data', value: '{"a":1}' }]);

  const comments = await readAllRecords(': ping\n\ndata: x\n\n', 5);
  assert.deepEqual(comments, [{ field: 'data', value: 'x' }]);
});

/* ------------------------------------------------------------------ */
/* 伪事件与归一化                                                      */
/* ------------------------------------------------------------------ */

test('normalizeSSEPayload: [PING]/[CHAT_TITLE]/[DONE] 伪事件', () => {
  assert.deepEqual(normalizeSSEPayload('[PING]'), [{ type: 'ping' }]);
  assert.deepEqual(normalizeSSEPayload('[DONE]'), [{ type: 'done' }]);
  assert.deepEqual(normalizeSSEPayload('[CHAT_TITLE:New chat]'), [{ type: 'title', title: 'New chat' }]);
  assert.deepEqual(normalizeSSEPayload('[CHAT_TITLE:天空为什么是蓝色的]'), [{ type: 'title', title: '天空为什么是蓝色的' }]);
  assert.deepEqual(normalizeSSEPayload('   '), []);
});

test('normalizeSSEPayload: 文本增量 + 数组 payload + 未知事件', () => {
  const text = normalizeSSEPayload(
    '{"id":"msg_1","action":"success","created":1793514943982,"model":"gpt-6-luna","role":"assistant","message":"光"}'
  );
  assert.equal(text.length, 1);
  assert.equal(text[0].type, 'text');
  assert.equal(text[0].text, '光');
  assert.equal(text[0].raw.model, 'gpt-6-luna');

  // assistant 的 parts 形式（多轮历史/非增量）
  const parts = normalizeSSEPayload('{"role":"assistant","parts":[{"type":"text","text":"你"},{"type":"text","text":"好"}]}');
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, '你好');

  // 空 assistant 帧不能产生空文本事件
  assert.equal(normalizeSSEPayload('{"role":"assistant","message":""}')[0].type, 'text-empty');

  // v2：数组 payload 不再支持（严格模式视为 unknown 帧，由 strict 消费器中断）
  const many = normalizeSSEPayload(
    '[{"role":"assistant","message":"a"},{"role":"assistant","message":"b"}]'
  );
  assert.equal(many.length, 1);
  assert.equal(many[0].type, 'unknown');

  // 非 JSON → unknown；无 role 帧按 assistant keep-alive（text-empty）；未知 role → unknown-event
  assert.equal(normalizeSSEPayload('{oops')[0].type, 'unknown');
  assert.equal(normalizeSSEPayload('{"foo":1}')[0].type, 'text-empty');
  assert.equal(normalizeSSEPayload('{"role":"weird-unknown"}')[0].type, 'unknown-event');
});

test('text-stream fixture: 文本增量拼出完整回答', async () => {
  const events = await normalizeFixture('text-stream.sse', 5);
  assert.equal(events.filter((event) => event.type === 'title').length, 1);
  assert.equal(events.filter((event) => event.type === 'ping').length, 2);
  assert.equal(events.at(-1).type, 'done');
  const text = events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('');
  assert.equal(text, '光被大气中的分子散射蓝光。');
});

/* ------------------------------------------------------------------ */
/* WebSearch：tool-invocation / citations / source                     */
/* ------------------------------------------------------------------ */

test('search fixture: tool-invocation call/result、data.citations、role:"source"', async () => {
  const events = await normalizeFixture('search-stream.sse', 11);

  const calls = events.filter((event) => event.type === 'tool-call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'WebSearch');
  assert.equal(calls[0].callId, 'call_8f2c1d4e');
  assert.equal(typeof calls[0].args, 'object');
  assert.equal(calls[0].args.query, 'New York City weather November 1 2026 temperature');
  assert.deepEqual(calls[0].args.allowedDomains, ['open-web']);

  const results = events.filter((event) => event.type === 'tool-result');
  assert.equal(results.length, 1);
  // 上游 result 事件只带 toolCallId（无 toolName），通过 callId 与 call 关联。
  assert.equal(results[0].callId, 'call_8f2c1d4e');
  assert.equal(results[0].data.citations.length, 2);
  assert.equal(results[0].data.markerFormat, '<citation src="N"></citation>');

  const sources = events.filter((event) => event.type === 'source');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].source.site, 'AccuWeather');
  assert.equal(sources[1].source.url, 'https://weather.com/weather/today/l/10001:4:US');

  const text = events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('');
  assert.ok(text.includes('<citation src="0"></citation>'), 'assistant text keeps inline citation markers');
  assert.equal(stripCitationMarkers(text), '今天纽约气温约12°C，局部多云。');
  assert.deepEqual(collectCitationIds(text), ['0', '1']);
});

test('citations: extractCitations / normalizeSources / markdown 映射', async () => {
  const events = await normalizeFixture('search-stream.sse', 11);
  const toolResult = events.find((event) => event.type === 'tool-result');
  const sources = extractCitations(toolResult.data);

  assert.equal(sources.length, 2);
  const first = sources[0];
  assert.equal(first.id, 0);
  assert.equal(first.url, 'https://www.accuweather.com/en/us/new-york-city/10007/weather-forecast/349727');
  assert.equal(first.title, 'New York City, NY Weather Forecast | AccuWeather');
  assert.equal(first.siteName, 'AccuWeather');
  assert.equal(first.domain, 'accuweather.com');
  assert.deepEqual(first.chunkIds, ['c1']);
  assert.equal(sources[1].published, null);

  // urls-only 退化形态
  assert.deepEqual(extractCitations({ urls: ['https://a.example/x'] }), [
    { id: 1, url: 'https://a.example/x', title: 'https://a.example/x' }
  ]);
  assert.deepEqual(extractCitations(null), []);

  // 混合输入：字符串 / role:"source" 形态
  const normalized = normalizeSources([
    'https://plain.example/a',
    { url: 'https://b.example/b', site_name: 'B Site' },
    { title: 'no url' }
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].title, 'https://plain.example/a');
  assert.equal(normalized[1].siteName, 'B Site');

  const markdown = citationsToMarkdown('参考<citation src="0"></citation>与<citation src="1,9"></citation>', sources);
  assert.ok(markdown.includes('[0](https://www.accuweather.com/en/us/new-york-city/10007/weather-forecast/349727)'));
  assert.ok(markdown.includes('[1](https://weather.com/weather/today/l/10001:4:US)'));
  assert.ok(markdown.includes('[9]'), 'unknown citation id degrades to bare marker');

  // 正则导出可复用
  assert.ok(CITATION_MARKER_RE instanceof RegExp);
  CITATION_MARKER_RE.lastIndex = 0;
});

/* ------------------------------------------------------------------ */
/* 图片生成：ui-component generate-image                               */
/* ------------------------------------------------------------------ */

test('image fixture: placement/call/title/partial/result/success 全序列', async () => {
  const events = await normalizeFixture('image-stream.sse', 13);

  const placement = events.find((event) => event.type === 'ui-component' && event.state === 'placement');
  assert.ok(placement, 'missing ui-component placement');
  assert.equal(placement.name, 'generate-image');
  assert.equal(placement.toolName, 'GenerateImage');

  const call = events.find((event) => event.type === 'tool-call');
  assert.equal(call.name, 'GenerateImage');
  assert.equal(call.args.imageGenPrompt, '画一只戴墨镜的卡通鸭子，扁平插画风格');
  assert.equal(call.args.imageToUse, 'none');

  const title = events.find(
    (event) => event.type === 'ui-component' && event.data && event.data.type === 'image-title'
  );
  assert.ok(title.data.title.includes('卡通鸭子'));

  const partial = events.find(
    (event) => event.type === 'ui-component' && event.data && event.data.type === 'image-partial'
  );
  assert.equal(partial.data.status, 'partial');
  assert.equal(partial.data.format, 'jpeg');

  const finalImage = events.find(
    (event) => event.type === 'ui-component' && event.data && event.data.status === 'success'
  );
  assert.ok(finalImage, 'missing final generate-image success event');
  assert.equal(finalImage.data.imageModelDisplayName, 'GPT Image 2');
  assert.equal(finalImage.data.width, 1024);
  assert.equal(finalImage.data.height, 1024);
  assert.equal(finalImage.data.generationDurationMs, 9072);
  const bytes = Buffer.from(finalImage.data.b64Image, 'base64');
  assert.ok(bytes.length > 8);
  assert.equal(bytes[0], 0xff); // JPEG magic（上游最终图片为 jpeg）
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[2], 0xff);

  const toolResult = events.find((event) => event.type === 'tool-result');
  assert.equal(toolResult.result, 'Image generated successfully.');

  assert.equal(events.at(-1).type, 'done');
});

/* ------------------------------------------------------------------ */
/* 错误事件                                                            */
/* ------------------------------------------------------------------ */

test('error fixture: action:"error" 归一化为 error 事件', async () => {
  const events = await normalizeFixture('error-stream.sse', 9);
  const error = events.find((event) => event.type === 'error');
  assert.ok(error);
  assert.equal(error.status, 418);
  assert.equal(error.code, 'ERR_BN_LIMIT');
  assert.ok(error.message.includes('unsupported entrypoint'));

  // 真实 418 另一种形态：{"action":"error","type":"ERR_CHALLENGE"}
  const challengeError = normalizeUpstreamEvent({ action: 'error', status: 418, type: 'ERR_CHALLENGE', overrideCode: '8e04' });
  assert.equal(challengeError[0].type, 'error');
  assert.equal(challengeError[0].code, 'ERR_CHALLENGE');
  assert.equal(challengeError[0].status, 418);

  // 400 ERR_BAD_REQUEST（system role 被拒）
  const badRequest = normalizeUpstreamEvent({ action: 'error', status: 400, type: 'ERR_BAD_REQUEST' });
  assert.equal(badRequest[0].status, 400);
});

/* ------------------------------------------------------------------ */
/* consumeSSE 流式消费                                                 */
/* ------------------------------------------------------------------ */

test('consumeSSE: 事件计数、[DONE] 检测与 onEvent 回调', async () => {
  const text = fixture('image-stream.sse');
  const seen = [];
  const result = await consumeSSE(streamFromText(text, 17), { onEvent: (event) => seen.push(event) });

  assert.equal(result.sawDone, true);
  assert.equal(seen.length, result.events.length);
  assert.ok(result.events.some((event) => event.type === 'ui-component' && event.data?.status === 'success'));
  assert.ok(result.events.some((event) => event.type === 'tool-call'));
  assert.ok(result.events.some((event) => event.type === 'text'));

  // 无 body 时显式报错
  await assert.rejects(() => consumeSSE(null), /not readable/);
});

test('normalizeUpstreamEvent: 未知/非法输入不抛异常', () => {
  // v2：null/undefined 归类为 unknown-event（严格模式消费器会中断）
  assert.equal(normalizeUpstreamEvent(null)[0].type, 'unknown-event');
  assert.equal(normalizeUpstreamEvent(undefined)[0].type, 'unknown-event');
  assert.equal(normalizeUpstreamEvent({ role: 'reasoning', message: '思考中' })[0].type, 'reasoning');
  assert.equal(normalizeUpstreamEvent({ role: 'ui-component', state: 'data', name: 'search-results' })[0].type, 'ui-component');
  assert.equal(normalizeUpstreamEvent({ role: 'tool-invocation', state: 'weird' })[0].type, 'tool-invocation');
});
