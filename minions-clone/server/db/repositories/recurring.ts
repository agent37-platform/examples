import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../index';
import { recurring } from '../schema';
import type { RecurringTaskRow } from '../schema';

/**
 * Recurring tasks are a v1 stub: rows persist (in SQLite) and the UI manages them, but nothing
 * executes them on a schedule yet. The shape is here so adding a cron runner later is purely
 * additive.
 */

export async function listRecurring(): Promise<RecurringTaskRow[]> {
  const db = await getDb();
  return db.select().from(recurring).orderBy(desc(recurring.createdAt));
}

export async function createRecurring(
  data: Omit<RecurringTaskRow, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> & { enabled?: boolean },
): Promise<RecurringTaskRow> {
  const ts = Date.now();
  const { enabled, ...rest } = data;
  const row: RecurringTaskRow = {
    id: crypto.randomUUID(),
    enabled: enabled ?? true,
    createdAt: ts,
    updatedAt: ts,
    ...rest,
  };
  const db = await getDb();
  await db.insert(recurring).values(row);
  return row;
}

export async function updateRecurring(
  id: string,
  patch: Partial<Omit<RecurringTaskRow, 'id' | 'createdAt'>>,
): Promise<RecurringTaskRow | null> {
  const db = await getDb();
  const [row] = await db
    .update(recurring)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(recurring.id, id))
    .returning();
  return row ?? null;
}

export async function deleteRecurring(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(recurring).where(eq(recurring.id, id));
}
