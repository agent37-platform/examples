# Agent37 Cookbook

Runnable examples for the [Agent37 Agents API](https://www.agent37.com/docs): example apps, custom agent images, and full applications to fork. Each folder is self-contained — put your API key in `.env`, run it, and you have a working app.

## Before you start

1. Mint an API key at [agent37.com/dashboard/cloud/api-keys](https://www.agent37.com/dashboard/cloud/api-keys).
2. Add at least $10 to your wallet at [agent37.com/dashboard/cloud/billing](https://www.agent37.com/dashboard/cloud/billing). The smallest instance costs $4.94 per month, billed a day at a time, and the rest covers managed LLM usage.

## Example apps

Small, single-purpose apps that each teach one part of the API.

| Example | What it shows |
|---|---|
| [bruno](./bruno) | Click through the raw API in [Bruno](https://www.usebruno.com/), no code: create an instance, chat with it, continue the thread, delete. The fastest way to see the API end to end. |
| [hermes-chat](./hermes-chat) | A streaming chat app on a Hermes agent instance: create and manage instances, stream replies token by token, sessions, cancel. |

## Custom images

Dockerfiles that change what the agent itself is. Each folder builds into a [workspace template](https://www.agent37.com/docs/agents-api/custom-image) with one command — `npx agent37 templates build . --name <name>` — no local Docker needed.

| Image | What it shows |
|---|---|
| [hermes-vnc-desktop](./custom-images/hermes-vnc-desktop) | A live desktop view: watch the agent open Chromium, click, and fill forms in real time from any browser tab — embeddable in your own app. |

## Full apps to fork

Complete applications on the API, each in its own repo, ready to rebrand and deploy.

| Repo | What it is |
|---|---|
| [starter-kit](https://github.com/agent37-platform/starter-kit) | A white-label multi-tenant agent dashboard: sign-in, workspaces, per-user agents, native chat/files/integrations tabs. The fastest way to put Agent37 in front of your users. |
| [custom-agent-image](https://github.com/agent37-platform/custom-agent-image) | A working agent app whose agents run an image it builds itself: one Dockerfile, one skill folder, one command to publish. |
| [pi-agent-image](https://github.com/agent37-platform/pi-agent-image) | The pi coding agent on Agent37: managed LLM + Composio integrations, with no API keys in the image. |
| [hermes-byo-model](https://github.com/agent37-platform/hermes-byo-model) | Agents running on your own OpenRouter key: per-agent tokens, a money proxy, and real per-agent spend. |
| [hermes-openclaw-composio](https://github.com/agent37-platform/hermes-openclaw-composio) | Hermes and OpenClaw agents on your own Composio: your users' connected accounts (Gmail, Slack, Notion, 1,000+ apps), per-agent usage metering. |

## Building your own

The full API reference lives at [agent37.com/docs](https://www.agent37.com/docs). If you are using a coding agent (Claude Code, Codex, Cursor), point it at [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt) and it can build against the current spec directly.
