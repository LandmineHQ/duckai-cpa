/**
 * MCP（Model Context Protocol）客户端管理器。
 *
 * 传输：
 * - stdio：spawn 子进程，JSON-RPC 2.0 以换行分隔（每行一条消息）。
 * - http：POST JSON-RPC，支持 JSON 响应与 text/event-stream（SSE data 行），
 *   并回传 Mcp-Session-Id。
 *
 * 该方法只负责连接/握手/列工具/调工具；工具定义如何注入提示词由上层负责。
 */

import { spawn } from 'node:child_process';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30000;
const CLIENT_INFO = { name: 'duckai-cpa', version: '2.23' };

function mcpError(message, { status = 502, code = 'mcp_error', cause = null } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  error.code = code;
  return error;
}

function safeLogger(logger) {
  return {
    warn: (message, detail) => {
      try {
        logger?.warn?.(message, detail);
      } catch {
        // 日志失败不影响 MCP 主流程
      }
    },
    info: (message, detail) => {
      try {
        logger?.info?.(message, detail);
      } catch {
        // ignore
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* stdio 传输                                                          */
/* ------------------------------------------------------------------ */

class StdioTransport {
  constructor({ server, logger, timeoutMs }) {
    this.server = server;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 0;
    this.exited = false;
    this.closing = false;
  }

  async connect() {
    const command = this.server.command || process.execPath;
    const args = Array.isArray(this.server.args) ? this.server.args.map(String) : [];
    const env = { ...process.env, ...(this.server.env || {}) };
    this.child = spawn(command, args, {
      cwd: this.server.cwd || undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.logger.warn(`[mcp:${this.server.name}] stderr`, { text: text.slice(0, 2000) });
    });
    this.child.on('error', (error) => {
      this.exited = true;
      this._rejectAll(mcpError(`MCP stdio server "${this.server.name}" failed: ${error.message}`, {
        code: 'mcp_transport_error',
        cause: error
      }));
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      if (!this.closing) {
        this.logger.warn(`[mcp:${this.server.name}] process exited`, { code, signal });
      }
      this._rejectAll(
        mcpError(`MCP stdio server "${this.server.name}" exited (code=${code}, signal=${signal})`, {
          code: 'mcp_server_exited'
        })
      );
    });

    const init = await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    this._notify('notifications/initialized', {});
    return init;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this._onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  _onLine(line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger.warn(`[mcp:${this.server.name}] invalid JSON line`, {
        error: error.message,
        line: line.slice(0, 500)
      });
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          mcpError(message.error.message || 'MCP JSON-RPC error', {
            code: 'mcp_rpc_error'
          })
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // 服务端通知（如 notifications/message）忽略，但记录日志便于排障。
    if (message.method) {
      this.logger.info(`[mcp:${this.server.name}] notification`, { method: message.method });
    }
  }

  _send(message) {
    if (this.exited || !this.child || !this.child.stdin.writable) {
      throw mcpError(`MCP stdio server "${this.server.name}" is not running`, {
        code: 'mcp_server_exited'
      });
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(
          mcpError(`MCP request "${method}" timed out after ${timeoutMs}ms`, {
            status: 504,
            code: 'mcp_timeout'
          })
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  _notify(method, params) {
    try {
      this._send({ jsonrpc: '2.0', method, params });
    } catch (error) {
      this.logger.warn(`[mcp:${this.server.name}] notification failed`, { error: error.message });
    }
  }

  _rejectAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  async listTools() {
    const result = await this._request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} });
  }

  async close() {
    this.closing = true;
    this._rejectAll(mcpError(`MCP stdio server "${this.server.name}" closed`, { code: 'mcp_closed' }));
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 800);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 传输                                                           */
/* ------------------------------------------------------------------ */

function parseSseJsonRpc(text, expectedId) {
  const messages = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch {
      // 忽略非 JSON data 行
    }
  }
  if (!messages.length) return null;
  return messages.find((message) => message.id === expectedId) || messages[messages.length - 1];
}

class HttpTransport {
  constructor({ server, logger, timeoutMs }) {
    this.server = server;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 0;
  }

  async connect() {
    if (typeof fetch !== 'function') {
      throw mcpError('global fetch is not available (Node >= 18 required)', { code: 'mcp_transport_error' });
    }
    await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    await this._notify('notifications/initialized', {});
  }

  _headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.server.headers && typeof this.server.headers === 'object' ? this.server.headers : {})
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  async _post(message, { timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.server.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(message),
        signal: controller.signal
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const text = await response.text();
      if (!response.ok) {
        throw mcpError(`MCP HTTP server "${this.server.name}" returned HTTP ${response.status}`, {
          status: 502,
          code: 'mcp_http_error'
        });
      }
      if (message.id === undefined) return null;
      if (contentType.includes('text/event-stream')) {
        const parsed = parseSseJsonRpc(text, message.id);
        if (!parsed) throw mcpError('MCP SSE response did not contain a JSON-RPC response', {
          code: 'mcp_bad_response'
        });
        return parsed;
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        const parsed = parseSseJsonRpc(text, message.id);
        if (parsed) return parsed;
        throw mcpError('MCP HTTP response is not valid JSON', { code: 'mcp_bad_response' });
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw mcpError(`MCP HTTP request timed out after ${timeoutMs}ms`, {
          status: 504,
          code: 'mcp_timeout'
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.nextId;
    const message = await this._post({ jsonrpc: '2.0', id, method, params }, { timeoutMs });
    if (message?.error) {
      throw mcpError(message.error.message || 'MCP JSON-RPC error', { code: 'mcp_rpc_error' });
    }
    return message?.result;
  }

  async _notify(method, params) {
    await this._post({ jsonrpc: '2.0', method, params });
  }

  async listTools() {
    const result = await this._request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} });
  }

  async close() {
    this.sessionId = null;
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

function normalizeToolResult(result) {
  const contentList = Array.isArray(result?.content) ? result.content : [];
  const content = contentList
    .map((item) => {
      if (item && item.type === 'text') return String(item.text ?? '');
      return JSON.stringify(item);
    })
    .join('');
  return { content, isError: result?.isError === true };
}

/**
 * 创建 MCP 管理器（懒加载：listTools/callTool 首次调用时连接）。
 * @param {{config?: {enabled?: boolean, timeoutMs?: number, servers?: Array<Record<string, any>>}, logger?: any}} options
 */
export async function createMcpManager({ config, logger } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const log = safeLogger(logger);
  const servers = Array.isArray(cfg.servers) ? cfg.servers.filter((item) => item && typeof item === 'object') : [];
  const enabled = cfg.enabled !== false;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

  let initPromise = null;
  let initialized = false;
  let closed = false;
  /** @type {Array<{name:string, transport:any, client:any}>} */
  let clients = [];
  /** @type {Array<{name:string, description:string, inputSchema:object, server:string, rawName:string, client:any}>} */
  let tools = [];

  async function doInit() {
    if (!enabled || servers.length === 0) {
      initialized = true;
      return;
    }
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      const name = typeof server.name === 'string' && server.name.trim() ? server.name.trim() : `server${index + 1}`;
      const transportName = server.transport || (server.url ? 'http' : 'stdio');
      if (transportName !== 'stdio' && transportName !== 'http') {
        log.warn(`[mcp] 跳过未知 transport 的 server "${name}"`, { transport: transportName });
        continue;
      }
      const transport =
        transportName === 'stdio'
          ? new StdioTransport({ server: { ...server, name }, logger: log, timeoutMs })
          : new HttpTransport({ server: { ...server, name }, logger: log, timeoutMs });
      try {
        await transport.connect();
        const rawTools = await transport.listTools();
        clients.push({ name, transport, client: transport });
        for (const rawTool of Array.isArray(rawTools) ? rawTools : []) {
          const rawName = typeof rawTool?.name === 'string' ? rawTool.name : '';
          if (!rawName) continue;
          const qualified = servers.length === 1 ? rawName : `${name}__${rawName}`;
          tools.push({
            name: qualified,
            description: typeof rawTool.description === 'string' ? rawTool.description : '',
            inputSchema:
              rawTool.inputSchema && typeof rawTool.inputSchema === 'object'
                ? rawTool.inputSchema
                : { type: 'object', properties: {} },
            server: name,
            rawName,
            client: transport
          });
        }
      } catch (error) {
        log.warn(`[mcp] server "${name}" 初始化失败，已跳过`, {
          error: error?.message || String(error),
          code: error?.code || null
        });
        await transport.close().catch(() => {});
      }
    }
    initialized = true;
  }

  async function ensureInit() {
    if (initPromise) return initPromise;
    if (closed) {
      initialized = true;
      return;
    }
    initPromise = doInit().catch((error) => {
      initialized = true;
      log.warn('[mcp] 初始化异常', { error: error?.message || String(error) });
    });
    return initPromise;
  }

  const manager = {
    get available() {
      return initialized && !closed ? clients.length > 0 : false;
    },

    async init() {
      await ensureInit();
      return manager;
    },

    async listTools() {
      await ensureInit();
      return tools.map(({ name, description, inputSchema, server, rawName }) => ({
        name,
        description,
        inputSchema,
        server,
        rawName
      }));
    },

    async callTool(name, args) {
      await ensureInit();
      if (!manager.available) {
        throw mcpError('MCP 不可用：没有可用的 MCP server', {
          status: 502,
          code: 'mcp_unavailable'
        });
      }
      const qualified = typeof name === 'string' ? name.trim() : '';
      if (!qualified) {
        throw mcpError('tool name is required', { status: 400, code: 'invalid_tool' });
      }
      let target = tools.find((item) => item.name === qualified);
      if (!target) {
        // 单 server 时允许直接调用原始工具名（未列出的工具交由 server 返回 isError）。
        if (clients.length === 1) {
          target = { name: qualified, rawName: qualified, server: clients[0].name, client: clients[0].client };
        } else {
          throw mcpError(`MCP tool "${qualified}" 不存在`, {
            status: 404,
            code: 'mcp_tool_not_found'
          });
        }
      }
      try {
        const result = await target.client.callTool(target.rawName, args);
        return normalizeToolResult(result);
      } catch (error) {
        if (error?.status || error?.code) throw error;
        throw mcpError(`MCP 工具 "${qualified}" 调用失败：${error?.message || String(error)}`, {
          code: 'mcp_tool_call_failed',
          cause: error
        });
      }
    },

    async close() {
      closed = true;
      const pending = clients;
      clients = [];
      tools = [];
      await Promise.allSettled(pending.map((item) => item.client.close()));
    }
  };

  return manager;
}

export default createMcpManager;
