import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPost, ApiError } from '@/app/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/app/lib/format';
import type { CreatedKey, KeyItem } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { CopyButton } from '@/app/components/copy-button';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function KeysPage() {
  const [items, setItems] = useState<KeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<{ items: KeyItem[] }>('/keys');
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载 API Key 失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const response = await apiPost<CreatedKey>('/keys', { label: label.trim() || 'default' });
      setCreated(response);
      setCreateOpen(false);
      setLabel('');
      toast.success('API Key 已创建');
      await load();
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '创建失败，请重试');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    try {
      await apiDelete<{ ok: boolean }>(`/keys/${encodeURIComponent(revokeTarget.id)}`);
      toast.success('API Key 已吊销');
      setRevokeTarget(null);
      await load();
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '吊销失败，请重试');
    }
  };

  const totalRequests = items.reduce((sum, item) => sum + (Number(item.requestCount) || 0), 0);

  return (
    <div>
      <PageHeader
        title="API Key"
        description="强制鉴权：所有 /v1/* 请求都必须携带 API Key"
      />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">v2 起 /v1/* 强制 API Key</p>
          <p className="text-xs text-muted-foreground">
            无 Key 或 Key 错误会返回 401 <code className="rounded bg-muted px-1">invalid_api_key</code>。
            首次启动会自动创建 label 为 <code className="rounded bg-muted px-1">default</code> 的 Key，完整值只打印到启动日志；
            完整 Key 也仅在创建时展示一次，请立即复制保存。
          </p>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Key 列表</CardTitle>
              <CardDescription className="text-xs">
                共 {items.length} 个 Key · 累计请求 {formatNumber(totalRequests)} 次
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {items.length > 0 ? <Badge variant="outline">强制鉴权已启用</Badge> : null}
              <Button
                variant="outline"
                size="sm"
                data-testid="keys-refresh"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                刷新
              </Button>
              <Button size="sm" data-testid="keys-create" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                创建 Key
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && items.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-10 rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="还没有 API Key"
              description="创建第一个 Key 后，客户端即可通过 Authorization: Bearer <key> 调用 /v1/*。"
              action={
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  创建第一个 Key
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标签</TableHead>
                  <TableHead>Key 预览</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className="text-right">请求数</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-1.5">
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                        {item.label || '未命名'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">{item.keyPreview}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.lastUsedAt ? formatRelative(item.lastUsedAt) : '从未使用'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(item.requestCount)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setRevokeTarget(item)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        吊销
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(open) => (!creating ? setCreateOpen(open) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>创建 API Key</DialogTitle>
            <DialogDescription>给这个 Key 一个便于识别的标签；创建后完整 Key 只显示一次。</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!creating) void create();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-label">标签</Label>
              <Input
                id="key-label"
                value={label}
                autoFocus
                maxLength={60}
                placeholder="例如：my-agent"
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                取消
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(created)} onOpenChange={(open) => (!open ? setCreated(null) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key 创建成功</DialogTitle>
            <DialogDescription>把下面的 Key 填入客户端配置；关闭后将无法再次查看完整 Key。</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>完整 Key（{created.label}）</Label>
                <div className="flex gap-2">
                  <Input readOnly value={created.key} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                  <CopyButton value={created.key} label="复制" />
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                请立即复制并妥善保存；如遗失只能吊销后重新创建。
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreated(null)}>
              关闭
            </Button>
            {created ? <CopyButton value={created.key} label="复制并关闭" /> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => (!open ? setRevokeTarget(null) : null)}
        title="吊销 API Key？"
        description={`吊销「${revokeTarget?.label ?? ''}」后，使用该 Key 的客户端会立即失效，此操作不可撤销。`}
        confirmText="吊销"
        destructive
        onConfirm={revoke}
      />
    </div>
  );
}
