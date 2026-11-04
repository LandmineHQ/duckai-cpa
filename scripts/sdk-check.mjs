#!/usr/bin/env node
/**
 * OpenAI 官方 SDK 兼容性检查（scripts/sdk-check.mjs）
 *
 * 用项目已安装的 `openai` SDK（devDependency）以真实 SDK 调用方式访问网关：
 *   1) models.list()
 *   2) chat.completions.create()          非流式
 *   3) chat.completions.create(stream)    流式（逐 chunk 消费）
 *   4) responses.create()                 Responses API 非流式
 *
 * 每个上游请求之间间隔 14s（默认），遇 429/418 等 60s 重试一次，避免匿名额度被打爆。
 * 目标服务默认 http://127.0.0.1:8787（BASE_URL 覆盖），需要网关已启动并连通真实上游。
 *
 * 用法:
 *   node scripts/sdk-check.mjs
 *   node scripts/sdk-check.mjs --base-url http://127.0.0.1:8787 --model gpt-6-luna
 *   node scripts/sdk-check.mjs --interval 14000 --rate-limit-wait 60000
 *
 * 退出码: 0 全部 PASS；1 有 FAIL；2 用法/导入错误。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const useColor = process.stdout.isTTY === true;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    model: process.env.SDK_CHECK_MODEL || 'gpt-6-luna',
    apiKey: process.env.DUCKAI_CPA_API_KEY || process.env.OPENAI_API_KEY || '',
    intervalMs: 14000,
    rateLimitWaitMs: 60000,
    timeoutMs: 180000,
    out: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const eq = arg.indexOf('=');
      if (eq !== -1) return arg.slice(eq + 1);
      index += 1;
      return argv[index];
    };
    switch (true) {
      case arg === '-h' || arg === '--help':
        options.help = true;
        break;
      case arg === '--base-url' || arg.startsWith('--base-url='):
        options.baseUrl = String(takeValue()).replace(/\/+$/, '');
        break;
      case arg === '--api-key' || arg.startsWith('--api-key='):
        options.apiKey = String(takeValue() || '');
        break;
      case arg === '--model' || arg.startsWith('--model='):
        options.model = String(takeValue());
        break;
      case arg === '--interval' || arg.startsWith('--interval='):
        options.intervalMs = Number(takeValue()) || options.intervalMs;
        break;
      case arg === '--rate-limit-wait' || arg.startsWith('--rate-limit-wait='):
        options.rateLimitWaitMs = Number(takeValue()) || options.rateLimitWaitMs;
        break;
      case arg === '--timeout' || arg.startsWith('--timeout='):
        options.timeoutMs = Number(takeValue()) || options.timeoutMs;
        break;
      case arg === '--out' || arg.startsWith('--out='):
        options.out = String(takeValue());
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (!/^https?:\/\//.test(options.baseUrl)) throw new UsageError(`--base-url 需要 http(s) 地址: ${options.baseUrl}`);
  return options;
}

function printHelp() {
  console.log(`OpenAI SDK 兼容性检查（v2 强制 API Key）

用法: node scripts/sdk-check.mjs [选项]

选项:
  --base-url <url>        网关地址（默认 $BASE_URL 或 http://127.0.0.1:8787）
  --api-key <key>         /v1/* 必备 API Key（也可用 $DUCKAI_CPA_API_KEY / $OPENAI_API_KEY）
  --model <id>            模型（默认 gpt-6-luna）
  --interval <ms>         上游请求间隔（默认 14000）
  --rate-limit-wait <ms>  遇 429/418 等待时间（默认 60000，重试一次）
  --timeout <ms>          SDK 请求超时（默认 180000）
  --out <file>            结果 JSON（默认 data/tmp/sdk-check-<ts>.json）
`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snippet(text, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRateLimit(error) {
  if (!error) return false;
  const status = Number(error.status);
  return status === 418 || status === 429 || /rate.?limit|ERR_RATE_LIMIT|ERR_BN_LIMIT/i.test(String(error.message || ''));
}

function errorInfo(error) {
  return {
    status: error?.status ?? error?.response?.status ?? null,
    type: error?.type ?? error?.code ?? null,
    message: error?.message || String(error),
    stack: String(error?.stack || '').split('\n').slice(0, 4).join('\n')
  };
}

function buildSteps(options) {
  const model = options.model;
  const steps = [];

  steps.push({
    name: 'models.list()',
    needsPace: false,
    async run({ client }) {
      const page = await client.models.list();
      const data = Array.isArray(page.data) ? page.data : [];
      if (data.length < 5) throw new Error(`模型列表过少: ${data.length}`);
      const luna = data.find((entry) => entry.id === model);
      if (!luna) throw new Error(`缺少模型 ${model}`);
      if (luna.object !== 'model') throw new Error(`模型 object 异常: ${luna.object}`);
      return { detail: `${data.length} models, ${model} ok`, data: { count: data.length, ids: data.slice(0, 3).map((e) => e.id) } };
    }
  });

  steps.push({
    name: 'chat 非流式',
    needsPace: true,
    async run({ client }) {
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: '用一句话说明天空为什么是蓝色的。' }]
      });
      const content = completion.choices?.[0]?.message?.content || '';
      if (!content.trim()) throw new Error('content 为空');
      if (completion.object !== 'chat.completion') throw new Error(`object 异常: ${completion.object}`);
      return {
        detail: `${content.length} chars: ${snippet(content)}`,
        data: { content, usage: completion.usage, finishReason: completion.choices[0].finish_reason }
      };
    }
  });

  steps.push({
    name: 'chat 流式',
    needsPace: true,
    async run({ client }) {
      const stream = await client.chat.completions.create({
        model,
        stream: true,
        messages: [{ role: 'user', content: '用一句话说明地球为什么是圆的。' }]
      });
      let content = '';
      let chunks = 0;
      let finishReason = null;
      for await (const chunk of stream) {
        chunks += 1;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        content += choice.delta?.content || '';
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (!content.trim()) throw new Error('流式 content 为空');
      if (finishReason !== 'stop') throw new Error(`finish_reason 异常: ${finishReason}`);
      if (chunks < 2) throw new Error(`chunk 数过少: ${chunks}`);
      return { detail: `${chunks} chunks, ${content.length} chars: ${snippet(content)}`, data: { content, chunks, finishReason } };
    }
  });

  steps.push({
    name: 'responses.create()',
    needsPace: true,
    async run({ client }) {
      const response = await client.responses.create({
        model,
        input: '用一句话说明月亮为什么会有阴晴圆缺。'
      });
      const text = response.output_text || '';
      if (!text.trim()) throw new Error('output_text 为空');
      if (response.object !== 'response') throw new Error(`object 异常: ${response.object}`);
      if (response.status !== 'completed') throw new Error(`status 异常: ${response.status}`);
      if (!Array.isArray(response.output) || response.output.length === 0) throw new Error('output 为空');
      return {
        detail: `${text.length} chars: ${snippet(text)}`,
        data: { output_text: text, status: response.status, outputTypes: response.output.map((item) => item.type) }
      };
    }
  });

  return steps;
}

async function runWithRetry(step, context, options, state) {
  if (step.needsPace && state.upstreamCalls > 0) {
    console.log(paint(DIM, `  … 等待 ${options.intervalMs}ms（上游限流保护）`));
    await sleep(options.intervalMs);
  }
  if (step.needsPace) state.upstreamCalls += 1;

  const startedAt = Date.now();
  try {
    const outcome = await step.run(context);
    return { name: step.name, status: 'PASS', durationMs: Date.now() - startedAt, ...outcome };
  } catch (error) {
    if (isRateLimit(error)) {
      console.log(paint(YELLOW, `  ↻ ${step.name}: 上游限流（${error?.status ?? '429'}），等待 ${options.rateLimitWaitMs}ms 后重试一次`));
      await sleep(options.rateLimitWaitMs);
      try {
        const outcome = await step.run(context);
        return { name: step.name, status: 'PASS', durationMs: Date.now() - startedAt, ...outcome, retriedAfterRateLimit: true };
      } catch (retryError) {
        return {
          name: step.name,
          status: 'FAIL',
          durationMs: Date.now() - startedAt,
          detail: `限流后重试仍失败: ${retryError?.message || retryError}`,
          error: errorInfo(retryError)
        };
      }
    }
    return { name: step.name, status: 'FAIL', durationMs: Date.now() - startedAt, detail: error?.message || String(error), error: errorInfo(error) };
  }
}

function printResult(result) {
  const label = result.status === 'PASS' ? paint(GREEN, '[PASS]') : paint(RED, '[FAIL]');
  console.log(`${label} ${result.name.padEnd(20)} ${paint(DIM, `${result.durationMs}ms`)}  ${result.detail || ''}`);
  if (result.error) {
    console.log(paint(DIM, `         status=${result.error.status} type=${result.error.type} ${snippet(result.error.message, 140)}`));
  }
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

  if (!options.apiKey) {
    console.error(
      '错误: v2 网关要求 /v1/* 强制 API Key。请通过 --api-key <key> 或环境变量 DUCKAI_CPA_API_KEY 提供 ' +
        '（首次启动的 default key 见启动日志 / data/keys.json，也可在后台 API Key 页创建）。'
    );
    return 2;
  }

  let OpenAI;
  try {
    ({ default: OpenAI } = await import('openai'));
  } catch (error) {
    console.error('无法导入 openai SDK，请先安装 devDependency：npm install');
    console.error(error?.message || error);
    return 2;
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: `${options.baseUrl}/v1`,
    timeout: options.timeoutMs,
    maxRetries: 0
  });

  console.log(
    `duckai-cpa sdk-check — baseURL: ${options.baseUrl}/v1 · model=${options.model} · interval=${options.intervalMs}ms\n`
  );

  const results = [];
  const state = { upstreamCalls: 0 };
  const startedAt = Date.now();
  for (const step of buildSteps(options)) {
    const result = await runWithRetry(step, { client }, options, state);
    results.push(result);
    printResult(result);
    if (result.status === 'FAIL' && isRateLimit(result.error)) {
      console.log(paint(YELLOW, '  上游限流，停止后续步骤'));
      break;
    }
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const totalMs = Date.now() - startedAt;
  console.log();
  console.log(failed > 0 ? paint(RED, `✖ sdk-check: ${passed} passed, ${failed} failed`) : paint(GREEN, `✔ sdk-check: ${passed} passed, 0 failed (${(totalMs / 1000).toFixed(1)}s)`));

  const outPath = options.out || path.join(PROJECT_ROOT, 'data', 'tmp', `sdk-check-${Date.now()}.json`);
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      JSON.stringify(
        { ts: new Date().toISOString(), baseUrl: options.baseUrl, model: options.model, sdk: 'openai@7', results, summary: { passed, failed, totalMs } },
        null,
        2
      ),
      'utf8'
    );
    console.log(`报告: ${outPath}`);
  } catch (error) {
    console.error(`写入报告失败: ${error.message}`);
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
