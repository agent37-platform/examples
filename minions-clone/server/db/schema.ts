// The status/priority/mode enums are domain concepts; these tables are just their persistence.
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type { TaskMode, TaskPriority, TaskStatus } from '@/features/tasks/types';

/**
 * Drizzle schema for the local SQLite database (libSQL, file `minions.db` — see server/db/index.ts).
 * The DB is the durable home for the thin metadata layer; Agent37 still owns execution and the
 * chat transcript (read live). What lives here is only what Agent37 can't: board metadata (title,
 * status, priority, sort order) and the lifecycle pointers (session_id / response_id) that join a
 * task to its Agent37 session.
 *
 * The table definitions are the single source of truth for the row types — the `*Row` types below
 * are inferred from them via `$inferSelect`, so the SQL and the TypeScript can never drift. The
 * enum columns are stored as plain text and re-typed with `$type<>()` to the domain unions.
 */

export type { TaskMode, TaskPriority, TaskStatus };

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  priority: text('priority').$type<TaskPriority>().notNull(),
  mode: text('mode').$type<TaskMode>().notNull(),
  model: text('model'),
  provider: text('provider'),
  // Pointers into Agent37 (null until the first turn starts).
  sessionId: text('session_id'),
  responseId: text('response_id'),
  titleGenerated: integer('title_generated', { mode: 'boolean' }).notNull(),
  // Manual Kanban position within a column (higher = nearer the top). Fractional, so REAL.
  sortOrder: real('sort_order').notNull(),
  // Reserved for multi-user later; unused in v1 (single-tenant, one shared instance).
  userId: text('user_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  // Path on the Agent37 instance (e.g. /home/node/uploads/3f2a-leads.csv).
  path: text('path').notNull(),
  filename: text('filename').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const recurring = sqliteTable('recurring', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  schedule: text('schedule').notNull(),
  priority: text('priority').$type<TaskPriority>().notNull(),
  mode: text('mode').$type<TaskMode>().notNull(),
  model: text('model'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Single-row app config (instance pointer + default model), keyed by a fixed 'singleton' id.
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id'),
  defaultModel: text('default_model'),
  defaultProvider: text('default_provider'),
  budgetTopupMicros: integer('budget_topup_micros'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Row types inferred from the tables — the unchanged contract the repositories and services use.
export type TaskRow = typeof tasks.$inferSelect;
export type TaskAttachmentRow = typeof attachments.$inferSelect;
export type RecurringTaskRow = typeof recurring.$inferSelect;
export type AppSettingsRow = typeof settings.$inferSelect;

/** The fields accepted when inserting a task; everything optional has a default applied. */
export interface NewTaskRow {
  id?: string;
  title: string;
  prompt: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  mode?: TaskMode;
  model?: string | null;
  provider?: string | null;
  sessionId?: string | null;
  responseId?: string | null;
  titleGenerated?: boolean;
  sortOrder?: number;
  userId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}
