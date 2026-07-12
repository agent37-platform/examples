import { Check, Contrast, X } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/util';
import { STATUS_LABELS, type TaskStatus } from '@/features/tasks/types';

/**
 * The task's lifecycle status as a small pill. The reference puts "Ready for review" in a soft
 * violet with a half-filled circle; the rest reuse the app's status accents.
 */
export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        styles[status],
      )}
    >
      <Glyph status={status} />
      {STATUS_LABELS[status]}
    </span>
  );
}

const styles: Record<TaskStatus, string> = {
  ready_for_review: 'border border-violet-100 bg-violet-50 text-violet-600',
  running: 'bg-running/10 text-running',
  completed: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  cancelled: 'bg-muted text-muted-foreground',
  queued: 'bg-muted text-muted-foreground',
};

function Glyph({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'ready_for_review':
      return <Contrast className="h-3.5 w-3.5" aria-hidden="true" />;
    case 'running':
      return <Spinner className="h-3.5 w-3.5 text-running" />;
    case 'completed':
      return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
    case 'failed':
      return <X className="h-3.5 w-3.5" aria-hidden="true" />;
    default:
      return null;
  }
}
