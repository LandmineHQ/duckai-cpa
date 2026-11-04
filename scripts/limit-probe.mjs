#!/usr/bin/env node
/**
 * scripts/limit-probe.mjs — 真实测量 duck.ai 每模型的输入/会话/输出上限（v2.20）
 *
 * 目的：为 `/v1/models` 的 `context_window_chars / max_output_tokens / session_limit_behavior`
 * 提供**实测下界**，而不是纯估算。所有数字都会标注 measured / lower-bound / blocked。
 *
 * 探测项（每个模型）：
 *   1) 单条输入上限：逐级发送长文本（默认 4000/8000/12000/15000/16000/16200/20000 字符），
 *      记录首次被上游拒绝的长度（ERR_INPUT_LIMIT / 400 / 413）。
 *   2) 会话上限：连续多轮（默认最多 20 轮，每轮追加一段文字），直到上游报
 *      conversation limit（[LIMIT_CONVERSATION] / ERR_CONVERSATION_LIMIT / 409）。
 *      记录失败前的累计消息数、累计字符数、估算 token。
 *   3) 输出长度：一次“尽量长”的写作请求，记录实际输出字符数（下界）。
 *
 * 用法：
 *   node scripts/limit-probe.mjs --models gpt-6-luna,gpt-5.4-mini
 *   node scripts/limit-probe.mjs --models gpt-6-luna --input-only
 *   node scripts/limit-probe.mjs --models gpt-6-luna --interval 9000 --max-turns 20
 *   node scripts/limit-probe.mjs --models gpt-6-luna --out data/tmp/limit-gpt6.json
 *
 * 匿名额度保护：默认每请求间隔 9s；遇到 418/429 等待 60s 重试一次，仍失败则把该模型标记 BLOCKED。
 * 输出：人类可读表 + `data/tmp/limit-probe-<timestamp>.json`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { DuckClient } from '../src/duck/index.js';
import { ProxyManager } from '../src/duck/proxy.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const FREE_MODELS = [
  'gpt-6-luna',
  'gpt-5.4-mini',
  'claude-haiku-4-5',
  'mistral-small-2603',
  'tinfoil/gpt-oss-120b',
  'tinfoil/gemma4-31b'
];
const PAID_MODELS = ['gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const INPUT_STEPS = [4000, 8000, 12000, 15000, 16000, 16200, 20000];
const CHARS_PER_TOKEN_ESTIMATE = 3;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    models: FREE_MODELS,
    intervalMs: 9000,
    retryWaitMs: 60000,
    maxTurns: 20,
    perTurnChars: 1500,
    steps: INPUT_STEPS,
    inputOnly: false,
    conversationOnly: false,
    outputOnly: false,
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
      case arg === '--models' || arg.startsWith('--models='):
        options.models = String(takeValue() || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case arg === '--interval' || arg.startsWith('--interval='):
        options.intervalMs = Math.max(1000, Number(takeValue()) || 9000);
        break;
      case arg === '--max-turns' || arg.startsWith('--max-turns='):
        options.maxTurns = Math.max(1, Math.min(60, Number(takeValue()) || 20));
        break;
      case arg === '--per-turn-chars' || arg.startsWith('--per-turn-chars='):
        options.perTurnChars = Math.max(200, Number(takeValue()) || 1500);
        break;
      case arg === '--steps' || arg.startsWith('--steps='):
        options.steps = String(takeValue() || '')
          .split(',')
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0);
        break;
      case arg === '--input-only':
        options.inputOnly = true;
        break;
      case arg === '--conversation-only':
        options.conversationOnly = true;
        break;
      case arg === '--output-only':
        options.outputOnly = true;
        break;
      case arg === '--out' || arg.startsWith('--out='):
        options.out = String(takeValue() || '');
        break;
      case arg === '--include-paid':
        options.models = [...FREE_MODELS, ...PAID_MODELS];
        break;
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.models.length) throw new UsageError('--models 不能为空');
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

function filler(target, seed) {
  const sentence =
    '这是一段用于测试上下文长度的占位文字，内容没有实际意义，只需要保持连贯并且不重复同一句。';
  let text = '';
  let counter = seed;
  while (text.length < target) {
    text += `第${counter}段：${sentence}`;
    if (counter % 3 === 0) text += '（继续填充以凑足长度）';
    counter += 1;
  }
  return text.slice(0, target);
}

function classifyError(error) {
  const code = String(error?.code || '');
  const upstreamType = String(error?.upstreamType || '');
  const message = String(error?.message || '');
  if (/input_limit/i.test(code) || /INPUT_LIMIT/i.test(upstreamType)) return 'input_limit';
  if (/conversation_limit/i.test(code) || /CONVERSATION_LIMIT/i.test(upstreamType)) return 'conversation_limit';
  if (/rate_limited|anomaly_check/i.test(code) || /BN_LIMIT|RATE_LIMIT/i.test(upstreamType)) return 'rate_limited';
  if (/upstream_no_image|refusal|content_filter/i.test(code)) return 'content';
  if (error?.transportStatus === 400) return 'bad_request';
  if (error?.transportStatus === 413) return 'input_limit';
  return code ? `error:${code}` : `error:${message.slice(0, 60)}`;
}

function createClient(config, logger) {
  const proxyManager =
    config?.proxy && config.proxy.enabled
      ? new ProxyManager({ config: { proxy: config.proxy }, logger })
      : null;
  return new DuckClient({
    baseUrl: 'https://duck.ai',
    defaultModel: 'gpt-6-luna',
    timeoutMs: 180000,
    strictInit: false,
    humanize: { minDelayMs: 600, maxDelayMs: 1400 },
    logger,
    ...(proxyManager ? { proxyManager } : {})
  });
}

async function withRateRetry(run, state, options) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const kind = classifyError(error);
    if (kind === 'rate_limited' && !state.retried) {
      state.retried = true;
      state.notes.push(`rate limited → wait ${options.retryWaitMs}ms 后重试一次`);
      await sleep(options.retryWaitMs);
      try {
        return { ok: true, value: await run() };
      } catch (retryError) {
        return { ok: false, error: retryError, kind: classifyError(retryError) };
      }
    }
    return { ok: false, error, kind };
  }
}

async function probeInputLimit(client, model, options, state) {
  const results = [];
  for (const chars of options.steps) {
    state.notes.push(`input: 尝试 ${chars} 字符`);
    const content = `${filler(Math.max(0, chars - 30), chars)}请只回复 OK。`;
    const outcome = await withRateRetry(
      () => client.chat({ model, messages: [{ role: 'user', content }] }, {}),
      state,
      options
    );
    if (outcome.ok) {
      results.push({ chars, ok: true });
    } else {
      results.push({ chars, ok: false, kind: outcome.kind, message: String(outcome.error?.message || '').slice(0, 120) });
      if (outcome.kind === 'rate_limited') {
        state.blocked = 'upstream 418/429（共享匿名出口限额）';
        break;
      }
      if (outcome.kind === 'input_limit' || outcome.kind === 'bad_request') break;
    }
    await sleep(options.intervalMs);
  }
  const lastOk = [...results].reverse().find((item) => item.ok);
  const firstFail = results.find((item) => !item.ok);
  return {
    steps: results,
    measuredMaxInputChars: lastOk ? lastOk.chars : null,
    rejectedAt: firstFail ? firstFail.chars : null,
    rejectionKind: firstFail ? firstFail.kind : null
  };
}

async function probeConversationLimit(client, model, options, state) {
  const messages = [];
  const turnLog = [];
  let totalChars = 0;
  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    const content = `第${turn}轮：${filler(Math.max(120, options.perTurnChars), turn * 7919)} 请用一句话回应。`;
    messages.push({ role: 'user', content });
    totalChars += content.length;
    state.notes.push(`conversation: 第 ${turn} 轮（累计 ${totalChars} 字符）`);
    const outcome = await withRateRetry(
      () => client.chat({ model, messages: messages.map((item) => ({ ...item })) }, {}),
      state,
      options
    );
    if (!outcome.ok) {
      turnLog.push({ turn, ok: false, kind: outcome.kind, message: String(outcome.error?.message || '').slice(0, 140), totalChars });
      if (outcome.kind === 'rate_limited') {
        state.blocked = 'upstream 418/429（共享匿名出口限额）';
      }
      break;
    }
    const reply = String(outcome.value?.content || '');
    messages.push({ role: 'assistant', content: reply });
    totalChars += reply.length;
    turnLog.push({ turn, ok: true, replyChars: reply.length, totalChars });
    await sleep(options.intervalMs);
  }
  const lastOk = [...turnLog].reverse().find((item) => item.ok);
  const fail = turnLog.find((item) => !item.ok);
  return {
    maxSuccessfulTurns: lastOk ? lastOk.turn : 0,
    maxSuccessfulTotalChars: lastOk ? lastOk.totalChars : 0,
    maxSuccessfulTotalTokensEstimate: lastOk ? estimateTokens(lastOk.totalChars) : 0,
    failedTurn: fail ? fail.turn : null,
    failureKind: fail ? fail.kind : null,
    failureMessage: fail ? fail.message : null,
    turns: turnLog
  };
}

async function probeOutputLength(client, model, options, state) {
  const outcome = await withRateRetry(
    () =>
      client.chat(
        {
          model,
          messages: [
            {
              role: 'user',
              content:
                '请写一篇尽量长的中文散文，主题是秋日山谷，不要提前结束，至少写 2000 字，能写更长就继续写。'
            }
          ]
        },
        {}
      ),
    state,
    options
  );
  if (!outcome.ok) {
    return { ok: false, kind: outcome.kind, message: String(outcome.error?.message || '').slice(0, 140) };
  }
  const content = String(outcome.value?.content || '');
  const finishReason = outcome.value?.finishReason || null;
  return {
    ok: true,
    chars: content.length,
    tokensEstimate: estimateTokens(content.length),
    finishReason,
    sampleTail: content.slice(-80)
  };
}

function summarize(report) {
  const lines = [];
  lines.push('');
  lines.push('model                                input(max ok)  input(rejected)  conv(max turns)  conv(chars)  output(chars)  status');
  lines.push('-'.repeat(120));
  for (const item of report.models) {
    const input = item.input?.measuredMaxInputChars ?? '—';
    const rejected = item.input?.rejectedAt ? `${item.input.rejectedAt}(${item.input.rejectionKind})` : '—';
    const turns = item.conversation?.maxSuccessfulTurns ?? '—';
    const chars = item.conversation?.maxSuccessfulTotalChars ?? '—';
    const output = item.output?.ok ? item.output.chars : item.output?.kind || '—';
    const status = item.blocked ? `BLOCKED: ${item.blocked}` : 'OK';
    lines.push(
      `${String(item.model).padEnd(36)} ${String(input).padEnd(13)} ${String(rejected).padEnd(16)} ${String(turns).padEnd(16)} ${String(chars).padEnd(12)} ${String(output).padEnd(14)} ${status}`
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: node scripts/limit-probe.mjs --models gpt-6-luna,gpt-5.4-mini [--max-turns 20] [--interval 9000] [--out path]');
    return;
  }
  const config = await loadConfig({ logger: null });
  // loadConfig() 只读 example/默认；这里再叠加运行时 data/config.json（含代理设置）。
  try {
    const runtimeRaw = await fs.readFile(path.join(PROJECT_ROOT, 'data', 'config.json'), 'utf8');
    const runtime = JSON.parse(runtimeRaw.replace(/^\uFEFF/, ''));
    if (runtime && typeof runtime === 'object') {
      config.proxy = { ...(config.proxy || {}), ...(runtime.proxy || {}) };
      config.duck = { ...(config.duck || {}), ...(runtime.duck || {}) };
      if (runtime.upstream) config.upstream = { ...(config.upstream || {}), ...runtime.upstream };
    }
  } catch {
    /* data/config.json 不存在时用默认配置 */
  }
  const logger = {
    debug() {},
    info() {},
    warn: (...args) => console.warn('[warn]', ...args),
    error: (...args) => console.error('[error]', ...args)
  };
  const client = createClient(config, logger);
  await client.init?.();
  console.log(
    `probe start · models=${options.models.length} · interval=${options.intervalMs}ms · maxTurns=${options.maxTurns} · proxy=${config?.proxy?.enabled ? 'on' : 'off'}`
  );

  const report = {
    startedAt: new Date().toISOString(),
    intervalMs: options.intervalMs,
    maxTurns: options.maxTurns,
    perTurnChars: options.perTurnChars,
    charsPerTokenEstimate: CHARS_PER_TOKEN_ESTIMATE,
    models: []
  };

  for (const model of options.models) {
    const state = { notes: [], blocked: null, retried: false };
    const result = { model, input: null, conversation: null, output: null, notes: state.notes, blocked: null };
    console.log(`\n=== ${model} ===`);
    try {
      if (!options.conversationOnly && !options.outputOnly) {
        result.input = await probeInputLimit(client, model, options, state);
        console.log('input:', JSON.stringify(result.input));
      }
      if (!options.inputOnly && !options.outputOnly) {
        result.conversation = await probeConversationLimit(client, model, options, state);
        console.log('conversation:', JSON.stringify({ ...result.conversation, turns: undefined }));
      }
      if (!options.inputOnly && !options.conversationOnly) {
        result.output = await probeOutputLength(client, model, options, state);
        console.log('output:', JSON.stringify(result.output));
      }
    } catch (error) {
      result.blocked = `probe crashed: ${error.message}`;
      console.error('probe crashed:', error.message);
    }
    result.blocked = result.blocked || state.blocked;
    report.models.push(result);
    report.finishedAt = new Date().toISOString();
    if (result.blocked) {
      console.warn(`⚠ ${model} BLOCKED: ${result.blocked}`);
      // Cool down before the next model.
      await sleep(Math.max(options.retryWaitMs, 60000));
    }
  }

  const outPath =
    options.out || path.join(PROJECT_ROOT, 'data', 'tmp', `limit-probe-${Date.now()}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(summarize(report));
  console.log(`\n报告: ${outPath}`);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
