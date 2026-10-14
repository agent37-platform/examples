import 'server-only';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema';

/**
 * Local SQLite database (libSQL), the durable home for the app's thin metadata layer. Agent37
 * remains the source of truth for execution and the chat transcript — this DB holds only what
 * Agent37 can't: board metadata and the session_id/response_id pointers (see schema.ts).
 *
 * One file, no external service: a fresh clone runs immediately and survives restarts. The file
 * path defaults to `minions.db` in the working directory; override with DATABASE_URL (e.g.
 * `file:/data/minions.db`, or a libsql:// Turso URL if you ever move to a hosted DB).
 *
 * The client + drizzle instance are stashed on globalThis so Next.js dev hot-reload (which
 * re-evaluates modules) reuses one open connection instead of leaking a new one per recompile.
 */

export type Database = LibSQLDatabase<typeof schema>;

const DB_URL = process.env.DATABASE_URL?.trim() || 'file:minions.db';

const globalForDb = globalThis as unknown as {
  __minionsClient?: Client;
  __minionsDb?: Database;
  __minionsSchemaReady?: Promise<void>;
};

function rawClient(): Client {
  return (globalForDb.__minionsClient ??= createClient({ url: DB_URL }));
}

// CREATE TABLE IF NOT EXISTS for every table — run once per process, memoized as a promise so
// concurrent first requests don't race. A single-user metadata store doesn't need migration
// tooling; the schema is small and additive, so idempotent creates are enough.
function ensureSchemaOnce(): Promise<void> {
  return (globalForDb.__minionsSchemaReady ??= (async () => {
    const client = rawClient();
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          mode TEXT NOT NULL,
          model TEXT,
          provider TEXT,
          session_id TEXT,
          response_id TEXT,
          title_generated INTEGER NOT NULL,
          sort_order REAL NOT NULL,
          user_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          path TEXT NOT NULL,
          filename TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS recurring (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          priority TEXT NOT NULL,
          mode TEXT NOT NULL,
          model TEXT,
          enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS settings (
          id TEXT PRIMARY KEY,
          instance_id TEXT,
          default_model TEXT,
          default_provider TEXT,
          budget_topup_micros INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments (task_id)`,
        `CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status)`,
      ],
      'write',
    );
  })());
}

/**
 * The Drizzle handle, with the schema's tables guaranteed to exist. Every repository awaits this
 * before issuing a query, so there's no separate migration/bootstrap step to wire up.
 */
export async function getDb(): Promise<Database> {
  await ensureSchemaOnce();
  return (globalForDb.__minionsDb ??= drizzle(rawClient(), { schema }));
}

/** Explicit schema bootstrap, kept for callers/tests that want to create the tables up front. */
export function ensureSchema(): Promise<void> {
  return ensureSchemaOnce();
}
