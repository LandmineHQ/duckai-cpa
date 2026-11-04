import type { ReactNode } from 'react';
import { QueueStatusChips } from './queue-status-chips';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  showQueue?: boolean;
}

export function PageHeader({ title, description, actions, showQueue = true }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {showQueue ? <QueueStatusChips /> : null}
        {actions}
      </div>
    </div>
  );
}
