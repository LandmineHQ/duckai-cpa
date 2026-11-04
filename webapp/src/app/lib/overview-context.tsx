import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { apiGet } from './api';
import type { Overview } from './types';

interface OverviewContextValue {
  data: Overview | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  refresh: () => void;
  /** v2.34：自动刷新间隔（毫秒；0 = 关闭） */
  refreshIntervalMs: number;
  setRefreshIntervalMs: (ms: number) => void;
}

const OverviewContext = createContext<OverviewContextValue | null>(null);

const POLL_INTERVAL_MS = 5000;
const REFRESH_INTERVAL_KEY = 'duckai_cpa_overview_refresh_ms';
const REFRESH_INTERVAL_OPTIONS = [0, 5000, 10000, 30000, 60000];

function readStoredInterval(): number {
  try {
    const raw = localStorage.getItem(REFRESH_INTERVAL_KEY);
    if (raw === null) return POLL_INTERVAL_MS;
    const value = Number(raw);
    return REFRESH_INTERVAL_OPTIONS.includes(value) ? value : POLL_INTERVAL_MS;
  } catch {
    return POLL_INTERVAL_MS;
  }
}

export function OverviewProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // v2.34：自动刷新间隔可配置（概览页第一行可展开调整；持久化到 localStorage）
  const [refreshIntervalMs, setRefreshIntervalState] = useState<number>(() => readStoredInterval());
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async (silent: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!silent) setLoading(true);
    try {
      const overview = await apiGet<Overview>('/overview');
      if (!mounted.current) return;
      setData(overview);
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (!mounted.current) return;
      const handled = Boolean((err as { handled?: boolean })?.handled);
      if (!handled) setError((err as Error)?.message || '无法获取概览数据');
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // v2.34：按可配置间隔轮询（0 = 关闭自动刷新）；页面隐藏时跳过
  useEffect(() => {
    if (!refreshIntervalMs) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, refreshIntervalMs);
    const onVisibility = () => {
      if (!document.hidden) void load(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, refreshIntervalMs]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  const setRefreshIntervalMs = useCallback((ms: number) => {
    const value = REFRESH_INTERVAL_OPTIONS.includes(ms) ? ms : POLL_INTERVAL_MS;
    setRefreshIntervalState(value);
    try {
      localStorage.setItem(REFRESH_INTERVAL_KEY, String(value));
    } catch {
      // ignore storage failures
    }
  }, []);

  const value = useMemo<OverviewContextValue>(
    () => ({ data, loading, error, lastUpdatedAt, refresh, refreshIntervalMs, setRefreshIntervalMs }),
    [data, loading, error, lastUpdatedAt, refresh, refreshIntervalMs, setRefreshIntervalMs]
  );

  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

export function useOverview(): OverviewContextValue {
  const context = useContext(OverviewContext);
  if (!context) throw new Error('useOverview must be used within OverviewProvider');
  return context;
}
