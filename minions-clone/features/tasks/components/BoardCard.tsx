'use client';

import { useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { cn, timeAgo } from '@/lib/util';
import { columnForStatus, type BoardColumnId, type Task } from '@/features/tasks/types';
import { COLUMN_META, COLUMN_ORDER } from '@/features/tasks/lib/board-meta';

export interface BoardCardProps {
  task: Task;
  now: number;
  onDelete: (id: string) => void;
  onMove: (id: string, target: BoardColumnId) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, task: Task) => void;
  onDragEnd: () => void;
  dragging: boolean;
}

/** Where the floating "..." menu should anchor (viewport coords, so column overflow can't clip it). */
interface MenuAnchor {
  top: number;
  right: number;
}

/**
 * A single draggable task card. The outer div is the HTML5 drag source (it carries
 * `data-card-id`, which the board reads to compute drop positions); the inner Card is the
 * visual. Clicking the body opens the task; the "..." menu offers "Move to" the other two
 * columns (a status change) and Delete.
 */
export function BoardCard({ task, now, onDelete, onMove, onDragStart, onDragEnd, dragging }: BoardCardProps) {
  const router = useRouter();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // True between dragstart and the click that may fire right after, so a drag never navigates.
  const draggedRef = useRef(false);

  // The menu offers the two columns this card is NOT currently in.
  const currentColumn = columnForStatus(task.status);
  const moveTargets = COLUMN_ORDER.filter((c) => c !== currentColumn);

  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    draggedRef.current = true;
    setMenu(null);
    onDragStart(e, task);
  };

  const handleDragEnd = () => {
    onDragEnd();
    // Let the trailing click (if any) see the flag, then clear it.
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  };

  const handleClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return; // a drag just finished — swallow the click
    }
    router.push(`/tasks/${task.id}`);
  };

  const toggleMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (menu) {
      setMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  const handleMove = (target: BoardColumnId) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setMenu(null);
    onMove(task.id, target);
  };

  const removeTask = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setMenu(null);
    if (window.confirm('Delete this task? This cannot be undone.')) onDelete(task.id);
  };

  return (
    <div
      data-card-id={task.id}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      className={cn('cursor-grab active:cursor-grabbing', dragging && 'opacity-50')}
    >
      <Card className="group relative p-3 transition-shadow hover:shadow-sm">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{task.prompt}</p>
          </div>
          <IconButton
            label="Task options"
            onClick={toggleMenu}
            className={cn(
              '-mr-1 -mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
              menu && 'opacity-100',
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-subtle">{timeAgo(task.updatedAt, now)}</span>
          <span className="ml-auto">
            {task.status === 'failed' && <Badge variant="danger">Failed</Badge>}
            {task.status === 'cancelled' && <Badge variant="muted">Cancelled</Badge>}
            {task.status === 'running' && (
              <span className="inline-flex items-center gap-1 text-xs text-running">
                <Spinner className="h-3 w-3 text-running" />
                Running
              </span>
            )}
          </span>
        </div>

        {menu && (
          <>
            {/* Click-away backdrop. */}
            <div
              className="fixed inset-0 z-30"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(null);
              }}
            />
            <div
              className="fixed z-40 w-52 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md"
              style={{ top: menu.top, right: menu.right }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="px-3 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Move to</p>
              {moveTargets.map((target) => {
                const { label, Icon, iconClass } = COLUMN_META[target];
                return (
                  <button
                    key={target}
                    type="button"
                    onClick={handleMove(target)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <Icon className={cn('h-4 w-4', iconClass)} />
                    {label}
                  </button>
                );
              })}
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={removeTask}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/5"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
