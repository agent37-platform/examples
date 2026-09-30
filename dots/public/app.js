const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const composer = $('composer');
const sendBtn = $('send');
const stopBtn = $('stop');

const APP_CONTEXT = 'App context (from the Dots app';
const APP_CONTEXT_END = 'End of app context.';
const MEMORY_CAPS = { user: 1375, memory: 2200 };

let me = null; // { agent, status, unread }
let loadingChat = false;
let view = 'chat'; // 'chat' or 'inbox'
let inFlight = null; // the live turn: { responseId, title, status, icon, tools }
let replyTo = []; // messages the agent sent first that are on screen, unanswered
let knownNotifications = null;
const desktopLayout = matchMedia('(min-width: 1000px)');

async function request(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code, status: res.status });
  return body;
}
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const send = (path, method, body) => request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const agentName = () => me?.agent?.name || 'your agent';

// ---- theme: the accent drives bubbles, the send button and the backdrop ----

function applyTheme(accent) {
  const root = document.documentElement.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-ink', inkOn(accent));
  root.setProperty('--accent-soft', mix(accent, '#ffffff', 0.62));
  root.setProperty('--accent-faint', mix(accent, '#ffffff', 0.88));
}

// ---- small formatting helpers ----

// Agent replies are markdown. Escape first, then allow a few safe constructs.
function md(text) {
  return esc(text)
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code) => `<code>${code.trim()}</code>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

function rel(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.round(abs / 60_000), 'min'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] : [Math.round(abs / 86_400_000), 'd'];
  if (abs < 60_000) return diff > 0 ? 'in a moment' : 'just now';
  return diff > 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(h, m) {
  const hour = Number(h);
  return `${hour % 12 || 12}:${String(m).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

// The common shapes read as words; anything else shows the expression itself. A cron runs
// in its own timezone, which the agent may have picked: a reminder pinned to one date reads
// as its next run in yours, and anything else names its zone when that is not yours.
function humanSchedule(cron, timezone) {
  const [m, h, dom, mon, dow] = cron.schedule.trim().split(/\s+/);
  const num = (v) => /^\d+$/.test(v);
  const zone = cron.timezone === timezone ? '' : ` (${cron.timezone})`;
  if (/^\*\/\d+$/.test(m) && h === '*') return `Every ${m.slice(2)} minutes`;
  if (num(m) && h === '*' && dom === '*' && dow === '*') return 'Every hour';
  if (num(m) && num(h) && dom === '*' && mon === '*') {
    if (dow === '*') return `Daily at ${clock(h, m)}${zone}`;
    if (dow === '1-5') return `Weekdays at ${clock(h, m)}${zone}`;
    if (num(dow)) return `${DAYS[Number(dow) % 7]}s at ${clock(h, m)}${zone}`;
  }
  if (num(m) && num(h) && num(dom) && num(mon) && dow === '*') {
    if (!cron.next_run) return `${MONTHS[Number(mon) - 1]} ${dom} at ${clock(h, m)}${zone}`;
    const at = new Date(cron.next_run * 1000);
    const date = at.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' });
    return `${date} at ${at.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })}`;
  }
  return `${cron.schedule}${zone}`;
}

// Tool events become the status line and the Activity rows. A label that mentions the
// agent37 cron CLI or the notify script is the agent keeping its schedule or reaching out.
const TOOLS = [
  [/agent37 cron|cronjob/, '⏰', 'Keeping its schedule'],
  [/\.dots\/notify/, '💬', 'Messaging you'],
  [/responsibilities/, '📌', 'Updating its list'],
  [/delegate/, '🧩', 'Splitting up the work'],
  [/composio|mcp_/, '🔌', 'Using your apps'],
  [/memory|session_search/, '🧠', 'Remembering'],
  [/web_search|brave/, '🔎', 'Searching the web'],
  [/web|browser/, '🌐', 'Reading the web'],
  [/file|patch/, '📝', 'Working on files'],
  [/terminal|process|execute_code/, '💻', 'Using its computer'],
  [/todo/, '🗒️', 'Planning'],
  [/skill/, '📚', 'Reading up'],
  [/vision|image/, '🖼️', 'Looking closely'],
];

function describe(tool, label = '') {
  const hay = `${tool} ${label}`.toLowerCase();
  const [, icon, verb] = TOOLS.find(([re]) => re.test(hay)) || [null, '⚙️', 'Working'];
  const showLabel = label && !/agent37 cron|\.dots\//.test(hay);
  return { icon, verb, status: showLabel ? `${verb}: ${label}` : `${verb}...` };
}

// ---- boot ----

async function boot() {
  me = await request('/api/me');
  if (me.agent && me.status === 'deleted') {
    await send('/api/agent', 'DELETE');
    me = await request('/api/me');
  }
  if (!me.agent) return showMeet();
  applyTheme(me.agent.accent);
  if (!me.agent.setupDone) return runSetup(false);
  showChat();
}

function showStep(id) {
  document.body.classList.remove('chat-ready');
  $('drawer').hidden = true;
  $('chat-screen').hidden = true;
  $('onboard').hidden = false;
  for (const step of ['step-meet', 'step-creating', 'step-apps', 'step-computer']) $(step).hidden = step !== id;
}

// ---- onboarding 1: name it, pick a look and a color ----

const draft = { name: 'Pip', mascot: 'bean', accent: ACCENTS[0] };

function renderPicker(shapesEl, colorsEl, previewEl, onChange) {
  const paint = () => {
    applyTheme(draft.accent);
    previewEl.innerHTML = mascotSvg(draft.mascot, draft.accent, { size: 150 });
    shapesEl.innerHTML = Object.keys(MASCOTS)
      .map((key) => `<button type="button" data-shape="${key}" class="${key === draft.mascot ? 'on' : ''}" aria-pressed="${key === draft.mascot}" aria-label="${MASCOTS[key].label}">${mascotSvg(key, draft.accent, { size: 50 })}</button>`)
      .join('');
    colorsEl.innerHTML = ACCENTS.map((c) => `<button type="button" data-color="${c}" class="${c === draft.accent ? 'on' : ''}" style="--swatch:${c}" aria-pressed="${c === draft.accent}" aria-label="${c}"></button>`).join('');
    onChange?.();
  };
  shapesEl.onclick = (event) => {
    const button = event.target.closest('[data-shape]');
    if (button) (draft.mascot = button.dataset.shape), paint();
  };
  colorsEl.onclick = (event) => {
    const button = event.target.closest('[data-color]');
    if (button) (draft.accent = button.dataset.color), paint();
  };
  paint();
}

function showMeet() {
  showStep('step-meet');
  const nameEl = $('meet-name');
  const updateButton = () => ($('meet-create').textContent = `Create ${nameEl.value.trim() || 'your agent'}`);
  nameEl.oninput = updateButton;
  renderPicker($('meet-shapes'), $('meet-colors'), $('meet-preview'), updateButton);
  $('meet-create').disabled = false;
  $('meet-create').onclick = () => {
    $('meet-create').disabled = true;
    $('meet-error').textContent = '';
    draft.name = nameEl.value.trim() || 'Pip';
    draft.userName = $('meet-username').value.trim();
    runSetup(true);
  };
}

// ---- onboarding 2: create the instance, wait for it, write who it is ----

function markStep(step, state) {
  const li = document.querySelector(`#creating-steps [data-step="${step}"]`);
  li.className = state;
}

async function runSetup(fromCreate) {
  showStep('step-creating');
  const name = fromCreate ? draft.name : me.agent.name;
  $('creating-title').textContent = `Setting up ${name}'s computer`;
  $('creating-mascot').innerHTML = mascotSvg(fromCreate ? draft.mascot : me.agent.mascot, fromCreate ? draft.accent : me.agent.accent, { size: 130 });
  $('creating-error').textContent = '';
  let created = !fromCreate;
  try {
    markStep('create', 'doing');
    if (fromCreate) {
      await post('/api/agent', { ...draft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      created = true;
    }
    markStep('create', 'done');
    markStep('boot', 'doing');
    // "running" means the computer is up; the agent inside is ready once health says so.
    for (let tries = 0; tries < 90; tries++) {
      const { ready } = await request('/api/agent/ready');
      if (ready) break;
      if (tries === 89) throw new Error('It is taking longer than usual to wake up. Reload the page to keep waiting.');
      await delay(4000);
    }
    markStep('boot', 'done');
    markStep('soul', 'doing');
    await post('/api/agent/setup');
    markStep('soul', 'done');
    me = await request('/api/me');
    showAppsStep();
  } catch (err) {
    // A create that failed (no balance, instance limit) goes back to the form with the reason;
    // one that succeeded keeps waiting here, since the agent exists.
    if (created) return ($('creating-error').textContent = err.message);
    showMeet();
    $('meet-error').textContent = err.message;
  }
}

// ---- onboarding 3 (and the Apps sheet): connect apps through managed Composio ----

async function renderApps(container) {
  container.innerHTML = '<input class="apps-search" placeholder="Search apps, e.g. calendar" /><div class="apps-grid"><p class="fine">Loading apps...</p></div>';
  const grid = container.querySelector('.apps-grid');
  const search = container.querySelector('.apps-search');
  let connected = {};

  async function loadConnections() {
    const { connections } = await request('/api/apps/connections');
    connected = {};
    for (const c of connections) if (c.status === 'ACTIVE') connected[c.toolkitSlug] = c.id;
  }

  async function load() {
    const query = search.value.trim();
    try {
      const [{ items }] = await Promise.all([request(`/api/apps${query.length >= 3 ? `?search=${encodeURIComponent(query)}` : ''}`), loadConnections()]);
      const apps = items.filter((app) => app.enabled && !app.isNoAuth);
      grid.innerHTML = apps.length
        ? apps
            .map(
              (app) => `<div class="app-card">
                <img src="${esc(app.logo)}" alt="" loading="lazy" />
                <div class="meta"><strong>${esc(app.name)}</strong><span>${esc(app.description)}</span></div>
                <button data-slug="${esc(app.slug)}" class="${connected[app.slug] ? 'connected' : ''}">${connected[app.slug] ? 'Connected' : 'Connect'}</button>
              </div>`
            )
            .join('')
        : '<p class="fine">No apps match.</p>';
    } catch (err) {
      grid.innerHTML = `<p class="fine error">${esc(err.message)}</p>`;
    }
  }

  grid.onclick = async (event) => {
    const button = event.target.closest('button[data-slug]');
    if (!button) return;
    const slug = button.dataset.slug;
    if (connected[slug]) {
      if (!confirm(`Disconnect ${slug}? ${agentName()} will lose access to it.`)) return;
      await send(`/api/apps/connections/${encodeURIComponent(connected[slug])}`, 'DELETE');
      return load();
    }
    // Open the tab now, while this click still counts as a user gesture; popup blockers
    // refuse a window opened after an await.
    const tab = window.open('about:blank', '_blank');
    button.textContent = 'Waiting...';
    try {
      const { redirectUrl, connectedAccountId } = await post('/api/apps/connect', { toolkit: slug });
      if (tab) tab.location = redirectUrl;
      else location.assign(redirectUrl);
      // Landing back on the callback page proves the user finished the screens, not that
      // the account is live; the connection list is the proof.
      for (let i = 0; i < 90; i++) {
        await delay(3000);
        const { connections } = await request('/api/apps/connections');
        if (connections.some((c) => c.id === connectedAccountId && c.status === 'ACTIVE')) return load();
      }
      button.textContent = 'Connect';
    } catch (err) {
      tab?.close();
      button.textContent = err.code === 'custom_auth_required' ? 'Needs setup' : 'Try again';
    }
  };

  let timer;
  search.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  };
  await load();
}

function showAppsStep() {
  showStep('step-apps');
  $('apps-mascot').innerHTML = mascotSvg(me.agent.mascot, me.agent.accent, { size: 100 });
  $('apps-sub').textContent = `So ${agentName()} can read your email, calendar and files. You can skip this and add them later.`;
  renderApps($('onboard-apps'));
  $('apps-skip').onclick = $('apps-continue').onclick = showComputerStep;
}

function showComputerStep() {
  showStep('step-computer');
  $('computer-welcome-mascot').innerHTML = mascotSvg(me.agent.mascot, me.agent.accent, { size: 90 });
  $('computer-welcome-name').textContent = `${agentName()}'s computer`;
  $('computer-welcome-copy').textContent = me.agent.computer
    ? `${agentName()} can browse, work on files, and follow up while you are away. Open its computer from the chat to watch or take over.`
    : `${agentName()} can browse, work on files, and follow up while you are away. You can find what it creates in Outputs.`;
  $('computer-continue').onclick = showChat;
}

// ---- chat screen ----

function showChat() {
  document.body.classList.add('chat-ready');
  $('drawer').hidden = !desktopLayout.matches;
  $('onboard').hidden = true;
  $('chat-screen').hidden = false;
  applyTheme(me.agent.accent);
  renderHead();
  refreshPanel();
  // Opening a file listing wakes a sleeping instance. Refresh on arrival only if awake,
  // after a turn, or when the user explicitly opens Outputs, never on a polling timer.
  if (me.status === 'running') loadOutputs().catch(() => {});
  if (me.agent.computer) initComputer();
  pollNotifications().then(() => openChat());
  setInterval(pollNotifications, 15000);
  // The status line says whether it is awake; a Hosting API read never wakes it.
  setInterval(async () => {
    me.status = (await request('/api/me').catch(() => me)).status;
    renderStatus();
  }, 60000);
}

function renderHead() {
  $('head-mascot').innerHTML = mascotSvg(me.agent.mascot, me.agent.accent, { size: 64 });
  $('head-name').textContent = me.agent.name;
  $('sidebar-name').textContent = me.agent.name;
  $('sidebar-mascot').innerHTML = mascotSvg(me.agent.mascot, me.agent.accent, { size: 30 });
  $('chat-title').textContent = agentName();
  inputEl.placeholder = `Message ${agentName()}`;
  $('inbox-label').textContent = `Messages from ${agentName()}`;
  $('computer-title').textContent = $('drawer-computer').textContent = `${agentName()}'s computer`;
  $('panel-computer-name').textContent = `${agentName()}'s computer`;
  $('panel-computer-section').hidden = !me.agent.computer;
  renderControl();
  renderStatus();
}

function renderStatus() {
  $('head-mascot').classList.toggle('working', Boolean(inFlight));
  const status = $('head-status');
  status.classList.toggle('paused', !inFlight && me.agent.paused);
  if (inFlight) status.textContent = inFlight.status;
  else if (me.agent.paused) status.textContent = 'Paused · Tap to resume';
  else status.textContent = { sleeping: 'Resting · wakes when you write', waking: 'Waking up', stopped: 'Stopped' }[me.status] || 'Online';
  $('chat-title').textContent = inFlight ? inFlight.status : agentName();
  $('activity-live').hidden = !inFlight;
}

function setStatus(text, icon) {
  if (!inFlight) return;
  inFlight.status = text;
  if (icon) inFlight.icon = icon;
  renderStatus();
  if (!$('activity-card').hidden) renderActivityNow();
  renderPanelActivity();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (role === 'agent') el.innerHTML = md(text);
  else el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addNote(text, className = '') {
  const el = document.createElement('div');
  el.className = `note ${className}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addFirstMessage(notification) {
  const tag = document.createElement('div');
  tag.className = 'first-tag';
  tag.textContent = `${agentName()} messaged you first · ${new Date(notification.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  messagesEl.appendChild(tag);
  addBubble('agent', notification.title ? `**${notification.title}**\n${notification.text}` : notification.text);
}

function emptyState() {
  messagesEl.innerHTML = `<div class="empty-chat">
    <p>Hand ${esc(agentName())} something to own. It checks back on its own schedule.</p>
    <div class="sheet-rows">
      ${[
        'Remind me to stretch in 5 minutes',
        'Every weekday at 9, tell me the top story on Hacker News',
        'Keep an eye on the price of a Kindle Paperwhite and tell me if it drops',
      ]
        .map((s) => `<button class="linkrow" data-suggest="${esc(s)}">${esc(s)}</button>`)
        .join('')}
    </div>
  </div>`;
}

messagesEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-suggest]');
  if (button && !inFlight) sendTurn(button.dataset.suggest);
});

// What the app said on the user's behalf is marked; show only what the user typed.
function visibleUserText(content) {
  if (!content.startsWith(APP_CONTEXT)) return content;
  const end = content.indexOf(APP_CONTEXT_END);
  return end === -1 ? '' : content.slice(end + APP_CONTEXT_END.length).trim();
}

async function openChat() {
  if (inFlight || loadingChat) return false;
  loadingChat = true;
  inputEl.disabled = sendBtn.disabled = true;
  view = 'chat';
  replyTo = [];
  messagesEl.innerHTML = '';
  renderNavigation();
  let introduce = false;
  try {
    const { session_id } = await request('/api/chat');
    if (!session_id) introduce = true;
    else {
      const session = await request(`/api/sessions/${session_id}`);
      for (const message of session.history) {
        if (message.role === 'user') {
          const text = visibleUserText(message.content);
          if (text) addBubble('user', text);
        } else if (message.role === 'assistant' && message.content) addBubble('agent', message.content);
      }
      if (!session.history.length && !session.active_response_id) emptyState();
      // Reloading during a reply rejoins the same turn.
      if (session.active_response_id) reattach(session.active_response_id, 'Working');
    }
  } catch (err) {
    addNote(err.message, 'error');
    return false;
  } finally {
    loadingChat = false;
    inputEl.disabled = sendBtn.disabled = false;
  }
  showUnreadInline();
  if (introduce) startIntro();
  return true;
}

// ---- streaming a turn (the parser and reattach loop come from hermes-chat) ----

async function* sseFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!frame.trim() || frame.startsWith(':')) continue;
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

const MAX_RECOVERY_ATTEMPTS = 8;
const RECOVERY_DELAY_MS = 1500;

function newAgentBubble() {
  const bubble = addBubble('agent', '');
  bubble.classList.add('typing');
  return bubble;
}

// Consume one SSE stream into `bubble`; returns whether a terminal event arrived.
async function consumeStream(response, bubble) {
  let text = '';
  let terminal = null;
  for await (const { event, data } of sseFrames(response)) {
    switch (event) {
      case 'response.created':
        inFlight.responseId = data.id;
        me.status = 'running';
        [...messagesEl.querySelectorAll('.receipt')].pop()?.replaceChildren('Read');
        setStatus('Thinking...');
        break;
      case 'response.reasoning.delta':
        setStatus('Thinking...');
        break;
      case 'response.output_text.delta':
        text += data.text;
        bubble.classList.remove('typing');
        bubble.innerHTML = md(text);
        scrollToBottom();
        setStatus('Typing...');
        break;
      case 'response.tool_call.generating':
        setStatus(`${describe(data.tool).verb}...`, describe(data.tool).icon);
        break;
      case 'response.tool_call.started': {
        const d = describe(data.tool, data.label);
        inFlight.tools.push(d.verb);
        setStatus(d.status, d.icon);
        break;
      }
      case 'response.completed':
        terminal = { ok: true, text: (data.output_text ?? '').replace(/^\n+/, '') };
        break;
      case 'response.failed':
        terminal = { ok: false, error: data.error };
        break;
    }
  }
  return terminal;
}

async function runStream(openStream, bubble) {
  let terminal = null;
  try {
    terminal = await consumeStream(await openStream(), bubble);
  } catch {
    // Network drop mid-stream; the reattach loop below recovers.
  }
  // A stream that closes without a terminal event is usually still running server-side.
  // Reattach: the replay re-sends every event from the start, then resumes live.
  let attempts = 0;
  while (!terminal && inFlight?.responseId && attempts < MAX_RECOVERY_ATTEMPTS) {
    attempts += 1;
    if (attempts > 1) await delay(RECOVERY_DELAY_MS);
    try {
      const replay = await fetch(`/api/responses/${inFlight.responseId}/stream`);
      if (!replay.headers.get('content-type')?.includes('text/event-stream')) throw new Error('not a stream');
      bubble.remove();
      bubble = newAgentBubble();
      inFlight.tools = [];
      terminal = await consumeStream(replay, bubble);
    } catch {
      // Still unreachable, or no longer retained; back off and retry.
    }
  }
  if (terminal?.ok) {
    bubble.classList.remove('typing');
    if (terminal.text) bubble.innerHTML = md(terminal.text);
    else bubble.remove();
    if (!terminal.text && !inFlight.tools.length && !inFlight.cancelled) {
      addNote('The reply came back empty. That usually means its monthly budget or the workspace balance ran out.', 'error');
    }
  } else {
    bubble.remove();
    addNote(terminal ? terminal.error?.message || 'The turn failed.' : 'Lost the connection. Reload to see the reply.', 'error');
  }
  return terminal;
}

async function finishTurn(terminal) {
  const turn = inFlight;
  inFlight = null;
  setBusy(false);
  renderStatus();
  const rank = (verb) => TOOLS.findIndex(([, , v]) => v === verb);
  const verbs = [...new Set(turn.tools)].sort((a, b) => rank(a) - rank(b));
  const status = turn.cancelled ? 'Stopped' : !terminal?.ok ? 'Failed' : verbs.length ? `Done · ${verbs.slice(0, 2).join(', ')}` : 'Replied';
  await post('/api/activity', { title: turn.title, status, icon: turn.icon }).catch(() => {});
  if (!$('activity-card').hidden) renderActivity();
  refreshPanel();
  loadOutputs().catch(() => {});
}

async function sendTurn(text, { intro = false } = {}) {
  if (inFlight || loadingChat) return;
  if (view === 'inbox') {
    const replyingTo = replyTo;
    if (!(await openChat()) || inFlight) {
      inputEl.value = text;
      return;
    }
    replyTo = [...new Set([...replyTo, ...replyingTo])];
  }
  messagesEl.querySelector('.empty-chat')?.remove();
  if (text) {
    messagesEl.querySelectorAll('.receipt').forEach((r) => r.remove());
    addBubble('user', text);
    const receipt = document.createElement('div');
    receipt.className = 'receipt';
    receipt.textContent = 'Delivered';
    messagesEl.appendChild(receipt);
  }
  // Asking it to do something hands its computer back, and tells it you were there.
  if (computer.mine) setControl(false);
  const tookOver = computer.tookOver;
  computer.tookOver = false;
  const body = { input: text, stream: true, ...(intro ? { intro: true } : {}), ...(replyTo.length ? { replying_to: replyTo } : {}), ...(tookOver ? { took_over: true } : {}) };
  if (replyTo.length) {
    post('/api/notifications/read').catch(() => {});
    allNotifications.forEach((n) => (n.read = true));
  }
  replyTo = [];
  updateUnread();
  inFlight = { responseId: null, title: intro ? 'Introducing itself' : text.slice(0, 80), status: me.status === 'sleeping' ? 'Waking up...' : 'Thinking...', icon: '💭', tools: [] };
  setBusy(true);
  renderStatus();
  const bubble = newAgentBubble();

  let response;
  try {
    response = await fetch('/api/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    bubble.remove();
    addNote(`Could not reach the server: ${err.message}`, 'error');
    return finishTurn(null);
  }
  // Failures before the stream starts (busy session, bad request) come back as JSON.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = await response.json().catch(() => null);
    bubble.remove();
    addNote(payload?.error?.code === 'session_busy' ? 'It is still working on your last message.' : payload?.error?.message || `Request failed (HTTP ${response.status}).`, 'error');
    return finishTurn(null);
  }
  const terminal = await runStream(async () => response, bubble);
  await finishTurn(terminal);
}

async function reattach(responseId, title) {
  inFlight = { responseId, title, status: 'Working...', icon: '⚙️', tools: [] };
  setBusy(true);
  renderStatus();
  const bubble = newAgentBubble();
  const terminal = await runStream(() => fetch(`/api/responses/${responseId}/stream`), bubble);
  await finishTurn(terminal);
}

// The hidden first turn: the server adds the brief, and history never shows it.
function startIntro() {
  messagesEl.innerHTML = '';
  sendTurn('', { intro: true });
}

async function cancelTurn(responseId) {
  try {
    // Cancel is asynchronous: the stream then ends with response.completed (partial text).
    if (inFlight?.responseId === responseId) inFlight.cancelled = true;
    await post(`/api/responses/${responseId}/cancel`);
  } catch (err) {
    addNote(`Could not stop it: ${err.message}`, 'error');
  }
}

stopBtn.addEventListener('click', () => inFlight?.responseId && cancelTurn(inFlight.responseId));

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || inFlight || loadingChat) return;
  inputEl.value = '';
  inputEl.style.height = '';
  sendTurn(text);
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

// ---- navigation drawer ----

function renderNavigation() {
  $('sidebar-agent').classList.toggle('on', view === 'chat');
  $('open-inbox').classList.toggle('on', view === 'inbox');
}

function openDrawer() {
  renderNavigation();
  $('drawer').hidden = false;
}
function closeDrawer() {
  $('drawer').hidden = !desktopLayout.matches;
}
$('menu-btn').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
desktopLayout.addEventListener('change', () => {
  if (me?.agent && !$('chat-screen').hidden) closeDrawer();
});
$('sidebar-agent').onclick = () => { closeDrawer(); openChat(); };
$('drawer').addEventListener('click', (event) => event.target.id === 'drawer' && closeDrawer());
$('open-inbox').onclick = () => {
  closeDrawer();
  if (!inFlight && !loadingChat) openInbox();
};
document.querySelectorAll('[data-open]').forEach((button) => {
  button.onclick = () => {
    closeDrawer();
    ({ apps: openAppsSheet, outputs: openOutputs, memory: openMemory, profile: () => openProfile(), computer: () => showComputer(true) })[button.dataset.open]();
  };
});

// ---- messages it sent first ----

let allNotifications = [];

async function pollNotifications() {
  try {
    const { data } = await request('/api/notifications');
    allNotifications = data;
    const fresh = knownNotifications ? data.filter((n) => !knownNotifications.has(n.id)) : [];
    knownNotifications = new Set(data.map((n) => n.id));
    for (const n of fresh) {
      showToast(n);
      if (view === 'inbox' || !inFlight) {
        addFirstMessage(n);
        if (view === 'chat') replyTo.push(n.id);
      }
    }
    updateUnread();
  } catch {}
}

function updateUnread() {
  const unread = allNotifications.filter((n) => !n.read).length;
  for (const id of ['menu-badge', 'inbox-badge']) {
    $(id).hidden = !unread;
    $(id).textContent = unread;
  }
  document.title = unread ? `(${unread}) Build your own Dots` : 'Build your own Dots';
}

// Unread messages show up at the bottom of whatever chat is open, and a reply there carries
// them to the agent as context, since they came from a different (check-in) chat.
function showUnreadInline() {
  for (const n of allNotifications.filter((n) => !n.read)) {
    addFirstMessage(n);
    if (view === 'chat') replyTo.push(n.id);
  }
}

function openInbox() {
  view = 'inbox';
  replyTo = [];
  messagesEl.innerHTML = '';
  if (!allNotifications.length) addNote(`Nothing yet. When ${agentName()} finds something on a check-in, it messages you here.`);
  for (const n of allNotifications) addFirstMessage(n);
  replyTo = allNotifications.slice(-3).map((n) => n.id);
  post('/api/notifications/read').catch(() => {});
  allNotifications.forEach((n) => (n.read = true));
  updateUnread();
  renderNavigation();
}

function showToast(n) {
  const toast = $('toast');
  toast.innerHTML = `${mascotSvg(me.agent.mascot, me.agent.accent, { size: 40 })}<div><strong>${esc(agentName())}</strong><span>${esc(n.text)}</span></div>`;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 7000);
  toast.onclick = () => {
    toast.hidden = true;
    scrollToBottom();
  };
}

// ---- its computer: watch it work, take over, hand it back ----
//
// Only for agents created from DESKTOP_TEMPLATE. noVNC draws the screen over a WebSocket URL
// the server mints with a 60-second signed token; an open socket outlives the token, and
// every reconnect asks for a fresh one. View-only is a setting in this page, not a permission.
// The pane lets go of the socket while the tab is hidden, so a forgotten tab never keeps
// the instance awake.

// noVNC is plain ES modules, so the page imports a pinned release straight from a CDN: no
// install, no build step.
const NOVNC = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/core/rfb.js';
const computer = { RFB: null, rfb: null, connecting: false, mine: false, tookOver: false, retry: 0, timer: null };

function initComputer() {
  $('drawer-computer').hidden = false;
  showComputer(false);
  document.addEventListener('visibilitychange', () => (document.hidden ? disconnectComputer() : connectComputer()));
}

function showComputer(open) {
  $('computer-pane').hidden = !open;
  if (open) connectComputer();
  else disconnectComputer();
}

function setComputerState(text) {
  $('computer-state').hidden = !text;
  $('computer-state').textContent = text;
}

async function connectComputer() {
  clearTimeout(computer.timer);
  if (computer.rfb || computer.connecting || $('computer-pane').hidden || document.hidden) return;
  computer.connecting = true;
  setComputerState(me.status === 'sleeping' ? 'Waking its computer...' : 'Connecting...');
  try {
    computer.RFB ||= (await import(NOVNC)).default;
    const { ws } = await post('/api/computer');
    const rfb = new computer.RFB($('computer-screen'), ws);
    rfb.scaleViewport = true;
    rfb.background = '#111';
    rfb.viewOnly = !computer.mine;
    rfb.addEventListener('connect', () => {
      computer.retry = 0;
      setComputerState('');
    });
    rfb.addEventListener('disconnect', () => {
      if (computer.rfb !== rfb) return;
      computer.rfb = null;
      setComputerState('Reconnecting...');
      reconnectComputer();
    });
    computer.rfb = rfb;
    if ($('computer-pane').hidden || document.hidden) disconnectComputer();
  } catch (err) {
    setComputerState(err.message);
    reconnectComputer();
  } finally {
    computer.connecting = false;
  }
}

function reconnectComputer() {
  clearTimeout(computer.timer);
  computer.timer = setTimeout(connectComputer, Math.min(30_000, 1000 * 2 ** computer.retry++));
}

function disconnectComputer() {
  clearTimeout(computer.timer);
  const rfb = computer.rfb;
  computer.rfb = null;
  rfb?.disconnect();
}

// Take over stops whatever it is doing, so the two of you never fight over the mouse.
function setControl(mine) {
  computer.mine = mine;
  if (mine) {
    computer.tookOver = true;
    if (inFlight?.responseId) cancelTurn(inFlight.responseId);
  }
  if (computer.rfb) {
    computer.rfb.viewOnly = !mine;
    if (mine) computer.rfb.focus();
  }
  renderControl();
}

function renderControl() {
  $('control-label').textContent = computer.mine ? 'You have control' : `${agentName()} has control`;
  $('control-btn').textContent = computer.mine ? 'Return control' : 'Take over';
}

$('control-btn').onclick = () => setControl(!computer.mine);
$('computer-close').onclick = () => showComputer(false);

// ---- the agent panel and output files ----

let panelActivity = [];
let outputFiles = [];

function renderPanelActivity() {
  const recent = inFlight
    ? [{ title: inFlight.title, status: inFlight.status }, ...panelActivity.slice(0, 1)]
    : panelActivity.slice(0, 2);
  $('panel-recent').innerHTML = recent.map(a => `<button class="panel-recent-row"><strong>${esc(a.title)}</strong><span>${esc(a.status)}${a.at ? ` · ${rel(a.at)}` : ''}</span></button>`).join('') || '<p class="panel-empty">No activity yet</p>';
}

async function refreshPanel() {
  try {
    panelActivity = (await request('/api/activity')).data;
    renderPanelActivity();
  } catch {}
}

$('customize-btn').onclick = openEdit;
$('panel-schedule').onclick = () => openProfile('scheduled');
$('panel-activity').onclick = $('panel-recent').onclick = () => {
  $('activity-card').hidden = false;
  renderActivity();
};
$('composer-files').onclick = openOutputs;

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const outputUrl = name => `/api/outputs/${encodeURIComponent(name)}`;
const fileType = name => name.includes('.') ? name.split('.').pop().slice(0, 5) : 'file';

function outputRow(file) {
  return `<div class="output-row"><button class="output-open" data-output="${esc(file.name)}"><span class="file-icon">${esc(fileType(file.name))}</span><span class="output-info"><strong>${esc(file.name)}</strong><small>${fileSize(file.size)} · ${rel(file.modified)}</small></span></button><a class="output-download" href="${esc(outputUrl(file.name))}" download aria-label="Download ${esc(file.name)}">↓</a></div>`;
}

async function loadOutputs() {
  outputFiles = (await request('/api/outputs')).data;
  $('panel-outputs').innerHTML = outputFiles.slice(0, 3).map(outputRow).join('') || '<p class="panel-empty">No outputs yet</p>';
  return outputFiles;
}

$('panel-outputs').onclick = (event) => {
  const button = event.target.closest('[data-output]');
  if (button) openOutput(button.dataset.output);
};

async function openOutputs() {
  const body = openSheet(`<h2>Outputs</h2><div class="outputs-toolbar"><p>Files ${esc(agentName())} has made for you.</p><button class="mini-btn" id="refresh-outputs">Refresh</button></div><div id="output-list"><p class="fine">Loading files...</p></div>`, { wide: true });
  const list = body.querySelector('#output-list');
  const refresh = body.querySelector('#refresh-outputs');
  const load = async () => {
    refresh.disabled = true;
    try {
      const files = await loadOutputs();
      list.innerHTML = files.map(outputRow).join('') || `<div class="output-empty"><span class="file-icon" style="margin:auto">file</span><strong>No outputs yet</strong>Ask ${esc(agentName())} to make a document, spreadsheet, or image.<br />It will appear here when it is ready.</div>`;
    } catch (err) {
      list.innerHTML = `<p class="error">Could not load files: ${esc(err.message)}</p>`;
    } finally { refresh.disabled = false; }
  };
  refresh.onclick = load;
  list.onclick = (event) => {
    const button = event.target.closest('[data-output]');
    if (button) openOutput(button.dataset.output);
  };
  await load();
}

async function openOutput(name) {
  const file = outputFiles.find(f => f.name === name);
  if (!file) return;
  const body = openSheet(`<button class="mini-btn" id="back-outputs">← Outputs</button><h2 class="file-preview-title" style="margin-top:18px">${esc(name)}</h2><div class="outputs-toolbar"><p>${fileSize(file.size)}</p><a class="mini-btn output-download" href="${esc(outputUrl(name))}" download>Download</a></div><div id="output-preview"></div>`, { wide: true });
  body.querySelector('#back-outputs').onclick = openOutputs;
  const preview = body.querySelector('#output-preview');
  const text = /\.(txt|md|csv|json|html?|svg|js|ts|py|css|ya?ml|xml|log)$/i.test(name);
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
  if ((!text && !image) || file.size > (image ? 10 : 1) * 1024 * 1024) {
    preview.innerHTML = '<p class="fine">Download this file to open it.</p>';
    return;
  }
  preview.innerHTML = '<p class="fine">Loading preview...</p>';
  try {
    const response = await fetch(outputUrl(name));
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || 'Could not read this file.');
    const content = image ? await response.blob() : await response.text();
    if (!preview.isConnected || $('sheet').hidden) return;
    preview.replaceChildren();
    // Text (including HTML/SVG) never executes on our origin. Images use a blob URL.
    if (image) {
      previewUrl = URL.createObjectURL(content);
      const img = document.createElement('img');
      img.className = 'image-preview';
      img.alt = name;
      img.src = previewUrl;
      preview.appendChild(img);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'file-preview';
      pre.textContent = content;
      preview.appendChild(pre);
    }
  } catch (err) { preview.textContent = err.message; }
}

// ---- activity card ----

$('activity-btn').onclick = () => {
  const card = $('activity-card');
  card.hidden = !card.hidden;
  if (!card.hidden) renderActivity();
};
$('activity-close').onclick = () => ($('activity-card').hidden = true);

function row({ icon, title, status, active = false, actions = '', below = '', attrs = '' }) {
  return `<div class="act-row ${active ? 'active' : ''} ${attrs ? 'clickable' : ''}" ${attrs}>
    <div class="tile">${esc(icon)}</div>
    <div class="act-text ${below ? 'wrap' : ''}"><strong>${esc(title)}</strong><span>${esc(status)}</span>${below}</div>
    ${actions}
  </div>`;
}

const stopButton = (id) => (id ? `<button class="stop-round" data-stop="${id}" aria-label="Stop"><span></span></button>` : '');

let progress = { responsibilities: [], running: [] };

// In progress: the live turn, check-ins running right now, and the responsibilities the
// agent keeps on its own list.
function progressRows() {
  const rows = [];
  if (inFlight) rows.push(row({ icon: inFlight.icon, title: inFlight.title, status: inFlight.status, active: true, actions: stopButton(inFlight.responseId) }));
  for (const r of progress.running) {
    if (r.response_id !== inFlight?.responseId) rows.push(row({ icon: '⏰', title: r.name, status: 'Checking in now', active: true, actions: stopButton(r.response_id) }));
  }
  for (const r of progress.responsibilities) rows.push(row({ icon: '📌', title: r.title, status: r.status || 'On it' }));
  return rows.join('');
}

function renderActivityNow() {
  $('activity-now').innerHTML = progressRows() || `<div class="act-empty">Nothing running right now.</div>`;
}

async function renderActivity() {
  renderActivityNow();
  try {
    const { data } = await request('/api/activity');
    $('activity-past').innerHTML = data.map((a) => row({ icon: a.icon || '💬', title: a.title, status: `${a.status} · ${rel(a.at)}` })).join('') || `<div class="act-empty">No past activity yet.</div>`;
    progress = await request('/api/progress');
    renderActivityNow();
  } catch {}
}

$('activity-card').addEventListener('click', (event) => {
  const stop = event.target.closest('[data-stop]');
  if (stop?.dataset.stop) cancelTurn(stop.dataset.stop);
});

// ---- sheets ----

let sheetTrigger = null;
let previewUrl = null;

function openSheet(html, { wide = false, customize = false } = {}) {
  if ($('sheet').hidden) sheetTrigger = document.activeElement;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('sheet-body').innerHTML = html;
  document.querySelector('.sheet').classList.toggle('wide', wide);
  document.querySelector('.sheet').classList.toggle('customize', customize);
  $('sheet').hidden = false;
  const dialog = document.querySelector('.sheet');
  dialog.setAttribute('aria-label', $('sheet-body').querySelector('h2')?.textContent || 'Agent details');
  dialog.focus();
  return $('sheet-body');
}
function closeSheet() {
  $('sheet').hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (me?.agent) applyTheme(me.agent.accent);
  sheetTrigger?.focus();
}
$('sheet-close').onclick = closeSheet;
$('sheet').addEventListener('click', (event) => event.target.id === 'sheet' && closeSheet());
document.addEventListener('keydown', (event) => {
  if (!$('sheet').hidden) {
    if (event.key === 'Escape') closeSheet();
    if (event.key === 'Tab') {
      const controls = [...$('sheet').querySelectorAll('button:not(:disabled), a[href], input, textarea, select')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === document.querySelector('.sheet'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  } else if (event.key === 'Escape') {
    closeDrawer();
    $('activity-card').hidden = true;
    if (me?.agent?.computer) showComputer(false);
  }
});

$('profile-btn').onclick = () => openProfile();

async function openProfile(tab = 'progress') {
  const a = me.agent;
  const body = openSheet(`
    <div class="more-wrap">
      <button class="icon-btn" id="more-btn" aria-label="More">&middot;&middot;&middot;</button>
      <div class="menu" id="more-menu" hidden>
        <button id="pause-btn">${a.paused ? 'Resume' : 'Pause'} ${esc(a.name)}</button>
        <button id="reset-btn" class="danger">Reset ${esc(a.name)}</button>
      </div>
    </div>
    <div class="profile-top">
      ${mascotSvg(a.mascot, a.accent, { size: 96 })}
      <div class="profile-name"><h2>${esc(a.name)}</h2><button class="icon-btn" id="edit-btn" aria-label="Edit">&#9998;</button></div>
      ${a.paused ? '<button class="paused-pill" id="resume-pill">Paused · Tap to resume</button>' : ''}
    </div>
    <div class="tabs">
      <button data-tab="progress">In progress</button>
      <button data-tab="scheduled">Scheduled</button>
      <button data-tab="completed">Completed</button>
    </div>
    <div id="tab-body" class="sheet-rows"></div>
    <h3>Customize</h3>
    <button class="linkrow" id="link-apps"><span>Apps</span><span>&rsaquo;</span></button>
    <button class="linkrow" id="link-memory"><span>Memory</span><span>&rsaquo;</span></button>
    ${a.computer ? `<button class="linkrow" id="link-computer"><span>${esc(a.name)}'s computer</span><span>&rsaquo;</span></button>` : ''}
  `);
  body.querySelector('#more-btn').onclick = () => (body.querySelector('#more-menu').hidden = !body.querySelector('#more-menu').hidden);
  body.querySelector('#pause-btn').onclick = togglePause;
  body.querySelector('#resume-pill')?.addEventListener('click', togglePause);
  body.querySelector('#reset-btn').onclick = resetAgent;
  body.querySelector('#edit-btn').onclick = openEdit;
  body.querySelector('#link-apps').onclick = openAppsSheet;
  body.querySelector('#link-memory').onclick = openMemory;
  body.querySelector('#link-computer')?.addEventListener('click', () => {
    closeSheet();
    showComputer(true);
  });
  const tabs = body.querySelector('.tabs');
  tabs.onclick = (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  };
  showTab(tab);
}

// Each tab renders off-screen and is swapped in only if it is still the tab showing, so a
// slow tab can never overwrite the one the user switched to.
let tabSeq = 0;

async function showTab(tab) {
  const seq = ++tabSeq;
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('tab-body').innerHTML = '<div class="act-empty">Loading...</div>';
  const el = document.createElement('div');
  el.className = 'sheet-rows';
  try {
    await { progress: renderProgressTab, scheduled: renderScheduledTab, completed: renderCompletedTab }[tab](el);
  } catch (err) {
    el.innerHTML = `<div class="act-empty error">${esc(err.message)}</div>`;
  }
  if (seq !== tabSeq || !$('tab-body')) return;
  $('tab-body').replaceWith(el);
  el.id = 'tab-body';
}

async function renderProgressTab(el) {
  progress = await request('/api/progress');
  el.innerHTML = progressRows() || `<div class="act-empty">Nothing yet. Hand ${esc(agentName())} something ongoing, like "keep an eye on flight prices to Lisbon".</div>`;
  el.onclick = (event) => {
    const stop = event.target.closest('[data-stop]');
    if (stop?.dataset.stop) cancelTurn(stop.dataset.stop).then(() => showTab('progress'));
  };
}

const PRESETS = [
  ['0 9 * * *', 'Every morning at 9'],
  ['0 9 * * 1-5', 'Every weekday at 9'],
  ['0 * * * *', 'Every hour'],
  ['0 9 * * 1', 'Every Monday at 9'],
  ['custom', 'Custom (cron expression)'],
];

async function renderScheduledTab(el) {
  const { data } = await request('/api/schedule');
  const timezone = me.agent.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  el.innerHTML = `
    <button class="linkrow" id="new-task"><span>+ New task</span><span></span></button>
    <form class="task-form" id="task-form" hidden>
      <textarea name="prompt" rows="3" placeholder="What should ${esc(agentName())} do?" required></textarea>
      <div class="row">
        <select name="preset">${PRESETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input name="custom" placeholder="0 9 * * *" hidden />
      </div>
      <input name="name" placeholder="Name (optional)" maxlength="80" />
      <div class="row-actions"><span class="counter">Times are in ${esc(timezone)}</span><button class="cta small" type="submit">Schedule</button></div>
    </form>
    ${
      data
        .map((c) =>
          row({
            icon: c.enabled ? '⏰' : '⏸️',
            title: c.name || c.prompt,
            status: `${humanSchedule(c, timezone)} · ${c.enabled ? `next ${rel(c.next_run * 1000)}` : 'Paused'} · Set by ${c.set_by === 'you' ? 'you' : agentName()}`,
            below: `<div class="row-btns"><button class="mini-btn" data-run="${c.id}">Run now</button>${me.agent.paused ? '' : `<button class="mini-btn" data-toggle="${c.id}" data-enabled="${c.enabled}">${c.enabled ? 'Pause' : 'Resume'}</button>`}<button class="mini-btn danger" data-delete="${c.id}">Delete</button></div>`,
          })
        )
        .join('') || `<div class="act-empty">No schedule yet. Ask ${esc(agentName())} to check on something regularly, or add a task here.</div>`
    }`;
  const form = el.querySelector('#task-form');
  el.querySelector('#new-task').onclick = () => (form.hidden = !form.hidden);
  form.preset.onchange = () => (form.custom.hidden = form.preset.value !== 'custom');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const schedule = form.preset.value === 'custom' ? form.custom.value.trim() : form.preset.value;
    try {
      await post('/api/schedule', { prompt: form.prompt.value.trim(), name: form.name.value.trim(), schedule, timezone });
      showTab('scheduled');
    } catch (err) {
      alert(err.message);
    }
  };
  el.onclick = async (event) => {
    const t = event.target;
    try {
      if (t.dataset.run) {
        t.textContent = 'Started';
        await post(`/api/schedule/${t.dataset.run}/run`);
      } else if (t.dataset.toggle) {
        await send(`/api/schedule/${t.dataset.toggle}`, 'PATCH', { enabled: t.dataset.enabled !== 'true' });
        showTab('scheduled');
      } else if (t.dataset.delete && confirm('Delete this task?')) {
        await send(`/api/schedule/${t.dataset.delete}`, 'DELETE');
        showTab('scheduled');
      }
    } catch (err) {
      alert(err.message);
    }
  };
}

async function renderCompletedTab(el) {
  const { data } = await request('/api/schedule/runs');
  el.innerHTML =
    data
      .map((r) =>
        row({
          icon: r.status === 'triggered' ? '✅' : '⏭️',
          title: r.name,
          status: `${r.status === 'triggered' ? 'Checked in' : `Skipped: ${(r.reason || '').replaceAll('_', ' ')}`} · ${rel(r.ran_at * 1000)}`,
          attrs: r.session_id ? `data-open-session="${r.session_id}"` : '',
        })
      )
      .join('') || `<div class="act-empty">No check-ins yet.</div>`;
  el.onclick = async (event) => {
    const target = event.target.closest('[data-open-session]');
    if (!target) return;
    // Check-ins run in background sessions. Inspect them without switching the chat.
    const body = openSheet('<h2>Scheduled check-in</h2><div class="checkin-history"><p class="fine">Loading...</p></div>', { wide: true });
    const history = body.querySelector('.checkin-history');
    try {
      const session = await request(`/api/sessions/${target.dataset.openSession}`);
      history.innerHTML = session.history
        .filter((message) => message.role === 'assistant' && message.content)
        .map((message) => `<div class="bubble agent">${md(message.content)}</div>`)
        .join('') || '<p class="fine">No reply yet.</p>';
      if (session.active_response_id) history.insertAdjacentHTML('beforeend', '<p class="fine">This check-in is still running.</p>');
    } catch (err) {
      history.textContent = err.message;
    }
  };
}

async function togglePause() {
  try {
    const { paused } = await post(me.agent.paused ? '/api/agent/resume' : '/api/agent/pause');
    me.agent.paused = paused;
    renderStatus();
    if (!$('sheet').hidden && document.querySelector('.profile-top')) openProfile('scheduled');
  } catch (err) {
    alert(err.message);
  }
}

async function resetAgent() {
  if (!confirm(`Reset ${agentName()}? This deletes its computer, memory, chats and connected apps, then starts over.`)) return;
  await send('/api/agent', 'DELETE');
  location.reload();
}

function openEdit() {
  Object.assign(draft, { name: me.agent.name, mascot: me.agent.mascot, accent: me.agent.accent });
  const body = openSheet(`
    <div class="customize-card">
      <div class="customize-options">
        <h2>Customize your agent</h2>
        <div class="field"><span>Colors</span><div id="edit-colors" class="swatches"></div></div>
        <div class="field"><span>Characters</span><div id="edit-shapes" class="picker"></div></div>
      </div>
      <div class="customize-preview">
        <label class="field"><span class="sr-only">Name</span><input id="edit-name" maxlength="24" value="${esc(draft.name)}" /></label>
        <div class="hero-mascot" id="edit-preview"></div>
        <button class="cta" id="edit-save">Save</button>
      </div>
    </div>
  `, { customize: true });
  renderPicker(body.querySelector('#edit-shapes'), body.querySelector('#edit-colors'), body.querySelector('#edit-preview'));
  const saveButton = body.querySelector('#edit-save');
  saveButton.onclick = async () => {
    saveButton.disabled = true;
    const name = body.querySelector('#edit-name').value.trim() || me.agent.name;
    try {
      const { agent } = await send('/api/agent', 'PATCH', { ...(name !== me.agent.name ? { name } : {}), mascot: draft.mascot, accent: draft.accent });
      me.agent = agent;
      applyTheme(agent.accent);
      renderHead();
      if (saveButton.isConnected) closeSheet();
    } catch (err) {
      saveButton.disabled = false;
      alert(err.message);
    }
  };
}

function openAppsSheet() {
  const body = openSheet(`<h2>Apps</h2><p class="fine" style="text-align:left;margin:6px 0 14px">Connected apps let ${esc(agentName())} read and act for you. Sign-in happens with the app itself; ${esc(agentName())} never sees your password.</p><div id="sheet-apps"></div>`, { wide: true });
  renderApps(body.querySelector('#sheet-apps'));
}

// ---- memory: every note it keeps, editable ----

async function openMemory() {
  const body = openSheet(`<h2>What ${esc(agentName())} remembers</h2><p class="fine" style="text-align:left;margin:6px 0 4px">These notes ride along in every conversation. Edit or delete anything.</p><div id="mem-body"><div class="act-empty">Loading...</div></div>`, { wide: true });
  const holder = body.querySelector('#mem-body');
  try {
    const files = await request('/api/memory');
    holder.innerHTML = '';
    for (const [key, title] of [['user', 'About you'], ['memory', 'Its own notes']]) holder.appendChild(memorySection(key, title, files[key]));
  } catch (err) {
    holder.innerHTML = `<div class="act-empty error">${esc(err.message)}</div>`;
  }
}

// Hermes stores memory as entries separated by a line holding a single section sign.
function memorySection(key, title, file) {
  const section = document.createElement('section');
  let state = { ...file };
  const entries = () => [...section.querySelectorAll('textarea')].map((t) => t.value.trim()).filter(Boolean);
  const count = () => {
    const length = entries().join('\n§\n').length;
    const counter = section.querySelector('.counter');
    counter.textContent = `${length.toLocaleString()} / ${MEMORY_CAPS[key].toLocaleString()} characters`;
    counter.classList.toggle('over', length > MEMORY_CAPS[key]);
    // Hermes refuses its own next memory write past the cap, so the editor does not save one.
    section.querySelector('[data-save]').disabled = length > MEMORY_CAPS[key];
  };
  const entryHtml = (text) => `<div class="mem-entry"><textarea rows="2">${esc(text)}</textarea><button class="x" data-remove aria-label="Delete">&times;</button></div>`;
  const render = () => {
    const list = state.content.split('\n§\n').map((e) => e.trim()).filter(Boolean);
    section.innerHTML = `<h3>${title}</h3><div class="entries">${list.map(entryHtml).join('') || '<div class="act-empty">Nothing yet.</div>'}</div>
      <div class="mem-foot"><button class="mini-btn" data-add>+ Add a note</button><span class="counter"></span><button class="cta small" data-save>Save</button></div>`;
    count();
  };
  section.addEventListener('input', count);
  section.addEventListener('click', async (event) => {
    if (event.target.closest('[data-remove]')) {
      event.target.closest('.mem-entry').remove();
      count();
    }
    if (event.target.closest('[data-add]')) {
      section.querySelector('.entries .act-empty')?.remove();
      section.querySelector('.entries').insertAdjacentHTML('beforeend', entryHtml(''));
      [...section.querySelectorAll('.entries textarea')].pop()?.focus();
    }
    const save = event.target.closest('[data-save]');
    if (save) {
      save.disabled = true;
      try {
        state = await send(`/api/memory/${key}`, 'PUT', { content: entries().join('\n§\n'), modified: state.modified });
        render();
        section.querySelector('[data-save]').textContent = 'Saved';
      } catch (err) {
        // 412: the agent wrote this file after we read it (409: created it). Show its version.
        if (err.status === 412 || err.status === 409) {
          state = (await request('/api/memory'))[key];
          render();
          section.querySelector('.counter').textContent = `${agentName()} just updated this. Here is the latest; make your edit again.`;
        } else {
          count();
          alert(err.message);
        }
      }
    }
  });
  render();
  return section;
}

boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px">Could not start: ${esc(err.message)}</p>`;
});
