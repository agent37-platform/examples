// muse server: a Muse-style personal agent app, and the only place the Agent37 key lives.
//
// Every visitor gets their own agent instance. The browser holds a signed cookie, never an
// instance id: the server maps the cookie to the visitor's instance in data/store.json and
// every /api/me route acts on that instance only. The sk_live_ key is workspace-scoped, so
// it never reaches the browser, and the agent never sees it either. Two upstreams:
//   - the Hosting API at AGENT37_API_BASE (instances, crons, integrations)
//   - each instance's own Agent API at https://{instanceId}.{AGENT37_APP_DOMAIN} (chat, files)
//
// What makes it Muse rather than a chat box lives in files on the agent's computer:
//   ~/.hermes/SOUL.md          persona plus the app's rules, written read-merge-write
//   ~/muse/ideas.json          written by a daily platform cron, rendered in the Ideas tab
//   ~/muse/goals.json          kept by the agent, one self-scheduled cron per check-in
//   ~/muse/library/            everything the agent makes, listed in the Library tab
//   ~/muse/notify.mjs          how the agent messages the user first (POST /api/notify)
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.AGENT37_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 3104);

if (!API_KEY) {
  console.error('Set AGENT37_API_KEY in .env (copy .env.example). Mint a key at https://www.agent37.com/dashboard/cloud/api-keys');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('Set SESSION_SECRET in .env to any long random string; it signs the visitor cookie.');
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.warn('PUBLIC_URL is empty: everything works except the agent messaging you first.');
  console.warn('For local dev run `cloudflared tunnel --url http://localhost:3104` and paste the https URL into .env.');
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(DIR, 'data', 'store.json');

const INSTANCE_ID = /^[a-z0-9]{10}$/;
const SESSION_ID = /^[a-f0-9]{32}$/;
const CRON_ID = /^[a-f0-9]{12}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TOOLKIT = /^[a-z0-9_-]{1,60}$/;
// One key, two planes, one header each: the Hosting API takes Authorization: Bearer, while
// instance URLs take the raw key as X-Agent37-Key.
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

const SOUL_PATH = '~/.hermes/SOUL.md';
const MEMORY_DIR = '~/.hermes/memories';
const IDEAS_PATH = '~/muse/ideas.json';
const GOALS_PATH = '~/muse/goals.json';
const LIBRARY_DIR = '~/muse/library';
const NOTIFY_PATH = '~/muse/notify.mjs';
// Hermes keeps each memory file as entries joined by this delimiter, under a character cap.
const MEMORY_FILES = {
  memory: { name: 'MEMORY.md', limit: 2200 },
  user: { name: 'USER.md', limit: 1375 },
};
const ENTRY_DELIMITER = '\n§\n';
const SOUL_BEGIN = '<!-- muse:begin -->';
const SOUL_END = '<!-- muse:end -->';

const TONES = {
  warm: 'warm and encouraging, like a thoughtful friend',
  casual: 'casual and playful, short messages, the way friends text',
  concise: 'brief and to the point, no filler',
  funny: 'witty, with a light sense of humor, never at the expense of getting things done',
};
const AVATARS = ['sky', 'peach', 'mint', 'lilac'];

// ---- store: one JSON file, demo-grade (swap in your database) ----

const store = loadStore();

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { users: {} };
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(`${STORE_PATH}.tmp`, JSON.stringify(store, null, 2));
  fs.renameSync(`${STORE_PATH}.tmp`, STORE_PATH);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hmac = (text) => crypto.createHmac('sha256', SESSION_SECRET).update(text).digest('hex');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ---- visitor identity: a signed cookie, nothing else (swap in real auth for production) ----

function identify(req, res, next) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((part) => part.trim().split('=')).filter(([key]) => key)
  );
  const [uid, mac] = (cookies.muse_uid || '').split('.');
  if (uid && mac && safeEqual(mac, hmac(uid))) {
    req.uid = uid;
  } else {
    req.uid = crypto.randomBytes(12).toString('hex');
    res.setHeader('Set-Cookie', `muse_uid=${req.uid}.${hmac(req.uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  req.user = store.users[req.uid];
  next();
}

function requireAgent(req, res, next) {
  if (req.user?.state !== 'ready' || !INSTANCE_ID.test(req.user.instanceId || '')) {
    return res.status(409).json({ error: { code: 'no_agent', message: 'Create your agent first.' } });
  }
  next();
}

// ---- upstream plumbing, copied from hermes-chat ----

function headersFor(url) {
  return url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
}

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

// Pipe an upstream SSE response through untouched. EventSource cannot POST or send custom
// headers like X-Agent37-Key, so the server relays the stream.
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

const hosting = (user, pathname) => `${API_BASE}/v1/instances/${user.instanceId}${pathname}`;
const agentApi = (user, pathname) => instanceUrl(user.instanceId, pathname);

// ---- files on the agent's computer (Files API) ----

async function readText(id, filePath) {
  const res = await fetch(instanceUrl(id, `/v1/files/content?${new URLSearchParams({ path: filePath })}`), { headers: AGENT_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Reading ${filePath} failed (HTTP ${res.status}).`);
  return res.text();
}

// PUT writes the raw body as the whole file, so every caller hands over the complete new
// contents. mtime, when given, makes the write fail with 412 if someone changed the file
// since it was read; overwrite=false makes a create fail with 409 if the file appeared.
async function writeText(id, filePath, text, { mtime, create } = {}) {
  const query = new URLSearchParams({ path: filePath, ...(create ? { overwrite: 'false' } : {}) });
  const res = await fetch(instanceUrl(id, `/v1/files/content?${query}`), {
    method: 'PUT',
    headers: { 'X-Agent37-Key': API_KEY, 'Content-Type': 'text/plain; charset=utf-8', ...(mtime ? { 'X-Expected-Mtime': String(mtime) } : {}) },
    body: text,
  });
  return res.status;
}

async function listDir(id, dirPath) {
  const { res, body } = await agent37(instanceUrl(id, `/v1/files?${new URLSearchParams({ path: dirPath })}`));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Listing ${dirPath} failed (HTTP ${res.status}).`);
  return body.entries;
}

async function readJson(id, filePath) {
  const text = await readText(id, filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
}

// ---- persona: the app owns one marked block of SOUL.md and leaves the rest alone ----

function soulBlock(user) {
  const { yourName, agentName, tagline, tone, timezone } = user.profile;
  return [
    SOUL_BEGIN,
    '# Who you are',
    `Your name is ${agentName}${tagline ? `: ${tagline}` : ''}. You are ${yourName}'s personal agent. Talk the way a friend texts: ${TONES[tone] || TONES.warm}. You have your own always-on computer with a browser, a terminal and files, so you do the work instead of explaining how. ${yourName}'s timezone is ${timezone}. Where anything else in this file gives you another name or tone, this block wins.`,
    '',
    '# The Muse app',
    `${yourName} talks to you through an app with four tabs: Chat, Ideas, Goals and Library. The app reads these files directly, so keep them valid JSON and current:`,
    '- ~/muse/ideas.json holds your ideas for things you could take off their plate: {"updated":"<ISO time>","ideas":[{"emoji":"<one emoji>","title":"I can ...","detail":"<one or two sentences on why, citing what you know>","prompt":"<the message that starts it, written as the user>"}]}. A daily scheduled run rewrites it; you can also update it whenever a good idea comes up.',
    '- ~/muse/goals.json holds what you track for them: {"goals":[{"id":"<short-slug>","kind":"tracking|goal","title":"...","detail":"<one line: status or plan>","progress":<0-100>,"next_check_in":"<ISO time or null>","cron_id":"<id or null>"}]}. kind "tracking" is watching something in the world (a price, a reservation, a delivery); kind "goal" is something they are working toward.',
    `- ~/muse/library/ is where everything you make for ${yourName} goes: documents (.md, .pdf, .csv), web pages as one self-contained .html file, images and audio. Use clear file names and mention the file in your reply.`,
    `When ${yourName} sets a goal or asks you to track something, add it to goals.json and schedule its check-ins yourself with agent37 cron (weekly for goals, daily at most for tracking), and store the cron id in cron_id. On each check-in, do the work, update progress, detail and next_check_in, and message them if there is news. When a goal is done or dropped, remove its cron.`,
    '',
    '# Following up later',
    `You can follow up after a response ends: schedule it yourself with agent37 cron add --name "<label>" --schedule "<five-field cron expression>" --timezone ${timezone} --prompt "<self-contained instructions for your future self>". Also agent37 cron list, agent37 cron update <id> --pause, agent37 cron remove <id>. Each run starts a fresh conversation with only that prompt, so put everything needed in it. For a one-time reminder, tell your future self to remove the cron after it runs (find the id with agent37 cron list). When you promise to check back, schedule it; never say you cannot follow up.`,
    '',
    `# Messaging ${yourName} first`,
    `Nobody reads your replies in scheduled runs. To reach ${yourName}, run: node ~/muse/notify.mjs "<short title>" "<one or two sentences>". Use it when a reminder is due, a check-in has news, or something needs their attention. Never for nothing.`,
    SOUL_END,
  ].join('\n');
}

async function writeSoul(user) {
  const current = (await readText(user.instanceId, SOUL_PATH)) ?? '';
  const start = current.indexOf(SOUL_BEGIN);
  const end = current.indexOf(SOUL_END);
  const next =
    start !== -1 && end > start
      ? current.slice(0, start) + soulBlock(user) + current.slice(end + SOUL_END.length)
      : `${soulBlock(user)}\n\n${current}`;
  const status = await writeText(user.instanceId, SOUL_PATH, next);
  if (status !== 200) throw new Error(`Writing SOUL.md failed (HTTP ${status}).`);
}

// The callback script carries the app URL, so a new tunnel URL only means rewriting this
// one file; the token it sends was planted in the instance env at create and never changes.
async function writeNotifyScript(user) {
  const script = PUBLIC_URL
    ? [
        '// Written by the Muse app. Usage: node ~/muse/notify.mjs "Title" "Body"',
        'const [title = "", body = ""] = process.argv.slice(2);',
        `const res = await fetch(${JSON.stringify(`${PUBLIC_URL}/api/notify`)}, {`,
        '  method: "POST",',
        '  headers: { Authorization: `Bearer ${process.env.MUSE_NOTIFY_TOKEN}`, "Content-Type": "application/json" },',
        '  body: JSON.stringify({ instance_id: process.env.AGENT37_INSTANCE_ID, title, body }),',
        '});',
        'console.log(res.status, await res.text());',
        '',
      ].join('\n')
    : 'console.log("Notifications are not set up: the app has no PUBLIC_URL."); process.exit(1);\n';
  const status = await writeText(user.instanceId, NOTIFY_PATH, script);
  if (status !== 200) throw new Error(`Writing notify.mjs failed (HTTP ${status}).`);
  user.notifyUrl = PUBLIC_URL;
  saveStore();
}

// ---- memory: read-merge-write against the agent's own files ----

async function readMemory(id, key) {
  const { name } = MEMORY_FILES[key];
  const entry = (await listDir(id, MEMORY_DIR)).find((file) => file.name === name);
  if (!entry) return { entries: [], mtime: null };
  const text = (await readText(id, `${MEMORY_DIR}/${name}`)) ?? '';
  const entries = text.split(ENTRY_DELIMITER).map((item) => item.trim()).filter(Boolean);
  return { entries, mtime: entry.modified };
}

// Re-read, apply the change to the current entries, write back guarded by the mtime just
// read. If the agent saved a memory in between, the write 412s and the loop re-applies the
// change on top of the agent's version, so neither side loses an entry.
async function mergeMemory(id, key, { edit, add }) {
  const { name, limit } = MEMORY_FILES[key];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { entries, mtime } = await readMemory(id, key);
    const next = [...entries];
    if (edit) {
      const index = next.indexOf(edit.from);
      if (index === -1) return { status: 404, message: 'That memory changed since you opened it. Reload and try again.' };
      if (edit.to.trim()) next[index] = edit.to.trim();
      else next.splice(index, 1);
    }
    if (add?.trim() && !next.includes(add.trim())) next.push(add.trim());
    const text = next.join(ENTRY_DELIMITER);
    if (text.length > limit) return { status: 400, message: `That goes over the ${limit}-character limit for ${name}. Shorten or remove an entry first.` };
    const status = await writeText(id, `${MEMORY_DIR}/${name}`, text, mtime ? { mtime } : { create: true });
    if (status === 200) return { status, entries: next };
    if (status !== 412 && status !== 409) return { status: 502, message: `Saving ${name} failed (HTTP ${status}).` };
  }
  return { status: 409, message: 'Your agent is busy updating its memory. Try again in a moment.' };
}

// ---- provisioning: create, wait for the agent, then set up the app's files and crons ----

const IDEAS_PROMPT = [
  'Daily ideas run, scheduled by the Muse app.',
  'Think about what you know about the user: your memory, recent conversations (session_search), their goals in ~/muse/goals.json, and any connected apps.',
  'Then replace ~/muse/ideas.json with 4 fresh, specific ideas for things you could take off their plate this week, in this exact format:',
  '{"updated":"<ISO time>","ideas":[{"emoji":"<one emoji>","title":"I can ...","detail":"<one or two sentences on why, citing what you know>","prompt":"<the message that starts it, written as the user>"}]}',
  'If you know little about them yet, suggest good first steps instead (connecting an app, setting a goal, a research task). Do not notify the user about this run.',
].join('\n');

async function createIdeasCron(user) {
  const { res, body } = await agent37(hosting(user, '/crons'), {
    method: 'POST',
    body: JSON.stringify({ name: 'Daily ideas', prompt: IDEAS_PROMPT, schedule: '0 8 * * *', timezone: user.profile.timezone }),
  });
  if (!res.ok) throw new Error(normalizeError(res.status, body).body.error.message);
  user.ideasCronId = body.id;
  saveStore();
  // First ideas now rather than at 8am tomorrow; the run is fire and forget.
  await agent37(hosting(user, `/crons/${body.id}/run`), { method: 'POST' });
}

const provisioning = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setState(user, state, error = null) {
  user.state = state;
  user.error = error;
  saveStore();
}

// "running" means the container is up, not that the agent inside has finished booting;
// poll the health probe until the harness answers healthy. A cold host can take minutes.
async function waitHealthy(id) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(instanceUrl(id, '/v1/health'), { headers: AGENT_HEADERS, signal: AbortSignal.timeout(8000) });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body?.healthy === true) return;
    } catch {}
    await delay(3000);
  }
  throw new Error('The agent did not finish booting within 10 minutes.');
}

async function provision(uid) {
  if (provisioning.has(uid)) return;
  provisioning.add(uid);
  const user = store.users[uid];
  try {
    if (!user.instanceId) {
      setState(user, 'creating');
      // The notify token pins "may message this user" to "is this user's agent": the raw
      // token goes into the container env (the agent's shell can read it), the server keeps
      // only its hash. env is write-only and immutable, so rotating it means a new instance.
      const token = crypto.randomBytes(24).toString('hex');
      const { res, body } = await agent37(`${API_BASE}/v1/instances`, {
        method: 'POST',
        body: JSON.stringify({
          name: `muse ${user.profile.agentName}`.slice(0, 60),
          user: uid,
          // A monthly allowance for managed LLM, search and app calls ($1 = 1,000,000
          // micros), the way Muse gives each user a weekly allowance. The default is $0,
          // which refuses every managed call. Raise it for paying users.
          budget: { monthly_cap_micros: 2_000_000 },
          // Asleep it bills disk alone; chat, the app's file reads and crons all wake it.
          // A 30-minute idle window keeps it awake through a conversation and a long task.
          auto_sleep: true,
          idle_timeout_seconds: 1800,
          env: { MUSE_NOTIFY_TOKEN: token },
        }),
      });
      if (!res.ok) throw new Error(normalizeError(res.status, body).body.error.message);
      user.instanceId = body.id;
      user.notifyTokenHash = sha256(token);
      saveStore();
    }
    setState(user, 'booting');
    await waitHealthy(user.instanceId);
    setState(user, 'setting_up');
    await writeSoul(user);
    await writeNotifyScript(user);
    await writeText(user.instanceId, GOALS_PATH, '{"goals":[]}\n', { create: true });
    await mergeMemory(user.instanceId, 'user', { add: `Name: ${user.profile.yourName}. Timezone: ${user.profile.timezone}.` });
    if (!user.ideasCronId) await createIdeasCron(user);
    setState(user, 'ready');
  } catch (err) {
    setState(user, 'failed', String(err?.message || err));
  } finally {
    provisioning.delete(uid);
  }
}

function publicProfile(user) {
  return {
    state: user?.state || 'new',
    error: user?.error || null,
    profile: user?.profile || null,
    main_session_id: user?.mainSessionId || null,
    notifications_enabled: Boolean(PUBLIC_URL),
  };
}

// Express 4 does not catch a rejected async handler (an unreachable instance, a failed
// read); answer 502 instead of letting the rejection take the process down.
const route = (fn) => (req, res, next) =>
  fn(req, res, next).catch((err) => {
    if (res.headersSent) return res.end();
    res.status(502).json({ error: { code: 'upstream_error', message: String(err?.message || err) } });
  });

const newSessionId = () => crypto.randomBytes(16).toString('hex');
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const app = express();
app.use(express.json());
app.use(express.static(path.join(DIR, 'public')));

// ---- the agent's callback: how it messages the user first ----
//
// The one route authenticated by a bearer token instead of the cookie: the caller is the
// agent, running node ~/muse/notify.mjs on its own computer. A real app would fan this out
// to Web Push, email or a messaging channel; this one keeps an in-app inbox.
app.post('/api/notify', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const instanceId = req.body?.instance_id;
  const user = INSTANCE_ID.test(instanceId || '') ? Object.values(store.users).find((u) => u.instanceId === instanceId) : null;
  if (!token || !user?.notifyTokenHash || !safeEqual(sha256(token), user.notifyTokenHash)) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'The token does not match this instance.' } });
  }
  const title = clean(req.body?.title, 120);
  const body = clean(req.body?.body, 2000);
  if (!title && !body) return res.status(400).json({ error: { code: 'invalid_request', message: 'Send a title or a body.' } });
  user.notifications = [...(user.notifications || []), { id: crypto.randomBytes(6).toString('hex'), title, body, created: Date.now(), read: false }].slice(-100);
  saveStore();
  res.json({ ok: true });
});

app.get('/connected', (req, res) => res.sendFile(path.join(DIR, 'public', 'connected.html')));

app.use('/api/me', identify);

// ---- the visitor and their agent ----

app.get('/api/me', (req, res) => {
  const user = req.user;
  // A server restart mid-setup leaves the provisioning loop dead; pick it back up.
  if (user && ['creating', 'booting', 'setting_up'].includes(user.state) && !provisioning.has(req.uid)) provision(req.uid);
  if (user?.state === 'ready' && user.notifyUrl !== PUBLIC_URL) writeNotifyScript(user).catch(() => {});
  res.json(publicProfile(user));
});

app.post('/api/me/agent', (req, res) => {
  if (req.user && req.user.state !== 'failed') return res.status(409).json({ error: { code: 'agent_exists', message: 'You already have an agent.' } });
  const yourName = clean(req.body?.your_name, 40);
  const agentName = clean(req.body?.agent_name, 30);
  const timezone = clean(req.body?.timezone, 60) || 'UTC';
  if (!yourName || !agentName) return res.status(400).json({ error: { code: 'invalid_request', message: 'Tell me your name and name your agent.' } });
  const user = (store.users[req.uid] ||= { created: Date.now(), notifications: [] });
  user.profile = {
    yourName,
    agentName,
    tagline: clean(req.body?.tagline, 60),
    tone: TONES[req.body?.tone] ? req.body.tone : 'warm',
    avatar: AVATARS.includes(req.body?.avatar) ? req.body.avatar : 'sky',
    timezone,
  };
  user.mainSessionId ||= newSessionId();
  user.threads ||= [];
  setState(user, 'creating');
  provision(req.uid);
  res.status(202).json(publicProfile(user));
});

// Reset: delete the computer and everything on it, then start over from onboarding.
app.delete('/api/me/agent', route(async (req, res) => {
  if (!req.user || provisioning.has(req.uid)) return res.status(409).json({ error: { code: 'invalid_request', message: 'Nothing to reset right now.' } });
  if (req.user.instanceId) {
    const { res: upstream, body } = await agent37(`${API_BASE}/v1/instances/${req.user.instanceId}`, { method: 'DELETE' });
    if (!upstream.ok && upstream.status !== 404) {
      const norm = normalizeError(upstream.status, body);
      return res.status(norm.status).json(norm.body);
    }
  }
  delete store.users[req.uid];
  saveStore();
  res.json({ deleted: true });
}));

// Hermes builds a session's system prompt, SOUL.md included, on its first turn and reuses it
// for the rest of the session. So a persona change moves the main chat to a fresh session,
// and the old one stays in the thread index as an earlier chat.
app.patch('/api/me/profile', requireAgent, route(async (req, res) => {
  const user = req.user;
  const before = soulBlock(user);
  const profile = user.profile;
  if (clean(req.body?.agent_name, 30)) profile.agentName = clean(req.body.agent_name, 30);
  if (typeof req.body?.tagline === 'string') profile.tagline = clean(req.body.tagline, 60);
  if (TONES[req.body?.tone]) profile.tone = req.body.tone;
  if (AVATARS.includes(req.body?.avatar)) profile.avatar = req.body.avatar;
  saveStore();
  if (soulBlock(user) === before) return res.json(publicProfile(user));
  await writeSoul(user);
  const { res: upstream, body } = await agent37(agentApi(user, `/v1/sessions/${user.mainSessionId}`));
  if (upstream.ok && (body.history?.length || body.active_response_id)) {
    user.threads.unshift({ id: user.mainSessionId, created: Date.now() });
    user.mainSessionId = newSessionId();
    saveStore();
  }
  res.json(publicProfile(user));
}));

app.get('/api/me/soul', requireAgent, route(async (req, res) => {
  res.json({ text: (await readText(req.user.instanceId, SOUL_PATH)) ?? '' });
}));

// ---- chat: the main chat plus side chats, each a session on the visitor's instance ----
//
// The app keeps its own thread index: GET /v1/sessions returns only the 100 most recent
// sessions, and every cron firing opens one, so it cannot be the list of the user's chats.
// Session ids are minted here, and Hermes starts a session under an id it has not seen.

app.get('/api/me/threads', requireAgent, route(async (req, res) => {
  const { res: upstream, body } = await agent37(agentApi(req.user, '/v1/sessions'));
  const known = new Map((upstream.ok ? body.data : []).map((session) => [session.id, session]));
  const threads = [{ id: req.user.mainSessionId, main: true, created: req.user.created }, ...req.user.threads].map((thread) => {
    const session = known.get(thread.id);
    return { ...thread, title: session?.title || session?.preview || null, last_active: session?.last_active ?? thread.created };
  });
  res.json({ data: threads });
}));

app.post('/api/me/threads', requireAgent, (req, res) => {
  const thread = { id: newSessionId(), created: Date.now() };
  req.user.threads.unshift(thread);
  saveStore();
  res.status(201).json(thread);
});

app.delete('/api/me/threads/:sid', requireAgent, route(async (req, res) => {
  if (!req.user.threads.some((thread) => thread.id === req.params.sid)) {
    return res.status(404).json({ error: { code: 'not_found', message: 'No such side chat.' } });
  }
  await agent37(agentApi(req.user, `/v1/sessions/${req.params.sid}`), { method: 'DELETE' });
  req.user.threads = req.user.threads.filter((thread) => thread.id !== req.params.sid);
  saveStore();
  res.json({ id: req.params.sid, deleted: true });
}));

function requireSessionId(req, res, next) {
  if (!SESSION_ID.test(req.params.sid || '')) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad session id.' } });
  next();
}

app.get('/api/me/sessions/:sid', requireAgent, requireSessionId, (req, res) =>
  forwardJson(res, agentApi(req.user, `/v1/sessions/${req.params.sid}`))
);

app.post('/api/me/responses', requireAgent, (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  const sessionId = req.body?.session_id;
  if (!input || !SESSION_ID.test(sessionId || '')) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Send { input, session_id }.' } });
  }
  forwardSse(req, res, agentApi(req.user, '/v1/responses'), {
    method: 'POST',
    body: JSON.stringify({ input, session_id: sessionId, stream: true }),
  });
});

app.get('/api/me/responses/:rid/stream', requireAgent, (req, res) =>
  forwardSse(req, res, agentApi(req.user, `/v1/responses/${encodeURIComponent(req.params.rid)}/stream`))
);

app.post('/api/me/responses/:rid/cancel', requireAgent, (req, res) =>
  forwardJson(res, agentApi(req.user, `/v1/responses/${encodeURIComponent(req.params.rid)}/cancel`), { method: 'POST' })
);

// ---- notifications the agent sent (see /api/notify); read from the store, never the instance ----

app.get('/api/me/notifications', (req, res) => res.json({ data: req.user?.notifications || [] }));

app.post('/api/me/notifications/read', (req, res) => {
  for (const item of req.user?.notifications || []) item.read = true;
  saveStore();
  res.json({ ok: true });
});

// ---- Ideas, Goals, Library: files the agent keeps, read through the Files API ----

// "Updated" comes from the file's mtime, not the agent's own "updated" field: a model's idea
// of the current time is not something to render.
app.get('/api/me/ideas', requireAgent, route(async (req, res) => {
  const [doc, entries] = await Promise.all([readJson(req.user.instanceId, IDEAS_PATH), listDir(req.user.instanceId, '~/muse')]);
  res.json({
    ideas: Array.isArray(doc?.ideas) ? doc.ideas.slice(0, 12) : [],
    updated: entries.find((entry) => entry.name === 'ideas.json')?.modified ?? null,
    unreadable: Boolean(doc?.unreadable),
  });
}));

// The daily cron is an ordinary cron, so the user (in Upcoming) or the agent can delete it.
// A refresh that finds it gone puts it back, which also runs it once.
app.post('/api/me/ideas/refresh', requireAgent, route(async (req, res) => {
  const { res: upstream, body } = await agent37(hosting(req.user, `/crons/${req.user.ideasCronId}/run`), { method: 'POST' });
  if (upstream.status === 404) {
    await createIdeasCron(req.user);
    return res.status(202).json({ id: req.user.ideasCronId });
  }
  if (!upstream.ok) {
    const norm = normalizeError(upstream.status, body);
    return res.status(norm.status).json(norm.body);
  }
  res.status(upstream.status).json(body);
}));

app.get('/api/me/goals', requireAgent, route(async (req, res) => {
  const [doc, crons] = await Promise.all([readJson(req.user.instanceId, GOALS_PATH), agent37(hosting(req.user, '/crons'))]);
  const nextRun = new Map((crons.res.ok ? crons.body.data : []).map((cron) => [cron.id, cron.next_run]));
  const goals = (Array.isArray(doc?.goals) ? doc.goals : []).map((goal) => ({
    ...goal,
    next_run: nextRun.get(goal.cron_id) ?? null,
  }));
  res.json({ goals, unreadable: Boolean(doc?.unreadable) });
}));

app.get('/api/me/library', requireAgent, route(async (req, res) => {
  const top = await listDir(req.user.instanceId, LIBRARY_DIR);
  const nested = await Promise.all(
    top.filter((entry) => entry.type === 'directory' && !entry.hidden).slice(0, 10).map(async (dir) =>
      (await listDir(req.user.instanceId, `${LIBRARY_DIR}/${dir.name}`)).map((entry) => ({ ...entry, name: `${dir.name}/${entry.name}` }))
    )
  );
  const files = [...top, ...nested.flat()]
    .filter((entry) => entry.type === 'file' && !entry.hidden)
    .map(({ name, size, modified }) => ({ name, size, modified }))
    .sort((a, b) => b.modified - a.modified);
  res.json({ data: files });
}));

// Only names under ~/muse/library, never a raw path: ~/.hermes/config.yaml holds the
// instance's managed token, and the key behind this proxy can read any path.
const LIBRARY_NAME = /^[^/.][^/]{0,200}(\/[^/.][^/]{0,200})?$/;

app.get('/api/me/library/file', requireAgent, route(async (req, res) => {
  const name = String(req.query.name || '');
  if (!LIBRARY_NAME.test(name)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad file name.' } });
  const query = new URLSearchParams({ path: `${LIBRARY_DIR}/${name}`, disposition: req.query.download ? 'attachment' : 'inline' });
  const upstream = await fetch(agentApi(req.user, `/v1/files/content?${query}`), { headers: { 'X-Agent37-Key': API_KEY } });
  if (!upstream.ok) {
    const norm = normalizeError(upstream.status, await upstream.json().catch(() => null));
    return res.status(norm.status).json(norm.body);
  }
  // Agent-written HTML or SVG opened directly would otherwise run scripts on this origin.
  res.set({
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': upstream.headers.get('content-disposition') || 'inline',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}));

// ---- Memory: USER.md (about you) and MEMORY.md (the agent's notes) ----

app.get('/api/me/memory', requireAgent, route(async (req, res) => {
  const [memory, user] = await Promise.all([readMemory(req.user.instanceId, 'memory'), readMemory(req.user.instanceId, 'user')]);
  res.json({
    memory: { entries: memory.entries, limit: MEMORY_FILES.memory.limit },
    user: { entries: user.entries, limit: MEMORY_FILES.user.limit },
  });
}));

app.post('/api/me/memory', requireAgent, route(async (req, res) => {
  const key = req.body?.file;
  const edit = req.body?.edit;
  if (!MEMORY_FILES[key] || (edit && (typeof edit.from !== 'string' || typeof edit.to !== 'string'))) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Send { file: "memory" | "user", edit?: { from, to }, add? }.' } });
  }
  const result = await mergeMemory(req.user.instanceId, key, { edit, add: typeof req.body.add === 'string' ? req.body.add.slice(0, 1000) : '' });
  if (result.status !== 200) return res.status(result.status).json({ error: { code: 'memory_not_saved', message: result.message } });
  res.json({ entries: result.entries });
}));

// Export memories only. Never archive all of ~/.hermes: config.yaml and .env hold secrets.
app.get('/api/me/memory/export', requireAgent, route(async (req, res) => {
  const [memory, user] = await Promise.all([readMemory(req.user.instanceId, 'memory'), readMemory(req.user.instanceId, 'user')]);
  const section = (title, entries) => `## ${title}\n\n${entries.map((entry) => `- ${entry.replaceAll('\n', '\n  ')}`).join('\n') || '(empty)'}\n`;
  res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="muse-memories.md"' });
  res.send(`# ${req.user.profile.agentName}'s memories\n\nExported ${new Date().toISOString()}\n\n${section('About you (USER.md)', user.entries)}\n${section('Notes (MEMORY.md)', memory.entries)}`);
}));

// ---- Upcoming: platform crons on the visitor's instance (the agent's own show up too) ----

function requireCronId(req, res, next) {
  if (!CRON_ID.test(req.params.cid || '')) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad cron id.' } });
  next();
}

app.get('/api/me/crons', requireAgent, (req, res) => forwardJson(res, hosting(req.user, '/crons')));

// A reminder the user sets in the app is a cron whose prompt tells the agent to reach them.
app.post('/api/me/crons', requireAgent, (req, res) => {
  const text = clean(req.body?.text, 500);
  const schedule = clean(req.body?.schedule, 60);
  if (!text || !schedule) return res.status(400).json({ error: { code: 'invalid_request', message: 'Send { text, schedule }.' } });
  const prompt = `Scheduled reminder, set by the user in the Muse app: "${text}". Do what it asks if it is a task, then message the user now with node ~/muse/notify.mjs, adding anything useful you know or can quickly check.`;
  forwardJson(res, hosting(req.user, '/crons'), {
    method: 'POST',
    body: JSON.stringify({ name: text.slice(0, 80), prompt, schedule, timezone: req.user.profile.timezone }),
  });
});

app.patch('/api/me/crons/:cid', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.user, `/crons/${req.params.cid}`), { method: 'PATCH', body: JSON.stringify({ enabled: Boolean(req.body?.enabled) }) })
);

app.delete('/api/me/crons/:cid', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.user, `/crons/${req.params.cid}`), { method: 'DELETE' })
);

app.post('/api/me/crons/:cid/run', requireAgent, requireCronId, (req, res) =>
  forwardJson(res, hosting(req.user, `/crons/${req.params.cid}/run`), { method: 'POST' })
);

// ---- Connectors: managed Composio, one entity per instance ----

app.get('/api/me/integrations/toolkits', requireAgent, (req, res) => {
  const search = clean(req.query.search, 60);
  const query = new URLSearchParams({ limit: '24', ...(search.length >= 3 ? { search } : {}) });
  forwardJson(res, hosting(req.user, `/integrations/toolkits?${query}`));
});

app.get('/api/me/integrations/connections', requireAgent, (req, res) => forwardJson(res, hosting(req.user, '/integrations/connections')));

app.post('/api/me/integrations/connect', requireAgent, (req, res) => {
  const toolkit = req.body?.toolkit;
  if (!TOOLKIT.test(toolkit || '')) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad toolkit.' } });
  // callbackUrl must be https; on plain localhost the user lands on Composio's own page.
  const callbackUrl = PUBLIC_URL.startsWith('https://') ? `${PUBLIC_URL}/connected?toolkit=${toolkit}` : undefined;
  forwardJson(res, hosting(req.user, '/integrations/connect'), { method: 'POST', body: JSON.stringify({ toolkit, callbackUrl }) });
});

app.delete('/api/me/integrations/connections/:caid', requireAgent, (req, res) => {
  if (!ACCOUNT_ID.test(req.params.caid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad account id.' } });
  forwardJson(res, hosting(req.user, `/integrations/connections/${req.params.caid}`), { method: 'DELETE' });
});

const server = app.listen(PORT, () => {
  console.log(`muse running at http://localhost:${PORT}`);
  if (PUBLIC_URL) console.log(`agents message you via ${PUBLIC_URL}/api/notify`);
});
// A turn has no time limit and a create can run for minutes on a cold host; without this,
// Node's default request timeout cuts both off.
server.requestTimeout = 0;
server.headersTimeout = 0;
