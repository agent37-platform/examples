# claude-code-byo-model

Claude Code on an [Agent37](https://www.agent37.com/docs) instance, with every model call going to **your own OpenRouter key** instead of an Anthropic login. Three commands: create, chat, delete. Plain Node, one dependency, no build step.

The [`agent37-claude-code`](https://www.agent37.com/docs/agents-api/claude-code) template normally runs on your Anthropic account. This example swaps the model backend by setting two environment variables on the instance at create time:

```json
"env": {
  "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
  "ANTHROPIC_AUTH_TOKEN": "<your OpenRouter key>"
}
```

Claude Code keeps sending its normal Anthropic-shaped requests; OpenRouter's Anthropic-compatible endpoint serves them and bills your OpenRouter account. The same two variables work for any provider that exposes an Anthropic-compatible Messages endpoint: point `ANTHROPIC_BASE_URL` at it and pass its key.

## Run it

You need an [Agent37 API key](https://www.agent37.com/dashboard/cloud/api-keys), at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing), and an [OpenRouter key](https://openrouter.ai/settings/keys) with credit.

```bash
npm install
cp .env.example .env   # paste both keys
node agent.js create
node agent.js chat <instanceId> "Which model are you? Answer in one line."
node agent.js delete <instanceId>
```

## Picking models

Claude Code chooses a model per task through four role variables. Set any of them in `.env` as OpenRouter slugs and `create` passes them through:

```bash
SONNET_MODEL=anthropic/claude-sonnet-5      # general coding
OPUS_MODEL=anthropic/claude-opus-5          # complex reasoning
HAIKU_MODEL=anthropic/claude-haiku-4.5      # quick tasks
FABLE_MODEL=anthropic/claude-fable-5        # the most demanding work
```

Unset, Claude Code asks for its own default models and OpenRouter maps the names. You can point a role at a non-Anthropic slug, but Claude Code is built for Anthropic models and others can mishandle the tool calls it edits files with.

The chat API's `model` field selects the role: `"model": "opus"` runs whatever `OPUS_MODEL` names.

## What it costs

Two separate meters. Agent37 bills compute per minute ($4.94 per month for the smallest instance) from your wallet; OpenRouter bills every model call to your OpenRouter credit. Your Agent37 managed-LLM budget is not used at all. `delete` ends the compute meter on the spot.

Full API reference: [agent37.com/docs](https://www.agent37.com/docs). For coding agents: [agent37.com/docs/llms-full.txt](https://www.agent37.com/docs/llms-full.txt).
