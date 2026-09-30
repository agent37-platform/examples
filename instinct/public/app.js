import { loadThreads, newThread } from '/chat.js';
import { formatPhone, renderTexting } from '/texting.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
// Agents often send a link (a connect page, a checkout to finish): make it tappable.
const linkify = (text) => escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

async function api(path, init = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => null);
  if (res.status === 401) location.href = '/start';
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

let me = await api('/me');
if (me.setup.step !== 'ready') location.href = '/start';

function paintMe() {
  for (const el of document.querySelectorAll('[data-agent-name]')) el.textContent = me.agentName;
  $('handle').textContent = me.handle ? `@${me.handle}` : '';
  $('imessage-number').textContent = me.connect ? formatPhone(me.connect.number) : '';
  $('email').textContent = me.email || '';
  $('me-name').textContent = me.name;
  $('input').placeholder = `Message ${me.agentName}`;
}
paintMe();

$('row-imessage').addEventListener('click', () => (location.hash = 'texting'));
$('row-email').addEventListener('click', () => navigator.clipboard?.writeText(me.email));

// ---- views ----

const VIEWS = {
  chat: { title: 'Chat', sub: () => `The same ${me.agentName} you text. Threads from iMessage, email, and reminders show up here too.`, load: loadThreads },
  reminders: { title: 'Reminders', sub: () => `Scheduled work. Each one wakes ${me.agentName}, even while it sleeps, and it texts you the result.`, load: loadReminders },
  memory: { title: 'Memory', sub: () => `What ${me.agentName} remembers across every channel. Edit anything.`, load: loadMemory },
  connectors: { title: 'Connectors', sub: () => `Apps ${me.agentName} can use for you. You can also ask it to connect one by text.`, load: loadConnectors },
  persona: { title: 'Persona', sub: () => `Who ${me.agentName} is. Saved to its SOUL.md.`, load: loadPersona },
  texting: { title: 'Text your assistant', sub: () => 'Connect your phone once, then just text.', load: loadTexting },
};

function route() {
  const name = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'chat';
  for (const pane of document.querySelectorAll('[data-pane]')) pane.classList.toggle('hidden', pane.dataset.pane !== name);
  for (const link of document.querySelectorAll('.nav a')) link.classList.toggle('on', link.dataset.view === name);
  $('view-title').textContent = name === 'texting' ? `Text ${me.agentName}` : VIEWS[name].title;
  $('view-sub').textContent = VIEWS[name].sub();
  VIEWS[name].load();
}
window.addEventListener('hashchange', route);
route();

// Inkbox says the router number can change, so the screen re-reads it on every visit.
async function loadTexting() {
  renderTexting($('texting-body'), me);
  try {
    me = await api('/connect-info/refresh', { method: 'POST' });
    renderTexting($('texting-body'), me);
  } catch {}
}

// ---- notifications: the agent calls POST /api/notify, the page polls ----

let seen = new Set();
let firstPoll = true;

async function pollNotifications() {
  try {
    const { data } = await api('/notifications');
    const unread = data.filter((note) => !note.read);
    $('badge').textContent = unread.length;
    $('badge').classList.toggle('hidden', unread.length === 0);
    for (const note of unread) {
      if (!firstPoll && !seen.has(note.id)) toast(note);
    }
    seen = new Set(data.map((note) => note.id));
    firstPoll = false;
    if (!$('panel').classList.contains('hidden')) renderPanel(data);
  } catch {}
}

function toast(note) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="from">${escapeHtml(me.agentName)}</div><b>${escapeHtml(note.title)}</b>${linkify(note.body)}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

function renderPanel(data) {
  $('panel').innerHTML = data.length
    ? data.map((note) => `<div class="note-item"><b>${escapeHtml(note.title)}</b>${linkify(note.body)}<br /><time>${new Date(note.created).toLocaleString()}</time></div>`).join('')
    : `<p class="empty" style="padding: 10px">Nothing yet. ${escapeHtml(me.agentName)} posts here when it has something for you.</p>`;
}

$('bell').addEventListener('click', async () => {
  const panel = $('panel');
  panel.classList.toggle('hidden');
  if (panel.classList.contains('hidden')) return;
  const { data } = await api('/notifications');
  renderPanel(data);
  await api('/notifications/read', { method: 'POST' });
  pollNotifications();
});

pollNotifications();
setInterval(pollNotifications, 8000);

// ---- reminders ----

const PRESETS = { '0 8 * * *': 'Every day at 8am', '0 9 * * 1-5': 'Weekdays at 9am', '0 18 * * 0': 'Sundays at 6pm', '0 * * * *': 'Every hour' };
const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'paused');

$('reminder-tz').textContent = me.timezone;
$('reminder-when').addEventListener('change', () => $('reminder-cron').classList.toggle('hidden', $('reminder-when').value !== 'custom'));

async function loadReminders() {
  const list = $('reminders');
  try {
    const { data } = await api('/reminders');
    if (!data.length) {
      list.innerHTML = `<p class="empty">No reminders yet. Add one above, or text ${escapeHtml(me.agentName)} "remind me to call mom on Sunday".</p>`;
      return;
    }
    list.innerHTML = data
      .map(
        (cron) => `
        <div class="reminder" data-id="${cron.id}">
          <div>
            <div class="title">${escapeHtml(cron.name || cron.prompt.slice(0, 80))}</div>
            <div class="meta">${escapeHtml(PRESETS[cron.schedule] || cron.schedule)} &middot; ${escapeHtml(cron.timezone)} &middot; next: ${when(cron.next_run)}
              <span class="tag ${cron.created_by === 'agent' ? 'accent' : ''}">${cron.created_by === 'agent' ? `Set by ${escapeHtml(me.agentName)}` : 'Set by you'}</span></div>
          </div>
          <div class="row">
            <button class="switch ${cron.enabled ? 'on' : ''}" data-act="toggle" title="${cron.enabled ? 'Pause' : 'Resume'}"></button>
            <button class="ghost" data-act="run">Run now</button>
            <button class="ghost" data-act="runs">History</button>
            <button class="ghost" data-act="delete" title="Delete">&times;</button>
          </div>
          <div class="runs hidden"></div>
        </div>`
      )
      .join('');
  } catch (err) {
    list.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

$('reminders').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.reminder');
  const id = row.dataset.id;
  button.disabled = true;
  try {
    if (button.dataset.act === 'toggle') await api(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !button.classList.contains('on') }) });
    if (button.dataset.act === 'delete') await api(`/reminders/${id}`, { method: 'DELETE' });
    if (button.dataset.act === 'run') {
      await api(`/reminders/${id}/run`, { method: 'POST' });
      button.textContent = 'Started';
      return;
    }
    if (button.dataset.act === 'runs') {
      const { data } = await api(`/reminders/${id}/runs`);
      const runs = row.querySelector('.runs');
      runs.classList.remove('hidden');
      runs.innerHTML = data.length
        ? data.slice(0, 5).map((run) => `<div>${new Date(run.ran_at * 1000).toLocaleString()} &middot; ${run.status}${run.reason ? ` (${run.reason})` : ''}</div>`).join('')
        : '<div class="faint">Not run yet.</div>';
      return;
    }
    loadReminders();
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
});

$('reminders-refresh').addEventListener('click', loadReminders);

$('reminder-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('reminder-error').textContent = '';
  const schedule = $('reminder-when').value === 'custom' ? $('reminder-cron').value.trim() : $('reminder-when').value;
  try {
    await api('/reminders', { method: 'POST', body: JSON.stringify({ task: $('reminder-task').value, schedule, timezone: me.timezone }) });
    $('reminder-task').value = '';
    loadReminders();
  } catch (err) {
    $('reminder-error').textContent = err.message;
  }
});

// ---- memory ----

async function loadMemory() {
  for (const key of ['user', 'memory']) $(`memory-${key}-note`).textContent = 'Loading...';
  try {
    const files = await api('/memory');
    for (const key of ['user', 'memory']) {
      $(`memory-${key}`).value = files[key];
      $(`memory-${key}-note`).textContent = files[key] ? '' : 'Empty so far. It fills in as you talk.';
    }
  } catch (err) {
    for (const key of ['user', 'memory']) $(`memory-${key}-note`).textContent = err.message;
  }
}

for (const button of document.querySelectorAll('[data-save]')) {
  button.addEventListener('click', async () => {
    const key = button.dataset.save;
    button.disabled = true;
    try {
      await api(`/memory/${key}`, { method: 'PUT', body: JSON.stringify({ content: $(`memory-${key}`).value }) });
      $(`memory-${key}-note`).textContent = 'Saved.';
    } catch (err) {
      $(`memory-${key}-note`).textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

// ---- connectors ----

let cursor = null;

async function loadConnections() {
  const box = $('connections');
  try {
    const { connections } = await api('/connectors/connections');
    const active = connections.filter((conn) => conn.status === 'ACTIVE');
    box.innerHTML = active.length
      ? active.map((conn) => `<div class="row" style="padding: 6px 0"><span>${escapeHtml(conn.toolkitName || conn.toolkitSlug)}</span><span class="tag accent">Connected</span><span class="spacer"></span><button class="ghost" data-disconnect="${escapeHtml(conn.id)}">Disconnect</button></div>`).join('')
      : `<p class="empty">Nothing connected. Connect an app below, or ask ${escapeHtml(me.agentName)} to send you a link.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

async function loadToolkits(append = false) {
  const search = $('toolkit-search').value.trim();
  const query = new URLSearchParams();
  if (search.length >= 3) query.set('search', search);
  if (append && cursor) query.set('cursor', cursor);
  const page = await api(`/connectors/toolkits?${query}`);
  cursor = page.nextCursor;
  $('toolkits-more').classList.toggle('hidden', !cursor);
  const html = page.items
    .map(
      (kit) => `<div class="tool"><img src="${escapeHtml(kit.logo)}" alt="" /><div class="name">${escapeHtml(kit.name)}</div>
        <div class="desc">${escapeHtml(kit.description)}</div>
        <button data-connect="${escapeHtml(kit.slug)}" data-name="${escapeHtml(kit.name)}">Connect</button></div>`
    )
    .join('');
  $('toolkits').innerHTML = append ? $('toolkits').innerHTML + html : html;
}

function loadConnectors() {
  loadConnections();
  loadToolkits().catch((err) => ($('toolkits').innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`));
}

let searchTimer;
$('toolkit-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadToolkits().catch(() => {}), 300);
});
$('toolkits-more').addEventListener('click', () => loadToolkits(true));

$('toolkits').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-connect]');
  if (!button) return;
  button.disabled = true;
  try {
    const { redirectUrl } = await api('/connectors/connect', { method: 'POST', body: JSON.stringify({ toolkit: button.dataset.connect, name: button.dataset.name }) });
    window.open(redirectUrl, '_blank');
    button.textContent = 'Finish in the new tab';
    // Landing back on /connected means the user finished the OAuth screens; the connection
    // list is the proof it took.
    let tries = 0;
    const timer = setInterval(() => {
      loadConnections();
      if (++tries > 40) clearInterval(timer);
    }, 3000);
  } catch (err) {
    alert(err.message);
    button.disabled = false;
  }
});

$('connections').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-disconnect]');
  if (!button) return;
  button.disabled = true;
  await api(`/connectors/connections/${encodeURIComponent(button.dataset.disconnect)}`, { method: 'DELETE' }).catch((err) => alert(err.message));
  loadConnections();
});

// ---- persona ----

function loadPersona() {
  $('persona-name').value = me.agentName;
  $('persona-text').value = me.persona;
  $('persona-phone').value = me.phone || '';
  $('persona-email').value = me.ownerEmail || '';
  $('persona-note').textContent = '';
}

$('persona-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('persona-note').textContent = 'Saving...';
  try {
    me = await api('/persona', {
      method: 'PUT',
      body: JSON.stringify({
        agentName: $('persona-name').value,
        persona: $('persona-text').value,
        phone: $('persona-phone').value,
        ownerEmail: $('persona-email').value,
      }),
    });
    paintMe();
    $('persona-note').textContent = 'Saved. It applies to new conversations.';
  } catch (err) {
    $('persona-note').textContent = err.message;
  }
});

$('delete-account').addEventListener('click', async () => {
  if (!confirm(`Delete ${me.agentName}, its computer, its phone line, and its inbox?`)) return;
  try {
    await api('/account', { method: 'DELETE' });
    location.href = '/';
  } catch (err) {
    alert(err.message);
  }
});

// ---- command palette ----

const COMMANDS = [
  ['New thread', () => { location.hash = 'chat'; newThread(); }],
  ['Chat', () => (location.hash = 'chat')],
  ['New reminder', () => { location.hash = 'reminders'; setTimeout(() => $('reminder-task').focus(), 50); }],
  ['Reminders', () => (location.hash = 'reminders')],
  ['Memory', () => (location.hash = 'memory')],
  ['Connectors', () => (location.hash = 'connectors')],
  ['Persona', () => (location.hash = 'persona')],
  [`Text ${me.agentName}`, () => (location.hash = 'texting')],
];

function openPalette() {
  if (document.querySelector('.palette-backdrop')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.innerHTML = '<div class="palette"><input placeholder="Jump to..." /><ul></ul></div>';
  document.body.appendChild(backdrop);
  const input = backdrop.querySelector('input');
  const list = backdrop.querySelector('ul');
  let matches = COMMANDS;
  let index = 0;
  const close = () => backdrop.remove();
  const paint = () => {
    matches = COMMANDS.filter(([label]) => label.toLowerCase().includes(input.value.toLowerCase()));
    index = Math.min(index, Math.max(matches.length - 1, 0));
    list.innerHTML = matches.map(([label], i) => `<li class="${i === index ? 'on' : ''}" data-i="${i}">${escapeHtml(label)}</li>`).join('');
  };
  input.addEventListener('input', () => ((index = 0), paint()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') index = Math.min(index + 1, matches.length - 1);
    else if (event.key === 'ArrowUp') index = Math.max(index - 1, 0);
    else if (event.key === 'Enter' && matches[index]) return close(), matches[index][1]();
    else if (event.key === 'Escape') return close();
    else return;
    event.preventDefault();
    paint();
  });
  list.addEventListener('click', (event) => {
    const item = event.target.closest('li');
    if (item) close(), matches[Number(item.dataset.i)][1]();
  });
  backdrop.addEventListener('click', (event) => event.target === backdrop && close());
  paint();
  input.focus();
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
});
