'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Spinner } from '@/components/ui/Spinner';
import { cn, timeAgo } from '@/lib/util';
import type { TaskStatus } from '@/features/tasks/types';
import { StatusPill } from './StatusPill';

interface TaskHeaderProps {
  taskId: string;
  title: string;
  status: TaskStatus;
  updatedAt: number;
  onRename: (title: string) => void | Promise<void>;
  onMarkComplete: () => void | Promise<void>;
  onReopen: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

/** The detail page header: an editable title on the left, status + lifecycle controls on the right. */
export function TaskHeader({
  taskId,
  title,
  status,
  updatedAt,
  onRename,
  onMarkComplete,
  onReopen,
  onDelete,
}: TaskHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <EditableTitle title={title} onRename={onRename} />
      <HeaderActions
        taskId={taskId}
        status={status}
        updatedAt={updatedAt}
        onMarkComplete={onMarkComplete}
        onReopen={onReopen}
        onDelete={onDelete}
      />
    </div>
  );
}

function EditableTitle({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const begin = () => {
    setDraft(title);
    setEditing(true);
  };

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) void onRename(next);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(title);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        aria-label="Task title"
        className={cn(
          'w-full max-w-xl rounded-lg border border-input bg-background px-2 py-1 text-2xl font-semibold',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      />
    );
  }

  return (
    <div className="group flex min-w-0 items-center gap-2">
      <h1 className="truncate text-2xl font-semibold text-foreground">{title}</h1>
      <IconButton
        label="Rename task"
        onClick={begin}
        className="opacity-60 transition-opacity group-hover:opacity-100"
      >
        <Pencil className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function HeaderActions({
  taskId,
  status,
  updatedAt,
  onMarkComplete,
  onReopen,
  onDelete,
}: {
  taskId: string;
  status: TaskStatus;
  updatedAt: number;
  onMarkComplete: () => void | Promise<void>;
  onReopen: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  // Compute the relative time only on the client to avoid an SSR/CSR hydration mismatch, and
  // refresh it on a slow interval so "just now" ages naturally.
  const [now, setNow] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await onMarkComplete();
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-3">
      <StatusPill status={status} />
      <span className="text-sm text-muted-foreground">{now === null ? '' : timeAgo(updatedAt, now)}</span>

      {status === 'ready_for_review' && (
        <Button variant="primary" size="sm" onClick={handleComplete} disabled={completing}>
          {completing ? <Spinner className="h-4 w-4 text-background" /> : <Check className="h-4 w-4" />}
          Mark complete
        </Button>
      )}

      <OverflowMenu taskId={taskId} status={status} onReopen={onReopen} onDelete={onDelete} />
    </div>
  );
}

function OverflowMenu({
  taskId,
  status,
  onReopen,
  onDelete,
}: {
  taskId: string;
  status: TaskStatus;
  onReopen: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleReopen = () => {
    setOpen(false);
    void onReopen();
  };

  const handleDelete = () => {
    setOpen(false);
    if (window.confirm('Delete this task? This cannot be undone.')) void onDelete();
  };

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-task-id={taskId}
      >
        <MoreHorizontal className="h-[18px] w-[18px]" />
      </IconButton>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-sm"
        >
          {status === 'completed' && (
            <button
              type="button"
              role="menuitem"
              onClick={handleReopen}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
            >
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
              Reopen
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleDelete}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/5"
          >
            <Trash2 className="h-4 w-4" />
            Delete task
          </button>
        </div>
      )}
    </div>
  );
}
