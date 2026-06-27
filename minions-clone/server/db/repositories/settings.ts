import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '../index';
import { settings } from '../schema';
import type { AppSettingsRow } from '../schema';

const SINGLETON = 'singleton';

/** Read the single settings row, creating it on first access. */
export async function getSettings(): Promise<AppSettingsRow> {
  const db = await getDb();
  const [existing] = await db.select().from(settings).where(eq(settings.id, SINGLETON)).limit(1);
  if (existing) return existing;

  const ts = Date.now();
  const row: AppSettingsRow = {
    id: SINGLETON,
    instanceId: null,
    defaultModel: null,
    defaultProvider: null,
    budgetTopupMicros: null,
    createdAt: ts,
    updatedAt: ts,
  };
  // onConflictDoNothing covers the race where a concurrent request inserted the row first;
  // we re-read so both callers converge on the same persisted singleton.
  await db.insert(settings).values(row).onConflictDoNothing();
  const [created] = await db.select().from(settings).where(eq(settings.id, SINGLETON)).limit(1);
  return created ?? row;
}

export async function updateSettings(
  patch: Partial<Omit<AppSettingsRow, 'id' | 'createdAt'>>,
): Promise<AppSettingsRow> {
  await getSettings(); // ensure the singleton row exists before patching
  const db = await getDb();
  const [next] = await db
    .update(settings)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(settings.id, SINGLETON))
    .returning();
  return next;
}
