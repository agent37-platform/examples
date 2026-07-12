import { CheckCircle2, Contrast, type LucideIcon } from 'lucide-react';
import type { BoardColumnId } from '@/features/tasks/types';
import { COLUMNS } from './board';

/**
 * Presentation metadata for the board columns — the status glyph, its colour, and the labels used
 * by the card "Move to" menu and the column header "Delete all" action. Kept out of the pure
 * board.ts (which stays React/lucide-free) and used as the single source by BoardColumn and
 * BoardCard so a column's icon/colour/labels live in exactly one place.
 */
export interface ColumnMeta {
  id: BoardColumnId;
  /** Title-case label, e.g. "In progress" (the card "Move to" menu uses this). */
  label: string;
  /** The column header's destructive bulk-action label, e.g. "Delete all in progress". */
  deleteAllLabel: string;
  Icon: LucideIcon;
  iconClass: string;
}

export const COLUMN_META: Record<BoardColumnId, ColumnMeta> = {
  in_progress: { id: 'in_progress', label: 'In progress', deleteAllLabel: 'Delete all in progress', Icon: Contrast, iconClass: 'text-orange-500' },
  ready_for_review: { id: 'ready_for_review', label: 'Ready for review', deleteAllLabel: 'Delete all in Ready for review', Icon: Contrast, iconClass: 'text-violet-500' },
  complete: { id: 'complete', label: 'Complete', deleteAllLabel: 'Delete all in Complete', Icon: CheckCircle2, iconClass: 'text-success' },
};

/** Column ids in board order, derived from the canonical COLUMNS registry. */
export const COLUMN_ORDER: BoardColumnId[] = COLUMNS.map((c) => c.id);
