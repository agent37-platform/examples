# minions-clone

An AI task-management app on the [Agent37](https://www.agent37.com/docs) Agents API. You write a task in plain language under **"What do you need done?"**, pick a model, priority, and mode, and hit go; Agent37 runs an agent that plans, uses tools, and works the task end-to-end while the detail page streams its reasoning, tool calls, and output live. The detail page is a **multi-turn chat thread**: the first prompt and the agent's reply open the conversation, and you send follow-ups in the **same Agent37 session**, so the agent keeps the context of the whole exchange. A task moves through **queued → running → ready_for_review → completed** — when a turn finishes it lands in _Ready for review_, and you click **Mark complete** to close it out. The **Tasks** page is a **3-column Kanban board** — _In Progress_ / _Ready for review_ / _Complete_ — that groups tasks by status, and you **drag cards** between and within columns to move them along; clicking a card opens its chat history. Titles are **auto-generated** from the first exchange and stay editable inline. A left sidebar holds New Task, Tasks, Recurring, Files, and Settings. Files you attach ride along to the agent and show up under Files, joined back to the task that used them. Clean, near-monochrome UI (think Vercel/Geist): white canvas, hairline borders, generous whitespace.

## Architecture

- **Next.js 15 (App Router) + TypeScript**, no extra UI framework. Pages that read data are Server Components; only interactive pieces are `'use client'`.
- **SQLite via libSQL + Drizzle** is a thin metadata/lifecycle layer. The DB owns only what Agent37 can't: task board metadata (title, status, priority, sort order) and the `session_id` / `response_id` pointers that join a task to its Agent37 session. **Agent37 owns the real session memory and the chat transcript** — the thread is read **live** from the session, not cached here.
- **Agent37 owns execution.** The whole app shares **one instance**, with **one session per task**. The first task provisions that instance once and remembers its id in the DB (or you pin it via env).
- **Clean layering:** controllers (`app/api/*` route handlers) → services (`server/services/*`) → gateway (`server/agent37/*`) + repositories (`server/db/*`). The browser talks only to our own `/api` routes through `lib/fetcher` (or raw `fetch` for streaming and uploads).
- **The `sk_live_` key lives only on the server.** `server/config.ts` and every `server/*` module import `server-only`, so the key can never be bundled into client code.

## Folder structure

```
app/            App Router: pages (Server Components) + /api route handlers (controllers)
features/       Per-feature client-safe domain types (tasks, files, settings) + UI hooks
components/     ui/ (Button, Input, Select, Badge, EmptyState…) and layout/ (Sidebar, AppShell, PageHeader)
server/         Server-only. config, http error mapping, agent37/ gateway, db/ (schema, repositories), services/
lib/            fetcher (typed client for our /api) and util (cn, timeAgo, titleFromPrompt)
```

## Quickstart

You need an [Agent37 API key](https://www.agent37.com/dashboard/cloud/api-keys) and a funded [wallet](https://www.agent37.com/dashboard/cloud/billing) — the smallest instance is about **$4.94/mo**, billed a day at a time, so trying this costs cents.

```bash
cp .env.example .env   # paste your sk_live_ key into AGENT37_API_KEY
npm install
npm run dev            # http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) (it redirects to **/tasks/new**), describe a task, and run it.

- **First run provisions one shared instance.** Unless `AGENT37_INSTANCE_ID` is set, the first task creates one container and remembers its id in the DB. A cold instance can take a minute to warm up; the stream returns `instance_warming` and the UI retries until the agent answers. Provisioning grants the instance a managed-LLM budget (`AGENT37_BUDGET_TOPUP_MICROS`, default $1) — without it replies come back empty.
- **The database self-creates.** `server/db/index.ts` runs `CREATE TABLE IF NOT EXISTS` for every table on first access (memoized per process), so a fresh clone runs with no migration step or tooling. The local file is `minions.db`, overridable via `DATABASE_URL` (e.g. a `libsql://` Turso URL to move to a hosted DB). Drizzle is used as the typed query builder + schema-as-code; the table definitions in `server/db/schema.ts` are the single source of truth for the row types.

## Tasks board

The Tasks page renders a **3-column Kanban board** grouped by status via `columnForStatus`:

- **In Progress** holds `queued` and `running`, plus the unhappy terminals `failed` / `cancelled` (those carry a small badge so they read as needing attention).
- **Ready for review** holds `ready_for_review`.
- **Complete** holds `completed`.

Cards are **drag-and-drop** with **native HTML5** DnD (no libraries). Dropping a card into a **different** column is a status change — it `PATCH`es `{ status, sortOrder }`, where the destination maps via `statusForColumnDrop` (and _In Progress_ → `queued`, which **reopens** the task without re-running the agent). Reordering **within** a column persists position only — `PATCH { sortOrder }`. Position is the new `tasks.sort_order` column (descending: higher sits nearer the top), and moves are computed as a fractional value between the neighbouring cards. The board is **optimistic** — it moves the card locally first, then reverts and surfaces an inline error if the `PATCH` fails. Clicking a card opens the task's chat history.

## API surface

All routes return data as JSON directly (lists as arrays); errors are `{ error: { code, message, hint? } }` via `jsonError`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks (newest first). |
| `POST` | `/api/tasks` | Create a task from `{ prompt, priority, mode, model?, provider?, attachments? }`. |
| `GET` | `/api/tasks/[id]` | Get one task with its attachments and chat messages. |
| `PATCH` | `/api/tasks/[id]` | Update a task from `{ title?, status?, sortOrder? }` — rename it, move it on the board (`status` is `completed` / `ready_for_review` / `queued`, where `queued` **reopens** to _In Progress_ without re-running the agent), and/or reposition it (`sortOrder`); returns the updated task. |
| `DELETE` | `/api/tasks/[id]` | Delete a task. |
| `POST` | `/api/tasks/[id]/stream` | SSE stream of the turn: starts a queued task, or **reattaches** to a running one (replays every event so far, then stays live); persists status/output from the same stream. |
| `POST` | `/api/tasks/[id]/messages` | Send a follow-up turn from `{ input }` in the **same session**; returns the SSE stream of that turn (teed server-side to persist the assistant message and new status). |
| `POST` | `/api/tasks/[id]/title` | Auto-generate the task's title from its first exchange; idempotent (returns the existing title once generated or edited). Called once after the first turn completes. |
| `POST` | `/api/tasks/[id]/cancel` | Cancel a running turn (keeps the partial output). |
| `GET` | `/api/models` | Model options for the composer, from the instance's `GET /v1/models` (falls back to "Default" when no instance exists yet). |
| `GET` | `/api/files` | List uploaded files, joined to their task. |
| `POST` | `/api/files` | Multipart upload, forwarded to the instance; returns `{ path, filename, bytes }`. |
| `GET` | `/api/files/content?path=…` | Stream a file's bytes back from the instance. |
| `GET` | `/api/settings` | App settings (instance id, template, defaults, budget). |
| `PATCH` | `/api/settings` | Update default model/provider. |
| `POST` | `/api/settings/provision` | Provision the shared instance on demand. |

Routes and pages that touch the DB / Agent37 at request time set `export const dynamic = 'force-dynamic'` (route handlers also `runtime = 'nodejs'`), so `next build` never executes them without a key.

## Maps to Agent37 vs. v1 stubs

- **Real:** task execution, live streaming, cancel, models, and files all map to the Agent37 Agent API on your instance (`/v1/responses`, `/v1/responses/{id}/stream`, `/v1/models`, `/v1/files`). Instance lifecycle uses the Hosting API (`/v1/instances`).
- **Stubs:** **Recurring** persists rows and lets the UI manage them, but nothing runs them on a schedule yet — the shape is here so a cron runner is purely additive. **Skills** is a placeholder under ADVANCED. The **Dictate** control cluster is decorative and inert.

## On the API reference

The authoritative Agent37 Agents API reference is **hosted, not vendored**: [agent37.com/docs](https://www.agent37.com/docs), and for coding agents [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt). This repo carries only what's unique to the example.
