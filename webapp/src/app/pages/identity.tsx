import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CloudOff,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  GripVertical,
  KeyRound,
  Laptop,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  MoreVertical,
  PlugZap,
  QrCode,
  RefreshCw,
  Pencil,
  PencilLine,
  Save,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  UserCheck,
  UserPlus
} from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, downloadFile, downloadTextFile, ApiError } from '@/app/lib/api';
import { makeQrDataUrl, downloadDataUrl } from '@/app/lib/qr';
import { formatDateTime, formatNumber, formatRelative } from '@/app/lib/format';
import type {
  DeviceSlotsResponse,
  DeviceSlotsSaveResponse,
  IdentitiesResponse,
  IdentityPoolItem,
  IdentityRotateResponse,
  IdentityState,
  OfficialRecoveryCodeInfo,
  OfficialRecoveryCodeResponse,
  RecoveryCodeResponse,
  RegisterDeviceResponse,
  ServerDevice,
  ServerDevicesResponse,
  SubscriptionInfo,
  SubscriptionResponse,
  SyncEnableResponse,
  SyncPairingResponse,
  SyncPairingSession,
  SyncResponse,
  SyncState
} from '@/app/lib/types';
import { useOverview } from '@/app/lib/overview-context';
import { PageHeader } from '@/app/components/page-header';
import { ErrorBanner } from '@/app/components/error-banner';
import { CopyButton } from '@/app/components/copy-button';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type RotateScope = 'journey' | 'device' | 'all';

const PAIRING_TERMINAL_STATES = new Set(['completed', 'failed', 'timeout', 'aborted', 'idle']);

const PAIRING_STATE_LABELS: Record<string, string> = {
  waiting: '等待另一台设备扫描…',
  hello: '手机已连接，正在握手…',
  exchange: '已连接，正在交换密钥…',
  completed: '配对完成',
  failed: '配对失败',
  timeout: '配对超时',
  aborted: '配对已停止',
  idle: '空闲'
};

/** v2.15：按 state+substate 给出「现在该在手机上做什么」的明确提示，避免扫码后页面毫无反馈。 */
function pairingPhaseHint(session: {
  state?: string | null;
  substate?: string | null;
  completedAs?: string | null;
  accountMerged?: boolean;
} | null): string | null {
  if (!session) return null;
  const { state, substate } = session;
  if (state === 'waiting') return '请用手机 DuckDuckGo → Sync & Backup → 扫描上方二维码';
  if (state === 'hello') return '手机已连接，正在建立加密通道…';
  if (state === 'exchange') {
    if (substate === 'joiner_awaiting' || substate === 'confirmed_requesting_code') {
      return '手机已扫码 ✅ 请回到手机，在 DuckDuckGo 弹窗中点击「允许 / 确认配对」';
    }
    if (substate === 'host_available' || substate === 'host_requested') {
      return '已连接，等待手机端确认账号…（如手机弹出提示，请点允许）';
    }
    return '已连接，正在交换密钥…（如手机弹出确认，请点允许）';
  }
  if (state === 'completed') {
    return session.accountMerged
      ? '配对成功：网关与手机已合并到同一个 DuckDuckGo 账号'
      : '配对成功';
  }
  return null;
}

const PAIRING_FAILURE_HINTS: Record<string, string> = {
  unavailable:
    '手机端账号信息不可用（可能手机已有账号或未开启 Sync）。可重试；若仍失败，可手动粘贴官方恢复码后再试。',
  same_account: '该手机与网关已是同一个 DuckDuckGo 账号，无需重复配对，可直接在手机上使用。',
  denied: '手机端拒绝了配对请求，请在手机上重新确认或重新生成二维码。',
  aborted: '配对已被主动停止，可点击「重新生成」重新开始。',
  timeout: '等待手机响应超时（长时间无活动或超过会话有效期），请重新生成二维码。',
  network: '与 DuckDuckGo Sync 服务的连接中断，请检查「代理」页的出站代理后重试。',
  read_channel_lost: '读频道失败（频道已被服务端回收），请重新生成二维码。',
  write_channel_lost: '写频道失败（握手消息未送达），请重新生成二维码。',
  sequence_gap: '握手消息序号异常，已终止本次配对，请重新生成二维码。',
  protocol_violation: '握手协议不匹配（可能是客户端版本差异），请更新 DuckDuckGo App 后重试。',
  version_mismatch: '配对协议版本不匹配，请更新 DuckDuckGo App 后重试。',
  peer_key_changed: '对端密钥发生变化（可能重复扫码），请重新生成二维码。',
  self_scan: '不能扫描本机生成的二维码，请使用另一台设备扫描。',
  pairing_start_failed: '无法向 DuckDuckGo Sync 服务注册频道，请检查代理后重试。'
};

function pairingFailureHint(reason: string | null | undefined): string {
  if (reason && PAIRING_FAILURE_HINTS[reason]) return PAIRING_FAILURE_HINTS[reason];
  return reason ? `配对失败（${reason}），可点击「重新生成」重试。` : '配对失败，可点击「重新生成」重试。';
}

function pairingCompletedText(completedAs: string | null | undefined): string {
  if (completedAs === 'joiner') return '已从手机导入官方恢复码并完成配对';
  if (completedAs === 'host') return '已向另一台设备提供恢复码并完成配对';
  return '配对完成，手机端已成功握手';
}

/** DuckDuckGo Sync 418→429 限流：优先使用后端 retryAfterMs 换算秒数。 */
function isSyncRateLimited(err: unknown): boolean {
  const apiError = err as ApiError;
  return apiError?.status === 429 || apiError?.code === 'sync_rate_limited';
}

function syncRateLimitSeconds(err: unknown): number {
  const apiError = err as ApiError;
  const payload = apiError?.payload as Record<string, unknown> | null | undefined;
  const errorObject = payload?.error as Record<string, unknown> | null | undefined;
  const retryAfterMs = Number(
    errorObject?.retryAfterMs ??
      payload?.retryAfterMs ??
      (apiError as unknown as { retryAfterMs?: number })?.retryAfterMs
  );
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.max(1, Math.ceil(retryAfterMs / 1000));
  return 60;
}

function pairingStateVariant(state: string | undefined): 'success' | 'warning' | 'destructive' | 'muted' | 'info' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'destructive';
  if (state === 'timeout') return 'warning';
  if (state === 'hello' || state === 'exchange') return 'info';
  if (state === 'waiting') return 'warning';
  return 'muted';
}

function extractRecoveryCode(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.code === 'string') return obj.code;
    if (typeof obj.recoveryCode === 'string') return obj.recoveryCode;
  }
  return '';
}

function handleActionError(error: unknown, fallback: string): void {
  if ((error as ApiError)?.handled) return;
  const apiError = error as ApiError;
  const code = apiError?.code;
  if (apiError?.status === 503 || code === 'sync_transport_unavailable') {
    toast.error('当前环境无法访问 duckduckgo.com（sync 传输不可用），仅本地能力可用。', { duration: 7000 });
    return;
  }
  if (apiError?.status === 409) {
    if (code === 'identity_busy') {
      toast.error('身份操作正在进行中（可能存在并发轮换/导入），请稍后重试。');
      return;
    }
    if (code === 'sync_not_enabled') {
      toast.error('Sync & Backup 尚未启用，请先打开开关生成密钥。');
      return;
    }
    toast.error(apiError.message || '操作冲突，请刷新后重试');
    return;
  }
  if (apiError?.status === 422) {
    if (code === 'token_invalid') {
      toast.error('token 格式无效，请粘贴 DuckDuckGo 登录后的完整 token。');
      return;
    }
    if (code === 'token_expired') {
      toast.error('token 已过期，请从 DuckDuckGo 重新获取后粘贴。');
      return;
    }
    toast.error(`校验失败：${apiError.message || '数据格式不正确'}`);
    return;
  }
  if (apiError?.status === 400) {
    if (code === 'confirmation_required') {
      toast.error('该操作需要二次确认（confirm=true）。');
      return;
    }
    toast.error(`参数无效：${apiError.message || '请检查输入'}`);
    return;
  }
  toast.error(apiError?.message || fallback);
}

function TierBadge({ tier }: { tier: string | null | undefined }) {
  const normalized = (tier || 'free').toLowerCase();
  if (normalized === 'pro') {
    return (
      <Badge variant="accent" className="uppercase">
        {normalized}
      </Badge>
    );
  }
  if (normalized === 'plus') {
    return (
      <Badge variant="info" className="uppercase">
        {normalized}
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className="uppercase">
      free
    </Badge>
  );
}

function ValueRow({
  label,
  value,
  mono = false,
  copyable = true
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  const display = value || '—';
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate text-xs', mono && 'font-mono')} title={display}>
          {display}
        </span>
        {copyable && display !== '—' ? (
          <CopyButton value={display} size="sm" variant="ghost" label="" className="h-6 w-6 px-0" />
        ) : null}
      </div>
    </div>
  );
}

export function IdentityPage() {
  const { refresh: refreshOverview } = useOverview();

  const [identity, setIdentity] = useState<IdentityState | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateStep, setRotateStep] = useState<1 | 2>(1);
  const [rotateScope, setRotateScope] = useState<RotateScope>('all');
  const [rotateNote, setRotateNote] = useState<string | null>(null);
  const [deviceNameInput, setDeviceNameInput] = useState('');
  const deviceNameDirtyRef = useRef(false);
  const [deviceNameSaving, setDeviceNameSaving] = useState(false);
  const [serverDevices, setServerDevices] = useState<ServerDevice[]>([]);
  const [serverDevicesLoading, setServerDevicesLoading] = useState(false);
  const [serverDevicesError, setServerDevicesError] = useState<string | null>(null);
  const [registeringDevice, setRegisteringDevice] = useState(false);
  const [removeDeviceTarget, setRemoveDeviceTarget] = useState<ServerDevice | null>(null);
  const [poolIdentities, setPoolIdentities] = useState<IdentityPoolItem[]>([]);
  const [pendingSlotIds, setPendingSlotIds] = useState<string[]>([]);
  const [savedSlotIds, setSavedSlotIds] = useState<string[]>([]);
  const [slotsLoaded, setSlotsLoaded] = useState(false);
  const [slotsSaving, setSlotsSaving] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<Array<unknown>>([]);
  const [reconcilingSlots, setReconcilingSlots] = useState(false);
  const [dragOverSide, setDragOverSide] = useState<'left' | 'right' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string>('');
  const [disableSyncOpen, setDisableSyncOpen] = useState(false);
  const [logoutSubOpen, setLogoutSubOpen] = useState(false);

  const [pairSession, setPairSession] = useState<SyncPairingSession | null>(null);
  // v2.16: Sync 模式（backup | syncOnly）与「删除 Sync & Backup 数据」二次确认
  const [deleteSyncOpen, setDeleteSyncOpen] = useState(false);
  // v2.17: "Sync This Device Only" 弹窗
  const [createOwnOpen, setCreateOwnOpen] = useState(false);
  // v2.18: 设备二级菜单（重命名 / 删除）
  const [renameDeviceTarget, setRenameDeviceTarget] = useState<{ id: string; name: string; identityId?: string | null } | null>(null);
  const [renameDeviceValue, setRenameDeviceValue] = useState('');
  const [deleteSyncConfirmText, setDeleteSyncConfirmText] = useState('');
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [pairInput, setPairInput] = useState('');
  const [officialCode, setOfficialCode] = useState<OfficialRecoveryCodeInfo | null>(null);
  const [officialCodeFromPairing, setOfficialCodeFromPairing] = useState(false);
  const [officialCodeInput, setOfficialCodeInput] = useState('');
  const [officialCodeVisible, setOfficialCodeVisible] = useState(false);
  const [officialCodeSaving, setOfficialCodeSaving] = useState(false);
  const [officialCodeDownloading, setOfficialCodeDownloading] = useState(false);
  const [officialQrOpen, setOfficialQrOpen] = useState(false);
  const [officialQrDataUrl, setOfficialQrDataUrl] = useState('');
  const [officialQrLoading, setOfficialQrLoading] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      apiGet<IdentityState>('/identity'),
      apiGet<SyncResponse>('/sync'),
      apiGet<SubscriptionResponse>('/subscription'),
      apiGet<OfficialRecoveryCodeResponse>('/sync/official-recovery-code'),
      apiGet<IdentitiesResponse>('/identities')
    ]);
    const messages: string[] = [];
    const [identityResult, syncResult, subscriptionResult, officialCodeResult, poolResult] = results;
    if (identityResult.status === 'fulfilled') {
      setIdentity(identityResult.value);
    } else if (!(identityResult.reason as ApiError)?.handled) {
      messages.push((identityResult.reason as Error)?.message || '身份信息加载失败');
    }
    if (syncResult.status === 'fulfilled') {
      setSync(syncResult.value?.sync ?? null);
      const effectiveName =
        syncResult.value?.sync?.deviceName ||
        (identityResult.status === 'fulfilled' ? identityResult.value?.identity?.deviceName : '') ||
        '';
      if (!deviceNameDirtyRef.current) setDeviceNameInput(effectiveName);
    } else if (!(syncResult.reason as ApiError)?.handled) {
      messages.push((syncResult.reason as Error)?.message || 'Sync 状态加载失败');
    }
    if (subscriptionResult.status === 'fulfilled') {
      setSubscription(subscriptionResult.value?.subscription ?? null);
    } else if (!(subscriptionResult.reason as ApiError)?.handled) {
      messages.push((subscriptionResult.reason as Error)?.message || '订阅状态加载失败');
    }
    if (officialCodeResult.status === 'fulfilled') {
      setOfficialCode(officialCodeResult.value?.officialRecoveryCode ?? null);
    } else if (!(officialCodeResult.reason as ApiError)?.handled) {
      const reason = officialCodeResult.reason as ApiError;
      // 旧后端未实现该端点时静默降级
      if (reason?.status !== 404 && reason?.code !== 'not_found') {
        setOfficialCode(null);
      }
    }
    if (messages.length > 0) setError(messages.join('；'));
    if (poolResult.status === 'fulfilled') {
      setPoolIdentities(Array.isArray(poolResult.value?.items) ? poolResult.value.items : []);
    } else if (!(poolResult.reason as ApiError)?.handled) {
      // 旧后端/未实现身份池时静默降级
    }
    if (!silent) setLoading(false);
  }, []);

  const loadServerDevices = useCallback(async (silent = false) => {
    if (!silent) setServerDevicesLoading(true);
    setServerDevicesError(null);
    try {
      const response = await apiGet<ServerDevicesResponse>('/sync/server-devices');
      const items = Array.isArray(response?.devices)
        ? response.devices
        : Array.isArray(response?.items)
          ? response.items
          : [];
      setServerDevices(items);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      if (isSyncRateLimited(err)) {
        setServerDevicesError(`DuckDuckGo Sync 限流中，请 ${syncRateLimitSeconds(err)} 秒后重试`);
        return;
      }
      const apiError = err as ApiError;
      setServerDevicesError(apiError?.message || 'DuckDuckGo 设备列表加载失败');
    } finally {
      if (!silent) setServerDevicesLoading(false);
    }
  }, []);

  const loadDeviceSlots = useCallback(async (silent = false) => {
    if (!silent) setSlotsLoaded(false);
    setSlotsError(null);
    try {
      const response = await apiGet<DeviceSlotsResponse>('/sync/device-slots');
      const raw = Array.isArray(response?.identityIds)
        ? response.identityIds
        : Array.isArray(response?.slots)
          ? response.slots
              .map((slot) => (typeof slot === 'string' ? slot : slot?.identityId || slot?.id || ''))
              .filter(Boolean)
          : [];
      const ids = [...new Set(raw)];
      const orphanList = Array.isArray(response?.orphans) ? response.orphans : [];
      setOrphans(orphanList);
      const activeId = poolIdentities.find((item) => item.active)?.id || poolIdentities[0]?.id;
      const initial = ids.length > 0 ? ids : activeId ? [activeId] : [];
      setSavedSlotIds(ids.length > 0 ? ids : []);
      setPendingSlotIds(initial);
      setSlotsLoaded(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      if (isSyncRateLimited(err)) {
        setSlotsError(`DuckDuckGo Sync 限流中，请 ${syncRateLimitSeconds(err)} 秒后重试`);
      } else {
        setSlotsError((err as Error)?.message || '设备槽位加载失败');
      }
      setSlotsLoaded(true);
    }
  }, [poolIdentities]);

  const identityDeviceName = useCallback(
    (item: IdentityPoolItem | null | undefined): string => {
      if (!item) return '';
      if (item.deviceName) return item.deviceName;
      if (item.active) return 'DuckAI@main';
      return item.label || item.id;
    },
    []
  );

  // v2.11：官方恢复码二维码（本地 qrcode，内容 = 完整官方恢复码）
  useEffect(() => {
    let cancelled = false;
    const code = officialCode?.code;
    if (!officialQrOpen || !code) {
      setOfficialQrDataUrl('');
      return;
    }
    setOfficialQrLoading(true);
    void makeQrDataUrl(code, 280)
      .then((dataUrl) => {
        if (!cancelled) setOfficialQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setOfficialQrDataUrl('');
      })
      .finally(() => {
        if (!cancelled) setOfficialQrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [officialQrOpen, officialCode?.code]);

  useEffect(() => {
    void load();
  }, [load]);

  // 从身份池「先去设备列表移除」跳转过来时，滚动到设备列表卡片
  useEffect(() => {
    if (!window.sessionStorage.getItem('duckai_focus_device_list')) return;
    window.sessionStorage.removeItem('duckai_focus_device_list');
    const timer = window.setTimeout(() => {
      document.getElementById('ddg-device-list-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (sync?.enabled) {
      void loadServerDevices(true);
      void loadDeviceSlots(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.enabled]);

  // 配对 URL 本地生成二维码（qrcode.toDataURL → data:image/png;base64，不请求外部服务）
  useEffect(() => {
    let cancelled = false;
    const url = pairSession?.qrUrl || pairSession?.url;
    if (!url) {
      setQrDataUrl('');
      return;
    }
    try {
      QRCode.toDataURL(
        url,
        { width: 220, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } },
        (error, dataUrl) => {
          if (cancelled) return;
          if (!error && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png')) {
            setQrDataUrl(dataUrl);
          } else {
            setQrDataUrl('');
          }
        }
      );
    } catch {
      setQrDataUrl('');
    }
    return () => {
      cancelled = true;
    };
  }, [pairSession?.qrUrl, pairSession?.url]);

  // 打开配对会话期间每 1.5s 轮询真实握手状态（waiting → hello → exchange → completed/failed/timeout）
  useEffect(() => {
    if (!pairSession?.channelId) return;
    if (PAIRING_TERMINAL_STATES.has(pairSession.state ?? '')) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await apiGet<SyncPairingResponse>('/sync/pairing');
        const nextStatus = response?.pairing;
        if (cancelled || !nextStatus) return;
        setPairSession((previous) => (previous ? { ...previous, ...nextStatus } : nextStatus));
        setPairingError(null);
      } catch (err) {
        if (cancelled || (err as ApiError)?.handled) return;
        const apiError = err as ApiError;
        setPairingError(apiError?.message || '配对状态查询失败，可点击重试');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pairSession?.channelId, pairSession?.state]);

  useEffect(() => {
    if (pairSession?.state !== 'completed') return;
    toast.success(
      `配对完成：已${pairSession.completedAs === 'joiner' ? '从手机导入账号' : '向手机提供账号'}${
        pairSession.accountMerged ? '（两端已同账号）' : ''
      }`
    );
    // 完成后刷新官方恢复码状态（joiner 模式下手机下发的码会被后端落盘）
    void (async () => {
      try {
        const response = await apiGet<OfficialRecoveryCodeResponse>('/sync/official-recovery-code');
        const info = response?.officialRecoveryCode;
        if (info) {
          setOfficialCode(info);
          setOfficialCodeFromPairing(info.configured === true);
        }
      } catch {
        /* 旧后端无该端点时忽略 */
      }
    })();
    // 完成后刷新 Sync server 信息与 DuckDuckGo 设备列表（joiner 会注册本机设备）
    void load(true);
    void loadServerDevices(true);
    if (pairSession.completedAs === 'joiner') {
      toast.success('已注册到 DuckDuckGo 设备列表，手机 My Devices 中可看到');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairSession?.state]);

  // 离开身份页时停止仍在等待的配对 host，避免频道悬挂（终态不重复 stop）
  const pairSessionRef = useRef<SyncPairingSession | null>(null);
  pairSessionRef.current = pairSession;
  useEffect(() => {
    return () => {
      const current = pairSessionRef.current;
      if (current?.channelId && !PAIRING_TERMINAL_STATES.has(current.state ?? '')) {
        void apiDelete('/sync/pairing').catch(() => {
          /* 忽略卸载时的清理失败 */
        });
      }
    };
  }, []);

  const withAction = async (key: string, fn: () => Promise<void>) => {
    if (action) return;
    setAction(key);
    try {
      await fn();
    } catch (err) {
      handleActionError(err, '操作失败，请重试');
    } finally {
      setAction(null);
    }
  };

  /* ------------------------------ 身份 ------------------------------ */

  const openRotateDialog = () => {
    setRotateStep(1);
    setRotateOpen(true);
    setRotateNote(null);
  };

  const rotateIdentity = () => {
    void withAction('rotate', async () => {
      try {
        // 仅第二步（二次确认）才会调用 API
        const response = await apiPost<IdentityRotateResponse>('/identity/rotate', { scope: rotateScope });
        setRotateOpen(false);
        setRotateStep(1);
        if (response?.identityLost) {
          const note = response.note || '旧 journeyId / durableStream 密钥已丢失，无法恢复';
          setRotateNote(note);
          toast.warning(`身份已丢失，原匿名身份不可恢复：${note}`, { duration: 9000 });
        } else {
          setRotateNote(response?.note || null);
          toast.success(response?.note || '身份已轮换（journeyId / deviceId 已更新）');
        }
        await load(true);
        if (sync?.enabled) await loadServerDevices(true);
      } catch (err) {
        handleActionError(err, '轮换身份失败');
      }
    });
  };

  const saveDeviceName = async () => {
    const value = deviceNameInput.trim();
    setDeviceNameSaving(true);
    try {
      await apiPut('/config', { identity: { deviceName: value || null } });
      deviceNameDirtyRef.current = false;
      toast.success(value ? `设备名称已保存：${value}` : '已恢复默认设备名称（DuckCPA@xxxx）');
      await load(true);
      if (sync?.enabled) await loadServerDevices(true);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '保存设备名称失败');
    } finally {
      setDeviceNameSaving(false);
    }
  };

  const registerDeviceError = (err: unknown): string => {
    const apiError = err as ApiError;
    if (isSyncRateLimited(err)) {
      return `DuckDuckGo Sync 限流中，请 ${syncRateLimitSeconds(err)} 秒后重试`;
    }
    if (apiError?.status === 503 || apiError?.code === 'sync_transport_unavailable') {
      return '无法访问 duckduckgo.com：请先在「代理」页启用代理；若尚未配置官方恢复码，请先完成扫码配对或手动填写。';
    }
    if (apiError?.code === 'recovery_code_required' || apiError?.code === 'official_recovery_code_required') {
      return '未配置官方恢复码：请先完成扫码配对，或在下方手动填写 DuckDuckGo 官方恢复码。';
    }
    if (apiError?.status === 409) return apiError.message || '设备已注册或状态冲突，请刷新后重试。';
    if (apiError?.status === 400) return apiError.message || '注册参数无效，请检查设备名称与同步状态。';
    return apiError?.message || '注册本机到 DuckDuckGo 设备列表失败';
  };

  const registerDevice = () => {
    void withAction('register-device', async () => {
      setRegisteringDevice(true);
      try {
        const response = await apiPost<RegisterDeviceResponse>('/sync/register-device', {});
        toast.success(response?.message || '已注册到 DuckDuckGo Sync 设备列表');
        await load(true);
        await loadServerDevices(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error(registerDeviceError(err), { duration: 7000 });
      } finally {
        setRegisteringDevice(false);
      }
    });
  };

  const adoptPhoneAccount = () => {
    void withAction('adopt-account', async () => {
      try {
        const result = await apiPost<{ ok?: boolean; accountUserId?: string | null }>(
          '/sync/pairing/adopt-account',
          {}
        );
        toast.success(
          `已把网关切换到手机账号（${String(result?.accountUserId || '').slice(0, 8)}…），正在重新注册本机设备…`,
          { duration: 6000 }
        );
        // 账号已切换：清掉旧账号缓存并重新注册本机设备 + 恢复设备槽
        await load(true).catch(() => {});
        await apiPost('/sync/register-device', {}).catch(() => {});
        await apiPut('/sync/device-slots', { identityIds: ['id_default'] }).catch(() => {});
        await Promise.all([load(true).catch(() => {}), loadDeviceSlots(true).catch(() => {}), loadServerDevices(true).catch(() => {})]);
        toast.success('已切换到手机账号并注册本机设备（DuckAI@main）');
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '切换账号失败');
      }
    });
  };

  const deleteServerDevice = () => {
    if (!removeDeviceTarget) return;
    const target = removeDeviceTarget;
    void withAction('delete-device', async () => {
      try {
        // v2.13：当前设备（默认身份 DuckAI@main）也允许删除；后端要求显式 confirm，
        // 注销设备但保留本机身份、配对账号与官方恢复码，可随时重新注册。
        await apiDelete(
          `/sync/server-devices/${encodeURIComponent(target.id)}${target.current ? '?force=true' : ''}`
        );
        toast.success(`已从 DuckDuckGo 设备列表注销：${target.name || target.id}`);
        setRemoveDeviceTarget(null);
        await Promise.all([loadServerDevices(true), loadDeviceSlots(true)]);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        const apiError = err as ApiError;
        const message =
          apiError?.status === 404
            ? '该设备已不在 DuckDuckGo 设备列表中（可能已在别处注销）。'
            : apiError?.status === 429
              ? 'DuckDuckGo Sync 限流中，请稍后重试。'
              : apiError?.message || '删除设备失败';
        toast.error(message);
        if (apiError?.status === 404) {
          setRemoveDeviceTarget(null);
          await loadServerDevices(true);
        }
      }
    });
  };

  /* ---------------------- 设备槽位（拖拽两栏，v2.9） ---------------------- */

  const poolById = (id: string): IdentityPoolItem | null => poolIdentities.find((item) => item.id === id) || null;
  const leftPoolIdentities = poolIdentities
    .filter((item) => !pendingSlotIds.includes(item.id))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  const rightSlotIdentities = pendingSlotIds
    .map((id) => poolById(id))
    .filter((item): item is IdentityPoolItem => Boolean(item));
  const deviceSlotsDirty = JSON.stringify(pendingSlotIds) !== JSON.stringify(savedSlotIds);

  const addSlot = (identityId: string) => {
    setPendingSlotIds((previous) => (previous.includes(identityId) ? previous : [...previous, identityId]));
    setSlotsError(null);
  };
  const removeSlot = (identityId: string) => {
    setPendingSlotIds((previous) => previous.filter((id) => id !== identityId));
    setSlotsError(null);
  };
  const onSlotDragStart = (event: ReactDragEvent<HTMLDivElement>, identityId: string) => {
    event.dataTransfer?.setData('text/plain', identityId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  const onSlotDrop = (side: 'left' | 'right') => (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOverSide(null);
    const identityId = event.dataTransfer?.getData('text/plain');
    if (!identityId) return;
    if (side === 'right') addSlot(identityId);
    else removeSlot(identityId);
  };

  const saveDeviceSlots = () => {
    void withAction('save-slots', async () => {      setSlotsSaving(true);
      setSlotsError(null);
      try {
        await apiPut<DeviceSlotsSaveResponse>('/sync/device-slots', { identityIds: pendingSlotIds });
        setSavedSlotIds([...pendingSlotIds]);
        toast.success('设备槽位已保存并生效');
        await load(true);
        await loadDeviceSlots(true);
        await loadServerDevices(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        const message = isSyncRateLimited(err)
          ? `DuckDuckGo Sync 限流中，请 ${syncRateLimitSeconds(err)} 秒后重试`
          : (err as ApiError)?.status === 409
            ? (err as ApiError).message || '设备槽位状态冲突，请刷新后重试。'
            : (err as ApiError)?.status === 400
              ? (err as ApiError).message || '设备槽位参数无效。'
              : (err as Error)?.message || '保存设备槽位失败';
        setSlotsError(message);
        toast.error(message, { duration: 7000 });
      } finally {
        setSlotsSaving(false);
      }
    });
  };

  const reconcileDeviceSlots = () => {
    void withAction('reconcile-slots', async () => {
      setReconcilingSlots(true);
      try {
        const response = await apiPut<DeviceSlotsResponse>('/sync/device-slots?reconcile=true', {});
        const remaining = Array.isArray(response?.orphans) ? response.orphans : [];
        setOrphans(remaining);
        toast.success('已清理失效身份的设备');
        await loadDeviceSlots(true);
        await loadServerDevices(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        const message = isSyncRateLimited(err)
          ? `DuckDuckGo Sync 限流中，请 ${syncRateLimitSeconds(err)} 秒后重试`
          : (err as Error)?.message || '清理失效设备失败';
        setSlotsError(message);
        toast.error(message, { duration: 7000 });
      } finally {
        setReconcilingSlots(false);
      }
    });
  };

  const serverDeviceForIdentity = (identity: IdentityPoolItem): ServerDevice | null => {
    const name = identityDeviceName(identity);
    return (
      serverDevices.find((device) => (device.name || '').trim() === name.trim()) ||
      (identity.active ? serverDevices.find((device) => device.thisDevice || device.local || device.current) : null) ||
      null
    );
  };

  const serverOnlyDevices = serverDevices.filter(
    (device) =>
      !pendingSlotIds.some((id) => {
        const identity = poolById(id);
        if (!identity) return false;
        if (identityDeviceName(identity).trim() === (device.name || '').trim()) return true;
        return identity.active && (device.thisDevice === true || device.local === true || device.current === true);
      })
  );

  const exportIdentity = () => {
    void withAction('export', async () => {
      const filename = await downloadFile('/identity/export', 'duckai-identity.json');
      toast.success(`已导出 ${filename}`);
    });
  };

  const importIdentity = () => {
    void withAction('import', async () => {
      const text = importText.trim();
      if (!text) {
        toast.warning('请粘贴身份 JSON 或选择身份文件');
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
      await apiPost('/identity/import', { identity: payload });
      setImportOpen(false);
      setImportText('');
      setImportFileName('');
      toast.success('身份文件已导入');
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

  /* ---------------------------- Sync ---------------------------- */

  const enableSync = () => {
    void withAction('sync-enable', async () => {
      const response = await apiPost<SyncEnableResponse>('/sync/enable', {});
      setSync(response.sync);
      const code = extractRecoveryCode(response.recoveryCode);
      if (code) {
        setRecoveryCode(code);
        setRecoveryOpen(true);
      }
      toast.success('Sync & Backup 已启用');
      await load(true);
    });
  };

  const disableSync = () => {
    void withAction('sync-disable', async () => {
      const response = await apiPost<SyncResponse & { ok?: boolean }>('/sync/disable', {});
      setSync(response.sync);
      setPairSession(null);
      setQrDataUrl('');
      setDisableSyncOpen(false);
      toast.success('Sync & Backup 已停用');
      await load(true);
    });
  };

  // v2.18: 重命名设备（对应 DuckDuckGo My Devices 二级菜单的 Rename）
  const renameDevice = () => {
    if (!renameDeviceTarget) return;
    const target = renameDeviceTarget;
    if (!target.identityId) {
      toast.error('该设备没有对应的本地身份，无法重命名');
      return;
    }
    void withAction('rename-device', async () => {
      try {
        await apiPatch(`/identities/${encodeURIComponent(target.identityId as string)}`, {
          deviceName: renameDeviceValue.trim()
        });
        toast.success(`设备已重命名：${renameDeviceValue.trim()}`);
        setRenameDeviceTarget(null);
        await Promise.all([load(true), loadServerDevices(true).catch(() => {})]);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '重命名失败');
      }
    });
  };

  // v2.17: Sync This Device Only —— 为本机创建独立备份账号（duck.ai signUpForPairing 等价）
  const createOwnAccount = () => {
    void withAction('create-own-account', async () => {
      try {
        const response = await apiPost<{ ok?: boolean; userId?: string; recoveryCodeStored?: boolean }>(
          '/sync/create-own-account',
          { confirm: true }
        );
        setCreateOwnOpen(false);
        toast.success(
          `已创建本机独立同步账号（${String(response?.userId || '').slice(0, 8)}…），恢复码已保存`
        );
        await load(true);
        await loadServerDevices(true).catch(() => {});
        await loadDeviceSlots(true).catch(() => {});
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '创建本机同步账号失败');
      }
    });
  };

  // v2.16: 切换 Sync 模式（Sync & Backup / 仅同步）
  const applySyncMode = (mode: 'backup' | 'syncOnly') => {
    void withAction('sync-mode', async () => {
      try {
        const response = await apiPost<SyncResponse & { ok?: boolean; mode?: string }>('/sync/mode', { mode });
        if (response.sync) setSync(response.sync);
        toast.success(mode === 'syncOnly' ? '已切换为「仅同步」：恢复码不落盘' : '已切换为 Sync & Backup');
        await load(true);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '切换 Sync 模式失败');
      }
    });
  };

  // v2.16: 删除当前 Sync & Backup 数据（注销设备 + 清除恢复码，不再同步）
  const deleteSyncData = () => {
    void withAction('sync-delete', async () => {
      try {
        const response = await apiPost<{ ok?: boolean; deletedDevices?: string[]; clearedRecoveryCode?: boolean }>(
          '/sync/delete-data',
          { confirm: true }
        );
        setDeleteSyncOpen(false);
        setDeleteSyncConfirmText('');
        setPairSession(null);
        setQrDataUrl('');
        setSync(null);
        toast.success(
          `Sync & Backup 数据已删除：注销 ${response?.deletedDevices?.length ?? 0} 台设备` +
            (response?.clearedRecoveryCode ? '，已清除官方恢复码' : '')
        );
        await Promise.all([load(true), loadServerDevices(true), loadDeviceSlots(true)]);
      } catch (err) {
        if ((err as ApiError)?.handled) return;
        toast.error((err as ApiError)?.message || '删除 Sync & Backup 数据失败');
      }
    });
  };

  const showRecoveryCode = () => {
    void withAction('recovery-view', async () => {
      const response = await apiGet<RecoveryCodeResponse>('/sync/recovery-code');
      const code = extractRecoveryCode(response.recoveryCode);
      if (!code) {
        toast.error('服务未返回恢复码');
        return;
      }
      setRecoveryCode(code);
      setRecoveryOpen(true);
    });
  };

  const pairingErrorMessage = (err: unknown): string => {
    const apiError = err as ApiError;
    if (apiError?.code === 'pairing_unavailable') {
      return '配对服务不可用（PairingHost 未初始化），请重启网关后重试。';
    }
    if (apiError?.code === 'sync_transport_unavailable') {
      return '无法访问 duckduckgo.com 的 Sync 交换服务：请先在「代理」页启用代理后重试。';
    }
    if (apiError?.code === 'sync_not_enabled') {
      return '请先启用 Sync & Backup 后再生成配对二维码。';
    }
    if (apiError?.code === 'pairing_in_progress' || apiError?.status === 409) {
      return '已有配对会话进行中，请先点「停止配对」后再试。';
    }
    if (apiError?.code === 'pairing_start_failed' || apiError?.status === 502) {
      return apiError.message || '无法向 DuckDuckGo Sync 注册频道（502 pairing_start_failed），请检查代理后重试。';
    }
    return apiError?.message || (err as Error)?.message || '生成配对失败，请重试。';
  };

  const generatePairingCode = () => {
    void withAction('pairing-start', async () => {
      setPairingError(null);
      setOfficialCodeFromPairing(false);
      try {
        // 先向 DuckDuckGo Sync 交换服务注册频道（PairingHost.start），成功后再展示二维码
        const response = await apiPost<SyncPairingResponse>('/sync/pairing', {});
        const pairing = response?.pairing ?? {};
        const merged: SyncPairingSession = {
          ...pairing,
          channelId: response.channelId ?? pairing.channelId ?? null,
          pairingCode: response.pairingCode ?? pairing.pairingCode ?? null,
          url: response.url ?? pairing.url ?? null,
          qrUrl: response.qrUrl ?? pairing.qrUrl ?? null,
          expiresAt: response.expiresAt ?? pairing.expiresAt ?? null,
          state: response.state ?? pairing.state ?? 'waiting',
          accountAvailable: response.accountAvailable ?? pairing.accountAvailable
        };
        if (!merged.url && !merged.qrUrl) throw new Error('后端未返回配对 URL');
        setPairSession(merged);
        toast.success('已注册配对频道，等待另一台设备扫描');
      } catch (err) {
        const message = pairingErrorMessage(err);
        setPairingError(message);
        toast.error(message, { duration: 7000 });
      }
    });
  };

  const stopPairing = () => {
    void withAction('pairing-stop', async () => {
      try {
        await apiDelete('/sync/pairing');
      } catch (err) {
        if (!(err as ApiError)?.handled) {
          // 即使删除失败，也清空本地二维码，避免误以为仍在等待
          toast.warning(pairingErrorMessage(err));
        }
      }
      setPairSession(null);
      setPairingError(null);
      setQrDataUrl('');
      toast.info('已停止配对');
    });
  };

  const saveOfficialRecoveryCode = async () => {
    const code = officialCodeInput.trim();
    if (!code) {
      toast.warning('请粘贴 DuckDuckGo 官方恢复码');
      return;
    }
    setOfficialCodeSaving(true);
    try {
      const response = await apiPut<OfficialRecoveryCodeResponse>('/sync/official-recovery-code', { code });
      setOfficialCode(response?.officialRecoveryCode ?? null);
      setOfficialCodeFromPairing(false);
      setOfficialCodeInput('');
      toast.success('官方恢复码已保存（可查看/下载）');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '保存官方恢复码失败');
    } finally {
      setOfficialCodeSaving(false);
    }
  };

  const downloadOfficialRecoveryCode = async () => {
    setOfficialCodeDownloading(true);
    try {
      const filename = await downloadFile(
        '/sync/official-recovery-code/download',
        `duckai-official-recovery-code-${Date.now()}.txt`
      );
      toast.success(`官方恢复码已下载：${filename}`);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '下载官方恢复码失败');
    } finally {
      setOfficialCodeDownloading(false);
    }
  };

  const clearOfficialRecoveryCode = async () => {
    setOfficialCodeSaving(true);
    try {
      const response = await apiDelete<OfficialRecoveryCodeResponse>('/sync/official-recovery-code');
      setOfficialCode(response?.officialRecoveryCode ?? null);
      setOfficialCodeFromPairing(false);
      toast.success('已清除官方恢复码');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '清除官方恢复码失败');
    } finally {
      setOfficialCodeSaving(false);
    }
  };

  const importPairingCode = () => {
    void withAction('pair', async () => {
      const code = pairInput.trim();
      if (!code) {
        toast.warning('请粘贴配对码或配对链接');
        return;
      }
      const response = await apiPost<SyncResponse>('/sync/pair', { code });
      setSync(response.sync);
      setPairInput('');
      toast.success('配对成功');
      await load(true);
    });
  };

  const importRecoveryCode = () => {
    void withAction('recovery-import', async () => {
      const code = recoveryInput.trim();
      if (!code) {
        toast.warning('请粘贴恢复码');
        return;
      }
      const response = await apiPost<SyncResponse>('/sync/recovery-code', { recoveryCode: code });
      setSync(response.sync);
      setRecoveryInput('');
      toast.success('恢复码已导入');
      await load(true);
    });
  };

  const downloadRecoveryCode = () => {
    try {
      downloadTextFile(`duckai-recovery-code-${Date.now()}.txt`, recoveryCode);
      toast.success('恢复码已下载');
    } catch (err) {
      handleActionError(err, '下载恢复码失败');
    }
  };

  /* ---------------------------- 订阅 ---------------------------- */

  const activateSubscription = () => {
    void withAction('activate', async () => {
      const value = token.trim();
      if (!value) {
        toast.warning('请粘贴 DuckDuckGo token');
        return;
      }
      const response = await apiPost<{ ok: boolean; subscription: SubscriptionInfo }>(
        '/subscription/activate',
        { token: value }
      );
      setSubscription(response.subscription);
      setToken('');
      if (response.subscription?.authenticated) {
        toast.success(`已激活 ${String(response.subscription.tier || 'free').toUpperCase()} 订阅`);
      } else {
        toast.warning('token 已保存，但未能验证为有效订阅');
      }
      refreshOverview();
    });
  };

  const verifySubscription = () => {
    void withAction('verify', async () => {
      const response = await apiPost<{ ok: boolean; subscription: SubscriptionInfo }>('/subscription/verify');
      setSubscription(response.subscription);
      if (response.subscription?.verified) {
        toast.success('订阅验证通过');
      } else {
        toast.warning(response.subscription?.verifyError || '未能在线验证订阅（可能网络受限）');
      }
      refreshOverview();
    });
  };

  const logoutSubscription = () => {
    void withAction('logout-sub', async () => {
      const response = await apiDelete<{ ok: boolean; subscription: SubscriptionInfo }>('/subscription');
      setSubscription(response.subscription);
      setToken('');
      setLogoutSubOpen(false);
      toast.success('已注销订阅（回到匿名 free）');
      refreshOverview();
    });
  };

  const durableStreamEnabled = identity?.durableStream?.enabled === true;
  const durableStreamDegraded = identity?.durableStream?.degraded === true;
  const reachabilityOnly = Boolean(subscription?.verified && subscription.verifyScope === 'reachability');
  const transportBlocked = sync?.transport === 'blocked';
  // v2.17: 当前同步账号来源（self=本机独立账号 / pairing=配对加入 / manual=手动恢复码）
  const accountSource: string | null = (sync as unknown as { accountSource?: string | null } | undefined)?.accountSource ?? null;

  return (
    <div>
      <PageHeader
        title="默认身份"
        description="默认匿名身份（journeyId + 本机指纹）与 DuckDuckGo Sync & Backup；订阅已移到独立「订阅」页"
      />

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ------------------------- 匿名身份 ------------------------- */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Fingerprint className="h-4 w-4" />
                  匿名身份
                </CardTitle>
                <CardDescription className="text-xs">
                  journeyId + 本地 RSA 指纹持久化到 data/identity.json，重启不漂移
                </CardDescription>
              </div>
              {identity ? (
                <Badge variant={identity.identity.stable ? 'success' : 'warning'} className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  {identity.identity.stable ? '已持久化 · 重启不漂移' : '尚未持久化'}
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading && !identity ? (
              <Skeleton className="h-44 rounded-xl" />
            ) : identity ? (
              <>
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  <ValueRow label="journeyId" value={identity.identity.journeyId} mono />
                  <ValueRow label="deviceId" value={identity.identity.deviceId} mono />
                  <ValueRow label="设备名称" value={identity.identity.deviceName || '—'} />
                  <ValueRow label="durable-stream 指纹" value={identity.durableStream?.fingerprint || '—'} mono />
                  <ValueRow label="创建时间" value={formatDateTime(identity.identity.createdAt)} copyable={false} />
                  <ValueRow
                    label="轮换时间"
                    value={`${formatDateTime(identity.identity.rotatedAt)}（${formatRelative(identity.identity.rotatedAt)}）`}
                    copyable={false}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge variant="outline">来源 {identity.identity.source}</Badge>
                  <Badge
                    variant={durableStreamEnabled ? 'success' : durableStreamDegraded ? 'destructive' : 'warning'}
                    className="gap-1"
                  >
                    <PlugZap className="h-3 w-3" />
                    {durableStreamEnabled
                      ? 'durableStream 已启用'
                      : durableStreamDegraded
                        ? 'durableStream 已自动降级'
                        : 'durableStream 未发送（需上游允许）'}
                  </Badge>
                  {durableStreamDegraded ? (
                    <Badge variant="outline" className="gap-1">
                      已拒绝 {formatNumber(identity.durableStream?.rejectedCount ?? 0)} 次
                    </Badge>
                  ) : null}
                  <span className="truncate" title={identity.file?.path}>
                    文件 {identity.file?.path}（{formatNumber(identity.file?.bytes)} bytes）
                  </span>
                </div>
                <p className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  匿名身份 = journeyId + 本地 RSA 指纹（持久化，重启不漂移）；durableStream 需上游允许（Sync / 订阅）才发送，
                  匿名档携带它可能被上游拒绝（后端会自动降级并记录）。轮换可能导致上游重新识别设备；
                  导出的身份文件包含私钥 / token，请妥善保管。
                </p>
                {durableStreamDegraded ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    durableStream 已被上游拒绝，网关已自动降级为不含该字段的请求
                    {identity.durableStream?.note ? `：${identity.durableStream.note}` : '。'}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={openRotateDialog} disabled={action !== null}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    轮换
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportIdentity} disabled={action !== null}>
                    {action === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    导出身份文件
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} disabled={action !== null}>
                    <Upload className="h-3.5 w-3.5" />
                    导入身份文件
                  </Button>
                </div>

                {rotateNote ? (
                  <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {rotateNote}
                  </p>
                ) : null}

                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="device-name-input">设备名称</Label>
                    <span className="text-[11px] text-muted-foreground">
                      当前：{identity.identity.deviceName || sync?.deviceName || '（默认名由网关生成）'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="device-name-input"
                      value={deviceNameInput}
                      placeholder="留空使用默认（DuckCPA@xxxx）"
                      maxLength={64}
                      className="min-w-[220px] flex-1"
                      onChange={(event) => {
                        deviceNameDirtyRef.current = true;
                        setDeviceNameInput(event.target.value);
                      }}
                    />
                    <Button size="sm" onClick={() => void saveDeviceName()} disabled={deviceNameSaving || action !== null}>
                      {deviceNameSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PencilLine className="h-3.5 w-3.5" />}
                      保存设备名称
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        deviceNameDirtyRef.current = false;
                        setDeviceNameInput('');
                        void saveDeviceName();
                      }}
                      disabled={deviceNameSaving || action !== null}
                    >
                      使用默认
                    </Button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    用于在手机 DuckDuckGo Sync → My Devices 中识别本机；默认 DuckCPA@xxxx 由后端生成，留空即恢复默认。
                  </p>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">身份信息不可用（后端可能尚未实现 /identity）。</p>
            )}
          </CardContent>
        </Card>

        {/* ------------------------- Sync & Backup ------------------------- */}
        <Card className="xl:col-span-2" data-testid="sync-backup-card">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Link2 className="h-4 w-4" />
                  Sync &amp; Backup
                </CardTitle>
                <CardDescription className="text-xs">
                  DuckDuckGo Sync 密钥、恢复码与配对码；blocked 时仅本地能力可用
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{sync?.enabled ? '已启用' : '未启用'}</span>
                <Switch
                  checked={sync?.enabled ?? false}
                  disabled={!sync || action !== null}
                  aria-label="启用 Sync & Backup"
                  onCheckedChange={(next) => {
                    if (next) enableSync();
                    else setDisableSyncOpen(true);
                  }}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {sync?.transport === 'blocked' ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  当前环境无法访问 duckduckgo.com；可在
                  <a href="#/proxy" className="mx-0.5 font-medium underline underline-offset-2">
                    「代理」页
                  </a>
                  启用代理后重试
                  {sync.transportReason ? `（${sync.transportReason}）` : ''}。
                </span>
              </div>
            ) : sync ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                <BadgeCheck className="h-3.5 w-3.5" />
                sync transport 可用
              </div>
            ) : null}

            {loading && !sync ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : sync?.enabled ? (
              <>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <ValueRow
                    label="恢复码"
                    value={sync.recoveryCode?.present ? sync.recoveryCode.preview || '已生成（完整值需查看）' : '—'}
                    copyable={false}
                  />
                  <ValueRow
                    label="最近同步"
                    value={sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : '尚未同步'}
                    copyable={false}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={showRecoveryCode} disabled={action !== null}>
                    <KeyRound className="h-3.5 w-3.5" />
                    查看完整恢复码
                  </Button>
                  {pairSession ? (
                    <Button size="sm" variant="outline" onClick={stopPairing} disabled={action !== null}>
                      <Square className="h-3.5 w-3.5" />
                      {PAIRING_TERMINAL_STATES.has(pairSession.state ?? '') ? '关闭配对' : '停止配对'}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={generatePairingCode} disabled={action !== null}>
                      <QrCode className="h-3.5 w-3.5" />
                      生成配对码
                    </Button>
                  )}
                </div>

                {pairingError ? (
                  <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    {pairingError}
                  </p>
                ) : null}

                {pairSession ? (
                  <div className="space-y-2.5 rounded-lg border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        扫码配对（已向 DuckDuckGo Sync 注册频道）
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={pairingStateVariant(pairSession.state)}>
                          {PAIRING_STATE_LABELS[pairSession.state ?? 'idle'] ?? pairSession.state ?? 'waiting'}
                        </Badge>
                        {pairSession.peerName ? (
                          <Badge variant="outline" className="max-w-[240px] truncate">
                            {pairSession.peerName}
                            {pairSession.peerKind ? ` · ${pairSession.peerKind}` : ''}
                          </Badge>
                        ) : pairSession.peerChannelId ? (
                          <Badge variant="outline" className="font-mono">
                            peer {pairSession.peerChannelId.slice(0, 8)}…
                          </Badge>
                        ) : null}
                        {pairSession.endReason ? <Badge variant="outline">{pairSession.endReason}</Badge> : null}
                        <Badge variant={pairSession.accountAvailable || officialCode?.configured ? 'success' : 'muted'}>
                          官方恢复码{pairSession.accountAvailable || officialCode?.configured ? '已配置' : '未配置'}
                        </Badge>
                      </div>
                    </div>

                    {pairSession.accountAvailable === false && officialCode?.configured !== true ? (
                      <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[11px] text-muted-foreground">
                        网关当前没有本地官方恢复码；扫码后将由配对流程自动接收手机下发的官方恢复码（无需预先填写）。
                      </p>
                    ) : null}

                    {pairSession.state === 'completed' ? (
                      <div className="space-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                        <div className="flex items-center gap-2 font-medium">
                          <BadgeCheck className="h-3.5 w-3.5" />
                          {pairingCompletedText(pairSession.completedAs)}
                        </div>
                        {pairSession.completedAs === 'joiner' ? (
                          <p className="text-[11px] opacity-90">
                            官方恢复码已自动保存到网关（下方「DuckDuckGo 官方恢复码」会显示已配置与预览）。
                          </p>
                        ) : null}
                        {pairSession.accountConflict ? (
                          <div className="mt-1 space-y-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                            <div className="flex items-center gap-1 font-medium">
                              <AlertTriangle className="h-3 w-3" />
                              两台设备属于不同账号（账号冲突）
                            </div>
                            <p>
                              手机把自己的恢复码给了网关，但网关已配置另一个账号（
                              {pairSession.currentAccountUserId?.slice(0, 8) || '当前'}…），默认不覆盖。
                            </p>
                            <ul className="list-disc space-y-0.5 pl-4">
                              <li>
                                要<b>合并到网关当前账号</b>：在手机上 DuckDuckGo → Sync &amp; Backup
                                <b>关闭 Sync / 清除该设备同步数据</b>，再扫本页二维码（手机会向网关索取恢复码）。
                              </li>
                              <li>
                                要<b>改用手机账号</b>（把网关切到手机账号）：点下方按钮
                                {pairSession.pendingAccount ? '「改用手机账号」' : '（需重新扫码一次）'}。
                              </li>
                            </ul>
                            {pairSession.pendingAccount ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-1 h-7 gap-1 text-[11px]"
                                disabled={action !== null}
                                onClick={() => void adoptPhoneAccount()}
                              >
                                <RefreshCw className="h-3 w-3" />
                                改用手机账号（切换网关到 {pairSession.pendingAccount.userId?.slice(0, 8) || '手机账号'}…）
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        {pairSession.accountMerged ? (
                          <p className="mt-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                            已合并到手机账号（{pairSession.currentAccountUserId?.slice(0, 8) || '…'}…），本机
                            <b>DuckAI@main</b> 已注册；手机 My Devices 中可直接看到。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {pairSession.state === 'failed' || pairSession.state === 'timeout' ? (
                      <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                        <div className="flex items-center gap-1.5 font-medium">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {pairSession.state === 'timeout' ? '配对超时' : '配对失败'}
                          {pairSession.endReason ? `（${pairSession.endReason}）` : ''}
                        </div>
                        <p>{pairingFailureHint(pairSession.endReason)}</p>
                      </div>
                    ) : null}

                    {pairingPhaseHint(pairSession) ? (
                      <p
                        data-testid="pairing-phase-hint"
                        className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px] font-medium text-primary"
                      >
                        {pairingPhaseHint(pairSession)}
                      </p>
                    ) : null}

                    {qrDataUrl &&
                    ['waiting', 'hello', 'exchange'].includes(pairSession.state ?? 'waiting') ? (
                      <div className="grid gap-2 md:grid-cols-[auto_1fr] md:items-start">
                        <div className="flex flex-col items-center gap-2 rounded-lg border bg-white p-3">
                          <img
                            src={qrDataUrl}
                            alt="Sync 配对二维码"
                            aria-label="扫码配对二维码"
                            width={200}
                            height={200}
                            className="h-[200px] w-[200px] rounded-md bg-white"
                          />
                          <p className="text-center text-[11px] leading-relaxed text-slate-600">
                            在另一台设备打开 DuckDuckGo → Sync &amp; Backup → 扫描
                          </p>
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => downloadDataUrl(`duckai-sync-pairing-${Date.now()}.png`, qrDataUrl)}
                            >
                              <Download className="h-3.5 w-3.5" />
                              下载 PNG
                            </Button>
                            <CopyButton value={pairSession.qrUrl || pairSession.url || ''} size="sm" variant="ghost" label="复制链接" />
                          </div>
                        </div>
                        {/* v2.18：二维码右侧实时展示双方交互（方便立刻定位失败原因） */}
                        <div className="min-w-0 rounded-lg border bg-background p-2.5" data-testid="pairing-message-log">
                          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1">
                            <span className="flex items-center gap-1.5 text-xs font-medium">
                              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                              配对交互记录
                            </span>
                            <Badge variant={pairSession.state === 'completed' ? 'success' : 'muted'} className="text-[10px]">
                              {pairSession.state === 'completed' ? '已完成' : '进行中'} · {pairSession.messages?.length ?? 0} 条
                            </Badge>
                          </div>
                          <div className="max-h-[190px] space-y-1 overflow-y-auto pr-1 font-mono text-[10.5px] leading-relaxed">
                            {(pairSession.messages ?? []).length === 0 ? (
                              <p className="text-muted-foreground">等待手机扫码…</p>
                            ) : (
                              (pairSession.messages ?? []).map((message, index) => {
                                const inbound = message.dir === 'in';
                                return (
                                  <div
                                    key={`${message.seq ?? index}-${message.at ?? index}`}
                                    className={inbound ? 'flex items-start gap-1.5' : 'flex flex-row-reverse items-start gap-1.5 text-right'}
                                  >
                                    <span
                                      className={
                                        inbound
                                          ? 'mt-0.5 shrink-0 rounded bg-sky-500/15 px-1 text-[9px] text-sky-700 dark:text-sky-300'
                                          : 'mt-0.5 shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-700 dark:text-emerald-300'
                                      }
                                    >
                                      {inbound ? '手机→网关' : '网关→手机'}
                                    </span>
                                    <span className="min-w-0 break-all">
                                      {message.type}
                                      {typeof message.httpStatus === 'number' ? (
                                        <span className="text-muted-foreground"> ({message.httpStatus})</span>
                                      ) : null}
                                      {message.at ? (
                                        <span className="ml-1 text-muted-foreground">
                                          {new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false })}
                                        </span>
                                      ) : null}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                          </div>
                          {pairingPhaseHint(pairSession) ? (
                            <p className="mt-1.5 border-t pt-1.5 text-[10.5px] text-primary">{pairingPhaseHint(pairSession)}</p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {pairSession.qrUrl || pairSession.url ? (
                      <div className="flex gap-2">
                        <Input readOnly value={pairSession.qrUrl || pairSession.url || ''} className="font-mono text-[11px]" />
                        <CopyButton value={pairSession.qrUrl || pairSession.url || ''} size="sm" variant="outline" label="复制 URL" />
                      </div>
                    ) : null}
                    {pairSession.pairingCode ? (
                      <details className="rounded-md border bg-background/60 px-2.5 py-2">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground">查看 code2 配对码</summary>
                        <code className="mt-1 block break-all font-mono text-[10.5px] text-muted-foreground">
                          {pairSession.pairingCode}
                        </code>
                      </details>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {pairSession.expiresAt ? (
                        <span className="text-[11px] text-muted-foreground">
                          有效期至 {formatDateTime(pairSession.expiresAt)}
                        </span>
                      ) : null}
                      {pairSession.state === 'failed' || pairSession.state === 'timeout' ? (
                        <Button size="sm" variant="outline" onClick={generatePairingCode} disabled={action !== null}>
                          <RefreshCw className="h-3.5 w-3.5" />
                          重新生成
                        </Button>
                      ) : null}
                    </div>

                    <p className="rounded-md bg-background/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">说明：</span>
                      扫码后会与手机完成握手，并由配对流程自动接收手机的官方恢复码（无需预先手动填写）；
                      若手机端仍显示失败，可在下方手动粘贴官方恢复码后再试。
                    </p>
                  </div>
                ) : null}

                <Separator />

                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-muted-foreground">DuckDuckGo 官方恢复码（可选）</span>
                    <div className="flex items-center gap-1.5">
                      {officialCodeFromPairing && officialCode?.configured ? (
                        <Badge variant="info">来自配对</Badge>
                      ) : null}
                      <Badge variant={officialCode?.configured ? 'success' : 'muted'}>
                        {officialCode?.configured ? '已配置' : '未配置'}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    扫码配对时会自动接收手机的官方恢复码并保存；也可在此手动粘贴。
                    <span className="text-foreground">本地恢复码不适用于官方 App</span>。
                  </p>
                  {officialCode?.configured ? (
                    <div className="space-y-1.5" data-testid="official-recovery-code-configured">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        官方恢复码等同账号密钥，可查看/下载；请勿分享。
                        {officialCode.updatedAt ? `（更新于 ${formatDateTime(officialCode.updatedAt)}）` : ''}
                      </p>
                      <code
                        data-testid="official-recovery-code-full"
                        className="block max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed select-all"
                      >
                        {officialCode.code || officialCode.preview || '（已配置，后端未返回完整值）'}
                      </code>
                      <div className="flex flex-wrap gap-2">
                        <CopyButton
                          value={officialCode.code || officialCode.preview || ''}
                          size="sm"
                          variant="outline"
                          label="复制官方恢复码"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="下载官方恢复码"
                          onClick={() => void downloadOfficialRecoveryCode()}
                          disabled={officialCodeDownloading || !officialCode.configured}
                        >
                          {officialCodeDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                          下载
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="查看恢复码二维码"
                          data-testid="official-code-qr-button"
                          onClick={() => setOfficialQrOpen(true)}
                          disabled={!officialCode.code}
                          title={officialCode.code ? '扫描恢复码' : '后端未返回完整恢复码'}
                        >
                          <QrCode className="h-3.5 w-3.5" />
                          二维码
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5" data-testid="official-recovery-code-empty">
                      <p className="text-[11px] text-muted-foreground">
                        未配置官方恢复码：完成扫码配对后会自动接收，或手动填写官方恢复码。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="查看恢复码二维码"
                          data-testid="official-code-qr-button"
                          disabled
                        >
                          <QrCode className="h-3.5 w-3.5" />
                          二维码
                        </Button>
                        <Button type="button" size="sm" variant="outline" aria-label="下载官方恢复码" disabled>
                          <Download className="h-3.5 w-3.5" />
                          下载
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="official-recovery-code"
                      type={officialCodeVisible ? 'text' : 'password'}
                      value={officialCodeInput}
                      placeholder="粘贴官方恢复码（保存后不回显）"
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-[220px] flex-1"
                      onChange={(event) => setOfficialCodeInput(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={officialCodeVisible ? '隐藏官方恢复码' : '显示官方恢复码'}
                      onClick={() => setOfficialCodeVisible((value) => !value)}
                    >
                      {officialCodeVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void saveOfficialRecoveryCode()}
                      disabled={officialCodeSaving || !officialCodeInput.trim()}
                    >
                      {officialCodeSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      保存
                    </Button>
                    {officialCode?.configured ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void clearOfficialRecoveryCode()}
                        disabled={officialCodeSaving}
                      >
                        清除
                      </Button>
                    ) : null}
                  </div>
                </div>

                <Separator />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="pairing-input">导入配对码 / 配对链接</Label>
                    <div className="flex gap-2">
                      <Input
                        id="pairing-input"
                        value={pairInput}
                        placeholder="code2=… 或完整 URL"
                        onChange={(event) => setPairInput(event.target.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={importPairingCode}
                        disabled={!pairInput.trim() || action !== null}
                      >
                        导入
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      transport blocked 时导入会返回 503，可改用恢复码在本地还原。
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="recovery-input">导入恢复码</Label>
                    <div className="flex gap-2">
                      <Input
                        id="recovery-input"
                        value={recoveryInput}
                        placeholder="粘贴恢复码"
                        onChange={(event) => setRecoveryInput(event.target.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={importRecoveryCode}
                        disabled={!recoveryInput.trim() || action !== null}
                      >
                        导入
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">恢复码可还原 mainKey + 加密私钥（本地能力）。</p>
                  </div>
                </div>



                <Separator />

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium">设备列表</span>
                    <span className="text-[11px] text-muted-foreground">
                      {sync.deviceCount} 台{sync.deviceName ? ` · 本机 ${sync.deviceName}` : ''}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {sync.devices && sync.devices.length > 0 ? (
                      sync.devices.map((device) => (
                        <div
                          key={device.id}
                          className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                        >
                          <Laptop className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="truncate font-medium">{device.name || '未命名设备'}</span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">{device.id}</span>
                          {device.thisDevice ? <Badge variant="success">本机</Badge> : null}
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        暂无其它设备（跨设备同步在 transport blocked 时不可用）。
                      </p>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">设备管理见下方「DuckDuckGo 设备列表」卡片。</p>

                {/* v2.17：与 duck.ai 一致的两个入口：Sync With Another Device / Sync This Device Only */}
                <div className="mt-3 space-y-2 rounded-lg border bg-muted/20 px-3 py-2.5" data-testid="sync-account-section">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Link2 className="h-3.5 w-3.5" />
                      同步方式
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      当前账号：
                      {accountSource === 'self'
                        ? '本机独立备份账号（Sync This Device Only）'
                        : accountSource === 'pairing'
                          ? '已通过配对加入其他设备的账号'
                          : accountSource === 'manual'
                            ? '手动导入的官方恢复码'
                            : '未配置'}
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-md border bg-background px-2.5 py-2">
                      <div className="text-xs font-medium">Sync With Another Device</div>
                      <p className="mb-1.5 text-[11px] text-muted-foreground">
                        与手机/其他浏览器配对，加入它们已有的 DuckDuckGo 账号（双向同步）。
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={action !== null || !sync?.enabled}
                        onClick={() => {
                          void generatePairingCode();
                          setPairingError(null);
                        }}
                        data-testid="sync-with-another-device"
                      >
                        生成配对码
                      </Button>
                    </div>
                    <div className="rounded-md border bg-background px-2.5 py-2">
                      <div className="text-xs font-medium">Sync This Device Only</div>
                      <p className="mb-1.5 text-[11px] text-muted-foreground">
                        只为这台网关创建独立的 DuckDuckGo 备份账号，恢复码保存在本机（可随时查看/下载）。
                      </p>
                      <Button
                        size="sm"
                        variant={accountSource === 'self' ? 'default' : 'outline'}
                        className="h-7 text-xs"
                        disabled={action !== null || !sync?.enabled}
                        onClick={() => setCreateOwnOpen(true)}
                        data-testid="sync-this-device-only"
                      >
                        {accountSource === 'self' ? '已启用' : '创建本机账号'}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        删除 Sync &amp; Backup 数据
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        注销本账号下所有网关注册设备、清除本机保存的官方恢复码并停止同步（匿名身份保留，不再 sync）。
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 gap-1 text-xs"
                      disabled={action !== null || (!sync?.enabled && !sync?.server?.userId)}
                      onClick={() => {
                        setDeleteSyncConfirmText('');
                        setDeleteSyncOpen(true);
                      }}
                      data-testid="sync-delete-data"
                    >
                      <Trash2 className="h-3 w-3" />
                      删除数据
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                未启用。启用后将生成 mainKey、加密私钥与恢复码（恢复码只显示一次，请离线保存）。
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---------------------- DDG 设备列表（v2.10 独立卡片） ---------------------- */}
        <Card id="ddg-device-list-card" data-testid="ddg-device-list-card" className="xl:col-span-2">
          <CardHeader className="pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Server className="h-4 w-4" />
                DuckDuckGo 设备列表
              </CardTitle>
              <CardDescription className="text-xs">
                左「身份池设备」/ 右「设备槽」：点「加入 / 移除」后点「保存」生效；默认身份也可移除且账号保留
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {orphans.length > 0 ? (
              <div
                data-testid="device-orphans-banner"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              >
                <span className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  发现 {orphans.length} 个已失效身份的设备（身份已删除/禁用），可清理后重新管理设备槽。
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="清理失效设备"
                  onClick={reconcileDeviceSlots}
                  disabled={reconcilingSlots || action !== null}
                >
                  {reconcilingSlots ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  清理
                </Button>
              </div>
            ) : null}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={sync?.server?.registered ? 'success' : 'muted'}>
                        {sync?.server?.registered ? '已注册' : '未注册'}
                      </Badge>
                      {sync?.server?.deviceName ? (
                        <Badge variant="outline" className="max-w-[220px] truncate">
                          本机 {sync?.server.deviceName}
                        </Badge>
                      ) : null}
                      {sync?.server?.userId ? (
                        <Badge variant="outline" className="font-mono">
                          user {sync?.server.userId.slice(0, 8)}…
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label="刷新 DuckDuckGo 设备列表"
                        onClick={() => void loadServerDevices()}
                        disabled={serverDevicesLoading || action !== null}
                      >
                        {serverDevicesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        刷新
                      </Button>
                      <Button
                        size="sm"
                        aria-label="注册本机到 DuckDuckGo"
                        onClick={registerDevice}
                        disabled={registeringDevice || action !== null}
                      >
                        {registeringDevice ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                        注册本机到 DuckDuckGo
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    左栏为身份池设备（按设备名），右栏为 DuckDuckGo 设备槽；拖拽调整待加入/已注册设备后点「保存」生效。默认身份用于获取手机配对 key，可移除但账号保留。
                  </p>
                  {slotsError ? (
                    <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                      {slotsError}
                    </p>
                  ) : null}
                  {serverDevicesError ? (
                    <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                      {serverDevicesError}
                    </p>
                  ) : null}
                  <div className="grid gap-3 lg:grid-cols-2">
                    {/* 左栏：身份池设备 */}
                    <div
                      data-testid="device-slots-left"
                      className="rounded-xl border border-dashed border-border bg-muted/20 p-2.5"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <Server className="h-3.5 w-3.5 text-muted-foreground" />
                          身份池设备
                        </span>
                        <Badge variant="muted">{leftPoolIdentities.length}</Badge>
                      </div>
                      <p className="mb-2 text-[10px] text-muted-foreground">
                        点「加入」把身份添加到右侧设备槽（点「保存」后注册到 DuckDuckGo）；默认身份也可移除，账号保留。
                      </p>
                      {leftPoolIdentities.length === 0 ? (
                        <p className="rounded-lg border px-3 py-4 text-center text-xs text-muted-foreground">
                          全部身份都已在右侧
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {leftPoolIdentities.map((identity) => (
                            <div
                              key={identity.id}
                              data-testid={`device-slot-left-${identity.id}`}
                              className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-xs"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate font-medium">{identityDeviceName(identity)}</span>
                                  {identity.active ? <Badge variant="default">默认</Badge> : null}
                                </div>
                                <div className="truncate text-[10px] text-muted-foreground">
                                  {identity.label} · {identity.fingerprint.slice(0, 8)}
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 shrink-0 text-xs"
                                aria-label={`加入设备 ${identityDeviceName(identity)}`}
                                onClick={() => addSlot(identity.id)}
                                disabled={slotsSaving || action !== null}
                              >
                                <ArrowRight className="h-3.5 w-3.5" />
                                加入
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 右栏：DDG 设备槽位（待注册/已注册） */}
                    <div
                      data-testid="device-slots-right"
                      className="rounded-xl border border-dashed border-border bg-muted/20 p-2.5"
                    >
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <Laptop className="h-3.5 w-3.5 text-muted-foreground" />
                          DuckDuckGo 设备列表 / 设备槽（待加入 / 已注册）
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={sync?.server?.registered ? 'success' : 'muted'}>
                            {sync?.server?.registered ? '已注册' : '未注册'}
                          </Badge>
                          <Badge variant="muted">{rightSlotIdentities.length + serverOnlyDevices.length}</Badge>
                        </div>
                      </div>
                      <p className="mb-2 text-[10px] text-muted-foreground">
                        当前已注册设备；点「移除」后点「保存」即从 DuckDuckGo 账号注销该设备（默认身份也可移除：
                        只注销设备，配对账号与官方恢复码保留，可随时重新加入）。
                      </p>
                      <p className="mb-2 flex items-start gap-1 rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        删除会把该设备从 DuckDuckGo 账号注销并使其失效（手机端需重新配对）；请只删除确认不再使用的设备。
                      </p>
                      {serverDevicesLoading && rightSlotIdentities.length === 0 ? (
                        <Skeleton className="h-16 rounded-lg" />
                      ) : rightSlotIdentities.length === 0 && serverOnlyDevices.length === 0 ? (
                        <p className="rounded-lg border px-3 py-4 text-center text-xs text-muted-foreground">
                          右侧为空：从左侧点「加入」后点「保存」。
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {rightSlotIdentities.map((identity) => {
                            const device = serverDeviceForIdentity(identity);
                            const currentDevice = identity.active;
                            const credentialId = device?.credential_id || device?.credentialId;
                            const jwtIssuedAt = device?.jwt_iat ?? device?.jwtIat;
                            return (
                              <div
                                key={identity.id}
                                data-testid={`device-slot-right-${identity.id}`}
                                className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-xs"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate font-medium">{identityDeviceName(identity)}</span>
                                    <Badge variant="outline">{device?.type || 'identity'}</Badge>
                                    {currentDevice ? <Badge variant="success">主设备（本机）</Badge> : null}
                                    {device ? null : <Badge variant="muted">待注册</Badge>}
                                  </div>
                                  <div className="truncate text-[10px] text-muted-foreground">
                                    {identity.label}
                                    {credentialId ? ` · cred ${credentialId.slice(0, 8)}…` : ''}
                                    {jwtIssuedAt ? ` · jwt ${formatDateTime(jwtIssuedAt)}` : ''}
                                  </div>
                                  {currentDevice ? (
                                    <div className="text-[10px] text-muted-foreground">默认身份（可移除，账号保留）</div>
                                  ) : null}
                                </div>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 shrink-0 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  aria-label={`移除设备 ${identityDeviceName(identity)}`}
                                  onClick={() => removeSlot(identity.id)}
                                  disabled={slotsSaving || action !== null}
                                >
                                  <ArrowLeft className="h-3.5 w-3.5" />
                                  移除
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 shrink-0"
                                      aria-label={`设备操作 ${identityDeviceName(identity)}`}
                                      disabled={slotsSaving || action !== null}
                                    >
                                      <MoreVertical className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-44">
                                    <DropdownMenuLabel className="text-[11px]">
                                      {identityDeviceName(identity)}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="gap-2 text-xs"
                                      onSelect={() => {
                                        setRenameDeviceTarget({ id: identity.id, name: identityDeviceName(identity), identityId: identity.id });
                                        setRenameDeviceValue(identityDeviceName(identity));
                                      }}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                      重命名设备
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="gap-2 text-xs text-destructive"
                                      onSelect={() => removeSlot(identity.id)}
                                    >
                                      <ArrowLeft className="h-3.5 w-3.5" />
                                      从设备列表移除
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            );
                          })}
                          {serverOnlyDevices.map((device) => {
                            const credentialId = device.credential_id || device.credentialId;
                            const jwtIssuedAt = device.jwt_iat ?? device.jwtIat;
                            const currentDevice =
                              device.thisDevice === true || device.local === true || device.current === true;
                            return (
                              <div
                                key={device.id}
                                className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-xs opacity-90"
                              >
                                <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate font-medium">{device.name || '未命名设备'}</span>
                                    <Badge variant="outline">{device.type || 'unknown'}</Badge>
                                    {currentDevice || device.primary ? <Badge variant="success">主设备（本机）</Badge> : null}
                                    <Badge variant="muted">服务端设备</Badge>
                                  </div>
                                  <div className="truncate text-[10px] text-muted-foreground">
                                    {device.id.slice(0, 8)}…
                                    {credentialId ? ` · cred ${credentialId.slice(0, 8)}…` : ''}
                                    {jwtIssuedAt ? ` · jwt ${formatDateTime(jwtIssuedAt)}` : ''}
                                  </div>
                                </div>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 shrink-0"
                                      aria-label={`设备操作 ${device.name || device.id}`}
                                      disabled={action !== null}
                                    >
                                      <MoreVertical className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-44">
                                    <DropdownMenuLabel className="text-[11px]">
                                      {device.name || device.id.slice(0, 8)}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="gap-2 text-xs"
                                      disabled={!device.matchedIdentityId}
                                      onSelect={() => {
                                        if (!device.matchedIdentityId) return;
                                        setRenameDeviceTarget({
                                          id: device.matchedIdentityId,
                                          name: device.name || device.id,
                                          identityId: device.matchedIdentityId
                                        });
                                        setRenameDeviceValue(device.name || '');
                                      }}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                      重命名设备
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="gap-2 text-xs text-destructive"
                                      onSelect={() => setRemoveDeviceTarget(device)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                      从 DuckDuckGo 删除设备
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      {deviceSlotsDirty ? (
                        <Badge variant="warning" data-testid="device-slots-dirty">
                          有未保存更改
                        </Badge>
                      ) : (
                        <Badge variant="success" data-testid="device-slots-clean">
                          已保存
                        </Badge>
                      )}
                      <span className="text-muted-foreground">
                        右侧将注册 {rightSlotIdentities.length} 个身份设备
                      </span>
                    </div>
                    <Button
                      size="sm"
                      aria-label="保存设备槽位"
                      onClick={saveDeviceSlots}
                      disabled={slotsSaving || action !== null || !deviceSlotsDirty}
                    >
                      {slotsSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      保存
                    </Button>
                  </div>
                </div>
          </CardContent>
        </Card>

      </div>

      {/* ------------------------------ 对话框 ------------------------------ */}

      <Dialog
        open={rotateOpen && rotateStep === 1}
        onOpenChange={(open) => {
          if (action) return;
          if (!open) {
            setRotateOpen(false);
            setRotateStep(1);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="rotate-step1-dialog">
          <DialogHeader>
            <DialogTitle>轮换身份（第 1 / 2 步）</DialogTitle>
            <DialogDescription>
              轮换会重新生成 journeyId / deviceId / RSA 指纹，可能导致 duck.ai 将本机识别为新设备。
              请选择范围后进入二次确认。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>轮换范围</Label>
            <Select value={rotateScope} onValueChange={(value) => setRotateScope(value as RotateScope)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all（journey + device + 密钥，推荐）</SelectItem>
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
                setRotateOpen(false);
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
        open={rotateOpen && rotateStep === 2}
        onOpenChange={(open) => {
          if (action) return;
          if (!open) {
            setRotateOpen(false);
            setRotateStep(1);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="rotate-step2-dialog">
          <DialogHeader>
            <DialogTitle>确认轮换（不可恢复）</DialogTitle>
            <DialogDescription>此操作会直接替换当前匿名身份，且无法撤销。</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              轮换会导致身份直接丢失（旧 journeyId / durableStream 密钥无法恢复，且无法找回）。
              确认后本机将作为全新匿名身份访问上游，历史匿名身份不可恢复。
            </span>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            轮换范围：<span className="font-mono text-foreground">{rotateScope}</span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="rotate-cancel"
              onClick={() => {
                setRotateOpen(false);
                setRotateStep(1);
              }}
              disabled={action !== null}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              data-testid="rotate-confirm"
              onClick={rotateIdentity}
              disabled={action !== null}
            >
              {action === 'rotate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              确认轮换（不可恢复）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={officialQrOpen} onOpenChange={(open) => setOfficialQrOpen(open)}>
        <DialogContent className="max-w-md" data-testid="official-code-qr-dialog">
          <DialogHeader>
            <DialogTitle>扫描恢复码</DialogTitle>
            <DialogDescription>另一台设备用 DuckDuckGo Sync → 输入/扫描恢复码</DialogDescription>
          </DialogHeader>
          {officialQrLoading ? (
            <Skeleton className="mx-auto h-[280px] w-[280px] rounded-lg" />
          ) : officialQrDataUrl ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border bg-white p-3">
              <img
                src={officialQrDataUrl}
                alt="官方恢复码二维码"
                data-testid="official-code-qr-image"
                width={280}
                height={280}
                className="h-[280px] w-[280px] rounded-md bg-white"
              />
              <p className="text-center text-[11px] leading-relaxed text-slate-600">
                在另一台设备打开 DuckDuckGo → Sync &amp; Backup → 扫描恢复码
              </p>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">二维码生成失败（恢复码为空）</p>
          )}
          <code
            data-testid="official-code-qr-text"
            className="block max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[11px] select-all"
          >
            {officialCode?.code || ''}
          </code>
          <DialogFooter>
            <CopyButton value={officialCode?.code || ''} size="sm" variant="outline" label="复制恢复码" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="下载恢复码二维码 PNG"
              onClick={() => {
                if (officialQrDataUrl) {
                  downloadDataUrl(`duckai-official-recovery-code-${Date.now()}.png`, officialQrDataUrl);
                  toast.success('恢复码二维码已下载');
                }
              }}
              disabled={!officialQrDataUrl}
            >
              <Download className="h-3.5 w-3.5" />
              下载 PNG
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setOfficialQrOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeDeviceTarget)}
        onOpenChange={(open) => (!open && action === null ? setRemoveDeviceTarget(null) : null)}
        title={`删除设备「${removeDeviceTarget?.name || removeDeviceTarget?.id || ''}」？`}
        description="将从 DuckDuckGo Sync 设备列表中注销该设备（手机端 My Devices 不再显示）；注销后该设备失效，需要时可重新注册。本机匿名身份、配对账号与官方恢复码不受影响。"
        confirmText="删除设备"
        destructive
        onConfirm={deleteServerDevice}
      />

      <Dialog open={importOpen} onOpenChange={(open) => (!action ? setImportOpen(open) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入身份文件</DialogTitle>
            <DialogDescription>
              粘贴导出的身份 JSON（包含私钥/token 的完整备份），或选择文件。导入会原子替换当前身份。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="identity-file">选择身份 JSON 文件</Label>
              <Input
                id="identity-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => onImportFile(event.target.files?.[0] ?? null)}
              />
              {importFileName ? <p className="text-[11px] text-muted-foreground">已读取：{importFileName}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="identity-json">或粘贴 JSON</Label>
              <Textarea
                id="identity-json"
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

      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>恢复码</DialogTitle>
            <DialogDescription>
              启用 Sync 时生成，仅用于在新设备/新环境还原 mainKey 与加密私钥。请立即复制并离线保存。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>完整恢复码</Label>
            <Textarea readOnly value={recoveryCode} rows={4} className="font-mono text-xs" />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            恢复码等同于 Sync 主密钥，泄露即可能被他人还原；不要通过聊天工具明文发送。
          </div>
          <DialogFooter>
            <CopyButton value={recoveryCode} label="复制" />
            <Button variant="outline" onClick={downloadRecoveryCode}>
              <Download className="h-3.5 w-3.5" />
              下载 .txt
            </Button>
            <Button onClick={() => setRecoveryOpen(false)}>关闭</Button>
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
        <DialogContent className="max-w-md" data-testid="rename-device-dialog">
          <DialogHeader>
            <DialogTitle>重命名设备</DialogTitle>
            <DialogDescription>
              修改该身份在 DuckDuckGo Sync 设备列表（My Devices）中显示的名称；保存后会立即同步到账号。
            </DialogDescription>
          </DialogHeader>
          <Input
            data-testid="rename-device-input"
            value={renameDeviceValue}
            onChange={(event) => setRenameDeviceValue(event.target.value)}
            placeholder="例如 DuckAI@main"
            maxLength={100}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDeviceTarget(null)}
              disabled={action !== null}
            >
              取消
            </Button>
            <Button
              data-testid="rename-device-submit"
              disabled={action !== null || !renameDeviceValue.trim()}
              onClick={() => void renameDevice()}
            >
              {action === 'rename-device' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存名称
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOwnOpen}
        onOpenChange={(open) => {
          if (!open && action === null) setCreateOwnOpen(false);
        }}
      >
        <DialogContent className="max-w-md" data-testid="sync-own-account-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              Sync This Device Only？
            </DialogTitle>
            <DialogDescription>
              为这台网关创建一个**独立的 DuckDuckGo Sync 备份账号**（等价于 duck.ai 设置里的
              「Sync This Device Only」）。恢复码会保存在本机，可随时在下方查看/下载。
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            <li>不会影响手机或其他浏览器上的账号；</li>
            <li>当前同步账号（{accountSource === 'pairing' ? '通过配对加入的账号' : accountSource === 'manual' ? '手动恢复码账号' : '未配置'}）会被替换为新账号；</li>
            <li>匿名身份（journeyId / 指纹）、API Key、聊天与订阅都不受影响。</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOwnOpen(false)} disabled={action !== null}>
              取消
            </Button>
            <Button
              data-testid="sync-own-account-submit"
              disabled={action !== null}
              onClick={() => void createOwnAccount()}
            >
              {action === 'create-own-account' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              创建本机账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteSyncOpen}
        onOpenChange={(open) => {
          if (!open && action === null) {
            setDeleteSyncOpen(false);
            setDeleteSyncConfirmText('');
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="sync-delete-data-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              删除 Sync &amp; Backup 数据？
            </DialogTitle>
            <DialogDescription>
              这会执行 DuckDuckGo「Delete Sync &amp; Backup data」的等价操作：注销本账号下所有网关设备、清除本机
              保存的官方恢复码并停止同步。匿名身份（journeyId / 本机指纹）保留，但不再参与逐设备同步。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              <li>设备将从 DuckDuckGo 设备列表移除，手机端 My Devices 不再显示它们；</li>
              <li>官方恢复码会被清除，需要重新配对才能再次同步；</li>
              <li>匿名身份与 API Key 不受影响，聊天/付费模型仍可用。</li>
            </ul>
            <div className="space-y-1">
              <Label htmlFor="delete-sync-confirm">
                输入 <span className="font-mono font-semibold">DELETE</span> 以确认
              </Label>
              <Input
                id="delete-sync-confirm"
                data-testid="sync-delete-data-confirm-input"
                value={deleteSyncConfirmText}
                onChange={(event) => setDeleteSyncConfirmText(event.target.value)}
                placeholder="DELETE"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteSyncOpen(false);
                setDeleteSyncConfirmText('');
              }}
              disabled={action !== null}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              data-testid="sync-delete-data-submit"
              disabled={action !== null || deleteSyncConfirmText.trim().toUpperCase() !== 'DELETE'}
              onClick={() => void deleteSyncData()}
            >
              {action === 'sync-delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              删除数据并停止同步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={disableSyncOpen}
        onOpenChange={setDisableSyncOpen}
        title="停用 Sync & Backup？"
        description="将清空本地的 mainKey / 加密私钥与恢复码（durable stream 身份保留）。请先确认已离线保存恢复码。"
        confirmText="停用"
        destructive
        onConfirm={disableSync}
      />

      <ConfirmDialog
        open={logoutSubOpen}
        onOpenChange={setLogoutSubOpen}
        title="注销 DuckDuckGo 订阅？"
        description="将从 data/identity.json 清除 token，后续上游请求回到匿名 free；可随时重新粘贴 token 激活。"
        confirmText="注销"
        destructive
        onConfirm={logoutSubscription}
      />
    </div>
  );
}
