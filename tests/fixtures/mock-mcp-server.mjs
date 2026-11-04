#!/usr/bin/env node
/**
 * 最小 stdio MCP server（测试用）：
 * - initialize / notifications/initialized
 * - tools/list：echo、add
 * - tools/call：echo / add / 未知工具 isError
 * 仅使用 Node 内置模块。
 */

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function writeExitMarker() {
  const exitFile = process.env.MOCK_MCP_EXIT_FILE;
  if (!exitFile) return;
  try {
    writeFileSync(exitFile, `exited:${Date.now()}\n`, 'utf8');
  } catch {
    // ignore
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('close', () => {
  // 管理器 close() 会先 stdin.end()；Windows 上 SIGTERM 不会触发 JS handler，EOF 是最可靠的退出信号
  writeExitMarker();
});
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let message = null;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;
  const method = message.method;
  const params = message.params && typeof message.params === 'object' ? message.params : {};

  if (method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      capabilities: { tools: {} }
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    reply(message.id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (name === 'echo') {
      reply(message.id, { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }], isError: false });
      return;
    }
    if (name === 'add') {
      const total = Number(args.a) + Number(args.b);
      reply(message.id, { content: [{ type: 'text', text: String(total) }], isError: false });
      return;
    }
    reply(message.id, {
      content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
      isError: true
    });
    return;
  }

  if (message.id !== undefined) replyError(message.id, -32601, `Method not found: ${String(method)}`);
});

process.on('SIGTERM', () => {
  const exitFile = process.env.MOCK_MCP_EXIT_FILE;
  if (exitFile) {
    try {
      writeFileSync(exitFile, `exited:${Date.now()}\n`, 'utf8');
    } catch {
      // ignore
    }
  }
  process.exit(0);
});

// 沙箱/Windows 下 stdin 关闭可能先于 SIGTERM 到达：任何退出路径都写标记，测试才能断言
process.on('exit', () => {
  const exitFile = process.env.MOCK_MCP_EXIT_FILE;
  if (!exitFile) return;
  try {
    writeFileSync(exitFile, `exited:${Date.now()}\n`, 'utf8');
  } catch {
    // ignore
  }
});
