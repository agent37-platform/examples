import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/util';

type Variant = 'muted' | 'success' | 'running' | 'danger' | 'warning' | 'review';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  muted: 'bg-muted text-muted-foreground',
  success: 'bg-success/10 text-success',
  running: 'bg-running/10 text-running',
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  review: 'bg-violet-50 text-violet-600',
};

/** A small status pill — soft alpha washes for the colored variants. */
export function Badge({ className, variant = 'muted', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
