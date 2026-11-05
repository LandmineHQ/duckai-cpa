/** v2 管理 API 与页面共用的数据类型（契约：docs/ADMIN_API_V2.md）。 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface QueueStatus {
  waiting: number;
  inFlight: number;
  rps: number;
  maxConcurrent: number;
  limit: number;
  avgWaitMs: number;
  lastStartAt?: number | null;
}

export interface UpstreamHealth {
  ok: boolean;
  version?: string | null;
  challengeOk: boolean;
  latencyMs?: number;
  upstreamStatus?: string | null;
  rateLimited?: boolean;
  queue?: QueueStatus;
  error?: string;
  initDone?: boolean;
}

export interface ServiceInfo {
  name: string;
  version: string;
  uptimeSec: number;
}

export interface UpstreamStats {
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
  totalPromptChars?: number;
  byModel?: Record<string, number>;
  byEndpoint?: Record<string, number>;
  rateLimitCount?: number;
  lastErrorAt?: number | null;
}

export interface AdminStats {
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
  byEndpoint?: Record<string, number>;
  lastErrorAt?: number | null;
}

export interface Stats {
  upstream: UpstreamStats;
  admin: AdminStats;
  /** v1 遗留扁平字段（后端可能短时间保留），前台不主动使用。 */
  requests?: number;
  errors?: number;
  avgLatencyMs?: number | null;
}

export interface ModelInfo {
  id: string;
  owned_by?: string;
  created_by?: string;
  display_name?: string;
  name?: string;
  paid: boolean;
  tier?: string | null;
  available: boolean;
  requires_subscription?: boolean;
  reasoning: boolean;
  supported_reasoning_efforts?: string[];
  reasoningEfforts?: string[];
  tools?: string[];
  default?: boolean;
  /** v2.11：上下文能力（字符）。真实后端 capabilities 为对象（含 webSearch/imageGeneration/reasoningEfforts/tier/context...）。 */
  contextWindowChars?: number | null;
  maxInputChars?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: string[] | Record<string, unknown>;
  /** v2.12：是否支持自动上下文压缩（gpt-6-luna 为 false）。 */
  compactionSupported?: boolean | null;
  /** 约多少轮对话后自动触发压缩。 */
  activationTargetPairCount?: number | null;
  inputCharLimit?: number | null;
}

export interface UpstreamLogItem {
  /** v2.24：该请求的 token 估算。 */
  tokens?: { prompt: number; completion: number; total: number; estimated?: boolean };
  id?: string;
  ts: number;
  source?: string;
  endpoint: string;
  model?: string | null;
  status: number;
  latencyMs: number;
  queueWaitMs?: number;
  stream?: boolean;
  error?: string | null;
  rateLimited?: boolean;
  /** v2.48：客户端工具协议注入信息（仅 upstream 日志）。 */
  clientTools?: string[] | null;
  protocolInjected?: boolean;
  upstreamMessageCount?: number | null;
  conversationChain?: string | null;
}

export interface AdminLogItem {
  id?: string;
  ts: number;
  endpoint: string;
  method?: string;
  status: number;
  latencyMs: number;
  error?: string | null;
}

export interface Overview {
  service: ServiceInfo;
  upstream: UpstreamHealth;
  stats: Stats;
  models: ModelInfo[];
  /** v2.24：token 消耗总览（分模型 / 分身份×模型）。 */
  tokens?: UsageResponse | null;
  /** v2.24：日志保留策略。 */
  logRetention?: LogRetentionInfo | null;
  recentUpstream?: UpstreamLogItem[];
  recentAdmin?: AdminLogItem[];
  /** v1 遗留字段。 */
  recent?: UpstreamLogItem[];
}

export interface LogsResponse<T> {
  kind: string;
  total: number;
  items: T[];
}

export interface KeyItem {
  id: string;
  label: string;
  keyPreview: string;
  createdAt: number;
  lastUsedAt?: number | null;
  requestCount: number;
}

export interface CreatedKey {
  id: string;
  label: string;
  key: string;
  createdAt: number;
}

export interface UpstreamConfig {
  rps?: number;
  maxConcurrent?: number;
  queueLimit?: number;
  queueTimeoutMs?: number;
}

export interface DuckConfig {
  defaultModel?: string;
  timeoutMs?: number;
  allowPaidModels?: boolean;
  baseUrl?: string;
  userAgent?: string;
  challenge?: Record<string, unknown>;
  humanize?: Record<string, unknown>;
}

export interface PromptsConfig {
  defaultSystemPrompt?: string;
  mode?: 'inline' | 'system';
  defaults?: Record<string, string>;
}

export interface LoggingConfig {
  level?: string;
  maxEntries?: number;
}

export interface ToolsConfig {
  webSearch?: boolean;
  imageGeneration?: boolean;
}

export interface Config {
  server?: { host?: string; port?: number; cors?: boolean };
  auth?: { apiKeys?: string[]; adminToken?: string };
  upstream?: UpstreamConfig;
  duck?: DuckConfig;
  prompts?: PromptsConfig;
  logging?: LoggingConfig;
  models?: { aliases?: Record<string, string> };
  tools?: ToolsConfig;
}

export interface ConfigResponse {
  config: Config;
}

export interface UpdateConfigResponse {
  ok: boolean;
  config: Config;
  restartRequired?: boolean;
  restartPaths?: string[];
  ignored?: string[];
}

export interface SearchSource {
  title?: string;
  url: string;
  snippet?: string;
}

export interface ImageAttachment {
  b64: string;
  format?: string;
  width?: number;
  height?: number;
  model?: string;
}

export interface ToolCallInfo {
  name: string;
  callId?: string | null;
  args?: string;
  result?: string;
}

export interface FileAttachment {
  filename: string;
  mimeType: string;
  pages?: number;
  bytes?: number;
  textChars?: number;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** v2.49：PDF/文件附件元数据（会话历史只存元数据，不存 base64）。 */
  files?: FileAttachment[];
  reasoning?: string;
  /** v2.37：工具调用（位置 / 生图 / 联网），连接测试与会话历史共用 */
  toolCalls?: ToolCallInfo[];
  /** 上游只返回加密推理摘要（匿名档无明文）时为 true。 */
  reasoningEncrypted?: boolean;
  sources?: SearchSource[];
  images?: ImageAttachment[];
  model?: string;
  ts: number;
  latencyMs?: number;
  queueWaitMs?: number;
  finishReason?: string | null;
  error?: string | null;
  /** 这条 assistant 消息是「重新生成」产生时，记录被替换的消息 id。 */
  retriedFrom?: string;
}

export interface SessionSummaryInfo {
  text?: string | null;
  summary?: string | null;
  coveredPairCount?: number | null;
  coveredMessageCount?: number | null;
  coveredCount?: number | null;
  targetPairCount?: number | null;
  updatedAt?: number | null;
  createdAt?: number | null;
  model?: string | null;
  auto?: boolean;
  /** v2.12：压缩节省的字符数。 */
  savedChars?: number | null;
  savedCharacters?: number | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  reasoningEffort: string;
  webSearch: boolean;
  imageGeneration: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** v2.4：会话绑定的身份（服务端 hash 路由后固定）。 */
  identityId?: string | null;
  identityLabel?: string | null;
  /** v2.33：会话标识（X-Session-Id / 连接测试会话 id） */
  sessionKey?: string | null;
  /** v2.33：网关请求 id（X-Request-Id），用于区分是否真的重复调用 */
  requestId?: string | null;
  /** v2.11：会话压缩摘要。 */
  summary?: SessionSummaryInfo | null;
}

export interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
  /** v2.11：详情里同时返回摘要区。 */
  summary?: SessionSummaryInfo | null;
}

export interface SessionsResponse {
  items: SessionSummary[];
}

export interface TestStreamEvent {
  type: string;
  text?: string;
  reasoning?: string;
  results?: SearchSource[];
  b64?: string;
  format?: string;
  width?: number;
  height?: number;
  message?: SessionMessage | string;
  latencyMs?: number;
  queueWaitMs?: number;
  sessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  /** 重新生成时，session 事件带 retryOf（被替换的 assistant 消息 id）。 */
  retryOf?: string;
  code?: string;
  status?: number;
  error?: string;
  /** v2.11：done 事件携带自动压缩信息。 */
  compacted?: boolean;
  summary?: SessionSummaryInfo | null;
  coveredPairCount?: number | null;
  coveredMessageCount?: number | null;
}

export interface CompactSessionResponse {
  ok?: boolean;
  session?: SessionSummary;
  summary?: SessionSummaryInfo | null;
  compacted?: boolean;
  coveredPairCount?: number | null;
  coveredMessageCount?: number | null;
  message?: string | null;
}

export interface HealthResponse {
  ok: boolean;
  service?: string;
  version?: string;
  uptimeSec?: number;
  upstream: UpstreamHealth;
}

/* ------------------------------------------------------------------ */
/* v2.2 身份 / Sync & Backup / 订阅                                     */
/* ------------------------------------------------------------------ */

export interface Entitlement {
  product: string;
  name: string;
  expiresAt?: number | null;
}

export interface IdentitySummary {
  journeyId: string;
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  createdAt: number;
  rotatedAt: number;
  stable: boolean;
  source: 'file' | 'generated' | string;
}

export interface IdentityDurableStream {
  fingerprint: string;
  publicKeyJwk: Record<string, unknown> | null;
  hasPrivateKey: boolean;
  version: string;
  /** 是否向上游发送 durableStream（匿名档默认 false，需上游允许）。 */
  enabled?: boolean;
  configured?: boolean;
  /** 上游拒绝 durableStream 后自动降级。 */
  degraded?: boolean;
  rejectedCount?: number;
  note?: string;
}

export interface IdentityAuthInfo {
  authenticated: boolean;
  email: string | null;
  tier: string;
  entitlements: Entitlement[];
  expiresAt: number | null;
  activatedAt: number | null;
  verified?: boolean;
  verifyError?: string | null;
}

export interface IdentitySyncSummary {
  enabled: boolean;
  deviceCount: number;
  lastSyncAt: number | null;
  hasPairingCode: boolean;
  hasRecoveryCode: boolean;
}

/** GET /admin/api/identity 的响应（扁平结构）。 */
export interface IdentityState {
  identity: IdentitySummary;
  durableStream: IdentityDurableStream;
  auth: IdentityAuthInfo;
  sync: IdentitySyncSummary;
  file: { path: string; bytes: number; updatedAt: number };
}

export interface SyncDeviceItem {
  id: string;
  name: string;
  type?: string;
  thisDevice?: boolean;
}

export interface PairingCodeInfo {
  code: string;
  url: string;
  channelId?: string;
  publicKey?: string;
  createdAt?: number;
  expiresAt?: number | null;
}

export interface SyncServerInfo {
  registered?: boolean;
  deviceName?: string | null;
  userId?: string | null;
}

export interface SyncState {
  enabled: boolean;
  /** v2.16：backup（Sync & Backup）| syncOnly（仅同步，恢复码不落盘）。 */
  mode?: 'backup' | 'syncOnly' | string;
  deviceId: string;
  deviceName: string;
  deviceCount: number;
  devices: SyncDeviceItem[];
  lastSyncAt: number | null;
  transport: 'available' | 'blocked' | string;
  transportReason?: string;
  pairingCode: PairingCodeInfo | null;
  recoveryCode: { present: boolean; preview?: string } | null;
  /** v2.8：DuckDuckGo Sync 服务端设备注册状态。 */
  server?: SyncServerInfo | null;
}

export interface SyncResponse {
  sync: SyncState;
}

export interface SyncEnableResponse {
  ok: boolean;
  sync: SyncState;
  /** 仅在启用时返回一次的完整恢复码。 */
  recoveryCode?: string | { code?: string; recoveryCode?: string } | null;
}

export interface PairingCodeResponse {
  code: string;
  url: string;
  channelId?: string;
  expiresAt?: number | null;
}

/* ------------------------------------------------------------------ */
/* v2.5 扫码配对（PairingHost）与官方恢复码                              */
/* ------------------------------------------------------------------ */

export interface SyncPairingMessage {
  dir?: string | null;
  type?: string | null;
  at?: number | null;
  seq?: number;
  httpStatus?: number;
}

export interface SyncPairingSession {
  channelId?: string | null;
  pairingCode?: string | null;
  code?: string | null;
  url?: string | null;
  qrUrl?: string | null;
  publicKeyBase64Url?: string | null;
  createdAt?: number | null;
  startedAt?: number | null;
  expiresAt?: number | null;
  /** waiting | hello | exchange | completed | failed | timeout | idle */
  state?: string;
  endReason?: string | null;
  peerChannelId?: string | null;
  /** 对端设备名/类型（如 Android 手机 / ddg）。 */
  peerName?: string | null;
  peerKind?: string | null;
  completedAs?: string | null;
  lastSeq?: number;
  messages?: SyncPairingMessage[];
  syncBase?: string | null;
  error?: string | null;
  /** 后端是否已配置官方恢复码（POST 返回）。 */
  accountAvailable?: boolean;
  expiresInMs?: number | null;
  /** 网关当前所在账号（从已保存恢复码解析）。 */
  currentAccountUserId?: string | null;
  /** 配对中收到的「手机账号」——尚未采用，用户可显式切换。 */
  pendingAccount?: { userId?: string | null; peerName?: string | null; receivedAt?: number | null } | null;
  accountConflict?: boolean;
  /** v2.15：配对成功后两端已在同一账号（不再显示冲突）。 */
  accountMerged?: boolean;
  recoveryUserId?: string | null;
  recoveryCodeReceived?: boolean;
  substate?: string | null;
}

export interface SyncPairingResponse {
  ok?: boolean;
  pairing?: SyncPairingSession | null;
  /** POST 时后端同时把 start() 字段平铺在顶层。 */
  url?: string | null;
  qrUrl?: string | null;
  pairingCode?: string | null;
  channelId?: string | null;
  expiresAt?: number | null;
  state?: string | null;
  accountAvailable?: boolean;
  error?: string | null;
}

export interface OfficialRecoveryCodeInfo {
  configured: boolean;
  hasCode?: boolean;
  updatedAt?: number | null;
  preview?: string | null;
  length?: number;
  /** v2.11：完整官方恢复码（等同账号密钥，前端直接展示/下载）。 */
  code?: string | null;
}

export interface OfficialRecoveryCodeResponse {
  ok?: boolean;
  officialRecoveryCode: OfficialRecoveryCodeInfo;
}

/* ------------------------------------------------------------------ */
/* v2.8 设备名 / DuckDuckGo 服务端设备列表 / 轮换结果                    */
/* ------------------------------------------------------------------ */

export interface ServerDevice {
  id: string;
  name?: string | null;
  type?: string | null;
  credential_id?: string | null;
  credentialId?: string | null;
  jwt_iat?: number | null;
  jwtIat?: number | null;
  thisDevice?: boolean;
  local?: boolean;
  current?: boolean;
  /** v2.15：网关自身（默认身份）注册的主设备。 */
  primary?: boolean;
  matchedIdentityId?: string | null;
}

export interface ServerDevicesResponse {
  devices?: ServerDevice[];
  items?: ServerDevice[];
  total?: number;
  currentDeviceId?: string | null;
  primaryDeviceId?: string | null;
  server?: SyncServerInfo | null;
}

export interface RegisterDeviceResponse {
  ok?: boolean;
  device?: ServerDevice | null;
  devices?: ServerDevice[];
  server?: SyncServerInfo | null;
  message?: string | null;
}

export interface DeviceSlotsResponse {
  identityIds?: string[];
  slots?: Array<string | { identityId?: string; id?: string }>;
  saved?: boolean;
  savedAt?: number | null;
  updatedAt?: number | null;
  /** v2.10：身份已删除/禁用的设备槽（失效设备）。 */
  orphans?: Array<string | { identityId?: string; id?: string; deviceName?: string }>;
  orphansCount?: number;
}

export interface DeviceSlotsSaveResponse {
  ok?: boolean;
  identityIds?: string[];
  slots?: Array<string | { identityId?: string; id?: string }>;
  savedAt?: number | null;
}

export interface IdentityRotateResponse {
  ok?: boolean;
  identityLost?: boolean;
  note?: string | null;
  rotatedAt?: number | null;
}

export interface RecoveryCodeResponse {
  recoveryCode?: string | { code?: string; recoveryCode?: string } | null;
}

export interface SubscriptionInfo {
  authenticated: boolean;
  email: string | null;
  tier: string;
  entitlements: Entitlement[];
  expiresAt: number | null;
  activatedAt: number | null;
  verified: boolean;
  /** verified 的校验范围：reachability 表示「token 本地解析通过 + 上游可达」，不代表 Duck.ai 确认有效。 */
  verifyScope?: string;
  verifyNote?: string | null;
  verifyError?: string;
  allowPaidModels: boolean;
  expired?: boolean;
}

export interface SubscriptionResponse {
  subscription: SubscriptionInfo;
}

/* ------------------------------------------------------------------ */
/* v2.3 出站代理                                                        */
/* ------------------------------------------------------------------ */

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyStatus {
  active: boolean;
  mode: string;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestLatencyMs: number | null;
  lastTestStatus: number | null;
  exitIp: string | null;
  lastError: string | null;
  updatedAt: number | null;
}

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType | string;
  host: string;
  port: number;
  hasAuth?: boolean;
  username: string;
  noProxy: string[];
  testUrl: string;
  ipCheckUrl: string;
  status: ProxyStatus;
}

export interface ProxyResponse {
  proxy: ProxyConfig;
}

export interface ProxyUpdatePayload {
  enabled?: boolean;
  type?: string;
  host?: string;
  port?: number;
  username?: string;
  /** 省略表示不修改已保存密码；空字符串表示清除。 */
  password?: string;
  noProxy?: string[];
  testUrl?: string;
  ipCheckUrl?: string;
}

export interface ProxyUpdateResponse {
  ok: boolean;
  proxy: ProxyConfig;
  applied?: boolean;
}

export interface ProxyTestResult {
  ok: boolean;
  mode: string;
  target?: string;
  status: number | null;
  latencyMs: number | null;
  exitIp?: string | null;
  ipError?: string | null;
  testedAt?: number;
  error?: string | null;
  code?: string | null;
}

/* ------------------------------------------------------------------ */
/* v2.4 身份池 / 会话绑定 / 路由                                        */
/* ------------------------------------------------------------------ */

export interface IdentityQueueInfo {
  waiting: number;
  inFlight: number;
  rps: number;
}

export interface IdentityPoolItem {
  id: string;
  label: string;
  /** v2.9：设备名称（默认身份 DuckAI@main，其它 DuckCPA@<4hex>）。 */
  deviceName?: string | null;
  enabled: boolean;
  subscribed: boolean;
  source: string;
  createdAt: number;
  journeyId: string;
  deviceId: string;
  fingerprint: string;
  durableStreamEnabled?: boolean;
  syncEnabled?: boolean;
  authTier?: string;
  authenticated?: boolean;
  /** v2.15：绑定的订阅实体（一个订阅可绑定多个身份）。 */
  subscriptionId?: string | null;
  subscriptionLabel?: string | null;
  subscriptionTier?: string | null;
  subscriptionExpiresAt?: string | null;
  /** v2.32：额度冷却（临时禁用；到期自动恢复） */
  cooling?: boolean;
  cooldownUntil?: number | null;
  cooldownReason?: string | null;
  cooldownScope?: string | null;
  sessions: number;
  requests: number;
  lastUsedAt: number | null;
  queue: IdentityQueueInfo;
  active?: boolean;
}

export interface IdentityPoolMeta {
  total: number;
  enabled: number;
  subscribed: number;
  activeId: string;
  salt?: string | null;
  bindingCount: number;
  maxIdentities: number;
}

export interface IdentitiesResponse {
  pool: IdentityPoolMeta;
  items: IdentityPoolItem[];
}

export interface IdentityBindingItem {
  sessionKey: string;
  identityId: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface BindingsResponse {
  items: IdentityBindingItem[];
  total: number;
}

export interface RoutingIdentityRow {
  id: string;
  label?: string;
  waiting: number;
  inFlight: number;
  requests: number;
}

export interface RoutingInfo {
  strategy: string;
  saltPresent: boolean;
  perIdentity: RoutingIdentityRow[];
  totals?: { waiting?: number; inFlight?: number; requests?: number };
}

export interface IdentityDetailResponse {
  identity: IdentityPoolItem & {
    sync?: Record<string, unknown>;
    auth?: Record<string, unknown>;
  };
}

/* ------------------------------------------------------------------ */
/* v2.15 subscriptions                                                 */
/* ------------------------------------------------------------------ */

export interface SubscriptionIdentityRef {
  id: string;
  label?: string | null;
  deviceName?: string | null;
}

export interface Subscription {
  id: string;
  label: string;
  email?: string | null;
  tier?: string | null;
  paid?: boolean;
  entitlements?: unknown[];
  expiresAt?: string | null;
  expired?: boolean;
  verified?: boolean;
  verifyError?: string | null;
  maskedToken?: string | null;
  tokenHashPrefix?: string | null;
  source?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  lastVerifiedAt?: number | null;
  bindingCount?: number;
  boundIdentities?: SubscriptionIdentityRef[];
  /** v2.27：自动续期（保存了 refresh token） */
  autoRefresh?: boolean;
  refreshTokenUpdatedAt?: number | null;
  refreshedAt?: number | null;
  refreshError?: string | null;
  refreshCount?: number;
}

export interface SubscriptionsResponse {
  items?: Subscription[];
  total?: number;
}

/* ------------------------------------------------------------------ */
/* v2.21 模型配置（/admin/api/models/config）                           */
/* ------------------------------------------------------------------ */

export interface ModelConfigDefaults {
  context_window_chars: number;
  max_input_chars: number;
  input_char_limit: number;
  max_output_tokens: number;
  max_output_tokens_estimated?: boolean;
}

export interface ModelConfigOverride {
  context_window_chars?: number;
  max_input_chars?: number;
  max_output_tokens?: number;
  session_limit_behavior?: 'summarize_and_continue' | 'new_chat';
}

export interface ModelToolState {
  name: string;
  supported: boolean;
  enabled: boolean;
}

export interface ModelConfigItem {
  id: string;
  name: string;
  tier: string | null;
  paid: boolean;
  compaction_supported: boolean;
  /** v2.29：该模型可接受的推理等级（none/minimal/low/medium/high） */
  reasoning_efforts?: string[];
  reasoning_efforts_supported?: boolean;
  session_limit_behavior: 'summarize_and_continue' | 'new_chat';
  tools?: ModelToolState[];
  tools_supported?: string[];
  tools_enabled?: string[];
  defaults: ModelConfigDefaults;
  override: ModelConfigOverride | null;
  effective: {
    context_window_chars: number;
    max_input_chars: number;
    max_input_tokens: number;
    max_output_tokens: number;
    max_output_tokens_estimated?: boolean;
    session_limit_behavior: 'summarize_and_continue' | 'new_chat';
  };
}

export interface ModelConfigResponse {
  object: string;
  items: ModelConfigItem[];
  drop_unsupported_tool?: boolean;
  tool_names?: string[];
  limits: Record<string, { min: number; max: number; step?: number }>;
  defaults: {
    context_window_chars: number;
    max_input_chars: number;
    max_output_tokens: number;
    session_limit_behavior: string;
  };
}
/* ------------------------------------------------------------------ */
/* v2.24 token 消耗统计（/admin/api/usage 与 overview.tokens）            */
/* ------------------------------------------------------------------ */

export interface UsageBucket {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UsageModelEntry extends UsageBucket {
  model: string;
}

export interface UsageIdentityEntry extends UsageBucket {
  identityId: string;
  identityLabel: string | null;
  byModel: UsageModelEntry[];
}

export interface UsageResponse {
  total: UsageBucket;
  byModel: UsageModelEntry[];
  byIdentity: UsageIdentityEntry[];
  filter: { model: string | null; identityId: string | null };
  estimated: boolean;
  estimation: string;
  updatedAt: number | null;
}

export interface LogRetentionInfo {
  maxEntries: number;
  maxAgeDays: number;
  upstreamCount: number;
  adminCount: number;
}

/* ------------------------------------------------------------------ */
/* v2.48 会话历史「提示词注入」与「查看上游请求」调试视图                   */
/* ------------------------------------------------------------------ */

/** 客户端工具协议注入快照（`GET /admin/api/history/:id` 的 `item.injection`）。 */
export interface HistoryInjection {
  injected: boolean;
  clientTools: string[];
  /** 实际注入到第一条 user 消息的协议文本（完整）。 */
  protocolText: string;
  /** 实际发给上游的第一条 user 内容（含协议文本，完整）。 */
  firstUserContent: string;
  upstreamMessageCount: number | null;
  /** prefix-reuse / rebuild / stateless / new 等链路标记。 */
  chain: string | null;
  at: number;
}

/** `GET /admin/api/history/:id/upstream` 的响应（图片 base64 已脱敏）。 */
export interface HistoryUpstreamResponse {
  ok: boolean;
  sessionKey: string | null;
  source: 'conversation_state' | 'response' | null;
  updatedAt: number | null;
  messageCount: number;
  injection: HistoryInjection | null;
  messages: unknown[];
}
