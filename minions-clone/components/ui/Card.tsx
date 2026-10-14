import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/util';

export type CardProps = HTMLAttributes<HTMLDivElement>;

/** A flat surface with a hairline border — the reference favors borders over shadows. */
export function Card({ className, ...props }: CardProps) {
  return <div className={cn('rounded-xl border border-border bg-card', className)} {...props} />;
}
