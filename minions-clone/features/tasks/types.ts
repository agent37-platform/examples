/**
 * Domain types for tasks — the client-safe contract shared by the React UI, the API routes,
 * and (as the source of the status/priority/mode enums) the database schema. No server-only
 * imports here, so it is safe to import from client components.
 */

// Lifecycle: 'queued' = created, not yet started on Agent37; 'running' = a turn is live;
// 'ready_for_review' = a turn finished and is awaiting the user's sign-off; 'completed' = the
// user marked it done; 'failed'/'cancelled' are the unhappy terminals.
export type TaskStatus = 'queued' | 'running' | 'ready_for_review' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';
// 'goal' wraps the first prompt as an end-to-end objective (steers the agent); 'ask' is plain.
export type TaskMode = 'goal' | 'ask';

export const TASK_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high'];
export const TASK_MODES: TaskMode[] = ['goal', 'ask'];

/** A task as returned by the API (plain JSON; timestamps are epoch ms). */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: TaskPriority;
  mode: TaskMode;
  model: string | null;
  provider: string | null;
  /** Pointers into Agent37; the thread, output, and any error are read live from these. */
  sessionId: string | null;
  responseId: string | null;
  /** True once a title has been auto-generated (or edited), so we don't regenerate. */
  titleGenerated: boolean;
  /** Manual board position within a column (higher = nearer the top). */
  sortOrder: number;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The three Kanban columns on the Tasks board. */
export type BoardColumnId = 'in_progress' | 'ready_for_review' | 'complete';

/** Which column a task's status belongs to. failed/cancelled live under In Progress (need attention). */
export function columnForStatus(status: TaskStatus): BoardColumnId {
  if (status === 'ready_for_review') return 'ready_for_review';
  if (status === 'completed') return 'complete';
  return 'in_progress'; // queued, running, failed, cancelled
}

/** The status to apply when a card is dropped INTO a column (cross-column move). */
export function statusForColumnDrop(column: BoardColumnId): 'queued' | 'ready_for_review' | 'completed' {
  if (column === 'ready_for_review') return 'ready_for_review';
  if (column === 'complete') return 'completed';
  return 'queued'; // In Progress = "reopen, no re-run"
}

/** All statuses that belong to a column (used by the header "Delete all in …" action). */
export function statusesForColumn(column: BoardColumnId): TaskStatus[] {
  if (column === 'ready_for_review') return ['ready_for_review'];
  if (column === 'complete') return ['completed'];
  return ['queued', 'running', 'failed', 'cancelled'];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  path: string;
  filename: string;
  bytes: number;
  createdAt: number;
}

/** One rendered turn in the task's chat thread. Display copy; Agent37 owns session memory. */
export interface TaskMessage {
  id: string;
  taskId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  responseId: string | null;
  createdAt: number;
}

export interface TaskWithAttachments extends Task {
  attachments: TaskAttachment[];
}

export interface TaskWithMessages extends TaskWithAttachments {
  messages: TaskMessage[];
}

/** A model option for the composer's model selector (from Agent37 GET /v1/models). */
export interface TaskModelOption {
  id: string;
  label: string;
  provider: string | null;
  isDefault: boolean;
}

/** Body for POST /api/tasks. */
export interface CreateTaskRequest {
  prompt: string;
  priority: TaskPriority;
  mode: TaskMode;
  model?: string | null;
  provider?: string | null;
  attachments?: Array<{ path: string; filename: string; bytes: number }>;
}

/** Body for PATCH /api/tasks/[id] (rename, board move / reopen, reorder). */
export interface UpdateTaskRequest {
  title?: string;
  status?: Extract<TaskStatus, 'completed' | 'ready_for_review' | 'queued'>;
  sortOrder?: number;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  ready_for_review: 'Ready for review',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const MODE_LABELS: Record<TaskMode, string> = {
  goal: 'Goal',
  ask: 'Ask',
};
