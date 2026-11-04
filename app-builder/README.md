# App builder with a database

An app builder on [Agent37](https://www.agent37.com/docs) and [Neon](https://neon.com/docs): your user asks an agent for an app ("Build me a guestbook and give me the link"), the agent builds it on its own always-on computer with its own Postgres database, and your server publishes it at a permanent public URL. Hono server, React frontend loaded from a CDN, no build step.

The interesting part is the database. The agent creates one per app with [Claimable Neon](https://neon.com/docs/reference/claimable-neon) (`npx neon claim create`), so there is no Neon account, token, or provisioning code in this app. The database is free for 72 hours, and the user claims it into their own Neon account to keep the app. Everything else is the [site-builder](../site-builder) pattern.

## Run it

You need an [API key](https://www.agent37.com/dashboard/cloud/api-keys) and at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing). No Neon account is needed to try it; you need one only to claim a database.

The agent runs in the cloud and must be able to reach this server to publish, so `PUBLIC_APP_URL` cannot be localhost. Deploy the app, or for local dev open a quick tunnel:

```bash
# terminal 1: a public URL for this server (prints https://<something>.trycloudflare.com)
cloudflared tunnel --url http://localhost:3000

# terminal 2
npm install
cp .env.example .env   # paste your sk_live_ key and the tunnel URL
npm start
```

If the tunnel never connects, your network probably blocks QUIC: add `--protocol http2`. A quick tunnel gets a new URL each run. Put the new one in `.env` and restart the server: it rewrites `~/.app-builder/publish-url` on each instance before that instance's next turn, and the agent reads the address from there, so every chat, old or new, publishes to the current URL.

Open [http://localhost:3000](http://localhost:3000), create an agent, wait for the Ready chip, click the row, and use a starter prompt. The agent replies with a live `https://....agent37.app` link, and the **Apps** panel shows each app with its database, the time it has left, and a **Claim database** button.

## What it costs

Creating an instance requires about $0.16 of wallet balance (one day of compute) but debits nothing, and grants the instance a $2 managed LLM budget. Compute is metered per minute at $4.76 per month while the instance runs, and deleting it ends billing on the spot. The databases are free until claimed; once claimed they are on the user's own Neon plan.

## How it works

One `sk_live_` key, held by the server only, drives the Agent37 side. Chat is proxied like [hermes-chat](../hermes-chat) and publishing works like [site-builder](../site-builder). What this example adds:

1. **Every app gets a folder, a port, and a database.** The first turn of each session carries a brief: build in `~/apps/<slug>`, pick a port from 8800 to 8899, and run `neon claim create --project-name <slug> --file .env` through `npx`, on the CLI version pinned in `instance-scripts.js`. That command writes `DATABASE_URL` into the app's `.env`, plus a `.neon` file that names the Neon project.
2. **One `start.sh` per app.** The agent writes a fixed `start.sh` and adds it to `~/.agent37/hooks/post-restart.sh`, so the app comes back on every boot. It loads `.env` with `set -a; . ./.env`, because `node --env-file` never overrides a variable already set in the environment.
3. **Publishing labels the port with the app.** The agent calls `POST /api/publish` at the address in `~/.app-builder/publish-url`, with its token, `instance_id`, `app`, and `port`. The address lives in a file, not the brief, because the brief only reaches a session's first turn. The server checks the token against the instance metadata, refuses ports outside 8800 to 8899, and creates the public port with `label: "app:<slug>"`, which is how the Apps panel matches a URL to an app folder.
4. **The Apps panel reads the instance's disk.** `GET /api/instances/:id/apps` runs a small script on the instance through [exec](https://www.agent37.com/docs/agents-api/exec) that asks `neon claim status` about each app's project. Nothing is stored on the server; the scripts are in [`instance-scripts.js`](./instance-scripts.js).
5. **Claiming is a link.** **Claim database** runs `neon claim accept <project-id> --no-open -o json` on the instance and opens the `verification_url` it returns, which is valid for 15 minutes. The user signs in to Neon and the project moves into their account, data included.
6. **Reconnect after the claim.** Claiming revokes the temporary password, so the old `DATABASE_URL` stops working. The user's Neon account issues a new connection string for the same database; pasting it into the panel writes it to the app's `.env` and reruns `start.sh`. Because `start.sh` loads `.env` with `sh`, the server accepts only a plain postgres URL (no quotes, `$`, backticks, backslashes, or whitespace), and the script writes it single-quoted.

Claim states move `unclaimed` → `pending` → `accepted` → `reconciled`. A claim code nobody used reads `expired` after 15 minutes; the panel shows that project as unclaimed again, because the database itself lives until `project_expires_at`. Once a claim reconciles, the Neon CLI deletes its local credential and `neon claim status` stops answering, so the list script keeps the last state it saw in `~/apps/<slug>/.neon-claim.json`. If Neon cannot be reached, the panel shows that saved state marked "last known" rather than guessing.

The server is locked down by default. It listens on `127.0.0.1` (set `HOST` to change that), accepts writes only as `application/json` so other sites cannot drive it from a browser, and acts only on instances whose `metadata.app` is `app-builder`, so it never lists, chats with, or deletes another app's instances in the same workspace. Only `/api/publish` needs to be reachable from the internet.

The frontend is React without a build step. Each page's import map loads `react`, `react-dom`, and [`htm`](https://github.com/developit/htm) from esm.sh at pinned versions, and components are written as `htm` tagged templates instead of JSX. The files worth reading:

- `public/use-chat.js`: the `useChat()` hook that streams a turn, reattaches when the stream drops, and cancels.
- `public/apps-panel.js`: each app's URL, database state, **Claim database** button, and reconnect form.
- `public/chat-ui.js`: the sessions sidebar, message list, and composer.

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). For coding agents: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt).

## Limits to know

- **Unclaimed databases are temporary.** Neon deletes an unclaimed project 72 hours after creation and caps it at 100 MB of storage and 1 GB of transfer; see [Claimable Neon](https://neon.com/docs/reference/claimable-neon).
- **A claim link is a password.** Whoever opens it first and signs in gets the database. Show it only to the app's owner and keep it out of logs.
- **The claim credential lives on the instance.** The Neon CLI keeps it under `~/.config/neon`. Deleting the instance loses the ability to claim its unclaimed databases, and a [fork](https://www.agent37.com/docs/agents-api/instances/fork) copies it, so both instances can claim the same project.
- **Public means public.** Anyone with an app's URL can open it, and a request to it wakes a sleeping instance, which bills compute.
- Ports 8800 to 8899 are this example's policy, enforced in `/api/publish`; one public URL per port, at most 50 per instance.
- Tailwind loads from its [browser build](https://tailwindcss.com/docs/installation/play-cdn), which is meant for prototypes; compile it before you ship.
- The server uses [Hono](https://hono.dev) rather than Express: its Web-standard `Request` and `Response` relay the SSE stream with `new Response(upstream.body)`.
