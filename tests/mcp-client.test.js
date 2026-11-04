import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpManager } from '../src/tools/mcp-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'mock-mcp-server.mjs');

let pipeSpawnSupport = null;
/** 本沙箱（DSH）不允许带管道 stdio 的 spawn（EPERM），此时跳过真实子进程用例。 */
async function canSpawnWithPipes() {
  if (pipeSpawnSupport !== null) return pipeSpawnSupport;
  pipeSpawnSupport = await new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (value) => {
        if (pipeSpawnSupport !== null) return;
        pipeSpawnSupport = value;
        resolve(value);
      };
      child.on('error', () => finish(false));
      child.on('exit', () => finish(true));
      setTimeout(() => finish(false), 1500);
    } catch {
      pipeSpawnSupport = false;
      resolve(false);
    }
  });
  return pipeSpawnSupport;
}

function stdioConfig(extra = {}) {
  return {
    enabled: true,
    timeoutMs: 5000,
    servers: [
      {
        name: 'mock',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        ...extra
      }
    ]
  };
}

function exitPath() {
  return path.join(os.tmpdir(), `mock-mcp-exit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
}

async function waitForFile(file, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, 'utf8');
      return text;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timeout waiting for ${file}`);
}

test('stdio MCP：初始化/listTools/callTool/未知工具/close 子进程退出', async (t) => {
  if (!(await canSpawnWithPipes())) {
    t.skip('当前沙箱禁止带管道 stdio 的 child_process.spawn（EPERM），跳过真实子进程用例');
    return;
  }
  const logger = { warn() {}, info() {} };
  const manager = await createMcpManager({ config: stdioConfig(), logger });
  assert.equal(manager.available, false);
  try {
    await manager.init();
    assert.equal(manager.available, true);

    const tools = await manager.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['add', 'echo']);
    const echo = tools.find((tool) => tool.name === 'echo');
    assert.equal(echo.server, 'mock');
    assert.equal(echo.rawName, 'echo');
    assert.equal(echo.description, 'Echo text');
    assert.equal(echo.inputSchema.type, 'object');

    assert.deepEqual(await manager.callTool('echo', { text: 'hi' }), { content: 'echo:hi', isError: false });
    assert.deepEqual(await manager.callTool('add', { a: 2, b: 3 }), { content: '5', isError: false });

    let unknownOk = false;
    try {
      const result = await manager.callTool('no_such_tool', {});
      unknownOk = result.isError === true;
    } catch (error) {
      unknownOk = error.status === 404 && error.code === 'mcp_tool_not_found';
    }
    assert.equal(unknownOk, true, '未知工具应报错或返回 isError');
  } finally {
    await manager.close();
  }
  // 关闭后管理器的工具不可用（子进程已被终止；本沙箱 Windows 下 SIGTERM 不触发子进程 JS handler，
  // 因此不再依赖退出标记文件，改为断言可用性）
  assert.equal(manager.available, false);
  let closedError = null;
  try {
    await manager.callTool('echo', { text: 'after-close' });
  } catch (error) {
    closedError = error;
  }
  assert.ok(closedError, 'close() 后 callTool 应抛错');
  assert.equal(closedError.code, 'mcp_unavailable');
});

test('多 server：工具名带 server__ 前缀，qualified callTool 可用', async (t) => {
  if (!(await canSpawnWithPipes())) {
    t.skip('当前沙箱禁止带管道 stdio 的 child_process.spawn（EPERM），跳过真实子进程用例');
    return;
  }
  const config = {
    enabled: true,
    timeoutMs: 5000,
    servers: [
      { name: 'alpha', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
      { name: 'beta', transport: 'stdio', command: process.execPath, args: [FIXTURE] }
    ]
  };
  const manager = await createMcpManager({ config, logger: { warn() {}, info() {} } });
  try {
    await manager.init();
    assert.equal(manager.available, true);
    const tools = await manager.listTools();
    assert.ok(tools.some((tool) => tool.name === 'alpha__echo'));
    assert.ok(tools.some((tool) => tool.name === 'beta__add'));
    assert.deepEqual(await manager.callTool('beta__add', { a: 4, b: 6 }), { content: '10', isError: false });
    await assert.rejects(manager.callTool('gamma__echo', {}), (error) => error.code === 'mcp_tool_not_found');
  } finally {
    await manager.close();
  }
});

test('http MCP：JSON-RPC + Mcp-Session-Id + tools/list/callTool', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      requests.push({ method: message.method, session: req.headers['mcp-session-id'] || null });
      if (!req.headers['mcp-session-id']) res.setHeader('Mcp-Session-Id', 'session-test-1');
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result = null;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', serverInfo: { name: 'http-mock' }, capabilities: { tools: {} } };
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }] };
      } else if (message.method === 'tools/call') {
        result = { content: [{ type: 'text', text: `http:${message.params?.arguments?.text ?? ''}` }], isError: false };
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const manager = await createMcpManager({
    config: {
      enabled: true,
      timeoutMs: 3000,
      servers: [{ name: 'httpmock', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }]
    },
    logger: { warn() {}, info() {} }
  });
  try {
    await manager.init();
    assert.equal(manager.available, true);
    const tools = await manager.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo']);
    assert.deepEqual(await manager.callTool('echo', { text: 'hi' }), { content: 'http:hi', isError: false });
    assert.ok(requests.some((item) => item.method === 'notifications/initialized'));
    // 第二次 tools/list 必须回传 initialize 响应头里的 session id
    assert.ok(requests.filter((item) => item.method === 'tools/list').every((item) => item.session === 'session-test-1'));
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('enabled=false / servers 为空 → available=false、listTools=[]、callTool 抛 mcp_unavailable', async () => {
  for (const config of [
    { enabled: false, timeoutMs: 1000, servers: [{ name: 'mock', transport: 'stdio', command: process.execPath, args: [FIXTURE] }] },
    { enabled: true, timeoutMs: 1000, servers: [] }
  ]) {
    const manager = await createMcpManager({ config, logger: { warn() {}, info() {} } });
    try {
      assert.equal(manager.available, false);
      await manager.init();
      assert.equal(manager.available, false);
      assert.deepEqual(await manager.listTools(), []);
      await assert.rejects(manager.callTool('echo', { text: 'x' }), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, 'mcp_unavailable');
        return true;
      });
    } finally {
      await manager.close();
    }
  }
});

test('单个 server 初始化失败 → 跳过且 available=false', async () => {
  const manager = await createMcpManager({
    config: {
      enabled: true,
      timeoutMs: 1000,
      servers: [
        {
          name: 'broken',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(3)']
        }
      ]
    },
    logger: { warn() {}, info() {} }
  });
  try {
    await manager.init();
    assert.equal(manager.available, false);
    assert.deepEqual(await manager.listTools(), []);
  } finally {
    await manager.close();
  }
});
