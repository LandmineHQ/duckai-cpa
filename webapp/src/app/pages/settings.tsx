import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPost, apiPut, ApiError } from '@/app/lib/api';
import { formatDateTime } from '@/app/lib/format';
import type { Config, ConfigResponse, UpdateConfigResponse } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface FormState {
  rps: string;
  maxConcurrent: string;
  queueLimit: string;
  queueTimeoutMs: string;
  systemPrompt: string;
  promptMode: 'inline' | 'system';
  promptSource: 'duckai' | 'custom' | 'none';
  duckai: {
    tone: string;
    length: string;
    assistantRole: string;
    userRole: string;
    shouldSeekClarity: boolean;
    userName: string;
    assistantName: string;
    additionalInstructions: string;
  };
  webSearch: boolean;
  imageGeneration: boolean;
  /** v2.36：允许上游使用「大致位置」（user-location），默认关闭 */
  location: boolean;
  /** v2.44：客户端工具桥（Codex/DSH 文件工具） */
  clientFunctionCalling: boolean;
  logLevel: string;
}

const DEFAULT_FORM: FormState = {
  rps: '1',
  maxConcurrent: '1',
  queueLimit: '50',
  queueTimeoutMs: '300000',
  systemPrompt: '',
  promptMode: 'inline',
  promptSource: 'custom',
  duckai: {
    tone: 'Default',
    length: 'Default',
    assistantRole: 'Default',
    userRole: 'Default',
    shouldSeekClarity: false,
    userName: '',
    assistantName: '',
    additionalInstructions: ''
  },
  webSearch: true,
  imageGeneration: true,
  location: false,
  clientFunctionCalling: true,
  logLevel: 'info'
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** v2.28：每张卡片的保存提示文案 */
const CARD_LABELS: Record<'queue' | 'prompts' | 'tools' | 'logging', string> = {
  queue: '队列配置',
  prompts: '提示词配置',
  tools: '工具配置',
  logging: '日志配置'
};

/** duck.ai 源码里的 assistant / user role 选项（与后端 duckai-roles.json 对齐）。 */
const ASSISTANT_ROLES = [
  'Default',
  'Brainstorm partner',
  'Career coach',
  'Coding coach',
  'Editor',
  'Entertainment guide',
  'Gardener',
  'Chef',
  'Fitness trainer',
  'Homework helper',
  'Language tutor',
  'Life coach',
  'Marketer',
  'Product manager',
  'Public speaking coach',
  'Social media copywriter',
  'Storyteller',
  'Summarizer',
  'Tech support specialist',
  'Teacher',
  'Translator',
  'Travel guide',
  'Trivia expert',
  'Writer'
];

const USER_ROLES = ['Default', 'Parent', 'Professional', 'Programmer', 'Student', 'Writer'];

function formFromConfig(config: Config, _fallbackModel?: string): FormState {
  return {
    rps: String(config.upstream?.rps ?? 1),
    maxConcurrent: String(config.upstream?.maxConcurrent ?? 1),
    queueLimit: String(config.upstream?.queueLimit ?? 50),
    queueTimeoutMs: String(config.upstream?.queueTimeoutMs ?? 300000),
    systemPrompt: config.prompts?.defaultSystemPrompt ?? '',
    promptMode: config.prompts?.mode === 'system' ? 'system' : 'inline',
    promptSource:
      config.prompts?.source === 'custom' || config.prompts?.source === 'none'
        ? config.prompts.source
        : 'duckai',
    duckai: {
      tone: config.prompts?.duckai?.tone || 'Default',
      length: config.prompts?.duckai?.length || 'Default',
      assistantRole: config.prompts?.duckai?.assistantRole || 'Default',
      userRole: config.prompts?.duckai?.userRole || 'Default',
      shouldSeekClarity: config.prompts?.duckai?.shouldSeekClarity === true,
      userName: config.prompts?.duckai?.userName || '',
      assistantName: config.prompts?.duckai?.assistantName || '',
      additionalInstructions: config.prompts?.duckai?.additionalInstructions || ''
    },
    webSearch: config.tools?.webSearch !== false,
    imageGeneration: config.tools?.imageGeneration !== false,
    location: config.tools?.location === true,
    clientFunctionCalling: config.tools?.clientFunctionCalling?.enabled !== false,
    logLevel: config.logging?.level || 'info'
  };
}

type FieldErrors = Partial<Record<'rps' | 'maxConcurrent' | 'queueLimit' | 'queueTimeoutMs', string>>;

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  const rps = Number(form.rps);
  if (!Number.isFinite(rps) || rps < 0.2 || rps > 20) errors.rps = '范围 0.2 – 20（可填 0.1 的倍数）';
  const maxConcurrent = Number(form.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) {
    errors.maxConcurrent = '范围 1 – 10 的整数';
  }
  const queueLimit = Number(form.queueLimit);
  if (!Number.isInteger(queueLimit) || queueLimit < 1 || queueLimit > 1000) {
    errors.queueLimit = '范围 1 – 1000 的整数';
  }
  const queueTimeoutMs = Number(form.queueTimeoutMs);
  if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1000 || queueTimeoutMs > 3_600_000) {
    errors.queueTimeoutMs = '范围 1000 – 3600000 毫秒';
  }
  return errors;
}

export function SettingsPage() {
  // v2.28：不再订阅 /overview 轮询——此前 overviewModels 每 5 秒换新数组，
  // 导致 load() 的 useCallback 依赖变化 → useEffect 重新执行 → setLoading(true) → 页面抖动。
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // v2.28：每张卡片独立保存（保存后只提示该卡片）
  const [savingCard, setSavingCard] = useState<string | null>(null);
  // duck.ai 提示词生成器选项 + 预览
  const [promptOptions, setPromptOptions] = useState<{
    tones: Array<{ id: string; prompt: string }>;
    lengths: Array<{ id: string; prompt: string }>;
    clarify_prompt: string;
    assistant_roles: Array<{ id: string }>;
    user_roles: Array<{ id: string }>;
  } | null>(null);
  const [promptPreview, setPromptPreview] = useState('');
  const [promptPreviewError, setPromptPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ConfigResponse>('/config');
      const config = response?.config ?? {};
      setForm(formFromConfig(config));
      setLoadedAt(Date.now());
      setFieldErrors({});
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (values: Partial<FormState>) => setForm((current) => ({ ...current, ...values }));

  /** 按卡片保存：只提交该卡片负责的配置段。 */
  const saveCard = async (card: 'queue' | 'prompts' | 'tools' | 'logging') => {
    const errors = validate(form);
    setFieldErrors(errors);
    if (errors.rps || errors.maxConcurrent || errors.queueLimit || errors.queueTimeoutMs) {
      if (card === 'queue') {
        toast.error('请先修正队列参数');
        return;
      }
    }
    setSavingCard(card);
    setSaving(true);
    setNotice(null);
    try {
      const body: Record<string, unknown> =
        card === 'queue'
          ? {
              upstream: {
                rps: Number(form.rps),
                maxConcurrent: Number(form.maxConcurrent),
                queueLimit: Number(form.queueLimit),
                queueTimeoutMs: Number(form.queueTimeoutMs)
              }
            }
          : card === 'prompts'
            ? {
                prompts: {
                  defaultSystemPrompt: form.systemPrompt,
                  mode: form.promptMode,
                  source: form.promptSource,
                  duckai: form.duckai
                }
              }
            : card === 'tools'
              ? {
                  tools: {
                    webSearch: form.webSearch,
                    imageGeneration: form.imageGeneration,
                    location: form.location,
                    clientFunctionCalling: { enabled: form.clientFunctionCalling }
                  }
                }
              : { logging: { level: form.logLevel } };
      const response = await apiPut<UpdateConfigResponse>('/config', body);
      if (response?.config) setForm(formFromConfig(response.config));
      setLoadedAt(Date.now());
      const ignored = response?.ignored ?? [];
      const label = CARD_LABELS[card];
      if (response?.restartRequired) {
        setNotice({ tone: 'warning', text: `${label}已保存，但部分改动需要重启服务后生效。` });
        toast.warning(`${label}已保存，部分改动需重启生效`);
      } else {
        toast.success(`${label}已保存并实时生效`);
      }
      if (ignored.length > 0) {
        toast.warning(`以下字段被忽略：${ignored.join('、')}`, { duration: 6000 });
      }
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '保存配置失败');
      toast.error('保存配置失败');
    } finally {
      setSavingCard(null);
      setSaving(false);
    }
  };

  const savingFor = (card: string) => savingCard === card;

  /** 加载 duck.ai 提示词选项（tones/lengths/roles）。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const options = await apiGet<NonNullable<typeof promptOptions>>('/prompts/duckai');
        if (!cancelled) setPromptOptions(options);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        if (!cancelled) setPromptOptions(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 生成预览（防抖）：由服务端按源码逻辑拼装，保证与真正注入的文本一致。 */
  const promptSignature = JSON.stringify({
    source: form.promptSource,
    custom: form.systemPrompt,
    duckai: form.duckai
  });
  useEffect(() => {
    if (form.promptSource === 'none') {
      setPromptPreview('');
      setPromptPreviewError(null);
      return;
    }
    if (form.promptSource === 'custom') {
      setPromptPreview(form.systemPrompt.trim());
      setPromptPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await apiPost<{ prompt: string }>('/prompts/duckai/preview', {
            customization: form.duckai
          });
          if (!cancelled) {
            setPromptPreview(result?.prompt || '');
            setPromptPreviewError(null);
          }
        } catch (err) {
          if ((err as ApiError)?.handled) return;
          if (!cancelled) setPromptPreviewError((err as Error)?.message || '生成预览失败');
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptSignature]);

  const patchDuckai = (values: Partial<FormState['duckai']>) =>
    setForm((current) => ({ ...current, duckai: { ...current.duckai, ...values } }));

  return (
    <div>
      <PageHeader
        title="设置"
        description="队列、提示词、工具与日志配置（保存后实时生效；默认模型/超时/付费模型已移到「模型配置」页）"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {notice ? (
        <div
          className={
            notice.tone === 'warning'
              ? 'mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'
              : 'mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300'
          }
        >
          {notice.tone === 'warning' ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {notice.text}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">上游请求队列（RPS）</CardTitle>
              <CardDescription className="text-xs">
                所有上游调用统一 FIFO 排队；默认 rps=1 表示同时只执行 1 个请求，其余排队。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-rps">每秒请求数 rps</Label>
                  <Input
                    id="settings-rps"
                    type="number"
                    min={0.2}
                    max={20}
                    step={0.1}
                    value={form.rps}
                    onChange={(event) => patch({ rps: event.target.value })}
                  />
                  {fieldErrors.rps ? <p className="text-xs text-destructive">{fieldErrors.rps}</p> : null}
                  <p className="text-[11px] text-muted-foreground">0.2 – 20，step 0.1，默认 1</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-max-concurrent">同时执行上限 maxConcurrent</Label>
                  <Input
                    id="settings-max-concurrent"
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={form.maxConcurrent}
                    onChange={(event) => patch({ maxConcurrent: event.target.value })}
                  />
                  {fieldErrors.maxConcurrent ? (
                    <p className="text-xs text-destructive">{fieldErrors.maxConcurrent}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">1 – 10，默认 1</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-queue-limit">队列上限 queueLimit</Label>
                  <Input
                    id="settings-queue-limit"
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    value={form.queueLimit}
                    onChange={(event) => patch({ queueLimit: event.target.value })}
                  />
                  {fieldErrors.queueLimit ? (
                    <p className="text-xs text-destructive">{fieldErrors.queueLimit}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">1 – 1000，超出后新请求返回 429 queue_full</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-queue-timeout">排队超时 queueTimeoutMs</Label>
                  <Input
                    id="settings-queue-timeout"
                    type="number"
                    min={1000}
                    max={3600000}
                    step={1000}
                    value={form.queueTimeoutMs}
                    onChange={(event) => patch({ queueTimeoutMs: event.target.value })}
                  />
                  {fieldErrors.queueTimeoutMs ? (
                    <p className="text-xs text-destructive">{fieldErrors.queueTimeoutMs}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">毫秒，默认 300000（5 分钟）</p>
                  )}
                </div>
              </div>
            </CardContent>
            <CardFooter className="justify-end pt-0">
              <Button size="sm" onClick={() => void saveCard('queue')} disabled={loading || saving} data-testid="settings-save-queue">
                {savingFor('queue') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存队列配置
              </Button>
            </CardFooter>
          </Card>

          <Card className="lg:col-span-2" data-testid="settings-prompts-card">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">提示词 prompts</CardTitle>
              <CardDescription className="text-xs">
                按 duck.ai 源码逻辑生成默认提示词，或使用完全自定义的系统提示词。匿名 duck.ai 不接受 system 角色，
                默认用 inline（以「[系统指令] …」并入首条用户消息）注入。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>提示词来源 prompts.source</Label>
                  <Select
                    value={form.promptSource}
                    onValueChange={(value) => patch({ promptSource: value as FormState['promptSource'] })}
                  >
                    <SelectTrigger data-testid="settings-prompt-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="duckai">duck.ai 默认（源码生成器）</SelectItem>
                      <SelectItem value="custom">自定义系统提示词</SelectItem>
                      <SelectItem value="none">不注入</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    duck.ai 本身默认不注入系统提示词；这里的生成器按源码「Customize responses」规则拼装。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>注入方式 prompts.mode</Label>
                  <Select
                    value={form.promptMode}
                    onValueChange={(value) => patch({ promptMode: value as 'inline' | 'system' })}
                  >
                    <SelectTrigger data-testid="settings-prompt-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inline">inline（推荐，合并进首条用户消息）</SelectItem>
                      <SelectItem value="system">system（前置 system 消息，上游可能 400）</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">inline 会以「[系统指令] …」前缀写入首条 user 消息，兼容性最好。</p>
                </div>
              </div>

              {form.promptSource === 'duckai' ? (
                <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <div className="text-xs font-medium">duck.ai 默认提示词生成器（源码逻辑）</div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label>语气 tone</Label>
                      <Select value={form.duckai.tone} onValueChange={(value) => patchDuckai({ tone: value })}>
                        <SelectTrigger data-testid="settings-duckai-tone">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(promptOptions?.tones || [{ id: 'Default' }, { id: 'Casual' }, { id: 'Professional' }]).map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>长度 length</Label>
                      <Select value={form.duckai.length} onValueChange={(value) => patchDuckai({ length: value })}>
                        <SelectTrigger data-testid="settings-duckai-length">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(promptOptions?.lengths || [{ id: 'Default' }, { id: 'Short' }, { id: 'Shortest' }]).map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>AI 角色 assistantRole</Label>
                      <Select value={form.duckai.assistantRole} onValueChange={(value) => patchDuckai({ assistantRole: value })}>
                        <SelectTrigger data-testid="settings-duckai-assistant-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSISTANT_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>你的角色 userRole</Label>
                      <Select value={form.duckai.userRole} onValueChange={(value) => patchDuckai({ userRole: value })}>
                        <SelectTrigger data-testid="settings-duckai-user-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {USER_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-duckai-user-name">你的昵称</Label>
                      <Input
                        id="settings-duckai-user-name"
                        value={form.duckai.userName}
                        onChange={(event) => patchDuckai({ userName: event.target.value })}
                        placeholder="例如：小许（可留空）"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-duckai-assistant-name">AI 昵称</Label>
                      <Input
                        id="settings-duckai-assistant-name"
                        value={form.duckai.assistantName}
                        onChange={(event) => patchDuckai({ assistantName: event.target.value })}
                        placeholder="例如：Ducky（可留空）"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label htmlFor="settings-duckai-clarify">先反问澄清 shouldSeekClarity</Label>
                      <p className="text-[11px] text-muted-foreground">
                        开启后要求模型在信息不足时先提问（对应 duck.ai 的「Ask clarifying questions」）。
                      </p>
                    </div>
                    <Switch
                      id="settings-duckai-clarify"
                      checked={form.duckai.shouldSeekClarity}
                      onCheckedChange={(checked) => patchDuckai({ shouldSeekClarity: checked })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-duckai-additional">附加指令 additionalInstructions</Label>
                    <Textarea
                      id="settings-duckai-additional"
                      rows={3}
                      value={form.duckai.additionalInstructions}
                      onChange={(event) => patchDuckai({ additionalInstructions: event.target.value })}
                      placeholder="例如：回答尽量使用中文，并给出可执行的步骤。"
                    />
                  </div>
                </div>
              ) : null}

              {form.promptSource === 'custom' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="settings-system-prompt">自定义系统提示词 defaultSystemPrompt</Label>
                  <Textarea
                    id="settings-system-prompt"
                    data-testid="settings-system-prompt"
                    rows={6}
                    value={form.systemPrompt}
                    placeholder="例如：你是一个严谨的中文技术助手，回答尽量简洁。"
                    onChange={(event) => patch({ systemPrompt: event.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">留空表示不注入。</p>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label>最终注入的提示词预览（服务端按源码同款逻辑生成）</Label>
                <pre
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px]"
                  data-testid="settings-prompt-preview"
                >
                  {promptPreviewError ? `预览失败：${promptPreviewError}` : promptPreview || '（空：不会注入任何提示词）'}
                </pre>
              </div>
            </CardContent>
            <CardFooter className="justify-end pt-0">
              <Button size="sm" onClick={() => void saveCard('prompts')} disabled={loading || saving} data-testid="settings-save-prompts">
                {savingFor('prompts') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存提示词配置
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">工具</CardTitle>
              <CardDescription className="text-xs">允许客户端请求联网搜索 / 图片生成</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="settings-tool-web">联网搜索 tools.webSearch</Label>
                  <p className="text-[11px] text-muted-foreground">禁用后 tools:[web_search] 返回 400 tool_disabled</p>
                </div>
                <Switch
                  id="settings-tool-web"
                  checked={form.webSearch}
                  onCheckedChange={(checked) => patch({ webSearch: checked })}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="settings-tool-image">图片生成 tools.imageGeneration</Label>
                  <p className="text-[11px] text-muted-foreground">禁用后图片生成接口与工具返回 400 tool_disabled</p>
                </div>
                <Switch
                  id="settings-tool-image"
                  checked={form.imageGeneration}
                  onCheckedChange={(checked) => patch({ imageGeneration: checked })}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="settings-tool-location">允许定位 tools.location</Label>
                  <p className="text-[11px] text-muted-foreground">
                    允许上游询问「使用大致位置」（天气等更精准）；默认不允许（LocationPrompt 自动拒绝）。
                  </p>
                </div>
                <Switch
                  id="settings-tool-location"
                  data-testid="settings-tool-location"
                  checked={form.location}
                  onCheckedChange={(checked) => patch({ location: checked })}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="settings-tool-client-tools">客户端工具 tools.clientFunctionCalling.enabled</Label>
                  <p className="text-[11px] text-muted-foreground">
                    允许 Codex/DSH 传 OpenAI tools[].function（文件读写等），网关自动转换 Completions/Responses
                    协议并返回 tool_calls；工具由客户端本地执行，网关不执行、不接 MCP。
                  </p>
                </div>
                <Switch
                  id="settings-tool-client-tools"
                  data-testid="settings-tool-client-tools"
                  checked={form.clientFunctionCalling}
                  onCheckedChange={(checked) => patch({ clientFunctionCalling: checked })}
                />
              </div>
            </CardContent>
            <CardFooter className="justify-end pt-0">
              <Button size="sm" onClick={() => void saveCard('tools')} disabled={loading || saving} data-testid="settings-save-tools">
                {savingFor('tools') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存工具配置
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">日志</CardTitle>
              <CardDescription className="text-xs">运行日志级别（上游/后台请求日志在「日志」页）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>日志级别 logging.level</Label>
                <Select value={form.logLevel} onValueChange={(value) => patch({ logLevel: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>各卡片保存后实时生效</span>
                {loadedAt ? <Badge variant="outline">加载于 {formatDateTime(loadedAt)}</Badge> : null}
              </div>
            </CardContent>
            <CardFooter className="justify-end pt-0">
              <Button size="sm" onClick={() => void saveCard('logging')} disabled={loading || saving} data-testid="settings-save-logging">
                {savingFor('logging') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存日志配置
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
