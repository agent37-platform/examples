# AGENTS.md

Guidance for AI coding agents working in this repo.

## The API reference is hosted, not vendored

The authoritative Agent37 Agents API reference is `https://www.agent37.com/docs/llms-full.txt`. Fetch it before writing or changing any code that calls the API. Never copy API documentation into this repo; it goes stale. This repo carries only what is unique to each example: run instructions and app code.

## Repo shape

One folder per example, each fully self-contained (own `package.json`, own `README.md`, own `.env.example`). No shared code between examples; an example must be copy-paste-able as a starting point without dragging siblings along.

## Conventions

- Keep dependencies minimal. `hermes-chat` uses only `express` and `dotenv`; hold new examples to the same bar.
- The `sk_live_` API key is a server-side secret. Every example that has a browser UI must route API calls through its own server; the key never reaches the client.
- Plain JavaScript, no build step, unless an example's whole point is a specific framework.

## Examples run against production

There is no staging: running an example exercises the live API with real money (creating an instance debits the wallet's first month; chat burns managed-usage budget). Keep per-instance budgets small (`hermes-chat` tops up $1), delete instances when you're done testing, and treat a wallet or budget `402` as an expected state the example should surface clearly — not an error to retry.
