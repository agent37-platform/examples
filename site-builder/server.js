// site-builder server: a chat proxy plus the owner-side publish endpoint.
//
// The sk_live_ key is workspace-scoped, so it must never reach the browser or the agent.
// Every call goes browser -> this server -> Agent37, exactly like hermes-chat. What this
// example adds is publishing: the agent inside the instance builds a website, then asks
// this server to make it reachable, and this server (the workspace owner) calls the
// Hosting API to give the site's port a permanent public URL.
//
// The agent cannot mint public URLs itself; there is deliberately no agent-facing route
// for it on the platform. The consent chain is:
//   1. Creating an instance plants a publish token: the raw token goes into the container
//      env (SITE_PUBLISH_TOKEN, visible to the agent's shell) and its SHA-256 into the
//      instance metadata. env is write-only on the API and metadata is readable, so the
//      pair lets this server verify a presented token against the instance it claims to
//      come from, with no state kept here.
//   2. The first turn of every session gets a publishing brief prepended, telling the
//      agent where to build, how to serve, and how to call POST /api/publish below.
//   3. /api/publish checks the token hash, then creates the public port with the key.
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 3000);
// The port the brief tells the agent to serve on. Any unreserved port works; fixing one
// keeps the brief, the publish call, and the UI's "Site" link all pointing at the same
// place.
const SITE_PORT = 8788;

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

const INSTANCE_ID = /^[a-z0-9]{10}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

function headersFor(url) {
  return url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

function normalizeError(status, body) {
  if (body && typeof body.error === 'object' && body.error?.code) return { status, body };
  if (body && typeof body.error === 'string') {
    return { status, body: { error: { code: body.error, message: body.error.replaceAll('_', ' ') } } };
  }
  return { status, body: { error: { code: 'upstream_error', message: `Unexpected upstream response (HTTP ${status}).` } } };
}

async function agent37(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headersFor(url), ...init.headers } });
  const body = await res.json().catch(() => null);
  return { res, body };
}

async function forwardJson(res, url, init = {}) {
  let upstream;
  try {
    upstream = await agent37(url, init);
  } catch (err) {
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  if (!upstream.res.ok) {
    const norm = normalizeError(upstream.res.status, upstream.body);
    return res.status(norm.status).json(norm.body);
  }
  res.status(upstream.res.status).json(upstream.body);
}

// Pipe an upstream SSE response through untouched (see hermes-chat for the full story:
// EventSource cannot POST or send custom headers, so the server must relay the stream).
async function forwardSse(req, res, url, init = {}) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  let upstream;
  try {
    upstream = await fetch(url, {
      ...init,
      headers: { ...headersFor(url), Accept: 'text/event-stream', ...init.headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await upstream.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const norm = normalizeError(upstream.status, body);
    return res.status(norm.status).json(norm.body);
  }
  res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.flushHeaders();
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch {
    // Client navigated away or upstream dropped; either way there is nothing left to send.
  }
  res.end();
}

function instanceUrl(id, pathname) {
  return `https://${id}.${APP_DOMAIN}${pathname}`;
}

function requireInstanceId(req, res, next) {
  if (!INSTANCE_ID.test(req.params.id)) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad instance id.' } });
  }
  next();
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// ---- Hosting API: instance management ----

app.get('/api/instances', (req, res) => forwardJson(res, `${API_BASE}/v1/instances`));

app.post('/api/instances', async (req, res) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : 'site-builder agent';
  // The publish token pins "may publish on this instance" to "was created by this app":
  // the agent presents the raw token from its env, /api/publish compares its hash to the
  // one stored in metadata. Rotating it means creating a new instance; env is immutable.
  const token = crypto.randomBytes(24).toString('hex');
  const body = {
    name,
    // budget.credit_micros funds managed LLM calls for this instance ($1 = 1,000,000
    // micros). Without it the default managed budget is $0 and replies come back empty.
    budget: { credit_micros: 1_000_000 },
    env: { SITE_PUBLISH_TOKEN: token },
    metadata: { site_publish_token_sha256: sha256(token) },
  };
  forwardJson(res, `${API_BASE}/v1/instances`, { method: 'POST', body: JSON.stringify(body) });
});

app.delete('/api/instances/:id', requireInstanceId, (req, res) =>
  forwardJson(res, `${API_BASE}/v1/instances/${req.params.id}`, { method: 'DELETE' })
);

// "running" means the container is up, not that the agent inside has finished booting.
// The UI polls this until the gateway answers; on a cold host that can take a few minutes.
app.get('/api/instances/:id/ready', requireInstanceId, async (req, res) => {
  try {
    const upstream = await fetch(instanceUrl(req.params.id, '/v1/health'), {
      headers: AGENT_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const body = upstream.ok ? await upstream.json().catch(() => null) : null;
    res.json({ ready: Boolean(body?.ok) });
  } catch {
    res.json({ ready: false });
  }
});

// ---- Publishing: the endpoint the agent calls ----
//
// This is the one route authenticated by the publish token instead of by being local to
// the app: the caller is the agent, curling from inside its instance. In your own app,
// this is where "may this agent publish?" policy goes: rate limits, port allowlists,
// per-user quotas, an approval step.

app.post('/api/publish', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const instanceId = req.body?.instance_id;
  const port = req.body?.port;
  if (!token || !INSTANCE_ID.test(instanceId || '') || !Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Send Authorization: Bearer <token> and JSON { "instance_id", "port" }.' } });
  }

  // Verify the token against the hash planted in the instance's metadata at create.
  let instance;
  try {
    instance = await agent37(`${API_BASE}/v1/instances/${instanceId}`);
  } catch (err) {
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  if (!instance.res.ok) {
    const norm = normalizeError(instance.res.status, instance.body);
    return res.status(norm.status).json(norm.body);
  }
  const expected = instance.body?.metadata?.site_publish_token_sha256;
  const presented = sha256(token);
  if (typeof expected !== 'string' || expected.length !== presented.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'The publish token does not match this instance.' } });
  }

  // Create the public port. 409 means it already exists, which for "publish" means
  // success: return the existing URL so republishing is idempotent.
  const created = await agent37(`${API_BASE}/v1/instances/${instanceId}/public-ports`, {
    method: 'POST',
    body: JSON.stringify({ port, label: 'site-builder site' }),
  });
  if (created.res.ok) return res.json({ url: created.body.url });
  if (created.body?.error?.code === 'public_port_exists' || created.res.status === 409) {
    const list = await agent37(`${API_BASE}/v1/instances/${instanceId}/public-ports`);
    const existing = list.body?.data?.find((entry) => entry.port === port);
    if (existing) return res.json({ url: existing.url });
  }
  const norm = normalizeError(created.res.status, created.body);
  res.status(norm.status).json(norm.body);
});

// ---- Agent API: chat, proxied to the instance's gateway ----

// The gateway has no instructions field on POST /v1/responses, so app context rides as a
// preamble on the first turn of each session. Composed per request, so a redeploy (or a
// new cloudflared URL) reaches every new session without touching existing instances.
function publishBrief() {
  return [
    'App context (from the site-builder app, not the user):',
    'You are the building agent behind a website-builder app. When the user asks for a page, site, or web app:',
    `1. Put the files in ~/site and serve them on port ${SITE_PORT}. For static files: mkdir -p ~/site && nohup python3 -m http.server ${SITE_PORT} --directory ~/site >/tmp/site.log 2>&1 &`,
    `2. Keep it running across restarts: append that exact nohup command to ~/.agent37/hooks/post-restart.sh if it is not already there. That hook runs on every boot of this computer; commands in it must run in the background.`,
    `3. Publish it by calling the app (use the env vars, they are set in your shell): curl -s -X POST ${PUBLIC_APP_URL}/api/publish -H "Authorization: Bearer $SITE_PUBLISH_TOKEN" -H "Content-Type: application/json" -d "{\\"instance_id\\":\\"$AGENT37_INSTANCE_ID\\",\\"port\\":${SITE_PORT}}"`,
    '4. The response has a "url" field. Give the user that URL verbatim, and tell them the link is public: anyone who has it can open the site.',
    'Publishing the same port twice returns the same URL; edits to files in ~/site show up on the existing URL with no republish. Never use ngrok or any other tunnel; publishing works only through the endpoint above.',
    'End of app context. The user message follows.',
    '',
    '',
  ].join('\n');
}

app.get('/api/i/:id/models', requireInstanceId, (req, res) => forwardJson(res, instanceUrl(req.params.id, '/v1/models')));

app.get('/api/i/:id/sessions', requireInstanceId, (req, res) => forwardJson(res, instanceUrl(req.params.id, '/v1/sessions')));

app.get('/api/i/:id/sessions/:sid', requireInstanceId, (req, res) =>
  forwardJson(res, instanceUrl(req.params.id, `/v1/sessions/${encodeURIComponent(req.params.sid)}`))
);

app.delete('/api/i/:id/sessions/:sid', requireInstanceId, (req, res) =>
  forwardJson(res, instanceUrl(req.params.id, `/v1/sessions/${encodeURIComponent(req.params.sid)}`), { method: 'DELETE' })
);

app.post('/api/i/:id/responses', requireInstanceId, (req, res) => {
  const payload = { ...(req.body ?? {}) };
  if (!payload.session_id && typeof payload.input === 'string') {
    payload.input = publishBrief() + payload.input;
  }
  const body = JSON.stringify(payload);
  if (payload.stream === true) {
    return forwardSse(req, res, instanceUrl(req.params.id, '/v1/responses'), { method: 'POST', body });
  }
  forwardJson(res, instanceUrl(req.params.id, '/v1/responses'), { method: 'POST', body });
});

app.get('/api/i/:id/responses/:rid/stream', requireInstanceId, (req, res) =>
  forwardSse(req, res, instanceUrl(req.params.id, `/v1/responses/${encodeURIComponent(req.params.rid)}/stream`))
);

app.post('/api/i/:id/responses/:rid/cancel', requireInstanceId, (req, res) =>
  forwardJson(res, instanceUrl(req.params.id, `/v1/responses/${encodeURIComponent(req.params.rid)}/cancel`), { method: 'POST' })
);

const server = app.listen(PORT, () => {
  console.log(`site-builder running at http://localhost:${PORT}`);
  console.log(`agents publish via ${PUBLIC_APP_URL}/api/publish`);
});
// Instance creation is synchronous on the Agent37 side and can run for minutes on a cold
// host; without this, Node's default 5-minute request timeout kills the create just short
// of the API's own budget.
server.requestTimeout = 0;
server.headersTimeout = 0;
