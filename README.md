# Agent37 examples

Runnable example apps built on the [Agent37 Agents API](https://www.agent37.com/docs). Each example is a self-contained folder: put your API key in `.env`, run it, and you have a working app.

## Before you start

1. Mint an API key at [agent37.com/dashboard/cloud/api-keys](https://www.agent37.com/dashboard/cloud/api-keys).
2. Add at least $10 to your wallet at [agent37.com/dashboard/cloud/billing](https://www.agent37.com/dashboard/cloud/billing). The smallest instance costs $4.94 per month, billed a day at a time, and the rest covers managed LLM usage.

## Examples

| Example | What it shows |
|---|---|
| [bruno](./bruno) | Click through the raw API in [Bruno](https://www.usebruno.com/), no code: create an instance, chat with it, continue the thread, delete. The fastest way to see the API end to end. |
| [hermes-chat](./hermes-chat) | A streaming chat app on a Hermes agent instance: create and manage instances, stream replies token by token, sessions, cancel. |

## Building a full app?

These examples are small, single-purpose teaching apps. If you want a complete application to fork and rebrand — a multi-tenant dashboard with sign-in, workspaces, and per-user agents — start from the [Agent37 white-label template](https://github.com/agent37-platform/whitelabel) and click **Use this template**.

## Building your own

The full API reference lives at [agent37.com/docs](https://www.agent37.com/docs). If you are using a coding agent (Claude Code, Codex, Cursor), point it at [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt) and it can build against the current spec directly.
