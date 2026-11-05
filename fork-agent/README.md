# Fork an agent with its data

Fork an [Agent37](https://www.agent37.com/docs) agent together with its [Neon](https://neon.com/docs) database, try a task several ways at once, and keep the best result. Hono server with Neon's official SDK ([`@neon/sdk`](https://neon.com/docs/reference/typescript-sdk)), React frontend loaded from a CDN, no build step.

The interesting part is copying both halves at the same moment. Each agent is an instance with its own Neon project, and `DATABASE_URL` in its env points at the project's default branch. **Try it** makes the copies once per attempt: the instance with [fork](https://www.agent37.com/docs/agents-api/instances/fork), a copy of its disk, and the database with a [Neon branch](https://neon.com/docs/introduction/branching), a copy-on-write copy of its data. Each fork works on its own copy, you compare the results with one query, and the attempts you don't keep are deleted, instance and branch together.

## Run it

You need an Agent37 [API key](https://www.agent37.com/dashboard/cloud/api-keys) with at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing) (the first top-up lifts the free tier's one-instance limit), and a [Neon API key](https://console.neon.tech/app/settings/api-keys). Branching needs a Neon account: unclaimed [Claimable Neon](https://neon.com/docs/reference/claimable-neon) projects cannot create branches.

```bash
npm install
cp .env.example .env   # paste both keys, plus NEON_ORG_ID for a personal Neon key
npm start
```

Open [http://localhost:3000](http://localhost:3000), create an agent, click **Chat**, and give it some data with a starter prompt. Back on the list, enter a task ("Clean up the products table: merge duplicates and normalize the categories"), pick how many ways, and click **Try it**. The attempts are up and working in about 35 seconds. Compare them with a query such as `select count(*), count(distinct category) from products`, then **Keep this one** or **Discard all**.

## What it costs

Each attempt is a full instance for as long as the round lasts: about $0.16 of balance to create (nothing debited), compute metered per minute at $4.76 per month, and a $1 managed LLM top-up. A Neon branch shares its parent's storage until it diverges, and its compute scales to zero when idle. Deleting attempts ends both on the spot.

## How it works

All state lives in instance metadata: whether an instance is an `agent` or an `attempt`, the Neon project and branch it uses, and for an attempt its `parent`, number, and `session_id`. The server keeps nothing of its own. For each attempt, `POST /api/agents/:id/attempts` runs these steps, all attempts in parallel:

1. **Copy both halves at once.** `neon.branches.createAndConnect` branches the agent's database and returns the branch's pooled connection string once its compute is ready, while `POST /v1/instances/{id}/fork` copies the agent's disk: files, installed packages, and the agent's own memory. The fork gets `auto_sleep` with a one-hour idle timeout, so a round you walk away from stops billing compute. If one half fails, the other is deleted.
2. **Give the branch its own password.** A new branch keeps its parent's role passwords, so its connection string would also log in to the agent's own database. `neon.postgres.roles.resetPassword` on the branch fixes that: the attempt's credentials work only on its branch, and the agent's keep working on its own.
3. **Repoint the fork.** A fork inherits the source's `env` and ignores an `env` field in the fork body, so it boots with the agent's `DATABASE_URL`. The server sets the branch's connection string with `PATCH /v1/instances/{id}` and restarts the fork to load it.
4. **Fund it.** A fork has its own [budget](https://www.agent37.com/docs/agents-api/budgets); `POST /v1/instances/{id}/budget/top-up` grants it $1 for the attempt.
5. **Start the task.** Once the gateway answers `GET /v1/health`, the server posts the task with `stream: true`, reads only the `response.created` event, saves its `session_id`, and closes the stream. The turn keeps running on the instance, and the UI follows it with `GET /v1/sessions/{id}` until `active_response_id` is `null`.

Behaviors worth copying into your own app:

- **Compare without writing.** The query runs on every branch through Neon's HTTP driver (`@neondatabase/serverless`) inside a `READ ONLY` transaction, with each connection string from `neon.postgres.connectionString`.
- **Keep is a promotion.** It deletes the other attempts and their branches, deletes the original instance for good (the confirm dialog says so), makes the winner's branch the project's default with `neon.branches.setDefault`, and relabels the winner as the agent. The original's branch stays as the point the round started from: Neon refuses to delete a branch that has children, or a project's root branch.
- **Locked down by default.** The server listens on `127.0.0.1` (set `HOST` to change that), accepts writes only as `application/json` so other sites cannot drive it from a browser, and its chat proxy reaches only instances tagged `fork-agent` in metadata.
- **One error path.** Every Neon call is in [`neon.js`](./neon.js), on a client created with `throwOnError: true`, so a failed call throws a typed error that the server's single error handler turns into a response. The SDK also retries `423 Locked`, which several branches created off one parent at once can hit.

The frontend is React without a build step. Each page's import map loads `react`, `react-dom`, and [`htm`](https://github.com/developit/htm) from esm.sh at pinned versions, and components are written as `htm` tagged templates instead of JSX. `public/agents.js` holds the agent, attempt, and compare components; `public/use-chat.js` is the streaming chat hook.

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). For coding agents: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt).

## Limits to know

- **Fork between turns.** Fork copies the disk and a branch copies the data at the moment of each call. If the agent is mid-turn, the two copies can disagree, so start a round while the agent is idle.
- **Processes do not carry over.** A fork boots fresh with the same files. Anything the agent had running starts again only if `~/.agent37/hooks/post-restart.sh` starts it.
- **One round at a time.** The server refuses a new round while attempts exist. A round has up to 4 attempts, and your workspace's instance limit caps the total.
- **Connected channels are copied.** If the agent has a messaging channel connected, every fork holds the same bot token; keep channels off agents you fork.
- Tailwind loads from its [browser build](https://tailwindcss.com/docs/installation/play-cdn), which is meant for prototypes; compile it before you ship.
- The server uses [Hono](https://hono.dev) rather than Express: its Web-standard `Request` and `Response` keep the SSE relay to one line.
