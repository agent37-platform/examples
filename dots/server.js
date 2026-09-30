// Build your own Dots: a personal agent that owns ongoing responsibilities, keeps its own
// schedule, and messages you first.
//
// The sk_live_ key is workspace-scoped, so it never reaches the browser. Every call goes
// browser -> this server -> Agent37, and the browser never sends an instance id: a signed
// cookie maps each visitor to their own instance in a small JSON store (data/store.json).
// Two upstreams sit behind the one key:
//   - the Hosting API at AGENT37_API_BASE (instances, crons, integrations, exec)
//   - each instance's own Agent API at https://{instanceId}.{AGENT37_APP_DOMAIN} (chat, files)
//
// What makes it a Dots clone rather than a chat app:
//   1. SOUL.md tells the agent it owns responsibilities: it keeps a list the app shows, and
//      schedules its own check-ins with the `agent37 cron` CLI baked into the image.
//   2. Create plants a callback token (env) and its hash (metadata), exactly like the
//      site-builder example. A check-in that finds something runs ~/.dots/notify, which
//      calls POST /api/notify here, and the app shows it as a message you did not ask for.
//   3. Optional: with DESKTOP_TEMPLATE set, agents run on a desktop image and the app shows
//      their screen live beside the chat, where the user can take over and hand it back.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 3101);
const DESKTOP_TEMPLATE = (process.env.DESKTOP_TEMPLATE || '').trim();
const DESKTOP_PORT = 6901;

if (!API_KEY) {
  console.error('Set AGENT37_API_KEY in .env (copy .env.example). Mint a key at https://www.agent37.com/dashboard/cloud/api-keys');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('Set SESSION_SECRET in .env: any long random string, e.g. the output of `openssl rand -hex 32`.');
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error('Set PUBLIC_URL in .env: the URL your agent uses to message you first.');
  console.error('Agents run in the cloud, so it cannot be localhost. Deploy this app, or for local dev run:');
  console.error(`  cloudflared tunnel --url http://localhost:${PORT}`);
  console.error('and paste the https URL it prints.');
  process.exit(1);
}

const INSTANCE_ID = /^[a-z0-9]{10}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const CRON_ID = /^[a-f0-9]{12}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

// Hermes keeps its persona and memory under ~/.hermes; the app's own files live in ~/.dots.
const SOUL_PATH = '~/.hermes/SOUL.md';
const MEMORY_PATHS = { user: '~/.hermes/memories/USER.md', memory: '~/.hermes/memories/MEMORY.md' };
const NOTIFY_PATH = '~/.dots/notify';
const RESPONSIBILITIES_PATH = '~/.dots/responsibilities.md';
const OUTPUTS_PATH = '~/outputs';
const OUTPUTS_BRIEF = `Save finished files for your person directly in ${OUTPUTS_PATH}, with clear file names. The app shows files in that folder as Outputs, where your person can preview and download them.`;
const PERSONA_START = '<!-- dots:persona -->';
const PERSONA_END = '<!-- /dots:persona -->';
// Everything the app says to the agent on the user's behalf starts with this line, so the
// chat view can hide it when it renders history.
const APP_CONTEXT = 'App context (from the Dots app, not your person; they do not see this part):';
const APP_CONTEXT_END = 'End of app context.';

function headersFor(url) {
  return url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
}

// ---- the store: visitor -> their agent ----
//
// One JSON file keeps this example dependency-free. Swap it (and the cookie below) for your
// real database and auth; https://github.com/agent37-platform/starter-kit shows both.

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = fs.existsSync(STORE_FILE) ? JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) : { users: {} };

function save() {
  fs.writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify(store, null, 2));
  fs.renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
}

function userByInstance(instanceId) {
  return Object.values(store.users).find((user) => user.agent?.instanceId === instanceId);
}

// ---- the signed cookie ----

const COOKIE = 'dots_uid';
const sign = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');

function readUid(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  const [uid, sig] = decodeURIComponent(raw?.slice(COOKIE.length + 1) || '').split('.');
  if (!uid || !sig) return null;
  const expected = Buffer.from(sign(uid));
  const presented = Buffer.from(sig);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented) ? uid : null;
}

function withUser(req, res, next) {
  let uid = readUid(req);
  if (!uid || !store.users[uid]) {
    uid = uid || crypto.randomBytes(12).toString('hex');
    store.users[uid] = { id: uid, created: Date.now(), agent: null, notifications: [], activity: [] };
    save();
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${uid}.${sign(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  req.user = store.users[uid];
  next();
}

function requireAgent(req, res, next) {
  if (!req.user.agent?.instanceId) {
    return res.status(404).json({ error: { code: 'no_agent', message: 'Create your agent first.' } });
  }
  req.instanceId = req.user.agent.instanceId;
  next();
}

// ---- upstream helpers (copied from hermes-chat) ----

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

async function agent37(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headersFor(url), ...init.headers } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body };
}

// For calls this server makes on its own behalf: throws the normalized error.
async function call(url, init) {
  const { res, body } = await agent37(url, init);
  if (!res.ok) {
    const norm = normalizeError(res.status, body);
    throw Object.assign(new Error(norm.body.error.message), { status: norm.status, body: norm.body });
  }
  return body;
}

function sendError(res, err) {
  if (err?.body) return res.status(err.status).json(err.body);
  res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
}

async function forwardJson(res, url, init = {}) {
  try {
    const { res: upstream, body } = await agent37(url, init);
    if (!upstream.ok) {
      const norm = normalizeError(upstream.status, body);
      return res.status(norm.status).json(norm.body);
    }
    res.status(upstream.status).json(body);
  } catch (err) {
    sendError(res, err);
  }
}

// Pipe an upstream SSE response through untouched. The browser cannot call the instance
// directly: EventSource cannot POST or send custom headers like X-Agent37-Key, and a fetch
// from the page would expose the key. `onChunk` lets the caller peek at frames as they pass.
async function forwardSse(req, res, url, init = {}, onChunk) {
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
      headers: { ...headersFor(url), Accept: 'text/event-stream', ...init.headers },
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
      onChunk?.(chunk);
      res.write(chunk);
    }
  } catch {
    // Client navigated away or upstream dropped; either way there is nothing left to send.
  }
  res.end();
}

const hosting = (id, pathname = '') => `${API_BASE}/v1/instances/${id}${pathname}`;
const instanceUrl = (id, pathname) => `https://${id}.${APP_DOMAIN}${pathname}`;
const fileUrl = (id, filePath) => instanceUrl(id, `/v1/files/content?path=${encodeURIComponent(filePath)}`);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// A missing file is an empty file here: USER.md and MEMORY.md do not exist until the agent
// (or the app) writes the first entry.
async function readFile(id, filePath) {
  const res = await fetch(fileUrl(id, filePath), { headers: { 'X-Agent37-Key': API_KEY } });
  if (res.status === 404) return '';
  if (!res.ok) throw Object.assign(new Error('read failed'), normalizeError(res.status, await res.json().catch(() => null)));
  return res.text();
}

// `modified` guards the write: the gateway compares it to the file's mtime exactly, so pass
// back the value a list returned untouched (it has a fractional part). It is ignored when the
// file does not exist, so a write that means "create" says so with overwrite=false instead.
async function writeFile(id, filePath, content, modified, { overwrite = true } = {}) {
  return call(`${fileUrl(id, filePath)}${overwrite ? '' : '&overwrite=false'}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(modified ? { 'X-Expected-Mtime': String(modified) } : {}) },
    body: content,
  });
}

// ---- persona: SOUL.md, written read-merge-write ----
//
// PUT replaces the whole file, so the app owns one marked block and keeps everything
// around it. The stock opener names the agent "Hermes Agent", which would fight the name
// the user picked, so that one sentence goes; the house style rules after it stay.

function personaBlock(user) {
  const { name, userName } = user.agent;
  const you = userName || 'your person';
  const timezone = user.agent.timezone || 'UTC';
  return [
    PERSONA_START,
    `# ${name}`,
    '',
    `You are ${name}, ${you}'s personal agent in the Dots app. You have your own computer (this one), and it is always there, even while ${you} is away. Talk like a thoughtful friend who texts: warm, short, plain words, no headings in chat replies.`,
    '',
    `## You own ongoing responsibilities`,
    `When ${you} hands you something ongoing (keep an eye on X, remind me, every morning, follow up on Y), it becomes yours until it is done:`,
    `1. Keep it on your list: one line per responsibility in ${RESPONSIBILITIES_PATH}, formatted "- Title :: what you are doing now". The app shows this list to ${you}. Update the part after "::" as things change, and delete the line when the responsibility is finished.`,
    `2. Keep your own schedule. You can follow up after a reply ends: schedule your next check-in with the agent37 CLI, for example agent37 cron add --name "Watch flight prices" --schedule "0 9 * * *" --timezone ${timezone} --prompt "..."`,
    `   ${you}'s timezone is ${timezone}: pass --timezone ${timezone} on every cron and work out its times there (TZ=${timezone} date). Each check-in wakes you in a fresh chat that holds only its prompt, so write the prompt to stand on its own: what to check, where your notes are, and when to message ${you}. Choose the pace yourself and slow down when nothing is changing. For a one-time follow-up, pin the exact minute, hour, day and month (like "30 14 2 10 *"); the app deletes a cron pinned to one date once it has fired, so you never have to. For one that should repeat every year, like a birthday, start its --name with "Yearly". Use agent37 cron update <id> to change pace. Never use crontab, at, or sleep loops: they stop when this computer sleeps.`,
    `   Tell ${you} in one short line what you scheduled. The note that you cannot follow up after a reply ends is about that single reply; a scheduled check-in is how you do follow up.`,
    `3. Message first. When a check-in finds something ${you} should know (progress, a question, a decision), send it with: sh ${NOTIFY_PATH} "your message"`,
    `   ${you} is not watching check-in chats (yours, or tasks they set up in the app), so this is the only way they hear from you. One short message, written to be read cold. Stay quiet when there is nothing new.`,
    '',
    '## Files you make',
    OUTPUTS_BRIEF,
    '',
    `## Hand back what is not yours to do`,
    `Ask first before anything that spends money, sends something to other people on ${you}'s behalf, or changes an account (passwords, settings, deletions). You never make purchases: find the options, then hand the decision and the checkout back to ${you}.`,
    ...(user.agent.desktop ? ['', ...desktopBlock(you)] : []),
    PERSONA_END,
  ].join('\n');
}

function desktopBlock(you) {
  return [
    '## Your screen is live in the app',
    `The app shows your screen live beside this chat, and ${you} can take over the mouse and keyboard at any time. Your browser tool drives the browser on that screen, so browse there and ${you} can follow along.`,
    `When a site needs ${you} (a sign-in, a code sent to their phone, a CAPTCHA), stop and ask them to take over and hand it back when they are done. Never ask for a password in chat. A login they finish there stays signed in for next time.`,
  ];
}

async function writeSoul(user) {
  const id = user.agent.instanceId;
  const current = await readFile(id, SOUL_PATH);
  const start = current.indexOf(PERSONA_START);
  const end = current.indexOf(PERSONA_END);
  const rest = (start !== -1 && end > start ? current.slice(0, start) + current.slice(end + PERSONA_END.length) : current)
    .replace(/^\s*You are Hermes Agent, built by Nous Research\.\s*/, '')
    .trim();
  await writeFile(id, SOUL_PATH, `${personaBlock(user)}\n\n${rest}\n`);
}

// The agent's way back to you. JSON-encoding in node keeps quotes and newlines in the
// message from breaking the curl body, which is where hand-written curl calls go wrong, and
// a literal \n (which sh leaves alone inside double quotes) becomes a line break.
function notifyScript() {
  return [
    '#!/bin/sh',
    '# Message your person through the Dots app: sh ~/.dots/notify "text" ["title"]',
    'body=$(node -e \'const [text = "", title = ""] = process.argv.slice(1).map((s) => s.replace(/\\\\n/g, "\\n")); process.stdout.write(JSON.stringify({ instance_id: process.env.AGENT37_INSTANCE_ID, text, title }))\' "$1" "$2")',
    `curl -sS -X POST ${PUBLIC_URL}/api/notify -H "Authorization: Bearer $DOTS_CALLBACK_TOKEN" -H "Content-Type: application/json" -d "$body"`,
    'echo',
    '',
  ].join('\n');
}

// Memory files hold entries separated by a line with a single section sign, and Hermes caps
// USER.md at 1,375 characters. Seed only what the user told the app.
function userSeed(user) {
  const { userName, timezone } = user.agent;
  return [userName && `Their name is ${userName}.`, timezone && `Their timezone is ${timezone}.`].filter(Boolean).join('\n§\n');
}

async function setupAgent(user) {
  const id = user.agent.instanceId;
  await writeSoul(user);
  await writeFile(id, NOTIFY_PATH, notifyScript());
  if (!(await readFile(id, RESPONSIBILITIES_PATH))) await writeFile(id, RESPONSIBILITIES_PATH, '');
  if (!(await readFile(id, MEMORY_PATHS.user)).trim() && userSeed(user)) await writeFile(id, MEMORY_PATHS.user, userSeed(user));
  user.agent.setupUrl = PUBLIC_URL;
  save();
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

// ---- messages you first: the one route the agent calls ----
//
// Authenticated by the callback token, not the cookie: the caller is the agent, curling
// from inside its instance. The token's hash lives in the instance metadata (see create),
// so the check needs no state here beyond "which visitor owns this instance".

app.post('/api/notify', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const instanceId = req.body?.instance_id;
  const text = clip(req.body?.text, 2000);
  if (!token || !INSTANCE_ID.test(instanceId || '') || !text) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Send Authorization: Bearer <token> and JSON { "instance_id", "text" }.' } });
  }
  const forbidden = () => res.status(403).json({ error: { code: 'forbidden', message: 'The callback token does not match this instance.' } });
  // Owner first: an id no visitor here owns never reaches the Hosting API, so a stranger can
  // neither probe which ids exist in the workspace nor spend calls on the key.
  const user = userByInstance(instanceId);
  if (!user) return forbidden();
  let instance;
  try {
    instance = await call(hosting(instanceId));
  } catch (err) {
    return sendError(res, err);
  }
  // Compare as buffers, guarded on byte length: timingSafeEqual throws on a length mismatch.
  const expected = Buffer.from(String(instance?.metadata?.dots_callback_token_sha256 ?? ''));
  const presented = Buffer.from(sha256(token));
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) return forbidden();
  user.notifications.push({ id: crypto.randomBytes(6).toString('hex'), text, title: clip(req.body?.title, 120), at: Date.now(), read: false });
  user.notifications = user.notifications.slice(-100);
  save();
  res.json({ ok: true, delivered: true });
  // A check-in is what calls this, so its cron has just fired: tidy the schedule now.
  tidyCrons(user);
});

app.use('/api', withUser);

// ---- your agent: create, set up, edit, reset ----

function publicAgent(user) {
  const agent = user.agent;
  if (!agent) return null;
  const { name, mascot, accent, userName, timezone, paused, setupDone, desktop } = agent;
  return { name, mascot, accent, userName, timezone, paused: Boolean(paused), setupDone: Boolean(setupDone), computer: Boolean(desktop) };
}

app.get('/api/me', async (req, res) => {
  const agent = publicAgent(req.user);
  let status = null;
  if (agent) {
    // A Hosting API read never wakes the instance or resets its idle timer, so this is
    // safe to call on every page load.
    try {
      status = (await call(hosting(req.user.agent.instanceId))).status;
    } catch (err) {
      if (err?.status === 404) status = 'deleted';
    }
    // The notify script carries PUBLIC_URL. A new tunnel URL means rewriting it.
    if (req.user.agent.setupDone && req.user.agent.setupUrl !== PUBLIC_URL) setupAgent(req.user).catch(() => {});
  }
  res.json({ agent, status, unread: req.user.notifications.filter((n) => !n.read).length });
});

const MASCOTS = ['bean', 'puff', 'drop', 'pebble', 'sprout', 'dot'];
const ACCENT = /^#[0-9a-f]{6}$/i;

const creating = new Set();

app.post('/api/agent', async (req, res) => {
  if (req.user.agent?.instanceId || creating.has(req.user.id)) {
    return res.status(409).json({ error: { code: 'agent_exists', message: 'You already have an agent. Reset it first.' } });
  }
  const name = clip(req.body?.name, 24) || 'Pip';
  const mascot = MASCOTS.includes(req.body?.mascot) ? req.body.mascot : MASCOTS[0];
  const accent = ACCENT.test(req.body?.accent || '') ? req.body.accent : '#00b1ff';
  const timezone = clip(req.body?.timezone, 64);
  // The callback token pins "may message this user" to "was created by this app": the
  // agent presents the raw token from its env, /api/notify compares its hash to the one in
  // metadata. env is write-only and immutable, so rotating it means a new instance.
  const token = crypto.randomBytes(24).toString('hex');
  creating.add(req.user.id);
  try {
    const instance = await call(`${API_BASE}/v1/instances`, {
      method: 'POST',
      body: JSON.stringify({
        name: `dots-${name}`.slice(0, 60),
        user: req.user.id,
        // The desktop image is the stock Hermes image plus a live screen on port 6901.
        ...(DESKTOP_TEMPLATE ? { template: DESKTOP_TEMPLATE } : {}),
        // A monthly cap, not one-time credit: this agent works on its own schedule for as
        // long as it exists. Without a budget every managed LLM call is refused with 402.
        budget: { monthly_cap_micros: 5_000_000 },
        // Asleep it bills disk alone, and crons and messages wake it. The idle timeout
        // outlasts a long turn: a turn whose browser went away can be checkpointed mid-run.
        auto_sleep: true,
        idle_timeout_seconds: 1800,
        env: { DOTS_CALLBACK_TOKEN: token },
        metadata: { dots_callback_token_sha256: sha256(token) },
      }),
    });
    req.user.agent = { instanceId: instance.id, name, mascot, accent, userName: clip(req.body?.userName, 40), timezone, desktop: Boolean(DESKTOP_TEMPLATE), appCronIds: [], pausedCronIds: [], created: Date.now() };
    req.user.threads = [];
    req.user.notifications = [];
    req.user.activity = [];
    save();
    res.status(201).json({ agent: publicAgent(req.user), status: instance.status });
  } catch (err) {
    sendError(res, err);
  } finally {
    creating.delete(req.user.id);
  }
});

// "running" means the computer is up, not that the agent inside has finished booting.
app.get('/api/agent/ready', requireAgent, async (req, res) => {
  try {
    const upstream = await fetch(instanceUrl(req.instanceId, '/v1/health'), { headers: AGENT_HEADERS, signal: AbortSignal.timeout(8000) });
    const body = upstream.ok ? await upstream.json().catch(() => null) : null;
    res.json({ ready: body?.healthy === true });
  } catch {
    res.json({ ready: false });
  }
});

app.post('/api/agent/setup', requireAgent, async (req, res) => {
  try {
    await setupAgent(req.user);
    req.user.agent.setupDone = true;
    save();
    res.json({ agent: publicAgent(req.user) });
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/agent', requireAgent, async (req, res) => {
  const agent = req.user.agent;
  if (req.body?.name !== undefined) agent.name = clip(req.body.name, 24) || agent.name;
  if (MASCOTS.includes(req.body?.mascot)) agent.mascot = req.body.mascot;
  if (ACCENT.test(req.body?.accent || '')) agent.accent = req.body.accent;
  save();
  try {
    if (req.body?.name !== undefined) await writeSoul(req.user);
    res.json({ agent: publicAgent(req.user) });
  } catch (err) {
    sendError(res, err);
  }
});

// Reset is delete plus a fresh create from the onboarding screen. Delete is permanent:
// files, memory, sessions and crons go with the instance.
app.delete('/api/agent', requireAgent, async (req, res) => {
  try {
    await call(hosting(req.instanceId), { method: 'DELETE' });
  } catch (err) {
    if (err?.status !== 404) return sendError(res, err);
  }
  Object.assign(req.user, { agent: null, threads: [], notifications: [], activity: [] });
  save();
  res.json({ reset: true });
});

// Pause stops the agent keeping its own schedule: every enabled cron is disabled, and
// Resume turns back on exactly the ones Pause turned off. Chat still works while paused, so
// the agent can still add a cron; listCrons turns those off too, after every turn.
app.post('/api/agent/pause', requireAgent, async (req, res) => {
  req.user.agent.paused = true;
  try {
    await listCrons(req.user);
    res.json({ paused: true });
  } catch (err) {
    req.user.agent.paused = false;
    sendError(res, err);
  }
  save();
});

app.post('/api/agent/resume', requireAgent, async (req, res) => {
  req.user.agent.paused = false;
  try {
    const { data } = await call(hosting(req.instanceId, '/crons'));
    const ids = new Set(req.user.agent.pausedCronIds || []);
    const toResume = data.filter((cron) => ids.has(cron.id) && !cron.enabled);
    await Promise.all(toResume.map((cron) => call(hosting(req.instanceId, `/crons/${cron.id}`), { method: 'PATCH', body: JSON.stringify({ enabled: true }) })));
    req.user.agent.pausedCronIds = [];
    res.json({ paused: false });
  } catch (err) {
    req.user.agent.paused = true;
    sendError(res, err);
  }
  save();
});

// ---- connect apps: managed Composio on the user's own instance ----

app.get('/api/apps', requireAgent, (req, res) => {
  const params = new URLSearchParams({ limit: '24' });
  const search = clip(req.query.search, 60);
  if (search.length >= 3) params.set('search', search);
  forwardJson(res, hosting(req.instanceId, `/integrations/toolkits?${params}`));
});

app.get('/api/apps/connections', requireAgent, (req, res) => forwardJson(res, hosting(req.instanceId, '/integrations/connections')));

app.post('/api/apps/connect', requireAgent, (req, res) => {
  const toolkit = clip(req.body?.toolkit, 60);
  if (!/^[a-z0-9_-]+$/.test(toolkit)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad toolkit.' } });
  // callbackUrl must be https; a plain-http PUBLIC_URL falls back to Composio's own page.
  const body = { toolkit, ...(PUBLIC_URL.startsWith('https://') ? { callbackUrl: `${PUBLIC_URL}/connected.html?toolkit=${toolkit}` } : {}) };
  forwardJson(res, hosting(req.instanceId, '/integrations/connect'), { method: 'POST', body: JSON.stringify(body) });
});

app.delete('/api/apps/connections/:accountId', requireAgent, (req, res) => {
  if (!ACCOUNT_ID.test(req.params.accountId)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad account id.' } });
  forwardJson(res, hosting(req.instanceId, `/integrations/connections/${req.params.accountId}`), { method: 'DELETE' });
});

// ---- chat: one ongoing conversation per agent ----

function chatSession(user) {
  // Older versions offered multiple chats. Continue the original conversation, keeping
  // the old index and every session intact. Scheduled runs have their own sessions.
  if (!user.agent.chatSessionId && user.threads?.length) {
    user.agent.chatSessionId = user.threads[0].sessionId;
    save();
  }
  return user.agent.chatSessionId || null;
}

app.get('/api/chat', requireAgent, (req, res) => res.json({ session_id: chatSession(req.user) }));

app.get('/api/sessions/:sid', requireAgent, (req, res) => {
  if (!HEX32.test(req.params.sid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad session id.' } });
  forwardJson(res, instanceUrl(req.instanceId, `/v1/sessions/${req.params.sid}`));
});

// The hidden first turn. Dots introduces itself before you say anything; this brief is what
// asks it to, and the chat view never shows it.
function introBrief(user) {
  return [
    `This is your very first conversation with ${user.agent.userName || 'your person'}. They just created you and named you ${user.agent.name}.`,
    'Introduce yourself in two or three short sentences, in your own voice.',
    'If any apps are connected, take a quick read-only look to learn what their days look like. Do not send, change or schedule anything yet.',
    'Then suggest three concrete things you could take off their plate, at least one of them ongoing (something you would keep an eye on and check in on by yourself). Ask which they want.',
  ].join('\n');
}

// The user took over its computer and handed it back since the last turn.
const TOOK_OVER = 'Your person took over your computer since your last turn and has handed it back. The browser may be on another page or newly signed in: look at it before you carry on.';

// Messages the agent sent first came from a check-in chat, so a reply here would lack them.
function replyContext(user, ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const picked = user.notifications.filter((n) => wanted.has(n.id)).slice(-5);
  if (!picked.length) return '';
  return ['Earlier you messaged your person first:', ...picked.map((n) => `- ${n.text}`), 'The message below is their reply.'].join('\n');
}

const chatting = new Set();

app.post('/api/responses', requireAgent, async (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  // The server owns the conversation id, including for old tabs that still send one.
  const sessionId = chatSession(req.user);
  const intro = req.body?.intro === true && !sessionId;
  if (chatting.has(req.user.id)) return res.status(409).json({ error: { code: 'session_busy', message: 'It is still working on your last message.' } });
  if (!input && !intro) return res.status(400).json({ error: { code: 'invalid_request', message: 'Say something first.' } });
  const context = [OUTPUTS_BRIEF, intro ? introBrief(req.user) : replyContext(req.user, req.body?.replying_to), req.body?.took_over === true ? TOOK_OVER : '']
    .filter(Boolean)
    .join('\n\n');
  // App context rides as a marked preamble; the gateway has no system-prompt field.
  const payload = { input: context ? `${APP_CONTEXT}\n${context}\n${APP_CONTEXT_END}\n\n${input}` : input, stream: true, ...(sessionId ? { session_id: sessionId } : {}) };
  let seen = '';
  const recordSession = sessionId
    ? null
    : (chunk) => {
        if (seen === null) return;
        seen += Buffer.from(chunk).toString('utf8');
        const match = seen.match(/"session_id"\s*:\s*"([a-f0-9]{32})"/);
        if (!match) return;
        seen = null;
        req.user.agent.chatSessionId = match[1];
        save();
      };
  // Two tabs finishing onboarding together must not create two first conversations.
  chatting.add(req.user.id);
  try {
    await forwardSse(req, res, instanceUrl(req.instanceId, '/v1/responses'), { method: 'POST', body: JSON.stringify(payload) }, recordSession);
  } finally {
    chatting.delete(req.user.id);
    tidyCrons(req.user);
  }
});

app.get('/api/responses/:rid/stream', requireAgent, (req, res) => {
  if (!HEX32.test(req.params.rid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad response id.' } });
  forwardSse(req, res, instanceUrl(req.instanceId, `/v1/responses/${req.params.rid}/stream`)).then(() => tidyCrons(req.user));
});

app.post('/api/responses/:rid/cancel', requireAgent, (req, res) => {
  if (!HEX32.test(req.params.rid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad response id.' } });
  forwardJson(res, instanceUrl(req.instanceId, `/v1/responses/${req.params.rid}/cancel`), { method: 'POST' });
});

// ---- activity: what the agent did, reported by the browser when a turn ends ----

app.get('/api/activity', requireAgent, (req, res) => res.json({ data: [...req.user.activity].reverse() }));

app.post('/api/activity', requireAgent, (req, res) => {
  const entry = { title: clip(req.body?.title, 80), status: clip(req.body?.status, 80), icon: clip(req.body?.icon, 8), at: Date.now() };
  if (!entry.title) return res.status(400).json({ error: { code: 'invalid_request', message: 'Missing title.' } });
  req.user.activity = [...req.user.activity, entry].slice(-40);
  save();
  res.json(entry);
});

// ---- the profile: In progress / Scheduled / Completed ----
//
// The agent schedules itself with a CLI the app does not control, so every read of the
// schedule also tidies it (and so does every turn, and every message it sends first):
//   - There is no one-shot cron. A reminder is a cron pinned to one date, which would fire
//     again a year later, so once it has fired the app deletes it. Delete takes its runs with
//     it, so they are kept first, for Completed. SOUL.md has the agent start a yearly one's
//     name with "Yearly", and tasks the user set up are theirs to delete.
//   - While paused, a cron the agent adds or turns back on is turned off again.
//   - On a workspace template (the desktop one), a cron with no `agent` still fires on Hermes,
//     but its runs record no session, so Completed could not open them. Crons the app creates
//     name Hermes; the CLI cannot, so the app names it on the ones the agent created.

const cronName = (cron) => cron.name || cron.prompt.slice(0, 60);

function firedReminder(cron, agent) {
  const [minute, hour, day, month, weekday] = cron.schedule.trim().split(/\s+/);
  const pinned = [minute, hour, day, month].every((field) => /^\d+$/.test(field)) && weekday === '*';
  return pinned && Boolean(cron.last_run) && !/^yearly\b/i.test(cron.name || '') && !(agent.appCronIds || []).includes(cron.id);
}

async function retireCron(agent, cron) {
  const { data } = await call(hosting(agent.instanceId, `/crons/${cron.id}/runs`));
  const kept = agent.doneRuns || [];
  const fresh = data.filter((run) => !kept.some((k) => k.cron_id === cron.id && k.id === run.id));
  agent.doneRuns = [...kept, ...fresh.map((run) => ({ ...run, cron_id: cron.id, name: cronName(cron) }))].slice(-50);
  save();
  await call(hosting(agent.instanceId, `/crons/${cron.id}`), { method: 'DELETE' }).catch((err) => {
    if (err?.status !== 404) throw err;
  });
}

async function listCrons(user) {
  const agent = user.agent;
  const { data } = await call(hosting(agent.instanceId, '/crons'));
  const crons = await Promise.all(
    data.map(async (cron) => {
      if (firedReminder(cron, agent)) return retireCron(agent, cron).then(() => null);
      const patch = { ...(agent.desktop && !cron.agent ? { agent: 'hermes' } : {}), ...(agent.paused && cron.enabled ? { enabled: false } : {}) };
      if (!Object.keys(patch).length) return cron;
      const updated = await call(hosting(agent.instanceId, `/crons/${cron.id}`), { method: 'PATCH', body: JSON.stringify(patch) });
      if (patch.enabled === false) agent.pausedCronIds = [...new Set([...(agent.pausedCronIds || []), cron.id])];
      return updated;
    })
  );
  save();
  return crons.filter(Boolean);
}

function tidyCrons(user) {
  if (user.agent) listCrons(user).catch(() => {});
}

// Every cron's latest runs plus the ones kept from deleted reminders, newest first. Each
// triggered run names the session it opened, which is where the agent's actual work lives.
async function allRuns(user, crons) {
  const lists = await Promise.all(
    crons.map(async (cron) => (await call(hosting(user.agent.instanceId, `/crons/${cron.id}/runs`))).data.map((run) => ({ ...run, cron_id: cron.id, name: cronName(cron) })))
  );
  return [...lists.flat(), ...(user.agent.doneRuns || [])].sort((a, b) => b.ran_at - a.ran_at);
}

app.get('/api/schedule', requireAgent, async (req, res) => {
  try {
    const data = await listCrons(req.user);
    const mine = new Set(req.user.agent.appCronIds || []);
    res.json({ data: data.map((cron) => ({ ...cron, set_by: mine.has(cron.id) ? 'you' : 'agent' })), paused: Boolean(req.user.agent.paused) });
  } catch (err) {
    sendError(res, err);
  }
});

// A cron sends its prompt verbatim, and nothing else tells the agent that nobody is
// watching that chat. Tasks set up in the app say so, and say how to reach the user.
function taskPrompt(user, task) {
  const you = user.agent.userName || 'Your person';
  return `${APP_CONTEXT}\nThis is a scheduled task ${you} set up in the Dots app. ${you} is not watching this chat: send what they should see with sh ${NOTIFY_PATH} "your message".\n${OUTPUTS_BRIEF}\n${APP_CONTEXT_END}\n\n${task}`;
}

app.post('/api/schedule', requireAgent, async (req, res) => {
  const task = clip(req.body?.prompt, 7000);
  const body = {
    name: clip(req.body?.name, 80) || clip(task, 60),
    prompt: taskPrompt(req.user, task),
    schedule: clip(req.body?.schedule, 100),
    timezone: clip(req.body?.timezone, 64) || 'UTC',
    ...(req.user.agent.desktop ? { agent: 'hermes' } : {}),
  };
  if (!task || !body.schedule) return res.status(400).json({ error: { code: 'invalid_request', message: 'A task needs what to do and when.' } });
  try {
    const cron = await call(hosting(req.instanceId, '/crons'), { method: 'POST', body: JSON.stringify(body) });
    req.user.agent.appCronIds = [...(req.user.agent.appCronIds || []), cron.id];
    save();
    res.status(201).json({ ...cron, set_by: 'you' });
  } catch (err) {
    sendError(res, err);
  }
});

function requireCronId(req, res, next) {
  if (!CRON_ID.test(req.params.cid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad schedule id.' } });
  next();
}

app.patch('/api/schedule/:cid', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.instanceId, `/crons/${req.params.cid}`), { method: 'PATCH', body: JSON.stringify({ enabled: req.body?.enabled === true }) })
);

app.delete('/api/schedule/:cid', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.instanceId, `/crons/${req.params.cid}`), { method: 'DELETE' })
);

app.post('/api/schedule/:cid/run', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.instanceId, `/crons/${req.params.cid}/run`), { method: 'POST' })
);

// Completed: every run, newest first.
app.get('/api/schedule/runs', requireAgent, async (req, res) => {
  try {
    res.json({ data: (await allRuns(req.user, await listCrons(req.user))).slice(0, 50) });
  } catch (err) {
    sendError(res, err);
  }
});

// In progress: the responsibilities the agent keeps in its own list, plus any check-in that
// fired in the last 15 minutes and is still running. Reading files and sessions goes to the
// instance URL, so this wakes a sleeping agent; the app calls it only when the profile or
// the Activity card opens.
app.get('/api/progress', requireAgent, async (req, res) => {
  try {
    const [text, crons] = await Promise.all([readFile(req.instanceId, RESPONSIBILITIES_PATH), listCrons(req.user)]);
    const responsibilities = text
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => {
        const [title, status] = line.slice(2).split('::');
        return { title: title.trim(), status: (status || '').trim() };
      });
    const recent = (await allRuns(req.user, crons)).filter((run) => run.session_id && run.ran_at * 1000 > Date.now() - 15 * 60_000).slice(0, 5);
    const sessions = await Promise.all(recent.map((run) => call(instanceUrl(req.instanceId, `/v1/sessions/${run.session_id}`))));
    const running = recent
      .map((run, i) => ({ name: run.name, session_id: run.session_id, response_id: sessions[i].active_response_id }))
      .filter((run) => run.response_id);
    res.json({ responsibilities, running });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- its computer: the live screen, for agents created from DESKTOP_TEMPLATE ----
//
// The browser gets a WebSocket URL for noVNC on port 6901, carrying a signed token for this
// visitor's own instance. The token grants full control (view-only is a setting in the page)
// and cannot be revoked, so it lives 60 seconds: it only has to be valid when the socket
// opens, and an open socket keeps working after it expires. Every reconnect mints a new one.

app.post('/api/computer', requireAgent, async (req, res) => {
  if (!req.user.agent.desktop) return res.status(404).json({ error: { code: 'no_computer', message: 'This agent was created without a desktop.' } });
  try {
    const { url } = await call(hosting(req.instanceId, '/signed-url'), { method: 'POST', body: JSON.stringify({ port: DESKTOP_PORT, ttl_seconds: 60 }) });
    const signed = new URL(url);
    res.json({ ws: `wss://${signed.host}/websockify?a37_token=${signed.searchParams.get('a37_token')}` });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- outputs: only regular files directly inside ~/outputs, never configuration files ----

async function listOutputs(id) {
  try {
    const home = await call(instanceUrl(id, '/v1/files'));
    if (!home.entries.some(entry => entry.name === 'outputs' && entry.type === 'directory')) return [];
    const listing = await call(instanceUrl(id, `/v1/files?${new URLSearchParams({ path: OUTPUTS_PATH })}`));
    return listing.entries.filter(entry => entry.type === 'file' && !entry.hidden)
      .map(({ name, size, modified }) => ({ name, size, modified }))
      .sort((a, b) => b.modified - a.modified);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

app.get('/api/outputs', requireAgent, async (req, res) => {
  try { res.json({ data: await listOutputs(req.instanceId) }); }
  catch (err) { sendError(res, err); }
});

app.get('/api/outputs/:name', requireAgent, async (req, res) => {
  const name = req.params.name;
  // Names only, with no traversal or hidden files. Symlinks are excluded by the listing.
  if (!name || name.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(name)) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid output file name.' } });
  }
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    if (!(await listOutputs(req.instanceId)).some(file => file.name === name)) {
      return res.status(404).json({ error: { code: 'file_not_found', message: 'That output is no longer available.' } });
    }
    const query = new URLSearchParams({ path: `${OUTPUTS_PATH}/${name}`, disposition: 'attachment' });
    const upstream = await fetch(instanceUrl(req.instanceId, `/v1/files/content?${query}`), { headers: AGENT_HEADERS, signal: controller.signal });
    if (!upstream.ok) {
      const norm = normalizeError(upstream.status, await upstream.json().catch(() => null));
      return res.status(norm.status).json(norm.body);
    }
    res.attachment(name).set({
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'no-store',
    });
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!controller.signal.aborted && !res.headersSent) sendError(res, err);
  }
});

// ---- memory: USER.md and MEMORY.md, which Dots itself never lets you see ----
//
// The editor saves with `modified` from the read: if the agent wrote the file in between,
// the write fails with 412 (or 409, for a file that did not exist yet) instead of silently
// dropping what it learned.

app.get('/api/memory', requireAgent, async (req, res) => {
  try {
    const { entries } = await call(instanceUrl(req.instanceId, `/v1/files?path=${encodeURIComponent('~/.hermes/memories')}`));
    const out = {};
    for (const [key, filePath] of Object.entries(MEMORY_PATHS)) {
      const entry = entries.find((e) => e.name === path.basename(filePath));
      out[key] = { content: entry ? await readFile(req.instanceId, filePath) : '', modified: entry?.modified ?? null };
    }
    res.json(out);
  } catch (err) {
    sendError(res, err);
  }
});

app.put('/api/memory/:which', requireAgent, async (req, res) => {
  const filePath = MEMORY_PATHS[req.params.which];
  if (!filePath || typeof req.body?.content !== 'string') return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad memory file.' } });
  const modified = Number.isFinite(req.body.modified) ? req.body.modified : null;
  try {
    const entry = await writeFile(req.instanceId, filePath, req.body.content, modified, { overwrite: modified !== null });
    res.json({ content: req.body.content, modified: entry.modified });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- notifications: what the agent sent first ----

app.get('/api/notifications', (req, res) => res.json({ data: req.user.notifications, unread: req.user.notifications.filter((n) => !n.read).length }));

app.post('/api/notifications/read', (req, res) => {
  for (const n of req.user.notifications) n.read = true;
  save();
  res.json({ unread: 0 });
});

const server = app.listen(PORT, () => {
  console.log(`Build your own Dots running at http://localhost:${PORT}`);
  console.log(`agents message you first via ${PUBLIC_URL}/api/notify`);
  if (DESKTOP_TEMPLATE) console.log(`new agents get a live computer from template ${DESKTOP_TEMPLATE}`);
});
// Instance creation is synchronous on the Agent37 side and can run for minutes on a cold
// host; without this, Node's default 5-minute request timeout kills the create just short
// of the API's own budget.
server.requestTimeout = 0;
server.headersTimeout = 0;
