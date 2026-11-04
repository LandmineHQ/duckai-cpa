/**
 * v2.12 compact 触发语义后端（task-50）：
 * 白名单模型才自动压缩、pair/字符兜底触发、SUMMARY_REFRESH_HINT→pendingCompaction、
 * LIMIT_CONVERSATION 压缩重试、手动 compact 任意模型、summary PATCH/DELETE、模型能力字段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, adminRequest, makeConfig, readSSEResponse } from './helpers/test-server.js';
import { DuckError } from '../src/duck/index.js';

const SUMMARY_TEXT = '- 摘要：用户目标与已确认事实（mock）';

function serverConfig(extra = {}) {
  return makeConfig({
    context: { compact: { enabled: true, triggerChars: 200000, keepRecentMessages: 2, maxSummaryChars: 400, ...extra } }
  });
}

function adminHeaders(env) {
  return { authorization: `Bearer ${env.adminToken}`, 'content-type': 'application/json' };
}

async function createSession(env, model = 'gpt-6-luna') {
  const res = await adminRequest(env.baseUrl, '/admin/api/test/sessions', {
    method: 'POST',
    body: { title: `v212-${model}`, model }
  });
  assert.equal(res.status, 201, res.text);
  return res.json.session;
}

async function sendMessage(env, sessionId, content) {
  const res = await fetch(`${env.baseUrl}/admin/api/test/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: adminHeaders(env),
    body: JSON.stringify({ content })
  });
  const events = await readSSEResponse(res).catch(() => []);
  return { status: res.status, events };
}

/** v2.21：需要看 409 的 JSON body（SSE 助手会丢掉非 200 的正文）。 */
async function rawSendMessage(env, sessionId, content) {
  const res = await fetch(`${env.baseUrl}/admin/api/test/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: adminHeaders(env),
    body: JSON.stringify({ content })
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
function payload(event) {
  if (!event) return null;
  if (event.json && typeof event.json === 'object') return event.json;
  if (typeof event.data === 'string') {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }
  return null;
}

function doneEvent(events) {
  return [...events].reverse().map(payload).find((item) => item && item.type === 'done') || null;
}

async function getSession(env, sessionId) {
  const res = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(res.status, 200, res.text);
  return res.json.session;
}

const LONG = '订单 A-102、客户回电与发票地址；需要保留关键数字、标识符与约束。'.repeat(30);
const MEDIUM = '第 {n} 轮：订单 A-102 与周四回电。';

function medium(round) {
  return `第 ${round} 轮：订单 A-102 与周四回电，保留发票地址与发货时间约束。`.repeat(3);
}

/* ------------------------------------------------------------------ */
/* 1) 自动压缩：模型白名单 + pair/字符触发                              */
/* ------------------------------------------------------------------ */

test('gpt-6-luna 长会话不自动压缩（不支持白名单）：无 summarize、done.compacted、session.summary=null', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-6-luna');
    for (let round = 0; round < 6; round += 1) {
      const { status, events } = await sendMessage(env, session.id, `${medium(round + 1)}${LONG}`);
      assert.equal(status, 200);
      const done = doneEvent(events);
      assert.ok(!done?.compacted, `gpt-6-luna 第 ${round + 1} 轮不应自动压缩`);
    }
    assert.equal(env.duck.calls.summarize.length, 0, 'gpt-6-luna 不应调用摘要');
    const state = await getSession(env, session.id);
    assert.equal(state.summary ?? null, null, 'gpt-6-luna 不应有 summary');
  });
});

test('gpt-5.4-mini 无 activation：fallback pair>=4 才压缩（4 pairs 后触发）', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-5.4-mini');
    let compactedRound = null;
    for (let round = 1; round <= 6; round += 1) {
      const { events } = await sendMessage(env, session.id, medium(round));
      const done = doneEvent(events);
      if (done?.compacted) {
        compactedRound = round;
        break;
      }
    }
    assert.ok(compactedRound, 'gpt-5.4-mini 应在 pair>=4 后触发压缩');
    assert.ok(compactedRound >= 5, `应在第 5 轮（4 pairs + 当前问题）后触发（实际第 ${compactedRound} 轮）`);
    assert.ok(env.duck.calls.summarize.length >= 1);
    const state = await getSession(env, session.id);
    assert.equal(state.summary?.text, SUMMARY_TEXT);
  });
});

test('字符兜底：支持模型 triggerChars 小值可触发（trigger=chars）；gpt-6-luna 同配置仍不压缩', async () => {
  await withServer({ config: serverConfig({ triggerChars: 1000 }) }, async (env) => {
    const supported = await createSession(env, 'gpt-5.4-mini');
    await sendMessage(env, supported.id, medium(1));
    await sendMessage(env, supported.id, medium(2));
    const first = await sendMessage(env, supported.id, LONG);
    const done = doneEvent(first.events);
    assert.equal(done?.compacted, true, '支持模型字符兜底应压缩');
    assert.equal(done.summary?.trigger, 'chars');
    assert.ok(env.duck.calls.summarize.length >= 1);

    const unsupported = await createSession(env, 'gpt-6-luna');
    await sendMessage(env, unsupported.id, medium(1));
    await sendMessage(env, unsupported.id, medium(2));
    const before = env.duck.calls.summarize.length;
    const second = await sendMessage(env, unsupported.id, LONG);
    assert.ok(!doneEvent(second.events)?.compacted, 'gpt-6-luna 即使超字符也不压缩');
    assert.equal(env.duck.calls.summarize.length, before, 'gpt-6-luna 不应调用摘要');
  });
});

/* ------------------------------------------------------------------ */
/* 2) SUMMARY_REFRESH_HINT → pendingCompaction + summaryInvalid        */
/* ------------------------------------------------------------------ */

test('SUMMARY_REFRESH_HINT：URL 编码 JSON → done.pendingCompaction + session.pendingCompaction，正文剥离标记', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-5.4-mini');
    const hint = { baseCoveredPairCount: 1, targetPairCount: 6, thresholdTokens: 9000, trigger: 'tokens' };
    const marker = `[SUMMARY_REFRESH_HINT:${encodeURIComponent(JSON.stringify(hint))}]`;
    env.duck.enqueueChat({ textDeltas: [`回答正文。${marker}`] });
    const { events } = await sendMessage(env, session.id, '触发上游 hint 的单轮问题');
    const done = doneEvent(events);
    assert.ok(done, events.length ? '应有 done' : '无事件');
    assert.equal(done.pendingCompaction?.targetPairCount, 6);
    assert.equal(done.pendingCompaction?.thresholdTokens, 9000);
    assert.equal(done.pendingCompaction?.trigger, 'tokens');
    assert.ok(!String(done.message?.content || '').includes('SUMMARY_REFRESH_HINT'), '正文应剥离标记');

    const state = await getSession(env, session.id);
    assert.equal(state.pendingCompaction?.targetPairCount, 6);
    assert.equal(state.pendingCompaction?.thresholdTokens, 9000);

    // 编辑 summary 后 pending 清空
    const patched = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/summary`, {
      method: 'PATCH',
      body: { text: '手动摘要' }
    });
    assert.equal(patched.status, 200, patched.text);
    const after = await getSession(env, session.id);
    assert.equal(after.pendingCompaction ?? null, null, '编辑 summary 后 pendingCompaction 应清空');
  });
});

test('SUMMARY_INVALID：done.summaryInvalid + session.summaryInvalid=true', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-5.4-mini');
    env.duck.enqueueChat({ textDeltas: ['回答[SUMMARY_INVALID]'] });
    const { events } = await sendMessage(env, session.id, '触发 invalid');
    const done = doneEvent(events);
    assert.equal(done?.summaryInvalid, true);
    assert.ok(!String(done?.message?.content || '').includes('SUMMARY_INVALID'));
    const state = await getSession(env, session.id);
    assert.equal(state.summaryInvalid, true);
  });
});

/* ------------------------------------------------------------------ */
/* 3) LIMIT_CONVERSATION（conversation_limit_reached）压缩重试          */
/* ------------------------------------------------------------------ */

test('conversation_limit_reached：v2.21 任意模型都不自动压缩，返回 409 + hint', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-6-luna');
    for (let round = 0; round < 4; round += 1) {
      await sendMessage(env, session.id, medium(round + 1));
    }
    env.duck.enqueueChat({
      error: new DuckError('conversation limit', {
        status: 409,
        type: 'conversation_limit',
        code: 'conversation_limit_reached',
        retriable: false
      })
    });
    const before = env.duck.calls.summarize.length;
    const beforeChats = env.duck.calls.chat.length;
    const { status, json } = await rawSendMessage(env, session.id, '继续：触发 limit 后由客户端决定是否压缩。');
    assert.equal(status, 409, '会话上限应原样返回 409（不再自动压缩重试）');
    assert.equal(json?.error?.code, 'conversation_limit_reached');
    assert.match(String(json?.error?.hint || ''), /\/v1\/compact/, '409 应提示客户端主动压缩');
    assert.equal(env.duck.calls.summarize.length, before, '不应自动调用摘要');
    assert.equal(env.duck.calls.chat.length, beforeChats + 1, '不应自动重试上游');
  });
});

/* ------------------------------------------------------------------ */
/* 4) 手动 compact 任意模型 + summary PATCH/DELETE                      */
/* ------------------------------------------------------------------ */

test('手动 compact：gpt-6-luna（不支持自动压缩）也可手动压缩，trigger=manual', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-6-luna');
    for (let round = 0; round < 4; round += 1) {
      await sendMessage(env, session.id, medium(round + 1));
    }
    const compact = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/compact`, {
      method: 'POST',
      body: {}
    });
    assert.equal(compact.status, 200, compact.text);
    assert.equal(compact.json.summary.trigger, 'manual');
    assert.equal(compact.json.summary.text, SUMMARY_TEXT);
    assert.equal(compact.json.session.summary.text, SUMMARY_TEXT);
  });
});

test('summary PATCH/DELETE：编辑持久化/校验/清除恢复；未知会话 404', async () => {
  await withServer({ config: serverConfig() }, async (env) => {
    const session = await createSession(env, 'gpt-6-luna');
    const patched = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/summary`, {
      method: 'PATCH',
      body: { text: '  手写摘要：保留订单 A-102  ', coveredPairCount: 2 }
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.ok, true);
    assert.equal(patched.json.summary.text, '手写摘要：保留订单 A-102');
    assert.equal(patched.json.summary.trigger, 'manual');
    assert.equal(patched.json.summary.coveredPairCount, 2);
    assert.equal((await getSession(env, session.id)).summary.text, '手写摘要：保留订单 A-102');

    const invalid = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/summary`, {
      method: 'PATCH',
      body: { text: '   ' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_summary');

    const cleared = await adminRequest(env.baseUrl, `/admin/api/test/sessions/${encodeURIComponent(session.id)}/summary`, {
      method: 'DELETE'
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.ok, true);
    assert.equal(cleared.json.cleared, true);
    assert.equal(cleared.json.summary, null);
    const state = await getSession(env, session.id);
    assert.equal(state.summary ?? null, null, 'DELETE 后 summary 应清空');
    assert.equal(state.pendingCompaction ?? null, null);

    const missing = await adminRequest(env.baseUrl, '/admin/api/test/sessions/sess_missing/summary', {
      method: 'PATCH',
      body: { text: 'x' }
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'session_not_found');
  });
});

/* ------------------------------------------------------------------ */
/* 5) 模型能力字段                                                     */
/* ------------------------------------------------------------------ */

test('模型能力：/v1/models 与 admin models 的 compaction_supported/activation_target_pair_count/input_char_limit 一致', async () => {
  await withServer({}, async (env) => {
    const v1 = await fetch(`${env.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${env.apiKey}` } });
    assert.equal(v1.status, 200);
    const v1Json = await v1.json();
    const luna = v1Json.data.find((model) => model.id === 'gpt-6-luna');
    const mini = v1Json.data.find((model) => model.id === 'gpt-5.4-mini');
    assert.equal(luna.compaction_supported, false, 'gpt-6-luna 不支持自动压缩');
    assert.equal(luna.activation_target_pair_count, 0);
    assert.equal(luna.input_char_limit, 16000);
    assert.equal(mini.compaction_supported, true, 'gpt-5.4-mini 支持自动压缩');
    assert.equal(mini.activation_target_pair_count, 0);
    assert.equal(mini.input_char_limit, 16000);
    assert.equal(luna.capabilities.compactionSupported, false);
    assert.equal(mini.capabilities.compactionSupported, true);

    const admin = await adminRequest(env.baseUrl, '/admin/api/models');
    const adminLuna = (admin.json.items || []).find((model) => model.id === 'gpt-6-luna');
    const adminMini = (admin.json.items || []).find((model) => model.id === 'gpt-5.4-mini');
    assert.equal(adminLuna.compaction_supported, false);
    assert.equal(adminMini.compaction_supported, true);
    assert.equal(adminLuna.activation_target_pair_count, 0);
    assert.equal(adminLuna.input_char_limit, 16000);
  });
});
