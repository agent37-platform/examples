# hermes-chat

A streaming chat app on [Agent37](https://www.agent37.com/docs) Hermes instances. Express server, vanilla JS frontend, no build step. Two pages: an instances table where you create and delete agent instances, and a chat view with live token streaming, sessions, and cancel.

## Run it

You need an [API key](https://www.agent37.com/dashboard/cloud/api-keys) and at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing).

```bash
npm install
cp .env.example .env   # paste your sk_live_ key into AGENT37_API_KEY
npm start
```

Open [http://localhost:3000](http://localhost:3000), create an instance, wait for the Ready chip, click the row, chat.

## What it costs

Creating an instance debits $4.99 from your wallet for its first month and grants the instance a $1 managed LLM budget. Deleting it refunds the unused part of the month, so trying this out costs cents. The instance renews at $4.99 on its monthly anniversary while it exists.

## How it works

The browser never sees your API key. The Express server (`server.js`) holds it and proxies two upstreams:

- **Hosting API** (`api.agent37.com`): create, list, delete instances.
- **Agent API** (`https://{instanceId}.agent37.app`): chat, sessions, models. This is the gateway running inside your instance, reached with the same key.

Chat streaming is a `fetch` POST whose body is parsed as server-sent events (`public/chat.js`). `EventSource` cannot POST or send the Authorization header, so a fetch-based parser is the way to consume Agent37 streams in a browser.

Behaviors worth copying into your own app:

- **Readiness polling.** Create returns when the container runs, but the agent inside keeps booting; the instances page polls `/v1/health` until the chat surface answers.
- **Replace on terminal.** `response.completed` carries the authoritative full text. The UI replaces the accumulated deltas with it instead of appending, which also makes replayed streams safe.
- **Recover from dropped streams.** A stream that closes without a terminal event usually means the turn is still running, not that it failed. The app checks `GET /v1/responses/{id}`, and while the status is `in_progress` it reattaches with `GET /v1/responses/{id}/stream`, which replays every event so far and then resumes live — a dropped connection never loses the answer.
- **Cancel is asynchronous.** The cancel call returns immediately, the stream then terminates with `response.completed` (partial text), and the stored status settles to `cancelled`.
- **Empty replies mean budget.** If a turn completes with no text and no tool activity, the instance's managed budget or your wallet is likely exhausted; the UI says so instead of showing a blank bubble.

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). For coding agents: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt).

## Limits to know

Chat input is text only in the current gateway. A fresh managed instance exposes a single default model, so the model picker appears only when there is a real choice. WebSockets are not supported through instance URLs; everything is HTTP and SSE.
