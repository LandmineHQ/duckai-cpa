import {
  History, Activity, Check, ChevronDown, Code2, CreditCard, Fingerprint, KeyRound, LayoutDashboard, LogOut, MessagesSquare, Monitor, Moon, Network, ScrollText, Settings, SlidersHorizontal, Sun, Users, X } from 'lucide-react';
import type { Route } from '@/app/lib/hash-route';
import {
  ROUTE_META } from '@/app/lib/hash-route';
import {
  useOverview } from '@/app/lib/overview-context';
import {
  useTheme, type ThemeMode } from '@/app/lib/theme';
import {
  cn } from '@/lib/utils';
import {
  Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Brand } from './brand';

const NAV_ITEMS: Array<{ route: Route; label: string; icon: typeof LayoutDashboard }> = [
  { route: 'overview', label: '概览', icon: LayoutDashboard },
  { route: 'chat', label: '连接测试', icon: MessagesSquare },
  { route: 'identity', label: '默认身份', icon: Fingerprint },
  { route: 'identities', label: '身份池', icon: Users },
  { route: 'subscriptions', label: '订阅', icon: CreditCard },
  { route: 'history', label: '会话历史', icon: History },
  { route: 'proxy', label: '代理', icon: Network },
  { route: 'settings', label: '设置', icon: Settings },
  { route: 'model-config', label: '模型配置', icon: SlidersHorizontal },
  { route: 'keys', label: 'API Key', icon: KeyRound },
  { route: 'logs', label: '日志', icon: ScrollText },
  { route: 'examples', label: '示例', icon: Code2 }
];

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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-4">
          <a href="#/overview" className="rounded-md" onClick={onCloseMobile}>
            <Brand />
          </a>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="关闭菜单" onClick={onCloseMobile}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = route === item.route;
            return (
              <a
                key={item.route}
                href={`#/${item.route}`}
                onClick={onCloseMobile}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Icon className={cn('h-4 w-4', active ? 'text-primary' : '')} />
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="space-y-2 border-t p-3">
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', status.dot)} aria-hidden="true" />
              <span className={cn('truncate', status.tone)}>{status.label}</span>
              <span className="ml-auto truncate text-[10px] text-muted-foreground">
                v{data?.service?.version ?? '0.1.0'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <Activity className="h-3 w-3" />
              执行 {queue?.inFlight ?? 0} · 排队 {queue?.waiting ?? 0} · RPS {queue?.rps ?? 1}
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={ROUTE_META[route].description}>
              {data?.upstream?.challengeOk === true ? 'x-vqd-hash-1 已就绪' : '挑战状态未知'}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-between px-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <ThemeIcon className="h-3.5 w-3.5" />
                  主题：{currentTheme.label}
                </span>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
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
            className="w-full justify-start px-2 text-xs text-muted-foreground"
            onClick={onLogout}
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </Button>
        </div>
      </aside>
    </>
  );
}

export { NAV_ITEMS };
