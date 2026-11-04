/**
 * QA 辅助：mock DuckDuckGo Sync v2 exchange 服务（fetchImpl 注入 PairingHost）。
 *
 * 提供：
 *   - PUT  <base>/v2/exchange/<channelId>              → 204（可配置失败）
 *   - GET  <base>/v2/exchange/<channelId>/messages     → {messages:[{seq,version,payload}]}（读取 queue，seq 连续）
 *   - POST <base>/v2/exchange/<channelId>/messages     → 204（记录 outbound 消息）
 *
 * base 默认含 `/sync` 前缀（如 https://sync.example.test/sync），所以按 `'/v2/exchange/'` 子串定位。
 */

export function createMockSyncService(options = {}) {
  const channels = new Map(); // channelId → inbound messages [{seq,version,payload}]
  const outbound = []; // {channelId, messages, at}
  const puts = [];
  let putStatus = options.putStatus ?? 204;
  let getStatusResolver = options.getStatusResolver || null;

  const ensure = (channelId) => {
    if (!channels.has(channelId)) channels.set(channelId, []);
    return channels.get(channelId);
  };

  function parseRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    const url = new URL(String(raw));
    const marker = url.pathname.indexOf('/v2/exchange/');
    if (marker === -1) return { url, rest: null };
    const rest = url.pathname.slice(marker + '/v2/exchange/'.length).split('/').filter(Boolean);
    return { url, rest }; // [channelId] or [channelId,'messages']
  }

  async function fetchImpl(input, init = {}) {
    const { url, rest } = parseRequest(input);
    if (!rest) return new Response(JSON.stringify({ error: 'unexpected' }), { status: 599 });
    const method = String(init.method || 'GET').toUpperCase();
    const channelId = rest[0];

    if (method === 'PUT' && rest.length === 1) {
      puts.push({ channelId, at: Date.now(), url: url.href });
      return new Response(null, { status: putStatus });
    }
    if (method === 'GET' && rest[1] === 'messages') {
      const status = getStatusResolver ? getStatusResolver({ channelId, url, init }) : 200;
      if (status !== 200) return new Response(JSON.stringify({ error: 'not found' }), { status });
      const after = Number(url.searchParams.get('after') || 0);
      const messages = ensure(channelId).filter((message) => message.seq > after);
      return new Response(JSON.stringify({ messages }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (method === 'POST') {
      let body = null;
      try {
        body = JSON.parse(String(init.body || '{}'));
      } catch {
        body = {};
      }
      outbound.push({ channelId, messages: body.messages || [], at: Date.now() });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: 'unexpected', method, rest }), { status: 599 });
  }

  return {
    fetchImpl,
    channels,
    puts,
    outbound,
    setPutStatus(status) {
      putStatus = status;
    },
    pushInbound(channelId, payload, seq = null) {
      const list = ensure(channelId);
      const next = seq ?? (list.length ? list[list.length - 1].seq + 1 : 1);
      list.push({ seq: next, version: '2', payload });
      return next;
    },
    inbound(channelId) {
      return ensure(channelId);
    },
    outboundFor(channelId) {
      return outbound.filter((entry) => entry.channelId === channelId);
    }
  };
}
