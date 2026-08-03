# AGENTS.md

Guidance for AI coding agents working in this repo.

## The API reference is hosted, not vendored

The authoritative Agent37 Agents API reference is `https://www.agent37.com/docs/llms-full.txt`. Fetch it before writing or changing any code that calls the API. Never copy API documentation into this repo; it goes stale. This repo carries only what is unique to each example: run instructions and app code.

## Repo shape

One folder per example, each fully self-contained (own `package.json`, own `README.md`, own `.env.example`). No shared code between examples; an example must be copy-paste-able as a starting point without dragging siblings along.

`custom-images/` holds image recipes instead of apps: one folder per image (`Dockerfile`, any files it COPYs, own `README.md`, no `package.json`), each buildable as-is with `npx agent37 templates build . --name <name>`. Before merging a recipe, run that build and create a real instance from it; a recipe that has not booted is not an example. Every example lands in the matching table in the root `README.md`.

## Conventions

- Keep dependencies minimal. `hermes-chat` uses only `express` and `dotenv`; hold new examples to the same bar.
- The `sk_live_` API key is a server-side secret. Every example that has a browser UI must route API calls through its own server; the key never reaches the client.
- Plain JavaScript, no build step, unless an example's whole point is a specific framework.
