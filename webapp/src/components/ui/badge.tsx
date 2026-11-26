import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-emerald-200/70 bg-emerald-100/80 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300',
        warning: 'border-amber-200/70 bg-amber-100/80 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-300',
        info: 'border-sky-200/70 bg-sky-100/80 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/15 dark:text-sky-300',
        muted: 'border-transparent bg-muted text-muted-foreground',
        accent: 'border-transparent bg-accent text-accent-foreground',
        mono: 'border-border/80 bg-muted/60 font-mono text-[11px] text-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
