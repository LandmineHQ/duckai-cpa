# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# DuckAI CPA — 生产镜像（Node.js 服务 + 预构建管理控制台）
#
#   # 1) 先在本机构建管理控制台（镜像内不装前端工具链，不跑构建）
#   npm install && npm run build:web        # 产物输出到 web/
#   # 2) 再构建/运行镜像
#   docker build -t duckai-cpa .
#   docker run -d --name duckai-cpa -p 8787:8787 \
#     -e DUCKAI_CPA_ADMIN_TOKEN=replace-with-a-strong-token \
#     -v "$PWD/data:/app/data" duckai-cpa
#
# 运行时依赖（package.json → dependencies，均为纯 JS，无需编译工具）：
#   - jsdom   执行 duck.ai 的 x-vqd-hash-1 挑战脚本
#   - undici  代理出站（ProxyAgent / 自定义 dispatcher）
#   - socks   SOCKS4/SOCKS5 代理连接器
#   - qrcode 属于 devDependencies，只在构建前端时打补丁进 web/，镜像内不需要
# 因此 alpine 镜像不需要 python3/make/g++；镜像内也不安装 vite/react 等前端依赖。
#
# 管理后台产物：web/（index.html + assets/*）必须由 `npm run build:web` 预先生成，
# 镜像只负责原样复制并由 /admin 静态托管。
# ---------------------------------------------------------------------------

# ---------- 依赖层：并行安装生产依赖，便于缓存 ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
# 用 lockfile 精确安装，锁定 jsdom/undici/socks 及其传递依赖；devDependencies 不进入镜像
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 运行层 ----------
FROM node:24-alpine

ARG APP_VERSION=""
ENV DUCKAI_CPA_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="duckai-cpa" \
      org.opencontainers.image.description="Duck.ai -> OpenAI-compatible gateway with admin dashboard" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="MIT"

# 容器内必须监听 0.0.0.0，端口映射才能生效
ENV NODE_ENV=production \
    DUCKAI_CPA_HOST=0.0.0.0 \
    DUCKAI_CPA_PORT=8787 \
    DUCKAI_CPA_DATA_DIR=/app/data

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY config ./config
COPY src ./src
COPY web ./web

# 运行数据目录：属主 node，保证非 root 用户可写（bind mount 时需宿主机可写）
RUN mkdir -p /app/data && chown -R node:node /app

# 非 root 运行
USER node

EXPOSE 8787

# 健康检查：上游异常时 /healthz 仍返回 200（body 里 upstream.ok=false），
# 这里只检查网关进程本身是否可响应。duck.ai 不可达时启动会重试挑战/预热，
# 因此给 60s 宽限期，避免刚启动就被标记 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const p=process.env.DUCKAI_CPA_PORT||'8787';fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
