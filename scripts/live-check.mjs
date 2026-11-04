#!/usr/bin/env node
/**
 * 真实上游链路验收（scripts/live-check.mjs）
 *
 * 直接使用 src/duck/index.js 的 DuckClient 打真实 duck.ai，验证协议层核心能力：
 *   1) 初始化/健康（挑战就绪 + x-fe-version）
 *   2) 文本流式（首 token 延迟 + 增量文本）
 *   3) 多轮对话（携带历史后仍能得到回答）
 *   4) 联网搜索（WebSearch → sources/url_citation 数据）
 *   5) 图片生成（GenerateImage → base64 图片可解码）
 *   6) 推理档位（reasoningEffort=low 被接受）
 *
 * 用法：
 *   node scripts/live-check.mjs                         # 全量（约 2–4 分钟，匿名额度消耗 6 次左右）
 *   node scripts/live-check.mjs --skip-image            # 跳过图片生成
 *   node scripts/live-check.mjs --skip-search           # 跳过联网搜索
 *   node scripts/live-check.mjs --skip-multi --skip-reasoning
 *   node scripts/live-check.mjs --interval 12000        # 上游请求最小间隔（默认 12s，防匿名限流）
 *   node scripts/live-check.mjs --out data/tmp/live-check.json
 *
 * 匿名限流（418/429）处理：等待 60s 后自动重试一次；仍失败则记为 BLOCKED 并继续后续步骤。
 * 退出码：0 = 全部 PASS/BLOCKED；1 = 有 FAIL；2 = 初始化/用法错误。
 *
 * ⚠️ 多个 agent 共用出口 IP 时请先与 Lead 协调，避免把匿名额度打爆。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckClient } from '../src/duck/index.js';

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
    model: process.env.LIVE_CHECK_MODEL || 'gpt-6-luna',
    skipImage: false,
    skipSearch: false,
    skipMulti: false,
    skipReasoning: false,
    intervalMs: 12000,
    rateLimitWaitMs: 60000,
    noRetry429: false,
    timeoutMs: 180000,
    only: null,
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
      case arg === '--skip-image':
        options.skipImage = true;
        break;
      case arg === '--skip-search':
        options.skipSearch = true;
        break;
      case arg === '--skip-multi':
        options.skipMulti = true;
        break;
      case arg === '--skip-reasoning':
        options.skipReasoning = true;
        break;
      case arg === '--no-retry-429':
        options.noRetry429 = true;
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
      case arg === '--only' || arg.startsWith('--only='):
        options.only = String(takeValue() || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`真实上游链路验收（DuckClient 直连 duck.ai）

用法: node scripts/live-check.mjs [选项]

选项:
  --model <id>            模型（默认 gpt-6-luna）
  --skip-image            跳过图片生成（省额度）
  --skip-search           跳过联网搜索
  --skip-multi            跳过多轮
  --skip-reasoning        跳过推理档位
  --interval <ms>         上游请求最小间隔（默认 12000）
  --rate-limit-wait <ms>  遇 429/418 的等待时间（默认 60000，等待后重试一次）
  --no-retry-429          遇 429/418 不重试
  --only <list>           只跑指定步骤（逗号分隔：text,multi,search,image,reasoning；
                          初始化/健康总是执行）适合限流期最小验收
  --timeout <ms>          单请求超时（默认 180000）
  --out <file>            结果 JSON 输出路径（默认 data/tmp/live-check-<ts>.json）
`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snippet(text, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || webp;
}

function isRateLimit(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status === 418 || status === 429) return true;
  return /rate.?limit|ERR_BN_LIMIT|ERR_RATE_LIMIT/i.test(String(error.type || '') + ' ' + String(error.message || ''));
}

function repro(command, options) {
  return `node scripts/live-check.mjs --model ${options.model} ${command}`;
}

/* ------------------------------------------------------------------ */
/* Steps                                                              */
/* ------------------------------------------------------------------ */

function buildSteps(options) {
  const model = options.model;
  const steps = [];

  steps.push({
    name: '初始化/健康',
    critical: true,
    async run({ client }) {
      const health = await client.health();
      if (!health || health.challengeOk !== true) {
        throw new Error(`挑战未就绪: ${JSON.stringify(health && { ok: health.ok, challengeOk: health.challengeOk })}`);
      }
      if (typeof health.version !== 'string' || !health.version) {
        throw new Error('缺少 x-fe-version（首页版本号解析失败）');
      }
      return { detail: `version=${health.version} upstreamStatus=${health.upstreamStatus}`, data: { health } };
    }
  });

  steps.push({
    name: '文本流式',
    key: 'text',
    async run({ client }) {
      const startedAt = Date.now();
      let firstTokenAt = 0;
      const deltas = [];
      const result = await client.chat(
        { model, messages: [{ role: 'user', content: '用一句话说明天空为什么是蓝色的。' }] },
        {
          onTextDelta(text) {
            if (!firstTokenAt) firstTokenAt = Date.now();
            deltas.push(text);
          }
        }
      );
      const content = result.content || deltas.join('');
      if (!content.trim()) throw new Error('上游返回空文本');
      return {
        detail: `${content.length} chars, firstToken=${firstTokenAt ? firstTokenAt - startedAt : '?'}ms, ${snippet(content)}`,
        data: {
          content,
          firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
          reasoningEffort: result.reasoningEffort,
          finishReason: result.finishReason
        }
      };
    }
  });

  if (!options.skipMulti) {
    steps.push({
      name: '多轮对话',
      key: 'multi',
      async run({ client }) {
        const first = await client.chat(
          { model, messages: [{ role: 'user', content: '我叫小明，请记住这个名字。' }] },
          {}
        );
        if (!first.content || !first.content.trim()) throw new Error('第一轮回答为空');
        await sleep(500);
        const second = await client.chat(
          {
            model,
            messages: [
              { role: 'user', content: '我叫小明，请记住这个名字。' },
              { role: 'assistant', content: first.content },
              { role: 'user', content: '我叫什么名字？只回答名字。' }
            ]
          },
          {}
        );
        if (!second.content || !second.content.trim()) throw new Error('第二轮回答为空');
        const mentionsName = /小明/.test(second.content);
        return {
          detail: `turn2=${snippet(second.content, 50)} 记住名字=${mentionsName ? '是' : '否(软失败，不计 FAIL)'}`,
          data: { first: first.content, second: second.content, mentionsName }
        };
      }
    });
  }

  if (!options.skipSearch) {
    steps.push({
      name: '联网搜索',
      key: 'search',
      async run({ client }) {
        const result = await client.chat(
          {
            model,
            webSearch: true,
            messages: [{ role: 'user', content: '2026 年 11 月 1 日纽约今天的天气如何？请给出摄氏度。' }]
          },
          {}
        );
        const sources = Array.isArray(result.sources) ? result.sources : [];
        if (sources.length === 0) {
          throw new Error('上游未返回搜索来源（sources 为空）');
        }
        const urls = sources.map((source) => source.url).filter(Boolean);
        return {
          detail: `${sources.length} sources, ${snippet(urls[0], 60)}`,
          data: { content: result.content, sources: sources.slice(0, 10) }
        };
      }
    });
  }

  if (!options.skipImage) {
    steps.push({
      name: '图片生成',
      key: 'image',
      async run({ client }) {
        const result = await client.imageGeneration({
          model,
          prompt: '一只戴着墨镜的卡通鸭子，扁平插画风格'
        });
        const image = result.images && result.images[0];
        if (!image || !image.b64) throw new Error('上游未返回图片');
        const bytes = Buffer.from(image.b64, 'base64');
        if (!isImageBytes(bytes)) throw new Error('返回的 b64 不是合法图片数据');
        if (bytes.length < 1000) throw new Error(`图片过小（${bytes.length} bytes）`);
        return {
          detail: `${bytes.length} bytes ${image.format || 'unknown'}${result.modelDisplayName ? ` (${result.modelDisplayName})` : ''}`,
          data: {
            bytes: bytes.length,
            format: image.format,
            modelDisplayName: result.modelDisplayName,
            b64Prefix: String(image.b64).slice(0, 32)
          }
        };
      }
    });
  }

  if (!options.skipReasoning) {
    steps.push({
      name: '推理档位 low',
      key: 'reasoning',
      async run({ client }) {
        const result = await client.chat(
          {
            model,
            reasoningEffort: 'low',
            messages: [{ role: 'user', content: '2 的 10 次方是多少？只回答数字。' }]
          },
          {}
        );
        if (!result.content || !result.content.trim()) throw new Error('推理档位请求返回空文本');
        if (result.reasoningEffort !== 'low') {
          throw new Error(`reasoningEffort 未按预期生效: ${result.reasoningEffort}`);
        }
        return {
          detail: `effort=${result.reasoningEffort} reasoning=${(result.reasoning || '').length} chars, ${snippet(result.content, 40)}`,
          data: { content: result.content, reasoning: result.reasoning, reasoningEffort: result.reasoningEffort }
        };
      }
    });
  }

  // --only text,search,image：限流期最小验收（初始化/健康总是执行）
  if (Array.isArray(options.only) && options.only.length > 0) {
    return steps.filter((step) => !step.key || options.only.includes(step.key));
  }

  return steps;
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

async function runStepWithRetry(step, context, options) {
  const startedAt = Date.now();
  try {
    const outcome = await step.run(context);
    return { name: step.name, status: 'PASS', durationMs: Date.now() - startedAt, ...outcome };
  } catch (error) {
    if (isRateLimit(error) && !options.noRetry429) {
      console.log(paint(YELLOW, `  ↻ ${step.name}: 上游匿名限流（${error.status || error.type}），等待 ${options.rateLimitWaitMs}ms 后重试一次`));
      await sleep(options.rateLimitWaitMs);
      try {
        const outcome = await step.run(context);
        return { name: step.name, status: 'PASS', durationMs: Date.now() - startedAt, ...outcome, retriedAfterRateLimit: true };
      } catch (retryError) {
        return {
          name: step.name,
          status: isRateLimit(retryError) ? 'BLOCKED' : 'FAIL',
          durationMs: Date.now() - startedAt,
          detail: `限流后重试仍失败: ${retryError?.message || retryError}`,
          error: {
            status: retryError?.status,
            type: retryError?.type,
            message: retryError?.message,
            stack: String(retryError?.stack || '').split('\n').slice(0, 4).join('\n')
          }
        };
      }
    }
    return {
      name: step.name,
      status: isRateLimit(error) ? 'BLOCKED' : 'FAIL',
      durationMs: Date.now() - startedAt,
      detail: error?.message || String(error),
      error: {
        status: error?.status,
        type: error?.type,
        message: error?.message,
        stack: String(error?.stack || '').split('\n').slice(0, 4).join('\n')
      }
    };
  }
}

function printResult(result) {
  const label =
    result.status === 'PASS'
      ? paint(GREEN, '[PASS]')
      : result.status === 'BLOCKED'
        ? paint(YELLOW, '[BLOCKED]')
        : paint(RED, '[FAIL]');
  console.log(`${label} ${result.name.padEnd(12)} ${paint(DIM, `${result.durationMs}ms`)}  ${result.detail || ''}`);
  if (result.error) {
    console.log(paint(DIM, `         status=${result.error.status} type=${result.error.type} ${snippet(result.error.message, 120)}`));
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

  console.log('duckai-cpa live-check — 直连 https://duck.ai（不经过网关）');
  console.log(
    `model=${options.model} interval=${options.intervalMs}ms image=${options.skipImage ? 'skip' : 'on'} search=${
      options.skipSearch ? 'skip' : 'on'
    } multi=${options.skipMulti ? 'skip' : 'on'} reasoning=${options.skipReasoning ? 'skip' : 'on'}\n`
  );

  const client = new DuckClient({
    baseUrl: 'https://duck.ai',
    defaultModel: options.model,
    timeoutMs: options.timeoutMs,
    strictInit: false,
    humanize: {
      minDelayMs: 1200,
      maxDelayMs: 2600,
      minIntervalMs: options.intervalMs,
      concurrency: 1,
      maxRetries: 2,
      retryBaseDelayMs: 3000,
      rateLimitCooldownMs: 60000,
      rateLimitWaitMs: 5000
    }
  });

  const startedAt = Date.now();
  const results = [];
  let fatal = null;
  try {
    await client.init();
  } catch (error) {
    fatal = error;
  }

  if (!fatal) {
    const steps = buildSteps(options);
    for (const step of steps) {
      const result = await runStepWithRetry(step, { client }, options);
      results.push(result);
      printResult(result);
      // 限流时不要继续消费额度
      if (result.status === 'BLOCKED') {
        console.log(paint(YELLOW, '  上游限流，停止后续步骤（稍后冷却后再跑）'));
        break;
      }
    }
  } else {
    console.error(paint(RED, `初始化失败: ${fatal?.message || fatal}`));
    results.push({
      name: '初始化/健康',
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      detail: fatal?.message || String(fatal),
      error: { status: fatal?.status, type: fatal?.type, message: fatal?.message }
    });
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const blocked = results.filter((result) => result.status === 'BLOCKED').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const totalMs = Date.now() - startedAt;

  console.log();
  const summaryLine = `live-check: ${passed} passed, ${failed} failed, ${blocked} blocked (${(totalMs / 1000).toFixed(1)}s)`;
  console.log(failed > 0 ? paint(RED, `✖ ${summaryLine}`) : blocked > 0 ? paint(YELLOW, `⚠ ${summaryLine}`) : paint(GREEN, `✔ ${summaryLine}`));

  const outPath = options.out || path.join(PROJECT_ROOT, 'data', 'tmp', `live-check-${Date.now()}.json`);
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          target: 'https://duck.ai',
          model: options.model,
          options,
          results,
          summary: { passed, failed, blocked, totalMs }
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`报告: ${outPath}`);
  } catch (error) {
    console.error(`写入报告失败: ${error.message}`);
  }

  if (failed > 0) {
    console.log('\n复现命令:');
    for (const result of results.filter((item) => item.status === 'FAIL')) {
      console.log(`  ${repro(result.name, options)}`);
    }
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
