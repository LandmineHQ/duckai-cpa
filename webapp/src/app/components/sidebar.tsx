import {
  Activity,
  Check,
  ChevronDown,
  Code2,
  CreditCard,
  Fingerprint,
  History,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  Network,
  Radar,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sun,
  Users,
  X
} from 'lucide-react';
import type { Route } from '@/app/lib/hash-route';
import { ROUTE_META } from '@/app/lib/hash-route';
import { useOverview } from '@/app/lib/overview-context';
import { useTheme, type ThemeMode } from '@/app/lib/theme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Brand } from './brand';

export interface NavItem {
  route: Route;
  label: string;
  icon: typeof LayoutDashboard;
}

export const NAV_GROUPS: Array<{ code: string; label: string; items: NavItem[] }> = [
  {
    code: '01',
    label: '工作台',
    items: [
      { route: 'overview', label: '概览', icon: LayoutDashboard },
      { route: 'chat', label: '连接测试', icon: MessagesSquare },
      { route: 'images', label: '图片工坊', icon: ImagePlus },
      { route: 'history', label: '会话历史', icon: History }
    ]
  },
  {
    code: '02',
    label: '身份与网络',
    items: [
      { route: 'identity', label: '默认身份', icon: Fingerprint },
      { route: 'identities', label: '身份池', icon: Users },
      { route: 'subscriptions', label: '订阅', icon: CreditCard },
      { route: 'proxy', label: '代理', icon: Network }
    ]
  },
  {
    code: '03',
    label: '运维与配置',
    items: [
      { route: 'recon', label: '前端 Recon', icon: Radar },
      { route: 'model-config', label: '模型配置', icon: SlidersHorizontal },
      { route: 'keys', label: 'API Key', icon: KeyRound },
      { route: 'logs', label: '日志', icon: ScrollText },
      { route: 'settings', label: '设置', icon: Settings },
      { route: 'examples', label: '示例', icon: Code2 }
    ]
  }
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor }
];

function connectionState(data: ReturnType<typeof useOverview>['data'], error: string | null) {
  if (error) return { dot: 'bg-destructive', label: '连接失败', tone: 'text-destructive' };
  if (!data) return { dot: 'bg-muted-foreground animate-pulse', label: '连接中…', tone: 'text-muted-foreground' };
  const upstream = data.upstream;
  if (upstream?.rateLimited) return { dot: 'bg-amber-500', label: '上游限流', tone: 'text-amber-600 dark:text-amber-400' };
  if (upstream?.ok) return { dot: 'bg-emerald-500', label: '上游正常', tone: 'text-emerald-600 dark:text-emerald-400' };
  if (upstream?.challengeOk) {
    return { dot: 'bg-amber-500', label: '部分可用', tone: 'text-amber-600 dark:text-amber-400' };
  }
  return { dot: 'bg-destructive', label: '上游异常', tone: 'text-destructive' };
}

export function Sidebar({
  route,
  mobileOpen,
  onCloseMobile,
  onLogout
}: {
  route: Route;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onLogout: () => void;
}) {
  const { data, error } = useOverview();
  const { theme, setTheme } = useTheme();
  const status = connectionState(data, error);
  const queue = data?.upstream?.queue;
  const currentTheme = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[2];
  const ThemeIcon = currentTheme.icon;

  return (
    <>
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border/80 bg-card transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border/70 px-4">
          <a href="#/overview" className="rounded-md" onClick={onCloseMobile}>
            <Brand />
          </a>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="关闭菜单" onClick={onCloseMobile}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-2.5 py-3" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <div key={group.code} className="space-y-1">
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                <span className="font-mono text-primary/70">{group.code}</span>
                <span>{group.label}</span>
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = route === item.route;
                  return (
                    <a
                      key={item.route}
                      href={`#/${item.route}`}
                      onClick={onCloseMobile}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                        active
                          ? 'bg-primary/12 text-primary shadow-[inset_2px_0_0_0_hsl(var(--primary))]'
                          : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                      )}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                      <span className="truncate">{item.label}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-1.5 border-t border-border/70 p-2.5">
          <div className="rounded-lg border border-border/60 bg-muted/45 px-2.5 py-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', status.dot)} aria-hidden="true" />
              <span className={cn('truncate', status.tone)}>{status.label}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground tabular-nums">
                v{data?.service?.version ?? '—'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground tabular-nums">
              <Activity className="h-3 w-3 shrink-0" />
              执行 {queue?.inFlight ?? 0} · 排队 {queue?.waiting ?? 0} · RPS {queue?.rps ?? 1}
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={ROUTE_META[route]?.description}>
              {data?.upstream?.challengeOk === true ? 'x-vqd-hash-1 已就绪' : '挑战状态未知'}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 flex-1 justify-between px-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5 truncate">
                    <ThemeIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{currentTheme.label}</span>
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>界面主题</DropdownMenuLabel>
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
                      <Icon className="h-3.5 w-3.5" />
                      {option.label}
                      {theme === option.value ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogout}>
                  <LogOut className="h-3.5 w-3.5" />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onLogout}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
