import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Clock,
  BadgeCheck,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Star,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
  Users
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, downloadFile, ApiError } from '@/app/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/app/lib/format';
import type {
  BindingsResponse,
  IdentityBindingItem,
  IdentityPoolItem,
  IdentitiesResponse,
  RoutingInfo,
  Subscription,
  SubscriptionsResponse
} from '@/app/lib/types';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { EmptyState } from '@/app/components/empty-state';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { CopyButton } from '@/app/components/copy-button';
import { StatTile } from '@/app/components/stat-tile';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const ROUTE_STRATEGIES = [
  { value: 'hash', label: 'hash（sha256(sessionKey+salt) 取模）' },
  { value: 'least-loaded', label: 'least-loaded（选当前负载最低）' }
];

function identityDeviceName(item: IdentityPoolItem): string {
  if (item.deviceName) return item.deviceName;
  if (item.active) return 'DuckAI@main';
  return item.label || item.id;
}

function shortId(value: string | null | undefined, length = 8): string {
  if (!value) return '—';
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function tierBadge(tier: string | null | undefined, subscribed: boolean) {
  const normalized = (tier || 'free').toLowerCase();
  if (!subscribed) return <Badge variant="muted">free</Badge>;
  if (normalized === 'pro') return <Badge variant="accent">PRO</Badge>;
  return <Badge variant="info">PLUS</Badge>;
}

function actionButton(
  label: string,
  icon: ReactNode,
  onClick: () => void,
  options: { danger?: boolean; disabled?: boolean } = {}
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn('h-7 w-7', options.danger && 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
          aria-label={label}
          disabled={options.disabled}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function IdentitiesPage() {
  const [pool, setPool] = useState<IdentitiesResponse['pool'] | null>(null);
  const [items, setItems] = useState<IdentityPoolItem[]>([]);
  const [bindings, setBindings] = useState<IdentityBindingItem[]>([]);
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createLabel, setCreateLabel] = useState('');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateCount, setGenerateCount] = useState('2');
  const [generatePrefix, setGeneratePrefix] = useState('分身');
  const [generateSubscribed, setGenerateSubscribed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [bindOpen, setBindOpen] = useState(false);
  const [bindSessionKey, setBindSessionKey] = useState('');
  const [bindIdentityId, setBindIdentityId] = useState('');
  const [subTarget, setSubTarget] = useState<IdentityPoolItem | null>(null);
  /** v2.15: 订阅来自「订阅」页的订阅池，身份池只做选择绑定（不再输入 token）。 */
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subSelectedId, setSubSelectedId] = useState('');
  const [rotateTarget, setRotateTarget] = useState<IdentityPoolItem | null>(null);
  // v2.18: 设备重命名（身份池设备名列的铅笔按钮）
  const [renameDeviceTarget, setRenameDeviceTarget] = useState<IdentityPoolItem | null>(null);
  const [renameDeviceValue, setRenameDeviceValue] = useState('');
  const [rotateStep, setRotateStep] = useState<1 | 2>(1);
  const [rotateScope, setRotateScope] = useState<'journey' | 'device' | 'all'>('all');
  const [deleteTarget, setDeleteTarget] = useState<IdentityPoolItem | null>(null);
  const [forceTarget, setForceTarget] = useState<IdentityPoolItem | null>(null);
  const [slotsBlockedTarget, setSlotsBlockedTarget] = useState<IdentityPoolItem | null>(null);
  const [forceSlotsTarget, setForceSlotsTarget] = useState<IdentityPoolItem | null>(null);
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<IdentityPoolItem | null>(null);
  // v2.27：删除身份时若绑定了订阅 → 提示先解绑
  const [subscriptionBlockedTarget, setSubscriptionBlockedTarget] = useState<IdentityPoolItem | null>(null);
  const [bindingFilter, setBindingFilter] = useState('');
  // v2.30：会话绑定分页（默认 5 行）与绑定缓存 TTL 设置
  const [bindingPage, setBindingPage] = useState(1);
  const [bindingPageSize] = useState(5);
  const [bindingTtlDays, setBindingTtlDays] = useState('7');
  const [bindingTtlSaving, setBindingTtlSaving] = useState(false);
  // v2.31：身份额度（付费身份可查）
  const [usageMap, setUsageMap] = useState<
    Record<string, { supported: boolean; reason?: string; windows?: Array<{ id: string; label: string; percentUsed: number; resetAt: string | null }> }>
  >({});

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      apiGet<IdentitiesResponse>('/identities'),
      apiGet<BindingsResponse>('/identities/bindings?limit=100'),
      apiGet<RoutingInfo>('/identities/routing'),
      apiGet<SubscriptionsResponse>('/subscriptions'),
      apiGet<{ bindingTtlDays?: number }>('/identities/settings'),
      apiGet<{ items?: Array<{ identityId: string; supported: boolean; reason?: string; windows?: any[] }> }>(
        '/identities/usage'
      )
    ]);
    const messages: string[] = [];
    const [identitiesResult, bindingsResult, routingResult, subscriptionsResult, settingsResult, usageResult] = results;
    if (usageResult?.status === 'fulfilled') {
      const map: Record<string, any> = {};
      for (const item of usageResult.value?.items || []) {
        if (item && item.identityId) map[item.identityId] = item;
      }
      setUsageMap(map);
    }
    if (settingsResult.status === 'fulfilled' && Number.isFinite(settingsResult.value?.bindingTtlDays)) {
      setBindingTtlDays(String(settingsResult.value.bindingTtlDays));
    }
    if (identitiesResult.status === 'fulfilled') {
      setPool(identitiesResult.value?.pool ?? null);
      setItems(Array.isArray(identitiesResult.value?.items) ? identitiesResult.value.items : []);
    } else if (!(identitiesResult.reason as ApiError)?.handled) {
      messages.push((identitiesResult.reason as Error)?.message || '身份池加载失败');
    }
    if (bindingsResult.status === 'fulfilled') {
      setBindings(Array.isArray(bindingsResult.value?.items) ? bindingsResult.value.items : []);
    } else if (!(bindingsResult.reason as ApiError)?.handled) {
      messages.push((bindingsResult.reason as Error)?.message || '会话绑定加载失败');
    }
    if (routingResult.status === 'fulfilled') {
      setRouting(routingResult.value ?? null);
    } else if (!(routingResult.reason as ApiError)?.handled) {
      messages.push((routingResult.reason as Error)?.message || '路由信息加载失败');
    }
    if (subscriptionsResult.status === 'fulfilled') {
      setSubscriptions(Array.isArray(subscriptionsResult.value?.items) ? subscriptionsResult.value.items : []);
    } else if (!(subscriptionsResult.reason as ApiError)?.handled) {
      // 订阅接口不可用时不影响身份池，仅清空选择项。
      setSubscriptions([]);
    }
    if (messages.length > 0) setError(messages.join('；'));
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const identityLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      return items.find((item) => item.id === id)?.label || id;
    },
    [items]
  );

  const handleError = (err: unknown, fallback: string) => {
    if ((err as ApiError)?.handled) return;
    const apiError = err as ApiError;
    if (apiError?.status === 409) {
      if (apiError.code === 'default_identity_protected') {
        toast.error('默认身份不可删除：请先将其他身份设为默认，或使用「设为默认」切换后再删除。');
        return;
      }
      toast.error(apiError.message || '操作冲突，请刷新后重试', { duration: 6000 });
      return;
    }
    if (apiError?.status === 403) {
      toast.error(`没有权限：${apiError.message || '操作被拒绝'}`);
      return;
    }
    if (apiError?.status === 404) {
      toast.error(`资源不存在：${apiError.message || '身份可能已被删除'}`);
      return;
    }
    toast.error(apiError?.message || fallback);
  };

  const withAction = async (key: string, fn: () => Promise<void>) => {
    if (action) return;
    setAction(key);
    try {
      await fn();
    } catch (err) {
      handleError(err, '操作失败，请重试');
    } finally {
      setAction(null);
    }
  };

  /* ------------------------------ 操作 ------------------------------ */

  const createIdentity = () => {
    void withAction('create', async () => {
      await apiPost('/identities', { label: createLabel.trim() || undefined });
      setCreateOpen(false);
      setCreateLabel('');
      toast.success('身份已创建');
      await load(true);
    });
  };

  const generateIdentities = () => {
    void withAction('generate', async () => {
      const count = Number(generateCount);
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        toast.warning('批量数量需为 1–20');
        return;
      }
      const response = await apiPost<{ items: IdentityPoolItem[] }>('/identities/generate', {
        count,
        labelPrefix: generatePrefix.trim() || '分身',
        subscribed: generateSubscribed
      });
      setGenerateOpen(false);
      toast.success(`已生成 ${response.items?.length ?? count} 个身份`);
      await load(true);
    });
  };

  const importIdentity = () => {
    void withAction('import', async () => {
      const text = importText.trim();
      if (!text) {
        toast.warning('请选择身份 JSON 文件或粘贴 JSON');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error('导入内容不是合法 JSON');
        return;
      }
      const payload =
        parsed && typeof parsed === 'object' && 'identity' in (parsed as Record<string, unknown>)
          ? (parsed as Record<string, unknown>).identity
          : parsed;
      await apiPost('/identities', { import: payload });
      setImportOpen(false);
      setImportText('');
      setImportFileName('');
      toast.success('身份已导入');
      await load(true);
    });
  };

  const onImportFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(typeof reader.result === 'string' ? reader.result : '');
      setImportFileName(file.name);
    };
    reader.onerror = () => toast.error('读取文件失败');
    reader.readAsText(file);
  };

  const activateIdentity = (item: IdentityPoolItem) => {
    void withAction(`activate-${item.id}`, async () => {
      await apiPost(`/identities/${encodeURIComponent(item.id)}/activate`);
      toast.success(`已设为默认身份：${item.label}`);
      await load(true);
    });
  };

  const toggleIdentity = (item: IdentityPoolItem) => {
    void withAction(`toggle-${item.id}`, async () => {
      await apiPatch(`/identities/${encodeURIComponent(item.id)}`, { enabled: !item.enabled });
      toast.success(item.enabled ? '身份已禁用' : '身份已启用');
      await load(true);
    });
  };

  const rotateIdentity = () => {
    if (!rotateTarget) return;
    void withAction('rotate', async () => {
      try {
        // 仅第二步（二次确认）才会调用 API
        const response = await apiPost<{ identityLost?: boolean; note?: string | null }>(
          `/identities/${encodeURIComponent(rotateTarget.id)}/rotate`,
          { scope: rotateScope }
        );
        setRotateTarget(null);
        setRotateStep(1);
        if (response?.identityLost) {
          toast.warning(
            `身份已丢失，原匿名身份不可恢复${response.note ? `：${response.note}` : '（旧 journeyId / durableStream 密钥无法恢复）'}`,
            { duration: 9000 }
          );
        } else {
          toast.success(response?.note || '身份已轮换');
        }
        await load(true);
      } catch (err) {
        handleError(err, '轮换身份失败');
      }
    });
  };

  const forceDeleteFromSlots = () => {
    if (!forceSlotsTarget) return;
    void withAction('force-delete-slots', async () => {
      try {
        await apiDelete(`/identities/${encodeURIComponent(forceSlotsTarget.id)}?force=true`);
        toast.success(`已移除设备并删除身份：${forceSlotsTarget.label}`);
        setForceSlotsTarget(null);
        await load(true);
        // 同步刷新 device-slots（设备拆除后槽位需更新）
        try {
          await apiGet('/sync/device-slots');
        } catch {
          /* 旧后端无该端点时忽略 */
        }
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as Error)?.message || '强制删除失败', { duration: 7000 });
      }
    });
  };

  const goToDeviceList = () => {
    setSlotsBlockedTarget(null);
    try {
      window.sessionStorage.setItem('duckai_focus_device_list', '1');
    } catch {
      /* ignore */
    }
    window.location.hash = '#/identity';
    toast.info('已跳转到设备列表卡片，请先移除该身份对应设备再删除');
  };

  const exportIdentity = (item: IdentityPoolItem) => {
    void withAction(`export-${item.id}`, async () => {
      const filename = await downloadFile(
        `/identities/${encodeURIComponent(item.id)}/export`,
        `duckai-identity-${item.id}.json`
      );
      toast.success(`已导出 ${filename}`);
    });
  };

  const bindSubscription = () => {
    if (!subTarget) return;
    if (!subSelectedId) {
      toast.warning('请选择一个订阅');
      return;
    }
    void withAction('subscribe', async () => {
      await apiPost(`/identities/${encodeURIComponent(subTarget.id)}/subscription`, {
        subscriptionId: subSelectedId
      });
      const selected = subscriptions.find((item) => item.id === subSelectedId);
      setSubTarget(null);
      setSubSelectedId('');
      toast.success(`已为 ${subTarget.label} 绑定订阅：${selected?.label || subSelectedId}`);
      await load(true);
    });
  };

  const unsubscribe = () => {
    if (!unsubscribeTarget) return;
    void withAction('unsubscribe', async () => {
      await apiDelete(`/identities/${encodeURIComponent(unsubscribeTarget.id)}/subscription`);
      setUnsubscribeTarget(null);
      toast.success('已解除订阅绑定');
      await load(true);
    });
  };

  /** v2.27：先解绑订阅，再删除身份（用户明确确认后执行）。 */
  const unbindThenDelete = () => {
    const target = subscriptionBlockedTarget;
    if (!target) return;
    void withAction('unbind-then-delete', async () => {
      try {
        await apiDelete(`/identities/${encodeURIComponent(target.id)}/subscription`);
      } catch (err) {
        const apiError = err as ApiError;
        if (!apiError?.handled) {
          toast.error(apiError?.message || '解绑订阅失败，已中止删除');
        }
        return;
      }
      try {
        await apiDelete(`/identities/${encodeURIComponent(target.id)}`);
        toast.success(`已解绑订阅并删除 ${target.label}`);
      } catch (err) {
        const apiError = err as ApiError;
        if (apiError?.handled) return;
        toast.error(apiError?.message || '订阅已解绑，但删除身份失败（可能仍在设备列表）');
      }
      setSubscriptionBlockedTarget(null);
      await load(true);
    });
  };

  const renameDevice = () => {
    if (!renameDeviceTarget) return;
    const value = renameDeviceValue.trim();
    if (!value) {
      toast.warning('设备名不能为空');
      return;
    }
    void withAction('rename-device', async () => {
      try {
        await apiPatch(`/identities/${encodeURIComponent(renameDeviceTarget.id)}`, { deviceName: value });
        toast.success(`设备已重命名：${value}`);
        setRenameDeviceTarget(null);
        setRenameDeviceValue('');
        await load(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '重命名设备失败');
      }
    });
  };

  const deleteIdentity = (force: boolean) => {
    const target = force ? forceTarget : deleteTarget;
    if (!target) return;
    void withAction('delete', async () => {
      try {
        await apiDelete(`/identities/${encodeURIComponent(target.id)}${force ? '?force=true' : ''}`);
        setDeleteTarget(null);
        setForceTarget(null);
        toast.success(force ? `已强制删除 ${target.label}` : `已删除 ${target.label}`);
        await load(true);
      } catch (err) {
        const apiError = err as ApiError;
        if (apiError?.status === 409) {
          if (apiError.code === 'identity_has_subscription') {
            // v2.27：绑定了订阅的身份必须先解绑（等价于 duck.ai 退出登录）
            setDeleteTarget(null);
            setSubscriptionBlockedTarget(target);
            return;
          }
          if (apiError.code === 'identity_in_device_slots') {
            // 身份仍在设备列表中：提供「先去移除」/「移除设备并删除（force）」两个操作
            setDeleteTarget(null);
            setSlotsBlockedTarget(target);
            return;
          }
          if (apiError.code === 'default_identity_protected') {
            toast.error('默认身份不可删除：请先将其他身份设为默认后再删除。');
            setDeleteTarget(null);
            return;
          }
          // 被默认身份/会话绑定占用：提示并引导强制删除
          toast.error(apiError.message || '该身份仍为默认身份或已被会话绑定，需先解绑或强制删除。', { duration: 6000 });
          setDeleteTarget(null);
          setForceTarget(target);
          return;
        }
        handleError(err, '删除身份失败');
      }
    });
  };

  /** v2.32：手动解除额度冷却。 */
  const clearCooldown = (identity: IdentityPoolItem) => {
    void withAction(`cooldown-${identity.id}`, async () => {
      await apiDelete(`/identities/${encodeURIComponent(identity.id)}/cooldown`);
      toast.success(`已解除「${identity.label}」的额度冷却`);
      await load(true);
    });
  };

  const bindSession = () => {
    void withAction('bind', async () => {
      const sessionKey = bindSessionKey.trim();
      if (!sessionKey) {
        toast.warning('请填写 sessionKey');
        return;
      }
      if (!bindIdentityId) {
        toast.warning('请选择身份');
        return;
      }
      await apiPost('/identities/bindings', { sessionKey, identityId: bindIdentityId });
      setBindOpen(false);
      setBindSessionKey('');
      toast.success('会话已绑定身份');
      await load(true);
    });
  };

  const unbindSession = (binding: IdentityBindingItem) => {
    void withAction(`unbind-${binding.sessionKey}`, async () => {
      await apiDelete(`/identities/bindings/${encodeURIComponent(binding.sessionKey)}`);
      toast.success('已解绑（下次请求会重新路由）');
      await load(true);
    });
  };

  const changeStrategy = (strategy: string) => {
    void withAction('strategy', async () => {
      await apiPatch('/identities/router', { strategy });
      toast.success(`路由策略已切换为 ${strategy}`);
      await load(true);
    });
  };

  /** v2.30：保存会话绑定缓存天数（0 = 永不过期）。 */
  const saveBindingTtl = () => {
    const value = Number(bindingTtlDays);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      toast.error('会话绑定有效期需为 0 – 365 的整数（0 = 永不过期）');
      return;
    }
    setBindingTtlSaving(true);
    void (async () => {
      try {
        const result = await apiPut<{ bindingTtlDays?: number }>('/identities/settings', { bindingTtlDays: value });
        if (Number.isFinite(result?.bindingTtlDays)) setBindingTtlDays(String(result.bindingTtlDays));
        toast.success(value === 0 ? '已关闭自动过期（绑定永久保留）' : `会话绑定将在 ${value} 天未使用后自动解除`);
        await load(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as Error)?.message || '保存会话绑定设置失败');
      } finally {
        setBindingTtlSaving(false);
      }
    })();
  };

  const filteredBindings = useMemo(() => {
    const keyword = bindingFilter.trim().toLowerCase();
    if (!keyword) return bindings;
    return bindings.filter(
      (binding) =>
        binding.sessionKey.toLowerCase().includes(keyword) ||
        identityLabel(binding.identityId).toLowerCase().includes(keyword)
    );
  }, [bindings, bindingFilter, identityLabel]);

  // v2.30：分页（默认 5 行/页）
  const bindingPageCount = Math.max(1, Math.ceil(filteredBindings.length / bindingPageSize));
  const pagedBindings = useMemo(() => {
    const start = (Math.min(bindingPage, bindingPageCount) - 1) * bindingPageSize;
    return filteredBindings.slice(start, start + bindingPageSize);
  }, [filteredBindings, bindingPage, bindingPageCount, bindingPageSize]);

  const subscribedCount = pool?.subscribed ?? items.filter((item) => item.subscribed).length;
  const enabledCount = pool?.enabled ?? items.filter((item) => item.enabled).length;

  return (
    <div>
      <PageHeader
        title="身份池"
        description="匿名分身池、会话身份绑定、订阅绑定与路由策略"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="身份总数" value={formatNumber(pool?.total ?? items.length)} hint={`上限 ${pool?.maxIdentities ?? 20}`} icon={Users} tone="primary" />
        <StatTile label="已启用" value={formatNumber(enabledCount)} hint={`禁用 ${Math.max(0, (pool?.total ?? items.length) - enabledCount)}`} icon={BadgeCheck} tone="success" />
        <StatTile label="已订阅" value={formatNumber(subscribedCount)} hint="付费模型只路由到已订阅身份" icon={UserCheck} />
        <StatTile label="会话绑定" value={formatNumber(pool?.bindingCount ?? bindings.length)} hint="sessionKey → identity（持久化）" icon={Link2} tone="warning" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-3">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm">身份列表</CardTitle>
                <CardDescription className="text-xs">
                  默认身份：{pool?.activeId ? identityLabel(pool.activeId) : '—'} · 每身份独立 journeyId/密钥/队列（rps=1）
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {pool?.salt ? <Badge variant="outline">salt 已配置</Badge> : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load()}
                  disabled={loading || action !== null}
                  data-testid="identities-refresh"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                  刷新
                </Button>
                <Button size="sm" onClick={() => setCreateOpen(true)} disabled={action !== null} data-testid="identities-create">
                  <UserPlus className="h-3.5 w-3.5" />
                  新建
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setGenerateOpen(true)}
                  disabled={action !== null}
                  data-testid="identities-generate"
                >
                  <Users className="h-3.5 w-3.5" />
                  批量生成
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setImportOpen(true)}
                  disabled={action !== null}
                  data-testid="identities-import"
                >
                  <Upload className="h-3.5 w-3.5" />
                  导入身份
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading && items.length === 0 ? (
              <Skeleton className="h-48 rounded-xl" />
            ) : items.length === 0 ? (
              <EmptyState
                icon={Users}
                title="身份池为空"
                description="新建、批量生成或导入身份后，这里会显示分身列表。"
                action={
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    新建身份
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>设备名称</TableHead>
                    <TableHead>journeyId</TableHead>
                    <TableHead>指纹</TableHead>
                    <TableHead>订阅</TableHead>
                    <TableHead className="text-right">会话</TableHead>
                    <TableHead className="text-right">队列</TableHead>
                    <TableHead>最后使用</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} className={!item.enabled ? 'opacity-60' : undefined}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{identityDeviceName(item)}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label={`重命名设备 ${identityDeviceName(item)}`}
                            title="重命名设备"
                            onClick={() => {
                              setRenameDeviceTarget(item);
                              setRenameDeviceValue(identityDeviceName(item));
                            }}
                            disabled={action !== null}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <CopyButton value={identityDeviceName(item)} size="sm" variant="ghost" />
                          {item.active ? <Badge variant="default">默认 · 不可删除</Badge> : null}
                          {item.subscribed ? <Badge variant="info">已订阅</Badge> : null}
                          {item.cooling ? (
                            <Badge variant="destructive" className="gap-1" title="额度用完：冷却期间不参与路由，到期自动恢复">
                              <Clock className="h-3 w-3" />
                              额度冷却
                            </Badge>
                          ) : null}
                          {!item.enabled ? <Badge variant="muted">已禁用</Badge> : null}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {item.label} · {shortId(item.id, 10)}
                        </div>
                        {item.cooling && item.cooldownUntil ? (
                          <div
                            className="mt-0.5 text-[10px] text-destructive"
                            data-testid={`identity-cooldown-${item.id}`}
                          >
                            额度冷却至 {formatDateTime(item.cooldownUntil)}
                            {item.cooldownScope === 'account' ? '（账号额度）' : ''}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={item.journeyId}>
                        {shortId(item.journeyId, 10)}
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={item.fingerprint}>
                        {shortId(item.fingerprint, 10)}
                      </TableCell>
                      <TableCell>
                        {item.subscriptionId ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1 text-xs">
                              <Badge variant={item.subscriptionTier === 'pro' ? 'warning' : 'info'} className="text-[10px]">
                                {item.subscriptionTier === 'pro'
                                  ? 'Pro'
                                  : item.subscriptionTier === 'plus'
                                    ? 'Plus'
                                    : item.subscriptionTier || '订阅'}
                              </Badge>
                              <span className="max-w-[140px] truncate" title={item.subscriptionLabel || item.subscriptionId}>
                                {item.subscriptionLabel || item.subscriptionId}
                              </span>
                            </span>
                            {item.subscriptionExpiresAt ? (
                              <span className="text-[10px] text-muted-foreground">
                                到期 {item.subscriptionExpiresAt}
                              </span>
                            ) : null}
                            {(() => {
                              const usage = usageMap[item.id];
                              if (!usage || !usage.supported || !usage.windows || usage.windows.length === 0) return null;
                              return (
                                <div className="mt-1 space-y-1" data-testid={`identity-usage-${item.id}`}>
                                  {usage.windows.map((windowItem) => {
                                    const percent = Math.max(0, Math.min(100, Number(windowItem.percentUsed) || 0));
                                    const barColor =
                                      percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
                                    return (
                                      <div key={windowItem.id} className="w-[160px]">
                                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                          <span>{windowItem.label}</span>
                                          <span className="tabular-nums">{percent.toFixed(1)}%</span>
                                        </div>
                                        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                                          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
                                        </div>
                                        {windowItem.resetAt ? (
                                          <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                                            重置于 {formatDateTime(windowItem.resetAt)}
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs text-muted-foreground">未绑定</span>
                            {tierBadge(item.authTier, item.subscribed)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatNumber(item.sessions)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        <span title="执行中 / 排队">{item.queue?.inFlight ?? 0} / {item.queue?.waiting ?? 0}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {item.lastUsedAt ? formatRelative(item.lastUsedAt) : '从未使用'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-0.5">
                          {item.cooling
                            ? actionButton('解除冷却', <Clock className="h-3.5 w-3.5" />, () => clearCooldown(item), {
                                disabled: action !== null
                              })
                            : null}
                          {actionButton('设为默认', <Star className="h-3.5 w-3.5" />, () => activateIdentity(item), {
                            disabled: item.active || !item.enabled || action !== null
                          })}
                          {actionButton('轮换', <RefreshCw className="h-3.5 w-3.5" />, () => {
                            setRotateScope('all');
                            setRotateStep(1);
                            setRotateTarget(item);
                          }, { disabled: action !== null })}
                          {item.subscribed
                            ? actionButton('解除订阅', <UserCheck className="h-3.5 w-3.5" />, () => setUnsubscribeTarget(item), {
                                disabled: action !== null
                              })
                            : actionButton('绑定订阅', <KeyRound className="h-3.5 w-3.5" />, () => {
                                setSubSelectedId(item.subscriptionId || subscriptions[0]?.id || '');
                                setSubTarget(item);
                              }, { disabled: action !== null })}
                          {actionButton('导出', <Download className="h-3.5 w-3.5" />, () => exportIdentity(item), {
                            disabled: action !== null
                          })}
                          {actionButton(item.enabled ? '禁用' : '启用', <Pencil className="h-3.5 w-3.5" />, () => toggleIdentity(item), {
                            disabled: action !== null
                          })}
                          {actionButton('删除', <Trash2 className="h-3.5 w-3.5" />, () => setDeleteTarget(item), {
                            danger: true,
                            disabled: action !== null || item.active
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {pool && pool.total >= pool.maxIdentities ? (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">已达到身份池上限（{pool.maxIdentities}），请先删除部分身份。</p>
            ) : null}
          </CardContent>
        </Card>

        {/* ------------------------- 会话绑定 ------------------------- */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm">会话绑定</CardTitle>
                <CardDescription className="text-xs">
                  sessionKey → 身份；新会话按路由策略自动绑定并固定，手工绑定会覆盖。
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void load()}
                  disabled={loading || action !== null}
                  data-testid="bindings-refresh"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                  刷新
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBindOpen(true)} disabled={items.length === 0 || action !== null}>
                  <Link2 className="h-3.5 w-3.5" />
                  手工绑定
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={bindingFilter}
                placeholder="筛选 sessionKey / 身份标签"
                className="h-8 max-w-xs text-xs"
                onChange={(event) => {
                  setBindingFilter(event.target.value);
                  setBindingPage(1);
                }}
              />
              <span className="text-[11px] text-muted-foreground">{filteredBindings.length} 条</span>
            </div>
            {filteredBindings.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">暂无会话绑定</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>sessionKey</TableHead>
                    <TableHead>身份</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedBindings.map((binding) => (
                    <TableRow key={binding.sessionKey}>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs" title={binding.sessionKey}>
                        {binding.sessionKey}
                      </TableCell>
                      <TableCell className="max-w-[160px] truncate text-xs">{identityLabel(binding.identityId)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {binding.updatedAt ? formatDateTime(binding.updatedAt) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => unbindSession(binding)} disabled={action !== null}>
                          解绑
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {filteredBindings.length > 0 ? (
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  第 {Math.min(bindingPage, bindingPageCount)} / {bindingPageCount} 页 · 每页 {bindingPageSize} 条 ·
                  共 {filteredBindings.length} 条
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={bindingPage <= 1}
                    onClick={() => setBindingPage((page) => Math.max(1, page - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={bindingPage >= bindingPageCount}
                    onClick={() => setBindingPage((page) => Math.min(bindingPageCount, page + 1))}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* ------------------------- 会话绑定缓存设置（v2.30） ------------------------- */}
        <Card data-testid="identity-binding-settings">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="h-4 w-4" />
              会话绑定缓存
            </CardTitle>
            <CardDescription className="text-xs">
              绑定是缓存：超过设定天数未被使用会自动解除（下次请求重新路由）。0 = 永不过期。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="binding-ttl-days">有效期（天）</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="binding-ttl-days"
                  data-testid="binding-ttl-days"
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  className="h-8 w-24 text-xs"
                  value={bindingTtlDays}
                  onChange={(event) => setBindingTtlDays(event.target.value)}
                />
                <Button
                  size="sm"
                  onClick={saveBindingTtl}
                  disabled={bindingTtlSaving}
                  data-testid="binding-ttl-save"
                >
                  {bindingTtlSaving ? '保存中…' : '保存'}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">默认 7 天；网关每 10 分钟自动清理一次过期绑定。</p>
            </div>
          </CardContent>
        </Card>

        {/* ------------------------- 路由信息 ------------------------- */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Route className="h-4 w-4" />
              路由信息
            </CardTitle>
            <CardDescription className="text-xs">新会话按策略映射；salt 轮换只影响新绑定</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>路由策略</Label>
              <Select
                value={routing?.strategy || 'hash'}
                onValueChange={(value) => changeStrategy(value)}
                disabled={action !== null}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTE_STRATEGIES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant={routing?.saltPresent ? 'success' : 'warning'}>
                {routing?.saltPresent ? 'salt 已存在' : 'salt 缺失'}
              </Badge>
              <Badge variant="outline">每身份 rps=1 / 并发 1</Badge>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium">每身份队列</div>
              {routing?.perIdentity?.length ? (
                <div className="space-y-1">
                  {routing.perIdentity.map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[11px]">
                      <span className="max-w-[45%] truncate">{row.label || identityLabel(row.id)}</span>
                      <span className="tabular-nums text-muted-foreground">
                        执行 {row.inFlight ?? 0} · 排队 {row.waiting ?? 0} · 请求 {formatNumber(row.requests)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">暂无队列数据</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------ 对话框 ------------------------------ */}

      <Dialog open={createOpen} onOpenChange={(open) => (!action ? setCreateOpen(open) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建身份</DialogTitle>
            <DialogDescription>生成一份独立的 journeyId / RSA 密钥对（默认启用、未订阅）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="identity-label-input">标签</Label>
            <Input
              id="identity-label-input"
              value={createLabel}
              placeholder="例如：分身 1"
              maxLength={40}
              autoFocus
              onChange={(event) => setCreateLabel(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={action !== null}>
              取消
            </Button>
            <Button onClick={createIdentity} disabled={action !== null}>
              {action === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={generateOpen} onOpenChange={(open) => (!action ? setGenerateOpen(open) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量生成身份</DialogTitle>
            <DialogDescription>一次生成 1–20 个独立身份；journeyId / deviceId / 指纹互不相同。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="generate-count">数量（1–20）</Label>
              <Input
                id="generate-count"
                type="number"
                min={1}
                max={20}
                value={generateCount}
                onChange={(event) => setGenerateCount(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="generate-prefix">标签前缀</Label>
              <Input
                id="generate-prefix"
                value={generatePrefix}
                maxLength={20}
                onChange={(event) => setGeneratePrefix(event.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs">
            <span>
              生成后标记为已订阅
              <span className="ml-1 text-muted-foreground">（仅元数据，仍需绑定 token）</span>
            </span>
            <Switch checked={generateSubscribed} onCheckedChange={setGenerateSubscribed} aria-label="批量生成标记为已订阅" />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)} disabled={action !== null}>
              取消
            </Button>
            <Button onClick={generateIdentities} disabled={action !== null}>
              {action === 'generate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={(open) => (!action ? setImportOpen(open) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入身份</DialogTitle>
            <DialogDescription>粘贴导出的身份 JSON（含私钥/token），或选择文件；导入后作为新身份加入池。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="identity-import-file">选择身份 JSON 文件</Label>
              <Input
                id="identity-import-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => onImportFile(event.target.files?.[0] ?? null)}
              />
              {importFileName ? <p className="text-[11px] text-muted-foreground">已读取：{importFileName}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="identity-import-json">或粘贴 JSON</Label>
              <Textarea
                id="identity-import-json"
                rows={8}
                value={importText}
                spellCheck={false}
                placeholder='{"version":1,"identity":{...}}'
                onChange={(event) => setImportText(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={action !== null}>
              取消
            </Button>
            <Button onClick={importIdentity} disabled={action !== null || !importText.trim()}>
              {action === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bindOpen} onOpenChange={(open) => (!action ? setBindOpen(open) : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>手工绑定会话 → 身份</DialogTitle>
            <DialogDescription>覆盖该 sessionKey 的自动路由结果，后续请求固定走所选身份。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bind-session-key">sessionKey</Label>
              <Input
                id="bind-session-key"
                value={bindSessionKey}
                placeholder="例如：sess_123 或 X-Session-Id 值"
                onChange={(event) => setBindSessionKey(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>身份</Label>
              <Select value={bindIdentityId} onValueChange={setBindIdentityId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择身份" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}（{shortId(item.fingerprint, 6)}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindOpen(false)} disabled={action !== null}>
              取消
            </Button>
            <Button onClick={bindSession} disabled={action !== null}>
              {action === 'bind' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(subTarget)} onOpenChange={(open) => (!open && !action ? setSubTarget(null) : null)}>
        <DialogContent className="max-w-md" data-testid="identity-subscription-dialog">
          <DialogHeader>
            <DialogTitle>绑定订阅：{subTarget?.label}</DialogTitle>
            <DialogDescription>
              从「订阅」页已添加的订阅中选择一个绑定。一个订阅可以绑定多个身份；绑定后付费模型请求可路由到该身份
              （仍受 allowPaidModels 控制）。
            </DialogDescription>
          </DialogHeader>
          {subscriptions.length === 0 ? (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <p>还没有任何订阅。请先到「订阅」页新增 DuckDuckGo Plus/Pro 订阅，再回来绑定。</p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setSubTarget(null);
                  window.location.hash = '#/subscriptions';
                }}
              >
                前往「订阅」页
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="identity-sub-select">选择订阅</Label>
              <Select value={subSelectedId} onValueChange={setSubSelectedId}>
                <SelectTrigger id="identity-sub-select" data-testid="identity-subscription-select">
                  <SelectValue placeholder="选择一个订阅" />
                </SelectTrigger>
                <SelectContent>
                  {subscriptions.map((subscription) => (
                    <SelectItem key={subscription.id} value={subscription.id}>
                      <span className="flex items-center gap-2">
                        <span className="truncate">{subscription.label || subscription.id}</span>
                        <Badge variant={subscription.tier === 'pro' ? 'warning' : 'info'} className="text-[10px]">
                          {subscription.tier === 'plus' ? 'Plus' : subscription.tier === 'pro' ? 'Pro' : subscription.tier || 'free'}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {subscription.bindingCount ? `已绑 ${subscription.bindingCount}` : '未绑定'}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubTarget(null)} disabled={action !== null}>
              取消
            </Button>
            <Button
              onClick={bindSubscription}
              disabled={action !== null || !subSelectedId || subscriptions.length === 0}
              data-testid="identity-subscription-bind"
            >
              {action === 'subscribe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
              绑定订阅
            </Button>
          </DialogFooter>
        </DialogContent>
            </Dialog>

      <Dialog
        open={Boolean(renameDeviceTarget)}
        onOpenChange={(open) => {
          if (!open && action === null) {
            setRenameDeviceTarget(null);
            setRenameDeviceValue('');
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="pool-rename-device-dialog">
          <DialogHeader>
            <DialogTitle>重命名设备：{renameDeviceTarget?.label}</DialogTitle>
            <DialogDescription>
              修改该身份在 DuckDuckGo Sync 设备列表（My Devices）中的显示名称（默认身份为 DuckAI@main，
              其他身份默认为 DuckCPA@xxxx）。
            </DialogDescription>
          </DialogHeader>
          <Input
            data-testid="pool-rename-device-input"
            value={renameDeviceValue}
            onChange={(event) => setRenameDeviceValue(event.target.value)}
            placeholder="例如 DuckCPA@1a2b"
            maxLength={100}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDeviceTarget(null)} disabled={action !== null}>
              取消
            </Button>
            <Button data-testid="pool-rename-device-submit" onClick={() => void renameDevice()} disabled={action !== null}>
              {action === 'rename-device' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
              保存名称
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rotateTarget) && rotateStep === 1}
        onOpenChange={(open) => {
          if (action) return;
          if (!open) {
            setRotateTarget(null);
            setRotateStep(1);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="rotate-step1-dialog">
          <DialogHeader>
            <DialogTitle>轮换身份：{rotateTarget?.label}（第 1 / 2 步）</DialogTitle>
            <DialogDescription>重新生成 journeyId / deviceId / RSA 指纹，可能导致上游识别为新设备。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>轮换范围</Label>
            <Select value={rotateScope} onValueChange={(value) => setRotateScope(value as 'journey' | 'device' | 'all')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all（journey + device + 密钥）</SelectItem>
                <SelectItem value="journey">journey（仅访问旅程 id）</SelectItem>
                <SelectItem value="device">device（仅设备 id / 密钥）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="rotate-step1-cancel"
              onClick={() => {
                setRotateTarget(null);
                setRotateStep(1);
              }}
              disabled={action !== null}
            >
              取消
            </Button>
            <Button data-testid="rotate-continue" onClick={() => setRotateStep(2)} disabled={action !== null}>
              继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rotateTarget) && rotateStep === 2}
        onOpenChange={(open) => {
          if (action) return;
          if (!open) {
            setRotateTarget(null);
            setRotateStep(1);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="rotate-step2-dialog">
          <DialogHeader>
            <DialogTitle>确认轮换（不可恢复）</DialogTitle>
            <DialogDescription>此操作会直接替换该匿名身份，且无法撤销。</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              轮换会导致身份直接丢失（旧 journeyId / durableStream 密钥无法恢复，且无法找回）。
              该身份当前的会话绑定不会被清理，但后续请求可能失败。
            </span>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            目标：<span className="font-medium text-foreground">{rotateTarget?.label}</span> · 范围：
            <span className="font-mono text-foreground">{rotateScope}</span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="rotate-cancel"
              onClick={() => {
                setRotateTarget(null);
                setRotateStep(1);
              }}
              disabled={action !== null}
            >
              取消
            </Button>
            <Button variant="destructive" data-testid="rotate-confirm" onClick={rotateIdentity} disabled={action !== null}>
              {action === 'rotate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              确认轮换（不可恢复）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => (!open && !action ? setDeleteTarget(null) : null)}
        title={`删除身份「${deleteTarget?.label ?? ''}」？`}
        description="删除会移除该身份的密钥与统计（导出文件不受影响）。若该身份是默认身份或仍被会话绑定，会返回 409 需要强制删除。"
        confirmText="删除"
        destructive
        onConfirm={() => deleteIdentity(false)}
      />

      <ConfirmDialog
        open={Boolean(forceTarget)}
        onOpenChange={(open) => (!open && !action ? setForceTarget(null) : null)}
        title={`强制删除「${forceTarget?.label ?? ''}」？`}
        description="该身份仍为默认身份或存在会话绑定。强制删除会清除相关绑定，绑定会话下次请求将重新路由。"
        confirmText="强制删除"
        destructive
        onConfirm={() => deleteIdentity(true)}
      />

      <ConfirmDialog
        open={Boolean(subscriptionBlockedTarget)}
        onOpenChange={(open) => (!open && !action ? setSubscriptionBlockedTarget(null) : null)}
        title={`「${subscriptionBlockedTarget?.label ?? ''}」绑定了订阅`}
        description={
          <span className="space-y-1 text-xs">
            <span className="block">
              该身份当前绑定了订阅（Pro/Plus）。删除身份前需要先解绑订阅——在 duck.ai 里这等价于「退出登录」，
              解绑后该身份会回退为免费模型。
            </span>
            <span className="block text-muted-foreground">
              订阅实体本身不会被删除，仍可在「订阅」页看到并可绑定到其他身份。
            </span>
          </span>
        }
        confirmText={action === 'unbind-then-delete' ? '处理中…' : '解绑订阅并删除'}
        destructive
        onConfirm={unbindThenDelete}
      />

      <ConfirmDialog
        open={Boolean(unsubscribeTarget)}
        onOpenChange={(open) => (!open && !action ? setUnsubscribeTarget(null) : null)}
        title={`解除订阅绑定「${unsubscribeTarget?.label ?? ''}」？`}
        description="解除后该身份回到 free，付费模型请求不会再路由到它（除非重新绑定 token）。"
        confirmText="解除"
        destructive
        onConfirm={unsubscribe}
      />

      <Dialog
        open={Boolean(slotsBlockedTarget)}
        onOpenChange={(open) => (!open && !action ? setSlotsBlockedTarget(null) : null)}
      >
        <DialogContent className="max-w-md" data-testid="identity-slots-conflict-dialog">
          <DialogHeader>
            <DialogTitle>该身份正在设备列表中</DialogTitle>
            <DialogDescription>
              「{slotsBlockedTarget?.label}」当前在 DuckDuckGo 设备列表中，无法直接删除。请先在设备列表移除该设备，
              或选择「移除设备并删除身份」（会注销该设备，操作不可恢复）。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>直接删除会返回 409 <code>identity_in_device_slots</code>；force 删除会同时从设备槽移除并注销设备。</span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="go-device-list"
              onClick={goToDeviceList}
              disabled={action !== null}
            >
              先去设备列表移除
            </Button>
            <Button
              variant="destructive"
              data-testid="force-delete-identity"
              onClick={() => {
                setForceSlotsTarget(slotsBlockedTarget);
                setSlotsBlockedTarget(null);
              }}
              disabled={action !== null}
            >
              移除设备并删除（force）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(forceSlotsTarget)}
        onOpenChange={(open) => (!open && !action ? setForceSlotsTarget(null) : null)}
        title={`移除设备并删除「${forceSlotsTarget?.label ?? ''}」？`}
        description="将从 DuckDuckGo 设备列表移除该设备并删除身份；设备可能因此被注销，此操作不可恢复。"
        confirmText="强制删除并注销设备"
        destructive
        onConfirm={forceDeleteFromSlots}
      />
    </div>
  );
}
