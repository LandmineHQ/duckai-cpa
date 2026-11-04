import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ErrorBanner({
  message,
  onRetry,
  actionLabel = '重试'
}: {
  message: string;
  onRetry?: () => void;
  actionLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{message}</div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} className="border-destructive/30 text-destructive hover:bg-destructive/10">
          <RotateCcw className="h-3.5 w-3.5" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
