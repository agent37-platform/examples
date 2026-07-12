import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../index';
import { attachments, tasks } from '../schema';
import type { FileItem } from '@/features/files/types';

/** Every uploaded attachment, joined to the task it belongs to, newest first. */
export async function listAllFiles(): Promise<FileItem[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: attachments.id,
      path: attachments.path,
      filename: attachments.filename,
      bytes: attachments.bytes,
      createdAt: attachments.createdAt,
      taskId: attachments.taskId,
      taskTitle: tasks.title,
    })
    .from(attachments)
    .leftJoin(tasks, eq(attachments.taskId, tasks.id))
    .orderBy(desc(attachments.createdAt));
  // leftJoin makes taskTitle string | null already (null when the task is gone); normalize undefined.
  return rows.map((r) => ({ ...r, taskTitle: r.taskTitle ?? null }));
}
