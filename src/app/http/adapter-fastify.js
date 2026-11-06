/**
 * Phase 5：可回滚 Fastify adapter（默认仍 native）。
 *
 * Fastify 只做传输壳：日志关闭；在 onRequest 阶段 reply.hijack()，把原始
 * IncomingMessage/ServerResponse 交给共享 Node request handler，避免 Fastify
 * 消费 body / 包装 SSE。路由表/鉴权/错误/静态仍由共享 handler 决定。
 */
import Fastify from 'fastify';
import { createRequestHandler } from '../../http/server.js';

export function createFastifyServer(options = {}) {
  const runtime = createRequestHandler(options);
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 64 * 1024 * 1024
  });

  // Fastify 默认会按 content-type 解析 body；onRequest 里 hijack 后不会进入解析阶段。
  app.removeAllContentTypeParsers?.();

  const handleRaw = (request, reply) => {
    if (!reply.raw.headersSent && !reply.raw.writableEnded) {
      try {
        reply.hijack();
      } catch {
        // already hijacked / response started
      }
    }
    runtime.handler(request.raw, reply.raw);
  };

  app.addHook('onRequest', async (request, reply) => {
    handleRaw(request, reply);
  });
  // 通配路由只为让 Fastify 接受所有路径；实际响应在 onRequest 已接管。
  app.all('/', (request, reply) => handleRaw(request, reply));
  app.all('/*', (request, reply) => handleRaw(request, reply));

  const wrapper = {
    adapter: 'fastify',
    app,
    server: app.server,
    queue: runtime.queue,
    sessions: runtime.sessions,
    serviceInfo: runtime.serviceInfo,
    getUpstreamHealth: runtime.getUpstreamHealth,
    async listen(port, host) {
      await app.listen({ port, host });
      return app.server.address();
    },
    async close() {
      try {
        await app.close();
      } catch {
        // ignore
      }
    },
    async closeGracefully(options = {}) {
      try {
        await app.close();
      } catch {
        // ignore
      }
      await runtime.close?.(options);
    },
    address() {
      return app.server.address();
    }
  };
  return wrapper;
}

export default { createFastifyServer };
