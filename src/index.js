#!/usr/bin/env node
/**
 * duckai-cpa v2 process entry point.
 *
 * Boot order: config (v1→v2 migration + first-run config file + admin token) →
 * store (keys/logs/stats migration) → **default API key creation** → DuckClient →
 * upstream queue → HTTP server → banner.
 *
 * DuckClient initialization failure does not abort startup: the service starts in
 * "degraded" mode so the admin UI / config / healthz stay usable.
 */

import { DuckClient, DuckError } from './duck/index.js';
import { DUCK_MODELS } from './duck/models.js';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createLogger } from './logger.js';
import { createUpstreamQueue } from './upstream/queue.js';
import { createServer, getPackageMeta } from './http/server.js';

const logger = createLogger({ level: 'info' });

/** Placeholder DuckClient used when the real one cannot be initialized. */
function createUnavailableDuck(initError) {
  const unavailable = () => {
    throw new DuckError('Duck.ai upstream client is not available (initialization failed)', {
      status: 502,
      type: 'upstream_unavailable',
      retriable: true,
      cause: initError
    });
  };
  return {
    async init() {},
    getModelCatalog() {
      return DUCK_MODELS.map((model) => ({ ...model }));
    },
    async chat() {
      unavailable();
    },
    async imageGeneration() {
      unavailable();
    },
    async health() {
      return {
        ok: false,
        upstreamStatus: null,
        challengeOk: false,
        version: null,
        rateLimited: false,
        error: 'DuckClient initialization failed'
      };
    }
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main() {
  const { config, paths, firstRun, generatedAdminToken, migrated, migrationNotes } = await loadConfig({ logger });
  logger.setLevel(config.logging.level);

  if (firstRun) {
    logger.info(`首次启动：已从 config/config.example.json 生成运行时配置 ${paths.configPath}`);
  }
  if (migrated) {
    logger.info('已将旧配置迁移到 v2', { notes: migrationNotes });
  }

  const store = createStore({
    dataDir: paths.dataDir,
    configPath: paths.configPath,
    config,
    logger
  });
  await store.init();

  // v2: every /v1/* request requires an API key. When no keys exist (first start
  // or all revoked) create a default key, print it once and persist it.
  let defaultApiKey = null;
  if (store.listKeys().length === 0) {
    const created = store.createKey('default');
    defaultApiKey = created.key;
    if (!Array.isArray(config.auth.apiKeys)) config.auth.apiKeys = [];
    config.auth.apiKeys.push(created.key);
    await store.saveConfig(config);
    await store.flush();
  }

  // v2.3: proxy manager (duck-protocol src/duck/proxy.js) — created before identity
  // and DuckClient so every outbound request (incl. sync transport probing and
  // subscription verification) can go through the proxy. Failures degrade to
  // direct mode instead of blocking startup.
  let proxy = null;
  let proxyInitError = null;
  try {
    const proxyModule = await import('./duck/proxy.js');
    if (typeof proxyModule.createProxyManager === 'function') {
      proxy = await proxyModule.createProxyManager({ config: config.proxy, logger });
    } else if (typeof proxyModule.ProxyManager === 'function') {
      proxy = new proxyModule.ProxyManager({ config: config.proxy, logger });
      await proxy.init();
    } else {
      throw new Error('src/duck/proxy.js does not export createProxyManager/ProxyManager');
    }
  } catch (error) {
    proxyInitError = error;
    proxy = null;
    logger.warn(
      'Proxy manager 不可用：/admin/api/proxy 将返回 502 proxy_unavailable，' +
        '所有出站请求按直连处理（代理配置仍可在 config 中保存）',
      error
    );
  }

  // v2.2: identity store (duck-protocol src/duck/identity.js) — must be ready
  // before DuckClient so the first chat already uses the persisted journeyId.
  // If the duck layer is not available yet we keep running (identity endpoints 503).
  let identity = null;
  let identityInitError = null;
  try {
    const identityModule = await import('./duck/identity.js');
    const proxyFetch =
      proxy && typeof proxy.getFetch === 'function'
        ? proxy.getFetch()
        : proxy && typeof proxy.fetch === 'function'
          ? proxy.fetch.bind(proxy)
          : null;
    const identityOptions = {
      dataDir: paths.dataDir,
      // Duck identity also uses baseUrl/userAgent/timeoutMs for subscription verify.
      config: { ...config.duck, identity: config.identity },
      logger,
      ...(proxyFetch ? { sync: { fetchImpl: proxyFetch } } : {})
    };
    if (typeof identityModule.createIdentityStore === 'function') {
      identity = await identityModule.createIdentityStore(identityOptions);
    } else if (typeof identityModule.IdentityStore === 'function') {
      identity = new identityModule.IdentityStore(identityOptions);
      await identity.init();
    } else {
      throw new Error('src/duck/identity.js does not export createIdentityStore/IdentityStore');
    }
    if (identity && typeof identity.setProxyManager === 'function' && proxy) {
      identity.setProxyManager(proxy);
    }
  } catch (error) {
    identityInitError = error;
    identity = null;
    logger.warn(
      'Identity store 不可用：身份/Sync/订阅 Admin API 将返回 503 identity_unavailable；' +
        '上游将退化为进程内随机身份（duck.ai 可能重复识别为新访客）',
      error
    );
  }

  // v2.4: identity pool (duck-protocol src/duck/identity-pool.js). Created after
  // the proxy so per-identity runtimes share it. Failure degrades to the single
  // v2.15: first-class subscriptions (one subscription can back many identities/devices).
  let subscriptions = null;
  try {
    const subscriptionsModule = await import('./admin/subscriptions.js');
    subscriptions = await subscriptionsModule.createSubscriptionStore({
      dataDir: paths.dataDir,
      logger,
      userAgent: config.duck?.userAgent,
      // v2.27：自动续期要访问 duck.ai，必须走同一代理
      fetchImpl: proxy ? (url, init) => proxy.fetch(url, init) : undefined
    });
    logger.info('订阅存储就绪（data/subscriptions.json）');
  } catch (error) {
    subscriptions = null;
    logger.warn('订阅存储不可用：/admin/api/subscriptions 将返回 503', error);
  }

  // global DuckClient (pool endpoints 503 identity_pool_unavailable).
  let identities = null;
  let identityPoolError = null;
  if (config.pool.enabled) {
    try {
      const poolModule = await import('./duck/identity-pool.js');
      const poolConfig = {
        ...config,
        // duck-protocol uses `idleTimeoutMs`; our public config key is runtimeIdleMs.
        pool: { ...config.pool, idleTimeoutMs: config.pool.runtimeIdleMs }
      };
      if (typeof poolModule.createIdentityPool === 'function') {
        identities = await poolModule.createIdentityPool({
          dataDir: paths.dataDir,
          config: poolConfig,
          logger,
          ...(proxy ? { proxyManager: proxy } : {}),
          ...(subscriptions ? { subscriptionStore: subscriptions } : {})
        });
      } else if (typeof poolModule.IdentityPool === 'function') {
        identities = new poolModule.IdentityPool({
          dataDir: paths.dataDir,
          config: poolConfig,
          logger,
          ...(proxy ? { proxyManager: proxy } : {})
        });
        await identities.init();
      } else {
        throw new Error('src/duck/identity-pool.js does not export createIdentityPool/IdentityPool');
      }
    } catch (error) {
      identityPoolError = error;
      identities = null;
      logger.warn(
        'Identity pool 不可用：/admin/api/identities 将返回 503 identity_pool_unavailable，/v1 回落到全局单身份',
        error
      );
    }
  }

  let syncDevices = null;
  let pairingStore = null;

  // v2.11: persistent compaction summaries for /v1 X-Session-Id.
  let chatSummaries = null;
  try {
    const summaryModule = await import('./admin/chat-summaries.js');
    chatSummaries = await summaryModule.createChatSummaryStore({ dataDir: paths.dataDir, logger }).init();
  } catch (error) {
    chatSummaries = null;
    logger.warn('chat summary store 不可用：/v1 X-Session-Id 压缩摘要不会持久化', error);
  }

  // v2.5: pairing host service (docs/PAIRING-IMPL.md). The PairingHost itself is
  // created lazily on POST /admin/api/sync/pairing; the service/store are created
  // at startup so the official recovery code is available to the account hook.
  let pairing = null;
  let pairingInitError = null;
  try {
    const [pairingModule, pairingAdmin] = await Promise.all([
      import('./duck/pairing.js'),
      import('./admin/pairing.js')
    ]);
    if (typeof pairingModule.createPairingHost !== 'function') {
      throw new Error('src/duck/pairing.js does not export createPairingHost');
    }
    pairingStore = await pairingAdmin.createPairingStore({ dataDir: paths.dataDir, logger });
    pairing = pairingAdmin.createPairingService({
      createPairingHost: pairingModule.createPairingHost,
      pairingStore,
      proxyManager: proxy,
      logger,
      config,
      options: {
        // v2.16: "syncOnly" never persists the recovery code (memory only).
        getSyncMode: async () => {
          try {
            const syncState = await identity.getSync();
            return syncState?.mode === 'syncOnly' ? 'syncOnly' : 'backup';
          } catch {
            return 'backup';
          }
        },
        // joiner completed → official code persisted by PairingService → auto register
        // this device on DuckDuckGo Sync (failures only warn, pairing stays completed).
        onCompleted: () => {
          setTimeout(() => {
            if (!syncDevices) return;
            void syncDevices.autoRegister().catch((error) => {
              logger.warn('sync 设备自动注册失败（不影响配对）', { error: error.message });
            });
          }, 0);
        }
      }
    });
  } catch (error) {
    pairingInitError = error;
    pairing = null;
    logger.warn('Pairing host 不可用：/admin/api/sync/pairing 将返回 503 pairing_unavailable', error);
  }

  // v2.8: server device registration service (lazy sync-client; endpoints 503 until ready).
  try {
    const syncDevicesModule = await import('./admin/sync-devices.js');
    syncDevices = syncDevicesModule.createSyncDeviceService({
      identity,
      pairingStore,
      proxyManager: proxy,
      logger,
      config,
      store,
      identities
    });
    if (identity && syncDevices) {
      const name = await syncDevices.ensureDeviceName().catch(() => null);
      if (name) logger.info(`设备名称: ${name}（config.identity.deviceName 可自定义）`);
    }
  } catch (error) {
    syncDevices = null;
    logger.warn('sync 设备注册服务不可用：/admin/api/sync/register-device 将返回 503', error);
  }

  let duck;
  let duckInitError = null;
  try {
    duck = new DuckClient({
      ...config.duck,
      // v2.2 identity: store injection + durableStream switch.
      identityStore: identity || undefined,
      identity: config.identity,
      durableStream: config.identity.durableStream,
      // v2.3 proxy: all upstream fetch calls go through the proxy manager.
      ...(proxy ? { proxyManager: proxy } : {}),
      logger
    });
    await duck.init();
    logger.info('DuckClient initialized', {
      baseUrl: config.duck.baseUrl,
      defaultModel: config.duck.defaultModel,
      identityInjected: Boolean(identity),
      proxyInjected: Boolean(proxy)
    });
  } catch (error) {
    duckInitError = error;
    logger.error(
      'DuckClient 初始化失败：服务将以降级模式启动（/v1 对话与图片接口会返回上游错误，管理后台与配置可正常使用）',
      error
    );
    duck = createUnavailableDuck(error);
  }

  // v2.31：会话历史（SQLite，只读展示）
  let historyStore = null;
  try {
    const historyModule = await import('./history.js');
    historyStore = await historyModule.createHistoryStore({ dataDir: paths.dataDir, config, logger });
    logger.info('会话历史就绪（data/duckai.db: history）');
  } catch (error) {
    historyStore = null;
    logger.warn('会话历史不可用：/admin/api/history 将返回 503', { error: error.message });
  }

  const queue = createUpstreamQueue({ config, logger });
  const server = createServer({
    config,
    store,
    duck,
    logger,
    webDir: paths.webDir,
    queue,
    identity,
    proxy,
    identities,
    history: historyStore,
    pairing,
    syncDevices,
    chatSummaries,
    subscriptions
  });
  let address;
  try {
    address = await listen(server, config.server.host, config.server.port);
  } catch (error) {
    logger.error(`无法监听 ${config.server.host}:${config.server.port}`, error);
    process.exitCode = 1;
    return;
  }

  const port = address && typeof address === 'object' ? address.port : config.server.port;
  const host = config.server.host;
  const meta = getPackageMeta();
  const baseUrl = `http://${host}:${port}`;

  logger.info(`${meta.name || 'duckai-cpa'} v${meta.version || '0.1.0'}（v2.5）已启动`);
  // v2.27：订阅 access token 自动续期（每 5 分钟检查一次，到期前 30 分钟内刷新）
  let subscriptionRefreshTimer = null;
  if (subscriptions) {
    const sweep = async () => {
      if (typeof subscriptions.listNeedingRefresh !== 'function') return;
      try {
        const pending = await subscriptions.listNeedingRefresh(30 * 60 * 1000);
        for (const item of pending) {
          try {
            const result = await subscriptions.refreshAccessToken(item.id, { force: false });
            if (result.refreshed && result.raw && identities?.syncSubscriptionToken) {
              await identities.syncSubscriptionToken(item.id, result.raw);
            }
            logger.info('[subscriptions] 自动续期成功', {
              id: item.id,
              tier: result.subscription?.tier,
              expiresAt: result.subscription?.expiresAt,
              rotated: result.rotatedRefreshToken === true
            });
          } catch (error) {
            logger.warn('[subscriptions] 自动续期失败', { id: item.id, error: error.message });
          }
        }
      } catch (error) {
        logger.warn('[subscriptions] 自动续期巡检失败', { error: error.message });
      }
    };
    void sweep();
    subscriptionRefreshTimer = setInterval(sweep, 5 * 60 * 1000);
    subscriptionRefreshTimer.unref?.();
    const active = await subscriptions.listNeedingRefresh(30 * 60 * 1000).catch(() => []);
    logger.info(`订阅自动续期：每 5 分钟巡检（当前待续期 ${active.length} 个）`);
  }

  // v2.30：会话→身份绑定是缓存（默认 7 天未使用即失效），定期清理过期绑定
  let historySweepTimer = null;
  if (historyStore && typeof historyStore.prune === 'function') {
    historySweepTimer = setInterval(() => {
      try {
        historyStore.prune();
      } catch (error) {
        logger.warn('[history] prune failed', { error: error.message });
      }
    }, 30 * 60 * 1000);
    historySweepTimer.unref?.();
  }
  let bindingSweepTimer = null;
  if (identities && typeof identities.pruneBindings === 'function') {
    const sweepBindings = () => {
      try {
        // v2.32：顺带清理已到期的额度冷却
        if (typeof identities.pruneCooldowns === 'function') identities.pruneCooldowns();
        const removed = identities.pruneBindings();
        if (removed > 0) logger.info('[duck:pool] 已清理过期会话绑定', { removed });
      } catch (error) {
        logger.warn('[duck:pool] 清理会话绑定失败', { error: error.message });
      }
    };
    sweepBindings();
    bindingSweepTimer = setInterval(sweepBindings, 10 * 60 * 1000);
    bindingSweepTimer.unref?.();
  }

  logger.info(`OpenAI 兼容 base URL（所有请求需 Bearer API Key）: ${baseUrl}/v1`);
  logger.info(`管理后台: ${baseUrl}/admin/`);
  logger.info(`健康检查: ${baseUrl}/healthz`);
  logger.info(
    `上游队列: rps=${config.upstream.rps} maxConcurrent=${config.upstream.maxConcurrent} ` +
      `queueLimit=${config.upstream.queueLimit} queueTimeoutMs=${config.upstream.queueTimeoutMs}`
  );
  logger.info(
    `付费模型: ${config.duck.allowPaidModels ? '允许（allowPaidModels=true）' : '禁用（allowPaidModels=false）'}`
  );
  logger.info(
    `身份: durableStream=${config.identity.durableStream.enabled ? 'enabled' : 'disabled'}` +
      ` sync=${config.identity.sync.enabled ? 'enabled' : 'disabled'}`
  );
  if (proxy) {
    try {
      const summary = (await Promise.resolve(proxy.getSummary?.())) || proxy.getRedacted?.() || {};
      const status = summary.status && typeof summary.status === 'object' ? summary.status : summary;
      const mode = typeof status.mode === 'string' ? status.mode : config.proxy.type;
      logger.info(
        `代理: ${summary.enabled === true ? 'enabled' : 'disabled'} mode=${mode}` +
          `${summary.enabled === true ? ` ${config.proxy.host}:${config.proxy.port}` : ''}` +
          `${config.proxy.password ? ' (auth=yes)' : ''}` +
          `${status.lastTestOk === true ? ` lastTest=ok/${status.lastTestLatencyMs ?? '?'}ms` : ''}`
      );
    } catch (error) {
      logger.warn('proxy manager 已加载但状态读取失败', { error: error.message });
    }
  } else if (proxyInitError) {
    logger.warn('v2.3 代理功能不可用（/admin/api/proxy 将返回 502 proxy_unavailable，出站按直连处理）');
  }
  if (identities) {
    try {
      const summary = identities.getSummary?.() || {};
      logger.info(
        `身份池: total=${summary.total ?? 0} enabled=${summary.enabled ?? 0}` +
          ` subscribed=${summary.subscribed ?? 0} activeId=${summary.activeId ?? '-'}` +
          ` bindings=${summary.bindingCount ?? 0}/${summary.maxIdentities ?? config.pool.maxIdentities}` +
          ` strategy=${config.pool.strategy}`
      );
    } catch (error) {
      logger.warn('identity pool 已加载但摘要读取失败', { error: error.message });
    }
  } else if (identityPoolError) {
    logger.warn('v2.4 身份池不可用（/admin/api/identities 将返回 503 identity_pool_unavailable）');
  }
  if (identity) {
    try {
      const red = identity.getRedacted() || {};
      const durable = red.durableStream && typeof red.durableStream === 'object' ? red.durableStream : {};
      const journey = typeof red.journeyId === 'string' ? red.journeyId : '';
      const fingerprint = typeof durable.fingerprint === 'string' ? durable.fingerprint : '';
      const tier = red.auth && typeof red.auth.tier === 'string' ? red.auth.tier : 'free';
      logger.info(
        `身份指纹: journeyId=${journey.slice(0, 8)}… fingerprint=${fingerprint.slice(0, 12)}… tier=${tier}` +
          ` deviceId=${String(red.deviceId || '').slice(0, 8)}…（不打印私钥/token）`
      );
    } catch (error) {
      logger.warn('identity store 已加载但 getRedacted 失败', { error: error.message });
    }
  } else if (identityInitError) {
    logger.warn('v2.2 身份功能不可用（/admin/api/identity|sync|subscription 将返回 503 identity_unavailable）');
  }
  logger.info(`数据目录: ${paths.dataDir}`);
  logger.info(`运行时配置: ${paths.configPath}`);

  const envToken = Boolean(process.env.DUCKAI_CPA_ADMIN_TOKEN);
  if (envToken) {
    logger.info('adminToken：使用 DUCKAI_CPA_ADMIN_TOKEN 环境变量（不打印明文）');
  } else if (generatedAdminToken) {
    logger.info(`adminToken（已写入 ${paths.configPath}，仅本次打印）: ${generatedAdminToken}`);
    logger.info(`管理后台快捷登录: ${baseUrl}/admin/?token=${generatedAdminToken}`);
  } else {
    logger.info(`adminToken：已存在于 ${paths.configPath}（不打印明文；可用 DUCKAI_CPA_ADMIN_TOKEN 覆盖）`);
  }

  if (defaultApiKey) {
    logger.info(`已自动创建默认 API Key（label=default，仅本次打印）: ${defaultApiKey}`);
    logger.info(`示例: curl ${baseUrl}/v1/models -H "Authorization: Bearer ${defaultApiKey}"`);
  } else {
    logger.info(`API Key：已存在 ${store.listKeys().length} 个（完整 key 仅在创建时显示，可到管理后台查看预览/新建）`);
  }

  if (duckInitError) {
    logger.warn('当前为降级模式：请检查 duck-protocol 的 DuckClient 实现或网络后重启');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (subscriptionRefreshTimer) {
      clearInterval(subscriptionRefreshTimer);
      subscriptionRefreshTimer = null;
    }
    if (bindingSweepTimer) {
      clearInterval(bindingSweepTimer);
      bindingSweepTimer = null;
    }
    if (historySweepTimer) {
      clearInterval(historySweepTimer);
      historySweepTimer = null;
    }
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在优雅关闭…`);
    try {
      await server.closeGracefully({ timeoutMs: 5000 });
      try {
        await proxy?.close?.();
      } catch {
        // proxy shutdown is best-effort
      }
      try {
        await identities?.close?.();
      } catch {
        // identity pool shutdown is best-effort
      }
      try {
        await pairing?.close?.();
      } catch {
        // pairing host shutdown is best-effort
      }
      try {
        await syncDevices?.close?.();
      } catch {
        // sync device service shutdown is best-effort
      }
      logger.info('关闭完成');
      process.exit(0);
    } catch (error) {
      logger.error('关闭过程中出错', error);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Never let a stray async error take down the gateway.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', reason instanceof Error ? reason : { reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', error);
  });
}

main().catch((error) => {
  logger.error('启动失败', error);
  process.exitCode = 1;
});
