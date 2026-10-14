import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/util';

export interface SpinnerProps {
  className?: string;
}

/** A quiet spinning loader for inline/pending states. */
export function Spinner({ className }: SpinnerProps) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} />;
}
