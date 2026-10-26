# claude-managed-agents

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) with every session on its own Agent37 instance. Anthropic runs the agent loop and the model; the instance runs the agent's commands and keeps its files. Between turns the instance sleeps and bills disk alone, and the session's next message wakes it with everything where the agent left it.

What it shows:

- **A dev environment that stays put.** Clone and install once. The next turn, an hour or a week later, finds the repo, its `node_modules`, and the agent's own notes right where they were.
- **Sleep between turns.** A session's instance is awake while the agent works and goes to sleep five minutes after, so an agent you talk to once a day costs cents a month.
- **Parallel sessions.** Every session gets its own computer, so ten sessions run at once with nothing shared.

## Run it

You need:

- An Agent37 [API key](https://www.agent37.com/dashboard/cloud/api-keys) and at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing).
- A Claude [API key](https://platform.claude.com/settings/keys).
- A self-hosted environment and its environment key: in the [Claude Console](https://platform.claude.com/workspaces/default/environments), **New** > **Self-hosted**, then open it and click **Generate environment key**.
- Node.js 22 or later.

```bash
npm install
cp .env.example .env    # fill in the four keys
node create-agent.mjs   # prints AGENT_ID, add it to .env
node orchestrator.mjs   # leave this running
```

In a second terminal, start a session:

```bash
node chat.mjs "Clone https://github.com/sindresorhus/slugify into /workspace, install its dependencies, and run its tests."
```

```text
> bash {"command":"cat /workspace/NOTES.md 2>/dev/null; ls /workspace"}
> bash {"command":"cd /workspace && git clone https://github.com/sindresorhus/slugify && cd slugify && npm install ..."}
> bash {"command":"cd /workspace/slugify && npm test 2>&1 | tail -20"}
All 25 tests passed. I cloned the repo to /workspace/slugify and wrote a short summary to /workspace/NOTES.md.

session: sesn_01QMmjPiPAv3FCx27dU8xoGq
```

Come back after ten minutes, when the instance is asleep, and continue the same session:

```bash
node chat.mjs sesn_01QMmjPiPAv3FCx27dU8xoGq "Add a test for an input with emoji and run the suite again."
```

The orchestrator wakes the instance, the agent reads its notes, and it goes straight to the code: no clone, no install.

To see sessions run side by side:

```bash
node parallel.mjs
```

```text
Python: 1,270,607 primes below 20,000,000, the sieve took 0.177 s wall-clock.
Node.js: 1,270,607 primes below 20,000,000, in 0.212 s wall-clock.
C compiled with gcc -O2: 1,270,607 primes below 20,000,000, in 0.089 s wall-clock.

3 sessions, each on its own instance, in 13 s
```

## How it works

`orchestrator.mjs` runs on your machine or server and needs only outbound HTTPS:

1. It long-polls the environment's work queue with the Anthropic SDK's `WorkPoller`. Each item it claims is one session with a turn to run.
2. It finds that session's instance by `metadata.claude_session_id`, or creates one with `auto_sleep: true` on the session's first turn.
3. Over [exec](https://www.agent37.com/docs/agents-api/exec), which wakes a sleeping instance first, it installs Anthropic's `ant` CLI if it is missing and starts `ant beta:worker run` in the background with the session's ids and secret.
4. The worker runs the agent's tools in `/workspace` and exits a minute after the turn ends. While it runs, the orchestrator checks on it once a minute, which keeps the instance awake: the worker's own calls out to Anthropic do not count as [activity](https://www.agent37.com/docs/agents-api/instance-auto-sleep). Five minutes after the worker exits, the instance sleeps.

Only the environment key and the session's secret enter the instance. Your Claude API key and your Agent37 key stay with the orchestrator.

`create-agent.mjs` gives the agent one habit worth copying: read `/workspace/NOTES.md` at the start of a session and update it before ending a turn. The files survive between turns; the notes make sure the agent knows what is in them.

For a single always-on worker that serves sessions one at a time, see the [guide](https://www.agent37.com/docs/agents-api/claude-managed-agents).

## What it costs

Each instance is the default 2 vCPU / 4 GB shape: $4.76 a month if it never slept, metered per minute while awake, and disk alone (about $0.36 a month) while asleep. A session that works ten minutes a day comes to about $0.40 a month on Agent37. Model usage bills to your Claude account.

Instances outlive their sessions. Delete one when you are done with its session:

```bash
curl -X DELETE https://api.agent37.com/v1/instances/INSTANCE_ID \
  -H "Authorization: Bearer $AGENT37_API_KEY"
```

`GET /v1/instances` lists them; the session id is in each one's `metadata.claude_session_id`.

## Limits to know

- Run one orchestrator per environment. It remembers which session has which instance, so two turns of one session never create two instances; two orchestrators could.
- A new workspace runs one instance until its first top-up, so `parallel.mjs` needs a funded wallet.
- The agent runs as root on an `agent37-base` instance (Debian with Node.js, Python, git, and build tools). To give it more, install packages from the agent's own bash tool, or pass a [custom template](https://www.agent37.com/docs/agents-api/custom-image) in the create call.
