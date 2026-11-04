#!/usr/bin/env node
/**
 * duckai-cpa 冒烟测试（scripts/smoke.js）
 *
 * 对**运行中的**网关做黑盒冒烟，或在本进程内用 mock DuckClient 起一个临时服务做全量检查。
 *
 * 用法：
 *   node scripts/smoke.js                          # 默认检查 http://127.0.0.1:8787（会真实调用 duck.ai）
 *   node scripts/smoke.js --base-url http://127.0.0.1:8787
 *   node scripts/smoke.js --no-upstream            # 只做本地检查（healthz/models[/admin]），跳过所有上游调用
 *   node scripts/smoke.js --mock                   # 进程内启动 mock 服务，跑完整检查（无需真实上游/网络）
 *   node scripts/smoke.js --search                 # 额外检查联网搜索 annotations（真实上游会多花 10–30s）
 *   node scripts/smoke.js --admin-token <token>    # 额外检查 /admin/api/overview（也可用 DUCKAI_CPA_ADMIN_TOKEN）
 *   node scripts/smoke.js --timeout 180000         # 单请求超时（毫秒，默认 120s；图片/搜索建议更长）
 *
 * 退出码：0 = 全部 PASS/SKIP；1 = 存在 FAIL；2 = 用法/启动错误。
 *
 * 环境变量：BASE_URL、DUCKAI_CPA_ADMIN_TOKEN、ADMIN_TOKEN。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;

function paint(color, text) {
  return useColor ? `${color}${text}${RESET}` : text;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    noUpstream: false,
    mock: false,
    search: false,
    apiKey: process.env.DUCKAI_CPA_API_KEY || process.env.OPENAI_API_KEY || '',
    adminToken: process.env.DUCKAI_CPA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    timeoutMs: 120000,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const eq = arg.indexOf('=');
      if (eq !== -1) return arg.slice(eq + 1);
      index += 1;
      return argv[index];
    };
    switch (true) {
      case arg === '-h' || arg === '--help':
        options.help = true;
        break;
      case arg === '--no-upstream':
        options.noUpstream = true;
        break;
      case arg === '--mock':
        options.mock = true;
        break;
      case arg === '--search':
        options.search = true;
        break;
      case arg === '--base-url' || arg.startsWith('--base-url='):
        options.baseUrl = String(takeValue('--base-url')).replace(/\/+$/, '');
        break;
      case arg === '--api-key' || arg.startsWith('--api-key='):
        options.apiKey = String(takeValue('--api-key') || '');
        break;
      case arg === '--admin-token' || arg.startsWith('--admin-token='):
        options.adminToken = String(takeValue('--admin-token') || '');
        break;
      case arg === '--timeout' || arg.startsWith('--timeout='):
        options.timeoutMs = Number(takeValue('--timeout')) || options.timeoutMs;
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (options.mock && options.noUpstream) {
    throw new UsageError('--mock 与 --no-upstream 不能同时使用（--mock 本身就是完整 mock 检查）');
  }
  if (!/^https?:\/\//.test(options.baseUrl)) {
    throw new UsageError(`--base-url 需要 http(s) 地址: ${options.baseUrl}`);
  }
  return options;
}

class UsageError extends Error {}

function printHelp() {
  console.log(`duckai-cpa smoke — 对运行中的网关做冒烟测试

用法:
  node scripts/smoke.js [选项]

选项:
  --base-url <url>      目标服务（默认 $BASE_URL 或 http://127.0.0.1:8787）
  --api-key <key>       /v1/* 必备 API Key（也可用 $DUCKAI_CPA_API_KEY / $OPENAI_API_KEY）
  --no-upstream         跳过所有依赖真实上游的检查（chat/responses/images/search）
  --mock                进程内启动 mock 服务并执行完整检查（不访问 duck.ai，自动使用测试 key）
  --search              额外检查联网搜索 url_citation 注解
  --admin-token <token> 额外检查 /admin/api/overview
  --timeout <ms>        单请求超时，默认 120000
  -h, --help            显示帮助

示例:
  node scripts/smoke.js --mock
  node scripts/smoke.js --no-upstream --api-key <key>
  node scripts/smoke.js --base-url http://127.0.0.1:8787 --api-key <key> --admin-token <token> --search
`);
}

/* ------------------------------------------------------------------ */
/* HTTP / SSE helpers                                                 */
/* ------------------------------------------------------------------ */

function makeClient(baseUrl, defaultTimeoutMs, apiKey = '') {
  const authHeaders = (pathName, headers) => {
    if (pathName.startsWith('/v1/') && apiKey && !headers.authorization) {
      return { authorization: `Bearer ${apiKey}`, ...headers };
    }
    return headers;
  };

  async function request(pathName, { method = 'GET', body, headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
    const init = {
      method,
      headers: authHeaders(pathName, { ...headers }),
      signal: AbortSignal.timeout(timeoutMs)
    };
    if (body !== undefined) {
      init.headers['content-type'] = init.headers['content-type'] || 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${pathName}`, init);
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /** Read an SSE response into `[{ event, data, json }]` (data parsed when JSON). */
  async function readSSE(response) {
    if (!response.body) throw new Error('响应没有 body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const events = [];
    let buffer = '';
    let eventName = null;
    let dataLines = [];

    const dispatch = () => {
      if (eventName === null && dataLines.length === 0) return;
      const data = dataLines.join('\n');
      let json = null;
      const trimmed = data.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = null;
        }
      }
      events.push({ event: eventName, data, json });
      eventName = null;
      dataLines = [];
    };

    const consumeLine = (raw) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      if (colon === -1) return;
      const field = line.slice(0, colon);
      let value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.length) consumeLine(buffer);
    dispatch();
    return events;
  }

  async function postSSE(pathName, body, { headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST',
      headers: authHeaders(pathName, { 'content-type': 'application/json', ...headers }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const events = await readSSE(response);
    return { response, events };
  }

  return { request, postSSE, readSSE };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64Bytes(b64) {
  return Buffer.from(String(b64 || ''), 'base64');
}

function isImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || webp;
}

function snippet(text, max = 60) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/* ------------------------------------------------------------------ */
/* Checks                                                             */
/* ------------------------------------------------------------------ */

const MODEL = 'gpt-6-luna';
const ADMIN_HEADER = (token) => ({ authorization: `Bearer ${token}` });

function buildChecks(options, client) {
  const upstream = !options.noUpstream;
  const adminToken = options.adminToken;

  return [
    {
      name: 'healthz',
      upstream: false,
      async run() {
        const res = await client.request('/healthz', { timeoutMs: Math.min(options.timeoutMs, 30000) });
        assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text)}`);
        assert(res.json && res.json.ok === true, '响应缺少 ok:true');
        assert(res.json.service === 'duckai-cpa', `service 字段异常: ${res.json.service}`);
        assert(typeof res.json.version === 'string', '缺少 version');
        assert(res.json.upstream && typeof res.json.upstream === 'object', '缺少 upstream 对象');
        if (upstream) {
          assert(res.json.upstream.ok === true, `上游不健康: ${JSON.stringify(res.json.upstream)}`);
        }
        return `version=${res.json.version} upstream=${res.json.upstream.ok} challenge=${res.json.upstream.challengeOk}`;
      }
    },
    {
      name: 'v1/models',
      upstream: false,
      async run() {
        const res = await client.request('/v1/models');
        assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text)}`);
        assert(res.json?.object === 'list', 'object 必须为 list');
        assert(Array.isArray(res.json.data) && res.json.data.length >= 5, '模型列表为空');
        const luna = res.json.data.find((model) => model.id === MODEL);
        assert(luna, `缺少默认模型 ${MODEL}`);
        assert(luna.object === 'model', '模型条目 object 必须为 model');
        assert(typeof luna.owned_by === 'string', '模型条目缺少 owned_by');
        // v2：免费/付费元数据
        assert(typeof luna.paid === 'boolean', '模型条目缺少 paid');
        assert(luna.paid === false, '默认模型应为免费模型');
        assert(typeof luna.available === 'boolean', '模型条目缺少 available');
        assert(Array.isArray(luna.supported_reasoning_efforts), '模型条目缺少 supported_reasoning_efforts');
        assert(Array.isArray(luna.tools), '模型条目缺少 tools');
        assert(typeof luna.display_name === 'string', '模型条目缺少 display_name');

        const paidModel = res.json.data.find((model) => model.paid === true);
        assert(paidModel, '缺少付费模型元数据（paid:true）');
        assert(paidModel.available === false, '默认付费模型应 available:false');
        assert(paidModel.requires_subscription === true, '付费模型应 requires_subscription:true');
        return `${res.json.data.length} models, default=${res.json.default_model || '(n/a)'}, paid=${paidModel.id}`;
      }
    },
    {
      name: 'v1/models/:id',
      upstream: false,
      async run() {
        const res = await client.request(`/v1/models/${encodeURIComponent(MODEL)}`);
        assert(res.status === 200, `HTTP ${res.status}`);
        assert(res.json?.id === MODEL, '单个模型 id 不一致');
        assert(res.json.object === 'model', '单个模型 object 必须为 model');
        return `id=${res.json.id}`;
      }
    },
    {
      name: 'chat 非流式',
      upstream: true,
      async run() {
        const res = await client.request('/v1/chat/completions', {
          method: 'POST',
          body: { model: MODEL, messages: [{ role: 'user', content: '用半句话介绍你自己。' }] },
          timeoutMs: options.timeoutMs
        });
        assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text, 200)}`);
        const body = res.json;
        assert(body?.object === 'chat.completion', 'object 必须为 chat.completion');
        const message = body.choices?.[0]?.message;
        assert(message && message.role === 'assistant', '缺少 assistant 消息');
        assert(typeof message.content === 'string' && message.content.trim().length > 0, 'content 为空');
        assert(body.usage && typeof body.usage.total_tokens === 'number', '缺少 usage');
        return `${message.content.length} chars: ${snippet(message.content)}`;
      }
    },
    {
      name: 'chat 流式',
      upstream: true,
      async run() {
        const { response, events } = await client.postSSE('/v1/chat/completions', {
          model: MODEL,
          stream: true,
          messages: [{ role: 'user', content: '用一句话说明天空为什么是蓝色。' }]
        });
        assert(response.status === 200, `HTTP ${response.status}`);
        assert(/text\/event-stream/.test(response.headers.get('content-type') || ''), '不是 text/event-stream');
        assert(events.length > 0, '没有收到任何 SSE 事件');
        assert(events.at(-1).data.trim() === '[DONE]', '缺少 [DONE] 结束帧');
        const chunks = events.filter((event) => event.json).map((event) => event.json);
        assert(chunks.length > 0, '没有 chat.completion.chunk');
        const content = chunks
          .map((chunk) => chunk.choices?.[0]?.delta?.content || '')
          .join('');
        assert(content.trim().length > 0, '流式 content 为空');
        const finished = chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop');
        assert(finished, '缺少 finish_reason:"stop" 帧');
        return `${chunks.length} chunks, ${content.length} chars: ${snippet(content)}`;
      }
    },
    {
      name: 'responses 流式',
      upstream: true,
      async run() {
        const { response, events } = await client.postSSE('/v1/responses', {
          model: MODEL,
          input: '用一句话说明地球为什么是圆的。',
          stream: true
        });
        assert(response.status === 200, `HTTP ${response.status}`);
        assert(/text\/event-stream/.test(response.headers.get('content-type') || ''), '不是 text/event-stream');
        const named = events.filter((event) => event.event);
        const names = named.map((event) => event.event);
        assert(names[0] === 'response.created', `首个事件应为 response.created，实际 ${names[0]}`);
        assert(names.includes('response.output_text.delta'), '缺少 response.output_text.delta');
        assert(names.at(-1) === 'response.completed', `最后事件应为 response.completed，实际 ${names.at(-1)}`);
        const text = named
          .filter((event) => event.event === 'response.output_text.delta')
          .map((event) => event.json?.delta || '')
          .join('');
        assert(text.trim().length > 0, 'output_text 增量为空');
        const payloads = named.map((event) => event.json);
        payloads.forEach((payload, index) => {
          assert(payload.sequence_number === index, `sequence_number 不连续（第 ${index} 个为 ${payload.sequence_number}）`);
        });
        return `${named.length} events, ${text.length} chars: ${snippet(text)}`;
      }
    },
    {
      name: 'images b64',
      upstream: true,
      async run() {
        const res = await client.request('/v1/images/generations', {
          method: 'POST',
          body: { model: MODEL, prompt: '一只戴着墨镜的卡通鸭子，扁平插画风格', n: 1, response_format: 'b64_json' },
          timeoutMs: Math.max(options.timeoutMs, 180000)
        });
        assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text, 200)}`);
        assert(Array.isArray(res.json?.data) && res.json.data.length >= 1, '缺少 data 数组');
        const b64 = res.json.data[0].b64_json;
        assert(typeof b64 === 'string' && b64.length > 0, '缺少 b64_json');
        const bytes = base64Bytes(b64);
        assert(isImageBytes(bytes), 'b64_json 不是 PNG/JPEG/WebP 图片数据');
        const minBytes = options.mock ? 8 : 1000;
        assert(bytes.length > minBytes, `图片过小（${bytes.length} bytes）`);
        return `${bytes.length} bytes (${bytes[0] === 0x89 ? 'png' : 'jpeg/webp'})`;
      }
    },
    ...(options.search
      ? [
          {
            name: '联网搜索 annotations',
            upstream: true,
            async run() {
              const res = await client.request('/v1/chat/completions', {
                method: 'POST',
                body: {
                  model: MODEL,
                  messages: [{ role: 'user', content: '2026 年 11 月 1 日纽约今天的天气如何？请给出摄氏度。' }],
                  web_search: true
                },
                timeoutMs: Math.max(options.timeoutMs, 180000)
              });
              assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text, 200)}`);
              const message = res.json.choices?.[0]?.message;
              const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
              assert(annotations.length > 0, '没有 url_citation 注解（搜索未触发？）');
              assert(
                annotations.every((item) => item.type === 'url_citation' && item.url_citation?.url),
                'url_citation 注解结构不合法'
              );
              return `${annotations.length} citations, first=${snippet(annotations[0].url_citation.url)}`;
            }
          }
        ]
      : []),
    ...(adminToken
      ? [
          {
            name: 'admin overview',
            upstream: false,
            async run() {
              const res = await client.request('/admin/api/overview', {
                headers: ADMIN_HEADER(adminToken),
                timeoutMs: Math.min(options.timeoutMs, 30000)
              });
              assert(res.status === 200, `HTTP ${res.status}: ${snippet(res.text, 200)}`);
              const body = res.json;
              assert(body.service?.name === 'duckai-cpa', '缺少 service.name');
              // v2：stats 拆分为 upstream/admin；upstream 带 queue 状态
              assert(body.stats?.upstream, '缺少 stats.upstream');
              assert(body.stats?.admin, '缺少 stats.admin');
              assert(typeof body.stats.upstream.requests === 'number', '缺少 stats.upstream.requests');
              assert(typeof body.stats.admin.requests === 'number', '缺少 stats.admin.requests');
              const queue = body.upstream?.queue;
              assert(queue && typeof queue.rps === 'number', '缺少 upstream.queue（RPS 队列状态）');
              assert(Array.isArray(body.models) && body.models.length > 0, '缺少 models');
              return `upstream=${body.stats.upstream.requests} admin=${body.stats.admin.requests} queue=${queue.inFlight}/${queue.waiting} models=${body.models.length}`;
            }
          }
        ]
      : [
          {
            name: 'admin overview',
            upstream: false,
            skip: true,
            skipReason: '未提供 --admin-token / DUCKAI_CPA_ADMIN_TOKEN',
            async run() {
              return '';
            }
          }
        ])
  ];
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

async function runCheck(check, client) {
  const startedAt = Date.now();
  try {
    const detail = await check.run();
    return { name: check.name, status: 'PASS', detail, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name: check.name,
      status: 'FAIL',
      detail: error?.message || String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

function printResult(result) {
  const label = result.status === 'PASS' ? paint(GREEN, '[PASS]') : paint(RED, '[FAIL]');
  const duration = paint(DIM, `${result.durationMs}ms`);
  console.log(`${label} ${result.name.padEnd(22)} ${duration}  ${result.detail || ''}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`错误: ${error.message}\n`);
    printHelp();
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  let cleanup = async () => {};
  let client;
  try {
    if (options.mock) {
      const { startTestServer, ADMIN_TOKEN, API_KEY } = await import('../tests/helpers/test-server.js');
      const { DEFAULT_SOURCES } = await import('../tests/helpers/mock-duck.js');
      const server = await startTestServer({});
      if (options.search) {
        server.duck.chatBehavior.sources = DEFAULT_SOURCES;
      }
      if (!options.adminToken) options.adminToken = ADMIN_TOKEN;
      if (!options.apiKey) options.apiKey = API_KEY;
      client = makeClient(server.baseUrl, options.timeoutMs, options.apiKey);
      cleanup = async () => {
        await server.close();
      };
      console.log(`duckai-cpa smoke — target: (in-process mock) ${server.baseUrl}`);
    } else {
      if (!options.apiKey) {
        console.error(
          '错误: v2 要求 /v1/* 强制 API Key。请通过 --api-key <key> 或环境变量 DUCKAI_CPA_API_KEY 提供。\n' +
            '（首次启动的 default key 在启动日志 / data/keys.json 中，也可在后台 API Key 页创建。）'
        );
        return 2;
      }
      client = makeClient(options.baseUrl, options.timeoutMs, options.apiKey);
      console.log(`duckai-cpa smoke — target: ${options.baseUrl}`);
    }
    console.log(
      `mode: ${options.mock ? 'mock' : options.noUpstream ? 'no-upstream' : 'live'} · search: ${
        options.search ? 'on' : 'off'
      } · api-key: ${options.apiKey ? 'on' : 'missing'} · admin: ${options.adminToken ? 'on' : 'off'}\n`
    );

    const checks = buildChecks(options, client);
    const results = [];
    for (const check of checks) {
      const skipped = check.skip || (check.upstream && !check.skip && !options.mock && options.noUpstream);
      if (skipped) {
        const reason = check.skipReason || '--no-upstream';
        results.push({ name: check.name, status: 'SKIP', detail: reason, durationMs: 0 });
        console.log(`${paint(YELLOW, '[SKIP]')} ${check.name.padEnd(22)} ${paint(DIM, '0ms')}  ${reason}`);
        continue;
      }
      const result = await runCheck(check, client);
      results.push(result);
      printResult(result);
    }

    const passed = results.filter((result) => result.status === 'PASS').length;
    const failed = results.filter((result) => result.status === 'FAIL').length;
    const skipped = results.filter((result) => result.status === 'SKIP').length;
    const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);

    console.log();
    if (failed === 0) {
      console.log(paint(GREEN, `✔ smoke 通过: ${passed} passed, ${failed} failed, ${skipped} skipped (${totalMs}ms)`));
      return 0;
    }
    console.log(paint(RED, `✖ smoke 失败: ${passed} passed, ${failed} failed, ${skipped} skipped (${totalMs}ms)`));
    const failedNames = results.filter((result) => result.status === 'FAIL').map((result) => result.name);
    console.log(`失败的检查: ${failedNames.join(', ')}`);
    if (!options.mock && failedNames.includes('healthz')) {
      console.log(`提示: 服务可能未启动。先运行 "npm start"（默认 http://127.0.0.1:8787），或使用 --mock 做离线检查。`);
    }
    return 1;
  } catch (error) {
    console.error(paint(RED, `smoke 运行失败: ${error?.message || error}`));
    if (error?.cause) console.error(String(error.cause));
    return 2;
  } finally {
    await cleanup();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
