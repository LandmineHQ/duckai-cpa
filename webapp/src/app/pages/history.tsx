import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Code2, History, Loader2, RefreshCw, Server, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';

import { apiDelete, apiGet, apiPut, ApiError } from '@/app/lib/api';
import { formatDateTime, formatNumber } from '@/app/lib/format';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { ChatMessageBubble } from '@/app/components/chat-message';
import { CopyButton } from '@/app/components/copy-button';
import type { HistoryInjection, HistoryUpstreamResponse, SessionMessage } from '@/app/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface HistoryItem {
  id: string;
  identityId: string | null;
  sessionKey: string;
  title: string;
  model: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

interface HistoryGroup {
  identityId: string | null;
  count: number;
  updatedAt: number;
  items: HistoryItem[];
}

interface HistoryResponse {
  ok: boolean;
  groups: HistoryGroup[];
  total: number;
  stats: { total: number; bytes: number; retentionDays: number };
}

interface HistoryImage {
  b64: string;
  format?: string;
  model?: string | null;
}

interface HistoryToolCall {
  name: string;
  callId?: string | null;
  args?: string;
  result?: string;
}

interface HistoryFile {
  filename: string;
  mimeType: string;
  pages?: number;
  bytes?: number;
  textChars?: number;
  text?: string;
}

interface HistoryMessage {
  role: string;
  content: string;
  ts: number;
  /** v2.49：PDF/文件附件元数据（历史只存元数据） */
  files?: HistoryFile[];
  /** v2.36：思考过程 / 生成图片 / 工具调用（位置、生图、联网） */
  reasoning?: string;
  images?: HistoryImage[];
  toolCalls?: HistoryToolCall[];
  sources?: Array<{ url: string; title?: string | null }>;
}

interface HistoryDetail {
  id: string;
  identityId: string | null;
  sessionKey: string;
  title: string;
  model: string | null;
  systemPrompt: string | null;
  /** v2.48：客户端工具协议注入快照（旧记录或未捕获时为 null）。 */
  injection?: HistoryInjection | null;
  messages: HistoryMessage[];
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

interface IdentityLite {
  id: string;
  label: string;
}

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  developer: '开发者',
  tool: '工具'
};

const UPSTREAM_SOURCE_LABEL: Record<string, string> = {
  conversation_state: 'conversation_state（服务端会话状态）',
  response: 'response（最近一次响应记录）'
};

function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function HistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [identities, setIdentities] = useState<IdentityLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [retentionDays, setRetentionDays] = useState('30');
  const [savingRetention, setSavingRetention] = useState(false);
  // v2.48：上游请求调试视图 + 提示词注入面板折叠状态
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const [upstreamLoading, setUpstreamLoading] = useState(false);
  const [upstream, setUpstream] = useState<HistoryUpstreamResponse | null>(null);
  const [injectionOpen, setInjectionOpen] = useState(true);

  const identityLabel = useCallback(
    (identityId: string | null) => {
      if (!identityId) return '未分配身份';
      const found = identities.find((item) => item.id === identityId);
      return found?.label || identityId;
    },
    [identities]
  );

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [historyResult, identityResult] = await Promise.allSettled([
        apiGet<HistoryResponse>('/history?limit=300'),
        apiGet<{ items: IdentityLite[] }>('/identities')
      ]);
      if (historyResult.status === 'fulfilled') {
        setData(historyResult.value);
        const stats = historyResult.value?.stats;
        if (stats && Number.isFinite(stats.retentionDays)) setRetentionDays(String(stats.retentionDays));
      } else if (!(historyResult.reason as ApiError)?.handled) {
        setError((historyResult.reason as Error)?.message || '加载会话历史失败');
      }
      if (identityResult.status === 'fulfilled') {
        setIdentities(Array.isArray(identityResult.value?.items) ? identityResult.value.items : []);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setUpstreamOpen(false);
    setUpstream(null);
    setInjectionOpen(true);
    setDetailLoading(true);
    try {
      const result = await apiGet<{ item: HistoryDetail }>(`/history/${encodeURIComponent(id)}`);
      setDetail(result?.item ?? null);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setDetail(null);
      toast.error((err as Error)?.message || '加载会话详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /** v2.48：查看该会话最近一次实际发给上游的请求（脱敏 JSON，仅本地调试）。 */
  const loadUpstream = useCallback(async (id: string) => {
    setUpstreamLoading(true);
    try {
      const result = await apiGet<HistoryUpstreamResponse>(`/history/${encodeURIComponent(id)}/upstream`);
      setUpstream(result);
      setUpstreamOpen(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '加载上游请求失败');
    } finally {
      setUpstreamLoading(false);
    }
  }, []);

  const groups = useMemo(() => data?.groups || [], [data]);

  const saveRetention = async () => {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      toast.error('保留天数需为 0 – 3650 的整数（0 = 不自动清理）');
      return;
    }
    setSavingRetention(true);
    try {
      await apiPut('/config', { history: { retentionDays: days } });
      toast.success(days === 0 ? '已关闭自动清理' : `会话历史将在 ${days} 天未更新后清理`);
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '保存保留策略失败');
    } finally {
      setSavingRetention(false);
    }
  };

  const removeConversation = async (item: HistoryItem) => {
    try {
      await apiDelete(`/history/${encodeURIComponent(item.id)}`);
      toast.success('已删除该会话记录');
      if (selectedId === item.id) {
        setSelectedId(null);
        setDetail(null);
      }
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '删除失败');
    }
  };

  return (
    <div className="space-y-4" data-testid="history-page">
      <PageHeader
        title="会话历史"
        description="按身份分组的只读会话记录（SQLite 存储）。默认保留 30 天：超过该天数未更新的会话会被自动清理。"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <History className="h-4 w-4" />
                    会话列表
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-xs">
                    共 {formatNumber(data?.stats?.total ?? data?.total ?? 0)} 段 · {formatBytes(data?.stats?.bytes ?? 0)}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load()}
                  disabled={loading}
                  data-testid="history-refresh"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  刷新
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {loading && !data ? (
                <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…
                </div>
              ) : groups.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">还没有会话记录</p>
              ) : (
                groups.map((group) => {
                  const key = group.identityId || '__unassigned__';
                  const isCollapsed = collapsed[key] === true;
                  return (
                    <div key={key} className="rounded-lg border" data-testid={`history-group-${key}`}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-muted/40"
                        onClick={() => setCollapsed((previous) => ({ ...previous, [key]: !isCollapsed }))}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{identityLabel(group.identityId)}</span>
                          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                            {group.count}
                          </Badge>
                        </span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                        />
                      </button>
                      {isCollapsed ? null : (
                        <div className="space-y-0.5 border-t p-1">
                          {group.items.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              data-testid={`history-item-${item.id}`}
                              className={`block w-full rounded-md px-2 py-1.5 text-left ${
                                selectedId === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
                              }`}
                              onClick={() => void loadDetail(item.id)}
                            >
                              <div className="truncate text-xs font-medium">{item.title}</div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span>{item.model || '—'}</span>
                                <span>·</span>
                                <span>{item.messageCount} 条</span>
                                <span>·</span>
                                <span>{formatDateTime(item.updatedAt)}</span>
                              </div>
                              <div
                                className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/70"
                                title={`会话 ID：${item.sessionKey}`}
                                data-testid={`history-session-${item.id}`}
                              >
                                {item.sessionKey}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">保留策略</CardTitle>
              <CardDescription className="text-xs">
                保留天数（0 = 不自动清理）。网关每 30 分钟清理一次超过该天数未更新的会话。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="history-retention-days">保留天数</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="history-retention-days"
                  data-testid="history-retention-days"
                  type="number"
                  min={0}
                  max={3650}
                  step={1}
                  className="h-8 w-24 text-xs"
                  value={retentionDays}
                  onChange={(event) => setRetentionDays(event.target.value)}
                />
                <Button size="sm" onClick={() => void saveRetention()} disabled={savingRetention} data-testid="history-retention-save">
                  {savingRetention ? '保存中…' : '保存'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-[520px]">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="text-sm">{detail ? detail.title : '选择左侧会话查看详情'}</CardTitle>
                {detail ? (
                  <div className="mt-1 flex min-w-0 items-center gap-1" data-testid="history-session-id">
                    <span className="shrink-0 text-[10px] text-muted-foreground">会话 ID</span>
                    <span className="truncate font-mono text-[10px] text-foreground/80" title={detail.sessionKey}>
                      {detail.sessionKey}
                    </span>
                    <CopyButton value={detail.sessionKey} size="sm" variant="ghost" />
                  </div>
                ) : null}
                <CardDescription className="text-xs">
                  {detail
                    ? `${identityLabel(detail.identityId)} · ${detail.model || '—'} · ${detail.messageCount} 条 · 更新于 ${formatDateTime(
                        detail.updatedAt
                      )}`
                    : '只读视图：系统上下文 + 对话记录（按时间）'}
                </CardDescription>
              </div>
              {detail ? (
                <div className="flex flex-wrap items-center gap-1">
                  {/* v2.48：查看该会话最近一次实际发给上游的请求（Dialog + 脱敏 JSON） */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void loadUpstream(detail.id)}
                    disabled={upstreamLoading}
                    data-testid="history-view-upstream"
                  >
                    {upstreamLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Server className="h-3.5 w-3.5" />
                    )}
                    查看上游请求
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      const item = groups.flatMap((group) => group.items).find((entry) => entry.id === detail.id);
                      if (item) void removeConversation(item);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除记录
                  </Button>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <div className="flex items-center gap-2 px-1 py-10 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载详情…
              </div>
            ) : !detail ? (
              <EmptyState icon={History} title="未选择会话" description="从左侧按身份展开，选择一段会话查看完整上下文。" />
            ) : (
              <div className="space-y-3">
                {detail.systemPrompt ? (
                  <details className="rounded-lg border bg-muted/20 p-2">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      系统上下文 / 提示词（{detail.systemPrompt.length} 字符）
                    </summary>
                    <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px]">
                      {detail.systemPrompt}
                    </pre>
                  </details>
                ) : null}
                {/* v2.48：客户端工具协议注入快照（完整 protocolText / 实际发给上游的第一条 user） */}
                {detail.injection ? (
                  <div className="rounded-lg border bg-muted/20" data-testid="history-injection">
                    <div className="flex flex-wrap items-center gap-1.5 p-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-xs"
                        aria-expanded={injectionOpen}
                        onClick={() => setInjectionOpen((previous) => !previous)}
                      >
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${injectionOpen ? '' : '-rotate-90'}`}
                        />
                        <Code2 className="h-3.5 w-3.5" />
                        提示词注入
                      </Button>
                      <Badge
                        variant={detail.injection.injected ? 'success' : 'muted'}
                        className="px-1.5 py-0 text-[10px]"
                        data-testid="history-injection-badge"
                      >
                        {detail.injection.injected ? '已注入' : '未注入'}
                      </Badge>
                      {detail.injection.contextPdf ? (
                        <Badge variant="info" className="px-1.5 py-0 text-[10px]" data-testid="history-context-pdf-badge">
                          {detail.injection.contextPdf.reused ? '上下文 PDF 复用' : '已生成上下文 PDF'}
                          {detail.injection.contextPdf.pages ? ` · ${detail.injection.contextPdf.pages} 页` : ''}
                        </Badge>
                      ) : null}
                      {detail.injection.clientTools.map((tool) => (
                        <Badge key={tool} variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                          {tool}
                        </Badge>
                      ))}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        upstreamMessageCount={detail.injection.upstreamMessageCount ?? '—'} · chain=
                        {detail.injection.chain || '—'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        · 采集于 {formatDateTime(detail.injection.at)}
                      </span>
                    </div>
                    {injectionOpen ? (
                      <div className="space-y-2 border-t p-2">
                        <details
                          className="rounded border bg-background/60 p-2"
                          data-testid="history-injection-protocol"
                        >
                          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                            {detail.injection.protocolKind === 'client-tools-pdf' ? 'PDF 用途说明' : '协议文本 protocolText'}（{detail.injection.protocolText.length} 字符，完整显示不截断）
                          </summary>
                          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px]">
                            {detail.injection.protocolText || '（空）'}
                          </pre>
                        </details>
                        <details
                          className="rounded border bg-background/60 p-2"
                          data-testid="history-injection-first-user"
                        >
                          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                            实际发给上游的第一条 user（{detail.injection.firstUserContent.length} 字符，完整显示不截断）
                          </summary>
                          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px]">
                            {detail.injection.firstUserContent || '（空）'}
                          </pre>
                        </details>
                        <p className="text-[10px] text-muted-foreground">
                          upstreamMessageCount={detail.injection.upstreamMessageCount ?? '—'} · chain=
                          {detail.injection.chain || '—'}
                          {detail.injection.clientTools.length
                            ? ` · 工具：${detail.injection.clientTools.join(', ')}`
                            : ' · 无客户端工具'}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {/* v2.37：与「连接测试」共用 ChatMessageBubble（工具调用 / 图片 / 思考 / 来源） */}
                <div className="space-y-2" data-testid="history-messages">
                  {detail.messages.filter((message) => message.role !== 'system' && message.role !== 'developer').map((message, index) => (
                    <div key={`${message.ts}-${index}`} data-testid={`history-message-${index}`}>
                      <ChatMessageBubble
                        message={{
                          id: `hist-${index}`,
                          role:
                            message.role === 'user' || message.role === 'assistant' || message.role === 'system'
                              ? message.role
                              : 'assistant',
                          content: message.content,
                          ts: message.ts,
                          reasoning: message.reasoning,
                          toolCalls: message.toolCalls,
                          sources: message.sources,
                          images: message.images,
                          files: message.files
                        } satisfies SessionMessage}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* v2.48：上游请求调试 Dialog（GET /admin/api/history/:id/upstream，JSON 已脱敏） */}
      <Dialog open={upstreamOpen} onOpenChange={setUpstreamOpen}>
        <DialogContent className="max-w-3xl" data-testid="history-upstream-dialog">
          <DialogHeader>
            <DialogTitle>查看上游请求</DialogTitle>
            <DialogDescription>
              {upstream
                ? `${UPSTREAM_SOURCE_LABEL[upstream.source ?? ''] || upstream.source || '无来源'} · ${
                    upstream.messageCount
                  } 条消息 · 会话 ${upstream.sessionKey || '—'} · 提示词注入=${
                    upstream.injection?.injected ? '已注入' : '未注入'
                  }`
                : '正在加载…'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            仅本地调试；图片 base64 已脱敏为 [image data ...]。
          </div>
          <pre
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-[11px]"
            data-testid="history-upstream-json"
          >
            {upstream ? JSON.stringify(upstream.messages, null, 2) : '加载中…'}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpstreamOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
