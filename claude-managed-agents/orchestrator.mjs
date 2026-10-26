import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { WorkPoller } from "@anthropic-ai/sdk/helpers/beta/environments";

const { AGENT37_API_KEY, ANTHROPIC_ENVIRONMENT_ID, ANTHROPIC_ENVIRONMENT_KEY } = process.env;

const ANT_VERSION = "2.3.0";
const IDLE_TIMEOUT_SECONDS = 300;
const WATCH_EVERY_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, url, headers, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    // 409/503 try_again: a sleep checkpoint is still being written, or the instance just moved hosts.
    if (text.includes("try_again") && attempt < 10) {
      await sleep(attempt * 3000);
      continue;
    }
    throw new Error(`${method} ${url} ${res.status}: ${text}`);
  }
}

const api = (method, path, body) =>
  call(method, `https://api.agent37.com/v1${path}`, { Authorization: `Bearer ${AGENT37_API_KEY}` }, body);

// Exec wakes a sleeping instance first, and every exec counts as activity.
const exec = (instanceId, command) =>
  call("POST", `https://sandbox.agent37.app/v1/instances/${instanceId}/exec`, { "X-Agent37-Key": AGENT37_API_KEY }, {
    command,
    user: "root",
  });

async function findOrCreateInstance(sessionId) {
  const { data } = await api("GET", "/instances");
  const existing = data.find((instance) => instance.metadata?.claude_session_id === sessionId);
  if (existing) return existing.id;

  const instance = await api("POST", "/instances", {
    name: `claude-${sessionId.slice(-8)}`,
    metadata: { claude_session_id: sessionId },
    auto_sleep: true,
    idle_timeout_seconds: IDLE_TIMEOUT_SECONDS,
  });
  console.log(`session ${sessionId}: created instance ${instance.id}`);
  return instance.id;
}

const instances = new Map();
function instanceFor(sessionId) {
  if (!instances.has(sessionId)) {
    const lookup = findOrCreateInstance(sessionId);
    lookup.catch(() => instances.delete(sessionId));
    instances.set(sessionId, lookup);
  }
  return instances.get(sessionId);
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

function startWorkerCommand(work) {
  const env = {
    ANTHROPIC_ENVIRONMENT_ID,
    ANTHROPIC_ENVIRONMENT_KEY,
    ANTHROPIC_SESSION_ID: work.data.id,
    ANTHROPIC_WORK_ID: work.id,
    ANTHROPIC_WORK_SECRET: work.secret ?? "",
    // The worker's bash tool runs on a terminal, so without this `git log` waits on a pager until the tool times out.
    PAGER: "cat",
  };
  const vars = Object.entries(env)
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(" ");
  return `set -e
if pgrep -x ant >/dev/null; then echo running; exit 0; fi
command -v ant >/dev/null || curl -fsSL https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_amd64.tar.gz | tar -xz -C /usr/local/bin ant
mkdir -p /workspace && cd /workspace
${vars} setsid nohup ant beta:worker run --workdir /workspace >> /var/log/claude-worker.log 2>&1 < /dev/null &
echo started`;
}

async function handleWork(work) {
  const sessionId = work.data.id;
  const instanceId = await instanceFor(sessionId);
  const { stdout, stderr, exit_code } = await exec(instanceId, startWorkerCommand(work));
  if (exit_code !== 0) throw new Error(`could not start the worker: ${stderr}`);
  if (stdout.trim() === "running") return;
  console.log(`session ${sessionId}: worker running on ${instanceId}`);

  // The worker exits a minute after the session's turn ends. Until then, a check every
  // minute keeps the instance awake; after it, the instance sleeps once it has been idle
  // for IDLE_TIMEOUT_SECONDS and bills disk alone until the session's next turn wakes it.
  while ((await exec(instanceId, "pgrep -x ant || true")).stdout.trim()) {
    await sleep(WATCH_EVERY_MS);
  }
  console.log(`session ${sessionId}: idle, ${instanceId} sleeps in ${IDLE_TIMEOUT_SECONDS / 60} minutes`);
}

const poller = new WorkPoller({
  client: new Anthropic({ apiKey: null, authToken: ANTHROPIC_ENVIRONMENT_KEY }),
  environmentId: ANTHROPIC_ENVIRONMENT_ID,
  environmentKey: ANTHROPIC_ENVIRONMENT_KEY,
  autoStop: false,
});

console.log(`polling environment ${ANTHROPIC_ENVIRONMENT_ID}`);
for await (const work of poller) {
  handleWork(work).catch((error) => console.error(`session ${work.data.id}: ${error.message}`));
}
