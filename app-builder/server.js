// app-builder server: a chat proxy, the owner-side publish endpoint, and the
// database controls for every app the agent builds.
//
// This is the site-builder example with one addition: every app the agent builds gets
// its own Postgres database. The agent creates it on its own with Claimable Neon
// (`npx neon claim create`): no Neon account, no token, nothing for this server to
// hand out. The database is free and temporary (it expires 72 hours after creation), and
// the end user claims it into their own Neon account when they want to keep the app.
//
// The sk_live_ key is workspace-scoped, so it must never reach the browser or the agent.
// Every call goes browser -> this server -> Agent37. The consent chain for publishing is
// the same as site-builder's:
//   1. Creating an instance plants a publish token: the raw token in the container env
//      (APP_PUBLISH_TOKEN), its SHA-256 in the instance metadata.
//   2. The first turn of every session gets a brief prepended: where to build, how to
//      create the database, how to run the app, and how to call POST /api/publish.
//   3. /api/publish checks the token hash, then creates the public port with the key.
//
// The database controls read the instance's own disk through exec (see
// instance-scripts.js), so this server keeps no state.
import '@dotenvx/dotenvx/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { NEON_CLI, LIST_APPS_SCRIPT, CLAIM_SCRIPT, SET_DATABASE_URL_SCRIPT } from './instance-scripts.js';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const SANDBOX_BASE = process.env.AGENT37_SANDBOX_BASE || 'https://sandbox.agent37.app';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 3000);
// Listen on loopback only: this server holds the workspace key and has no login of its
// own. A tunnel (cloudflared) still reaches it; set HOST=0.0.0.0 only behind your own auth.
const HOST = process.env.HOST || '127.0.0.1';
// Tags this app's instances in metadata. Every per-instance route checks it, so the app
// never lists, chats with, runs commands on, or deletes another app's instances.
const APP_TAG = 'app-builder';
// Each app the agent builds gets one port from this range. The publish endpoint refuses
// anything outside it: that is this app's port policy.
const APP_PORT_MIN = 8800;
const APP_PORT_MAX = 8899;
const PORT_LABEL_PREFIX = 'app:';

if (!API_KEY) {
  console.error('Set AGENT37_API_KEY in .env (copy .env.example). Mint a key at https://www.agent37.com/dashboard/cloud/api-keys');
  process.exit(1);
}
if (!PUBLIC_APP_URL) {
  console.error('Set PUBLIC_APP_URL in .env: the URL agents use to reach this server when publishing.');
  console.error('Agents run in the cloud, so it cannot be localhost. Deploy this app, or for local dev run:');
  console.error('  cloudflared tunnel --url http://localhost:3000');
  console.error('and paste the https URL it prints.');
  process.exit(1);
}

// The URL is written into a file on every instance (see syncPublishUrl), so it must be a
// plain http(s) URL with nothing a shell would interpret.
if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(PUBLIC_APP_URL)) {
  console.error(`PUBLIC_APP_URL must be a plain https URL, for example https://your-app.com (got ${PUBLIC_APP_URL}).`);
  process.exit(1);
}

const INSTANCE_ID = /^[a-z0-9]{10}$/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

// The Sandbox API takes the key as a Bearer token; instance URLs (the Agent API) and the
// exec host take it raw in X-Agent37-Key.
function headersFor(url) {
  return url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
}

const app = new Hono();

// ---- Upstream helpers ----

function errorBody(code, message) {
  return { error: { code, message } };
}

// Agent37 errors are { "error": { "code", "message" } }, but a request turned away at an
// instance URL or the exec host gets a flat { "error": "not_found" }. Normalize both.
function normalizeError(status, body) {
  if (body && typeof body.error === 'object' && body.error?.code) return { status, body };
  if (body && typeof body.error === 'string') return { status, body: errorBody(body.error, body.error.replaceAll('_', ' ')) };
  return { status, body: errorBody('upstream_error', `Unexpected upstream response (HTTP ${status}).`) };
}

class UpstreamError extends Error {
  constructor(status, body) {
    const norm = normalizeError(status, body);
    super(norm.body.error.message);
    this.status = norm.status;
    this.body = norm.body;
  }
}

async function agent37(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headersFor(url), ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new UpstreamError(res.status, body);
  return { status: res.status, body };
}

// One error handler for every route: upstream errors pass through in Agent37's envelope,
// everything else (a network failure, a failed command on the instance) is a 502.
app.onError((err, c) => {
  if (err instanceof UpstreamError) return c.json(err.body, err.status);
  return c.json(errorBody(err.code || 'upstream_unreachable', String(err.message || err)), 502);
});

async function forwardJson(c, url, init) {
  const { status, body } = await agent37(url, init);
  return c.json(body, status);
}

// Relay an upstream SSE stream. Hono speaks Web Request/Response, so the upstream body
// is handed straight back; passing the request's signal cancels the upstream fetch when
// the browser goes away.
async function forwardSse(c, url, init = {}) {
  const upstream = await fetch(url, {
    ...init,
    headers: { ...headersFor(url), Accept: 'text/event-stream', ...init.headers },
    signal: c.req.raw.signal,
  });
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
    // Failures before the stream starts (busy session, bad request) come back as JSON.
    throw new UpstreamError(upstream.status, await upstream.json().catch(() => null));
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}

const readJson = (c) => c.req.json().catch(() => ({}));

// The pasted URL ends up in the app's .env, which start.sh loads with sh. Only a plain
// postgres URL may pass: no quotes, $, backticks, backslashes, or whitespace, any of
// which the shell would interpret.
function isPlainPostgresUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /["'`$\\\s]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
const instanceUrl = (id, pathname) => `https://${id}.${APP_DOMAIN}${pathname}`;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

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

// Validate path params once for every route that has them, and only act on instances
// this app created. Ownership is checked once per instance and remembered.
const owned = new Set();
for (const pattern of ['/api/instances/:id/*', '/api/instances/:id', '/api/i/:id/*']) {
  app.use(pattern, async (c, next) => {
    const id = c.req.param('id');
    if (!INSTANCE_ID.test(id)) return c.json(errorBody('invalid_request', 'Bad instance id.'), 400);
    if (!owned.has(id)) {
      const { body } = await agent37(`${API_BASE}/v1/instances/${id}`);
      if (body.metadata?.app !== APP_TAG) return c.json(errorBody('not_found', 'No such instance in this app.'), 404);
      owned.add(id);
    }
    await next();
  });
}
app.use('/api/instances/:id/apps/:slug/*', async (c, next) => {
  if (!APP_SLUG.test(c.req.param('slug'))) return c.json(errorBody('invalid_request', 'Bad app name.'), 400);
  await next();
});

// ---- Exec: run a script on the instance ----

async function execOn(instanceId, script, args = []) {
  const b64 = Buffer.from(script).toString('base64');
  const command = `node -e "$(echo ${b64} | base64 -d)" ${args.join(' ')}`;
  const { body } = await agent37(`${SANDBOX_BASE}/v1/instances/${instanceId}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  // A command that exits nonzero is still a 200 from exec; read exit_code to branch.
  if (body.exit_code !== 0) {
    throw Object.assign(new Error((body.stderr || body.stdout || 'command failed').trim().slice(-500)), { code: 'command_failed' });
  }
  return JSON.parse(body.stdout.trim().split('\n').pop());
}

// The agent reads the publish URL from a file on its own disk instead of from the brief,
// because the brief is only sent on a session's first turn: a URL baked into it goes
// stale for every existing chat when this server moves (a new tunnel URL on every
// cloudflared run, a new deploy). The server rewrites the file before an instance's first
// turn after each start, so every chat, old or new, publishes to where the server is now.
const PUBLISH_URL_FILE = '~/.app-builder/publish-url';
const synced = new Set();
async function syncPublishUrl(instanceId) {
  if (synced.has(instanceId)) return;
  const command = `mkdir -p ~/.app-builder && printf '%s\\n' '${PUBLIC_APP_URL}' > ${PUBLISH_URL_FILE}`;
  const { body } = await agent37(`${SANDBOX_BASE}/v1/instances/${instanceId}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  if (body.exit_code !== 0) throw Object.assign(new Error(`Could not write ${PUBLISH_URL_FILE}: ${body.stderr}`), { code: 'command_failed' });
  synced.add(instanceId);
}

// ---- Sandbox API: instance management ----

app.get('/api/instances', async (c) => {
  const { body } = await agent37(`${API_BASE}/v1/instances`);
  return c.json({ data: body.data.filter((instance) => instance.metadata?.app === APP_TAG) });
});

app.post('/api/instances', async (c) => {
  const { name } = await readJson(c);
  const token = crypto.randomBytes(24).toString('hex');
  return forwardJson(c, `${API_BASE}/v1/instances`, {
    method: 'POST',
    body: JSON.stringify({
      template: 'agent37-hermes',
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'app-builder agent',
      // budget.credit_micros funds managed LLM calls for this instance ($1 = 1,000,000
      // micros). Building an app with a database takes more turns than a static page.
      budget: { credit_micros: 2_000_000 },
      // The publish token pins "may publish on this instance" to "was created by this
      // app": the agent presents the raw token from its env, /api/publish compares its
      // hash to the one stored in metadata.
      env: { APP_PUBLISH_TOKEN: token },
      metadata: { app: APP_TAG, app_publish_token_sha256: sha256(token) },
    }),
  });
});

// Deleting the instance deletes the agent's disk, including the Neon CLI's credentials
// for any unclaimed database. Unclaimed databases then expire on their own 72 hours after
// creation; claimed ones belong to the user's Neon account and are not touched.
app.delete('/api/instances/:id', async (c) => {
  const id = c.req.param('id');
  const result = await forwardJson(c, `${API_BASE}/v1/instances/${id}`, { method: 'DELETE' });
  owned.delete(id);
  return result;
});

// "running" means the container is up, not that the agent inside has finished booting.
app.get('/api/instances/:id/ready', async (c) => {
  try {
    const res = await fetch(instanceUrl(c.req.param('id'), '/v1/health'), { headers: AGENT_HEADERS, signal: AbortSignal.timeout(8000) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return c.json({ ready: Boolean(body?.ok) });
  } catch {
    return c.json({ ready: false });
  }
});

// ---- Apps and their databases ----

// Every app on the instance: its public URL (from the instance's public ports, labelled
// at publish) and its database (from the app folder, through exec).
app.get('/api/instances/:id/apps', async (c) => {
  const id = c.req.param('id');
  const [instance, apps] = await Promise.all([agent37(`${API_BASE}/v1/instances/${id}`), execOn(id, LIST_APPS_SCRIPT)]);
  const ports = instance.body.public_ports || [];
  return c.json({
    data: apps.map((entry) => {
      const published = ports.find((port) => port.label === `${PORT_LABEL_PREFIX}${entry.slug}`);
      return { ...entry, url: published?.url || null, port: published?.port || null };
    }),
  });
});

// A claim code is good for 15 minutes. The user opens the URL, signs in to Neon, and the
// project moves into their own account.
app.post('/api/instances/:id/apps/:slug/claim', async (c) => {
  const claim = await execOn(c.req.param('id'), CLAIM_SCRIPT, [c.req.param('slug')]);
  return c.json({ verification_url: claim.verification_url, user_code: claim.user_code, expires_in_seconds: claim.expires_in_seconds });
});

// Claiming revokes the temporary database password. The user pastes the connection
// string their Neon account issues, and this writes it into the app and restarts it.
app.post('/api/instances/:id/apps/:slug/database-url', async (c) => {
  const { database_url: url } = await readJson(c);
  if (!isPlainPostgresUrl(url)) {
    return c.json(errorBody('invalid_request', 'Send JSON { "database_url": "postgresql://..." } with a plain connection string.'), 400);
  }
  await execOn(c.req.param('id'), SET_DATABASE_URL_SCRIPT, [c.req.param('slug'), Buffer.from(url).toString('base64')]);
  return c.json({ ok: true });
});

// ---- Publishing: the endpoint the agent calls ----
//
// The one route authenticated by the publish token instead of by being local to the app:
// the caller is the agent, curling from inside its instance. In your own app, this is
// where "may this agent publish?" policy goes: quotas, an approval step, your user auth.

app.post('/api/publish', async (c) => {
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const { instance_id: instanceId, app: slug, port } = await readJson(c);
  if (!token || !INSTANCE_ID.test(instanceId || '') || !APP_SLUG.test(slug || '') || !Number.isInteger(port)) {
    return c.json(errorBody('invalid_request', 'Send Authorization: Bearer <token> and JSON { "instance_id", "app", "port" }.'), 400);
  }
  if (port < APP_PORT_MIN || port > APP_PORT_MAX) {
    return c.json(errorBody('invalid_request', `Apps must be served on a port from ${APP_PORT_MIN} to ${APP_PORT_MAX}.`), 400);
  }

  // Verify the token against the hash planted in the instance's metadata at create.
  // Compare as buffers of equal length: timingSafeEqual throws on a length mismatch.
  const instance = await agent37(`${API_BASE}/v1/instances/${instanceId}`);
  if (instance.body.metadata?.app !== APP_TAG) return c.json(errorBody('forbidden', 'Not an instance of this app.'), 403);
  const expected = Buffer.from(String(instance.body.metadata?.app_publish_token_sha256 ?? ''));
  const presented = Buffer.from(sha256(token));
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    return c.json(errorBody('forbidden', 'The publish token does not match this instance.'), 403);
  }

  // The label ties the public port to the app folder, so the Apps panel can show each
  // app's URL next to its database. 409 means the port is already public: return the
  // existing URL so republishing is idempotent.
  try {
    const created = await agent37(`${API_BASE}/v1/instances/${instanceId}/public-ports`, {
      method: 'POST',
      body: JSON.stringify({ port, label: `${PORT_LABEL_PREFIX}${slug}` }),
    });
    return c.json({ url: created.body.url });
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.status !== 409) throw err;
    const list = await agent37(`${API_BASE}/v1/instances/${instanceId}/public-ports`);
    const existing = list.body.data?.find((entry) => entry.port === port);
    if (!existing) throw err;
    return c.json({ url: existing.url });
  }
});

// ---- Agent API: chat, proxied to the instance's gateway ----

// The gateway has no instructions field on POST /v1/responses, so app context rides as a
// preamble on the first turn of each session. It names the publish-url file rather than
// the URL itself, so a new tunnel URL or a redeploy reaches every session, old and new
// (see syncPublishUrl).
function appBrief() {
  return [
    'App context (from the app-builder app, not the user):',
    'You are the building agent behind an app builder. Users ask you for small web apps that keep data. Every app gets its own folder, its own port, and its own Postgres database. For each new app:',
    `1. Pick a short slug (lowercase letters, digits, dashes) and work in ~/apps/<slug>. Pick a port from ${APP_PORT_MIN} to ${APP_PORT_MAX} that no other app uses (grep PORT= ~/apps/*/start.sh shows the ones taken).`,
    `2. Create the app's database: cd ~/apps/<slug> && npx -y ${NEON_CLI} claim create --project-name <slug> --file .env`,
    '   This needs no account or token. It writes DATABASE_URL into ~/apps/<slug>/.env. Never share a database between apps, and never show a connection string to the user.',
    '3. Build the app as a Node server in ~/apps/<slug>/server.js that listens on process.env.PORT, connects with the pg package and process.env.DATABASE_URL, and creates its tables at startup with CREATE TABLE IF NOT EXISTS. Serve the UI from the same server.',
    '4. Write ~/apps/<slug>/start.sh, exactly this with your slug and port filled in, and run it with sh:',
    '   cd ~/apps/<slug>',
    '   [ -f app.pid ] && kill "$(cat app.pid)" 2>/dev/null',
    '   set -a; . ./.env; set +a',
    '   PORT=<port> nohup node server.js >app.log 2>&1 &',
    '   echo $! > app.pid',
    '5. Keep it running across restarts: append the line "sh ~/apps/<slug>/start.sh" to ~/.agent37/hooks/post-restart.sh if it is not already there.',
    `6. Check that curl -s http://localhost:<port>/ answers, then publish it. The app builder's address is in ${PUBLISH_URL_FILE}; read it each time you publish, because it can change. The env vars are set in your shell: curl -s -X POST "$(cat ${PUBLISH_URL_FILE})/api/publish" -H "Authorization: Bearer $APP_PUBLISH_TOKEN" -H "Content-Type: application/json" -d "{\\"instance_id\\":\\"$AGENT37_INSTANCE_ID\\",\\"app\\":\\"<slug>\\",\\"port\\":<port>}"`,
    '7. The response has a "url" field. Give the user that URL verbatim. Tell them the link is public, and that the app runs on a free temporary Neon database that is deleted 72 hours after it was created unless they claim it from the Apps panel.',
    'Edits to an app need no new database and no republish: change the code, then rerun its start.sh. Never use ngrok or any other tunnel; publishing works only through the endpoint above.',
    'End of app context. The user message follows.',
    '',
    '',
  ].join('\n');
}

const sessionPath = (c) => `/v1/sessions/${encodeURIComponent(c.req.param('sid'))}`;
const responsePath = (c, suffix) => `/v1/responses/${encodeURIComponent(c.req.param('rid'))}${suffix}`;

app.get('/api/i/:id/sessions', (c) => forwardJson(c, instanceUrl(c.req.param('id'), '/v1/sessions')));
app.get('/api/i/:id/sessions/:sid', (c) => forwardJson(c, instanceUrl(c.req.param('id'), sessionPath(c))));
app.delete('/api/i/:id/sessions/:sid', (c) => forwardJson(c, instanceUrl(c.req.param('id'), sessionPath(c)), { method: 'DELETE' }));

app.post('/api/i/:id/responses', async (c) => {
  await syncPublishUrl(c.req.param('id'));
  const payload = await readJson(c);
  if (!payload.session_id && typeof payload.input === 'string') payload.input = appBrief() + payload.input;
  const url = instanceUrl(c.req.param('id'), '/v1/responses');
  const init = { method: 'POST', body: JSON.stringify(payload) };
  return payload.stream === true ? forwardSse(c, url, init) : forwardJson(c, url, init);
});

app.get('/api/i/:id/responses/:rid/stream', (c) => forwardSse(c, instanceUrl(c.req.param('id'), responsePath(c, '/stream'))));
app.post('/api/i/:id/responses/:rid/cancel', (c) =>
  forwardJson(c, instanceUrl(c.req.param('id'), responsePath(c, '/cancel')), { method: 'POST' })
);

app.use('/*', serveStatic({ root: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') }));

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`app-builder running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`agents publish via ${PUBLIC_APP_URL}/api/publish`);
});
// Instance creation can run for minutes on a cold host; without this, Node's default
// 5-minute request timeout kills the create just short of the API's own budget.
server.requestTimeout = 0;
server.headersTimeout = 0;
