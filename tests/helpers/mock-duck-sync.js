/**
 * QA 辅助：mock DuckDuckGo Sync 服务（v2.8 设备注册流程：login / keys / devices）。
 *
 * 与 `mock-sync-service.js`（配对 exchange 频道）互补：这里提供**通用路由注册**，测试按最终实现
 * 注册 `POST /login`、`GET/PATCH /keys`、`GET/PATCH/DELETE /devices` 等，并记录每个请求（方法/路径/
 * 查询/JSON body/headers）供断言（如 login payload 的 JWE、PATCH 的 updates）。
 *
 * 用法：
 *   const sync = createMockDuckSync();
 *   sync.on('POST', '/login', ({ body }) => ({ status: 200, json: { token: 'jwt-1' } }));
 *   sync.on('GET', '/keys', () => ({ status: 200, json: { keys: [] } }));
 *   const client = await createSyncClient({ fetchImpl: sync.fetchImpl, ... });
 *   assert.equal(sync.requests.filter((r) => r.pathname.endsWith('/login')).length, 1);
 */

export function createMockDuckSync(options = {}) {
  const routes = [];
  const requests = [];
  const state = options.state || {};

  function on(method, pattern, handler) {
    routes.push({ method: String(method).toUpperCase(), pattern: pattern instanceof RegExp ? pattern : new RegExp(pattern), handler });
    return api;
  }

  function matchRoute(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (match) return { route, match };
    }
    return null;
  }

  async function fetchImpl(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    const url = new URL(String(rawUrl));
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (init.body !== undefined && init.body !== null) {
      const text = typeof init.body === 'string' ? init.body : String(init.body);
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const record = {
      method,
      url: url.href,
      pathname: url.pathname,
      search: url.search,
      query: url.searchParams,
      body,
      headers: normalizeHeaders(init.headers),
      at: Date.now()
    };
    requests.push(record);

    const matched = matchRoute(method, url.pathname);
    if (!matched) {
      return jsonResponse({ error: 'unexpected_request', method, pathname: url.pathname }, 599);
    }
    const result = await matched.route.handler({
      url,
      method,
      body,
      record,
      match: matched.match,
      state,
      requests,
      json: (data, status = 200) => jsonResponse(data, status)
    });
    return toResponse(result);
  }

  function requestList(method = null, pathPattern = null) {
    const pattern = pathPattern ? (pathPattern instanceof RegExp ? pathPattern : new RegExp(pathPattern)) : null;
    return requests.filter(
      (request) => (!method || request.method === String(method).toUpperCase()) && (!pattern || pattern.test(request.pathname))
    );
  }

  const api = {
    fetchImpl,
    on,
    requests,
    state,
    requestList,
    lastRequest: () => requests[requests.length - 1] || null,
    reset() {
      requests.length = 0;
    }
  };
  return api;
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    const result = {};
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }
  const result = {};
  for (const [key, value] of Object.entries(headers)) result[String(key).toLowerCase()] = String(value);
  return result;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function toResponse(result) {
  if (result instanceof Response) return result;
  if (!result || typeof result !== 'object') return jsonResponse({ error: 'invalid_mock_result' }, 599);
  const { status = 200, json, text, headers = {} } = result;
  if (json !== undefined) {
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json', ...headers }
    });
  }
  return new Response(text ?? '', { status, headers });
}

export default createMockDuckSync;
