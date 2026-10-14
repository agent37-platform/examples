/**
 * Pure column model + ordering helpers for the Tasks Kanban board. No React here — this file is
 * unit-testable on its own. The board has three fixed columns; a task's column is derived from
 * its status via `columnForStatus`, and within a column cards are ordered by `sortOrder` DESC
 * (higher = nearer the top), tie-broken by most-recently-updated.
 */
import { columnForStatus, type BoardColumnId, type Task } from '@/features/tasks/types';

export interface BoardColumnDef {
  id: BoardColumnId;
  label: string;
}

/** The three columns, left-to-right, with their UPPERCASE header labels. */
export const COLUMNS: BoardColumnDef[] = [
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'ready_for_review', label: 'READY FOR REVIEW' },
  { id: 'complete', label: 'COMPLETE' },
];

/** The gap we leave above/below the extremes so future drops always have room to land. */
const SORT_STEP = 1000;

/** Display order within a column: sortOrder DESC, then updatedAt DESC. */
function byDisplayOrder(a: Task, b: Task): number {
  if (b.sortOrder !== a.sortOrder) return b.sortOrder - a.sortOrder;
  return b.updatedAt - a.updatedAt;
}

/** Bucket tasks into their columns, each list sorted into display order. */
export function groupByColumn(tasks: Task[]): Record<BoardColumnId, Task[]> {
  const groups: Record<BoardColumnId, Task[]> = {
    in_progress: [],
    ready_for_review: [],
    complete: [],
  };
  for (const task of tasks) {
    groups[columnForStatus(task.status)].push(task);
  }
  (Object.keys(groups) as BoardColumnId[]).forEach((id) => groups[id].sort(byDisplayOrder));
  return groups;
}

/**
 * Fractional, DESCending sortOrder for a drop.
 *
 * `columnCards` is the destination column in display order (top→bottom, sortOrder DESC) with the
 * dragged card removed; `index` is the insertion slot, 0..columnCards.length.
 *
 *   - top    (no card above): topCard.sortOrder + 1000   (Date.now() if the column is empty)
 *   - bottom (no card below): bottomCard.sortOrder - 1000
 *   - middle (between U/L):    (U.sortOrder + L.sortOrder) / 2
 */
export function computeDropSortOrder(columnCards: Task[], index: number): number {
  const clamped = Math.max(0, Math.min(index, columnCards.length));
  const above = clamped > 0 ? columnCards[clamped - 1] : undefined; // the card now above the slot (higher order)
  const below = clamped < columnCards.length ? columnCards[clamped] : undefined; // the card now below (lower order)

  if (!above && !below) return Date.now(); // empty column
  if (!above) return below!.sortOrder + SORT_STEP; // dropped at the top
  if (!below) return above.sortOrder - SORT_STEP; // dropped at the bottom
  return (above.sortOrder + below.sortOrder) / 2; // dropped between two cards
}
