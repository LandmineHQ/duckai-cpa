import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'duckai_cpa_console_theme';

interface ThemeContextValue {
  theme: ThemeMode;
  resolved: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  try {
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    /* ignore */
  }
  return 'light';
}

function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* ignore */
  }
  return 'system';
}

function applyThemeClass(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => (theme === 'system' ? systemTheme() : theme));

  useEffect(() => {
    const next: ResolvedTheme = theme === 'system' ? systemTheme() : theme;
    setResolved(next);
    applyThemeClass(next);
    if (theme !== 'system') return;
    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      media = null;
    }
    if (!media) return;
    const onChange = () => {
      const value = systemTheme();
      setResolved(value);
      applyThemeClass(value);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media?.removeEventListener('change', onChange);
    }
    // 老浏览器回退
    media.addListener?.(onChange);
    return () => media?.removeListener?.(onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
