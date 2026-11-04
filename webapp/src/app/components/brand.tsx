import { cn } from '@/lib/utils';

/** DuckAI CPA 品牌标识（橙白，纯内联 SVG，无外部资源）。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn('h-8 w-8', className)} fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="#f97316" />
      <path
        d="M15 27c0-7 5-12 12-12h7v6l-4 2v3h4c0 7-5 11-11 11h-1v-6h-4l-3 6h-4l2-6h-3v-4h5z"
        fill="#fff"
      />
      <circle cx="29" cy="20" r="1.8" fill="#f97316" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      {compact ? null : (
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">DuckAI CPA</div>
          <div className="text-[11px] text-muted-foreground">管理控制台</div>
        </div>
      )}
    </div>
  );
}
