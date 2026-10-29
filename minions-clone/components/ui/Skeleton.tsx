import { cn } from '@/lib/util';

export interface SkeletonProps {
  className?: string;
}

/** A shimmering placeholder block for loading states. */
export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}
