import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Network,
  PlugZap,
  RefreshCw,
  Save,
  Server,
  Wifi
} from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPost, apiPut, ApiError } from '@/app/lib/api';
import { formatDateTime, formatDuration } from '@/app/lib/format';
import type { ProxyConfig, ProxyResponse, ProxyTestResult, ProxyUpdateResponse } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const MODE_LABELS: Record<string, string> = {
  direct: '直连',
  http: 'HTTP 代理',
  https: 'HTTPS 代理',
  socks4: 'SOCKS4 代理',
  socks5: 'SOCKS5 代理'
};

const TYPE_OPTIONS = [
  { value: 'http', label: 'HTTP（CONNECT 隧道）' },
  { value: 'https', label: 'HTTPS（TLS 连接代理）' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' }
];

interface ProxyForm {
  enabled: boolean;
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
  noProxy: string;
  testUrl: string;
  ipCheckUrl: string;
}

const DEFAULT_FORM: ProxyForm = {
  enabled: false,
  type: 'http',
  host: '',
  port: '8080',
  username: '',
  password: '',
  noProxy: '127.0.0.1\nlocalhost',
  testUrl: 'https://duck.ai/duckchat/v1/status',
  ipCheckUrl: 'https://api.ipify.org?format=json'
};

function parseNoProxy(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function hydrateForm(proxy: ProxyConfig): ProxyForm {
  return {
    enabled: proxy.enabled === true,
    type: proxy.type || 'http',
    host: proxy.host || '',
    port: String(proxy.port ?? 8080),
    username: proxy.username || '',
    password: '',
    noProxy: (proxy.noProxy ?? ['127.0.0.1', 'localhost']).join('\n'),
    testUrl: proxy.testUrl || DEFAULT_FORM.testUrl,
    ipCheckUrl: proxy.ipCheckUrl || DEFAULT_FORM.ipCheckUrl
  };
}

function handleActionError(error: unknown, fallback: string): void {
  if ((error as ApiError)?.handled) return;
  const apiError = error as ApiError;
  if (apiError?.status === 400 || apiError?.code === 'invalid_proxy') {
    toast.error(`代理配置无效：${apiError.message || '请检查主机/端口/URL'}`);
    return;
  }
  if (apiError?.status === 502) {
    toast.error(`代理链路失败：${apiError.message || '上游不可达'}`);
    return;
  }
  toast.error(apiError?.message || fallback);
}

export function ProxyPage() {
  const [proxy, setProxy] = useState<ProxyConfig | null>(null);
  const [form, setForm] = useState<ProxyForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ProxyResponse>('/proxy');
      if (response?.proxy) {
        setProxy(response.proxy);
        setForm((current) => ({ ...hydrateForm(response.proxy), enabled: response.proxy.enabled === true, password: current.password }));
      }
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '代理配置加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (values: Partial<ProxyForm>) => {
    setForm((current) => ({ ...current, ...values }));
    setFormError(null);
  };

  const fieldsDisabled = !form.enabled;

  const validate = (): boolean => {
    if (form.enabled) {
      if (!form.host.trim()) {
        setFormError('启用代理时必须填写主机（host）。');
        return false;
      }
      const port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setFormError('端口必须是 1–65535 的整数。');
        return false;
      }
    } else if (form.host.trim()) {
      const port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setFormError('端口必须是 1–65535 的整数。');
        return false;
      }
    }
    for (const [label, value] of [
      ['测试地址', form.testUrl.trim()],
      ['出口 IP 检查地址', form.ipCheckUrl.trim()]
    ] as const) {
      if (value && !/^https?:\/\//i.test(value)) {
        setFormError(`${label}必须以 http:// 或 https:// 开头。`);
        return false;
      }
    }
    return true;
  };

  const buildPayload = () => {
    const payload: Record<string, unknown> = {
      enabled: form.enabled,
      type: form.type,
      host: form.host.trim(),
      port: Number(form.port) || 8080,
      username: form.username.trim(),
      noProxy: parseNoProxy(form.noProxy),
      testUrl: form.testUrl.trim(),
      ipCheckUrl: form.ipCheckUrl.trim()
    };
    // 密码留空表示不修改已保存密码
    if (form.password.length > 0) payload.password = form.password;
    return payload;
  };

  const save = async () => {
    if (saving) return;
    if (!validate()) return;
    setSaving(true);
    try {
      const response = await apiPut<ProxyUpdateResponse>('/proxy', buildPayload());
      if (response?.proxy) {
        const applied = response.proxy;
        setProxy(applied);
        setForm(hydrateForm(applied));
      }
      toast.success(form.enabled ? '代理已保存并应用（立即生效）' : '代理配置已保存（已关闭）');
      setTestResult(null);
    } catch (err) {
      handleActionError(err, '保存代理配置失败');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (testing) return;
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const payload = buildPayload();
      const result = await apiPost<ProxyTestResult>('/proxy/test', {
        type: payload.type,
        host: payload.host,
        port: payload.port,
        username: payload.username,
        ...(payload.password ? { password: payload.password } : {}),
        noProxy: payload.noProxy,
        testUrl: payload.testUrl,
        ipCheckUrl: payload.ipCheckUrl
      });
      setTestResult(result);
      if (result.ok) {
        toast.success(
          `代理连通：${formatDuration(result.latencyMs)}${result.exitIp ? ` · 出口 IP ${result.exitIp}` : ''}`
        );
      } else {
        toast.error(`代理测试失败：${result.error || result.code || '未知错误'}`, { duration: 6000 });
      }
      // 同步最新 status（lastTestAt / lastError 等）
      try {
        const fresh = await apiGet<ProxyResponse>('/proxy');
        if (fresh?.proxy) setProxy(fresh.proxy);
      } catch {
        /* ignore refresh failure */
      }
    } catch (err) {
      handleActionError(err, '测试代理失败');
    } finally {
      setTesting(false);
    }
  };

  const fillLocalProxy = () => {
    patch({ type: 'http', host: '127.0.0.1', port: '10808', enabled: true });
    toast.info('已填入本机代理 127.0.0.1:10808（HTTP），保存后生效');
  };

  const status = proxy?.status;
  const mode = status?.mode || (form.enabled ? form.type : 'direct');
  const active = status?.active === true;

  return (
    <div>
      <PageHeader
        title="代理"
        description="网关出站代理：让服务端访问外部网络（含 duckduckgo.com），立即生效"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-xs leading-relaxed">
        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          代理用于让 <span className="font-medium">网关服务端出站</span>访问外部网络（包括 <code className="rounded bg-muted px-1">duckduckgo.com</code>，影响 Sync 与订阅校验）；
          <span className="font-medium">仅影响服务端出站，不影响浏览器流量</span>。修改并保存后立即生效，无需重启。
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* ------------------------------ 状态卡 ------------------------------ */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="h-4 w-4" />
                  代理状态
                </CardTitle>
                <CardDescription className="text-xs">当前模式、最近一次连通性测试结果</CardDescription>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant={active ? 'success' : 'muted'} className="gap-1">
                  <PlugZap className="h-3 w-3" />
                  {active ? '已启用' : '未启用'}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <Network className="h-3 w-3" />
                  {MODE_LABELS[mode] ?? mode}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading && !proxy ? (
              <Skeleton className="h-48 rounded-xl" />
            ) : (
              <>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <StatusRow label="最近测试" value={status?.lastTestAt ? formatDateTime(status.lastTestAt) : '尚未测试'} />
                  <StatusRow
                    label="最近测试结果"
                    value={
                      status?.lastTestOk === true
                        ? '通过'
                        : status?.lastTestOk === false
                          ? '失败'
                          : '—'
                    }
                    tone={status?.lastTestOk === false ? 'danger' : status?.lastTestOk === true ? 'success' : 'muted'}
                  />
                  <StatusRow label="延迟" value={formatDuration(status?.lastTestLatencyMs)} />
                  <StatusRow label="HTTP 状态" value={status?.lastTestStatus ? String(status.lastTestStatus) : '—'} />
                  <StatusRow label="出口 IP" value={status?.exitIp || '—'} mono />
                  <StatusRow
                    label="状态更新时间"
                    value={status?.updatedAt ? formatDateTime(status.updatedAt) : '—'}
                  />
                </div>
                {status?.lastError ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-words">最近错误：{status.lastError}</span>
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3" />
                    暂无最近错误记录
                  </p>
                )}
                <p className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  启用代理后，DuckClient 全部请求、Sync transport 探测、订阅在线校验都会走该代理；
                  Sync 的 <code className="rounded bg-muted px-1">transport</code> 应变为 <code className="rounded bg-muted px-1">available</code>。
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------ 配置卡 ------------------------------ */}
        <Card className="xl:col-span-3">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Server className="h-4 w-4" />
                  代理配置
                </CardTitle>
                <CardDescription className="text-xs">
                  支持 HTTP / HTTPS CONNECT 与 SOCKS4 / SOCKS5；关闭时字段不可编辑（开关打开后可编辑并保存）
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="proxy-refresh"
                  onClick={() => void load()}
                  disabled={loading || saving || testing}
                >
                  <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                  刷新
                </Button>
                <span className="text-[11px] text-muted-foreground">{form.enabled ? '开启' : '关闭'}</span>
                <Switch
                  checked={form.enabled}
                  aria-label="启用代理"
                  disabled={saving || testing}
                  onCheckedChange={(next) => patch({ enabled: next })}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {formError ? (
              <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{formError}</p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select
                  value={form.type}
                  onValueChange={(value) => patch({ type: value })}
                  disabled={fieldsDisabled || saving || testing}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="proxy-host">主机 + 端口</Label>
                <div className="flex gap-2">
                  <Input
                    id="proxy-host"
                    value={form.host}
                    placeholder="127.0.0.1 或 proxy.example.com"
                    disabled={fieldsDisabled || saving || testing}
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                  <Input
                    id="proxy-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    className="w-28 shrink-0"
                    disabled={fieldsDisabled || saving || testing}
                    onChange={(event) => patch({ port: event.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="proxy-username">用户名（可选）</Label>
                <Input
                  id="proxy-username"
                  value={form.username}
                  autoComplete="off"
                  disabled={fieldsDisabled || saving || testing}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="proxy-password">密码（可选）</Label>
                  {proxy?.hasAuth ? <Badge variant="outline">已保存密码</Badge> : null}
                </div>
                <div className="flex gap-2">
                  <Input
                    id="proxy-password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    autoComplete="new-password"
                    placeholder="留空表示不修改已保存密码"
                    disabled={fieldsDisabled || saving || testing}
                    onChange={(event) => patch({ password: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="proxy-no-proxy">不走代理（noProxy）</Label>
              <Textarea
                id="proxy-no-proxy"
                rows={3}
                value={form.noProxy}
                placeholder="127.0.0.1, localhost, *.internal（逗号或换行分隔）"
                disabled={fieldsDisabled || saving || testing}
                onChange={(event) => patch({ noProxy: event.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">逗号或换行分隔，最多 50 项；按精确 / 后缀匹配直连。</p>
            </div>

            <div className="rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setAdvancedOpen((value) => !value)}
                aria-expanded={advancedOpen}
              >
                <span>高级：测试地址与出口 IP 检查</span>
                <ChevronDown className={advancedOpen ? 'h-3.5 w-3.5 rotate-180 transition-transform' : 'h-3.5 w-3.5 transition-transform'} />
              </button>
              {advancedOpen ? (
                <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="proxy-test-url">测试地址 testUrl</Label>
                    <Input
                      id="proxy-test-url"
                      value={form.testUrl}
                      disabled={fieldsDisabled || saving || testing}
                      onChange={(event) => patch({ testUrl: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="proxy-ip-url">出口 IP 检查地址 ipCheckUrl</Label>
                    <Input
                      id="proxy-ip-url"
                      value={form.ipCheckUrl}
                      disabled={fieldsDisabled || saving || testing}
                      onChange={(event) => patch({ ipCheckUrl: event.target.value })}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} disabled={saving || testing}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存并应用
              </Button>
              <Button variant="outline" onClick={() => void testConnection()} disabled={saving || testing}>
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                {testing ? '测试中…' : '测试连接'}
              </Button>
              <Button type="button" variant="secondary" onClick={fillLocalProxy} disabled={saving || testing}>
                <PlugZap className="h-3.5 w-3.5" />
                填入本机代理
              </Button>
              <span className="self-center text-[11px] text-muted-foreground">本机：127.0.0.1:10808（HTTP）</span>
            </div>

            {testResult ? (
              testResult.ok ? (
                <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  <div className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    测试通过 · {MODE_LABELS[testResult.mode] ?? testResult.mode}
                  </div>
                  <div>
                    延迟 {formatDuration(testResult.latencyMs)}
                    {testResult.status ? ` · HTTP ${testResult.status}` : ''}
                    {testResult.exitIp ? ` · 出口 IP ${testResult.exitIp}` : ''}
                    {testResult.ipError ? ` · IP 查询失败：${testResult.ipError}` : ''}
                  </div>
                  {testResult.target ? <div className="font-mono text-[10.5px] opacity-80">target: {testResult.target}</div> : null}
                </div>
              ) : (
                <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    测试失败{testResult.code ? `（${testResult.code}）` : ''}
                  </div>
                  <div className="break-words">{testResult.error || '未知错误'}</div>
                  <div className="opacity-80">耗时 {formatDuration(testResult.latencyMs)}</div>
                </div>
              )
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  mono = false,
  tone = 'muted'
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'muted' | 'success' | 'danger';
}) {
  const toneClass = tone === 'success' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 truncate text-xs ${mono ? 'font-mono' : ''} ${toneClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}
