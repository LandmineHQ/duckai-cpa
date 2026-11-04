/** admin token 存取：?token= → localStorage → 登录门。 */

const TOKEN_KEY = 'duckai_cpa_admin_token';

export function readStoredToken(): string {
  try {
    return (localStorage.getItem(TOKEN_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function readTokenFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    return token ? token.trim() : null;
  } catch {
    return null;
  }
}

/** 从地址栏移除 ?token=（已写入 localStorage / 内存）。 */
export function stripTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    const search = url.searchParams.toString();
    const next = `${url.pathname}${search ? `?${search}` : ''}${url.hash || window.location.hash || ''}`;
    window.history.replaceState(null, '', next);
  } catch {
    /* ignore */
  }
}
