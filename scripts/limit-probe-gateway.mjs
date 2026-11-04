#!/usr/bin/env node
/**
 * scripts/limit-probe-gateway.mjs — 通过**网关自身的连接测试接口**真实测量模型上限（v2.20）
 *
 * 为什么不用 DuckClient 直连：直连缺少身份池身份/网关注入头，容易被上游判定
 * "unsupported entrypoint"（429），而且用户实际体验的就是网关。这里走：
 *   POST /admin/api/test/sessions                     （创建会话，指定模型）
 *   POST /admin/api/test/sessions/:id/messages        （SSE：delta/reasoning/done/error）
 * 与「连接测试」页面完全同一条链路（含身份池、rps=1 队列、压缩逻辑）。
 *
 * 探测项：
 *   1) 单条输入上限：逐步加大单条消息字符数，记录首次失败（HTTP/SSE error）。
 *   2) 会话上限：连续多轮（每轮追加内容），记录失败前成功轮数/累计字符/估算 token。
 *   3) 输出长度：一次“尽量长”的写作请求，记录实际输出字符数。
 *
 * 用法：
 *   node scripts/limit-probe-gateway.mjs --models gpt-6-luna --input-only --steps 16000,16100,20000
 *   node scripts/limit-probe-gateway.mjs --models gpt-6-luna,gpt-5.4-mini --max-turns 12
 *   node scripts/limit-probe-gateway.mjs --models gpt-6-luna --output-only
 *   node scripts/limit-probe-gateway.mjs --models all-free --interval 8000
 *
 * 环境变量：DUCKAI_CPA_ADMIN_TOKEN / ADMIN_TOKEN；--base-url 默认 http://127.0.0.1:8787
 * 输出：表格 + data/tmp/limit-gateway-<timestamp>.json（含每步原始状态，便于复核）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DEFAULT_INPUT_STEPS = [16000, 16100, 20000];
const CHARS_PER_TOKEN_ESTIMATE = 3;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    adminToken: process.env.DUCKAI_CPA_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    models: ['gpt-6-luna'],
    filler: 'zh',
    intervalMs: 8000,
    maxTurns: 12,
    perTurnChars: 1500,
    steps: DEFAULT_INPUT_STEPS,
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
      case arg === '--base-url' || arg.startsWith('--base-url='):
        options.baseUrl = String(takeValue() || '').replace(/\/+$/, '');
        break;
      case arg === '--admin-token' || arg.startsWith('--admin-token='):
        options.adminToken = String(takeValue() || '');
        break;
      case arg === '--models' || arg.startsWith('--models='): {
        const raw = String(takeValue() || '');
        options.models =
          raw === 'all-free'
            ? [...FREE_MODELS]
            : raw === 'all'
              ? [...FREE_MODELS, ...PAID_MODELS]
              : raw
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean);
        break;
      }
      case arg === '--interval' || arg.startsWith('--interval='):
        options.intervalMs = Math.max(1000, Number(takeValue()) || 8000);
        break;
      case arg === '--max-turns' || arg.startsWith('--max-turns='):
        options.maxTurns = Math.max(1, Math.min(60, Number(takeValue()) || 12));
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
      case arg === '--filler' || arg.startsWith('--filler='):
        options.filler = String(takeValue() || 'zh') === 'ascii' ? 'ascii' : 'zh';
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
      default:
        throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!/^https?:\/\//.test(options.baseUrl)) throw new UsageError('--base-url 需要 http(s) 地址');
  if (!options.adminToken) {
    throw new UsageError('需要 admin token：--admin-token <token> 或 DUCKAI_CPA_ADMIN_TOKEN');
  }
  if (!options.models.length) throw new UsageError('--models 不能为空');
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

function filler(target, seed, language = 'zh') {
  // zh: 中文占位（约 1 token/字）；ascii: 英文占位（约 1 token/4 字符）。
  // 两种 filler 对比可以判定上游限制是按“字符”还是按“token”。
  const zhSentence = '这是一段用于测试上下文长度的占位文字，内容没有实际意义，只需要保持连贯。';
  const asciiSentence = 'The quick brown fox jumps over the lazy dog while the autumn wind moves through the valley. ';
  const sentence = language === 'ascii' ? asciiSentence : zhSentence;
  let text = '';
  let counter = seed;
  while (text.length < target) {
    text += language === 'ascii' ? sentence : `第${counter}段：${sentence}`;
    counter += 1;
  }
  return text.slice(0, target);
}

function headers(options) {
  return {
    authorization: `Bearer ${options.adminToken}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
}

async function jsonFetch(options, pathname, init = {}) {
  const response = await fetch(`${options.baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers(options), ...(init.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function createSession(options, model) {
  const result = await jsonFetch(options, '/admin/api/test/sessions', {
    method: 'POST',
    body: JSON.stringify({ model })
  });
  if ((result.status !== 200 && result.status !== 201) || !result.body?.session?.id) {
    throw new Error(`创建会话失败 HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  }
  return result.body.session.id;
}

/**
 * 发送一条消息并解析 SSE。
 * @returns {Promise<{status:number, ok:boolean, deltaChars:number, doneContentChars:number|null, error:object|null, eventTypes:string[]}>}
 */
async function sendMessage(options, sessionId, content) {
  const response = await fetch(
    `${options.baseUrl}/admin/api/test/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: { ...headers(options), accept: 'text/event-stream' },
      body: JSON.stringify({ content })
    }
  );
  const text = await response.text();
  if (response.status !== 200) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: response.status,
      ok: false,
      deltaChars: 0,
      doneContentChars: null,
      error: body?.error || { message: text.slice(0, 200) },
      eventTypes: []
    };
  }
  const eventTypes = [];
  let deltaChars = 0;
  let doneContentChars = null;
  let error = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    eventTypes.push(payload.type);
    if (payload.type === 'delta' && typeof payload.text === 'string') deltaChars += payload.text.length;
    if (payload.type === 'done') {
      if (typeof payload.message?.content === 'string') doneContentChars = payload.message.content.length;
      if (payload.compacted) eventTypes.push('compacted');
    }
    if (payload.type === 'error') error = payload;
  }
  return { status: response.status, ok: !error, deltaChars, doneContentChars, error, eventTypes };
}

function isRateLimit(result) {
  const code = String(result.error?.code || '');
  const message = String(result.error?.message || '');
  // 上下文超限在上游也常以 HTTP 429 返回（ERR_INPUT_LIMIT/context_length_exceeded），
  // 不能和真正的限流混为一谈，否则会把“输入过长”误判成 BLOCKED。
  if (/context_length|input_limit/i.test(code) || /context_length|input limit|输入/i.test(message)) return false;
  return result.status === 429 || /rate_limit|queue_full|queue_timeout/i.test(code) || /限流|429|rate limit/i.test(message);
}

async function probeInputLimit(options, model, state) {
  const rows = [];
  for (const chars of options.steps) {
    const sessionId = await createSession(options, model);
    const content = `${filler(Math.max(0, chars - 30), chars)}请只回复 OK。`;
    const result = await sendMessage(options, sessionId, content);
    rows.push({ chars, ...result, eventTypes: [...new Set(result.eventTypes)] });
    console.log(`  input ${chars} → HTTP ${result.status} ${result.ok ? 'OK' : JSON.stringify(result.error).slice(0, 140)}`);
    if (!result.ok && isRateLimit(result)) {
      state.blocked = 'upstream 429/限流（共享匿名额度）';
      break;
    }
    if (!result.ok) break;
    await sleep(options.intervalMs);
  }
  const lastOk = [...rows].reverse().find((row) => row.ok);
  const firstFail = rows.find((row) => !row.ok);
  return {
    steps: rows.map((row) => ({
      chars: row.chars,
      status: row.status,
      ok: row.ok,
      error: row.error ? { code: row.error.code, message: String(row.error.message || '').slice(0, 160) } : null
    })),
    measuredMaxInputChars: lastOk ? lastOk.chars : null,
    rejectedAt: firstFail ? firstFail.chars : null,
    rejection: firstFail?.error ? { code: firstFail.error.code, message: String(firstFail.error.message || '').slice(0, 160) } : null
  };
}

async function probeConversationLimit(options, model, state) {
  const sessionId = await createSession(options, model);
  const turns = [];
  let totalChars = 0;
  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    const content = `第${turn}轮：${filler(Math.max(120, options.perTurnChars), turn * 7919)} 请用一句话回应。`;
    const result = await sendMessage(options, sessionId, content);
    totalChars += content.length + (result.doneContentChars ?? result.deltaChars);
    turns.push({
      turn,
      ok: result.ok,
      status: result.status,
      replyChars: result.doneContentChars ?? result.deltaChars,
      compacted: result.eventTypes.includes('compacted'),
      error: result.error ? { code: result.error.code, message: String(result.error.message || '').slice(0, 160) } : null,
      totalChars
    });
    console.log(
      `  turn ${turn} → HTTP ${result.status} ${result.ok ? `OK ${result.doneContentChars ?? result.deltaChars} chars${result.eventTypes.includes('compacted') ? ' · compacted' : ''}` : JSON.stringify(result.error).slice(0, 140)}`
    );
    if (!result.ok) {
      if (isRateLimit(result)) state.blocked = 'upstream 429/限流（共享匿名额度）';
      break;
    }
    await sleep(options.intervalMs);
  }
  const lastOk = [...turns].reverse().find((turn) => turn.ok);
  const fail = turns.find((turn) => !turn.ok);
  return {
    maxSuccessfulTurns: lastOk ? lastOk.turn : 0,
    maxSuccessfulTotalChars: lastOk ? lastOk.totalChars : 0,
    maxSuccessfulTotalTokensEstimate: lastOk ? estimateTokens(lastOk.totalChars) : 0,
    failedTurn: fail ? fail.turn : null,
    failure: fail?.error ? { code: fail.error.code, message: String(fail.error.message || '').slice(0, 160) } : null,
    compactedAtTurn: turns.filter((turn) => turn.compacted).map((turn) => turn.turn),
    turns
  };
}

async function probeOutputLength(options, model) {
  const sessionId = await createSession(options, model);
  const result = await sendMessage(
    options,
    sessionId,
    '请写一篇尽量长的中文散文，主题是秋日山谷，不要提前结束，至少写 2000 字，能写更长就继续写。'
  );
  return {
    ok: result.ok,
    status: result.status,
    chars: result.doneContentChars ?? result.deltaChars,
    tokensEstimate: estimateTokens(result.doneContentChars ?? result.deltaChars),
    eventTypes: [...new Set(result.eventTypes)],
    error: result.error ? { code: result.error.code, message: String(result.error.message || '').slice(0, 160) } : null
  };
}

function summarize(report) {
  const lines = ['', 'model                               input max ok   input rejected   conv turns   conv chars   output   status', '-'.repeat(112)];
  for (const item of report.models) {
    const input = item.input?.measuredMaxInputChars ?? '—';
    const rejected = item.input?.rejectedAt ? `${item.input.rejectedAt}` : '—';
    const turns = item.conversation?.maxSuccessfulTurns ?? '—';
    const chars = item.conversation?.maxSuccessfulTotalChars ?? '—';
    const output = item.output ? (item.output.ok ? item.output.chars : 'ERR') : '—';
    const status = item.blocked ? `BLOCKED: ${item.blocked}` : 'OK';
    lines.push(
      `${String(item.model).padEnd(35)} ${String(input).padEnd(13)} ${String(rejected).padEnd(16)} ${String(turns).padEnd(12)} ${String(chars).padEnd(12)} ${String(output).padEnd(8)} ${status}`
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: node scripts/limit-probe-gateway.mjs --admin-token <token> --models gpt-6-luna [--input-only] [--max-turns 12]');
    return;
  }
  const health = await jsonFetch(options, '/healthz').catch((error) => ({ status: 0, text: error.message }));
  if (health.status !== 200) {
    throw new UsageError(`网关不可达（${options.baseUrl}/healthz → ${health.status}）`);
  }
  console.log(
    `gateway probe · ${options.baseUrl} · models=${options.models.join(',')} · interval=${options.intervalMs}ms · maxTurns=${options.maxTurns}`
  );

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    intervalMs: options.intervalMs,
    maxTurns: options.maxTurns,
    perTurnChars: options.perTurnChars,
    charsPerTokenEstimate: CHARS_PER_TOKEN_ESTIMATE,
    models: []
  };

  for (const model of options.models) {
    const state = { blocked: null };
    const item = { model, input: null, conversation: null, output: null, blocked: null };
    console.log(`\n=== ${model} ===`);
    try {
      if (!options.conversationOnly && !options.outputOnly) {
        item.input = await probeInputLimit(options, model, state);
        console.log(`  input result: maxOk=${item.input.measuredMaxInputChars} rejectedAt=${item.input.rejectedAt} ${JSON.stringify(item.input.rejection || {})}`);
      }
      if (!options.inputOnly && !options.outputOnly) {
        item.conversation = await probeConversationLimit(options, model, state);
        console.log(
          `  conversation: turns=${item.conversation.maxSuccessfulTurns} chars=${item.conversation.maxSuccessfulTotalChars} tokens≈${item.conversation.maxSuccessfulTotalTokensEstimate} ${JSON.stringify(item.conversation.failure || {})}`
        );
      }
      if (!options.inputOnly && !options.conversationOnly) {
        item.output = await probeOutputLength(options, model);
        console.log(`  output: ${JSON.stringify(item.output)}`);
      }
    } catch (error) {
      item.blocked = `probe failed: ${error.message}`;
      console.error('probe failed:', error.message);
    }
    item.blocked = item.blocked || state.blocked;
    report.models.push(item);
    report.finishedAt = new Date().toISOString();
    if (item.blocked) {
      console.warn(`⚠ ${model} BLOCKED: ${item.blocked}`);
      await sleep(60000);
    }
  }

  const outPath =
    options.out || path.join(PROJECT_ROOT, 'data', 'tmp', `limit-gateway-${Date.now()}.json`);
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
