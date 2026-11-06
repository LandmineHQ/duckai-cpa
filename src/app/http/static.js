/** Static file serving + SPA fallback (Phase 1 split; traversal/SPA behavior unchanged). */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
});

export function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function resolveStaticPath(baseDir, relativePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\0')) return null;
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return null;
  const segments = normalized.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..' || segment === '.' || /^[a-zA-Z]:$/.test(segment))) {
    return null;
  }
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, ...segments);
  if (resolved !== baseResolved && !resolved.startsWith(`${baseResolved}${path.sep}`)) return null;
  return resolved;
}

export async function serveStaticFile(ctx, filePath, { cacheControl = 'no-cache' } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch {
    return false;
  }
  const headers = {
    'Content-Type': mimeFor(filePath),
    'Content-Length': data.length,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  };
  ctx.res.writeHead(200, headers);
  ctx.sent = true;
  if (ctx.method === 'HEAD') ctx.res.end();
  else ctx.res.end(data);
  return true;
}

export async function serveAdminIndex(ctx, { webDir, serviceName }) {
  const indexFile = path.join(webDir, 'index.html');
  if (await serveStaticFile(ctx, indexFile, { cacheControl: 'no-cache' })) return;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${serviceName} · admin</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;line-height:1.6">
  <h1>管理后台尚未构建</h1>
  <p>未找到 <code>web/index.html</code>（Vite 构建产物；<code>npm run build:web</code> 生成到 <code>web/</code>）。</p>
  <p>管理 API 仍然可用：<code>GET /admin/api/overview?token=&lt;adminToken&gt;</code>。</p>
</body></html>`;
  ctx.text(404, html, 'text/html; charset=utf-8');
}

export default { MIME_TYPES, mimeFor, resolveStaticPath, serveStaticFile, serveAdminIndex };
