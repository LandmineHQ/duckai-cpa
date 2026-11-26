import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  GitCompare,
  Loader2,
  Radar,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPost, ApiError } from '@/app/lib/api';
import { formatDateTime, formatNumber } from '@/app/lib/format';
import type { ReconDiffResponse, ReconStatusResponse } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ENDPOINT_MARKERS: Array<{ key: keyof NonNullable<ReconStatusResponse['markers']>; label: string; path: string }> = [
  { key: 'chatEndpoint', label: '对话端点', path: '/duckchat/v1/chat' },
  { key: 'statusEndpoint', label: '挑战/状态', path: '/duckchat/v1/status' },
  { key: 'capabilitiesEndpoint', label: '能力开关', path: '/duckchat/v1/capabilities' },
  { key: 'summarizeEndpoint', label: '原生摘要', path: '/duckchat/v1/summarize' },
  { key: 'authTokenEndpoint', label: '订阅 Token', path: '/duckchat/v1/auth/token' }
];

const PROTOCOL_MARKERS: Array<{ key: keyof NonNullable<ReconStatusResponse['markers']>; label: string }> = [
  { key: 'vqdChallengeHeader', label: 'x-vqd-hash-1' },
  { key: 'feVersionHeader', label: 'x-fe-version' },
  { key: 'feSignalsHeader', label: 'x-fe-signals' },
  { key: 'continuationHeader', label: 'x-duckai-continuation' },
  { key: 'consentPurposesHeader', label: 'x-duckai-consent-purposes' },
  { key: 'durableStream', label: 'durableStream' },
  { key: 'generatedImagePart', label: 'generated-image 回放' },
  { key: 'generateImageTool', label: 'GenerateImage' },
  { key: 'webSearchTool', label: 'WebSearch' },
  { key: 'readDocumentTool', label: 'ReadDocument' },
  { key: 'locationPromptTool', label: 'LocationPrompt' }
];

function shortHash(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 14)}…` : value;
}

function MarkerChip({ label, ok }: { label: string; ok?: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-2.5 py-1.5 text-xs">
      <span className="truncate font-mono text-[11.5px]">{label}</span>
      {ok === true ? (
        <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
          <CheckCircle2 className="h-3 w-3" />
          已识别
        </Badge>
      ) : (
        <Badge variant="muted" className="gap-1 px-1.5 py-0 text-[10px]">
          <XCircle className="h-3 w-3" />
          未发现
        </Badge>
      )}
    </div>
  );
}

export function ReconPage() {
  const [status, setStatus] = useState<ReconStatusResponse | null>(null);
  const [diff, setDiff] = useState<ReconDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [diffing, setDiffing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<ReconStatusResponse>('/recon/status');
      setStatus(res);
      setError(null);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载 Recon 状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handlePull = async () => {
    setPulling(true);
    try {
      const res = await apiPost<ReconStatusResponse>('/recon/pull', {});
      setStatus(res);
      setDiff(null);
      setError(null);
      toast.success(`基线快照已更新（${res.assetCount} 个代码资源）`);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '拉取基线失败');
    } finally {
      setPulling(false);
    }
  };

  const handleDiff = async () => {
    setDiffing(true);
    try {
      const res = await apiPost<ReconDiffResponse>('/recon/diff', {});
      setDiff(res);
      setError(null);
      if (!res.baselineExists) toast.info('当前暂无基线，请先点击「拉取基线」');
      else if (res.same) toast.success('线上脚本与本地基线一致');
      else toast.warning('检测到 duck.ai 前端存在更新或契约漂移');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '对比线上变更失败');
    } finally {
      setDiffing(false);
    }
  };

  const activeMarkers = diff?.currentMarkers || status?.markers || null;
  const unknownModels = activeMarkers?.unknownModels ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="前端 Recon 监控"
        description="追踪 duck.ai 入口 HTML 归一化哈希、JS Bundle 契约标记与新模型目录漂移"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void loadStatus()} /> : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b border-border/70 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Radar className="h-4 w-4 text-primary" />
              duck.ai 基线快照
            </CardTitle>
            <CardDescription className="mt-1">
              自动忽略动态 nonce 噪声与图片/字体静态媒体，仅校验入口 HTML 与 JS/CSS 协议契约层
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void loadStatus()} disabled={loading || pulling || diffing}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新状态
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handleDiff()} disabled={pulling || diffing}>
              {diffing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
              对比线上变更
            </Button>
            <Button size="sm" onClick={() => void handlePull()} disabled={pulling || diffing}>
              {pulling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              拉取基线
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {loading && !status ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
            </div>
          ) : !status?.baselineExists ? (
            <EmptyState
              icon={Radar}
              title="尚未建立本地基线"
              description="点击右上角「拉取基线」抓取当前 duck.ai 入口 HTML 与 JS Bundle 指纹（会走系统已配置的代理），或先点击「对比线上变更」即时探测。"
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground">基线版本</div>
                <div className="mt-1 truncate font-mono text-xs font-medium" title={status.version || undefined}>
                  {status.targets?.versionTag || status.version || '未知'}
                </div>
                <div className="mt-1 text-[10.5px] text-muted-foreground">
                  SHA: <span className="font-mono">{shortHash(status.targets?.versionSha)}</span>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground">归一化 HTML 哈希</div>
                <div className="mt-1 truncate font-mono text-xs font-medium" title={status.targets?.htmlSha256 || undefined}>
                  {shortHash(status.targets?.htmlSha256)}
                </div>
                <div className="mt-1 text-[10.5px] text-muted-foreground">
                  状态码 {status.targets?.status ?? 200}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground">代码资产数</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(status.assetCount)}</div>
                <div className="text-[10.5px] text-muted-foreground tabular-nums">
                  {Math.max(1, Math.round((status.totalBytes || 0) / 1024))} KB（已过滤媒体）
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground">最近抓取时间</div>
                <div className="mt-1 text-xs font-medium">{status.capturedAt ? formatDateTime(status.capturedAt) : '—'}</div>
                <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">{status.entryUrl}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {unknownModels.length > 0 ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold">检测到线上 Bundle 出现本地静态表尚未收录的模型 ID：</div>
            <div className="flex flex-wrap gap-1.5">
              {unknownModels.map((id) => (
                <Badge key={id} variant="warning" className="font-mono text-[11px]">{id}</Badge>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {activeMarkers ? (
        <Card>
          <CardHeader className="border-b border-border/70">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-primary" />
              协议契约与模型扫描标记
            </CardTitle>
            <CardDescription>
              本地静态目录共 {activeMarkers.catalogCount ?? '—'} 个模型 · 线上包内识别到 {activeMarkers.detectedModels?.length ?? 0} 个模型 ID
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground">核心上游端点</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ENDPOINT_MARKERS.map((m) => (
                  <MarkerChip key={m.key} label={m.path} ok={Boolean(activeMarkers[m.key])} />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground">请求头 / 能力与回放契约</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {PROTOCOL_MARKERS.map((m) => (
                  <MarkerChip key={m.key} label={m.label} ok={Boolean(activeMarkers[m.key])} />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {diff ? (
        <Card>
          <CardHeader className="border-b border-border/70">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                线上 Diff 报告
              </CardTitle>
              <Badge variant={diff.same ? 'success' : 'warning'}>
                {diff.same ? '完全一致' : '存在变更'}
              </Badge>
            </div>
            <CardDescription>{diff.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {diff.markerChanges.length > 0 ? (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-muted-foreground">契约标记变化（{diff.markerChanges.length}）</div>
                <div className="space-y-1">
                  {diff.markerChanges.map((item) => (
                    <div key={item.key} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs">
                      <span className="font-mono font-medium">{item.key}</span>
                      <span className="text-muted-foreground">:</span>
                      <Badge variant="muted" className="font-mono text-[10px]">{String(item.before ?? 'null')}</Badge>
                      <span>→</span>
                      <Badge variant="warning" className="font-mono text-[10px]">{String(item.after ?? 'null')}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {diff.changed.length > 0 || diff.added.length > 0 || diff.removed.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">类型</TableHead>
                    <TableHead>资产 URL</TableHead>
                    <TableHead>变更前 SHA256</TableHead>
                    <TableHead>当前 SHA256</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diff.changed.map((a) => (
                    <TableRow key={`chg-${a.url}`}>
                      <TableCell><Badge variant="warning" className="text-[10px]">变动</Badge></TableCell>
                      <TableCell className="max-w-md truncate font-mono text-xs" title={a.url}>{a.url}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{shortHash(a.previous?.sha256)}</TableCell>
                      <TableCell className="font-mono text-xs">{shortHash(a.sha256)}</TableCell>
                    </TableRow>
                  ))}
                  {diff.added.map((a) => (
                    <TableRow key={`add-${a.url}`}>
                      <TableCell><Badge variant="success" className="text-[10px]">新增</Badge></TableCell>
                      <TableCell className="max-w-md truncate font-mono text-xs" title={a.url}>{a.url}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">—</TableCell>
                      <TableCell className="font-mono text-xs">{shortHash(a.sha256)}</TableCell>
                    </TableRow>
                  ))}
                  {diff.removed.map((a) => (
                    <TableRow key={`rem-${a.url}`}>
                      <TableCell><Badge variant="destructive" className="text-[10px]">移除</Badge></TableCell>
                      <TableCell className="max-w-md truncate font-mono text-xs" title={a.url}>{a.url}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{shortHash(a.sha256)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">—</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : diff.same ? (
              <p className="text-xs text-muted-foreground">所有监测脚本与端点标记均未发现变动。</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
