import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, setUnauthorizedHandler } from './lib/api';
import { clearStoredToken, readStoredToken, readTokenFromUrl, storeToken, stripTokenFromUrl } from './lib/token';
import { useHashRoute, type Route } from './lib/hash-route';
import { ThemeProvider, useTheme } from './lib/theme';
import { OverviewProvider } from './lib/overview-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { BrandMark } from './components/brand';
import { ConsoleLayout } from './components/console-layout';
import { LoginGate } from './components/login-gate';
import { OverviewPage } from './pages/overview';
import { PlaygroundPage } from './pages/playground';
import { IdentityPage } from './pages/identity';
import { IdentitiesPage } from './pages/identities';
import { SubscriptionsPage } from './pages/subscriptions';
import { HistoryPage } from './pages/history';
import { ProxyPage } from './pages/proxy';
import { SettingsPage } from './pages/settings';
import { ModelConfigPage } from './pages/model-config';
import { KeysPage } from './pages/keys';
import { LogsPage } from './pages/logs';
import { ExamplesPage } from './pages/examples';

type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function BootSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
      <BrandMark className="h-12 w-12 animate-pulse" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在加载管理控制台…
      </div>
    </div>
  );
}

function PageFor({ route }: { route: Route }) {
  switch (route) {
    case 'overview':
      return <OverviewPage />;
    case 'chat':
      return <PlaygroundPage />;
    case 'identity':
      return <IdentityPage />;
    case 'identities':
      return <IdentitiesPage />;
    case 'subscriptions':
      return <SubscriptionsPage />;
    case 'history':
      return <HistoryPage />;
    case 'proxy':
      return <ProxyPage />;
    case 'settings':
      return <SettingsPage />;
    case 'model-config':
      return <ModelConfigPage />;
    case 'keys':
      return <KeysPage />;
    case 'logs':
      return <LogsPage />;
    case 'examples':
      return <ExamplesPage />;
    default:
      return <OverviewPage />;
  }
}

const ROUTE_TITLES: Record<Route, string> = {
  overview: '概览',
  chat: '连接测试',
  identity: '默认身份',
  identities: '身份池',
  subscriptions: '订阅',
  proxy: '代理',
  settings: '设置',
  'model-config': '模型配置',
  keys: 'API Key',
  logs: '日志',
  examples: '调用示例'
};

function AuthGate() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [loginBusy, setLoginBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [route, navigate] = useHashRoute();
  const authRef = useRef<AuthState>('checking');
  const lastUnauthorizedToast = useRef(0);

  authRef.current = auth;

  useEffect(() => {
    setUnauthorizedHandler((message) => {
      clearStoredToken();
      setAuth('unauthenticated');
      setAuthError(message || '管理 token 无效或已过期，请重新登录。');
      const now = Date.now();
      if (now - lastUnauthorizedToast.current > 3000) {
        lastUnauthorizedToast.current = now;
        toast.error(message || '管理 token 无效或已过期，请重新登录。');
      }
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const urlToken = readTokenFromUrl();
      if (urlToken) stripTokenFromUrl();
      const token = urlToken || readStoredToken();
      if (!token) {
        if (!cancelled) setAuth('unauthenticated');
        return;
      }
      storeToken(token);
      try {
        await apiGet('/overview', { suppressAuthHandler: true });
        if (!cancelled) setAuth('authenticated');
      } catch (error) {
        if (cancelled) return;
        clearStoredToken();
        setAuth('unauthenticated');
        setAuthError((error as Error)?.message || '自动登录失败，请重新输入 admin token');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (token: string) => {
    setLoginBusy(true);
    setAuthError(null);
    storeToken(token);
    try {
      await apiGet('/overview', { suppressAuthHandler: true });
      setAuth('authenticated');
      toast.success('登录成功');
    } catch (error) {
      clearStoredToken();
      setAuthError((error as Error)?.message || 'token 无效或已过期');
    } finally {
      setLoginBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setAuth('unauthenticated');
    setAuthError(null);
    toast.info('已退出登录');
  }, []);

  useEffect(() => {
    document.title = `${ROUTE_TITLES[route] ?? '管理控制台'} · DuckAI CPA`;
  }, [route]);

  if (auth === 'checking') return <BootSplash />;

  if (auth === 'unauthenticated') {
    return <LoginGate onLogin={login} busy={loginBusy} error={authError} />;
  }

  return (
    <OverviewProvider>
      <ConsoleLayout route={route} onLogout={logout}>
        <PageFor route={route} />
      </ConsoleLayout>
    </OverviewProvider>
  );
}

function AppFrame() {
  const { resolved } = useTheme();
  const lastErrorToast = useRef(0);

  useEffect(() => {
    const report = (message: string) => {
      const now = Date.now();
      if (now - lastErrorToast.current < 5000) return;
      lastErrorToast.current = now;
      toast.error(message, { duration: 6000 });
    };
    const onError = (event: ErrorEvent) => {
      // 资源加载失败等无 error 对象的事件忽略
      if (event?.error || event?.message) report('页面出现异常，请刷新重试；若持续出现请查看浏览器控制台。');
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event?.reason as { name?: string } | undefined;
      if (reason?.name === 'AbortError') return;
      report('页面出现未处理的异常，请刷新重试。');
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <>
      <AuthGate />
      <Toaster theme={resolved} />
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={200}>
        <AppFrame />
      </TooltipProvider>
    </ThemeProvider>
  );
}
