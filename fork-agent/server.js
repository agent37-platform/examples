// fork-agent server: fork an agent together with its database, run several attempts
// at a task in parallel, and keep the best one.
//
// Every agent is an Agent37 instance with its own Neon project. DATABASE_URL in the
// instance env points at the project's default branch. "Try it N ways" then makes N
// copies of both halves at the same moment:
//   - the instance, with POST /v1/instances/{id}/fork (a copy of its disk), and
//   - the database, with a Neon branch (a copy-on-write copy of its data).
// Each fork is repointed at its own branch, gets the same task, and works on its own
// copy. Nothing an attempt does can touch the original or another attempt. Keep one and
// the others are deleted, instance and branch together.
//
// All state lives in instance metadata (which instance is an agent, which is an attempt,
// and which Neon branch each one uses), so this server keeps none of its own.
import '@dotenvx/dotenvx/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as neon from './neon.js';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PORT = Number(process.env.PORT || 3000);
// Listen on loopback only: this server holds both API keys and has no login of its own.
// Set HOST=0.0.0.0 only behind your own auth.
const HOST = process.env.HOST || '127.0.0.1';
// Tags this app's instances in metadata, so it can share a workspace with other apps.
const APP_TAG = 'fork-agent';
const MAX_ATTEMPTS = 4;

for (const name of ['AGENT37_API_KEY', 'NEON_API_KEY']) {
  if (!process.env[name]) {
    console.error(`Set ${name} in .env (copy .env.example).`);
    process.exit(1);
  }
}

const INSTANCE_ID = /^[a-z0-9]{10}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

const app = new Hono();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const instanceUrl = (id, pathname) => `https://${id}.${APP_DOMAIN}${pathname}`;
const readJson = (c) => c.req.json().catch(() => ({}));

// ---- Agent37 helpers ----

function errorBody(code, message) {
  return { error: { code, message } };
}

class UpstreamError extends Error {
  constructor(status, body) {
    const code = typeof body?.error === 'object' ? body.error.code : body?.error || 'upstream_error';
    super((typeof body?.error === 'object' && body.error.message) || String(code).replaceAll('_', ' '));
    this.status = status;
    this.code = code;
  }
}

// Sandbox API calls take the key as a Bearer token; instance URLs take it raw in
// X-Agent37-Key.
async function agent37(url, init = {}) {
  const headers = url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new UpstreamError(res.status, body);
  return body;
}

const sandbox = (pathname, init) => agent37(`${API_BASE}/v1${pathname}`, init);
const post = (pathname, body) => sandbox(pathname, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = (pathname, body) => sandbox(pathname, { method: 'PATCH', body: JSON.stringify(body) });

// One error handler for every route. Agent37 errors carry their HTTP status; Neon SDK
// errors carry `status` when the API answered (and a `kind` such as "not_found").
app.onError((err, c) => {
  const status = Number.isInteger(err.status) && err.status >= 400 ? err.status : 502;
  return c.json(errorBody(err.code || err.kind || 'upstream_unreachable', String(err.message || err)), status);
});

// A browser sends another site's POST without asking first only when the body is form
// data or text/plain. Requiring JSON on every write forces a CORS preflight, which this
// server never answers, so another site cannot drive these routes from a visitor's
// browser. A browser request from a different host is refused outright.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json(errorBody('unsupported_media_type', 'Send the request with Content-Type: application/json.'), 415);
    }
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== c.req.header('host')) {
      return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed.'), 403);
    }
  }
  await next();
});

for (const pattern of ['/api/agents/:id', '/api/agents/:id/*', '/api/attempts/:id/*', '/api/i/:id/*']) {
  app.use(pattern, async (c, next) => {
    if (!INSTANCE_ID.test(c.req.param('id'))) return c.json(errorBody('invalid_request', 'Bad instance id.'), 400);
    await next();
  });
}

// The chat proxy only reaches this app's own agents and attempts. Ownership is checked
// once per instance and remembered.
const owned = new Set();
app.use('/api/i/:id/*', async (c, next) => {
  const id = c.req.param('id');
  if (!owned.has(id)) {
    await getAgent(id); // throws 404 for an instance this app did not create
    owned.add(id);
  }
  await next();
});

// A fork of a large instance can return 202 while the platform finishes it; wait for it.
async function waitForRunning(id, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = await sandbox(`/instances/${id}`);
    if (instance.status === 'running') return instance;
    if (instance.status === 'failed') throw new UpstreamError(502, { error: { code: 'fork_failed', message: `Instance ${id} failed to start.` } });
    await delay(3000);
  }
  throw new UpstreamError(504, { error: { code: 'timeout', message: `Instance ${id} did not reach running.` } });
}

// "running" means the container is up; the gateway inside answers a little later.
async function isReady(id) {
  try {
    const res = await fetch(instanceUrl(id, '/v1/health'), { headers: AGENT_HEADERS, signal: AbortSignal.timeout(8000) });
    return res.ok && Boolean((await res.json().catch(() => null))?.ok);
  } catch {
    return false;
  }
}

async function waitForReady(id, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(id)) return;
    await delay(3000);
  }
  throw new UpstreamError(504, { error: { code: 'timeout', message: `The agent on ${id} did not come up.` } });
}

// Start a turn and return as soon as the gateway has accepted it. The turn keeps running
// on the instance after this connection closes; its session id is all you need to follow
// it later with GET /v1/sessions/{id}.
async function startTurn(id, input) {
  const controller = new AbortController();
  const res = await fetch(instanceUrl(id, '/v1/responses'), {
    method: 'POST',
    headers: { ...AGENT_HEADERS, Accept: 'text/event-stream' },
    body: JSON.stringify({ input, stream: true }),
    signal: controller.signal,
  });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    throw new UpstreamError(res.status, await res.json().catch(() => null));
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const match = buffer.match(/event: response\.created\ndata: (.+)\n/);
      if (match) return JSON.parse(match[1]);
    }
  } finally {
    controller.abort();
  }
  throw new UpstreamError(502, { error: { code: 'no_response', message: 'The gateway closed the stream before the turn started.' } });
}

// ---- Metadata: this app's whole state ----
//
// agent:   { app, role: "agent",   neon_project_id, neon_branch_id }
// attempt: { ...the same, role: "attempt", parent, attempt, of, session_id }

const isOurs = (instance) => instance.metadata?.app === APP_TAG && instance.status !== 'deleted';

async function listOurs() {
  const { data } = await sandbox('/instances');
  return data.filter(isOurs);
}

async function getAgent(id) {
  const instance = await sandbox(`/instances/${id}`);
  if (!isOurs(instance)) throw new UpstreamError(404, { error: { code: 'not_found', message: 'Not an agent of this app.' } });
  return instance;
}

const neonOf = (meta) => ({ neon_project_id: meta.neon_project_id, neon_branch_id: meta.neon_branch_id });

async function removeAttempt(attempt) {
  await sandbox(`/instances/${attempt.id}`, { method: 'DELETE' });
  await neon.deleteBranch(attempt.metadata.neon_project_id, attempt.metadata.neon_branch_id).catch(() => {});
}

// ---- Briefs ----

const AGENT_BRIEF = [
  'App context (from the fork-agents app, not the user):',
  'You have your own Postgres database. DATABASE_URL in your shell environment points at it; keep the data the user asks you to manage there.',
  'Query it from Node with the pg package (cd ~ && npm install pg), passing process.env.DATABASE_URL. Never print the connection string.',
  'End of app context. The user message follows.',
  '',
  '',
].join('\n');

function attemptBrief(n, of) {
  return [
    'App context (from the fork-agents app, not the user):',
    `You are attempt ${n} of ${of}, running in parallel with the others. This computer and its Postgres database (DATABASE_URL) were copied from the original agent a moment ago, so your files and your data are your own copy: nothing you change reaches the original or the other attempts.`,
    n === 1
      ? 'Take the most direct approach to the task.'
      : 'Take a meaningfully different approach from the most obvious one, so the user has real alternatives to compare.',
    'Work the task to completion without asking questions. End with a short summary of what you changed, and a SQL query the user can run to check the result.',
    'End of app context. The task follows.',
    '',
    '',
  ].join('\n');
}

// ---- Agents ----

// Each agent with its attempts nested under it.
app.get('/api/agents', async (c) => {
  const ours = await listOurs();
  const agents = ours.filter((i) => i.metadata.role === 'agent');
  return c.json({
    data: agents.map((agent) => ({
      ...agent,
      attempts: ours
        .filter((i) => i.metadata.role === 'attempt' && i.metadata.parent === agent.id)
        .sort((a, b) => Number(a.metadata.attempt) - Number(b.metadata.attempt)),
    })),
  });
});

app.post('/api/agents', async (c) => {
  const { name: rawName } = await readJson(c);
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 40) : 'fork-agents agent';
  const db = await neon.createProject(name);
  try {
    const instance = await post('/instances', {
      template: 'agent37-hermes',
      name,
      // Funds managed LLM calls ($1 = 1,000,000 micros). Each fork gets its own budget.
      budget: { credit_micros: 1_000_000 },
      env: { DATABASE_URL: db.connectionString },
      metadata: { app: APP_TAG, role: 'agent', neon_project_id: db.projectId, neon_branch_id: db.branchId },
    });
    return c.json(instance, 201);
  } catch (err) {
    await neon.deleteProject(db.projectId).catch(() => {});
    throw err;
  }
});

// Deleting an agent deletes its attempts, its instance, and its whole Neon project.
app.delete('/api/agents/:id', async (c) => {
  const agent = await getAgent(c.req.param('id'));
  const attempts = (await listOurs()).filter((i) => i.metadata.parent === agent.id);
  await Promise.all(attempts.map((attempt) => sandbox(`/instances/${attempt.id}`, { method: 'DELETE' })));
  await sandbox(`/instances/${agent.id}`, { method: 'DELETE' });
  await neon.deleteProject(agent.metadata.neon_project_id).catch(() => {});
  return c.json({ ok: true });
});

app.get('/api/agents/:id/ready', async (c) => c.json({ ready: await isReady(c.req.param('id')) }));

// ---- Attempts ----

// Fork the agent N times, each fork with its own branch of the agent's database, and
// start the same task on every fork.
app.post('/api/agents/:id/attempts', async (c) => {
  const { task, count: rawCount } = await readJson(c);
  const count = Math.min(Math.max(Number.parseInt(rawCount, 10) || 2, 1), MAX_ATTEMPTS);
  if (typeof task !== 'string' || !task.trim()) return c.json(errorBody('invalid_request', 'Send JSON { "task", "count" }.'), 400);

  const agent = await getAgent(c.req.param('id'));
  if (agent.metadata.role !== 'agent') return c.json(errorBody('invalid_request', 'Fork the agent, not an attempt.'), 400);
  const existing = (await listOurs()).filter((i) => i.metadata.parent === agent.id);
  if (existing.length) return c.json(errorBody('attempts_running', 'Keep one attempt or discard them before starting another round.'), 409);

  const meta = agent.metadata;
  const stamp = Date.now().toString(36);

  const attempts = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const n = index + 1;
      // 1. Copy both halves at the same moment: the database as a Neon branch of the
      //    agent's branch, and the computer as a fork (same image, same files, its own
      //    id, URLs, and budget).
      const [branchResult, forkResult] = await Promise.allSettled([
        neon.createBranch(meta.neon_project_id, meta.neon_branch_id, `attempt-${stamp}-${n}`),
        post(`/instances/${agent.id}/fork`, {
          name: `${agent.name} · attempt ${n}`.slice(0, 60),
          // A round you walk away from should not bill compute forever: an attempt with
          // no traffic on its URLs for an hour sleeps at disk-only rates. The UI's status
          // polling counts as traffic, so attempts you are watching stay awake.
          auto_sleep: true,
          idle_timeout_seconds: 3600,
          metadata: { ...neonOf(meta), app: APP_TAG, role: 'attempt', parent: agent.id, attempt: String(n), of: String(count) },
        }),
      ]);
      const branch = branchResult.value;
      let fork = forkResult.value;
      try {
        if (branchResult.status === 'rejected') throw branchResult.reason;
        if (forkResult.status === 'rejected') throw forkResult.reason;
        if (fork.status !== 'running') fork = await waitForRunning(fork.id);

        // 2. Repoint the fork at its branch. A fork inherits the agent's env, so it boots
        //    with the agent's DATABASE_URL; the edit lands on the restart. Nothing on the
        //    instance touches the database before its first turn, so the original is safe.
        const metadata = { ...fork.metadata, neon_branch_id: branch.branchId };
        await patch(`/instances/${fork.id}`, { env: { DATABASE_URL: branch.connectionString }, metadata });
        await post(`/instances/${fork.id}/restart`);

        // 3. A fork has a budget of its own: grant it headroom for the attempt.
        await post(`/instances/${fork.id}/budget/top-up`, { amount_micros: 1_000_000, idempotency_key: `${fork.id}-attempt` });

        // 4. Start the task and record the session, so the UI can follow it.
        await waitForReady(fork.id);
        const turn = await startTurn(fork.id, attemptBrief(n, count) + task.trim());
        await patch(`/instances/${fork.id}`, { metadata: { ...metadata, session_id: turn.session_id } });
        return { id: fork.id, attempt: n, branch_id: branch.branchId, session_id: turn.session_id };
      } catch (err) {
        if (fork?.id) await sandbox(`/instances/${fork.id}`, { method: 'DELETE' }).catch(() => {});
        if (branch) await neon.deleteBranch(meta.neon_project_id, branch.branchId).catch(() => {});
        return { attempt: n, error: String(err.message || err) };
      }
    })
  );
  return c.json({ data: attempts }, 201);
});

// Where an attempt is: working while its session has a running response, done once the
// transcript holds the agent's reply.
app.get('/api/attempts/:id/status', async (c) => {
  const attempt = await getAgent(c.req.param('id'));
  const sessionId = attempt.metadata.session_id;
  if (!sessionId) return c.json({ state: 'starting', reply: null });
  const session = await agent37(instanceUrl(attempt.id, `/v1/sessions/${sessionId}`));
  const reply = [...(session.history || [])].reverse().find((message) => message.role === 'assistant')?.content || null;
  return c.json({ state: session.active_response_id ? 'working' : reply ? 'done' : 'starting', reply, session_id: sessionId });
});

// Keep one attempt: it becomes the agent. The other attempts are deleted with their
// branches, and so is the original instance. The original's branch stays in Neon as the
// point the round started from (Neon keeps a branch while it has children), and the
// winner's branch becomes the project's default.
app.post('/api/attempts/:id/keep', async (c) => {
  const winner = await getAgent(c.req.param('id'));
  if (winner.metadata.role !== 'attempt') return c.json(errorBody('invalid_request', 'Only an attempt can be kept.'), 400);
  const parent = await getAgent(winner.metadata.parent);
  const siblings = (await listOurs()).filter((i) => i.metadata.parent === parent.id && i.id !== winner.id);

  await Promise.all(siblings.map(removeAttempt));
  await sandbox(`/instances/${parent.id}`, { method: 'DELETE' });
  await neon.setDefaultBranch(winner.metadata.neon_project_id, winner.metadata.neon_branch_id).catch(() => {});
  const kept = await patch(`/instances/${winner.id}`, {
    name: parent.name,
    // Sent whole: attempt-only keys are nulled, so this reads right whether the API
    // replaces the stored metadata or merges into it.
    metadata: { ...neonOf(winner.metadata), app: APP_TAG, role: 'agent', parent: null, attempt: null, of: null, session_id: null },
  });
  return c.json(kept);
});

// Throw the round away: delete every attempt and its branch. The agent is untouched.
app.post('/api/agents/:id/discard', async (c) => {
  const agent = await getAgent(c.req.param('id'));
  const attempts = (await listOurs()).filter((i) => i.metadata.parent === agent.id);
  await Promise.all(attempts.map(removeAttempt));
  return c.json({ ok: true, deleted: attempts.length });
});

// Run one read-only query against the agent's branch and every attempt's branch, side by
// side, to compare what each attempt did to the data.
app.post('/api/agents/:id/check', async (c) => {
  const { sql } = await readJson(c);
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 4000) return c.json(errorBody('invalid_request', 'Send JSON { "sql" }.'), 400);
  const agent = await getAgent(c.req.param('id'));
  const attempts = (await listOurs())
    .filter((i) => i.metadata.parent === agent.id)
    .sort((a, b) => Number(a.metadata.attempt) - Number(b.metadata.attempt));
  const targets = [{ label: 'original', instance: agent }, ...attempts.map((a) => ({ label: `attempt ${a.metadata.attempt}`, instance: a }))];
  const results = await Promise.all(
    targets.map(async ({ label, instance }) => {
      const m = instance.metadata;
      try {
        const uri = await neon.connectionString(m.neon_project_id, m.neon_branch_id);
        return { label, instance_id: instance.id, rows: await neon.readOnlyQuery(uri, sql) };
      } catch (err) {
        return { label, instance_id: instance.id, error: String(err.message || err) };
      }
    })
  );
  return c.json({ data: results });
});

// ---- Agent API: chat with any agent or attempt, proxied to its gateway ----

async function forwardSse(c, url, init = {}) {
  const upstream = await fetch(url, {
    ...init,
    headers: { ...AGENT_HEADERS, Accept: 'text/event-stream', ...init.headers },
    signal: c.req.raw.signal,
  });
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
    throw new UpstreamError(upstream.status, await upstream.json().catch(() => null));
  }
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}

const sessionPath = (c) => `/v1/sessions/${encodeURIComponent(c.req.param('sid'))}`;
const responsePath = (c, suffix) => `/v1/responses/${encodeURIComponent(c.req.param('rid'))}${suffix}`;

app.get('/api/i/:id/sessions', async (c) => c.json(await agent37(instanceUrl(c.req.param('id'), '/v1/sessions'))));
app.get('/api/i/:id/sessions/:sid', async (c) => c.json(await agent37(instanceUrl(c.req.param('id'), sessionPath(c)))));

app.post('/api/i/:id/responses', async (c) => {
  const payload = await readJson(c);
  // The gateway has no instructions field, so app context rides on a session's first turn.
  if (!payload.session_id && typeof payload.input === 'string') payload.input = AGENT_BRIEF + payload.input;
  const url = instanceUrl(c.req.param('id'), '/v1/responses');
  const init = { method: 'POST', body: JSON.stringify(payload) };
  return payload.stream === true ? forwardSse(c, url, init) : c.json(await agent37(url, init));
});

app.get('/api/i/:id/responses/:rid/stream', (c) => forwardSse(c, instanceUrl(c.req.param('id'), responsePath(c, '/stream'))));
app.post('/api/i/:id/responses/:rid/cancel', async (c) =>
  c.json(await agent37(instanceUrl(c.req.param('id'), responsePath(c, '/cancel')), { method: 'POST' }))
);

app.use('/*', serveStatic({ root: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') }));

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () =>
  console.log(`fork-agent running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`)
);
// Forking and starting several attempts takes a minute or more.
server.requestTimeout = 0;
server.headersTimeout = 0;
