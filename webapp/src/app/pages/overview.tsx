import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Clock3,
  Gauge,
  Layers,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  Wifi,
  WifiOff
} from 'lucide-react';
import { useOverview } from '@/app/lib/overview-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  errorRate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatQueueWait,
  formatRelative,
  formatUptime,
  topEntries
} from '@/app/lib/format';
import type { AdminLogItem, ModelInfo, UpstreamLogItem } from '@/app/lib/types';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { StatTile } from '@/app/components/stat-tile';
import { MiniBarList } from '@/app/components/mini-bar-list';
import { EmptyState } from '@/app/components/empty-state';
import { ModelCapabilityBadges, ModelCompactionBadge, ModelContextLine, ModelTierBadge, isModelLocked } from '@/app/components/model-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function StatusBadge({ status }: { status: number }) {
  const variant =
    status >= 500 ? 'destructive' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {status}
    </Badge>
  );
}

function UpstreamTable({ items }: { items: UpstreamLogItem[] }) {
  if (items.length === 0) {
    return <EmptyState icon={Server} title="暂无上游请求" description="调用 /v1/* 或连接测试后，这里会出现记录。" />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>来源</TableHead>
          <TableHead>端点</TableHead>
          <TableHead>模型</TableHead>
          <TableHead className="text-right">状态</TableHead>
          <TableHead className="text-right">耗时</TableHead>
          <TableHead className="text-right">排队</TableHead>
          <TableHead>模式</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item, index) => (
          <TableRow key={item.id ?? `${item.ts}-${index}`} className={item.status >= 400 ? 'bg-destructive/5' : undefined}>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(item.ts)}</TableCell>
            <TableCell>
              <Badge variant={item.source === 'admin-test' ? 'info' : 'outline'} className="text-[10px]">
                {item.source ?? 'v1'}
              </Badge>
            </TableCell>
            <TableCell className="max-w-[220px] truncate font-mono text-xs" title={item.endpoint}>
              {item.endpoint}
            </TableCell>
            <TableCell className="max-w-[160px] truncate font-mono text-xs">{item.model ?? '—'}</TableCell>
            <TableCell className="text-right">
              <StatusBadge status={item.status} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{formatDuration(item.latencyMs)}</TableCell>
            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
              {formatQueueWait(item.queueWaitMs)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{item.stream ? '流式' : '普通'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AdminTable({ items }: { items: AdminLogItem[] }) {
  if (items.length === 0) {
    return <EmptyState icon={ShieldCheck} title="暂无后台 API 请求" description="管理后台自身的请求会记录在这里（与上游日志分开）。" />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>方法</TableHead>
          <TableHead>端点</TableHead>
          <TableHead className="text-right">状态</TableHead>
          <TableHead className="text-right">耗时</TableHead>
          <TableHead>错误</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item, index) => (
          <TableRow key={item.id ?? `${item.ts}-${index}`} className={item.status >= 400 ? 'bg-destructive/5' : undefined}>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(item.ts)}</TableCell>
            <TableCell className="font-mono text-xs">{item.method ?? '—'}</TableCell>
            <TableCell className="max-w-[280px] truncate font-mono text-xs" title={item.endpoint}>
              {item.endpoint}
            </TableCell>
            <TableCell className="text-right">
              <StatusBadge status={item.status} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{formatDuration(item.latencyMs)}</TableCell>
            <TableCell className="max-w-[220px] truncate text-xs text-destructive" title={item.error ?? ''}>
              {item.error ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ModelTile({ model, allowPaidModels }: { model: ModelInfo; allowPaidModels: boolean }) {
  const locked = isModelLocked(model, allowPaidModels);
  const displayName = model.display_name || model.name || model.id;
  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        locked ? 'border-dashed bg-muted/40' : 'bg-card hover:border-primary/30'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('truncate text-sm font-medium', locked && 'text-muted-foreground')}>{displayName}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={model.id}>
            {model.id}
          </div>
        </div>
        <ModelTierBadge model={model} allowPaidModels={allowPaidModels} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {model.owned_by ? (
          <Badge variant="outline" className="font-normal text-[10px]">
            {model.owned_by}
          </Badge>
        ) : null}
        {model.default ? (
          <Badge variant="default" className="text-[10px]">
            默认
          </Badge>
        ) : null}
      </div>
      <div className="mt-2">
        <ModelCapabilityBadges model={model} />
      </div>
      <div className="mt-1.5">
        <ModelContextLine model={model} />
      </div>
      <div className="mt-1.5">
        <ModelCompactionBadge model={model} />
      </div>
    </div>
  );
}

export function OverviewPage() {
  // v2.24：token 消耗总览的模型筛选（空 = 全部模型）
  const [tokenModel, setTokenModel] = useState<string>('all');
  const { data, loading, error, lastUpdatedAt, refresh, refreshIntervalMs, setRefreshIntervalMs } = useOverview();
  // v2.34：自动刷新控制条展开状态
  const [refreshOpen, setRefreshOpen] = useState(false);

  const stats = data?.stats;
  const upstreamStats = stats?.upstream ?? {
    requests: stats?.requests ?? 0,
    errors: stats?.errors ?? 0,
    avgLatencyMs: stats?.avgLatencyMs ?? null,
    byModel: {},
    byEndpoint: {},
    rateLimitCount: 0,
    lastErrorAt: null
  };
  const adminStats = stats?.admin ?? { requests: 0, errors: 0, avgLatencyMs: null, byEndpoint: {}, lastErrorAt: null };
  const models = data?.models ?? [];
  const recentUpstream = data?.recentUpstream ?? data?.recent ?? [];
  const recentAdmin = data?.recentAdmin ?? [];
  const upstream = data?.upstream;
  const queue = upstream?.queue;
  const tokenData = data?.tokens ?? null;
  const tokenModelOptions = tokenData?.byModel ?? [];
  const filteredTokenModels =
    tokenModel === 'all'
      ? tokenModelOptions
      : tokenModelOptions.filter((item) => item.model === tokenModel);
  const filteredTokenTotal =
    tokenModel === 'all'
      ? tokenData?.total ?? null
      : filteredTokenModels[0] ?? null;
  const filteredIdentities = (tokenData?.byIdentity ?? []).filter(
    (identity) => tokenModel === 'all' || identity.byModel.some((entry) => entry.model === tokenModel)
  );
  const allowPaidModels = models.some((model) => model.paid && model.available);
  const freeCount = models.filter((model) => !model.paid).length;
  const paidCount = models.filter((model) => model.paid).length;

  const upstreamBadge = upstream?.rateLimited
    ? { variant: 'warning' as const, text: '上游限流' }
    : upstream?.ok
      ? { variant: 'success' as const, text: '正常' }
      : upstream?.challengeOk
        ? { variant: 'warning' as const, text: '部分可用' }
        : { variant: 'destructive' as const, text: '异常' };

  return (
    <div>
      <PageHeader title="概览" description="上游健康、RPS 队列、请求统计与模型目录" />

      {/* v2.34：第一行是「自动刷新」控制条：默认折叠显示当前间隔，可展开调整/手动刷新 */}
      <div className="mb-4 rounded-xl border bg-card px-3 py-2" data-testid="overview-refresh-bar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setRefreshOpen((open) => !open)}
            data-testid="overview-refresh-toggle"
            aria-expanded={refreshOpen}
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', refreshOpen ? 'rotate-180' : '')} />
            <span>
              自动刷新：{refreshIntervalMs ? `每 ${Math.round(refreshIntervalMs / 1000)} 秒` : '已关闭'}
            </span>
            <span className="hidden text-muted-foreground/70 sm:inline">
              · {lastUpdatedAt ? `更新于 ${formatDateTime(lastUpdatedAt)}` : '尚未加载'}
            </span>
          </button>
          <div className="flex items-center gap-2">
            {refreshOpen ? (
              <div className="flex items-center gap-1">
                {[0, 5000, 10000, 30000, 60000].map((interval) => (
                  <Button
                    key={interval}
                    size="sm"
                    variant={refreshIntervalMs === interval ? 'default' : 'outline'}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setRefreshIntervalMs(interval)}
                    data-testid={`overview-refresh-interval-${interval}`}
                  >
                    {interval === 0 ? '关闭' : `${interval / 1000}s`}
                  </Button>
                ))}
              </div>
            ) : null}
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={refresh} data-testid="overview-refresh">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>
        {refreshOpen ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            自动刷新间隔会保存在本浏览器；页面切到后台时暂停轮询，回到前台会立即刷新一次。
          </p>
        ) : null}
      </div>

      {error ? <ErrorBanner message={error} onRetry={refresh} /> : null}

      {!data && loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : null}

      {data ? (
        <div className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">上游健康</CardTitle>
                  <Badge variant={upstreamBadge.variant}>{upstreamBadge.text}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">挑战 x-vqd-hash-1</span>
                  <span className="flex items-center gap-1 font-medium">
                    {upstream?.challengeOk ? (
                      <>
                        <Wifi className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        已就绪
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5 text-destructive" />
                        未就绪
                      </>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">上游版本</span>
                  <span className="max-w-[60%] truncate font-mono text-xs" title={upstream?.version ?? ''}>
                    {upstream?.version || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">探测延迟</span>
                  <span className="tabular-nums">{formatDuration(upstream?.latencyMs)}</span>
                </div>
                {upstream?.error ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-words">{upstream.error}</span>
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">请求队列（RPS）</CardTitle>
                  <Badge variant="outline" className="gap-1 font-normal">
                    <Gauge className="h-3 w-3" />
                    {queue?.rps ?? 1} req/s
                  </Badge>
                </div>
                <CardDescription className="text-xs">所有上游调用统一 FIFO 排队</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Activity className="h-3 w-3" />
                      执行中
                    </div>
                    <div className="mt-0.5 text-lg font-semibold tabular-nums">{queue?.inFlight ?? 0}</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock3 className="h-3 w-3" />
                      排队
                    </div>
                    <div className="mt-0.5 text-lg font-semibold tabular-nums">{queue?.waiting ?? 0}</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Layers className="h-3 w-3" />
                      并发上限 / 队列上限
                    </div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums">
                      {queue?.maxConcurrent ?? 1} / {queue?.limit ?? 50}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      平均等待
                    </div>
                    <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatDuration(queue?.avgWaitMs)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">服务</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">名称</span>
                  <span className="font-medium">{data.service?.name ?? 'duckai-cpa'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">版本</span>
                  <span className="font-mono text-xs">{data.service?.version ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">运行时长</span>
                  <span className="tabular-nums">{formatUptime(data.service?.uptimeSec)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">队列最近开始</span>
                  <span className="tabular-nums text-xs" title={queue?.lastStartAt ? formatDateTime(queue.lastStartAt) : ''}>
                    {queue?.lastStartAt ? formatRelative(queue.lastStartAt) : '—'}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="上游请求"
              value={formatNumber(upstreamStats.requests)}
              hint={`错误 ${formatNumber(upstreamStats.errors)} · 错误率 ${errorRate(upstreamStats.errors, upstreamStats.requests)}`}
              icon={Server}
              tone="primary"
            />
            <StatTile
              label="上游平均耗时"
              value={formatDuration(upstreamStats.avgLatencyMs)}
              hint={`限流 ${formatNumber(upstreamStats.rateLimitCount ?? 0)} 次`}
              icon={Timer}
            />
            <StatTile
              label="后台 API 请求"
              value={formatNumber(adminStats.requests)}
              hint={`错误 ${formatNumber(adminStats.errors)} · ${errorRate(adminStats.errors, adminStats.requests)}`}
              icon={ShieldCheck}
            />
            <StatTile
              label="最近错误"
              value={upstreamStats.lastErrorAt ? formatRelative(upstreamStats.lastErrorAt) : '无'}
              hint={upstreamStats.lastErrorAt ? formatDateTime(upstreamStats.lastErrorAt) : '运行期间未记录上游错误'}
              icon={AlertTriangle}
              tone={upstreamStats.lastErrorAt ? 'danger' : 'default'}
            />
          </div>

          <Card data-testid="token-usage-card">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-sm">Token 消耗总览</CardTitle>
                  <CardDescription className="text-xs">
                    估算值（字符数 / 4）· 按模型汇总，并可下钻到「身份 × 模型」· 累计不受清空日志影响
                  </CardDescription>
                </div>
                <Select value={tokenModel} onValueChange={setTokenModel}>
                  <SelectTrigger
                    className="h-8 w-[190px] text-xs"
                    aria-label="token 模型筛选"
                    data-testid="token-model-filter"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部模型</SelectItem>
                    {tokenModelOptions.map((item) => (
                      <SelectItem key={item.model} value={item.model}>
                        {item.model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">总 tokens</div>
                  <div className="text-lg font-semibold tabular-nums" data-testid="token-total">
                    {formatNumber(filteredTokenTotal?.total_tokens ?? 0)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    请求 {formatNumber(filteredTokenTotal?.requests ?? 0)} 次
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">输入 tokens</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatNumber(filteredTokenTotal?.prompt_tokens ?? 0)}
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">输出 tokens</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatNumber(filteredTokenTotal?.completion_tokens ?? 0)}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">按模型</div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">请求</TableHead>
                        <TableHead className="text-right">输入</TableHead>
                        <TableHead className="text-right">输出</TableHead>
                        <TableHead className="text-right">合计</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredTokenModels.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                            暂无 token 记录（发起一次 /v1/chat/completions 后出现）
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredTokenModels.map((item) => (
                          <TableRow key={item.model}>
                            <TableCell className="max-w-[180px] truncate font-mono text-xs">{item.model}</TableCell>
                            <TableCell className="text-right tabular-nums text-xs">
                              {formatNumber(item.requests)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs">
                              {formatNumber(item.prompt_tokens)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs">
                              {formatNumber(item.completion_tokens)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs font-medium">
                              {formatNumber(item.total_tokens)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    按身份（{tokenModel === 'all' ? '身份 × 模型' : `身份 · ${tokenModel}`}）
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>身份</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">合计</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredIdentities.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-xs text-muted-foreground">
                            暂无身份维度记录
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredIdentities.flatMap((identity) =>
                          identity.byModel
                            .filter((entry) => tokenModel === 'all' || entry.model === tokenModel)
                            .map((entry) => (
                              <TableRow key={`${identity.identityId}-${entry.model}`}>
                                <TableCell className="max-w-[150px] truncate text-xs">
                                  <span className="font-mono">{identity.identityId}</span>
                                  {identity.identityLabel ? (
                                    <span className="ml-1 text-muted-foreground">{identity.identityLabel}</span>
                                  ) : null}
                                </TableCell>
                                <TableCell className="max-w-[130px] truncate font-mono text-xs">
                                  {entry.model}
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-xs">
                                  {formatNumber(entry.total_tokens)}
                                </TableCell>
                              </TableRow>
                            ))
                        )
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">上游请求统计</CardTitle>
                <CardDescription className="text-xs">/v1/* 与连接测试真实打到 duck.ai 的请求</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">按端点</div>
                  <MiniBarList entries={topEntries(upstreamStats.byEndpoint, 5)} />
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">按模型</div>
                  <MiniBarList
                    entries={topEntries(upstreamStats.byModel, 5)}
                    formatKey={(key) => (key === 'unknown' || key === '' ? '—（非模型请求）' : key)}
                  />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">后台 API 统计</CardTitle>
                <CardDescription className="text-xs">管理后台自身的 /admin/api/* 请求（不含上游）</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="text-[11px] text-muted-foreground">请求数</div>
                    <div className="text-base font-semibold tabular-nums">{formatNumber(adminStats.requests)}</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="text-[11px] text-muted-foreground">错误数</div>
                    <div className="text-base font-semibold tabular-nums">{formatNumber(adminStats.errors)}</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2.5">
                    <div className="text-[11px] text-muted-foreground">平均耗时</div>
                    <div className="text-base font-semibold tabular-nums">{formatDuration(adminStats.avgLatencyMs)}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">按端点</div>
                  <MiniBarList entries={topEntries(adminStats.byEndpoint, 6)} />
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">模型目录</CardTitle>
                  <CardDescription className="text-xs">
                    共 {models.length} 个模型 · 免费 {freeCount} · 付费 {paidCount}
                    {paidCount > 0 && !allowPaidModels ? ' · 付费模型默认禁用（可在设置中开启 allowPaidModels）' : ''}
                  </CardDescription>
                </div>
                <Badge variant="outline" className="font-normal">
                  <Layers className="mr-1 h-3 w-3" />
                  {models.length}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {models.length === 0 ? (
                <EmptyState icon={Layers} title="暂无模型数据" description="确认上游挑战已就绪后刷新。" />
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {models.map((model) => (
                    <ModelTile key={model.id} model={model} allowPaidModels={allowPaidModels} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">最近日志</CardTitle>
              <CardDescription className="text-xs">上游请求与后台 API 分开记录，互不混淆</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="upstream">
                <TabsList>
                  <TabsTrigger value="upstream">上游请求</TabsTrigger>
                  <TabsTrigger value="admin">后台 API</TabsTrigger>
                </TabsList>
                <TabsContent value="upstream">
                  <UpstreamTable items={recentUpstream} />
                </TabsContent>
                <TabsContent value="admin">
                  <AdminTable items={recentAdmin} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
