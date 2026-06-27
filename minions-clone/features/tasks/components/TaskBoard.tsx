'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  columnForStatus,
  statusForColumnDrop,
  type BoardColumnId,
  type Task,
  type UpdateTaskRequest,
} from '@/features/tasks/types';
import { deleteTask, deleteTasksInColumn, updateTask } from '@/features/tasks/api/client';
import { COLUMNS, computeDropSortOrder, groupByColumn } from '@/features/tasks/lib/board';
import { BoardColumn } from './BoardColumn';
import { BoardCard } from './BoardCard';

export interface TaskBoardProps {
  initialTasks: Task[];
}

/**
 * Find the insertion slot (0..n) within a drop zone given the pointer Y. We measure the
 * non-dragged cards by their `data-card-id` rects and insert before the first card whose vertical
 * midpoint sits below the pointer; past the last card means "append".
 */
function insertionIndex(dropZone: HTMLElement, clientY: number, draggedId: string): number {
  const cards = Array.from(dropZone.querySelectorAll<HTMLElement>('[data-card-id]')).filter(
    (el) => el.dataset.cardId !== draggedId,
  );
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

/**
 * The Tasks board. Holds a local, optimistic copy of the tasks seeded from the server, runs
 * native HTML5 drag-and-drop across the three columns, and persists each move via PATCH —
 * reverting to a snapshot if the write fails.
 */
export function TaskBoard({ initialTasks }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  // 0 until mounted so SSR and the first client render agree; the effect swaps in the real clock.
  const [now, setNow] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetColumn, setDropTargetColumn] = useState<BoardColumnId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const grouped = useMemo(() => groupByColumn(tasks), [tasks]);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, task: Task) => {
    setDraggingId(task.id);
    setError(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id); // some browsers need a payload to start a drag
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDropTargetColumn(null);
  };

  const handleColumnDragOver = (column: BoardColumnId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); // required for onDrop to fire
    e.dataTransfer.dropEffect = 'move';
    setDropTargetColumn((prev) => (prev === column ? prev : column));
  };

  const handleColumnDragLeave = (column: BoardColumnId) => (e: DragEvent<HTMLDivElement>) => {
    // Only clear when the pointer truly leaves the column, not when crossing onto a child card.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropTargetColumn((prev) => (prev === column ? null : prev));
    }
  };

  // One place for the optimistic move/reorder lifecycle: apply locally, persist, reconcile the
  // server-authoritative fields, and roll back (with an error message) on failure. Shared by the
  // drag handler and the card "Move to" menu.
  const persistMove = (id: string, body: UpdateTaskRequest, optimistic: (t: Task) => Task) => {
    const snapshot = tasks;
    setTasks((curr) => curr.map((t) => (t.id === id ? optimistic(t) : t)));
    setError(null);
    updateTask(id, body)
      .then((saved) =>
        setTasks((curr) =>
          curr.map((t) =>
            t.id === id
              ? { ...t, status: saved.status, sortOrder: saved.sortOrder, updatedAt: saved.updatedAt, title: saved.title }
              : t,
          ),
        ),
      )
      .catch((err: unknown) => {
        setTasks(snapshot);
        setError(err instanceof Error ? err.message : 'Could not move that task. Please try again.');
      });
  };

  const handleColumnDrop = (column: BoardColumnId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropTargetColumn(null);

    const draggedId = draggingId ?? e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    if (!draggedId) return;

    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;

    const crossColumn = columnForStatus(dragged.status) !== column;
    const destExcluding = grouped[column].filter((t) => t.id !== draggedId);
    const index = insertionIndex(e.currentTarget, e.clientY, draggedId);

    // No-op guard for an intra-column drop back into the same slot.
    if (!crossColumn && index === grouped[column].findIndex((t) => t.id === draggedId)) return;

    const newSortOrder = computeDropSortOrder(destExcluding, index);
    // Narrow drop-status (the three board-settable statuses) on a cross-column move; undefined keeps
    // the current status on an intra-column reorder.
    const newStatus = crossColumn ? statusForColumnDrop(column) : undefined;
    persistMove(
      draggedId,
      newStatus ? { status: newStatus, sortOrder: newSortOrder } : { sortOrder: newSortOrder },
      (t) => ({ ...t, status: newStatus ?? t.status, sortOrder: newSortOrder, updatedAt: crossColumn ? Date.now() : t.updatedAt }),
    );
  };

  const handleDelete = async (id: string) => {
    const snapshot = tasks;
    setTasks((curr) => curr.filter((t) => t.id !== id));
    try {
      await deleteTask(id);
    } catch (err) {
      setTasks(snapshot);
      setError(err instanceof Error ? err.message : 'Could not delete that task. Please try again.');
    }
  };

  // Column header "Delete all in …": optimistically drop every card in that column, then persist.
  const handleDeleteAll = (column: BoardColumnId) => {
    const snapshot = tasks;
    setTasks((curr) => curr.filter((t) => columnForStatus(t.status) !== column));
    setError(null);
    deleteTasksInColumn(column).catch((err: unknown) => {
      setTasks(snapshot);
      setError(err instanceof Error ? err.message : 'Could not delete those tasks. Please try again.');
    });
  };

  // The card "..." menu's "Move to" target: same as a cross-column drop, landed at the top of the
  // destination column. In Progress maps to 'queued' (reopen, no re-run).
  const moveToColumn = (id: string, target: BoardColumnId) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || columnForStatus(task.status) === target) return;

    const newStatus = statusForColumnDrop(target);
    const newSortOrder = computeDropSortOrder(grouped[target], 0); // drop at the top of the column
    persistMove(id, { status: newStatus, sortOrder: newSortOrder }, (t) => ({
      ...t,
      status: newStatus,
      sortOrder: newSortOrder,
      updatedAt: Date.now(),
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-8 py-6">
        <h1 className="text-2xl font-semibold text-foreground">Tasks</h1>
      </header>

      {error && (
        <div className="mx-8 mb-4 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-6 overflow-x-auto px-8 pb-8">
        {COLUMNS.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            tasks={grouped[column.id]}
            isDropTarget={dropTargetColumn === column.id}
            onDrop={handleColumnDrop(column.id)}
            onDragOver={handleColumnDragOver(column.id)}
            onDragLeave={handleColumnDragLeave(column.id)}
            onDeleteAll={handleDeleteAll}
            renderCard={(task) => (
              <BoardCard
                key={task.id}
                task={task}
                now={now}
                onDelete={handleDelete}
                onMove={moveToColumn}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                dragging={draggingId === task.id}
              />
            )}
          />
        ))}
      </div>
    </div>
  );
}
