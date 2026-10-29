'use client';

import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/util';
import type { BoardColumnId, Task } from '@/features/tasks/types';
import type { BoardColumnDef } from '@/features/tasks/lib/board';
import { COLUMN_META } from '@/features/tasks/lib/board-meta';

export interface BoardColumnProps {
  column: BoardColumnDef;
  tasks: Task[];
  isDropTarget: boolean;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDeleteAll: (column: BoardColumnId) => void;
  renderCard: (task: Task) => ReactNode;
}

/** Shared icon-button styling for the header "+" link (a Link, not a <button>, to nest in an anchor cleanly). */
const ICON_LINK_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * One board column: a muted header (icon + UPPERCASE label + count + controls) over a full-height
 * drop zone. The drop zone keeps a minimum height so even an empty column accepts drops, and it
 * highlights while a card hovers it.
 */
export function BoardColumn({
  column,
  tasks,
  isDropTarget,
  onDrop,
  onDragOver,
  onDragLeave,
  onDeleteAll,
  renderCard,
}: BoardColumnProps) {
  const { Icon, iconClass } = COLUMN_META[column.id];
  const isInProgress = column.id === 'in_progress';
  // Fixed-position menu anchored to the "..." button (avoids clipping by the board's overflow).
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);

  const toggleMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (menu) {
      setMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  const handleDeleteAll = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setMenu(null);
    if (tasks.length === 0) return;
    const plural = tasks.length === 1 ? 'task' : 'tasks';
    if (window.confirm(`Delete all ${tasks.length} ${plural} in ${column.label}? This cannot be undone.`)) {
      onDeleteAll(column.id);
    }
  };

  return (
    <div className="flex w-80 shrink-0 flex-col">
      <div className="flex items-center gap-2 px-1 pb-3">
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} aria-hidden="true" />
        <span className="text-xs font-semibold tracking-wide text-muted-foreground">{column.label}</span>
        <span className="text-xs text-subtle">{tasks.length}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={`${column.label} options`}
            onClick={toggleMenu}
            className={cn(menu && 'bg-muted text-foreground')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
          {isInProgress && (
            <Link href="/tasks/new" aria-label="New task" title="New task" className={ICON_LINK_CLASS}>
              <Plus className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>

      {menu && (
        <>
          {/* Click-away backdrop. */}
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 w-56 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md"
            style={{ top: menu.top, right: menu.right }}
          >
            <button
              type="button"
              onClick={handleDeleteAll}
              disabled={tasks.length === 0}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Trash2 className="h-4 w-4" />
              {COLUMN_META[column.id].deleteAllLabel}
            </button>
          </div>
        </>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={cn(
            'flex min-h-full flex-col gap-3 rounded-xl p-1 transition-colors',
            isDropTarget && 'bg-muted/60 ring-1 ring-inset ring-ring',
          )}
        >
          {tasks.map((task) => renderCard(task))}

          {isInProgress && (
            <Link
              href="/tasks/new"
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-input py-2 text-sm text-muted-foreground transition-colors hover:border-ring hover:bg-muted/50 hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              Add task
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
