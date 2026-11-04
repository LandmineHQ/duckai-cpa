import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPut, downloadFile, ApiError } from '@/app/lib/api';
import { formatDateTime, formatDuration, formatNumber, formatQueueWait } from '@/app/lib/format';
import type { AdminLogItem, LogsResponse, UpstreamLogItem } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

type LogKind = 'upstream' | 'admin';
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 20;

function StatusBadge({ status }: { status: number }) {
  const variant =
    status >= 500 ? 'destructive' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {status}
    </Badge>
  );
}

export function LogsPage() {
  const [kind, setKind] = useState<LogKind>('upstream');
  const [offset, setOffset] = useState(0);
  // v2.19: 每页数量可选 + 跳页输入
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [pageInput, setPageInput] = useState('1');
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Array<UpstreamLogItem | AdminLogItem>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  // v2.24：日志下载 + 保留策略
  const [downloading, setDownloading] = useState(false);
  const [retention, setRetention] = useState<{ maxEntries: number; maxAgeDays: number } | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<{ maxEntries: string; maxAgeDays: string }>({
    maxEntries: '',
    maxAgeDays: ''
  });
  const [savingRetention, setSavingRetention] = useState(false);

  const load = useCallback(async (nextKind: LogKind, nextOffset: number, nextPageSize: number = pageSize) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<LogsResponse<UpstreamLogItem | AdminLogItem>>(
        `/logs?kind=${nextKind}&limit=${nextPageSize}&offset=${nextOffset}`
      );
      let nextItems = Array.isArray(response?.items) ? response.items : [];
      let nextTotal = Number(response?.total) || 0;
      let effectiveOffset = nextOffset;
      if (nextItems.length === 0 && nextTotal > 0 && nextOffset > 0) {
        const retry = await apiGet<LogsResponse<UpstreamLogItem | AdminLogItem>>(
          `/logs?kind=${nextKind}&limit=${nextPageSize}&offset=0`
        );
        nextItems = Array.isArray(retry?.items) ? retry.items : [];
        nextTotal = Number(retry?.total) || nextTotal;
        effectiveOffset = 0;
      }
      setItems(nextItems);
      setTotal(nextTotal);
      setOffset(effectiveOffset);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(kind, offset, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, offset, pageSize]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(totalPages, Math.floor(offset / pageSize) + 1);
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const gotoPage = (raw: string) => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return;
    const page = Math.min(totalPages, Math.max(1, value));
    setOffset((page - 1) * pageSize);
  };

  const changePageSize = (next: number) => {
    const firstRow = offset + 1;
    setPageSize(next);
    setOffset(Math.max(0, Math.floor((firstRow - 1) / next) * next));
  };

  const switchKind = (next: LogKind) => {
    if (next === kind) return;
    setKind(next);
    setOffset(0);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await apiDelete<{ ok: boolean }>(`/logs?kind=${kind}`);
      toast.success(kind === 'upstream' ? '上游日志已清空' : '后台 API 日志已清空');
      setClearOpen(false);
      setOffset(0);
      await load(kind, 0, pageSize);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '清空日志失败');
    } finally {
      setClearing(false);
    }
  };

  const loadRetention = useCallback(async () => {
    try {
      const data = await apiGet<{ maxEntries: number; maxAgeDays: number }>('/logs/retention');
      setRetention({ maxEntries: data.maxEntries, maxAgeDays: data.maxAgeDays });
      setRetentionDraft({ maxEntries: String(data.maxEntries), maxAgeDays: String(data.maxAgeDays) });
    } catch (err) {
      if ((err as ApiError)?.handled) return;
    }
  }, []);

  useEffect(() => {
    void loadRetention();
  }, [loadRetention]);

  const download = async (target: LogKind, format: 'jsonl' | 'csv' | 'json') => {
    setDownloading(true);
    try {
      const name = await downloadFile(
        `/logs/download?kind=${target}&format=${format}`,
        `duckai-cpa-${target}-logs.${format}`
      );
      toast.success(`已下载 ${target === 'upstream' ? '上游' : '面板'}日志：${name}`);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '下载日志失败');
    } finally {
      setDownloading(false);
    }
  };

  const saveRetention = async () => {
    const maxEntries = Number(retentionDraft.maxEntries);
    const maxAgeDays = Number(retentionDraft.maxAgeDays);
    if (!Number.isFinite(maxEntries) || maxEntries < 10 || maxEntries > 20000) {
      toast.error('最大条数需在 10–20000 之间');
      return;
    }
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 365) {
      toast.error('最大保留天数需在 0–365 之间（0 = 不按时间淘汰）');
      return;
    }
    setSavingRetention(true);
    try {
      const result = await apiPut<{ maxEntries: number; maxAgeDays: number; pruned: number }>('/logs/retention', {
        maxEntries,
        maxAgeDays
      });
      setRetention({ maxEntries: result.maxEntries, maxAgeDays: result.maxAgeDays });
      setRetentionDraft({ maxEntries: String(result.maxEntries), maxAgeDays: String(result.maxAgeDays) });
      toast.success(`已保存日志保留策略${result.pruned > 0 ? `（清理 ${result.pruned} 条）` : ''}`);
      setOffset(0);
      await load(kind, 0, pageSize);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '保存保留策略失败');
    } finally {
      setSavingRetention(false);
    }
  };

  const upstreamItems = items as UpstreamLogItem[];
  const adminItems = items as AdminLogItem[];

  return (
    <div>
      <PageHeader title="日志" description="上游请求与后台 API 日志分开存储、分别清空" />

      {error ? <ErrorBanner message={error} onRetry={() => void load(kind, offset)} /> : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">请求日志</CardTitle>
              <CardDescription className="text-xs">
                共 {formatNumber(total)} 条 · 每页 {pageSize} 条
                {kind === 'upstream' ? ' · 含 queueWaitMs 排队等待时间' : ' · 仅管理后台自身请求'}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={downloading} data-testid="logs-download">
                    <Download className={`h-3.5 w-3.5 ${downloading ? 'animate-pulse' : ''}`} />
                    下载日志
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuLabel>上游请求日志</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => void download('upstream', 'jsonl')}>JSONL（推荐）</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void download('upstream', 'csv')}>CSV（含 token 列）</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void download('upstream', 'json')}>JSON</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>面板 API 日志</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => void download('admin', 'jsonl')}>JSONL</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void download('admin', 'csv')}>CSV</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void download('admin', 'json')}>JSON</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setClearOpen(true)}
                data-testid="logs-clear"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空{kind === 'upstream' ? '上游' : '后台'}日志
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(kind, offset)}
                disabled={loading}
                data-testid="logs-refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
              <Tabs value={kind} onValueChange={(value) => switchKind(value as LogKind)}>
                <TabsList>
                  <TabsTrigger value="upstream">上游请求</TabsTrigger>
                  <TabsTrigger value="admin">后台 API</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && items.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-9 rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={kind === 'upstream' ? '暂无上游请求日志' : '暂无后台 API 日志'}
              description={
                kind === 'upstream'
                  ? '调用 /v1/* 或在「连接测试」发送消息后，这里会出现记录。'
                  : '管理后台自身的接口调用会记录在这里，与上游日志互不混淆。'
              }
            />
          ) : kind === 'upstream' ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>端点</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>会话 / 身份</TableHead>
                  <TableHead className="text-right">状态</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead className="text-right">排队</TableHead>
                  <TableHead>模式</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreamItems.map((item, index) => (
                  <TableRow key={item.id ?? `${item.ts}-${index}`} className={item.status >= 400 || item.error ? 'bg-destructive/5' : undefined}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(item.ts)}</TableCell>
                    <TableCell>
                      <Badge variant={item.source === 'admin-test' ? 'info' : 'outline'} className="text-[10px]">
                        {item.source ?? 'v1'}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs" title={item.endpoint}>
                      {item.endpoint}
                    </TableCell>
                    <TableCell className="max-w-[150px] truncate font-mono text-xs">{item.model ?? '—'}</TableCell>
                    <TableCell data-testid={`log-session-${item.id ?? index}`}>
                      <div className="flex max-w-[240px] flex-col gap-0.5">
                        <span
                          className="truncate font-mono text-[10px] text-muted-foreground"
                          title={item.sessionKey || undefined}
                        >
                          {item.sessionKey || '—'}
                        </span>
                        <span
                          className="truncate text-[11px]"
                          title={item.identityId || undefined}
                        >
                          {item.identityLabel || item.identityId || '—'}
                        </span>
                        {item.requestId ? (
                          <span className="truncate font-mono text-[9px] text-muted-foreground/60" title={`requestId: ${item.requestId}`}>
                            {String(item.requestId).slice(0, 8)}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatDuration(item.latencyMs)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {formatQueueWait(item.queueWaitMs)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.stream ? '流式' : '普通'}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-destructive" title={item.error ?? ''}>
                      {item.error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
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
                {adminItems.map((item, index) => (
                  <TableRow key={item.id ?? `${item.ts}-${index}`} className={item.status >= 400 || item.error ? 'bg-destructive/5' : undefined}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(item.ts)}</TableCell>
                    <TableCell className="font-mono text-xs">{item.method ?? '—'}</TableCell>
                    <TableCell className="max-w-[320px] truncate font-mono text-xs" title={item.endpoint}>
                      {item.endpoint}
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatDuration(item.latencyMs)}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-destructive" title={item.error ?? ''}>
                      {item.error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="logs-pagination">
            <p className="text-xs text-muted-foreground">
              第 <span data-testid="logs-page-current">{currentPage}</span> / {totalPages} 页 · 共{' '}
              {formatNumber(total)} 条 · 每页 {pageSize} 条
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">每页</span>
                <Select value={String(pageSize)} onValueChange={(value) => changePageSize(Number(value))}>
                  <SelectTrigger className="h-7 w-[72px] text-xs" aria-label="每页数量">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">跳至</span>
                <Input
                  data-testid="logs-page-input"
                  className="h-7 w-14 text-xs"
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') gotoPage(pageInput);
                  }}
                  aria-label="跳转页码"
                />
                <span className="text-xs text-muted-foreground">页</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="logs-page-goto"
                  disabled={loading}
                  onClick={() => gotoPage(pageInput)}
                >
                  跳转
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={offset <= 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={offset + items.length >= total || loading}
                  onClick={() => setOffset(offset + pageSize)}
                >
                  下一页
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4 border-destructive/40" data-testid="logs-danger">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-destructive">危险 / 高级操作</CardTitle>
          <CardDescription className="text-xs">
            日志保留策略：超出条数或超过保留时间的日志会被自动淘汰（保存后立即清理一次）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="log-max-entries">
                最大存储条数（每类）
              </label>
              <Input
                id="log-max-entries"
                className="h-8 w-32 text-xs"
                inputMode="numeric"
                value={retentionDraft.maxEntries}
                onChange={(event) =>
                  setRetentionDraft((previous) => ({
                    ...previous,
                    maxEntries: event.target.value.replace(/[^0-9]/g, '')
                  }))
                }
                data-testid="log-max-entries"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="log-max-age-days">
                最大保留天数（0 = 不限）
              </label>
              <Input
                id="log-max-age-days"
                className="h-8 w-32 text-xs"
                inputMode="numeric"
                value={retentionDraft.maxAgeDays}
                onChange={(event) =>
                  setRetentionDraft((previous) => ({
                    ...previous,
                    maxAgeDays: event.target.value.replace(/[^0-9]/g, '')
                  }))
                }
                data-testid="log-max-age-days"
              />
            </div>
            <Button
              size="sm"
              onClick={() => void saveRetention()}
              disabled={savingRetention}
              data-testid="log-retention-save"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${savingRetention ? 'animate-spin' : ''}`} />
              {savingRetention ? '保存中…' : '保存并清理'}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {retention
                ? `当前：${formatNumber(retention.maxEntries)} 条 / ${retention.maxAgeDays} 天`
                : '加载中…'}
            </p>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            提示：日志文件为 <code className="rounded bg-muted px-1">data/logs.json</code>，条数上限与时间上限同时生效；
            清空日志请用上方「清空日志」按钮。
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={`清空${kind === 'upstream' ? '上游请求' : '后台 API'}日志？`}
        description={
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            只清空当前标签页对应的日志，另一类日志与统计数据不受影响；此操作不可撤销。
          </span>
        }
        confirmText={clearing ? '清空中…' : '清空'}
        destructive
        onConfirm={clear}
      />
    </div>
  );
}
