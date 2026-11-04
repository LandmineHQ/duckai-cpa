import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError, openEventStream } from '@/app/lib/api';
import { consumeSSE } from '@/app/lib/sse';
import { formatRelative } from '@/app/lib/format';
import type {
  CompactSessionResponse,
  ConfigResponse,
  IdentitiesResponse,
  ModelInfo,
  SessionDetail,
  SessionMessage,
  SessionSummary,
  SessionSummaryInfo,
  SessionsResponse,
  TestStreamEvent
} from '@/app/lib/types';
import { useOverview } from '@/app/lib/overview-context';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { ChatMessageBubble } from '@/app/components/chat-message';
import { CopyButton } from '@/app/components/copy-button';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import {
  ModelCapabilityBadges,
  ModelCompactionBadge,
  ModelContextLine,
  isModelLocked
} from '@/app/components/model-badge';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectItemText,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const ACTIVE_SESSION_KEY = 'duckai_cpa_active_session';

function persistActiveSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function readPersistedSession(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

function mergeSources(previous: SessionMessage['sources'], incoming: SessionMessage['sources']) {
  const byUrl = new Map<string, { title?: string; url: string; snippet?: string }>();
  for (const source of previous ?? []) {
    if (source?.url) byUrl.set(source.url, source);
  }
  for (const source of incoming ?? []) {
    if (source?.url && !byUrl.has(source.url)) byUrl.set(source.url, source);
  }
  return [...byUrl.values()];
}

/** v2.11：summary 覆盖条数（消息优先，兼容 pair/covered）。 */
function summaryCoveredCount(summary: SessionSummaryInfo | null | undefined): number {
  if (!summary) return 0;
  return (
    summary.coveredMessageCount ??
    summary.coveredPairCount ??
    summary.coveredCount ??
    0
  );
}

function summaryPlainText(summary: SessionSummaryInfo | null | undefined): string {
  const value = summary?.text ?? summary?.summary;
  return typeof value === 'string' ? value : '';
}

function summarySavedChars(summary: SessionSummaryInfo | null | undefined): number {
  const value = summary?.savedChars ?? summary?.savedCharacters;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

interface SessionsPanelProps {
  sessions: SessionSummary[];
  activeId: string | null;
  loading: boolean;
  /** sessionId → 是否正在流式生成（每会话独立）。 */
  streamingSessions?: Record<string, boolean>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  /** v2.31：多选批量删除 */
  selected?: Record<string, boolean>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: (checked: boolean) => void;
  onBulkDelete?: () => void;
  className?: string;
}

function SessionsPanel({
  sessions,
  activeId,
  loading,
  streamingSessions,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  selected = {},
  onToggleSelect,
  onToggleSelectAll,
  onBulkDelete,
  className
}: SessionsPanelProps) {
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const allSelected = sessions.length > 0 && sessions.every((session) => selected[session.id]);
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          会话
          <Badge variant="muted" className="text-[10px]">
            {sessions.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {sessions.length > 0 ? (
            <Button
              size="sm"
              variant={selectedCount > 0 ? 'destructive' : 'outline'}
              className="h-7 px-2 text-[11px]"
              disabled={selectedCount === 0}
              onClick={() => onBulkDelete?.()}
              data-testid="sessions-bulk-delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {selectedCount > 0 ? `删除 ${selectedCount}` : '批量删除'}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="outline" className="h-7 w-7" aria-label="新建会话" onClick={onCreate}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>新建会话</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {sessions.length > 0 ? (
        <label className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={allSelected}
            onChange={(event) => onToggleSelectAll?.(event.target.checked)}
            data-testid="sessions-select-all"
          />
          全选（{selectedCount}/{sessions.length}）
        </label>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1.5 p-2">
          {loading && sessions.length === 0 ? (
            Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12 rounded-lg" />)
          ) : sessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              还没有会话
              <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" onClick={onCreate}>
                立即新建
              </Button>
            </div>
          ) : (
            sessions.map((session) => {
              const active = session.id === activeId;
              const sessionStreaming = streamingSessions?.[session.id] === true;
              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(session.id);
                    }
                  }}
                  className={cn(
                    'group cursor-pointer rounded-lg border px-2.5 py-2 transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:border-border hover:bg-accent/40'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                      checked={selected[session.id] === true}
                      aria-label={`选择会话 ${session.title || session.id}`}
                      data-testid={`session-select-${session.id}`}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={() => onToggleSelect?.(session.id)}
                    />
                    <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', !active && 'text-foreground')}>
                      {session.title || '未命名会话'}
                    </span>
                    {sessionStreaming ? (
                      <Badge variant="info" className="shrink-0 gap-1 px-1.5 py-0 text-[9px]">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        生成中
                      </Badge>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 opacity-50 group-hover:opacity-100"
                          aria-label="会话操作"
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem onSelect={() => onRename(session)}>
                          <Pencil className="h-3.5 w-3.5" />
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => onDelete(session)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="truncate">{session.model}</span>
                    <span>·</span>
                    <span>{session.messageCount} 条</span>
                    <span
                      className="font-mono text-[9px] text-muted-foreground/70"
                      title={`会话 ID：${session.id}`}
                      data-testid={`session-id-${session.id}`}
                    >
                      {session.id}
                    </span>
                    {session.identityLabel || session.identityId ? (
                      <span className="max-w-[92px] truncate rounded bg-primary/10 px-1 text-primary">
                        {session.identityLabel || session.identityId}
                      </span>
                    ) : null}
                    <span>·</span>
                    <span className="shrink-0">{formatRelative(session.updatedAt)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function PlaygroundPage() {
  const { data: overview } = useOverview();

  const [models, setModels] = useState<ModelInfo[]>(overview?.models ?? []);
  const [allowPaidModels, setAllowPaidModels] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  /** v2.5：按会话缓存消息 / 流式草稿 / 生成状态，切换会话互不影响。 */
  const [sessionMessages, setSessionMessages] = useState<Record<string, SessionMessage[]>>({});
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, SessionMessage | null>>({});
  const [streamingSessions, setStreamingSessions] = useState<Record<string, boolean>>({});
  const [retryingBySession, setRetryingBySession] = useState<Record<string, string | null>>({});
  const [input, setInput] = useState('');
  const [model, setModel] = useState('gpt-6-luna');
  const [reasoning, setReasoning] = useState('none');
  const [webSearch, setWebSearch] = useState(false);
  const [imageGeneration, setImageGeneration] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  // v2.31：会话多选批量删除
  const [selectedSessions, setSelectedSessions] = useState<Record<string, boolean>>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [summaryHighlight, setSummaryHighlight] = useState(false);
  const [summaryEditOpen, setSummaryEditOpen] = useState(false);
  const [summaryEditText, setSummaryEditText] = useState('');
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryClearOpen, setSummaryClearOpen] = useState(false);
  const summaryCardRef = useRef<HTMLDivElement | null>(null);
  const [identityMeta, setIdentityMeta] = useState<Record<string, { label: string; fingerprint: string }>>({});

  /** sessionId → 独立 AbortController（同一会话同一时刻最多一个流）。 */
  const streamsRef = useRef<Map<string, AbortController>>(new Map());
  /** 与 state 同步的 refs，供异步 SSE 回调读取最新状态（避免闭包过期）。 */
  const draftsRef = useRef<Record<string, SessionMessage | null>>({});
  const streamingRef = useRef<Record<string, boolean>>({});
  const loadedRef = useRef<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const messages = activeId ? (sessionMessages[activeId] ?? []) : [];
  const draft = activeId ? (sessionDrafts[activeId] ?? null) : null;
  const activeStreaming = activeId ? Boolean(streamingSessions[activeId]) : false;
  const retryingId = activeId ? (retryingBySession[activeId] ?? null) : null;

  const setStreamingFor = useCallback((sessionId: string, value: boolean) => {
    streamingRef.current = { ...streamingRef.current, [sessionId]: value };
    setStreamingSessions(streamingRef.current);
  }, []);

  const setDraftState = useCallback((sessionId: string, next: SessionMessage | null) => {
    draftsRef.current = { ...draftsRef.current, [sessionId]: next };
    setSessionDrafts(draftsRef.current);
  }, []);

  const patchDraft = useCallback(
    (sessionId: string, updater: (previous: SessionMessage) => SessionMessage) => {
      const previous = draftsRef.current[sessionId];
      if (!previous) return;
      setDraftState(sessionId, updater(previous));
    },
    [setDraftState]
  );

  const appendMessage = useCallback((sessionId: string, message: SessionMessage) => {
    setSessionMessages((previous) => ({
      ...previous,
      [sessionId]: [...(previous[sessionId] ?? []), message]
    }));
  }, []);

  const finalizeDraft = useCallback(
    (sessionId: string, extra?: Partial<SessionMessage>) => {
      const current = draftsRef.current[sessionId];
      if (current) appendMessage(sessionId, { ...current, ...extra });
      setDraftState(sessionId, null);
    },
    [appendMessage, setDraftState]
  );

  const forgetSession = useCallback((sessionId: string) => {
    const controller = streamsRef.current.get(sessionId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      streamsRef.current.delete(sessionId);
    }
    streamingRef.current = { ...streamingRef.current, [sessionId]: false };
    setStreamingSessions(streamingRef.current);
    draftsRef.current = { ...draftsRef.current, [sessionId]: null };
    setSessionDrafts(draftsRef.current);
    setSessionMessages((previous) => {
      if (!(sessionId in previous)) return previous;
      const next = { ...previous };
      delete next[sessionId];
      return next;
    });
    delete loadedRef.current[sessionId];
    setRetryingBySession((previous) => ({ ...previous, [sessionId]: null }));
  }, []);

  /** 把流式错误翻译成可读、可重试的提示（409/429/网络不用“未知错误”）。 */
  /** v2.12：展开摘要折叠块并滚动/高亮（头部徽章、手动/自动压缩后调用）。 */
  const focusSummaryCard = useCallback(() => {
    setSummaryOpen(true);
    setSummaryHighlight(true);
    window.setTimeout(() => {
      summaryCardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 80);
    window.setTimeout(() => setSummaryHighlight(false), 2400);
  }, []);

  const describeStreamError = (err: unknown): string => {
    const apiError = err as ApiError;
    if (apiError?.status === 409) {
      if (apiError.code === 'session_busy') return '该会话正在生成中（409 session_busy），请等待完成或先停止后重试。';
      return apiError.message || '会话状态冲突，请刷新后重试。';
    }
    if (apiError?.status === 429) {
      return apiError.code === 'queue_full' || apiError.code === 'queue_timeout'
        ? '上游队列繁忙或排队超时，请稍后重试。'
        : '匿名额度受限（429），请稍后重试。';
    }
    if (apiError?.status === 503) return '上游暂不可用，请稍后重试。';
    if (apiError?.code === 'network_error') return '网络连接中断，请检查网关后点击重试。';
    return apiError?.message || (err as Error)?.message || '发送消息失败，请重试。';
  };

  /**
   * 统一处理 session/delta/reasoning/search/image/done/error 事件。
   * 所有写入都绑定发起请求的 sessionId；切换视图不影响后台流。
   * 返回 true 表示收到 error 事件。
   */
  const handleStreamEvent = (
    sessionId: string,
    event: TestStreamEvent,
    options: { expectedUserId?: string | null; retryOf?: string | null } = {}
  ): boolean => {
    let failed = false;
    switch (event.type) {
      case 'session': {
        if (event.userMessageId && options.expectedUserId) {
          const nextUserId = event.userMessageId;
          const expected = options.expectedUserId;
          setSessionMessages((previous) => ({
            ...previous,
            [sessionId]: (previous[sessionId] ?? []).map((item) =>
              item.id === expected ? { ...item, id: nextUserId } : item
            )
          }));
        }
        const retryOf = options.retryOf ?? event.retryOf;
        if (event.assistantMessageId || retryOf) {
          patchDraft(sessionId, (previous) => ({
            ...previous,
            ...(event.assistantMessageId ? { id: event.assistantMessageId } : {}),
            ...(retryOf ? { retriedFrom: retryOf } : {})
          }));
        }
        break;
      }
      case 'delta':
        if (typeof event.text === 'string' && event.text) {
          patchDraft(sessionId, (previous) => ({ ...previous, content: previous.content + event.text }));
        }
        break;
      case 'reasoning':
        if (typeof event.text === 'string' && event.text) {
          patchDraft(sessionId, (previous) => ({ ...previous, reasoning: (previous.reasoning ?? '') + event.text }));
        }
        break;
      case 'search':
        if (Array.isArray(event.results)) {
          patchDraft(sessionId, (previous) => ({ ...previous, sources: mergeSources(previous.sources, event.results) }));
        }
        break;
      case 'image':
        if (event.b64) {
          patchDraft(sessionId, (previous) => ({
            ...previous,
            images: [
              ...(previous.images ?? []),
              { b64: event.b64 as string, format: event.format, width: event.width, height: event.height }
            ]
          }));
        }
        break;
      case 'done': {
        // v2.29：后端在请求发起后才路由并回填身份，这里同步到会话列表/当前会话
        if (event.identityId) {
          setSessions((previous) =>
            previous.map((item) =>
              item.id === sessionId
                ? {
                    ...item,
                    identityId: String(event.identityId),
                    identityLabel: event.identityLabel ? String(event.identityLabel) : item.identityLabel
                  }
                : item
            )
          );
          if (activeIdRef.current === sessionId) {
            setActiveSession((previous) =>
              previous
                ? {
                    ...previous,
                    identityId: String(event.identityId),
                    identityLabel: event.identityLabel ? String(event.identityLabel) : previous.identityLabel
                  }
                : previous
            );
          }
        }
        if (event.message && typeof event.message === 'object') {
          const message = event.message as SessionMessage;
          appendMessage(sessionId, message);
          setDraftState(sessionId, null);
        } else {
          finalizeDraft(sessionId, { latencyMs: event.latencyMs, queueWaitMs: event.queueWaitMs, finishReason: 'stop' });
        }
        // v2.11：自动压缩（done.compacted=true / summary）→ 插入提示条并更新 summary
        if (event.compacted || event.summary) {
          const info = event.summary ?? null;
          const covered =
            event.coveredMessageCount ?? event.coveredPairCount ?? summaryCoveredCount(info) ?? 0;
          appendMessage(sessionId, {
            id: `compact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'system',
            content: `上下文已压缩（覆盖 ${covered} 条消息），后续基于摘要继续`,
            ts: Date.now()
          });
          setSessions((previous) =>
            previous.map((item) => (item.id === sessionId ? { ...item, summary: info ?? item.summary } : item))
          );
          if (activeIdRef.current === sessionId) {
            setActiveSession((previous) => (previous ? { ...previous, summary: info ?? previous.summary } : previous));
            window.setTimeout(() => focusSummaryCard(), 120);
          }
          toast.info(`已自动压缩历史（${covered} 条消息）`);
        }
        break;
      }
      case 'error': {
        failed = true;
        const message = typeof event.message === 'string' ? event.message : event.error || '上游返回错误';
        patchDraft(sessionId, (previous) => ({ ...previous, error: message, finishReason: 'error' }));
        toast.error(message, { duration: 6000 });
        break;
      }
      default:
        break;
    }
    return failed;
  };

  /* ---------------------- 模型 / 配置 / 会话加载 ---------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiGet<{ items: ModelInfo[] }>('/models');
        if (!cancelled && Array.isArray(response?.items) && response.items.length > 0) {
          setModels(response.items);
        }
      } catch (modelError) {
        if ((modelError as ApiError)?.handled) return;
        if (overview?.models?.length) setModels(overview.models);
      }
      try {
        const configResponse = await apiGet<ConfigResponse>('/config');
        if (!cancelled) setAllowPaidModels(configResponse?.config?.duck?.allowPaidModels === true);
      } catch (configError) {
        if ((configError as ApiError)?.handled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (overview?.models?.length && models.length === 0) setModels(overview.models);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.models?.length]);

  // v2.4：加载身份池映射（用于会话头展示绑定身份的 label + 指纹前缀）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiGet<IdentitiesResponse>('/identities');
        if (cancelled) return;
        const map: Record<string, { label: string; fingerprint: string }> = {};
        for (const item of Array.isArray(response?.items) ? response.items : []) {
          if (item?.id) map[item.id] = { label: item.label || item.id, fingerprint: item.fingerprint || '' };
        }
        setIdentityMeta(map);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        // 后端未实现身份池时静默降级（不显示身份徽章）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const freeModels = useMemo(() => models.filter((item) => !item.paid), [models]);
  const paidModels = useMemo(() => models.filter((item) => item.paid), [models]);

  const selectedModelInfo = models.find((item) => item.id === model);
  const currentLocked = Boolean(selectedModelInfo && isModelLocked(selectedModelInfo, allowPaidModels));

  // 模型加载/开关变化后，若当前模型不可用则回退到免费模型
  useEffect(() => {
    if (models.length === 0) return;
    const info = models.find((item) => item.id === model);
    if (!info || isModelLocked(info, allowPaidModels)) {
      const fallback = freeModels[0]?.id ?? models[0].id;
      if (fallback && fallback !== model) setModel(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, allowPaidModels]);

  const reasoningOptions = useMemo(() => {
    const info = models.find((item) => item.id === model);
    const rawSupported =
      (Array.isArray(info?.supported_reasoning_efforts) && info.supported_reasoning_efforts) ||
      (Array.isArray(info?.reasoningEfforts) && info.reasoningEfforts) ||
      [];
    const supported = rawSupported.filter((value): value is string => typeof value === 'string');
    const values = ['none', ...supported.filter((value) => value !== 'none')];
    return [...new Set(values)];
  }, [models, model]);

  useEffect(() => {
    if (!reasoningOptions.includes(reasoning)) setReasoning('none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasoningOptions]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const response = await apiGet<SessionsResponse>('/test/sessions');
      const items = Array.isArray(response?.items) ? response.items : [];
      setSessions(items);
      setActiveId((current) => {
        if (current && items.some((session) => session.id === current)) return current;
        const persisted = readPersistedSession();
        if (persisted && items.some((session) => session.id === persisted)) return persisted;
        return items[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载会话列表失败');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setMessagesLoading(true);
    try {
      const response = await apiGet<SessionDetail>(`/test/sessions/${encodeURIComponent(id)}`);
      // 拉取期间该会话已开始流式生成：保留本地缓存/草稿，避免把进行中的回复清掉
      if (streamingRef.current[id]) {
        loadedRef.current[id] = true;
        return;
      }
      const session = response?.session ?? null;
      const detailMessages = Array.isArray(response?.messages) ? response.messages : [];
      // 写入该会话缓存（后台刷新也不会污染其它会话视图）
      setSessionMessages((previous) => ({ ...previous, [id]: detailMessages }));
      draftsRef.current = { ...draftsRef.current, [id]: null };
      setSessionDrafts(draftsRef.current);
      loadedRef.current[id] = true;
      if (activeIdRef.current === id) {
        const mergedSession = session
          ? { ...session, summary: session.summary ?? response?.summary ?? null }
          : sessions.find((item) => item.id === id) ?? null;
        setActiveSession(mergedSession);
        if (mergedSession?.summary) {
          setSessions((previous) =>
            previous.map((item) => (item.id === id ? { ...item, summary: mergedSession.summary } : item))
          );
        }
        if (session) {
          setModel(session.model || 'gpt-6-luna');
          setReasoning(session.reasoningEffort || 'none');
          setWebSearch(Boolean(session.webSearch));
          setImageGeneration(Boolean(session.imageGeneration));
        }
        persistActiveSession(id);
        setError(null);
      }
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      if (activeIdRef.current === id) setError((err as Error)?.message || '加载会话失败');
    } finally {
      if (activeIdRef.current === id) setMessagesLoading(false);
    }
  }, [sessions]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!activeId) {
      setActiveSession(null);
      setMessagesLoading(false);
      return;
    }
    setActiveSession(sessions.find((session) => session.id === activeId) ?? null);
    setMessagesLoading(false);
    // 已有缓存（含后台流式中的会话）不再拉取详情，避免覆盖本地进度
    if (!loadedRef.current[activeId] && !streamingRef.current[activeId]) {
      void loadDetail(activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, sessions.map((session) => session.id).join(',')]);

  useEffect(() => {
    const node = endRef.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'end' });
    }
  }, [messages.length, draft?.content, draft?.reasoning, draft?.images?.length, draft?.sources?.length]);

  /* ---------------------------- 会话操作 ---------------------------- */

  const patchSessionSettings = useCallback(
    (partial: Partial<Pick<SessionSummary, 'model' | 'reasoningEffort' | 'webSearch' | 'imageGeneration' | 'title'>>) => {
      if (!activeId) return;
      void apiPatch<{ session: SessionSummary }>(`/test/sessions/${encodeURIComponent(activeId)}`, partial)
        .then((response) => {
          if (response?.session) {
            const session = response.session;
            setActiveSession(session);
            setSessions((previous) => previous.map((item) => (item.id === session.id ? session : item)));
          }
        })
        .catch(() => {
          /* 静默失败：下次发送消息时会再次带上参数 */
        });
    },
    [activeId]
  );

  const createSession = useCallback(async (): Promise<string | null> => {
    const fallbackModel = freeModels[0]?.id ?? models[0]?.id ?? 'gpt-6-luna';
    const effectiveModel = currentLocked ? fallbackModel : model || fallbackModel;
    try {
      const response = await apiPost<{ session: SessionSummary }>('/test/sessions', {
        model: effectiveModel,
        reasoningEffort: reasoning,
        webSearch,
        imageGeneration
      });
      const session = response?.session;
      if (!session) throw new Error('服务未返回会话信息');
      setSessions((previous) => [session, ...previous]);
      setActiveId(session.id);
      setActiveSession(session);
      setSessionMessages((previous) => ({ ...previous, [session.id]: [] }));
      draftsRef.current = { ...draftsRef.current, [session.id]: null };
      setSessionDrafts(draftsRef.current);
      loadedRef.current[session.id] = true;
      persistActiveSession(session.id);
      setMobileSessionsOpen(false);
      setError(null);
      toast.success('已新建会话');
      return session.id;
    } catch (err) {
      if ((err as ApiError)?.handled) return null;
      toast.error((err as Error)?.message || '新建会话失败');
      return null;
    }
  }, [currentLocked, freeModels, imageGeneration, model, models, reasoning, webSearch]);

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    setMobileSessionsOpen(false);
  }, []);

  const openRename = (session: SessionSummary) => {
    setRenameTarget(session);
    setRenameValue(session.title || '');
  };

  const renameSession = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) {
      toast.error('标题不能为空');
      return;
    }
    try {
      const response = await apiPatch<{ session: SessionSummary }>(
        `/test/sessions/${encodeURIComponent(renameTarget.id)}`,
        { title }
      );
      if (response?.session) {
        const session = response.session;
        setSessions((previous) => previous.map((item) => (item.id === session.id ? session : item)));
        if (activeSession?.id === session.id) setActiveSession(session);
      }
      setRenameTarget(null);
      toast.success('会话已重命名');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '重命名失败');
    }
  };

  const toggleSessionSelected = (id: string) =>
    setSelectedSessions((previous) => ({ ...previous, [id]: !previous[id] }));

  const toggleSelectAllSessions = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    if (checked) for (const session of sessions) next[session.id] = true;
    setSelectedSessions(next);
  };

  const bulkDeleteSelected = async () => {
    const ids = sessions.filter((session) => selectedSessions[session.id]).map((session) => session.id);
    if (!ids.length) return;
    for (const id of ids) forgetSession(id);
    try {
      const result = await apiPost<{ deleted?: string[]; missing?: string[]; deletedCount?: number }>(
        '/test/sessions/bulk-delete',
        { ids }
      );
      const deleted = new Set(result?.deleted || ids);
      const remaining = sessions.filter((session) => !deleted.has(session.id));
      setSessions(remaining);
      setSelectedSessions({});
      setBulkDeleteOpen(false);
      if (activeId && deleted.has(activeId)) {
        const nextId = remaining[0]?.id ?? null;
        setActiveId(nextId);
        if (!nextId) {
          setActiveSession(null);
          persistActiveSession(null);
        } else {
          await selectSession(nextId);
        }
      }
      toast.success(`已删除 ${result?.deletedCount ?? ids.length} 个会话`);
      await loadSessions();
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '批量删除失败');
    }
  };

  const deleteSession = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    // 先中止该会话的后台流并清空缓存
    forgetSession(targetId);
    try {
      await apiDelete<{ ok: boolean }>(`/test/sessions/${encodeURIComponent(targetId)}`);
      setDeleteTarget(null);
      const remaining = sessions.filter((session) => session.id !== targetId);
      setSessions(remaining);
      if (activeId === targetId) {
        const nextId = remaining[0]?.id ?? null;
        setActiveId(nextId);
        if (!nextId) {
          setActiveSession(null);
          persistActiveSession(null);
        }
      }
      toast.success('会话已删除');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '删除失败');
    }
  };

  /* ------------------------------ 发送 ------------------------------ */

  const send = async () => {
    const content = input.trim();
    if (!content) {
      // 同一会话流式生成中再次按 Enter：给出明确“会话忙”提示（后端 409 session_busy 的本地前置提示）
      if (activeId && streamingRef.current[activeId]) {
        toast.warning('该会话正在生成中，请等待完成或先停止后再发送。');
      }
      return;
    }
    if (currentLocked) {
      toast.error('当前模型为付费模型，请先在设置中开启 allowPaidModels 或切换免费模型');
      return;
    }

    let sessionId = activeId;
    if (!sessionId) {
      sessionId = await createSession();
      if (!sessionId) return;
    }
    // 仅检查“该会话”是否已在生成；其它会话在流式生成不影响这里
    if (streamingRef.current[sessionId]) {
      toast.warning('该会话正在生成中，请等待完成或先停止后再发送。');
      return;
    }

    const tempUserId = `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tempAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const userMessage: SessionMessage = { id: tempUserId, role: 'user', content, ts: Date.now() };
    const assistantDraft: SessionMessage = {
      id: tempAssistantId,
      role: 'assistant',
      content: '',
      reasoning: '',
      sources: [],
      images: [],
      model,
      ts: Date.now()
    };
    appendMessage(sessionId, userMessage);
    setDraftState(sessionId, assistantDraft);
    loadedRef.current[sessionId] = true;
    setInput('');
    setStreamingFor(sessionId, true);
    setError(null);

    const controller = new AbortController();
    streamsRef.current.set(sessionId, controller);
    let failed = false;

    try {
      const response = await openEventStream(
        `/test/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          content,
          model,
          reasoningEffort: reasoning,
          webSearch,
          imageGeneration,
          stream: true
        },
        { signal: controller.signal }
      );

      await consumeSSE(response, (event: TestStreamEvent) => {
        if (handleStreamEvent(sessionId, event, { expectedUserId: tempUserId })) failed = true;
      });

      // 流在没收到 done/error 的情况下结束（例如网络中断）：把草稿落盘
      if (draftsRef.current[sessionId]) {
        failed = true;
        finalizeDraft(sessionId, {
          finishReason: 'incomplete',
          error: draftsRef.current[sessionId]?.error || '上游流意外结束，可点击重试'
        });
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        finalizeDraft(sessionId, { finishReason: 'aborted' });
        // 只有“用户主动停止”才提示；删除会话导致的 abort 静默
        if (streamsRef.current.get(sessionId) === controller) {
          toast.info('已停止生成');
        }
      } else if (!(err as ApiError)?.handled) {
        failed = true;
        const message = describeStreamError(err);
        if (draftsRef.current[sessionId]) {
          patchDraft(sessionId, (previous) => ({ ...previous, error: message }));
          finalizeDraft(sessionId, { finishReason: 'error' });
        }
        toast.error(message, { duration: 6000 });
      }
    } finally {
      setStreamingFor(sessionId, false);
      if (streamsRef.current.get(sessionId) === controller) streamsRef.current.delete(sessionId);
      void loadSessions();
      if (failed && activeIdRef.current === sessionId) {
        // 让服务端记录的 error/消息落到该会话缓存
        window.setTimeout(() => {
          void loadDetail(sessionId as string);
        }, 250);
      }
    }
  };

  const retryMessage = async (target: SessionMessage) => {
    if (!activeId) {
      toast.error('请先选择或新建会话');
      return;
    }
    if (target.role !== 'assistant') return;
    const sessionId = activeId;
    if (streamingRef.current[sessionId]) {
      toast.warning('该会话正在生成中，请等待完成或先停止后再重试。');
      return;
    }
    if (!loadedRef.current[sessionId]) {
      toast.error('会话正在加载，请稍候再试');
      return;
    }
    if (currentLocked) {
      toast.error('当前模型为付费模型，请先在设置中开启 allowPaidModels 或切换免费模型');
      return;
    }

    const currentMessages = sessionMessages[sessionId] ?? [];
    const targetIndex = currentMessages.findIndex((item) => item.id === target.id);
    if (targetIndex < 0) {
      toast.error('目标消息不存在（可能已刷新），请重新加载会话');
      return;
    }
    let userIndex = -1;
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      if (currentMessages[index].role === 'user') {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) {
      toast.error('找不到该回复对应的用户消息，无法重新生成');
      return;
    }

    const retainedUserId = currentMessages[userIndex].id;
    const retained = currentMessages.slice(0, userIndex + 1);
    setSessionMessages((previous) => ({ ...previous, [sessionId]: retained }));

    const draftMessage: SessionMessage = {
      id: `local-retry-${Date.now()}`,
      role: 'assistant',
      content: '',
      reasoning: '',
      sources: [],
      images: [],
      model,
      ts: Date.now(),
      retriedFrom: target.id
    };
    setDraftState(sessionId, draftMessage);
    setRetryingBySession((previous) => ({ ...previous, [sessionId]: target.id }));
    setStreamingFor(sessionId, true);
    setError(null);

    const controller = new AbortController();
    streamsRef.current.set(sessionId, controller);
    let failed = false;

    try {
      const response = await openEventStream(
        `/test/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(target.id)}/retry`,
        {
          model,
          reasoningEffort: reasoning,
          webSearch,
          imageGeneration,
          stream: true
        },
        { signal: controller.signal }
      );

      await consumeSSE(response, (event: TestStreamEvent) => {
        if (handleStreamEvent(sessionId, event, { expectedUserId: retainedUserId, retryOf: target.id })) failed = true;
      });

      if (draftsRef.current[sessionId]) {
        failed = true;
        finalizeDraft(sessionId, {
          finishReason: 'incomplete',
          error: draftsRef.current[sessionId]?.error || '上游流意外结束，可点击重试'
        });
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        finalizeDraft(sessionId, { finishReason: 'aborted' });
        if (streamsRef.current.get(sessionId) === controller) {
          toast.info('已停止重新生成');
        }
      } else if (!(err as ApiError)?.handled) {
        failed = true;
        const message = describeStreamError(err);
        if (draftsRef.current[sessionId]) {
          patchDraft(sessionId, (previous) => ({ ...previous, error: message }));
          finalizeDraft(sessionId, { finishReason: 'error' });
        }
        toast.error(message, { duration: 6000 });
      }
    } finally {
      setStreamingFor(sessionId, false);
      setRetryingBySession((previous) => ({ ...previous, [sessionId]: null }));
      if (streamsRef.current.get(sessionId) === controller) streamsRef.current.delete(sessionId);
      void loadSessions();
      if (failed && activeIdRef.current === sessionId) {
        // 同步服务端记录（截断结果 / error 消息 / retriedFrom）
        window.setTimeout(() => {
          void loadDetail(sessionId);
        }, 250);
      }
    }
  };

  const compactSession = () => {
    if (!activeId || compacting) return;
    const sessionId = activeId;
    setCompacting(true);
    void (async () => {
      try {
        const response = await apiPost<CompactSessionResponse>(
          `/test/sessions/${encodeURIComponent(sessionId)}/compact`,
          {}
        );
        const info = response?.summary ?? response?.session?.summary ?? null;
        const covered =
          response?.coveredMessageCount ??
          response?.coveredPairCount ??
          summaryCoveredCount(info) ??
          0;
        setSessions((previous) =>
          previous.map((item) =>
            item.id === sessionId
              ? { ...item, ...(response?.session ?? {}), summary: info ?? item.summary }
              : item
          )
        );
        if (activeIdRef.current === sessionId) {
          setActiveSession((previous) =>
            previous ? { ...previous, ...(response?.session ?? {}), summary: info ?? previous.summary } : previous
          );
          setSummaryOpen(Boolean(info));
        }
        toast.success(`已压缩上下文${covered ? `（覆盖 ${covered} 条消息）` : ''}`);
        await loadDetail(sessionId);
        window.setTimeout(() => focusSummaryCard(), 200);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        const apiError = err as ApiError;
        const message =
          apiError?.status === 429
            ? '压缩请求被限流（429），请稍后重试。'
            : apiError?.status === 413
              ? '会话过长超出限制（413），可先压缩成功后再继续。'
              : apiError?.message || '压缩会话失败，请重试。';
        toast.error(message, { duration: 7000 });
      } finally {
        setCompacting(false);
      }
    })();
  };

  const saveSummaryEdit = () => {
    if (!activeId) return;
    const text = summaryEditText.trim();
    if (!text) {
      toast.warning('摘要不能为空');
      return;
    }
    const sessionId = activeId;
    setSummarySaving(true);
    void (async () => {
      try {
        await apiPatch(`/test/sessions/${encodeURIComponent(sessionId)}/summary`, { text, summary: text });
        setActiveSession((previous) =>
          previous ? { ...previous, summary: { ...(previous.summary ?? {}), text, updatedAt: Date.now() } } : previous
        );
        setSessions((previous) =>
          previous.map((item) =>
            item.id === sessionId
              ? { ...item, summary: { ...(item.summary ?? {}), text, updatedAt: Date.now() } }
              : item
          )
        );
        setSummaryEditOpen(false);
        toast.success('摘要已更新');
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as Error)?.message || '更新摘要失败，请重试。');
      } finally {
        setSummarySaving(false);
      }
    })();
  };

  const clearCompaction = () => {
    if (!activeId) return;
    const sessionId = activeId;
    void (async () => {
      try {
        await apiDelete(`/test/sessions/${encodeURIComponent(sessionId)}/summary`);
        setActiveSession((previous) => (previous ? { ...previous, summary: null } : previous));
        setSessions((previous) => previous.map((item) => (item.id === sessionId ? { ...item, summary: null } : item)));
        setSummaryOpen(false);
        setSummaryClearOpen(false);
        toast.success('已清除压缩，恢复完整消息');
        await loadDetail(sessionId);
        await loadSessions();
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as Error)?.message || '清除压缩失败，请重试。');
      }
    })();
  };

  const stop = () => {
    // 只停止“当前会话”的生成，其它会话的后台流不受影响
    if (!activeId) return;
    const controller = streamsRef.current.get(activeId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  };

  /* ------------------------------ 渲染 ------------------------------ */

  const activeTitle = activeSession?.title || '新会话';
  const canSend = input.trim().length > 0 && !activeStreaming;
  const activeSummary = activeSession?.summary ?? null;
  const activeSummaryCount = summaryCoveredCount(activeSummary);
  const activeSummaryText = summaryPlainText(activeSummary);
  const activeSummarySaved = summarySavedChars(activeSummary);
  const modelOptions = (
    <>
      <SelectGroup>
        <SelectLabel>免费可用</SelectLabel>
        {freeModels.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            <div className="flex w-full min-w-0 flex-col gap-0.5">
              <div className="flex w-full min-w-0 items-center gap-2">
                <SelectItemText className="truncate font-medium">{item.display_name || item.name || item.id}</SelectItemText>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <ModelCapabilityBadges model={item} />
                </span>
              </div>
              <ModelContextLine model={item} />
              <ModelCompactionBadge model={item} />
            </div>
          </SelectItem>
        ))}
      </SelectGroup>
      {paidModels.length > 0 ? (
        <SelectGroup>
          <SelectLabel>付费（需订阅）</SelectLabel>
          {paidModels.map((item) => {
            const locked = isModelLocked(item, allowPaidModels);
            return (
              <SelectItem
                key={item.id}
                value={item.id}
                disabled={locked}
                title={
                  locked
                    ? '需 Duck.ai 订阅，设置中开启 allowPaidModels 后可尝试'
                    : '付费模型：需要 Duck.ai Plus/Pro 订阅'
                }
              >
                <div className="flex w-full min-w-0 flex-col gap-0.5">
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <SelectItemText className="truncate font-medium">{item.display_name || item.name || item.id}</SelectItemText>
                    {locked ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <Lock className="h-3 w-3 opacity-70" />
                        付费 · 需订阅
                      </span>
                    ) : null}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <ModelCapabilityBadges model={item} />
                    </span>
                  </div>
                  <ModelContextLine model={item} />
                  <ModelCompactionBadge model={item} />
                </div>
              </SelectItem>
            );
          })}
        </SelectGroup>
      ) : null}
    </>
  );

  // v2.19: 摘要内联在「触发压缩的位置」之后（DSH web 风格），而不是固定在消息流顶部。
  const summaryAnchorIndex = (() => {
    if (!activeSummaryText) return -1;
    const raw =
      (activeSummary as unknown as { anchorIndex?: number } | null)?.anchorIndex ??
      activeSummaryCount;
    const value = Number.isFinite(raw) ? Math.trunc(raw as number) : 0;
    return Math.max(0, Math.min(value, messages.length));
  })();

  const summaryCard =                 <div
                  ref={summaryCardRef}
                  data-testid="summary-card"
                  className={cn(
                    'rounded-xl border bg-muted/20 transition-shadow',
                    summaryHighlight ? 'ring-2 ring-primary/60 shadow-md' : ''
                  )}
                >
                  <button
                    type="button"
                    data-testid="summary-card-toggle"
                    aria-expanded={summaryOpen}
                    onClick={() => setSummaryOpen((value) => !value)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        上下文摘要 · 覆盖 {activeSummaryCount} 条消息
                        {activeSummarySaved > 0 ? ` / 节省 ${activeSummarySaved.toLocaleString('en-US')} 字符` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      {summaryOpen ? '收起摘要' : '展开摘要'}
                      <ChevronDown className={cn('h-3 w-3 transition-transform', summaryOpen && 'rotate-180')} />
                    </span>
                  </button>
                  {summaryOpen ? (
                    <div className="space-y-2 border-t px-3 py-2" data-testid="summary-card-body">
                      <pre
                        data-testid="summary-card-text"
                        className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed select-all"
                      >
                        {activeSummaryText}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        <CopyButton value={activeSummaryText} size="sm" variant="outline" label="复制摘要" />
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="edit-summary-button"
                          onClick={() => {
                            setSummaryEditText(activeSummaryText);
                            setSummaryEditOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          编辑摘要
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          data-testid="clear-summary-button"
                          onClick={() => setSummaryClearOpen(true)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          清除压缩
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>;

  return (
    <div>
      <PageHeader title="连接测试" description="会话式连续对话：多轮上下文由服务端保存，刷新后历史仍在" />

      {error ? <ErrorBanner message={error} onRetry={() => void loadSessions()} /> : null}

      <div className="flex h-[calc(100vh-230px)] min-h-[560px] gap-3">
        <Card className="hidden w-64 shrink-0 flex-col overflow-hidden md:flex">
          <SessionsPanel
            sessions={sessions}
            activeId={activeId}
            loading={sessionsLoading}
            streamingSessions={streamingSessions}
            onSelect={selectSession}
            onCreate={() => void createSession()}
            onRename={openRename}
            onDelete={setDeleteTarget}
            selected={selectedSessions}
            onToggleSelect={toggleSessionSelected}
            onToggleSelectAll={toggleSelectAllSessions}
            onBulkDelete={() => setBulkDeleteOpen(true)}
            className="min-h-0 flex-1"
          />
        </Card>

        <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 md:hidden"
              aria-label="会话列表"
              onClick={() => setMobileSessionsOpen(true)}
            >
              <MessagesSquare className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{activeId ? activeTitle : '未选择会话'}</div>
              {activeId ? (
                <div className="mt-0.5 flex min-w-0 items-center gap-1" data-testid="active-session-id">
                  <span className="shrink-0 text-[10px] text-muted-foreground">会话 ID</span>
                  <span className="truncate font-mono text-[10px] text-foreground/80" title={activeId}>
                    {activeId}
                  </span>
                  <CopyButton value={activeId} size="sm" variant="ghost" />
                </div>
              ) : null}
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                {activeId ? (
                  <>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {activeSession?.model ?? model}
                    </Badge>
                    <Badge variant="muted" className="text-[10px]">
                      reasoning {activeSession?.reasoningEffort ?? reasoning}
                    </Badge>
                    {activeSession?.webSearch ? <Badge variant="info" className="text-[10px]">联网</Badge> : null}
                    {activeSummaryCount > 0 ? (
                      <button
                        type="button"
                        data-testid="summary-badge"
                        className="inline-flex items-center gap-0.5 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/10"
                        title="展开对话中压缩位置的上下文摘要折叠块"
                        onClick={focusSummaryCard}
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        已压缩 · 覆盖 {activeSummaryCount} 条
                        <span className="ml-0.5 underline">展开</span>
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            {activeId ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="compact-session"
                  className="h-7 gap-1 text-xs"
                  disabled={activeStreaming || compacting}
                  onClick={() => compactSession()}
                >
                  {compacting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  压缩会话
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="会话操作">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openRename(activeSession)}>
                      <Pencil className="h-3.5 w-3.5" />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setDeleteTarget(activeSession)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除会话
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-3 py-4 sm:px-4">
              {summaryAnchorIndex === 0 ? summaryCard : null}
              {messagesLoading && messages.length === 0 ? (
                <div className="space-y-3">
                  <Skeleton className="ml-auto h-16 w-2/3 rounded-2xl" />
                  <Skeleton className="h-24 w-4/5 rounded-2xl" />
                </div>
              ) : messages.length === 0 && !draft ? (
                <EmptyState
                  icon={MessageSquarePlus}
                  title={activeId ? '开始这段对话' : '新建一个会话'}
                  description={
                    activeId
                      ? '在底部输入框输入内容并发送；服务端会保存多轮历史。'
                      : '点击左上角「+」新建会话，或直接在底部输入框发送消息（会自动创建）。'
                  }
                  action={
                    activeId ? undefined : (
                      <Button size="sm" onClick={() => void createSession()}>
                        <Plus className="h-3.5 w-3.5" />
                        新建会话
                      </Button>
                    )
                  }
                />
              ) : (
                <>
                  {messages.map((message, index) => (
                    <Fragment key={message.id}>
                      <ChatMessageBubble
                        message={message}
                        retrying={retryingId === message.id}
                        retryDisabled={activeStreaming}
                        onRetry={(target) => void retryMessage(target)}
                      />
                      {summaryAnchorIndex > 0 && index === summaryAnchorIndex - 1 ? summaryCard : null}
                    </Fragment>
                  ))}
                  {summaryAnchorIndex > messages.length ? summaryCard : null}
                  {draft ? <ChatMessageBubble message={draft} streaming /> : null}
                </>
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          <div className="border-t bg-card p-3">
            <div className="rounded-xl border bg-background focus-within:ring-1 focus-within:ring-ring">
              <Textarea
                value={input}
                rows={2}
                placeholder={
                  activeId
                    ? '输入消息，Enter 发送，Shift + Enter 换行'
                    : '输入消息并发送；若未选择会话会自动新建'
                }
                className="min-h-[64px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                disabled={activeStreaming}
              />
              <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
                <Select
                  value={model}
                  onValueChange={(value) => {
                    setModel(value);
                    patchSessionSettings({ model: value });
                  }}
                  disabled={activeStreaming}
                >
                  <SelectTrigger className="h-8 w-[170px] text-xs">
                    <span className="truncate">
                      {selectedModelInfo?.display_name || selectedModelInfo?.name || model || '选择模型'}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="min-w-[340px] max-w-[420px]">{modelOptions}</SelectContent>
                </Select>

                <Select
                  value={reasoning}
                  onValueChange={(value) => {
                    setReasoning(value);
                    patchSessionSettings({ reasoningEffort: value });
                  }}
                  disabled={activeStreaming || reasoningOptions.length <= 1}
                >
                  <SelectTrigger className="h-8 w-[104px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reasoningOptions.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant={webSearch ? 'default' : 'outline'}
                      className="h-8 gap-1 px-2 text-xs"
                      disabled={activeStreaming}
                      onClick={() => {
                        const next = !webSearch;
                        setWebSearch(next);
                        patchSessionSettings({ webSearch: next });
                      }}
                    >
                      <Globe2 className="h-3.5 w-3.5" />
                      联网
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>允许模型联网搜索（web_search 工具）</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant={imageGeneration ? 'default' : 'outline'}
                      className="h-8 gap-1 px-2 text-xs"
                      disabled={activeStreaming}
                      onClick={() => {
                        const next = !imageGeneration;
                        setImageGeneration(next);
                        patchSessionSettings({ imageGeneration: next });
                      }}
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      图片
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>允许模型生成图片（image_generation 工具）</TooltipContent>
                </Tooltip>

                {currentLocked ? (
                  <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    付费模型已禁用
                  </span>
                ) : null}

                <div className="ml-auto flex items-center gap-1.5">
                  <span className="hidden text-[10px] text-muted-foreground sm:inline">
                    {activeStreaming ? '生成中…' : 'Enter 发送'}
                  </span>
                  {activeStreaming ? (
                    <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={stop}>
                      <Square className="h-3 w-3" />
                      停止
                    </Button>
                  ) : (
                    <Button size="sm" className="h-8 gap-1 px-3 text-xs" disabled={!canSend} onClick={() => void send()}>
                      {currentLocked ? <AlertTriangle className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                      发送
                    </Button>
                  )}
                </div>
              </div>
              {selectedModelInfo ? (
                <div className="flex flex-wrap items-center gap-2 px-2.5 pb-1">
                  <ModelContextLine model={selectedModelInfo} />
                  <ModelCompactionBadge model={selectedModelInfo} />
                </div>
              ) : null}
              {!allowPaidModels && paidModels.length > 0 ? (
                <p className="flex items-center gap-1 border-t px-2.5 py-1 text-[10px] text-muted-foreground">
                  <Lock className="h-3 w-3 shrink-0" />
                  付费模型需 Duck.ai Plus/Pro 订阅；在「设置」开启 allowPaidModels 后可尝试。
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      {/* 移动端会话抽屉 */}
      {mobileSessionsOpen ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMobileSessionsOpen(false)} />
          <div className="relative z-10 flex h-full w-72 flex-col bg-card shadow-xl">
            <SessionsPanel
              sessions={sessions}
              activeId={activeId}
              loading={sessionsLoading}
              streamingSessions={streamingSessions}
              onSelect={selectSession}
              onCreate={() => void createSession()}
              onRename={openRename}
              onDelete={setDeleteTarget}
              className="min-h-0 flex-1"
            />
            <div className="border-t p-2">
              <Button variant="outline" className="w-full" size="sm" onClick={() => setMobileSessionsOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => (!open ? setRenameTarget(null) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>标题显示在左侧会话列表，便于区分不同测试场景。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="session-title">会话标题</Label>
            <Input
              id="session-title"
              value={renameValue}
              maxLength={60}
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void renameSession();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void renameSession()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => (!open ? setBulkDeleteOpen(false) : null)}
        title={`批量删除 ${Object.values(selectedSessions).filter(Boolean).length} 个会话？`}
        description="将删除所选会话及其全部消息，此操作不可撤销。"
        confirmText="批量删除"
        destructive
        onConfirm={() => void bulkDeleteSelected()}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : null)}
        title="删除会话？"
        description={`将删除「${deleteTarget?.title ?? ''}」及其全部消息，此操作不可撤销。`}
        confirmText="删除"
        destructive
        onConfirm={deleteSession}
      />

      <Dialog open={summaryEditOpen} onOpenChange={(open) => (summarySaving ? null : setSummaryEditOpen(open))}>
        <DialogContent className="max-w-lg" data-testid="summary-edit-dialog">
          <DialogHeader>
            <DialogTitle>编辑摘要</DialogTitle>
            <DialogDescription>
              修改后将作为上下文摘要发送给上游（覆盖 {activeSummaryCount} 条消息）。摘要为空不可保存。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid="summary-edit-textarea"
            rows={8}
            value={summaryEditText}
            maxLength={20000}
            className="font-mono text-xs"
            onChange={(event) => setSummaryEditText(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSummaryEditOpen(false)} disabled={summarySaving}>
              取消
            </Button>
            <Button
              onClick={saveSummaryEdit}
              disabled={summarySaving || !summaryEditText.trim()}
              data-testid="summary-edit-save"
            >
              {summarySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存摘要
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={summaryClearOpen}
        onOpenChange={(open) => (!open ? setSummaryClearOpen(false) : null)}
        title="清除压缩并恢复完整消息？"
        description="将删除当前摘要（DELETE /summary），后续请求会重新携带完整历史；消息本身不会被删除。"
        confirmText="清除压缩"
        destructive
        onConfirm={clearCompaction}
      />
    </div>
  );
}
