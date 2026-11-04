import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CreditCard,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '@/app/lib/api';
import { formatDateTime } from '@/app/lib/format';
import type { Subscription, SubscriptionsResponse } from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { EmptyState } from '@/app/components/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

function tierVariant(tier: string | null | undefined): 'warning' | 'info' | 'muted' {
  if (tier === 'pro') return 'warning';
  if (tier === 'plus' || tier === 'internal') return 'info';
  return 'muted';
}

function isExpired(subscription: Subscription): boolean {
  if (!subscription.expiresAt) return false;
  const time = Date.parse(subscription.expiresAt);
  return Number.isFinite(time) && time <= Date.now();
}

interface CreateForm {
  token: string;
  label: string;
}

export function SubscriptionsPage() {
  const [items, setItems] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>({ token: '', label: '' });
  const [renameTarget, setRenameTarget] = useState<Subscription | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // v2.27：自动续期（refresh token）对话框
  const [refreshTarget, setRefreshTarget] = useState<Subscription | null>(null);
  const [refreshTokenValue, setRefreshTokenValue] = useState('');
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  // v2.25：免复制 JWT 的登录会话（bookmarklet + 轮询）
  const [loginSession, setLoginSession] = useState<{
    sessionId: string;
    expiresAt: number;
    relayUrl: string;
    bookmarklet: string;
    consoleScript: string;
    captureUrl: string;
    tokenEndpoint: string;
    steps: string[];
    status: string;
  } | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginStatus, setLoginStatus] = useState<string>('idle');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const response = await apiGet<SubscriptionsResponse>('/subscriptions');
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      setError((err as Error)?.message || '订阅列表加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * v2.26：接受书签脚本从 duck.ai 带来的 `#/subscriptions?sessionId=..&token=..`。
   * 管理台与服务同源，提交不会受 Chrome Local Network Access 限制；提交后立即把 token 从地址栏清掉。
   */
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    if (qIndex === -1) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const sessionId = params.get('sessionId');
    const token = params.get('token');
    if (!sessionId || !token) return;
    const cleanHash = hash.slice(0, qIndex);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${cleanHash}`
    );
    void (async () => {
      try {
        const result = await apiPost<{
          ok: boolean;
          duplicate?: boolean;
          subscription?: { tier?: string; email?: string | null };
        }>('/subscriptions/capture', { sessionId, token });
        toast.success(
          `已绑定订阅${result?.subscription?.tier ? `（${result.subscription.tier}` : ''}${
            result?.subscription?.email ? ` · ${result.subscription.email}` : ''
          }${result?.subscription?.tier || result?.subscription?.email ? '）' : ''}`
        );
        await load(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as Error)?.message || '订阅绑定失败（会话可能已过期，请重新生成登录链接）');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const bound = items.reduce((total, item) => total + (item.bindingCount ?? 0), 0);
    const expired = items.filter((item) => isExpired(item) || item.expired).length;
    const paid = items.filter((item) => item.paid === true).length;
    return { total: items.length, bound, expired, paid };
  }, [items]);

  const create = async () => {
    const token = form.token.trim();
    if (!token) {
      toast.error('请粘贴 DuckDuckGo 订阅 token');
      return;
    }
    setCreating(true);
    try {
      const response = await apiPost<{ subscription: Subscription; duplicate?: boolean }>('/subscriptions', {
        token,
        ...(form.label.trim() ? { label: form.label.trim() } : {})
      });
      toast.success(response?.duplicate ? '该订阅已存在（已复用原条目）' : '订阅已添加');
      setCreateOpen(false);
      setForm({ token: '', label: '' });
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      const apiError = err as ApiError;
      toast.error(
        apiError?.code === 'token_invalid'
          ? `token 无效：${apiError.message || '请检查是否粘贴了完整 DuckDuckGo 订阅 token'}`
          : apiError?.message || '新增订阅失败'
      );
    } finally {
      setCreating(false);
    }
  };

  const verify = async (subscription: Subscription) => {
    setBusyId(subscription.id);
    try {
      await apiPost(`/subscriptions/${encodeURIComponent(subscription.id)}/verify`, {});
      toast.success(`已校验「${subscription.label}」`);
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as ApiError)?.message || '订阅校验失败');
      await load(true).catch(() => {});
    } finally {
      setBusyId(null);
    }
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    setBusyId(renameTarget.id);
    try {
      await apiPatch(`/subscriptions/${encodeURIComponent(renameTarget.id)}`, { label: renameValue.trim() });
      toast.success('名称已更新');
      setRenameTarget(null);
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as ApiError)?.message || '更新失败');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const result = await apiDelete<{ unbound?: number }>(`/subscriptions/${encodeURIComponent(deleteTarget.id)}`);
      toast.success(
        result?.unbound ? `已删除订阅，并解绑 ${result.unbound} 个身份` : '订阅已删除'
      );
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as ApiError)?.message || '删除订阅失败');
    } finally {
      setBusyId(null);
    }
  };

  const stopPolling = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const createLoginSession = async () => {
    setLoginBusy(true);
    try {
      const data = await apiPost<{
        sessionId: string;
        expiresAt: number;
        relayUrl: string;
        bookmarklet: string;
        consoleScript: string;
        captureUrl: string;
        tokenEndpoint: string;
        steps: string[];
      }>('/subscriptions/login-session', { origin: window.location.origin });
      setLoginSession({ ...data, status: 'waiting' });
      setLoginStatus('waiting');
      toast.success('已生成登录会话（5 分钟内有效）');
      stopPolling();
      pollTimer.current = setInterval(async () => {
        try {
          const status = await apiGet<{ status: string; result?: { tier?: string; email?: string } | null }>(
            `/subscriptions/login-session/${data.sessionId}`
          );
          setLoginStatus(status.status);
          if (status.status === 'completed') {
            stopPolling();
            toast.success(
              `登录成功，已绑定订阅${status.result?.tier ? `（${status.result.tier}` : ''}${status.result?.email ? ` ${status.result.email}` : ''}${
                status.result?.tier || status.result?.email ? '）' : ''
              }`
            );
            await load(true);
          } else if (status.status === 'failed' || status.status === 'expired' || status.status === 'cancelled') {
            stopPolling();
            if (status.status === 'failed') toast.error('token 无效或绑定失败，请重新生成登录链接');
            if (status.status === 'expired') toast.error('登录会话已过期，请重新生成');
          }
        } catch {
          /* 轮询失败静默重试 */
        }
      }, 2000);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as ApiError)?.message || '生成登录会话失败');
    } finally {
      setLoginBusy(false);
    }
  };

  const cancelLogin = async () => {
    if (loginSession) {
      try {
        await apiDelete(`/subscriptions/login-session/${loginSession.sessionId}`);
      } catch {
        /* ignore */
      }
    }
    stopPolling();
    setLoginSession(null);
    setLoginStatus('idle');
  };

  const copyBookmarklet = async () => {
    if (!loginSession) return;
    try {
      await navigator.clipboard.writeText(loginSession.bookmarklet);
      toast.success('脚本已复制：打开 duck.ai → 地址栏粘贴执行（或存为书签）');
    } catch {
      toast.error('复制失败，请手动选择文本复制');
    }
  };

  const copyConsoleScript = async () => {
    if (!loginSession) return;
    try {
      await navigator.clipboard.writeText(loginSession.consoleScript);
      toast.success('已复制：在 duck.ai 按 F12 → Console 粘贴并回车（提示 allow pasting 时手动输入该短语）');
    } catch {
      toast.error('复制失败，请手动选择文本复制');
    }
  };

  const copyRelayUrl = async () => {
    if (!loginSession) return;
    try {
      await navigator.clipboard.writeText(loginSession.relayUrl);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  const saveRefreshToken = async () => {
    if (!refreshTarget) return;
    const value = refreshTokenValue.trim();
    if (!value) {
      toast.error('请粘贴 ddg_auth_refresh_token 的值');
      return;
    }
    setBusyId(refreshTarget.id);
    try {
      await apiPost(`/subscriptions/${encodeURIComponent(refreshTarget.id)}/refresh-token`, { refreshToken: value });
      toast.success('已保存 refresh token，网关会自动续期（30 天有效，每次续期自动轮换）');
      setRefreshTarget(null);
      setRefreshTokenValue('');
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '保存 refresh token 失败');
    } finally {
      setBusyId(null);
    }
  };

  const clearRefreshToken = async (subscription: Subscription) => {
    setBusyId(subscription.id);
    try {
      await apiDelete(`/subscriptions/${encodeURIComponent(subscription.id)}/refresh-token`);
      toast.success('已关闭自动续期');
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '关闭自动续期失败');
    } finally {
      setBusyId(null);
    }
  };

  const refreshNow = async (subscription: Subscription) => {
    setRefreshingId(subscription.id);
    try {
      const result = await apiPost<{ refreshed: boolean; reason?: string | null; rotatedRefreshToken?: boolean }>(
        `/subscriptions/${encodeURIComponent(subscription.id)}/refresh`,
        {}
      );
      if (result?.refreshed) {
        toast.success(`已续期${result.rotatedRefreshToken ? '（refresh token 已轮换）' : ''}`);
      } else {
        toast.message('当前 token 仍有效，无需续期');
      }
      await load(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '续期失败');
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="订阅"
        description="DuckDuckGo Plus/Pro 订阅池：一个订阅可以绑定多个匿名身份（设备），在「身份池」里选择绑定。"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>订阅总数</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              {loading ? '—' : stats.total}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>已绑定身份</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Users className="h-4 w-4 text-muted-foreground" />
              {loading ? '—' : stats.bound}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>付费订阅</CardDescription>
            <CardTitle className="text-2xl">{loading ? '—' : stats.paid}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>已过期</CardDescription>
            <CardTitle className={`text-2xl ${stats.expired > 0 ? 'text-destructive' : ''}`}>
              {loading ? '—' : stats.expired}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card data-testid="subscription-login-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">免复制 JWT 登录（推荐）</CardTitle>
              <CardDescription className="text-xs">
                在已登录 DuckDuckGo 的浏览器里点一下书签，网关自动取到订阅 token 并保存；无需手动粘贴 JWT。
                token 有效期约 4–5 小时，到期后再点一次书签即可（订阅本身不会失效）
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {loginSession ? (
                <Button variant="outline" size="sm" onClick={() => void cancelLogin()}>
                  取消
                </Button>
              ) : null}
              <Button size="sm" onClick={() => void createLoginSession()} disabled={loginBusy} data-testid="subscription-login-start">
                {loginBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                生成登录链接
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {!loginSession ? (
            <p className="text-muted-foreground">
              点击「生成登录链接」后，页面会给出一个 5 分钟有效的一次性会话和一段书签脚本；
              在 duck.ai 页面执行后，本页会在 2 秒内自动检测到绑定完成。
            </p>
          ) : (
            <>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                ⚠️ Chrome 在<b>地址栏粘贴</b> <code className="rounded bg-muted px-1">javascript:</code> 会把它当成搜索，
                所以<strong>不要粘贴到地址栏</strong>；请按下面 1 → 2 → 3 的顺序操作。
              </div>

              {/* 步骤 1：先打开 duck.ai 并登录 */}
              <div className="space-y-2 rounded-md border p-3" data-testid="login-step-1">
                <div className="text-xs font-medium text-foreground">步骤 1 · 打开 duck.ai 并登录 DuckDuckGo</div>
                <p className="text-[11px] text-muted-foreground">
                  必须是已订阅 Plus/Pro 的账号；未登录时脚本会提示「未获取到 token」。
                </p>
                <a
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 text-xs font-medium hover:bg-primary/10"
                  href="https://duck.ai/"
                  target="_blank"
                  rel="noreferrer"
                  data-testid="login-open-duckai"
                >
                  打开 duck.ai
                </a>
              </div>

              {/* 步骤 2：方式 A（拖书签） */}
              <div className="space-y-2 rounded-md border p-3" data-testid="login-step-2">
                <div className="text-xs font-medium text-foreground">步骤 2 · 方式 A（推荐）：拖成书签后点击</div>
                <ol className="list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>
                    按 <kbd className="rounded border px-1">Ctrl</kbd>+<kbd className="rounded border px-1">Shift</kbd>+
                    <kbd className="rounded border px-1">B</kbd> 显示书签栏
                  </li>
                  <li>
                    把下面的「捕获订阅」链接<b>拖到书签栏</b>（或右键 → 添加到书签 → 选「书签栏」）
                  </li>
                  <li>切到 duck.ai 标签，点击刚添加的书签 → 弹出「订阅已绑定」即完成</li>
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 text-xs font-medium hover:bg-primary/10"
                    href={loginSession.bookmarklet}
                    onClick={(event) => event.preventDefault()}
                    draggable
                    data-testid="subscription-login-drag"
                    title="拖我到书签栏（单击只会复制）"
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/uri-list', loginSession.bookmarklet);
                      event.dataTransfer.setData('text/plain', loginSession.bookmarklet);
                    }}
                    onDoubleClick={() => void copyBookmarklet()}
                  >
                    捕获订阅（拖到书签栏）
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyBookmarklet()}
                    data-testid="subscription-login-copy"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    复制书签脚本
                  </Button>
                </div>
              </div>

              {/* 步骤 4：方式 B（控制台） */}
              <div className="space-y-2 rounded-md border p-3" data-testid="login-step-3">
                <div className="text-xs font-medium text-foreground">步骤 3 · 方式 B（不便加书签时）：DevTools 控制台</div>
                <ol className="list-decimal space-y-1 pl-5 text-[11px] text-muted-foreground">
                  <li>在 duck.ai 页面按 F12 → 切到 Console</li>
                  <li>
                    点「复制控制台脚本」并粘贴执行；若提示 <code className="rounded bg-muted px-1">allow pasting</code>，
                    手动输入该短语后再粘贴
                  </li>
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyConsoleScript()}
                    data-testid="subscription-login-console"
                  >
                    复制控制台脚本
                  </Button>
                </div>
              </div>

              {/* 会话辅助信息 */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant={loginStatus === 'completed' ? 'success' : loginStatus === 'waiting' ? 'info' : 'secondary'}>
                  {loginStatus === 'waiting'
                    ? '等待授权…'
                    : loginStatus === 'completed'
                      ? '已绑定'
                      : loginStatus === 'failed'
                        ? '绑定失败'
                        : loginStatus === 'expired'
                          ? '已过期'
                          : '已取消'}
                </Badge>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void copyRelayUrl()}>
                  复制会话链接
                </Button>
                <span>会话 5 分钟内有效</span>
              </div>

              <details className="rounded-md border bg-muted/20 p-2">
                <summary className="cursor-pointer text-muted-foreground">查看书签脚本 / 技术细节</summary>
                <div className="mt-2 space-y-1">
                  <div className="text-[11px] text-muted-foreground">会话 ID：{loginSession.sessionId}</div>
                  <div className="text-[11px] text-muted-foreground">
                    取 token 端点：<code className="break-all">{loginSession.tokenEndpoint}</code>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    回传端点：<code className="break-all">{loginSession.captureUrl}</code>
                  </div>
                  <div className="text-[11px] font-medium text-muted-foreground">控制台脚本（Console 用，无 javascript: 前缀）</div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 text-[10px]">
                    {loginSession.consoleScript}
                  </pre>
                  <div className="text-[11px] font-medium text-muted-foreground">书签 URL（拖拽用）</div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 text-[10px]">
                    {loginSession.bookmarklet}
                  </pre>
                </div>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="subscription-list-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="h-4 w-4" />
                订阅列表
              </CardTitle>
              <CardDescription>
                粘贴 DuckDuckGo 订阅 token（JWT）即可添加；同一 token 重复添加会复用原条目。一个订阅可绑定多个身份。
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="subscription-refresh">
                <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                刷新
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="subscription-add">
                <Plus className="h-3.5 w-3.5" />
                新增订阅
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading && items.length === 0 ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : items.length === 0 ? (
            <EmptyState
              title="还没有订阅"
              description="点击右上角「新增订阅」，粘贴 DuckDuckGo Plus/Pro 订阅 token（JWT）。"
            />
          ) : (
            items.map((subscription) => {
              const expired = isExpired(subscription) || subscription.expired === true;
              return (
                <div
                  key={subscription.id}
                  data-testid={`subscription-card-${subscription.id}`}
                  className="rounded-lg border bg-background px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{subscription.label || subscription.id}</span>
                    <Badge variant={tierVariant(subscription.tier)}>
                      {subscription.tier === 'plus'
                        ? 'Plus'
                        : subscription.tier === 'pro'
                          ? 'Pro'
                          : subscription.tier === 'internal'
                            ? 'Internal'
                            : '免费'}
                    </Badge>
                    {expired ? (
                      <Badge variant="destructive" className="gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        已过期
                      </Badge>
                    ) : subscription.verified ? (
                      <Badge variant="success" className="gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        已验证
                      </Badge>
                    ) : (
                      <Badge variant="muted">未验证</Badge>
                    )}
                    <Badge variant={subscription.bindingCount ? 'info' : 'muted'} className="gap-1">
                      <Users className="h-3 w-3" />
                      绑定 {subscription.bindingCount ?? 0} 个身份
                    </Badge>
                    {subscription.autoRefresh ? (
                      <Badge variant="success" className="gap-1" title="已保存 refresh token，网关会在到期前自动续期">
                        <RefreshCw className="h-3 w-3" />
                        自动续期
                      </Badge>
                    ) : (
                      <Badge variant="muted" className="gap-1" title="未保存 refresh token：token 4 小时后需要重新登录">
                        不自动续期
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      {subscription.autoRefresh ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={refreshingId === subscription.id}
                            onClick={() => void refreshNow(subscription)}
                            data-testid={`subscription-refresh-now-${subscription.id}`}
                          >
                            {refreshingId === subscription.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                            立即续期
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            disabled={busyId === subscription.id}
                            onClick={() => void clearRefreshToken(subscription)}
                          >
                            关闭续期
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={busyId === subscription.id}
                          onClick={() => {
                            setRefreshTarget(subscription);
                            setRefreshTokenValue('');
                          }}
                          data-testid={`subscription-enable-refresh-${subscription.id}`}
                        >
                          <RefreshCw className="h-3 w-3" />
                          自动续期
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={busyId === subscription.id}
                        onClick={() => void verify(subscription)}
                      >
                        {busyId === subscription.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3 w-3" />
                        )}
                        校验
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={busyId === subscription.id}
                        onClick={() => {
                          setRenameTarget(subscription);
                          setRenameValue(subscription.label || '');
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                        改名
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={busyId === subscription.id}
                        onClick={() => setDeleteTarget(subscription)}
                      >
                        <Trash2 className="h-3 w-3" />
                        删除
                      </Button>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{subscription.maskedToken || subscription.id}</span>
                    {subscription.email ? <span>{subscription.email}</span> : null}
                    {subscription.expiresAt ? (
                      <span
                    className={expired ? 'text-destructive' : ''}
                    title="这是 DuckDuckGo access token 的到期时间（通常是签发后 4–5 小时）；到期后订阅会回退为免费，需要重新点一次登录书签"
                  >
                    token 到期 {formatDateTime(subscription.expiresAt)}
                    {expired ? '（已过期，请重新登录）' : ''}
                  </span>
                    ) : null}
                    {subscription.autoRefresh ? (
                      <span title="网关每 5 分钟巡检一次，到期前 30 分钟自动续期">
                        续期 {subscription.refreshCount ?? 0} 次
                        {subscription.refreshedAt ? ` · 最近 ${formatDateTime(subscription.refreshedAt)}` : ''}
                        {subscription.refreshError ? ` · 失败：${subscription.refreshError}` : ''}
                      </span>
                    ) : null}
                    {subscription.boundIdentities && subscription.boundIdentities.length > 0 ? (
                      <span className="truncate">
                        绑定身份：
                        {subscription.boundIdentities.map((item) => item.deviceName || item.label || item.id).join('、')}
                      </span>
                    ) : null}
                  </div>
                  {expired ? (
                    <p className="mt-1 text-[11px] text-destructive">该订阅已过期，绑定它的身份会回退为免费模型。</p>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(open) => (!open ? setCreateOpen(false) : null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>新增订阅</DialogTitle>
            <DialogDescription>
              粘贴 DuckDuckGo Plus/Pro 订阅 token（三段式 JWT）。订阅保存在本机 data/subscriptions.json（0600），
              列表只显示脱敏预览。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="subscription-token">订阅 token</Label>
              <Textarea
                id="subscription-token"
                data-testid="subscription-token-input"
                value={form.token}
                onChange={(event) => setForm((previous) => ({ ...previous, token: event.target.value }))}
                placeholder="eyJhbGciOi…（三段式 JWT）"
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="subscription-label">名称（可选）</Label>
              <Input
                id="subscription-label"
                data-testid="subscription-label-input"
                value={form.label}
                onChange={(event) => setForm((previous) => ({ ...previous, label: event.target.value }))}
                placeholder="例如：我的 Plus 订阅"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={() => void create()} disabled={creating} data-testid="subscription-create-submit">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => (!open ? setRenameTarget(null) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>订阅改名</DialogTitle>
          </DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="订阅名称" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void saveRename()} disabled={Boolean(busyId)}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(refreshTarget)} onOpenChange={(open) => (!open ? setRefreshTarget(null) : null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>开启自动续期</DialogTitle>
            <DialogDescription>
              在已登录 duck.ai 的浏览器里打开 DevTools → Application → Cookies →
              <code className="mx-1 rounded bg-muted px-1">https://duck.ai</code>，复制
              <code className="mx-1 rounded bg-muted px-1">ddg_auth_refresh_token</code> 的完整值粘贴到这里。
              有效期 30 天，网关会在到期前自动换新的 access token，并在每次续期后自动轮换该 refresh token。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="subscription-refresh-token">ddg_auth_refresh_token</Label>
            <Textarea
              id="subscription-refresh-token"
              data-testid="subscription-refresh-token-input"
              className="min-h-[110px] font-mono text-[11px]"
              value={refreshTokenValue}
              onChange={(event) => setRefreshTokenValue(event.target.value)}
              placeholder="eyJ0eXAiOiJKV1Qi… （三段式 JWT，scope=refresh）"
            />
            <p className="text-[11px] text-muted-foreground">
              提示：这是 HttpOnly cookie，书签脚本读不到，只能从 DevTools 复制；粘贴后只保存在本机
              data/subscriptions.json（0600），接口不返回明文。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefreshTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void saveRefreshToken()} disabled={busyId === refreshTarget?.id} data-testid="subscription-refresh-token-save">
              {busyId === refreshTarget?.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存并开启自动续期
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : null)}
        title={`删除订阅「${deleteTarget?.label || deleteTarget?.id || ''}」？`}
        description={`将删除该订阅并解除它与 ${
          deleteTarget?.bindingCount ?? 0
        } 个身份的绑定；身份本身不会被删除，之后会回退为免费模型。`}
        confirmText="删除"
        destructive
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
