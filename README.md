# Agent37 examples

Runnable example apps built on the [Agent37 Agents API](https://www.agent37.com/docs). Each example is a self-contained folder: put your API key in `.env`, run it, and you have a working app.

## Before you start

1. Mint an API key at [agent37.com/dashboard/cloud/api-keys](https://www.agent37.com/dashboard/cloud/api-keys).
2. Add at least $10 to your wallet at [agent37.com/dashboard/cloud/billing](https://www.agent37.com/dashboard/cloud/billing). The smallest instance bills $4.99 for its first month when you create it, and the rest covers managed LLM usage.

## Examples

| Example | What it shows |
|---|---|
| [hermes-chat](./hermes-chat) | A streaming chat app on a Hermes agent instance: create and manage instances, stream replies token by token, sessions, cancel. |

## Building your own

The full API reference lives at [agent37.com/docs](https://www.agent37.com/docs). If you are using a coding agent (Claude Code, Codex, Cursor), point it at [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt) and it can build against the current spec directly.
