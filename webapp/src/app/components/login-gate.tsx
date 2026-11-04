import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, LogIn } from 'lucide-react';
import { BrandMark } from './brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginGate({
  onLogin,
  busy,
  error
}: {
  onLogin: (token: string) => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) {
      setLocalError('请输入 admin token');
      return;
    }
    setLocalError(null);
    await onLogin(value);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-lg">
        <div className="mb-5 flex items-center gap-2.5">
          <BrandMark />
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight">DuckAI CPA</div>
            <div className="text-xs text-muted-foreground">OpenAI 兼容网关 · 管理控制台</div>
          </div>
        </div>
        <h1 className="text-lg font-semibold">登录管理控制台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          输入启动日志或 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">data/config.json</code> 中的 admin token；
          也可用 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">/admin?token=…</code> 快捷登录。
        </p>

        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="login-token">Admin Token</Label>
            <div className="flex gap-2">
              <Input
                id="login-token"
                type={reveal ? 'text' : 'password'}
                value={token}
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                placeholder="change-me-admin-token"
                onChange={(event) => setToken(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={reveal ? '隐藏 token' : '显示 token'}
                onClick={() => setReveal((value) => !value)}
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {error || localError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {localError ?? error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {busy ? '验证中…' : '登录'}
          </Button>
        </form>

        <p className="mt-5 flex items-start gap-1.5 border-t pt-4 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Token 仅保存在当前浏览器的 localStorage，不会发送给 duck.ai 或任何第三方。
        </p>
      </div>
    </div>
  );
}
