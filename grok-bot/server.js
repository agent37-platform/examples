// grok-bot server: a team of named Bots that share one Agent37 computer per user.
//
// The sk_live_ key is workspace-scoped, so it must never reach the browser. Every call goes
// browser -> this server -> Agent37, like hermes-chat, on the same two upstreams:
//   - the Hosting API at AGENT37_API_BASE (instances, crons, integrations)
//   - each instance's own Agent API at https://{instanceId}.{AGENT37_APP_DOMAIN} (chat, files)
//
// What this example adds on top:
//   - Per-visitor ownership. A signed cookie names the visitor and data/store.json maps the
//     visitor to their one instance, so the browser never sends (or sees) an instance id.
//   - Bots live in this app, not on the platform: a name, a title, a brief and a color, each
//     with its own sessions on the shared instance and a notes file on its disk. The brief
//     rides as a preamble on the Bot's turns, since /v1/responses has no system-prompt field.
//   - Routines are platform crons whose name starts with the Bot's handle ("scout: ...").
//   - The agent messages the user first by calling POST /api/notify with a token planted in
//     its env at create (the site-builder publish-token pattern).
//   - The team chat forwards @mentions to each Bot's own group session and posts the answers
//     back, including one hop of Bot-to-Bot handoff.
//   - Optional live screen: with DESKTOP_TEMPLATE set, computers run a desktop template and the
//     browser watches (and takes over) its noVNC stream on a short-lived signed token.
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.AGENT37_API_KEY;
const API_BASE = process.env.AGENT37_API_BASE || 'https://api.agent37.com';
const APP_DOMAIN = process.env.AGENT37_APP_DOMAIN || 'agent37.app';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const PORT = Number(process.env.PORT || 3000);
const [SHAPE_CPU, SHAPE_MEMORY] = (process.env.INSTANCE_SHAPE || '2/4').split('/').map(Number);
const DESKTOP_TEMPLATE = process.env.DESKTOP_TEMPLATE || '';
const DESKTOP_PORT = 6901;

if (!API_KEY) {
  console.error('Set AGENT37_API_KEY in .env (copy .env.example). Mint a key at https://www.agent37.com/dashboard/cloud/api-keys');
  process.exit(1);
}
if (SESSION_SECRET.length < 16) {
  console.error('Set SESSION_SECRET in .env to a long random string (openssl rand -hex 32).');
  process.exit(1);
}
if (!PUBLIC_URL.startsWith('https://')) {
  console.error('Set PUBLIC_URL in .env: the https URL your Bots use to reach this server.');
  console.error('Agents run in the cloud, so it cannot be localhost. Deploy this app, or for local dev run:');
  console.error(`  cloudflared tunnel --url http://localhost:${PORT}`);
  console.error('and paste the https URL it prints.');
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INSTANCE_ID = /^[a-z0-9]{10}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const CRON_ID = /^[A-Za-z0-9_-]{4,64}$/;
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const AGENT_HEADERS = { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/json' };

function headersFor(url) {
  return url.startsWith(API_BASE) ? AUTH_HEADERS : AGENT_HEADERS;
}

// ---- Store: one JSON file, one record per visitor ----
//
// A stand-in for your database. Swap the cookie and this file for real auth and real tables
// in production (the starter-kit repo shows one way).

const DATA_DIR = path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) : { visitors: {} };

function save() {
  fs.writeFileSync(`${STORE_PATH}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${STORE_PATH}.tmp`, STORE_PATH);
}

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validTimezone(value) {
  if (typeof value !== 'string' || !value) return 'UTC';
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// ---- Visitor cookie ----

const COOKIE = 'grokbot_visitor';

function signed(value) {
  return `${value}.${crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url')}`;
}

function visitorIdFrom(req) {
  const raw = (req.headers.cookie || '')
    .split(/;\s*/)
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const value = raw.slice(0, raw.lastIndexOf('.'));
  return value && safeEqual(signed(value), raw) ? value : null;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api', (req, res, next) => {
  if (req.path === '/notify') return next();
  let id = visitorIdFrom(req);
  if (!id) {
    id = randomHex(16);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${signed(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  req.visitorId = id;
  req.visitor = db.visitors[id] || null;
  next();
});

function requireComputer(req, res, next) {
  if (!req.visitor?.instanceId) {
    return res.status(409).json({ error: { code: 'no_computer', message: 'Start your computer first.' } });
  }
  next();
}

function requireBot(req, res, next) {
  req.bot = req.visitor.bots.find((bot) => bot.id === req.params.botId);
  if (!req.bot) return res.status(404).json({ error: { code: 'not_found', message: 'No such Bot.' } });
  next();
}

// ---- Upstream plumbing, copied from hermes-chat ----

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

function sendUpstreamError(res, upstream) {
  const norm = normalizeError(upstream.res.status, upstream.body);
  res.status(norm.status).json(norm.body);
}

// Pipe an upstream SSE response through untouched (EventSource cannot POST or send custom
// headers, so the server relays the stream). Resolves with the tail of what it relayed, so
// a caller can read the terminal event without parsing the whole stream.
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
    if (controller.signal.aborted) return '';
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
    return '';
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
    res.status(norm.status).json(norm.body);
    return '';
  }
  res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.flushHeaders();
  const decoder = new TextDecoder();
  let tail = '';
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-64_000);
    }
  } catch {
    // Client navigated away or upstream dropped; either way there is nothing left to send.
  }
  res.end();
  return tail;
}

function instanceUrl(id, pathname) {
  return `https://${id}.${APP_DOMAIN}${pathname}`;
}

// ---- Files on the user's computer ----

async function readInstanceFile(instanceId, filePath) {
  const res = await fetch(instanceUrl(instanceId, `/v1/files/content?${new URLSearchParams({ path: filePath })}`), {
    headers: { 'X-Agent37-Key': API_KEY },
  });
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`Could not read ${filePath} (HTTP ${res.status}).`);
  return res.text();
}

async function writeInstanceFile(instanceId, filePath, text, { overwrite = true } = {}) {
  const query = new URLSearchParams({ path: filePath, overwrite: String(overwrite) });
  const res = await fetch(instanceUrl(instanceId, `/v1/files/content?${query}`), {
    method: 'PUT',
    headers: { 'X-Agent37-Key': API_KEY, 'Content-Type': 'application/octet-stream' },
    body: text,
  });
  if (!res.ok && !(res.status === 409 && !overwrite)) throw new Error(`Could not write ${filePath} (HTTP ${res.status}).`);
}

// ---- The words the agent reads ----
//
// App context rides at the top of the input. It is composed per request, so a redeploy
// reaches every new turn without touching existing instances, and the UI strips it back out
// of history with BRIEF_PATTERN.

const BRIEF_PATTERN = /^App context \(from the Bots app[\s\S]*?End of app context\.[^\n]*\n\n/;
const stripBrief = (text) => (typeof text === 'string' ? text.replace(BRIEF_PATTERN, '') : text);
const notesPath = (bot) => `~/bots/${bot.handle}/notes.md`;
const cronPrefix = (bot) => `${bot.handle}: `;

function teammates(visitor, bot) {
  const others = visitor.bots.filter((other) => other.id !== bot.id);
  return others.length ? others.map((other) => `@${other.handle} (${other.name}, ${other.title || 'no title'})`).join(', ') : 'none yet';
}

function botBrief(visitor, bot, firstTurn) {
  if (!firstTurn) {
    return `App context (from the Bots app, not the user): you are ${bot.name} (${bot.title || 'Bot'}); your notes are in ${notesPath(bot)}. End of app context. The user message follows.\n\n`;
  }
  return [
    'App context (from the Bots app, not the user):',
    `You are ${bot.name}, ${visitor.userName}'s ${bot.title || 'teammate'}. Stay in this role for the whole conversation.`,
    bot.description ? `Your brief: ${bot.description}` : '',
    `Your notes file is ${notesPath(bot)}. Read it before you start, and add to it whenever you learn something you should remember next time.`,
    `Other Bots on this computer: ${teammates(visitor, bot)}.`,
    `To schedule a routine for yourself: agent37 cron add --name "${cronPrefix(bot)}<short name>" --schedule "<5-field cron>" --timezone "${visitor.timezone}" --prompt "You are ${bot.name}. <what to do>"`,
    `To message ${visitor.userName} first: node ~/.grokbot/notify.mjs ${bot.handle} "<one or two sentences>"`,
    'End of app context. The user message follows.',
    '',
    '',
  ]
    .filter((line, index, lines) => line || index >= lines.length - 2)
    .join('\n');
}

function routineBrief(visitor, bot) {
  return [
    'App context (from the Bots app, not the user):',
    `This is a scheduled routine for ${bot.name}, ${visitor.userName}'s ${bot.title || 'teammate'}.${bot.description ? ` Brief: ${bot.description}` : ''}`,
    `Read ${notesPath(bot)} first. When the routine is done, message ${visitor.userName} with: node ~/.grokbot/notify.mjs ${bot.handle} "<a short summary>"`,
    'End of app context. The routine instruction follows.',
    '',
    '',
  ].join('\n');
}

function groupBrief(visitor, bot, firstTurn) {
  return [
    'App context (from the Bots app, not the user):',
    `You are ${bot.name} (${bot.title || 'Bot'}) in ${visitor.userName}'s team chat. The other Bots: ${teammates(visitor, bot)}.`,
    firstTurn && bot.description ? `Your brief: ${bot.description}` : '',
    firstTurn ? `Your notes file is ${notesPath(bot)}.` : '',
    'Reply to the group in a few sentences, without repeating the message you were sent. @mention another Bot only when you need it to do something; the app forwards your message to it.',
    'End of app context. The group message follows.',
    '',
    '',
  ]
    .filter((line, index, lines) => line || index >= lines.length - 2)
    .join('\n');
}

function soulFor(visitor) {
  return [
    '# Team computer',
    '',
    `You are the shared computer behind ${visitor.userName}'s team of Bots. Every conversation belongs to one Bot: the app opens it with an "App context" block naming the Bot, its job and its notes file. Stay in that Bot's role for the whole conversation, and answer in its voice.`,
    '',
    '- All Bots share this computer: its files, browser and terminal. Keep shared work in ~/workspace.',
    "- Each Bot keeps its own notes in ~/bots/<handle>/notes.md. Read them at the start of a conversation and update them as you work. Facts every Bot should know go in your shared memory.",
    `- You can follow up later. Schedule your own future turns with the agent37 CLI: agent37 cron add --name "<handle>: <short name>" --schedule "<5-field cron>" --timezone "${visitor.timezone}" --prompt "<what to do, starting with which Bot you are>". Use it whenever ${visitor.userName} asks for something recurring or asks you to check back later. agent37 cron list and agent37 cron remove <id> manage them. Never say you cannot follow up.`,
    `- You can message ${visitor.userName} first: node ~/.grokbot/notify.mjs <handle> "<one or two sentences>". It shows up as a notification in their app. Use it when a routine finishes or something they are waiting for is ready.`,
    `- Never buy anything or enter payment details. When a task needs a purchase, stop and hand it back to ${visitor.userName} with what to buy and where.`,
    ...(visitor.desktop
      ? [`- ${visitor.userName} can watch this computer's screen live in the app and take it over. Your browser is the one on that screen. When a site needs ${visitor.userName} (a login, a 2FA code, a CAPTCHA), leave the page open, ask them to take over the screen, and carry on when they say they are done.`]
      : []),
    `- ${visitor.userName}'s timezone is ${visitor.timezone}.`,
    '',
    'Be direct: match the length of the reply to the ask, no filler, and say plainly when you are unsure.',
    '',
  ].join('\n');
}

// The notify script carries this server's URL, so it is rewritten whenever PUBLIC_URL changes
// (a new quick-tunnel URL, a deploy). The token comes from the instance env, set at create.
function notifyScript() {
  return `const [bot, ...words] = process.argv.slice(2);
const res = await fetch(${JSON.stringify(`${PUBLIC_URL}/api/notify`)}, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.GROKBOT_NOTIFY_TOKEN}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ instance_id: process.env.AGENT37_INSTANCE_ID, bot, text: words.join(' ') }),
});
console.log(res.status, await res.text());
`;
}

// ---- The user's computer ----

const PALETTE = ['#FF6B35', '#006CEB', '#12A150', '#8B5CF6', '#E5484D', '#0EA5A4', '#D97706', '#DB2777'];
const SHAPES = ['circle', 'triangle', 'diamond', 'square', 'hexagon', 'ring'];

function publicBot(bot) {
  return {
    id: bot.id,
    handle: bot.handle,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    color: bot.color,
    shape: bot.shape,
    sessions: bot.sessions,
    last_at: bot.lastAt ?? null,
    preview: bot.preview ?? '',
  };
}

function me(visitor) {
  if (!visitor) return { computer: false };
  return {
    computer: true,
    user_name: visitor.userName,
    timezone: visitor.timezone,
    desktop: Boolean(visitor.desktop),
    bots: visitor.bots.map(publicBot),
  };
}

app.get('/api/me', (req, res) => res.json(me(req.visitor)));

const creating = new Set();

// budget.credit_micros funds managed LLM calls for this computer ($1 = 1,000,000 micros);
// without it the default budget is $0 and replies come back empty. Several Bots share it.
// auto_sleep lets the computer sleep between conversations and billed only for disk; a
// request, a cron, or a notify-driven visit wakes it. The idle timeout sits above the
// length of a long routine so a turn is not checkpointed mid-run. DESKTOP_TEMPLATE swaps in a
// workspace template that adds a visible screen; everything else on the computer is the same.
app.post('/api/setup', async (req, res) => {
  if (req.visitor?.instanceId) return res.json(me(req.visitor));
  if (creating.has(req.visitorId)) {
    return res.status(409).json({ error: { code: 'busy', message: 'Your computer is already starting.' } });
  }
  creating.add(req.visitorId);
  const userName = clean(req.body?.name, 40) || 'you';
  const token = randomHex(24);
  const body = {
    template: DESKTOP_TEMPLATE || 'agent37-hermes',
    user: req.visitorId,
    name: `grok-bot ${userName}`.slice(0, 60),
    resources: { cpu: SHAPE_CPU, memory: SHAPE_MEMORY },
    budget: { credit_micros: 2_000_000 },
    auto_sleep: true,
    idle_timeout_seconds: 1800,
    env: { GROKBOT_NOTIFY_TOKEN: token },
  };
  try {
    const created = await agent37(`${API_BASE}/v1/instances`, { method: 'POST', body: JSON.stringify(body) });
    if (!created.res.ok) return sendUpstreamError(res, created);
    db.visitors[req.visitorId] = {
      instanceId: created.body.id,
      userName,
      timezone: validTimezone(req.body?.timezone),
      desktop: Boolean(DESKTOP_TEMPLATE),
      notifyTokenSha256: sha256(token),
      provisionedFor: null,
      bots: [],
      notifications: [],
      group: [],
      createdAt: Date.now(),
    };
    save();
    res.json(me(db.visitors[req.visitorId]));
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  } finally {
    creating.delete(req.visitorId);
  }
});

// The instance URL can't tell a computer still booting from one that is gone or stopped (and a
// brand-new route can 404 for a few seconds), so the Hosting API has the last word. A computer
// deleted elsewhere drops the visitor back to onboarding; a stopped one is started again.
async function notReady(req) {
  const { res: upstream, body } = await agent37(`${API_BASE}/v1/instances/${req.visitor.instanceId}`);
  if (upstream.status === 404 || body?.status === 'deleting') {
    delete db.visitors[req.visitorId];
    save();
    return { ready: false, gone: true };
  }
  if (body?.status === 'stopped') {
    await agent37(`${API_BASE}/v1/instances/${req.visitor.instanceId}/start`, { method: 'POST' });
    return { ready: false, message: 'Your computer was stopped. Starting it again.' };
  }
  if (body?.status === 'failed') return { ready: false, stuck: true, message: 'Your computer failed to start.' };
  return { ready: false };
}

// "running" means the container is up, not that the agent inside has finished booting, and a
// sleeping computer wakes on this request. Once healthy, the first check writes SOUL.md and
// the notify script; later checks only refresh the script when PUBLIC_URL has changed.
app.get('/api/ready', requireComputer, async (req, res) => {
  const visitor = req.visitor;
  try {
    const upstream = await fetch(instanceUrl(visitor.instanceId, '/v1/health'), {
      headers: AGENT_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const body = await upstream.json().catch(() => null);
    if (upstream.status === 402) return res.json({ ready: false, stuck: true, message: body?.message || 'Your computer is paused.' });
    if (body?.healthy !== true) return res.json(await notReady(req));
  } catch {
    return res.json({ ready: false });
  }
  if (visitor.provisionedFor !== PUBLIC_URL) {
    try {
      if (!visitor.provisionedFor) await writeInstanceFile(visitor.instanceId, '~/.hermes/SOUL.md', soulFor(visitor));
      await writeInstanceFile(visitor.instanceId, '~/.grokbot/notify.mjs', notifyScript());
      visitor.provisionedFor = PUBLIC_URL;
      save();
    } catch (err) {
      return res.json({ ready: false, message: err.message });
    }
  }
  res.json({ ready: true });
});

app.delete('/api/me', requireComputer, async (req, res) => {
  let upstream;
  try {
    upstream = await agent37(`${API_BASE}/v1/instances/${req.visitor.instanceId}`, { method: 'DELETE' });
  } catch (err) {
    return res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
  if (!upstream.res.ok && upstream.res.status !== 404) return sendUpstreamError(res, upstream);
  delete db.visitors[req.visitorId];
  save();
  res.json({ deleted: true });
});

// ---- The live screen (DESKTOP_TEMPLATE only) ----
//
// A signed URL's token opens the desktop's noVNC WebSocket from any origin (the token rides in
// the URL's query string, so no cookie is needed). The token grants full control, whatever the page does with
// viewOnly, and cannot be revoked, so it is minted per connection, for the owner alone, at the
// 60-second minimum: it only has to be valid while the socket opens.
app.post('/api/computer', requireComputer, async (req, res) => {
  if (!req.visitor.desktop) {
    return res.status(404).json({ error: { code: 'no_desktop', message: 'This computer has no live screen.' } });
  }
  try {
    const upstream = await agent37(`${API_BASE}/v1/instances/${req.visitor.instanceId}/signed-url`, {
      method: 'POST',
      body: JSON.stringify({ port: DESKTOP_PORT, ttl_seconds: 60 }),
    });
    if (!upstream.res.ok) return sendUpstreamError(res, upstream);
    const signed = new URL(upstream.body.url);
    res.set('Cache-Control', 'no-store');
    res.json({ ws: `wss://${signed.host}/websockify?a37_token=${signed.searchParams.get('a37_token')}` });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
});

// ---- Bots ----

function uniqueHandle(visitor, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'bot';
  let handle = base;
  for (let n = 2; visitor.bots.some((bot) => bot.handle === handle) || handle === 'everyone'; n += 1) handle = `${base}-${n}`;
  return handle;
}

function applyBotFields(bot, body) {
  if (typeof body?.name === 'string' && body.name.trim()) bot.name = clean(body.name, 40);
  if (typeof body?.title === 'string') bot.title = clean(body.title, 60);
  if (typeof body?.description === 'string') bot.description = clean(body.description, 1500);
  if (PALETTE.includes(body?.color)) bot.color = body.color;
  if (SHAPES.includes(body?.shape)) bot.shape = body.shape;
}

app.post('/api/bots', requireComputer, async (req, res) => {
  const visitor = req.visitor;
  const name = clean(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: { code: 'invalid_request', message: 'A Bot needs a name.' } });
  const bot = {
    id: randomHex(6),
    handle: uniqueHandle(visitor, name),
    name,
    title: '',
    description: '',
    color: PALETTE[visitor.bots.length % PALETTE.length],
    shape: SHAPES[visitor.bots.length % SHAPES.length],
    sessions: [],
    groupSessionId: null,
    createdAt: Date.now(),
  };
  applyBotFields(bot, req.body);
  try {
    await writeInstanceFile(visitor.instanceId, notesPath(bot), `# ${bot.name}'s notes\n\n`, { overwrite: false });
  } catch (err) {
    return res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
  visitor.bots.push(bot);
  save();
  res.status(201).json(publicBot(bot));
});

app.patch('/api/bots/:botId', requireComputer, requireBot, (req, res) => {
  applyBotFields(req.bot, req.body);
  save();
  res.json(publicBot(req.bot));
});

// Deleting a Bot deletes its routines. Its sessions and notes file stay on the computer.
app.delete('/api/bots/:botId', requireComputer, requireBot, async (req, res) => {
  const visitor = req.visitor;
  const listed = await agent37(`${API_BASE}/v1/instances/${visitor.instanceId}/crons`).catch(() => null);
  for (const cron of listed?.body?.data ?? []) {
    if (cron.name?.startsWith(cronPrefix(req.bot))) {
      await agent37(`${API_BASE}/v1/instances/${visitor.instanceId}/crons/${cron.id}`, { method: 'DELETE' }).catch(() => null);
    }
  }
  visitor.bots = visitor.bots.filter((bot) => bot.id !== req.bot.id);
  save();
  res.json({ id: req.bot.id, deleted: true });
});

app.get('/api/bots/:botId/notes', requireComputer, requireBot, async (req, res) => {
  try {
    res.json({ path: notesPath(req.bot), text: await readInstanceFile(req.visitor.instanceId, notesPath(req.bot)) });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

app.put('/api/bots/:botId/notes', requireComputer, requireBot, async (req, res) => {
  try {
    await writeInstanceFile(req.visitor.instanceId, notesPath(req.bot), String(req.body?.text ?? ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

// ---- Chat: each Bot has its own sessions on the shared computer ----
//
// Hermes accepts a caller-minted session id on the first turn, so the server mints it and
// records it on the Bot before the turn starts. Different Bots are different sessions, so
// they work in parallel; one session runs one turn at a time (409 session_busy).

app.post('/api/bots/:botId/responses', requireComputer, requireBot, async (req, res) => {
  const { visitor, bot } = req;
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  if (!input) return res.status(400).json({ error: { code: 'invalid_request', message: 'Say something first.' } });
  let session = bot.sessions.find((entry) => entry.id === req.body?.session_id);
  if (req.body?.session_id && !session) {
    return res.status(404).json({ error: { code: 'not_found', message: 'That conversation belongs to another Bot.' } });
  }
  if (!session) {
    session = { id: randomHex(16), created: Date.now(), title: input.slice(0, 60) };
    bot.sessions.unshift(session);
  }
  // The full brief goes on a session's first turn that actually started; later turns carry
  // a one-line reminder, so the history stays readable and the Bot stays in role.
  const firstTurn = !session.started;
  bot.lastAt = Date.now();
  bot.preview = `You: ${input.slice(0, 100)}`;
  save();
  const body = JSON.stringify({ input: botBrief(visitor, bot, firstTurn) + input, session_id: session.id, stream: true });
  const tail = await forwardSse(req, res, instanceUrl(visitor.instanceId, '/v1/responses'), { method: 'POST', body });
  if (tail.includes('event: response.created')) session.started = true;
  const completed = tail.match(/event: response\.completed\ndata: (.+)\n/);
  if (completed) {
    try {
      const text = JSON.parse(completed[1]).output_text?.trim();
      if (text) {
        bot.preview = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').replace(/^[\s-]+/, '').slice(0, 100);
        bot.lastAt = Date.now();
      }
    } catch {}
  }
  save();
});

app.delete('/api/bots/:botId/sessions/:sid', requireComputer, requireBot, async (req, res) => {
  if (!HEX32.test(req.params.sid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad session id.' } });
  req.bot.sessions = req.bot.sessions.filter((entry) => entry.id !== req.params.sid);
  save();
  forwardJson(res, instanceUrl(req.visitor.instanceId, `/v1/sessions/${req.params.sid}`), { method: 'DELETE' });
});

// Any session on the visitor's own computer is theirs: Bot threads, group threads, and the
// sessions routine runs open. The app's preamble is stripped before the browser sees it.
app.get('/api/sessions/:sid', requireComputer, async (req, res) => {
  if (!HEX32.test(req.params.sid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad session id.' } });
  try {
    const upstream = await agent37(instanceUrl(req.visitor.instanceId, `/v1/sessions/${req.params.sid}`));
    if (!upstream.res.ok) return sendUpstreamError(res, upstream);
    const history = (upstream.body.history ?? [])
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: stripBrief(message.content), thinking: message.thinking, created_at: message.created_at }));
    res.json({ id: upstream.body.id, active_response_id: upstream.body.active_response_id, history });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
});

app.get('/api/responses/:rid/stream', requireComputer, (req, res) => {
  if (!HEX32.test(req.params.rid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad response id.' } });
  forwardSse(req, res, instanceUrl(req.visitor.instanceId, `/v1/responses/${req.params.rid}/stream`));
});

app.post('/api/responses/:rid/cancel', requireComputer, (req, res) => {
  if (!HEX32.test(req.params.rid)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad response id.' } });
  forwardJson(res, instanceUrl(req.visitor.instanceId, `/v1/responses/${req.params.rid}/cancel`), { method: 'POST' });
});

// ---- Routines: platform crons, one Bot each ----
//
// The cron name carries the Bot's handle, so routines the agent schedules for itself with
// `agent37 cron add` land on the right Bot too. App-created routines set agent: 'hermes' so
// every run links its session as it fires (a workspace template would otherwise link it only
// once the turn ends).
// The CLI cannot set agent, so on a desktop computer the list patches it onto the routines
// a Bot scheduled for itself.

function routineView(visitor, cron) {
  const bot = visitor.bots.find((candidate) => cron.name?.startsWith(cronPrefix(candidate)));
  return {
    id: cron.id,
    bot_id: bot?.id ?? null,
    name: bot ? cron.name.slice(cronPrefix(bot).length) : cron.name || 'Untitled routine',
    instruction: stripBrief(cron.prompt),
    schedule: cron.schedule,
    timezone: cron.timezone,
    enabled: cron.enabled,
    last_run: cron.last_run,
    next_run: cron.next_run,
  };
}

function cronsUrl(visitor, suffix = '') {
  return `${API_BASE}/v1/instances/${visitor.instanceId}/crons${suffix}`;
}

function requireCronId(req, res, next) {
  if (!CRON_ID.test(req.params.cronId)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad routine id.' } });
  next();
}

app.get('/api/routines', requireComputer, async (req, res) => {
  try {
    const upstream = await agent37(cronsUrl(req.visitor));
    if (!upstream.res.ok) return sendUpstreamError(res, upstream);
    if (req.visitor.desktop) {
      for (const cron of upstream.body.data.filter((entry) => !entry.agent)) {
        await agent37(cronsUrl(req.visitor, `/${cron.id}`), { method: 'PATCH', body: JSON.stringify({ agent: 'hermes' }) });
      }
    }
    res.json({ data: upstream.body.data.map((cron) => routineView(req.visitor, cron)) });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
});

app.post('/api/bots/:botId/routines', requireComputer, requireBot, async (req, res) => {
  const { visitor, bot } = req;
  const body = {
    name: `${cronPrefix(bot)}${clean(req.body?.name, 50) || 'Routine'}`,
    prompt: routineBrief(visitor, bot) + clean(req.body?.instruction, 6000),
    schedule: clean(req.body?.schedule, 100),
    timezone: validTimezone(req.body?.timezone || visitor.timezone),
    enabled: req.body?.enabled !== false,
    agent: 'hermes',
  };
  try {
    const upstream = await agent37(cronsUrl(visitor), { method: 'POST', body: JSON.stringify(body) });
    if (!upstream.res.ok) return sendUpstreamError(res, upstream);
    res.status(201).json(routineView(visitor, upstream.body));
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
});

// The Active toggle is a PATCH of enabled alone. A name or instruction edit is recomposed
// with the owning Bot's prefix and brief, looked up from the stored cron name.
app.patch('/api/routines/:cronId', requireComputer, requireCronId, async (req, res) => {
  const visitor = req.visitor;
  const patch = {};
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (typeof req.body?.schedule === 'string') patch.schedule = clean(req.body.schedule, 100);
  if (typeof req.body?.timezone === 'string') patch.timezone = validTimezone(req.body.timezone);
  try {
    if (typeof req.body?.name === 'string' || typeof req.body?.instruction === 'string') {
      const current = await agent37(cronsUrl(visitor, `/${req.params.cronId}`));
      if (!current.res.ok) return sendUpstreamError(res, current);
      const bot = visitor.bots.find((candidate) => current.body.name?.startsWith(cronPrefix(candidate)));
      if (typeof req.body.name === 'string') patch.name = `${bot ? cronPrefix(bot) : ''}${clean(req.body.name, 50) || 'Routine'}`;
      if (typeof req.body.instruction === 'string') {
        patch.prompt = (bot ? routineBrief(visitor, bot) : '') + clean(req.body.instruction, 6000);
        if (bot) patch.agent = 'hermes';
      }
    }
    const upstream = await agent37(cronsUrl(visitor, `/${req.params.cronId}`), { method: 'PATCH', body: JSON.stringify(patch) });
    if (!upstream.res.ok) return sendUpstreamError(res, upstream);
    res.json(routineView(visitor, upstream.body));
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_unreachable', message: String(err?.message || err) } });
  }
});

app.delete('/api/routines/:cronId', requireComputer, requireCronId, (req, res) =>
  forwardJson(res, cronsUrl(req.visitor, `/${req.params.cronId}`), { method: 'DELETE' })
);

app.post('/api/routines/:cronId/run', requireComputer, requireCronId, (req, res) =>
  forwardJson(res, cronsUrl(req.visitor, `/${req.params.cronId}/run`), { method: 'POST' })
);

app.get('/api/routines/:cronId/runs', requireComputer, requireCronId, (req, res) =>
  forwardJson(res, cronsUrl(req.visitor, `/${req.params.cronId}/runs`))
);

// ---- Persona and memory: plain files on the computer ----
//
// SOUL.md is the team-wide persona every turn loads. Hermes keeps its memory as entries in
// two files, separated by a line holding a single "§".

const MEMORY_FILES = { memory: '~/.hermes/memories/MEMORY.md', user: '~/.hermes/memories/USER.md' };
const MEMORY_DELIMITER = '\n§\n';

app.get('/api/persona', requireComputer, async (req, res) => {
  try {
    res.json({ text: await readInstanceFile(req.visitor.instanceId, '~/.hermes/SOUL.md') });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

app.put('/api/persona', requireComputer, async (req, res) => {
  try {
    await writeInstanceFile(req.visitor.instanceId, '~/.hermes/SOUL.md', String(req.body?.text ?? ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

app.get('/api/memory', requireComputer, async (req, res) => {
  try {
    const result = {};
    for (const [key, file] of Object.entries(MEMORY_FILES)) {
      const text = await readInstanceFile(req.visitor.instanceId, file);
      result[key] = text.split(MEMORY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

app.put('/api/memory/:which', requireComputer, async (req, res) => {
  const file = MEMORY_FILES[req.params.which];
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.map((entry) => clean(entry, 2000)).filter(Boolean) : null;
  if (!file || !entries) return res.status(400).json({ error: { code: 'invalid_request', message: 'Send { entries: [...] }.' } });
  try {
    await writeInstanceFile(req.visitor.instanceId, file, entries.join(MEMORY_DELIMITER));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
  }
});

// ---- App connections: managed Composio on the user's computer ----

function integrationsUrl(visitor, suffix) {
  return `${API_BASE}/v1/instances/${visitor.instanceId}/integrations${suffix}`;
}

app.get('/api/apps/toolkits', requireComputer, (req, res) => {
  const query = new URLSearchParams({ limit: '12' });
  const search = clean(req.query.search, 60);
  if (search.length >= 3) query.set('search', search);
  forwardJson(res, integrationsUrl(req.visitor, `/toolkits?${query}`));
});

app.post('/api/apps/connect', requireComputer, (req, res) => {
  const toolkit = clean(req.body?.toolkit, 60);
  if (!/^[a-z0-9_-]+$/i.test(toolkit)) return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad toolkit.' } });
  forwardJson(res, integrationsUrl(req.visitor, '/connect'), {
    method: 'POST',
    body: JSON.stringify({ toolkit, callbackUrl: `${PUBLIC_URL}/connected.html` }),
  });
});

app.get('/api/apps/connections', requireComputer, (req, res) => forwardJson(res, integrationsUrl(req.visitor, '/connections')));

app.delete('/api/apps/connections/:accountId', requireComputer, (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(req.params.accountId)) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Bad account id.' } });
  }
  forwardJson(res, integrationsUrl(req.visitor, `/connections/${req.params.accountId}`), { method: 'DELETE' });
});

// ---- Messages you first: the endpoint the agent calls ----
//
// Authenticated by the notify token instead of the cookie: the caller is the agent, running
// ~/.grokbot/notify.mjs inside its instance. This is where your own policy goes (rate
// limits, quiet hours) and where a real app would send Web Push, email, or a text.

app.post('/api/notify', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const instanceId = req.body?.instance_id;
  const visitor = INSTANCE_ID.test(instanceId || '') ? Object.values(db.visitors).find((entry) => entry.instanceId === instanceId) : null;
  if (!visitor || !token || !safeEqual(visitor.notifyTokenSha256, sha256(token))) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'The notify token does not match this instance.' } });
  }
  const text = clean(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: { code: 'invalid_request', message: 'Send JSON { "instance_id", "bot", "text" }.' } });
  const bot = visitor.bots.find((candidate) => candidate.handle === req.body?.bot);
  visitor.notifications.push({ id: randomHex(8), bot_id: bot?.id ?? null, text, at: Date.now(), read: false });
  visitor.notifications = visitor.notifications.slice(-100);
  save();
  res.json({ ok: true });
});

app.get('/api/notifications', requireComputer, (req, res) => {
  const list = req.visitor.notifications;
  res.json({ data: list.slice(-50).reverse(), unread: list.filter((entry) => !entry.read).length });
});

app.post('/api/notifications/read', requireComputer, (req, res) => {
  for (const entry of req.visitor.notifications) entry.read = true;
  save();
  res.json({ ok: true });
});

// ---- Team chat: @mentions forwarded to each Bot's group session ----
//
// Each Bot answers in its own group session, one turn at a time (a per-Bot promise chain
// keeps a second mention from hitting 409 session_busy). The answer is posted back to the
// group. When a Bot @mentions another Bot in its reply, the app hands the reply over, up to
// two hops (Chief asks Scout, Scout answers Chief), skipping Bots the user already asked.

const groupQueues = new Map();
const groupPending = new Map();

function postToGroup(visitor, message) {
  visitor.group.push({ id: randomHex(8), at: Date.now(), ...message });
  visitor.group = visitor.group.slice(-200);
  save();
}

function mentionedBots(visitor, text, except) {
  if (/@everyone\b/i.test(text)) return visitor.bots.filter((bot) => bot !== except);
  const handles = [...text.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)].map((match) => match[1].toLowerCase());
  return visitor.bots.filter((bot) => bot !== except && (handles.includes(bot.handle) || handles.includes(bot.name.toLowerCase())));
}

function recentGroup(visitor) {
  const lines = visitor.group
    .filter((message) => message.kind !== 'status')
    .slice(-7, -1)
    .map((message) => `${message.kind === 'user' ? visitor.userName : visitor.bots.find((bot) => bot.id === message.bot_id)?.name || 'A Bot'}: ${message.text.slice(0, 400)}`);
  return lines.length ? `Earlier in the group:\n${lines.join('\n')}\n\nNow:\n` : '';
}

function askInGroup(visitorId, bot, text, hops, askedByUser) {
  const visitor = db.visitors[visitorId];
  groupPending.set(visitorId, (groupPending.get(visitorId) || 0) + 1);
  const turn = (groupQueues.get(bot.id) || Promise.resolve())
    .then(async () => {
      const firstTurn = !bot.groupSessionId;
      if (firstTurn) bot.groupSessionId = randomHex(16);
      const input = groupBrief(visitor, bot, firstTurn) + recentGroup(visitor) + text;
      const { res, body } = await agent37(instanceUrl(visitor.instanceId, '/v1/responses'), {
        method: 'POST',
        body: JSON.stringify({ input, session_id: bot.groupSessionId }),
      });
      if (!res.ok || body?.status !== 'completed') {
        const reason = body?.error?.message || (typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        return postToGroup(visitor, { kind: 'status', text: `${bot.name} could not answer: ${reason}` });
      }
      const reply = body.output_text.trim() || '(no reply)';
      postToGroup(visitor, { kind: 'bot', bot_id: bot.id, text: reply });
      if (hops >= 2) return;
      for (const next of mentionedBots(visitor, reply, bot)) {
        if (hops === 0 && askedByUser.has(next.id)) continue;
        postToGroup(visitor, { kind: 'status', text: `${bot.name} is asking ${next.name}` });
        askInGroup(visitorId, next, `${bot.name} says: ${reply}`, hops + 1, askedByUser);
      }
    })
    .catch((err) => postToGroup(visitor, { kind: 'status', text: `${bot.name} could not answer: ${err.message}` }))
    .finally(() => groupPending.set(visitorId, groupPending.get(visitorId) - 1));
  groupQueues.set(bot.id, turn);
}

app.get('/api/group', requireComputer, (req, res) => {
  res.json({ messages: req.visitor.group.slice(-100), pending: groupPending.get(req.visitorId) || 0 });
});

app.post('/api/group/messages', requireComputer, (req, res) => {
  const visitor = req.visitor;
  const text = clean(req.body?.text, 4000);
  if (!text) return res.status(400).json({ error: { code: 'invalid_request', message: 'Say something first.' } });
  postToGroup(visitor, { kind: 'user', text });
  const targets = mentionedBots(visitor, text, null);
  if (!targets.length) {
    postToGroup(visitor, { kind: 'status', text: 'Nobody was mentioned. @mention a Bot (or @everyone) to hand it the work.' });
  }
  const askedByUser = new Set(targets.map((bot) => bot.id));
  for (const bot of targets) {
    postToGroup(visitor, { kind: 'status', text: `Asking ${bot.name}` });
    askInGroup(req.visitorId, bot, text, 0, askedByUser);
  }
  res.status(202).json({ messages: visitor.group.slice(-100), pending: groupPending.get(req.visitorId) || 0 });
});

const server = app.listen(PORT, () => {
  console.log(`grok-bot running at http://localhost:${PORT}`);
  console.log(`Bots call back via ${PUBLIC_URL}/api/notify`);
});
// Instance creation is synchronous on the Agent37 side and can run for minutes on a cold
// host; without this, Node's default 5-minute request timeout kills the create just short
// of the API's own budget.
server.requestTimeout = 0;
server.headersTimeout = 0;
