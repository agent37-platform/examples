# site-builder

A website-builder app on [Agent37](https://www.agent37.com/docs): your user chats with an agent ("Create a simple Hello World page and give me a link"), the agent builds the site on its own always-on computer, and your server publishes it at a permanent public URL. Express server, vanilla JS frontend, no build step.

The interesting part is the publish flow. Agents on Agent37 deliberately cannot mint [public ports](https://www.agent37.com/docs/agents-api/public-ports) themselves; the workspace owner's `sk_live_` call is the consent boundary. So the agent asks *your app* to publish, your app decides, and your app calls the Hosting API. This example is the smallest complete version of that pattern.

## Run it

You need an [API key](https://www.agent37.com/dashboard/cloud/api-keys) and at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing).

The agent runs in the cloud and must be able to reach this server to publish, so `PUBLIC_APP_URL` cannot be localhost. Deploy the app, or for local dev open a quick tunnel:

```bash
# terminal 1: a public URL for this server (prints https://<something>.trycloudflare.com)
cloudflared tunnel --url http://localhost:3000

# terminal 2
npm install
cp .env.example .env   # paste your sk_live_ key and the tunnel URL
npm start
```

Open [http://localhost:3000](http://localhost:3000), create an agent, wait for the Ready chip, click the row, and use one of the starter prompts. The agent replies with a live `https://....agent37.app` link, and the site link also appears in the header and on the agents table.

A quick tunnel gets a new URL each run. That is fine here: the URL is read from `.env` per session, not stored anywhere, so restart the server with the new URL and new chats pick it up.

## What it costs

Creating an instance requires about $0.16 of wallet balance (one day of compute) but debits nothing, and grants the instance a $1 managed LLM budget. Compute is metered per minute at $4.94 per month while the instance runs, and deleting it ends billing on the spot, so trying this out costs cents.

## How it works

One `sk_live_` key, held by the server only, drives everything. Chat is proxied exactly like the [hermes-chat](../hermes-chat) example; what site-builder adds is a chain of three pieces:

1. **Create plants a token.** `POST /v1/instances` is called with a random publish token in `env.SITE_PUBLISH_TOKEN` (the agent's shell sees it) and the token's SHA-256 in `metadata`. `env` is write-only on the API and `metadata` is readable, so this pair is what later lets the server check "does this token belong to this instance" without keeping any state.
2. **The first turn briefs the agent.** The gateway has no system-prompt field, so the server prepends an "app context" preamble to the first message of every session: build in `~/site`, serve on port 8788, keep it alive, and publish by calling `POST {PUBLIC_APP_URL}/api/publish` with `Authorization: Bearer $SITE_PUBLISH_TOKEN` and its `$AGENT37_INSTANCE_ID` (which the platform sets in every container). The UI strips the preamble when rendering history.
3. **`/api/publish` is the consent gate.** It hashes the presented token, compares it to the instance's stored metadata hash, and only then calls `POST /v1/instances/{id}/public-ports`. A `409` (port already public) returns the existing URL, so republishing is idempotent. In a real app this endpoint is where your policy goes: quotas, port allowlists, an approval step, your own user auth.

Behaviors worth copying into your own app:

- **The site survives restarts.** The brief has the agent append its start command to `~/.agent37/hooks/post-restart.sh`, which the platform runs on every boot of the instance (restart, image update, recovery). Files live under `~` on the persistent disk, so the published URL keeps serving across the instance's whole lifecycle.
- **Edits need no republish.** The public URL routes to the port, and the server on that port reads files from disk, so "make the background dark" is just the agent editing `~/site` in a later turn.
- **Readiness polling, stream reattach, cancel, empty-reply-means-budget**: all inherited from hermes-chat; see its README for the details.

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). For coding agents: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt).

## Limits to know

- **Public means public.** Anyone with the URL can open the site, and a request to it wakes a sleeping instance, which bills compute. Don't publish anything sensitive, and delete the public port (or the instance) when a site should go away.
- Hostnames are platform-minted: a random 20-character slug, or `{prefix}-{instanceId}.agent37.app` if you pass a `prefix`. To serve the same URLs under your own domain, register a [custom domain](https://www.agent37.com/docs/agents-api/domains); arbitrary hostnames like `app.yourdomain.com` are not a thing.
- One public URL per port, at most 20 per instance, and platform ports (`3737`, `8080`, `7681`, ...) are rejected; this example uses `8788`.
- The path `/health` never reaches the site; the platform edge answers it.
