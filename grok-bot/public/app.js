const $ = (id) => document.getElementById(id);
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const COLORS = ['#FF6B35', '#006CEB', '#12A150', '#8B5CF6', '#E5484D', '#0EA5A4', '#D97706', '#DB2777'];
const SHAPES = ['circle', 'triangle', 'diamond', 'square', 'hexagon', 'ring'];

const PRESETS = [
  {
    name: 'Chief',
    title: 'Chief of staff',
    description: 'Keeps track of my priorities, plans my week, and turns loose ends into next steps. Short, direct updates. Never sends anything external without asking me first.',
    color: '#FF6B35',
    shape: 'diamond',
  },
  {
    name: 'Scout',
    title: 'Research lead',
    description: 'Digs into any topic on the web, compares sources, and writes tight memos with links. Says plainly when something is uncertain.',
    color: '#006CEB',
    shape: 'triangle',
  },
  {
    name: 'Inbox',
    title: 'Inbox manager',
    description: 'Triages my email once Gmail is connected: surfaces what needs me today, drafts replies, and archives noise. Always asks before sending.',
    color: '#12A150',
    shape: 'ring',
  },
];

const state = {
  me: null,
  current: null, // a Bot id, or 'group' for the team chat
  views: new Map(), // one thread per Bot, kept alive so Bots stream in parallel
  routines: [],
  seenNotifications: null,
  groupTimer: null,
  groupPending: 0,
  computer: null, // the live screen, when the computer has one
};

// ---- API ----

async function request(path, init = {}) {
  const res = await fetch(path, { headers: JSON_HEADERS, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code, hint: body?.error?.hint });
  return body;
}

const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: (path) => request(path, { method: 'DELETE' }),
};

// ---- small helpers ----

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Just enough Markdown for agent replies: code, bold, headings, links.
function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)([.,;:!?]*)(?=$|[\s<)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>$3');
}

function el(tag, attrs = {}, html = '') {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  if (html) node.innerHTML = html;
  return node;
}

function avatarSvg(color, shape, size = 36) {
  const glyphs = {
    circle: '<circle cx="20" cy="20" r="7.5" fill="#fff"/>',
    triangle: '<path d="M20 11.5l8.5 15h-17z" fill="#fff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>',
    diamond: '<path d="M20 10.5l9.5 9.5-9.5 9.5-9.5-9.5z" fill="#fff"/>',
    square: '<rect x="13" y="13" width="14" height="14" rx="3" fill="#fff"/>',
    hexagon: '<path d="M20 11l8 4.6v8.8L20 29l-8-4.6v-8.8z" fill="#fff"/>',
    ring: '<circle cx="20" cy="20" r="7" fill="none" stroke="#fff" stroke-width="3.6"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill="${color}"/><circle cx="31" cy="9" r="2.4" fill="#fff" fill-opacity=".55"/>${glyphs[shape] || glyphs.circle}</svg>`;
}

function botAvatar(bot, size) {
  return `<span class="avatar">${avatarSvg(bot.color, bot.shape, size)}</span>`;
}

function groupAvatar(bots) {
  const tiles = [0, 1, 2, 3].map((index) => `<i style="background:${bots[index]?.color || '#E8EBF0'}"></i>`).join('');
  return `<span class="group-avatar">${tiles}</span>`;
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayLabel(ms) {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function botById(id) {
  return state.me?.bots.find((bot) => bot.id === id) || null;
}

function toast(title, text, onClick, bot) {
  const node = el('div', { class: 'toast' }, `${bot ? botAvatar(bot, 30) : ''}<div><b>${escapeHtml(title)}</b><p>${escapeHtml(text)}</p></div>`);
  node.addEventListener('click', () => {
    node.remove();
    onClick?.();
  });
  $('toasts').prepend(node);
  setTimeout(() => node.remove(), 9000);
}

// ---- first run ----

function show(screen) {
  for (const id of ['onboarding', 'starting', 'presets', 'app']) $(id).hidden = id !== screen;
}

async function boot() {
  state.me = await api.get('/api/me');
  if (!state.me.computer) return show('onboarding');
  if (!(await waitForComputer())) return boot();
  if (!state.me.bots.length) return showPresets();
  showApp();
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('setup-go').disabled = true;
  show('starting');
  $('starting-note').textContent = 'Creating your computer. The first boot takes a minute or two; after that it wakes in seconds.';
  try {
    state.me = await api.post('/api/setup', { name: $('setup-name').value, timezone: TIMEZONE });
  } catch (err) {
    show('onboarding');
    $('setup-go').disabled = false;
    $('setup-status').textContent = err.message;
    return;
  }
  $('setup-go').disabled = false;
  if (!(await waitForComputer())) return boot();
  showPresets();
});

// Create returns once the container runs; the agent inside is still booting. A sleeping
// computer also wakes on this probe, which can take a couple of minutes after a long idle.
// Resolves false when the computer is gone (deleted outside the app), so the caller starts over.
async function waitForComputer() {
  for (let attempt = 0; ; attempt += 1) {
    const { ready, gone, stuck, message } = await api.get('/api/ready').catch(() => ({ ready: false }));
    if (ready) return true;
    if (gone) return false;
    if (attempt === 0) show('starting');
    if (message) $('starting-note').textContent = message;
    $('starting-delete').hidden = !stuck;
    await delay(3000);
  }
}

$('starting-delete').addEventListener('click', deleteComputer);

async function deleteComputer() {
  if (!confirm('Delete your computer? Every Bot, file, routine and conversation on it is gone for good.')) return;
  await api.del('/api/me').catch((err) => alert(err.message));
  localStorage.removeItem('grokbot:current');
  location.reload();
}

function showPresets() {
  show('presets');
  const grid = $('preset-grid');
  grid.innerHTML = '';
  for (const preset of PRESETS) {
    const card = el('button', { class: 'preset' }, `${avatarSvg(preset.color, preset.shape, 40)}<b>${preset.name}</b><span>${preset.title}</span><span>${escapeHtml(preset.description)}</span>`);
    card.addEventListener('click', async () => {
      card.disabled = true;
      const bot = await api.post('/api/bots', preset).catch((err) => alert(err.message));
      if (!bot) return;
      state.me = await api.get('/api/me');
      showApp(bot.id);
    });
    grid.appendChild(card);
  }
}

$('preset-custom').addEventListener('click', () => openBotEditor(null));

// ---- the app shell ----

function showApp(selectId) {
  show('app');
  $('user-name').textContent = state.me.user_name;
  $('user-avatar').textContent = (state.me.user_name || '?').slice(0, 1).toUpperCase();
  renderSidebar();
  const remembered = localStorage.getItem('grokbot:current');
  select(selectId || (botById(remembered) || remembered === 'group' ? remembered : state.me.bots[0]?.id));
  loadRoutines();
  pollNotifications();
  if (state.me.desktop) startScreen();
}

// The noVNC client loads only for computers that have a screen (DESKTOP_TEMPLATE).
async function startScreen() {
  if (state.computer) return;
  const { startComputer } = await import('/computer.js');
  state.computer = startComputer({
    isWorking: () => state.groupPending > 0 || [...state.views.values()].some((view) => view.busy),
  });
}

async function refreshMe() {
  state.me = await api.get('/api/me').catch(() => state.me);
  renderSidebar();
  if (state.current !== 'group') renderHeader();
}

function renderSidebar() {
  const query = $('search').value.trim().toLowerCase();
  const bots = state.me.bots;
  const group = el('button', { class: `row ${state.current === 'group' ? 'active' : ''}` },
    `${groupAvatar(bots)}<span class="row-main"><span class="row-top"><b>Team</b></span><span class="row-preview">${bots.length === 1 ? '1 Bot' : `${bots.length} Bots`}, @mention to assign</span></span>`);
  group.addEventListener('click', () => select('group'));
  $('group-row').replaceChildren(group);

  const list = $('bot-list');
  list.innerHTML = '';
  for (const bot of bots) {
    if (query && !`${bot.name} ${bot.title}`.toLowerCase().includes(query)) continue;
    const working = state.views.get(bot.id)?.busy;
    const row = el('button', { class: `row ${state.current === bot.id ? 'active' : ''}` },
      `${botAvatar(bot, 36)}<span class="row-main"><span class="row-top"><b>${escapeHtml(bot.name)}</b><time>${formatTime(bot.last_at)}</time></span>` +
      `<span class="row-preview ${working ? 'working' : ''}">${working ? 'Working...' : escapeHtml(bot.preview || bot.title || 'New Bot')}</span></span>`);
    row.addEventListener('click', () => select(bot.id));
    list.appendChild(row);
  }
}

$('search').addEventListener('input', renderSidebar);
$('new-bot').addEventListener('click', () => openBotEditor(null));

function viewFor(id) {
  let view = state.views.get(id);
  if (!view) {
    view = { id, el: el('div', { class: 'thread-inner' }), sessionId: null, busy: false, responseId: null, loaded: false, lastDay: null };
    state.views.set(id, view);
  }
  return view;
}

function select(id) {
  if (!id) return;
  state.current = id;
  localStorage.setItem('grokbot:current', id);
  closeDrawer();
  const view = viewFor(id);
  $('thread').replaceChildren(view.el);
  renderSidebar();
  renderHeader();
  renderRoutines();
  updateComposer();
  clearInterval(state.groupTimer);
  if (id === 'group') {
    loadGroup();
    state.groupTimer = setInterval(loadGroup, 2500);
  } else if (!view.loaded) {
    view.loaded = true;
    const bot = botById(id);
    if (bot.sessions[0]) openSession(view, bot.sessions[0].id);
    else renderIntro(view);
  }
  scrollToBottom(view, true);
  $('input').focus();
}

function renderHeader() {
  const pill = $('header-pill');
  if (state.current === 'group') {
    pill.innerHTML = `${groupAvatar(state.me.bots)}<b>Team</b><span class="muted">${state.me.bots.length === 1 ? '1 Bot' : `${state.me.bots.length} Bots`}</span>`;
    $('screen-title').textContent = 'Team computer';
    $('screen-avatar').innerHTML = groupAvatar(state.me.bots);
    $('notes-section').hidden = true;
    return;
  }
  const bot = botById(state.current);
  if (!bot) return;
  pill.innerHTML = `${botAvatar(bot, 30)}<b>${escapeHtml(bot.name)}</b><span class="muted">${escapeHtml(bot.title || '')}</span>`;
  $('screen-title').textContent = `${bot.name}'s screen`;
  $('screen-avatar').innerHTML = botAvatar(bot, 22);
  $('notes-section').hidden = false;
  $('notes-path').textContent = `~/bots/${bot.handle}/notes.md`;
}

function updateComposer() {
  const view = state.views.get(state.current);
  const group = state.current === 'group';
  const bot = botById(state.current);
  $('input').placeholder = group ? 'Message the team, @mention a Bot' : `Message ${bot?.name || ''}`;
  $('send').hidden = Boolean(view?.busy) && !group;
  $('stop').hidden = !view?.busy || group;
  $('new-convo').hidden = group;
  $('mention-bar').hidden = !group;
  if (group) {
    $('mention-bar').innerHTML = '';
    for (const handle of [...state.me.bots.map((b) => b.handle), 'everyone']) {
      const chip = el('button', { type: 'button' }, `@${escapeHtml(handle)}`);
      chip.addEventListener('click', () => {
        $('input').value = `${$('input').value.trim()} @${handle} `.trimStart();
        $('input').focus();
      });
      $('mention-bar').appendChild(chip);
    }
  }
}

$('toggle-pane').addEventListener('click', () => {
  $('app').classList.toggle('pane-closed');
  state.computer?.sync();
});

// ---- the "..." menu: conversations and Bot settings ----

$('more').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('more-menu');
  if (!menu.hidden) return (menu.hidden = true);
  menu.innerHTML = '';
  const bot = botById(state.current);
  const item = (label, onClick, cls = '') => {
    const button = el('button', { class: cls }, label);
    button.addEventListener('click', () => {
      menu.hidden = true;
      onClick();
    });
    menu.appendChild(button);
  };
  if (bot) {
    item('New conversation', () => newConversation(viewFor(bot.id)));
    item(`Edit ${escapeHtml(bot.name)}`, () => openBotEditor(bot));
    if (bot.sessions.length) {
      menu.appendChild(el('hr'));
      menu.appendChild(el('div', { class: 'menu-label' }, 'Conversations'));
      for (const session of bot.sessions.slice(0, 12)) {
        item(`${escapeHtml(session.title || 'Conversation')} <span class="muted small">${formatTime(session.created)}</span>`, () => {
          const view = viewFor(bot.id);
          if (view.busy) return toast(bot.name, 'Still working on the current conversation.');
          openSession(view, session.id);
        });
      }
    }
    menu.appendChild(el('hr'));
    item(`Delete ${escapeHtml(bot.name)}`, () => deleteBot(bot), 'danger');
  } else {
    item('Clear the team chat view', () => viewFor('group').el.replaceChildren());
  }
  menu.hidden = false;
});

document.addEventListener('click', (event) => {
  if (!$('more-menu').contains(event.target)) $('more-menu').hidden = true;
  if (!$('notif-popover').contains(event.target) && !$('bell').contains(event.target)) $('notif-popover').hidden = true;
});

async function deleteBot(bot) {
  if (!confirm(`Delete ${bot.name} and its routines? Its conversations and notes stay on the computer.`)) return;
  await api.del(`/api/bots/${bot.id}`).catch((err) => alert(err.message));
  state.views.delete(bot.id);
  await refreshMe();
  await loadRoutines();
  select(state.me.bots[0]?.id || 'group');
}

// ---- rendering a thread ----

function scrollToBottom(view, force = false) {
  if (view.id !== state.current) return;
  const thread = $('thread');
  if (force || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 240) thread.scrollTop = thread.scrollHeight;
}

function dayStamp(view, ms) {
  const label = dayLabel(ms);
  if (view.lastDay === label) return;
  view.lastDay = label;
  view.el.appendChild(el('div', { class: 'day' }, label));
}

function addMessage(view, role, { at = Date.now(), from } = {}) {
  dayStamp(view, at);
  if (from) view.el.appendChild(el('div', { class: 'from' }, `${botAvatar(from, 20)}${escapeHtml(from.name)}`));
  const node = el('div', { class: `msg ${role}` });
  view.el.appendChild(node);
  let textEl = null;
  let pendingEl = null;
  let thinkingEl = null;
  let toolsEl = null;
  const ensureText = () => {
    if (!textEl) {
      textEl = el('span');
      node.appendChild(textEl);
    }
    return textEl;
  };
  const bubble = {
    setText(text, markdown = role === 'assistant') {
      bubble.clearPending();
      if (markdown) ensureText().innerHTML = renderMarkdown(text);
      else ensureText().textContent = text;
      scrollToBottom(view);
    },
    appendText(text) {
      bubble.clearPending();
      ensureText().textContent += text;
      scrollToBottom(view);
    },
    pending(text) {
      if (!pendingEl) {
        pendingEl = el('span', { class: 'pending' });
        node.appendChild(pendingEl);
      }
      pendingEl.textContent = text;
      scrollToBottom(view);
    },
    clearPending() {
      pendingEl?.remove();
      pendingEl = null;
    },
    remove() {
      node.remove();
    },
    thinking(text) {
      bubble.clearPending();
      if (!thinkingEl) {
        thinkingEl = el('details', { class: 'thinking' }, '<summary>Thinking</summary><div></div>');
        node.prepend(thinkingEl);
      }
      thinkingEl.querySelector('div').textContent += text;
    },
    // started carries a label; completed and failed carry only the tool name, so the chip
    // is found by tool name and keeps the label it started with.
    tool(name, status, label) {
      bubble.clearPending();
      if (!toolsEl) {
        toolsEl = el('div', { class: 'tools' });
        node.insertBefore(toolsEl, textEl);
      }
      let chip = [...toolsEl.children].find((child) => child.dataset.tool === name && !child.dataset.settled);
      if (!chip || status === 'running') {
        chip = el('span');
        chip.dataset.tool = name;
        chip.textContent = label || name;
        chip.title = label || name;
        toolsEl.appendChild(chip);
      }
      chip.className = `chip tool-${status}`;
      if (status !== 'running') chip.dataset.settled = '1';
      scrollToBottom(view);
    },
  };
  return bubble;
}

function addNote(view, cls, text) {
  view.el.appendChild(el('div', { class: `msg ${cls}` }, escapeHtml(text)));
  scrollToBottom(view);
}

function renderIntro(view) {
  const bot = botById(view.id);
  view.lastDay = null;
  const intro = el('div', { class: 'bot-intro' },
    `${avatarSvg(bot.color, bot.shape, 64)}<h2>${escapeHtml(bot.name)}</h2><p class="muted">${escapeHtml(bot.title || '')}</p><p>${escapeHtml(bot.description || '')}</p>`);
  const suggestions = el('div', { class: 'suggestions' });
  for (const text of [
    'What can you do for me?',
    'Every weekday at 9, send me a two-line briefing.',
    'Read your notes and tell me what you know about me.',
  ]) {
    const chip = el('button', {}, escapeHtml(text));
    chip.addEventListener('click', () => sendToBot(view, text));
    suggestions.appendChild(chip);
  }
  intro.appendChild(suggestions);
  view.el.replaceChildren(intro);
}

function newConversation(view) {
  if (view.busy) return toast(botById(view.id).name, 'Still working. Stop it or wait before starting a new conversation.');
  view.sessionId = null;
  renderIntro(view);
  $('input').focus();
}

async function openSession(view, sessionId) {
  view.sessionId = sessionId;
  view.lastDay = null;
  view.el.replaceChildren(el('div', { class: 'msg system' }, 'Loading...'));
  let session;
  try {
    session = await api.get(`/api/sessions/${sessionId}`);
  } catch (err) {
    session = { error: err.message };
  }
  // The user may have moved on (new conversation, another thread) while this loaded.
  if (view.sessionId !== sessionId) return;
  view.el.replaceChildren();
  if (session.error) return addNote(view, 'error', `Could not load this conversation: ${session.error}`);
  for (const message of session.history) {
    addMessage(view, message.role, { at: message.created_at }).setText(message.content);
  }
  if (!session.history.length && !session.active_response_id) renderIntro(view);
  scrollToBottom(view, true);
  if (session.active_response_id && !view.busy) {
    view.responseId = session.active_response_id;
    const bubble = addMessage(view, 'assistant');
    bubble.pending('Catching up on a reply in progress...');
    setBusy(view, true);
    follow(view, bubble, null);
  }
}

// ---- streaming a Bot's turn ----
// EventSource cannot POST, so the stream is a fetch whose body is parsed as SSE frames:
// blocks separated by a blank line, each with "event:" and "data:" lines. Lines starting
// with ":" are keepalive comments.

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

const isSse = (response) => response.headers.get('content-type')?.includes('text/event-stream');
const MAX_RECOVERY_ATTEMPTS = 8;
const RECOVERY_DELAY_MS = 1500;

async function consumeStream(view, response, bubble) {
  let sawTerminal = false;
  let sawToolCalls = false;
  for await (const { event, data } of sseFrames(response)) {
    switch (event) {
      case 'response.created':
        view.sessionId = data.session_id;
        view.responseId = data.id;
        bubble.pending('Working...');
        break;
      case 'response.reasoning.delta':
        bubble.thinking(data.text);
        break;
      case 'response.output_text.delta':
        bubble.appendText(data.text);
        break;
      case 'response.tool_call.generating':
        bubble.pending(`Writing a ${data.tool} call...`);
        break;
      case 'response.tool_call.started':
        sawToolCalls = true;
        bubble.tool(data.tool, 'running', data.label);
        break;
      case 'response.tool_call.completed':
        bubble.tool(data.tool, 'done');
        break;
      case 'response.tool_call.failed':
        bubble.tool(data.tool, 'failed');
        break;
      case 'response.completed': {
        sawTerminal = true;
        // The terminal payload carries the authoritative full text: replace, never append.
        const text = (data.output_text ?? '').replace(/^\n+/, '');
        bubble.setText(text);
        if (!text && !sawToolCalls) {
          addNote(view, 'error', 'The Bot returned an empty reply. The computer budget or the workspace balance is likely exhausted.');
        }
        break;
      }
      case 'response.failed':
        sawTerminal = true;
        bubble.remove();
        addNote(view, 'error', data.error?.message || 'The turn failed.');
        break;
    }
  }
  return sawTerminal;
}

function setBusy(view, busy) {
  view.busy = busy;
  renderSidebar();
  if (view.id === state.current) updateComposer();
  state.computer?.render();
}

async function sendToBot(view, text) {
  const bot = botById(view.id);
  if (view.el.querySelector('.bot-intro')) view.el.replaceChildren();
  addMessage(view, 'user').setText(text);
  const bubble = addMessage(view, 'assistant');
  bubble.pending(`${bot.name} is thinking...`);
  setBusy(view, true);
  let response;
  try {
    response = await fetch(`/api/bots/${bot.id}/responses`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ input: text, ...(view.sessionId ? { session_id: view.sessionId } : {}) }),
    });
  } catch (err) {
    bubble.remove();
    addNote(view, 'error', `Could not reach the server: ${err.message}`);
    return setBusy(view, false);
  }
  if (!isSse(response)) {
    const body = await response.json().catch(() => null);
    // One turn per session: if another tab already has one running here, follow that
    // reply instead of failing.
    if (body?.error?.code === 'session_busy' && body.error.response_id) {
      addNote(view, 'system', `Not sent: ${bot.name} is still answering the last message. Showing that reply.`);
      view.responseId = body.error.response_id;
      bubble.pending('Catching up...');
      return follow(view, bubble, null);
    }
    bubble.remove();
    addNote(view, 'error', [body?.error?.message || `Request failed (HTTP ${response.status}).`, body?.error?.hint].filter(Boolean).join(' '));
    return setBusy(view, false);
  }
  follow(view, bubble, response);
}

// A stream that closes without a terminal event usually means the turn is still running.
// Reattach with GET /responses/{id}/stream, which replays every event so far and then
// resumes live, until a terminal event arrives.
async function follow(view, bubble, response) {
  let sawTerminal = false;
  if (response) {
    try {
      sawTerminal = await consumeStream(view, response, bubble);
    } catch {}
  }
  for (let attempt = 0; !sawTerminal && view.responseId && attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(RECOVERY_DELAY_MS);
    try {
      const replay = await fetch(`/api/responses/${view.responseId}/stream`);
      if (!isSse(replay)) throw new Error('not a stream');
      bubble.remove();
      bubble = addMessage(view, 'assistant');
      bubble.pending('Catching up...');
      sawTerminal = await consumeStream(view, replay, bubble);
    } catch {}
  }
  if (!sawTerminal) {
    bubble.remove();
    addNote(view, 'system', 'Lost the connection to this reply. Reopen the conversation to see it.');
  }
  bubble.clearPending();
  view.responseId = null;
  setBusy(view, false);
  refreshMe();
}

$('stop').addEventListener('click', async () => {
  const view = state.views.get(state.current);
  if (!view?.responseId) return;
  // Cancel returns at once; the stream then ends with response.completed (partial text).
  await api.post(`/api/responses/${view.responseId}/cancel`).catch((err) => addNote(view, 'error', `Stop failed: ${err.message}`));
});

$('new-convo').addEventListener('click', () => newConversation(viewFor(state.current)));

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('input').value.trim();
  if (!text || !state.current) return;
  if (state.current === 'group') {
    $('input').value = '';
    return sendToGroup(text);
  }
  const view = viewFor(state.current);
  if (view.busy) return;
  $('input').value = '';
  sendToBot(view, text);
});

$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

// ---- team chat ----

function renderGroup(view, messages, pending) {
  view.el.replaceChildren();
  view.lastDay = null;
  if (!messages.length) {
    view.el.appendChild(el('div', { class: 'bot-intro' },
      `${groupAvatar(state.me.bots)}<h2>Team</h2><p class="muted">Every Bot in one thread. @mention a Bot to hand it work, or @everyone. Bots can hand work to each other the same way.</p>`));
  }
  for (const message of messages) {
    if (message.kind === 'status') {
      dayStamp(view, message.at);
      addNote(view, 'status', message.text);
    } else if (message.kind === 'user') {
      addMessage(view, 'user', { at: message.at }).setText(message.text);
    } else {
      const bot = botById(message.bot_id) || { name: 'Deleted Bot', color: '#999', shape: 'circle' };
      addMessage(view, 'assistant', { at: message.at, from: bot }).setText(message.text);
    }
  }
  if (pending) addNote(view, 'system', 'Working...');
}

async function loadGroup() {
  if (state.current !== 'group') return;
  const view = viewFor('group');
  const { messages, pending } = await api.get('/api/group').catch(() => ({ messages: [], pending: 0 }));
  state.groupPending = pending;
  state.computer?.render();
  const signature = `${messages.length}:${messages.at(-1)?.id}:${pending}`;
  if (view.signature === signature) return;
  view.signature = signature;
  renderGroup(view, messages, pending);
  scrollToBottom(view, true);
}

async function sendToGroup(text) {
  const view = viewFor('group');
  try {
    const { messages, pending } = await api.post('/api/group/messages', { text });
    view.signature = null;
    renderGroup(view, messages, pending);
    scrollToBottom(view, true);
  } catch (err) {
    addNote(view, 'error', err.message);
  }
}

// ---- Bot editor ----

function openModal(title, body, actions) {
  const box = $('modal-box');
  box.innerHTML = `<h2>${escapeHtml(title)}</h2>`;
  box.appendChild(body);
  if (actions) box.appendChild(actions);
  $('modal').hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
}

$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});

function openBotEditor(bot) {
  const draft = bot ? { ...bot } : { name: '', title: '', description: '', color: COLORS[(state.me?.bots.length || 0) % COLORS.length], shape: SHAPES[(state.me?.bots.length || 0) % SHAPES.length] };
  const body = el('div', { class: 'stack' }, `
    <label>Name<input id="bot-name" maxlength="40" placeholder="Short and memorable, like Scout" /></label>
    <label>Title<input id="bot-title" maxlength="60" placeholder="Its job, like Research lead" /></label>
    <label>Description<textarea id="bot-desc" rows="4" maxlength="1500" placeholder="What it works on and the rules it follows. Sent to the Bot at the start of every conversation."></textarea></label>
    <div><div class="small muted">Color</div><div class="swatches" id="bot-colors"></div></div>
    <div><div class="small muted">Avatar</div><div class="swatches" id="bot-shapes"></div></div>`);
  body.querySelector('#bot-name').value = draft.name;
  body.querySelector('#bot-title').value = draft.title || '';
  body.querySelector('#bot-desc').value = draft.description || '';
  const paint = () => {
    const colors = body.querySelector('#bot-colors');
    colors.innerHTML = '';
    for (const color of COLORS) {
      const swatch = el('button', { type: 'button', class: `swatch ${draft.color === color ? 'active' : ''}`, style: `background:${color}`, 'aria-label': color });
      swatch.addEventListener('click', () => {
        draft.color = color;
        paint();
      });
      colors.appendChild(swatch);
    }
    const shapes = body.querySelector('#bot-shapes');
    shapes.innerHTML = '';
    for (const shape of SHAPES) {
      const pick = el('button', { type: 'button', class: `shape-pick ${draft.shape === shape ? 'active' : ''}`, 'aria-label': shape }, avatarSvg(draft.color, shape, 34));
      pick.addEventListener('click', () => {
        draft.shape = shape;
        paint();
      });
      shapes.appendChild(pick);
    }
  };
  paint();
  const actions = el('div', { class: 'row-actions' });
  const cancel = el('button', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', closeModal);
  const saveBtn = el('button', { type: 'button', class: 'primary' }, bot ? 'Save' : 'Create Bot');
  saveBtn.addEventListener('click', async () => {
    const fields = {
      name: body.querySelector('#bot-name').value,
      title: body.querySelector('#bot-title').value,
      description: body.querySelector('#bot-desc').value,
      color: draft.color,
      shape: draft.shape,
    };
    if (!fields.name.trim()) return body.querySelector('#bot-name').focus();
    saveBtn.disabled = true;
    try {
      const saved = bot ? await api.patch(`/api/bots/${bot.id}`, fields) : await api.post('/api/bots', fields);
      closeModal();
      await refreshMe();
      if ($('app').hidden) showApp(saved.id);
      else select(saved.id);
    } catch (err) {
      saveBtn.disabled = false;
      alert(err.message);
    }
  });
  actions.append(cancel, saveBtn);
  openModal(bot ? `Edit ${bot.name}` : 'New Bot', body, actions);
  body.querySelector('#bot-name').focus();
}

// ---- notes ----

$('open-notes').addEventListener('click', async () => {
  const bot = botById(state.current);
  if (!bot) return;
  const body = el('div', { class: 'stack' }, `<p class="muted small mono">~/bots/${escapeHtml(bot.handle)}/notes.md on the shared computer. ${escapeHtml(bot.name)} reads it when a conversation starts and writes to it as it learns.</p><textarea rows="14" class="mono" id="notes-text">Loading...</textarea>`);
  const actions = el('div', { class: 'row-actions' });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Save notes');
  const close = el('button', { type: 'button' }, 'Close');
  close.addEventListener('click', closeModal);
  actions.append(close, saveBtn);
  openModal(`${bot.name}'s notes`, body, actions);
  const { text } = await api.get(`/api/bots/${bot.id}/notes`).catch((err) => ({ text: `Could not load: ${err.message}` }));
  body.querySelector('#notes-text').value = text;
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    await api.put(`/api/bots/${bot.id}/notes`, { text: body.querySelector('#notes-text').value }).catch((err) => alert(err.message));
    closeModal();
  });
});

// ---- routines ----

const pad = (n) => String(n).padStart(2, '0');

function parseSchedule(expr) {
  let match;
  if ((match = expr.match(/^(\d{1,2}) \* \* \* \*$/))) return { kind: 'hourly', time: `00:${pad(match[1])}` };
  if ((match = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/))) {
    const kind = { '*': 'daily', '1-5': 'weekdays', 1: 'weekly' }[match[3]];
    return { kind, time: `${pad(match[2])}:${pad(match[1])}` };
  }
  return { kind: 'custom', time: '09:00' };
}

function buildSchedule(kind, time, custom) {
  const [hour, minute] = time.split(':').map(Number);
  return {
    hourly: `${minute} * * * *`,
    daily: `${minute} ${hour} * * *`,
    weekdays: `${minute} ${hour} * * 1-5`,
    weekly: `${minute} ${hour} * * 1`,
  }[kind] ?? custom.trim();
}

function describeSchedule(expr) {
  const { kind, time } = parseSchedule(expr || '');
  const [hour, minute] = time.split(':').map(Number);
  const clock = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    hourly: `Every hour at :${pad(minute)}`,
    daily: `Every day at ${clock}`,
    weekdays: `Weekdays at ${clock}`,
    weekly: `Mondays at ${clock}`,
  }[kind] ?? expr;
}

async function loadRoutines() {
  try {
    state.routines = (await api.get('/api/routines')).data;
  } catch {
    state.routines = [];
  }
  renderRoutines();
}

function renderRoutines() {
  const list = $('routine-list');
  list.innerHTML = '';
  const mine = state.routines.filter((routine) => (state.current === 'group' ? !routine.bot_id : routine.bot_id === state.current));
  $('add-routine').hidden = state.current === 'group';
  if (!mine.length) {
    const bot = botById(state.current);
    list.appendChild(el('div', { class: 'empty-note' }, bot
      ? `No routines yet. Add one, or ask ${escapeHtml(bot.name)} to do something on a schedule.`
      : 'Routines the agent scheduled without naming a Bot show up here.'));
  }
  for (const routine of mine) {
    const row = el('div', { class: 'routine' }, `<div class="routine-main"><b>${escapeHtml(routine.name)}</b><span>${escapeHtml(describeSchedule(routine.schedule))}</span></div>`);
    const toggle = el('label', { class: 'switch', title: 'Active' }, `<input type="checkbox" ${routine.enabled ? 'checked' : ''} /><span></span>`);
    toggle.addEventListener('click', (event) => event.stopPropagation());
    toggle.querySelector('input').addEventListener('change', async (event) => {
      await setRoutineActive(routine, event.target.checked);
    });
    row.appendChild(toggle);
    row.addEventListener('click', () => openRoutineEditor(routine));
    list.appendChild(row);
  }
}

async function setRoutineActive(routine, enabled) {
  try {
    Object.assign(routine, await api.patch(`/api/routines/${routine.id}`, { enabled }));
  } catch (err) {
    alert(err.message);
  }
  renderRoutines();
}

$('add-routine').addEventListener('click', () => openRoutineEditor(null));

function closeDrawer() {
  $('drawer').hidden = true;
}

function openRoutineEditor(routine) {
  const bot = routine ? botById(routine.bot_id) : botById(state.current);
  const parsed = parseSchedule(routine?.schedule || '0 9 * * *');
  const drawer = $('drawer');
  drawer.innerHTML = `
    <div class="drawer-head"><h3>${routine ? 'Routine' : `New routine for ${escapeHtml(bot?.name || '')}`}</h3><button class="icon-btn" id="drawer-close" aria-label="Close">&#x2715;</button></div>
    <div class="row-actions" style="justify-content:space-between">
      <label class="inline"><span class="switch"><input type="checkbox" id="r-active" ${routine?.enabled === false ? '' : 'checked'} /><span></span></span>Active</label>
      <button id="r-test" ${routine ? '' : 'disabled'}>Test run</button>
    </div>
    <label>Name<input id="r-name" maxlength="50" placeholder="Morning briefing" /></label>
    <label>Instruction<textarea id="r-instruction" rows="6" placeholder="What ${escapeHtml(bot?.name || 'the Bot')} should do each time it runs"></textarea></label>
    <label>When to run
      <div class="when">
        <select id="r-kind">
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Every Monday</option>
          <option value="custom">Custom (cron)</option>
        </select>
        <input type="time" id="r-time" />
      </div>
      <input id="r-custom" class="mono" placeholder="*/30 * * * *" hidden />
    </label>
    <p class="muted small">Time zone: ${escapeHtml(routine?.timezone || state.me.timezone)}</p>
    <div class="row-actions">${routine ? '<button class="danger" id="r-delete">Delete</button>' : ''}<span class="spacer"></span><button class="primary" id="r-save">${routine ? 'Save' : 'Create routine'}</button></div>
    ${routine ? '<div><div class="pane-head"><span>Run history</span><button class="chip-btn" id="r-refresh">Refresh</button></div><div class="runs" id="r-runs"><div class="empty-note">Loading...</div></div></div>' : ''}`;
  drawer.hidden = false;
  const kind = drawer.querySelector('#r-kind');
  const time = drawer.querySelector('#r-time');
  const custom = drawer.querySelector('#r-custom');
  drawer.querySelector('#r-name').value = routine?.name || '';
  drawer.querySelector('#r-instruction').value = routine?.instruction || '';
  kind.value = parsed.kind;
  time.value = parsed.time;
  custom.value = routine?.schedule || '';
  const syncKind = () => {
    custom.hidden = kind.value !== 'custom';
    time.hidden = kind.value === 'custom';
  };
  syncKind();
  kind.addEventListener('change', syncKind);
  drawer.querySelector('#drawer-close').addEventListener('click', closeDrawer);

  drawer.querySelector('#r-active').addEventListener('change', async (event) => {
    if (routine) await setRoutineActive(routine, event.target.checked);
  });

  drawer.querySelector('#r-save').addEventListener('click', async (event) => {
    const fields = {
      name: drawer.querySelector('#r-name').value,
      instruction: drawer.querySelector('#r-instruction').value,
      schedule: buildSchedule(kind.value, time.value || '09:00', custom.value),
      enabled: drawer.querySelector('#r-active').checked,
    };
    if (!fields.instruction.trim()) return drawer.querySelector('#r-instruction').focus();
    event.target.disabled = true;
    try {
      const saved = routine
        ? await api.patch(`/api/routines/${routine.id}`, fields)
        : await api.post(`/api/bots/${bot.id}/routines`, { ...fields, timezone: state.me.timezone });
      await loadRoutines();
      openRoutineEditor(saved);
    } catch (err) {
      event.target.disabled = false;
      alert(err.message);
    }
  });

  if (!routine) return;

  drawer.querySelector('#r-delete').addEventListener('click', async () => {
    if (!confirm(`Delete the routine "${routine.name}"?`)) return;
    await api.del(`/api/routines/${routine.id}`).catch((err) => alert(err.message));
    closeDrawer();
    loadRoutines();
  });

  drawer.querySelector('#r-test').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await api.post(`/api/routines/${routine.id}/run`);
      toast(bot?.name || 'Routine', `Test run of "${routine.name}" started.`, null, bot);
      await delay(1500);
      loadRuns(routine);
    } catch (err) {
      alert(err.message);
    }
    event.target.disabled = false;
  });

  drawer.querySelector('#r-refresh').addEventListener('click', () => loadRuns(routine));
  loadRuns(routine);
}

async function loadRuns(routine) {
  const list = $('r-runs');
  if (!list) return;
  let runs = [];
  try {
    runs = (await api.get(`/api/routines/${routine.id}/runs`)).data;
  } catch (err) {
    list.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  list.innerHTML = runs.length ? '' : '<div class="empty-note">No runs yet. Use Test run to try it now.</div>';
  for (const run of runs) {
    const ok = run.status === 'triggered';
    const when = new Date(run.ran_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const row = el('div', { class: `run ${run.session_id ? 'clickable' : ''}` },
      `${ok ? '<span class="ok">&#10003;</span>' : '<span class="skip">&#8211;</span>'}<span>${when}</span><span class="muted">${ok ? 'Ran' : `Skipped: ${escapeHtml(run.reason || '')}`}</span>`);
    if (run.session_id) row.addEventListener('click', () => openTranscript(`${routine.name}, ${when}`, run.session_id));
    list.appendChild(row);
  }
}

// A routine run is a session of its own on the computer. Show what the Bot did there.
async function openTranscript(title, sessionId) {
  const body = el('div', { class: 'transcript' });
  const view = { id: null, el: body, lastDay: null };
  openModal(title, body, null);
  for (let attempt = 0; attempt < 40 && !$('modal').hidden; attempt += 1) {
    const session = await api.get(`/api/sessions/${sessionId}`).catch((err) => ({ history: [], error: err.message }));
    body.replaceChildren();
    view.lastDay = null;
    for (const message of session.history) addMessage(view, message.role, { at: message.created_at }).setText(message.content);
    if (session.error) addNote(view, 'error', session.error);
    if (!session.active_response_id && session.history.length) return;
    addNote(view, 'system', session.active_response_id ? 'Still working. This updates when the run finishes.' : 'Waiting for the run to start...');
    await delay(4000);
  }
}

// ---- notifications: the agent messaging first ----

async function pollNotifications() {
  try {
    const { data, unread } = await api.get('/api/notifications');
    $('bell-badge').hidden = !unread;
    $('bell-badge').textContent = unread;
    if (state.seenNotifications) {
      for (const note of data.filter((entry) => !state.seenNotifications.has(entry.id)).reverse()) {
        const bot = botById(note.bot_id);
        toast(bot?.name || 'Your computer', note.text, () => bot && select(bot.id), bot);
        loadRoutines();
      }
    }
    state.seenNotifications = new Set(data.map((entry) => entry.id));
    state.notifications = data;
  } catch {}
  setTimeout(pollNotifications, 5000);
}

$('bell').addEventListener('click', async (event) => {
  event.stopPropagation();
  const popover = $('notif-popover');
  if (!popover.hidden) return (popover.hidden = true);
  popover.innerHTML = '';
  const list = state.notifications || [];
  if (!list.length) popover.appendChild(el('div', { class: 'empty-note' }, 'Nothing yet. Bots message you here when a routine finishes or something is ready.'));
  for (const note of list) {
    const bot = botById(note.bot_id);
    const row = el('div', { class: `notif ${note.read ? '' : 'unread'}` },
      `${bot ? botAvatar(bot, 28) : ''}<div><p><b>${escapeHtml(bot?.name || 'Your computer')}</b> <span class="muted small">${formatTime(note.at)}</span></p><p>${escapeHtml(note.text)}</p></div>`);
    row.addEventListener('click', () => {
      popover.hidden = true;
      if (bot) select(bot.id);
    });
    popover.appendChild(row);
  }
  popover.hidden = false;
  await api.post('/api/notifications/read').catch(() => {});
  $('bell-badge').hidden = true;
});

// ---- settings: persona, memory, apps, computer ----

$('settings').addEventListener('click', () => openSettings('persona'));

function openSettings(tab) {
  const body = el('div', { class: 'stack' });
  const tabs = el('div', { class: 'tabs' });
  const panel = el('div', { class: 'stack' });
  for (const [key, label] of [['persona', 'Persona'], ['memory', 'Memory'], ['apps', 'Apps'], ['computer', 'Computer']]) {
    const button = el('button', { type: 'button', class: key === tab ? 'active' : '' }, label);
    button.addEventListener('click', () => openSettings(key));
    tabs.appendChild(button);
  }
  body.append(tabs, panel);
  openModal('Settings', body, null);
  ({ persona: renderPersona, memory: renderMemory, apps: renderApps, computer: renderComputer })[tab](panel);
}

async function renderPersona(panel) {
  panel.innerHTML = '<p class="muted small">SOUL.md is the persona every Bot on this computer shares: how it behaves, that it can schedule its own follow-ups, and how it messages you first. Each Bot adds its own name and description on top.</p><textarea rows="14" class="mono" id="soul">Loading...</textarea>';
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Save persona');
  const actions = el('div', { class: 'row-actions' });
  actions.appendChild(saveBtn);
  panel.appendChild(actions);
  const { text } = await api.get('/api/persona').catch((err) => ({ text: `Could not load: ${err.message}` }));
  panel.querySelector('#soul').value = text;
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    await api.put('/api/persona', { text: panel.querySelector('#soul').value }).catch((err) => alert(err.message));
    saveBtn.textContent = 'Saved';
  });
}

async function renderMemory(panel) {
  panel.innerHTML = '<div class="empty-note">Loading...</div>';
  const memory = await api.get('/api/memory').catch((err) => ({ error: err.message }));
  panel.innerHTML = '';
  if (memory.error) return panel.appendChild(el('div', { class: 'empty-note' }, escapeHtml(memory.error)));
  for (const [key, label, hint] of [
    ['user', 'About you', 'What the agent has learned about you. Every Bot reads it.'],
    ['memory', 'Shared memory', 'Facts and lessons the agent keeps across conversations. Every Bot reads it; each Bot also has its own notes file.'],
  ]) {
    const section = el('div', { class: 'stack' }, `<div><b>${label}</b><div class="muted small">${hint}</div></div>`);
    const entries = el('div', { class: 'entries' });
    const save = () => api.put(`/api/memory/${key}`, { entries: memory[key] }).catch((err) => alert(err.message));
    const paint = () => {
      entries.innerHTML = memory[key].length ? '' : '<div class="empty-note">Nothing yet.</div>';
      memory[key].forEach((entry, index) => {
        const row = el('div', { class: 'entry' }, `<span>${escapeHtml(entry)}</span>`);
        const remove = el('button', { type: 'button', 'aria-label': 'Forget' }, '&#x2715;');
        remove.addEventListener('click', async () => {
          memory[key].splice(index, 1);
          paint();
          await save();
        });
        row.appendChild(remove);
        entries.appendChild(row);
      });
    };
    paint();
    const add = el('form', { class: 'row-actions' }, '<input placeholder="Add something to remember" /><button class="primary">Add</button>');
    add.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = add.querySelector('input');
      if (!input.value.trim()) return;
      memory[key].push(input.value.trim());
      input.value = '';
      paint();
      await save();
    });
    section.append(entries, add);
    panel.appendChild(section);
  }
}

async function renderApps(panel) {
  panel.innerHTML = `<p class="muted small">Connect your apps to the shared computer. Sign-in happens with the app itself; your Bots never see a password or token.</p>
    <div><b>Connected</b><div class="entries" id="connected"><div class="empty-note">Loading...</div></div></div>
    <input id="app-search" placeholder="Search apps (Gmail, Slack, Notion...)" />
    <div class="toolkits" id="toolkits"></div>`;
  const loadConnections = async () => {
    const box = panel.querySelector('#connected');
    const { connections = [] } = await api.get('/api/apps/connections').catch(() => ({}));
    box.innerHTML = connections.length ? '' : '<div class="empty-note">No apps connected yet.</div>';
    for (const account of connections) {
      const row = el('div', { class: 'entry' }, `<span>${escapeHtml(account.toolkitName || account.toolkitSlug)} <span class="${account.status === 'ACTIVE' ? 'status-ok' : 'muted small'}">${escapeHtml(account.status)}</span></span>`);
      const remove = el('button', { type: 'button', 'aria-label': 'Disconnect' }, 'Disconnect');
      remove.addEventListener('click', async () => {
        await api.del(`/api/apps/connections/${account.id}`).catch((err) => alert(err.message));
        loadConnections();
      });
      row.appendChild(remove);
      box.appendChild(row);
    }
  };
  const loadToolkits = async (search = '') => {
    const grid = panel.querySelector('#toolkits');
    const { items = [] } = await api.get(`/api/apps/toolkits?search=${encodeURIComponent(search)}`).catch((err) => ({ items: [], error: err }));
    grid.innerHTML = '';
    for (const toolkit of items) {
      const card = el('div', { class: 'toolkit' }, `<img src="${escapeHtml(toolkit.logo || '')}" alt="" /><div><b>${escapeHtml(toolkit.name)}</b><small>${escapeHtml(toolkit.description || '')}</small></div>`);
      const connect = el('button', { type: 'button' }, 'Connect');
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        // Open the tab inside the click, while it still counts as a user gesture; popup
        // blockers refuse a window opened after an await.
        const tab = window.open('about:blank', '_blank');
        let started;
        try {
          started = await api.post('/api/apps/connect', { toolkit: toolkit.slug });
        } catch (err) {
          tab?.close();
          connect.disabled = false;
          return alert(err.message);
        }
        if (tab) {
          tab.opener = null;
          tab.location = started.redirectUrl;
        } else location.assign(started.redirectUrl);
        connect.textContent = 'Waiting...';
        // The sign-in tab ends on connected.html, which needs no cookie, so it works whichever
        // address this app was opened on. The connection list says when the account is live.
        for (let i = 0; i < 90 && panel.isConnected; i += 1) {
          await delay(3000);
          const { connections = [] } = await api.get('/api/apps/connections').catch(() => ({}));
          if (connections.some((account) => account.id === started.connectedAccountId && account.status === 'ACTIVE')) {
            toast('Apps', `${toolkit.name} is connected.`);
            connect.textContent = 'Connected';
            return loadConnections();
          }
        }
        connect.disabled = false;
        connect.textContent = 'Connect';
      });
      card.appendChild(connect);
      grid.appendChild(card);
    }
  };
  let timer;
  panel.querySelector('#app-search').addEventListener('input', (event) => {
    clearTimeout(timer);
    const value = event.target.value.trim();
    timer = setTimeout(() => loadToolkits(value.length >= 3 ? value : ''), 300);
  });
  loadConnections();
  loadToolkits();
}

function renderComputer(panel) {
  panel.innerHTML = `<p>All your Bots share one always-on computer: the same files, browser and terminal. It sleeps when nobody is using it and wakes for chats and routines.</p>
    <p class="muted small">Time zone for routines: ${escapeHtml(state.me.timezone)}</p>
    <div class="row-actions" style="justify-content:flex-start"><button class="danger" id="delete-computer">Delete my computer</button></div>
    <p class="footnote">An Agent37 example that mimics xAI's Grok Bot. Not affiliated with xAI.</p>`;
  panel.querySelector('#delete-computer').addEventListener('click', deleteComputer);
}


boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px">Could not start: ${escapeHtml(err.message)}</p>`;
});
