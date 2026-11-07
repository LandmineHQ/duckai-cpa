import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { maskIp } from '../lib/mask-ip.mjs';

/**
 * 默认脱敏展示 IP，点击眼睛按钮后显示/隐藏真实值。
 * 不持久化 reveal 状态（刷新/重新挂载后回到脱敏状态）。
 */
export function MaskedIp({ value, className }: { value?: string | null; className?: string }) {
  const [revealed, setRevealed] = useState(false);
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return <span className={className}>—</span>;

  const masked = maskIp(raw);
  // 非 IP 文本会被 maskIp 变成 ***；仍允许点击查看原值，便于排障
  const canToggle = masked !== raw;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={className} title={revealed ? undefined : '点击右侧按钮显示真实 IP'}>
        {revealed ? raw : masked}
      </span>
      {canToggle ? (
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? '隐藏真实 IP' : '显示真实 IP'}
          title={revealed ? '隐藏真实 IP' : '显示真实 IP'}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      ) : null}
    </span>
  );
}

export default MaskedIp;
