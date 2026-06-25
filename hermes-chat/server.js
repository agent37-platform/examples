// hermes-chat server: a thin proxy that holds the Agent37 API key.
//
// The sk_live_ key is workspace-scoped, so it must never reach the browser. Every call,
// including the SSE chat stream, goes browser -> this server -> Agent37. There are two
// upstreams behind one key:
//   - the Hosting API at AGENT37_API_BASE (create/list/delete instances)
//   - each instance's own Agent API at https://{instanceId}.{AGENT37_APP_DOMAIN} (chat)
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PORT = Number(process.env.PORT || 3000);

if (!API_KEY) {
  console.error('Set AGENT37_API_KEY in .env (copy .env.example). Mint a key at https://www.agent37.com/dashboard/cloud/api-keys');
  process.exit(1);
}

// Instance ids are 10-char DNS labels; validating here keeps arbitrary hosts out of the
// instance-URL template below.
const INSTANCE_ID = /^[a-z0-9]{10}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

// The API returns three error shapes: the Hosting API and the Agent API use
// { error: { code, message, hint? } }, but edge rejections are flat strings like
// { error: "invalid_api_key" }. Normalize so the browser always gets the object form.
function normalizeError(status, body) {
  if (body && typeof body.error === 'object' && body.error?.code) return { status, body };
  if (body && typeof body.error === 'string') {
    return { status, body: { error: { code: body.error, message: body.error.replaceAll('_', ' ') } } };
  }
  return { status, body: { error: { code: 'upstream_error', message: `Unexpected upstream response (HTTP ${status}).` } } };
}

async function forwardJson(res, url, init = {}) {
  let upstream;
  try {
    upstream = await fetch(url, { ...init, headers: { ...AUTH_HEADERS, ...init.headers } });
  } catch (err) {
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  const text = await upstream.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!upstream.ok) {
    const norm = normalizeError(upstream.status, body);
    return res.status(norm.status).json(norm.body);
  }
  res.status(upstream.status).json(body);
}

// Pipe an upstream SSE response through untouched. The browser cannot call the instance
// directly: EventSource cannot POST or set the Authorization header, and a fetch from the
// page would expose the key.
async function forwardSse(req, res, url, init = {}) {
  const controller = new AbortController();
  // res 'close' (not req 'close', which fires once the request body is consumed) signals the
  // browser went away mid-stream; abort the upstream turn fetch so it doesn't leak.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  let upstream;
  try {
    upstream = await fetch(url, {
      ...init,
      headers: { ...AUTH_HEADERS, Accept: 'text/event-stream', ...init.headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  // Pre-stream failures (e.g. 409 session_busy) arrive as plain JSON before any SSE bytes.
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

// ---- Hosting API: instance management ----

app.get('/api/instances', (req, res) => forwardJson(res, `${API_BASE}/v1/instances`));

app.post('/api/instances', (req, res) => {
  // budget.topup_micros funds managed LLM calls for this instance ($1 = 1,000,000 micros).
  // Without it the default managed budget is $0 and chat replies come back empty.
  const body = {
    name: typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : 'hermes-chat example',
    budget: { topup_micros: 1_000_000 },
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
      headers: AUTH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const body = upstream.ok ? await upstream.json().catch(() => null) : null;
    res.json({ ready: Boolean(body?.ok) });
  } catch {
    res.json({ ready: false });
  }
});

// ---- Agent API: everything below talks to the instance itself ----

app.get('/api/i/:id/models', requireInstanceId, (req, res) => forwardJson(res, instanceUrl(req.params.id, '/v1/models')));

app.get('/api/i/:id/sessions', requireInstanceId, (req, res) => forwardJson(res, instanceUrl(req.params.id, '/v1/sessions')));

app.get('/api/i/:id/sessions/:sid', requireInstanceId, (req, res) =>
  forwardJson(res, instanceUrl(req.params.id, `/v1/sessions/${encodeURIComponent(req.params.sid)}`))
);

app.delete('/api/i/:id/sessions/:sid', requireInstanceId, (req, res) =>
  forwardJson(res, instanceUrl(req.params.id, `/v1/sessions/${encodeURIComponent(req.params.sid)}`), { method: 'DELETE' })
);

app.post('/api/i/:id/responses', requireInstanceId, (req, res) => {
  const body = JSON.stringify(req.body ?? {});
  if (req.body?.stream === true) {
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
  console.log(`hermes-chat running at http://localhost:${PORT}`);
});
// Instance creation is synchronous on the Agent37 side and can run for minutes on a cold
// host; without this, Node's default 5-minute request timeout kills the create just short
// of the API's own budget.
server.requestTimeout = 0;
server.headersTimeout = 0;
