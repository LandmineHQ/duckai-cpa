/**
 * QA 测试辅助：进程内最小代理服务器（HTTP CONNECT + SOCKS5），仅监听 127.0.0.1 随机端口。
 *
 * 用途：v2.3 代理能力单测（不访问外网）：
 *   - `startHttpProxy()`：支持 CONNECT 隧道（https/任意 TCP）与 absolute-form 的普通 HTTP 转发；
 *     可选 Basic Auth（记录 Authorization 供断言“凭据是否随代理请求发送”）。
 *   - `startSocks5Proxy()`：最小 SOCKS5（no-auth，CONNECT，ATYP=IPv4/domain），用于验证 socks4/5 connector。
 *   - `startHttpOrigin()`：本地 HTTP 源站，返回 JSON（含请求头/来源端口），用于 exitIp / testUrl 断言。
 *
 * 所有 server 均返回 { port, url, requests, close() }；close() 会断开当前连接。
 */

import http from 'node:http';
import net from 'node:net';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server, sockets) {
  for (const socket of sockets) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * 最小 HTTP 代理：CONNECT 隧道 + absolute-form 转发。
 * @param {{ requireAuth?: string, forwardTo?: string }} [options]
 *   requireAuth: 若设置，要求 `Proxy-Authorization: Basic <base64(user:pass)>`（直接传完整头值）；
 *   forwardTo: 可选固定上游（测试可让代理把所有请求转发到该 URL，不真实出网）。
 */
export async function startHttpProxy(options = {}) {
  const sockets = new Set();
  const requests = [];
  const proxy = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (options.requireAuth) {
      const provided = req.headers['proxy-authorization'] || req.headers.authorization || '';
      if (provided !== options.requireAuth) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="qa"' });
        res.end('proxy auth required');
        return;
      }
    }
    let target = req.url;
    if (!/^https?:\/\//i.test(target)) {
      // origin-form：用 Host 头补全
      target = `http://${req.headers.host}${target}`;
    }
    if (options.forwardTo) target = options.forwardTo;
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      res.writeHead(400);
      res.end('bad target');
      return;
    }
    const upstream = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host }
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`proxy upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });

  proxy.on('connect', (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on('error', () => {});
    requests.push({ method: 'CONNECT', url: req.url, headers: { ...req.headers } });
    if (options.requireAuth) {
      const provided = req.headers['proxy-authorization'] || '';
      if (provided !== options.requireAuth) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="qa"\r\n\r\n');
        return;
      }
    }
    const [host, portText] = String(req.url || '').split(':');
    const port = Number(portText) || 443;
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      try {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        /* ignore */
      }
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
  });

  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await listen(proxy);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    server: proxy,
    close: () => closeServer(proxy, sockets)
  };
}

/**
 * 最小 SOCKS5 代理（no-auth，仅 CONNECT）。
 * @param {{ username?: string, password?: string }} [options] 若提供则要求用户名/密码认证（0x02）
 */
export async function startSocks5Proxy(options = {}) {
  const sockets = new Set();
  const connections = [];
  const requireAuth = Boolean(options.username);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));

    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const version = buffer[0];
          const count = buffer[1];
          if (version !== 0x05) return socket.destroy();
          if (buffer.length < 2 + count) return;
          const methods = buffer.subarray(2, 2 + count);
          buffer = buffer.subarray(2 + count);
          if (requireAuth && methods.includes(0x02)) {
            socket.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else if (!requireAuth && methods.includes(0x00)) {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          } else {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          if (buffer.length) onData(Buffer.alloc(0));
          return;
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userLen = buffer[1];
          if (buffer.length < 2 + userLen + 1) return;
          const username = buffer.subarray(2, 2 + userLen).toString('utf8');
          const passLen = buffer[2 + userLen];
          if (buffer.length < 2 + userLen + 1 + passLen) return;
          const password = buffer.subarray(2 + userLen + 1, 2 + userLen + 1 + passLen).toString('utf8');
          buffer = buffer.subarray(2 + userLen + 1 + passLen);
          const ok = username === options.username && password === (options.password || '');
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = 'request';
          if (buffer.length) onData(Buffer.alloc(0));
          return;
        }

        if (stage === 'request') {
          if (buffer.length < 5) return;
          const version = buffer[0];
          const command = buffer[1];
          const atyp = buffer[3];
          if (version !== 0x05 || command !== 0x01) {
            socket.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          let address;
          let offset;
          if (atyp === 0x01) {
            if (buffer.length < 10) return;
            address = Array.from(buffer.subarray(4, 8)).join('.');
            offset = 8;
          } else if (atyp === 0x03) {
            const length = buffer[4];
            if (buffer.length < 5 + length + 2) return;
            address = buffer.subarray(5, 5 + length).toString('utf8');
            offset = 5 + length;
          } else if (atyp === 0x04) {
            if (buffer.length < 22) return;
            const parts = [];
            for (let index = 0; index < 8; index += 1) parts.push(buffer.readUInt16BE(4 + index * 2).toString(16));
            address = parts.join(':');
            offset = 20;
          } else {
            socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = buffer.readUInt16BE(offset);
          buffer = buffer.subarray(offset + 2);
          stage = 'connected';
          connections.push({ address, port, atyp });
          const upstream = net.connect(port, address, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (buffer.length) upstream.write(buffer);
            upstream.pipe(socket);
            socket.pipe(upstream);
          });
          sockets.add(upstream);
          upstream.on('error', () => {
            try {
              socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            } catch {
              /* ignore */
            }
          });
          upstream.on('close', () => sockets.delete(upstream));
          return;
        }
      } catch {
        socket.destroy();
      }
    };

    socket.on('data', onData);
  });

  const port = await listen(server);
  return {
    port,
    url: `socks5://127.0.0.1:${port}`,
    connections,
    server,
    close: () => closeServer(server, sockets)
  };
}

/**
 * 本地 HTTP 源站：返回 JSON（含请求来源信息），可选伪装 ipify。
 * @param {{ ip?: string, delayMs?: number }} [options]
 */
export async function startHttpOrigin(options = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: { ...req.headers }, at: Date.now() });
    const body = {
      ok: true,
      path: req.url,
      host: req.headers.host || null,
      remoteAddress: req.socket.remoteAddress,
      ip: options.ip || '203.0.113.7'
    };
    const payload = Buffer.from(JSON.stringify(body));
    const respond = () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length });
      res.end(payload);
    };
    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    server,
    close: () => closeServer(server, new Set())
  };
}

/** 取一个当前空闲的本地端口（用于「代理不可达」用例）。 */
export async function getClosedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server, new Set());
  return port;
}
