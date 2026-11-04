import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  title
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'primary' | 'danger' | 'success' | 'warning';
  title?: string;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-primary/25 bg-primary/5'
      : tone === 'danger'
        ? 'border-destructive/25 bg-destructive/5'
        : tone === 'success'
          ? 'border-emerald-500/25 bg-emerald-500/5'
          : tone === 'warning'
            ? 'border-amber-500/25 bg-amber-500/5'
            : '';
  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-sm', toneClass)} title={title}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
      </div>
      <div className="mt-1.5 truncate text-xl font-semibold tabular-nums sm:text-2xl" title={value}>
        {value}
      </div>
      {hint ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground" title={hint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
