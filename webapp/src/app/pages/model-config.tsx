import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';

import { apiGet, apiPost, apiPut, ApiError } from '@/app/lib/api';
import { formatNumber } from '@/app/lib/format';
import type { ModelConfigResponse, ModelConfigItem } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';

type FieldKey = 'context_window_chars' | 'max_input_chars' | 'max_output_tokens';
type Draft = Partial<Record<FieldKey | 'session_limit_behavior', string>>;
type DraftMap = Record<string, Draft>;
/** 每模型工具开关（只允许上游支持的 tool）。 */
type ToolDraftMap = Record<string, Record<string, boolean>>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TOOL_LABELS: Record<string, string> = { web_search: '联网搜索', image_generation: '图片生成' };

const FIELD_META: Array<{ key: FieldKey; label: string; shortLabel: string; unit: string; hint: string }> = [
  {
    key: 'context_window_chars',
    label: '上下文窗口',
    shortLabel: '上下文窗口',
    unit: '字符',
    hint: '整段会话可用上下文（默认 20,000，duck.ai 实测边界）'
  },
  {
    key: 'max_input_chars',
    label: '单条输入上限',
    shortLabel: '单条输入',
    unit: '字符',
    hint: '单条消息上限（实测 19,500 通过 / 19,600 被拒）'
  },
  {
    key: 'max_output_tokens',
    label: '输出上限',
    shortLabel: '输出上限',
    unit: 'tokens',
    hint: '估算值（观测输出下界 4,335–6,427 字符）'
  }
];

const QUICK_PRESETS = [
  { value: 'default', label: 'duck.ai 默认' },
  { value: 'max', label: 'duck.ai 实测上限' },
  { value: 'custom', label: '自定义' }
] as const;

/** 「duck.ai 实测上限」预设：上下文/输入用实测值，输出取 8,192（默认估算的 2 倍）。 */
const MAX_PRESET: Required<Pick<Draft, FieldKey>> = {
  context_window_chars: '20000',
  max_input_chars: '19500',
  max_output_tokens: '8192'
};

const AUTOSAVE_DELAY_MS = 700;

function draftFromItem(item: ModelConfigItem): Draft {
  if (!item.override) return {};
  return {
    ...(item.override.context_window_chars !== undefined
      ? { context_window_chars: String(item.override.context_window_chars) }
      : {}),
    ...(item.override.max_input_chars !== undefined
      ? { max_input_chars: String(item.override.max_input_chars) }
      : {}),
    ...(item.override.max_output_tokens !== undefined
      ? { max_output_tokens: String(item.override.max_output_tokens) }
      : {}),
    ...(item.override.session_limit_behavior
      ? { session_limit_behavior: item.override.session_limit_behavior }
      : {})
  };
}

function draftToOverride(draft: Draft | undefined): Record<string, number | string> | null {
  if (!draft) return null;
  const out: Record<string, number | string> = {};
  for (const key of ['context_window_chars', 'max_input_chars', 'max_output_tokens'] as FieldKey[]) {
    const raw = draft[key];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) out[key] = Math.trunc(value);
  }
  if (draft.session_limit_behavior === 'new_chat' || draft.session_limit_behavior === 'summarize_and_continue') {
    out.session_limit_behavior = draft.session_limit_behavior;
  }
  return Object.keys(out).length ? out : null;
}

function hasDraft(draft: Draft | undefined): boolean {
  return Boolean(draft) && Object.values(draft || {}).some((value) => value !== undefined && value !== '');
}

/** 由页面上所有可编辑状态构造 PUT payload（自动保存与签名比对共用）。 */
function buildPayload(
  items: ModelConfigItem[],
  drafts: DraftMap,
  toolDrafts: ToolDraftMap,
  dropTools: boolean
) {
  const overrides: Record<string, Record<string, number | string> | null> = {};
  for (const item of items) {
    overrides[item.id] = draftToOverride(drafts[item.id]);
  }
  // 工具只保存「关闭」覆盖，避免把全量默认值写进 config。
  const toolPayload: Record<string, Record<string, boolean>> = {};
  for (const [modelId, entry] of Object.entries(toolDrafts)) {
    const disabled: Record<string, boolean> = {};
    for (const [tool, enabled] of Object.entries(entry)) {
      if (enabled === false) disabled[tool] = false;
    }
    if (Object.keys(disabled).length) toolPayload[modelId] = disabled;
  }
  return { overrides, tools: { dropUnsupported: dropTools, perModel: toolPayload } };
}

export function ModelConfigPage() {
  const [data, setData] = useState<ModelConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [toolDrafts, setToolDrafts] = useState<ToolDraftMap>({});
  // v2.23：静默清理开关（默认开启=丢弃不可用 tool；关闭=报错 400）
  const [dropTools, setDropTools] = useState(true);
  const [presets, setPresets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshInfo, setRefreshInfo] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // v2.28：从「设置」页迁移过来的默认模型 / 超时 / 付费开关（独立于按模型覆盖，防抖自动保存）
  const [runtime, setRuntime] = useState<{
    defaultModel: string;
    timeoutMs: string;
    allowPaidModels: boolean;
  } | null>(null);
  const [runtimeSaveState, setRuntimeSaveState] = useState<SaveState>('idle');
  const runtimeSavedSignature = useRef<string | null>(null);
  const runtimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 自动保存：签名比对避免初次加载/回填触发保存，防止保存后循环。
  const savedSignature = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSignature = useRef<string | null>(null);

  const items = useMemo(() => data?.items || [], [data]);

  const hydrate = useCallback((response: ModelConfigResponse) => {
    setData(response);
    const nextDrafts: DraftMap = {};
    for (const item of response.items || []) {
      const draft = draftFromItem(item);
      if (hasDraft(draft)) nextDrafts[item.id] = draft;
    }
    setDrafts(nextDrafts);
    const nextTools: ToolDraftMap = {};
    for (const item of response.items || []) {
      const entry: Record<string, boolean> = {};
      for (const tool of item.tools || []) {
        if (!tool.supported) continue;
        entry[tool.name] = tool.enabled;
      }
      if (Object.keys(entry).length) nextTools[item.id] = entry;
    }
    setToolDrafts(nextTools);
    const nextDrop = response.drop_unsupported_tool !== false;
    setDropTools(nextDrop);
    setPresets({});
    savedSignature.current = JSON.stringify(buildPayload(response.items || [], nextDrafts, nextTools, nextDrop));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ModelConfigResponse>('/models/config');
      hydrate(response);
      // v2.28：同时读取运行配置里的 duck.defaultModel / timeoutMs / allowPaidModels
      try {
        const configResponse = await apiGet<{ config?: { duck?: Record<string, unknown> } }>('/config');
        const duck = configResponse?.config?.duck || {};
        const next = {
          defaultModel: typeof duck.defaultModel === 'string' ? duck.defaultModel : 'gpt-6-luna',
          timeoutMs: String(duck.timeoutMs ?? 120000),
          allowPaidModels: duck.allowPaidModels === true
        };
        setRuntime(next);
        runtimeSavedSignature.current = JSON.stringify(next);
      } catch (configError) {
        if ((configError as ApiError)?.handled) return;
        /* 运行配置读取失败不阻塞按模型配置 */
      }
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载模型配置失败');
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  const payload = useMemo(
    () => buildPayload(items, drafts, toolDrafts, dropTools),
    [items, drafts, toolDrafts, dropTools]
  );
  const signature = useMemo(() => JSON.stringify(payload), [payload]);

  const persist = useCallback(
    async (nextSignature: string) => {
      setSaveState('saving');
      try {
        const response = await apiPut<ModelConfigResponse>('/models/config', payload);
        savedSignature.current = nextSignature;
        setData(response);
        setSaveState('saved');
        setSavedAt(new Date().toLocaleTimeString('zh-CN'));
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        setSaveState('error');
        toast.error((err as Error)?.message || '自动保存失败');
      }
    },
    [payload]
  );

  // 防抖自动保存
  useEffect(() => {
    if (loading) return;
    if (savedSignature.current === null) return;
    if (signature === savedSignature.current) return;
    if (pendingSignature.current === signature) return;
    pendingSignature.current = signature;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pendingSignature.current = null;
      void persist(signature);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [signature, loading, persist]);

  /** v2.28：默认模型 / 超时 / 付费开关的防抖自动保存（走 PUT /admin/api/config）。 */
  const runtimeSignature = useMemo(() => (runtime ? JSON.stringify(runtime) : null), [runtime]);

  const persistRuntime = useCallback(async (next: { defaultModel: string; timeoutMs: string; allowPaidModels: boolean }) => {
    const timeoutMs = Number(next.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
      setRuntimeSaveState('error');
      toast.error('请求超时需为 1000 – 600000 毫秒的整数');
      return;
    }
    setRuntimeSaveState('saving');
    try {
      await apiPut('/config', {
        duck: { defaultModel: next.defaultModel, timeoutMs, allowPaidModels: next.allowPaidModels }
      });
      runtimeSavedSignature.current = JSON.stringify(next);
      setRuntimeSaveState('saved');
      toast.success('运行配置已保存');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setRuntimeSaveState('error');
      toast.error((err as Error)?.message || '运行配置保存失败');
    }
  }, []);

  useEffect(() => {
    if (!runtime || loading) return;
    if (runtimeSavedSignature.current === null) return;
    if (runtimeSignature === runtimeSavedSignature.current) return;
    if (runtimeTimer.current) clearTimeout(runtimeTimer.current);
    runtimeTimer.current = setTimeout(() => {
      runtimeTimer.current = null;
      void persistRuntime(runtime);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (runtimeTimer.current) {
        clearTimeout(runtimeTimer.current);
        runtimeTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeSignature, loading, persistRuntime]);

  const patchDraft = (id: string, patch: Draft) => {    setDrafts((previous) => {
      const merged = { ...(previous[id] || {}), ...patch };
      const next = { ...previous };
      if (hasDraft(merged)) next[id] = merged;
      else delete next[id];
      return next;
    });
  };

  /** 单个参数重置为默认（删除该字段的覆盖）。 */
  const resetField = (modelId: string, field: FieldKey) => {
    setDrafts((previous) => {
      const current = previous[modelId];
      if (!current) return previous;
      const nextDraft: Draft = { ...current };
      delete nextDraft[field];
      const next = { ...previous };
      if (hasDraft(nextDraft)) next[modelId] = nextDraft;
      else delete next[modelId];
      return next;
    });
  };

  const applyPreset = (item: ModelConfigItem, preset: string) => {
    setPresets((previous) => ({ ...previous, [item.id]: preset }));
    if (preset === 'default') {
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[item.id];
        return next;
      });
      return;
    }
    if (preset === 'max') {
      patchDraft(item.id, { ...MAX_PRESET, session_limit_behavior: '' });
    }
  };

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const result = await apiPost<{
        ok: boolean;
        catalogSource: string;
        modelCount: number;
        capabilities: unknown;
        upstreamVersion?: string | null;
        probedAt: number;
        error?: string | null;
      }>('/models/refresh');
      const flags =
        result?.capabilities && typeof result.capabilities === 'object'
          ? Object.keys((result.capabilities as Record<string, unknown>).assignments || {}).length
          : 0;
      const time = new Date(result?.probedAt || Date.now()).toLocaleTimeString('zh-CN');
      setRefreshInfo(
        `已刷新上游能力快照（${time}）· 模型目录：${result?.modelCount ?? '-'} 个（内置静态表）· flags ${flags} 个` +
          (result?.error ? ` · 上游探测失败：${result.error}` : '')
      );
      toast.success('已刷新上游能力快照');
      await load();
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const resetAll = async () => {
    setResetting(true);
    try {
      const response = await apiPost<ModelConfigResponse>('/models/config/reset');
      hydrate(response);
      toast.success('已重置全部模型配置为默认值');
      setResetOpen(false);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '重置失败');
    } finally {
      setResetting(false);
    }
  };

  const overrideCount = useMemo(() => Object.values(drafts).filter((draft) => hasDraft(draft)).length, [drafts]);
  const toolOverrideCount = useMemo(
    () =>
      Object.values(toolDrafts).filter((entry) => Object.values(entry).some((enabled) => enabled === false)).length,
    [toolDrafts]
  );

  const modelBadges = (item: ModelConfigItem) => (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs">{item.id}</span>
      <Badge variant={item.paid ? 'warning' : 'outline'} className="text-[10px]">
        {item.tier}
      </Badge>
      <Badge variant={item.compaction_supported ? 'success' : 'secondary'} className="text-[10px]">
        {item.compaction_supported ? '自动压缩' : '不压缩'}
      </Badge>
    </div>
  );

  const saveIndicator = () => {
    if (saveState === 'saving') {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="model-config-autosave">
          <Loader2 className="h-3 w-3 animate-spin" />
          保存中…
        </span>
      );
    }
    if (saveState === 'error') {
      return (
        <span className="flex items-center gap-1 text-xs text-destructive" data-testid="model-config-autosave">
          <AlertTriangle className="h-3 w-3" />
          保存失败
        </span>
      );
    }
    if (saveState === 'saved' || savedAt) {
      return (
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid="model-config-autosave">
          <Check className="h-3 w-3" />
          已自动保存{savedAt ? ` · ${savedAt}` : ''}
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground" data-testid="model-config-autosave">
        修改后自动保存
      </span>
    );
  };

  return (
    <div>
      <PageHeader
        title="模型配置"
        description="按模型自定义上下文窗口 / 单条输入 / 输出上限与工具开关；默认值来自 duck.ai 真实实测（见 docs/CONTEXT-TOKENS.md）"
        actions={saveIndicator()}
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="mb-4 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        默认值：上下文 {formatNumber(data?.defaults?.context_window_chars ?? 20000)} 字符 · 单条输入{' '}
        {formatNumber(data?.defaults?.max_input_chars ?? 19500)} 字符 · 输出{' '}
        {formatNumber(data?.defaults?.max_output_tokens ?? 4096)} tokens（估算）。达到会话上限时网关返回 409
        <code className="mx-1 rounded bg-muted px-1">conversation_limit_reached</code>
        ——请新建会话，或由客户端调用
        <code className="mx-1 rounded bg-muted px-1">POST /v1/compact</code>
        压缩后重试；网关不再自动压缩。
      </div>

      {refreshInfo ? (
        <div
          className="mb-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-testid="model-config-refresh-info"
        >
          {refreshInfo}
        </div>
      ) : null}

      {/* v2.28：从「设置」页迁移过来的默认模型 / 超时 / 付费模型开关 */}
      <Card className="mb-4" data-testid="model-config-runtime">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">默认模型与超时</CardTitle>
              <CardDescription className="text-xs">
                默认模型 duck.defaultModel · 请求超时 duck.timeoutMs · 付费模型开关 duck.allowPaidModels（修改后自动保存）
              </CardDescription>
            </div>
            <span className="text-xs text-muted-foreground" data-testid="model-config-runtime-autosave">
              {runtimeSaveState === 'saving'
                ? '保存中…'
                : runtimeSaveState === 'saved'
                  ? '已保存'
                  : runtimeSaveState === 'error'
                    ? '保存失败'
                    : '修改后自动保存'}
            </span>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>默认模型 duck.defaultModel</Label>
            <Select
              value={runtime?.defaultModel || 'gpt-6-luna'}
              onValueChange={(value) =>
                setRuntime((current) => (current ? { ...current, defaultModel: value } : current))
              }
            >
              <SelectTrigger data-testid="model-config-default-model">
                <SelectValue placeholder="选择默认模型" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id} disabled={item.paid && !runtime?.allowPaidModels}>
                    <span className="flex items-center gap-1.5">
                      <span>{item.name || item.id}</span>
                      {item.paid ? (
                        <span className="text-[11px] text-muted-foreground">
                          {runtime?.allowPaidModels ? '付费' : '付费 · 需订阅'}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(() => {
              const defaultItem = items.find((item) => item.id === runtime?.defaultModel);
              return defaultItem?.paid && !runtime?.allowPaidModels ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  当前默认模型为付费模型，但 allowPaidModels 未开启；调用时会返回 403。
                </p>
              ) : null;
            })()}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-config-timeout">请求超时 duck.timeoutMs</Label>
            <Input
              id="model-config-timeout"
              data-testid="model-config-timeout"
              type="number"
              min={1000}
              max={600000}
              step={1000}
              value={runtime?.timeoutMs ?? '120000'}
              onChange={(event) =>
                setRuntime((current) => (current ? { ...current, timeoutMs: event.target.value } : current))
              }
            />
            <p className="text-[11px] text-muted-foreground">毫秒，默认 120000（1000 – 600000）</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label htmlFor="model-config-allow-paid">允许付费模型</Label>
                <p className="text-[11px] text-muted-foreground">
                  关闭时 Plus/Pro 模型一律 403；开启后放行（仍需上游订阅）。
                </p>
              </div>
              <Switch
                id="model-config-allow-paid"
                data-testid="model-config-allow-paid"
                checked={runtime?.allowPaidModels === true}
                onCheckedChange={(checked) =>
                  setRuntime((current) => (current ? { ...current, allowPaidModels: checked } : current))
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">模型覆盖配置</CardTitle>
              <CardDescription className="text-xs">
                共 {items.length} 个模型 · 参数覆盖 {overrideCount} 个 · 工具关闭 {toolOverrideCount} 项 · 留空表示使用
                duck.ai 默认值
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshCatalog()}
              disabled={refreshing || loading}
              data-testid="model-config-refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              刷新上游能力
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && items.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-16 rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={SlidersHorizontal} title="没有可配置的模型" description="请先确认 /admin/api/models 正常返回。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">模型</TableHead>
                  <TableHead className="min-w-[280px]">限制（上下文 / 单条输入 / 输出）</TableHead>
                  <TableHead className="min-w-[150px]">推理等级</TableHead>
                  <TableHead className="min-w-[190px]">工具（仅上游支持项可开关）</TableHead>
                  <TableHead className="w-[170px]">快捷预设</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const draft = drafts[item.id] || {};
                  return (
                    <TableRow key={item.id} data-testid={`model-config-row-${item.id}`}>
                      <TableCell>
                        <div className="font-medium">{item.name}</div>
                        {modelBadges(item)}
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          生效：窗口 {formatNumber(item.effective.context_window_chars)} · 单条{' '}
                          {formatNumber(item.effective.max_input_chars)} · 输出{' '}
                          {formatNumber(item.effective.max_output_tokens)}
                          {item.effective.max_output_tokens_estimated ? '（估算）' : '（自定义）'}
                        </div>
                      </TableCell>
                      {/* v2.29：三个参数合并为一列三行，节省横向空间 */}
                      <TableCell className="align-top">
                        <div className="space-y-1.5" data-testid={`model-limits-${item.id}`}>
                          {FIELD_META.map((field) => {
                            const overridden = draft[field.key] !== undefined && draft[field.key] !== '';
                            return (
                              <div key={field.key} className="flex items-center gap-1.5">
                                <span
                                  className="w-[92px] shrink-0 text-[10px] text-muted-foreground"
                                  title={field.hint}
                                >
                                  {field.shortLabel}
                                  <span className="opacity-60">（{field.unit}）</span>
                                </span>
                                <Input
                                  className="h-7 w-24 text-xs"
                                  inputMode="numeric"
                                  placeholder={String(item.defaults[field.key] ?? '')}
                                  value={draft[field.key] ?? ''}
                                  onChange={(event) => {
                                    const value = event.target.value.replace(/[^0-9]/g, '');
                                    patchDraft(item.id, { [field.key]: value } as Draft);
                                  }}
                                  aria-label={`${item.id}-${field.key}`}
                                  title={`默认 ${formatNumber((data?.defaults as Record<string, number | undefined>)?.[field.key] ?? '')}`}
                                  data-testid={`model-field-${item.id}-${field.key}`}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  disabled={!overridden}
                                  onClick={() => resetField(item.id, field.key)}
                                  aria-label={`重置 ${item.id} 的 ${field.label}`}
                                  title={overridden ? '重置为默认值' : '当前已是默认值'}
                                  data-testid={`model-field-reset-${item.id}-${field.key}`}
                                >
                                  <RotateCcw className="h-3 w-3" />
                                </Button>
                                <span className="text-[10px] text-muted-foreground/60">
                                  默认 {formatNumber((data?.defaults as Record<string, number | undefined>)?.[field.key] ?? '')}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </TableCell>
                      {/* v2.29：该模型可接受的推理等级 */}
                      <TableCell className="align-top">
                        <div className="flex flex-wrap gap-1" data-testid={`model-reasoning-${item.id}`}>
                          {(item.reasoning_efforts || []).length === 0 ? (
                            <span className="text-[11px] text-muted-foreground">不支持推理等级</span>
                          ) : (
                            (item.reasoning_efforts || []).map((effort) => (
                              <Badge key={effort} variant="secondary" className="px-1.5 py-0 text-[10px]">
                                {effort}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1.5" data-testid={`model-tools-${item.id}`}>
                          {(item.tools || []).filter((tool) => tool.supported).length === 0 ? (
                            <span className="text-[11px] text-muted-foreground">上游不支持任何工具</span>
                          ) : (
                            (item.tools || [])
                              .filter((tool) => tool.supported)
                              .map((tool) => {
                                const enabled = toolDrafts[item.id]?.[tool.name] ?? tool.enabled;
                                return (
                                  <label
                                    key={tool.name}
                                    className="flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground"
                                  >
                                    <Switch
                                      checked={enabled}
                                      onCheckedChange={(checked) =>
                                        setToolDrafts((previous) => ({
                                          ...previous,
                                          [item.id]: { ...(previous[item.id] || {}), [tool.name]: checked }
                                        }))
                                      }
                                      aria-label={`${item.id}-${tool.name}-toggle`}
                                      data-testid={`model-tool-${item.id}-${tool.name}`}
                                    />
                                    {TOOL_LABELS[tool.name] || tool.name}
                                    <span className="font-mono text-[10px] opacity-60">{tool.name}</span>
                                  </label>
                                );
                              })
                          )}
                          {(item.tools || []).some((tool) => !tool.supported) ? (
                            <p className="text-[10px] text-muted-foreground/70">
                              不显示：
                              {(item.tools || [])
                                .filter((tool) => !tool.supported)
                                .map((tool) => tool.name)
                                .join(' / ')}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={presets[item.id] || (hasDraft(draft) ? 'custom' : 'default')}
                          onValueChange={(value) => applyPreset(item, value)}
                        >
                          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label={`${item.id}-preset`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {QUICK_PRESETS.map((preset) => (
                              <SelectItem key={preset.value} value={preset.value}>
                                {preset.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          说明：<strong>“duck.ai 实测上限”</strong> 预设采用 20,000 / 19,500 / 8,192（输出为估算）；
          自定义值超出上限会被服务端拒绝并提示。上下文窗口与单条输入的关系为「单条 ≤ 窗口」。
          <span className="block text-muted-foreground">
            修改会写入 <code>config.models</code>，自动保存后立即影响 <code>/v1/models</code> 与后台模型列表。
          </span>
        </div>
      </div>

      <Card className="mt-4 border-destructive/40" data-testid="model-config-danger">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-destructive">危险 / 高级操作</CardTitle>
          <CardDescription className="text-xs">
            不可用工具的处理策略，以及一键重置所有模型配置
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="space-y-1">
              <div className="text-sm font-medium">
                {dropTools ? '静默清理不支持的 tools（已启用）' : '不支持的 tools 直接报错（已关闭静默清理）'}
              </div>
              <p className="text-xs text-muted-foreground">
                {dropTools
                  ? '请求里出现模型不支持 / 被关闭 / 非网关支持的 tool（如 OpenAI function）时，自动丢弃并继续执行（记录到请求日志 droppedTools）。'
                  : '请求里出现不可用 tool 时返回 400：unsupported_tool（类型不支持）/ tool_not_supported（模型不支持或已关闭）/ tool_disabled（服务端关闭）。'}
              </p>
            </div>
            <Switch
              checked={dropTools}
              onCheckedChange={setDropTools}
              aria-label="静默清理不支持的 tools"
              data-testid="drop-unsupported-tool"
            />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              当前已自定义：参数覆盖 {overrideCount} 个模型 · 工具关闭 {toolOverrideCount} 项 ·
              静默清理 {dropTools ? '开启' : '关闭'}
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setResetOpen(true)}
              disabled={resetting || loading}
              data-testid="model-config-reset-all"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置全部模型配置
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="重置全部模型配置？"
        description={
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            所有模型的上下文窗口 / 单条输入 / 输出上限覆盖、工具开关、以及“不支持的 tool 报错”都会恢复默认；
            此操作立即生效且不可撤销。
          </span>
        }
        confirmText={resetting ? '重置中…' : '重置全部'}
        destructive
        onConfirm={resetAll}
      />
    </div>
  );
}
