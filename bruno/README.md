# Agent37 Quickstart — Bruno collection

Create an agent instance and chat with it in a few clicks, no code, using
[Bruno](https://www.usebruno.com/) (a free, offline API client). The fastest way to see the
Agent37 API end to end.

## Before you start

1. Mint an API key at [agent37.com/dashboard/cloud/api-keys](https://www.agent37.com/dashboard/cloud/api-keys).
2. Fund your workspace wallet at [agent37.com/dashboard/cloud/billing](https://www.agent37.com/dashboard/cloud/billing). Creating an instance prepays compute, and the $1 budget in `01 Create Instance` covers a few chat turns; ~$10 is plenty to try this.

## Use it

1. Install Bruno, then **Open Collection** → select this `bruno/` folder.
2. Copy `environments/agent37.example.bru` to `environments/agent37.bru` (gitignored), pick the **agent37** environment (top-right), and paste your `sk_live_` key into `token`.
3. Run `quickstart` in order:
   - **01 Create Instance** — creates an `agent37-hermes` instance and saves `instanceId`.
   - **02 Wait for Ready** — click Send until it returns `200 { ok: true }`. The agent takes a moment to boot (502/503 until then; a minute or two on a cold host).
   - **03 Send Message** — your first agent turn; saves `sessionId`.
   - **04 Continue Conversation** — follows up on the same thread, to show sessions.
   - **05 Delete Instance** — tears it down. Do this when you are done.

## Two URLs, one key

The same `sk_live_` key talks to two surfaces:

- **Control plane** — `https://api.agent37.com/v1/*` manages instances (`01`, `05`).
- **Agent (data) plane** — `https://{instanceId}.agent37.app/v1/*` talks to one instance's agent (`02`, `03`, `04`).

`01 Create Instance` returns the `instanceId` that the data-plane requests slot into their URL.

## Real money

There is no sandbox — this hits production. Creating an instance prepays compute from your
wallet and chatting spends its managed budget. Keep the budget small (`01` tops up $1) and run
**05 Delete Instance** when you are done; an idle instance keeps billing.

## More

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). Want a full app instead of
click-through requests? See [`../hermes-chat`](../hermes-chat).
