import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../index';
import { attachments, tasks } from '../schema';
import type { NewTaskRow, TaskAttachmentRow, TaskRow } from '../schema';
import type { TaskStatus } from '@/features/tasks/types';

function id(): string {
  return crypto.randomUUID();
}
function now(): number {
  return Date.now();
}

export async function insertTask(
  data: Omit<NewTaskRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<TaskRow> {
  const ts = now();
  // sortOrder defaults to creation time so brand-new tasks sort to the top of their column.
  const row: TaskRow = {
    id: data.id ?? id(),
    title: data.title,
    prompt: data.prompt,
    status: data.status ?? 'queued',
    priority: data.priority ?? 'medium',
    mode: data.mode ?? 'goal',
    model: data.model ?? null,
    provider: data.provider ?? null,
    sessionId: data.sessionId ?? null,
    responseId: data.responseId ?? null,
    titleGenerated: data.titleGenerated ?? false,
    sortOrder: data.sortOrder ?? ts,
    userId: data.userId ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
  const db = await getDb();
  await db.insert(tasks).values(row);
  return row;
}

export async function getTaskById(taskId: string): Promise<TaskRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

export async function listTasks(): Promise<TaskRow[]> {
  // Board order: manual sortOrder first (higher = top), createdAt as a stable tiebreak.
  const db = await getDb();
  return db.select().from(tasks).orderBy(desc(tasks.sortOrder), desc(tasks.createdAt));
}

export async function updateTask(
  taskId: string,
  patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>,
): Promise<TaskRow | null> {
  const db = await getDb();
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: now() })
    .where(eq(tasks.id, taskId))
    .returning();
  return row ?? null;
}

/**
 * Atomically move a task from 'queued' to 'running'. Returns true only for the caller that won
 * the transition, so a double-submit can't kick off two Agent37 turns for the same task. The
 * status guard rides in the WHERE clause, so SQLite settles the race in a single statement.
 */
export async function claimQueuedTask(taskId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(tasks)
    .set({ status: 'running', updatedAt: now() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'queued')))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export async function deleteTask(taskId: string): Promise<void> {
  const db = await getDb();
  // Cascade attachments first (no FK constraint declared, so do it explicitly).
  await db.delete(attachments).where(eq(attachments.taskId, taskId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
}

/** Bulk-delete every task whose status is in `statuses`, cascading attachments. */
export async function deleteTasksByStatuses(statuses: TaskStatus[]): Promise<number> {
  if (statuses.length === 0) return 0;
  const db = await getDb();
  const ids = (
    await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.status, statuses))
  ).map((r) => r.id);
  for (const taskId of ids) await deleteTask(taskId);
  return ids.length;
}

export async function addAttachment(
  taskId: string,
  data: { path: string; filename: string; bytes: number },
): Promise<TaskAttachmentRow> {
  const row: TaskAttachmentRow = { id: id(), taskId, createdAt: now(), ...data };
  const db = await getDb();
  await db.insert(attachments).values(row);
  return row;
}

export async function listAttachments(taskId: string): Promise<TaskAttachmentRow[]> {
  const db = await getDb();
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(desc(attachments.createdAt));
}
