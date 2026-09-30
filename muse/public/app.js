// The browser half of the Muse example. It only ever talks to this app's own /api/me
// routes: the server resolves the cookie to the visitor's instance, so no instance id or
// API key ever appears here.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function h(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

async function request(path, init) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code });
  return body;
}

const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: (path) => request(path, { method: 'DELETE' }),
  // SSE endpoints need the raw Response; request() would consume the body as JSON.
  stream: (path, init) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init }),
};

const ICONS = {
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
};

function mascot(slot) {
  slot.replaceChildren($('#mascot').content.cloneNode(true));
  return slot;
}

// ---- tiny markdown: enough for agent replies (bold, code, links, bullets) ----

function renderMarkdown(text) {
  let html = esc(String(text).replace(/^\n+/, '').trimEnd());
  html = html.replace(/```\w*\n?([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Links to files the agent saved open in the Library preview instead of a dead path.
  html = html.replace(/\[([^\]\n]+)\]\((?:~|\/home\/node)\/muse\/library\/([^)\s]+)\)/g, '<a href="#" data-lib="$2">$1</a>');
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  html = html.replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
  html = html.replace(/^\s*[-*] (.+)$/gm, '• $1');
  return html;
}

function ago(when) {
  const ms = Date.now() - (typeof when === 'number' ? when : Date.parse(when));
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

function when(epochMs) {
  return new Date(epochMs).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

let toastTimer;
function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2800);
}

// ---- state ----

let me = null;
let tab = 'chat';
let current = null; // the session id on screen
const threads = new Map(); // session id -> { inFlight, queue, turnEl, queueEl }
let notifications = [];
let seenNotifications = new Set();

function thread(sid) {
  if (!threads.has(sid)) threads.set(sid, { inFlight: null, starting: false, queue: [], turnEl: null, queueEl: null });
  return threads.get(sid);
}

// ---- boot and onboarding ----

async function boot() {
  me = await api.get('/api/me');
  if (me.state === 'ready') return enterApp();
  showOnboarding();
}

function showOnboarding() {
  $('#app').hidden = true;
  $('#onboarding').hidden = false;
  const busy = ['creating', 'booting', 'setting_up'].includes(me.state);
  const failed = me.state === 'failed';
  $('#ob-form').hidden = busy || failed;
  $('#ob-progress').hidden = !busy && !failed;
  document.querySelectorAll('#onboarding .mascot-slot').forEach(mascot);
  if (busy || failed) return showProgress();
  const swatches = $('.swatches');
  if (!swatches.children.length) {
    for (const color of ['sky', 'peach', 'mint', 'lilac']) {
      const button = h('button', color === 'sky' ? 'on' : '');
      button.type = 'button';
      button.dataset.value = color;
      button.style.setProperty('--mascot', `url(#m-${color})`);
      button.appendChild(mascot(h('span', 'mascot-slot')));
      button.firstChild.style.cssText = 'width:100%;height:100%';
      swatches.appendChild(button);
    }
  }
  $('input[name=your_name]').focus();
}

for (const group of document.querySelectorAll('#ob-form .chips, #ob-form .swatches')) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === button));
    if (group.dataset.name === 'avatar') document.documentElement.dataset.avatar = button.dataset.value;
  });
}

$('#ob-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const button = event.target.querySelector('.primary');
  button.disabled = true;
  try {
    me = await api.post('/api/me/agent', {
      your_name: form.get('your_name'),
      agent_name: form.get('agent_name'),
      tone: $('.chips[data-name=tone] .on')?.dataset.value,
      avatar: $('.swatches .on')?.dataset.value,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    showOnboarding();
  } catch (err) {
    toast(err.message);
  }
  button.disabled = false;
});

async function showProgress() {
  const order = ['creating', 'booting', 'setting_up'];
  while (true) {
    document.documentElement.dataset.avatar = me.profile?.avatar || 'sky';
    $('#ob-title').textContent = me.state === 'failed' ? 'Something went wrong' : `Setting up ${me.profile?.agentName || 'your agent'}`;
    const at = order.indexOf(me.state);
    document.querySelectorAll('.steps li').forEach((li, index) => {
      li.className = me.state === 'failed' ? '' : index < at ? 'done' : index === at ? 'now' : '';
    });
    $('#ob-progress').dataset.mood = me.state === 'failed' ? 'idle' : 'working';
    $('#ob-error').hidden = $('#ob-retry').hidden = $('#ob-reset').hidden = me.state !== 'failed';
    $('#ob-error').textContent = me.error || '';
    if (me.state === 'ready') return enterApp();
    if (me.state === 'failed' || me.state === 'new') return;
    await delay(2500);
    me = await api.get('/api/me').catch(() => me);
  }
}

$('#ob-retry').addEventListener('click', async () => {
  me = await api.post('/api/me/agent', {
    your_name: me.profile.yourName,
    agent_name: me.profile.agentName,
    tone: me.profile.tone,
    avatar: me.profile.avatar,
    timezone: me.profile.timezone,
  });
  showOnboarding();
});

// Try again reuses the instance it already has; Start over deletes it and goes back to the form.
$('#ob-reset').addEventListener('click', async () => {
  try {
    await api.del('/api/me/agent');
  } catch (err) {
    return toast(err.message);
  }
  location.reload();
});

async function enterApp() {
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  applyProfile();
  mascot($('#avatar-btn .mascot-slot'));
  setMood('idle');
  await pollNotifications(true);
  await openThread(me.main_session_id);
  setInterval(pollNotifications, 8000);
}

function applyProfile() {
  document.documentElement.dataset.avatar = me.profile.avatar;
  $('#agent-name').textContent = me.profile.agentName;
}

// ---- mascot status: driven by the SSE events of the turn on screen ----

function setMood(mood, text) {
  $('.top').dataset.mood = mood;
  $('#agent-status').textContent = mood === 'idle' ? me.profile.tagline || 'Here for you' : text;
}

function moodFor(sid, mood, text) {
  if (sid === current) setMood(mood, text);
}

function toolStatus(tool) {
  if (tool.startsWith('browser_')) return 'Browsing the web...';
  if (/web_search|web_extract|brave/.test(tool)) return 'Searching the web...';
  if (/write_file|patch/.test(tool)) return 'Making something...';
  if (/read_file|search_files/.test(tool)) return 'Reading files...';
  if (tool === 'memory') return 'Remembering...';
  if (tool === 'session_search') return 'Looking back...';
  if (/terminal|execute_code|process/.test(tool)) return 'Working on its computer...';
  if (tool === 'delegate_task') return 'Getting help...';
  if (/image/.test(tool)) return 'Drawing...';
  if (/speech|tts/.test(tool)) return 'Recording audio...';
  if (/composio|mcp_/.test(tool)) return 'Using your apps...';
  return 'Working...';
}

function browserStep({ tool, label, arguments: args }) {
  if (tool === 'browser_navigate') {
    try {
      return `Opening ${new URL(label || args?.url).hostname}...`;
    } catch {
      return 'Opening a page...';
    }
  }
  if (tool === 'browser_click') return 'Clicking...';
  if (tool === 'browser_type' || tool === 'browser_press') return 'Typing...';
  if (tool === 'browser_scroll') return 'Scrolling...';
  if (tool === 'browser_back') return 'Going back...';
  if (tool.startsWith('browser_vault')) return 'Checking saved logins...';
  return 'Reading the page...';
}

// ---- tabs ----

document.querySelector('.tabbar').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) showTab(button.dataset.tab);
});

function showTab(name) {
  tab = name;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('main .tab').forEach((section) => (section.hidden = section.id !== `tab-${name}`));
  $('#menu-btn').style.visibility = name === 'chat' ? 'visible' : 'hidden';
  if (name === 'ideas') loadIdeas();
  if (name === 'goals') loadGoals();
  if (name === 'library') loadLibrary();
}

// ---- chat ----

const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#send');

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function userBubble(text) {
  const bubble = h('div', 'bubble user');
  bubble.textContent = text;
  return bubble;
}

function agentBubble(text) {
  return h('div', 'bubble agent', renderMarkdown(text));
}

function noticeBubble(item) {
  return h(
    'div',
    'bubble notice',
    `<div class="notice-head">${ICONS.bell}${esc(item.title || 'From your agent')}</div>${renderMarkdown(item.body || '')}`
  );
}

function note(text) {
  const node = h('div', 'bubble note');
  node.textContent = text;
  messagesEl.appendChild(node);
  scrollToBottom();
}

function emptyChat() {
  const box = h('div', 'empty-chat');
  box.appendChild(mascot(h('span', 'mascot-slot lg')));
  box.appendChild(h('h2', '', `Hi ${esc(me.profile.yourName)}, I'm ${esc(me.profile.agentName)}`));
  box.appendChild(h('p', 'muted', 'Ask me for anything. I can keep working after you close the app.'));
  const suggestions = h('div', 'suggestions');
  for (const text of ['What can you do for me?', 'Remind me to stretch every day at 5pm', 'Help me set a goal for this month']) {
    const chip = h('button');
    chip.type = 'button';
    chip.textContent = text;
    chip.addEventListener('click', () => send(current, text));
    suggestions.appendChild(chip);
  }
  box.appendChild(suggestions);
  return box;
}

async function openThread(sid) {
  current = sid;
  messagesEl.replaceChildren();
  const isMain = sid === me.main_session_id;
  $('#thread-chip').hidden = isMain;
  $('#thread-chip').textContent = 'Side chat';
  const state = thread(sid);
  setMood(state.inFlight ? 'working' : 'idle', 'Working...');
  updateSendButton();
  let session;
  try {
    session = await api.get(`/api/me/sessions/${sid}`);
  } catch (err) {
    return note(err.message);
  }
  if (current !== sid) return;
  const items = session.history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ kind: message.role, text: message.content, at: message.created_at }));
  // Messages the agent sent first (reminders, check-ins) live in the main chat, in time order.
  if (isMain) for (const item of notifications) items.push({ kind: 'notice', item, at: item.created });
  items.sort((a, b) => a.at - b.at);
  if (!items.length && !state.inFlight && !state.queue.length) messagesEl.appendChild(emptyChat());
  for (const entry of items) {
    if (entry.kind === 'user') messagesEl.appendChild(userBubble(entry.text));
    else if (entry.kind === 'assistant') messagesEl.appendChild(agentBubble(entry.text));
    else messagesEl.appendChild(noticeBubble(entry.item));
  }
  if (state.turnEl) messagesEl.appendChild(state.turnEl);
  if (state.queueEl) messagesEl.appendChild(state.queueEl);
  // A turn this tab did not start (another tab, a reload mid-turn) is still running: follow it.
  if (session.active_response_id && !state.inFlight && !state.starting) follow(sid, session.active_response_id);
  scrollToBottom();
}

function makeAgentUi(box, sid) {
  let raw = '';
  let typingEl = null;
  let textEl = null;
  let browserEl = null;
  const ui = {
    typing(on = true) {
      if (on && !typingEl) {
        typingEl = h('div', 'bubble agent typing', '<i></i><i></i><i></i>');
        box.appendChild(typingEl);
      }
      if (!on && typingEl) {
        typingEl.remove();
        typingEl = null;
      }
      if (on) box.appendChild(typingEl);
      scrollIfCurrent(sid);
    },
    appendText(text) {
      raw += text;
      if (!textEl) {
        textEl = h('div', 'bubble agent');
        box.insertBefore(textEl, typingEl);
      }
      textEl.innerHTML = renderMarkdown(raw);
      ui.typing(false);
      scrollIfCurrent(sid);
    },
    // Muse's Browser card, status only: the stock image's browser is headless, so the
    // card narrates the browser_* tool calls from the stream instead of showing a view.
    browser(step) {
      if (!browserEl) {
        browserEl = h(
          'div',
          'browser-card',
          `<div class="browser-row"><div class="globe">${ICONS.globe}</div><div><strong>Browser</strong><span></span></div></div><button class="pill" type="button">Stop</button>`
        );
        browserEl.querySelector('button').addEventListener('click', () => cancel(sid));
        box.insertBefore(browserEl, textEl || typingEl);
      }
      browserEl.querySelector('span').textContent = step;
      scrollIfCurrent(sid);
    },
    finish(text, sawTools) {
      ui.typing(false);
      if (browserEl) {
        browserEl.querySelector('span').textContent = 'Done';
        browserEl.querySelector('button').remove();
        browserEl = null;
      }
      const final = String(text ?? '').replace(/^\n+/, '');
      if (final) {
        if (!textEl) {
          textEl = h('div', 'bubble agent');
          box.appendChild(textEl);
        }
        textEl.innerHTML = renderMarkdown(final);
      } else {
        textEl?.remove();
        if (!sawTools) ui.error('The agent returned an empty reply. Its monthly allowance or the workspace balance is probably used up.');
      }
    },
    error(message) {
      ui.typing(false);
      const bubble = h('div', 'bubble error');
      bubble.textContent = message;
      box.appendChild(bubble);
      scrollIfCurrent(sid);
    },
    reset() {
      box.replaceChildren();
      raw = '';
      typingEl = textEl = browserEl = null;
      ui.typing();
    },
  };
  return ui;
}

const attached = (node) => (node?.parentNode === messagesEl ? node : null);

function scrollIfCurrent(sid) {
  if (sid === current) scrollToBottom();
}

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

async function consume(sid, response, ui) {
  const state = thread(sid);
  let sawTerminal = false;
  let sawTools = false;
  for await (const { event, data } of sseFrames(response)) {
    switch (event) {
      case 'response.created':
        state.inFlight = data.id;
        moodFor(sid, 'thinking', 'Thinking...');
        updateSendButton();
        break;
      case 'response.reasoning.delta':
        moodFor(sid, 'thinking', 'Thinking...');
        break;
      case 'response.output_text.delta':
        ui.appendText(data.text);
        moodFor(sid, 'typing', 'Typing...');
        break;
      case 'response.tool_call.generating':
      case 'response.tool_call.started':
        sawTools = true;
        ui.typing();
        moodFor(sid, 'working', toolStatus(data.tool));
        if (data.tool.startsWith('browser_')) ui.browser(browserStep(data));
        break;
      case 'response.completed':
        sawTerminal = true;
        ui.finish(data.output_text, sawTools);
        break;
      case 'response.failed':
        sawTerminal = true;
        ui.error(data.error?.message || 'The turn failed.');
        break;
    }
  }
  return sawTerminal;
}

// Consume a stream, and if it closes without a terminal event (a dropped connection, not a
// failed turn) reattach with GET /responses/{id}/stream, which replays from the start.
async function drive(sid, response, ui) {
  const state = thread(sid);
  let done = false;
  try {
    done = await consume(sid, response, ui);
  } catch {}
  for (let attempt = 1; !done && state.inFlight && attempt <= 8; attempt += 1) {
    if (attempt > 1) await delay(1500);
    try {
      const replay = await api.stream(`/api/me/responses/${state.inFlight}/stream`);
      if (!isSse(replay)) throw new Error('not a stream');
      ui.reset();
      done = await consume(sid, replay, ui);
    } catch {}
  }
  if (!done) ui.error('Lost the connection. Reopen the chat to see the reply.');
}

function startTurnUi(sid, texts) {
  const state = thread(sid);
  const turnEl = h('div', 'turn');
  for (const text of texts) turnEl.appendChild(userBubble(text));
  const box = h('div', 'agent-box');
  turnEl.appendChild(box);
  state.turnEl = turnEl;
  if (sid === current) {
    messagesEl.querySelector('.empty-chat')?.remove();
    messagesEl.insertBefore(turnEl, attached(state.queueEl));
  }
  const ui = makeAgentUi(box, sid);
  ui.typing();
  return ui;
}

function endTurn(sid) {
  const state = thread(sid);
  state.inFlight = null;
  state.starting = false;
  state.turnEl = null;
  moodFor(sid, 'idle');
  updateSendButton();
  flushQueue(sid);
}

// Muse is not turn by turn: you can keep typing while it works. A session runs one turn at
// a time (409 session_busy), so messages sent meanwhile wait here and go out together.
function send(sid, text) {
  const state = thread(sid);
  if (state.inFlight || state.starting) {
    state.queue.push(text);
    renderQueue(sid);
    return;
  }
  runTurn(sid, [text]);
}

function renderQueue(sid) {
  const state = thread(sid);
  state.queueEl?.remove();
  state.queueEl = null;
  if (!state.queue.length) return;
  state.queueEl = h('div', 'turn');
  for (const text of state.queue) state.queueEl.appendChild(userBubble(text));
  state.queueEl.appendChild(h('div', 'queued-tag', 'Queued, sends when this reply finishes'));
  if (sid === current) {
    messagesEl.appendChild(state.queueEl);
    scrollToBottom();
  }
}

function flushQueue(sid) {
  const state = thread(sid);
  if (!state.queue.length) return;
  const texts = state.queue.splice(0);
  renderQueue(sid);
  runTurn(sid, texts);
}

async function runTurn(sid, texts) {
  const state = thread(sid);
  state.starting = true;
  updateSendButton();
  const ui = startTurnUi(sid, texts);
  moodFor(sid, 'thinking', 'Thinking...');
  let response;
  try {
    response = await api.stream('/api/me/responses', { method: 'POST', body: JSON.stringify({ input: texts.join('\n\n'), session_id: sid }) });
  } catch (err) {
    ui.error(`Could not reach the server: ${err.message}`);
    return endTurn(sid);
  }
  if (!isSse(response)) {
    const body = await response.json().catch(() => null);
    if (body?.error?.code === 'session_busy') {
      // Something else holds the session (another tab, a reload mid-turn). Put these
      // messages back in the queue and follow the running turn; they go out after it.
      state.turnEl?.remove();
      state.turnEl = null;
      state.starting = false;
      state.queue.unshift(...texts);
      renderQueue(sid);
      if (body.error.response_id) return follow(sid, body.error.response_id);
      await delay(3000);
      return flushQueue(sid);
    }
    ui.error(body?.error?.message || `Request failed (HTTP ${response.status}).`);
    return endTurn(sid);
  }
  await drive(sid, response, ui);
  endTurn(sid);
}

async function follow(sid, responseId) {
  const state = thread(sid);
  if (state.inFlight) return;
  state.inFlight = responseId;
  updateSendButton();
  const ui = startTurnUi(sid, []);
  moodFor(sid, 'working', 'Working...');
  try {
    const replay = await api.stream(`/api/me/responses/${responseId}/stream`);
    if (isSse(replay)) await drive(sid, replay, ui);
    else state.turnEl?.remove();
  } catch {}
  endTurn(sid);
}

async function cancel(sid) {
  const state = thread(sid);
  if (!state.inFlight) return;
  try {
    // Cancel is asynchronous: the stream then ends with response.completed (partial text).
    await api.post(`/api/me/responses/${state.inFlight}/cancel`);
    moodFor(sid, 'working', 'Stopping...');
  } catch (err) {
    toast(`Could not stop: ${err.message}`);
  }
}

function updateSendButton() {
  const busy = Boolean(current && (thread(current).inFlight || thread(current).starting));
  sendBtn.classList.toggle('stop', busy && !inputEl.value.trim());
  sendBtn.setAttribute('aria-label', sendBtn.classList.contains('stop') ? 'Stop' : 'Send');
}

messagesEl.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-lib]');
  if (!link) return;
  event.preventDefault();
  const name = link.dataset.lib;
  previewFile(name, kindOf(name)[0]);
});

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (sendBtn.classList.contains('stop')) return cancel(current);
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  autosize();
  send(current, text);
  updateSendButton();
});

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

inputEl.addEventListener('input', () => {
  autosize();
  updateSendButton();
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

function sendToMain(text) {
  showTab('chat');
  const go = () => send(me.main_session_id, text);
  if (current !== me.main_session_id) openThread(me.main_session_id).then(go);
  else go();
}

// ---- notifications: the agent messaging first, via POST /api/notify on the server ----

async function pollNotifications(initial = false) {
  let data;
  try {
    ({ data } = await api.get('/api/me/notifications'));
  } catch {
    return;
  }
  const fresh = data.filter((item) => !seenNotifications.has(item.id));
  notifications = data;
  seenNotifications = new Set(data.map((item) => item.id));
  const unread = data.filter((item) => !item.read).length;
  $('#badge').hidden = !unread;
  $('#badge').textContent = unread;
  if (initial || !fresh.length) return;
  const latest = fresh[fresh.length - 1];
  showBanner(latest);
  if (current === me.main_session_id) {
    const state = thread(current);
    for (const item of fresh) messagesEl.insertBefore(noticeBubble(item), attached(state.turnEl) || attached(state.queueEl));
    messagesEl.querySelector('.empty-chat')?.remove();
    scrollToBottom();
  }
}

let bannerTimer;
function showBanner(item) {
  const banner = $('#banner');
  banner.replaceChildren(mascot(h('span', 'mascot-slot')), h('div', '', `<strong>${esc(item.title || me.profile.agentName)}</strong><span>${esc(item.body)}</span>`));
  banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (banner.hidden = true), 7000);
}

$('#banner').addEventListener('click', () => {
  $('#banner').hidden = true;
  markRead();
  showTab('chat');
  if (current !== me.main_session_id) openThread(me.main_session_id);
  else scrollToBottom();
});

async function markRead() {
  await api.post('/api/me/notifications/read').catch(() => {});
  for (const item of notifications) item.read = true;
  $('#badge').hidden = true;
}

$('#bell-btn').addEventListener('click', () => {
  openSheet('Notifications', (body) => {
    if (!notifications.length) return (body.innerHTML = `<p class="empty-state">When ${esc(me.profile.agentName)} has something for you, it shows up here and in your chat.</p>`);
    const group = h('div', 'group');
    for (const item of [...notifications].reverse()) {
      const row = h('button', 'item', `<div class="grow"><strong>${esc(item.title)}</strong><small>${esc(item.body)}</small><small>${ago(item.created)}</small></div>`);
      row.addEventListener('click', () => {
        closeSheet();
        showTab('chat');
        openThread(me.main_session_id);
      });
      group.appendChild(row);
    }
    body.appendChild(group);
  });
  markRead();
});

// ---- side chats ----

$('#menu-btn').addEventListener('click', () => openSheet('Chats', renderChats, { action: newSideChatButton() }));

function newSideChatButton() {
  const button = h('button', 'round small', '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>');
  button.setAttribute('aria-label', 'New side chat');
  button.addEventListener('click', async () => {
    const created = await api.post('/api/me/threads');
    closeSheet();
    openThread(created.id);
  });
  return button;
}

async function renderChats(body) {
  body.innerHTML = '<div class="skeleton"></div>';
  const { data } = await api.get('/api/me/threads');
  const group = h('div', 'group');
  for (const item of data) {
    const label = item.main ? 'Main chat' : item.title || 'New side chat';
    const row = h('div', 'item', `<div class="grow"><strong>${esc(label)}</strong><small>${item.main ? esc(item.title || 'Your conversation') : ago(item.last_active)}</small></div>`);
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      closeSheet();
      openThread(item.id);
    });
    if (!item.main) {
      const remove = h('button', 'link danger', 'Delete');
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        await api.del(`/api/me/threads/${item.id}`);
        if (current === item.id) openThread(me.main_session_id);
        renderChats(body);
      });
      row.appendChild(remove);
    }
    group.appendChild(row);
  }
  body.replaceChildren(h('p', 'muted', 'Side chats are for tangents. They share the same memory as your main chat.'), group);
  body.firstChild.style.cssText = 'font-size:14px;margin:0 4px 12px';
}

// ---- Ideas: a daily platform cron has the agent write ~/muse/ideas.json ----

let ideasPoll = null;

async function loadIdeas() {
  const list = $('#ideas-list');
  if (!list.children.length) list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  let data;
  try {
    data = await api.get('/api/me/ideas');
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
    return;
  }
  $('#ideas-meta').textContent = ideasPoll
    ? `${me.profile.agentName} is thinking of new ideas...`
    : data.updated
      ? `Updated ${ago(data.updated)}`
      : `${me.profile.agentName} is writing your first ideas. Check back in a minute.`;
  list.replaceChildren();
  for (const idea of data.ideas) {
    const row = h(
      'button',
      'row',
      `<span class="idea-emoji">${esc(idea.emoji || '💡')}</span><span class="grow"><strong>${esc(idea.title)}</strong><span class="sub">${esc(idea.detail)}</span></span>`
    );
    row.addEventListener('click', () => sendToMain(idea.prompt || idea.title));
    list.appendChild(row);
  }
  if (!data.ideas.length && !data.updated) list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  return data.updated;
}

$('#ideas-refresh').addEventListener('click', async () => {
  if (ideasPoll) return;
  const before = await loadIdeas();
  try {
    await api.post('/api/me/ideas/refresh');
  } catch (err) {
    return toast(err.message);
  }
  ideasPoll = true;
  loadIdeas();
  // The run is fire and forget; watch the file until the agent rewrites it.
  for (let i = 0; i < 30 && ideasPoll; i += 1) {
    await delay(8000);
    const data = await api.get('/api/me/ideas').catch(() => null);
    if (data?.updated && data.updated !== before) break;
  }
  ideasPoll = null;
  if (tab === 'ideas') loadIdeas();
});

// ---- Goals: the agent keeps ~/muse/goals.json and one cron per check-in ----

const CATEGORIES = [
  ['Health', '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>'],
  ['Money', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v11"/></svg>'],
  ['Learning', '<svg viewBox="0 0 24 24"><path d="M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z"/><path d="M12 6v13.5"/></svg>'],
  ['Relationships', '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M14.5 14.3c.6-.2 1.3-.3 2-.3 2.2 0 3.8 1.6 4.2 4"/></svg>'],
  ['Track something', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/></svg>'],
];

function renderCategories() {
  const list = $('#goal-categories');
  if (list.children.length) return;
  for (const [name, icon] of CATEGORIES) {
    const row = h('button', 'row cat', `${icon}<span class="grow">${name}</span><span class="plus">+</span>`);
    row.addEventListener('click', () => newGoalSheet(name));
    list.appendChild(row);
  }
}

function newGoalSheet(category) {
  const tracking = category === 'Track something';
  openSheet(tracking ? 'Track something' : `New ${category.toLowerCase()} goal`, (body) => {
    body.innerHTML = `<label class="field">${tracking ? 'What should it keep an eye on?' : 'What do you want to work toward?'}
      <textarea rows="3" placeholder="${tracking ? 'Flights to Lisbon under $400 in May' : 'Run a 10k by December'}"></textarea></label>
      <button class="primary" type="button">${tracking ? 'Start tracking' : 'Make it a plan'}</button>`;
    body.querySelector('.primary').addEventListener('click', () => {
      const text = body.querySelector('textarea').value.trim();
      if (!text) return;
      closeSheet();
      sendToMain(
        tracking
          ? `Track this for me: ${text}. Add it to my goals as tracking and check on it on a schedule.`
          : `New ${category.toLowerCase()} goal: ${text}. Turn it into a plan, add it to my goals, and schedule check-ins.`
      );
    });
  });
}

async function loadGoals() {
  renderCategories();
  const list = $('#goals-list');
  if (!list.children.length) list.innerHTML = '<div class="skeleton"></div>';
  let data;
  try {
    data = await api.get('/api/me/goals');
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
    return;
  }
  list.replaceChildren();
  const sections = [
    ['tracking', 'Tracking', data.goals.filter((goal) => goal.kind === 'tracking')],
    ['goals', 'Goals', data.goals.filter((goal) => goal.kind !== 'tracking')],
  ];
  for (const [key, label, goals] of sections) {
    if (!goals.length) continue;
    list.appendChild(h('div', `section-label ${key}`, `<i></i>${label}`));
    const box = h('div', 'list');
    goals.forEach((goal, index) => {
      const row = goalRow(goal, key);
      if (index >= 3) row.hidden = true;
      box.appendChild(row);
    });
    if (goals.length > 3) {
      const more = h('button', 'more', `Show ${goals.length - 3} more`);
      more.addEventListener('click', () => {
        box.querySelectorAll('.row[hidden]').forEach((row) => (row.hidden = false));
        more.remove();
      });
      box.appendChild(more);
    }
    list.appendChild(box);
  }
  if (!data.goals.length) {
    list.innerHTML = `<p class="empty-state">Nothing tracked yet. Tell ${esc(me.profile.agentName)} what you're working toward, or pick a category below.</p>`;
  }
}

function nextCheckIn(goal) {
  if (goal.next_run) return when(goal.next_run * 1000);
  if (goal.next_check_in && Number.isFinite(Date.parse(goal.next_check_in))) return when(Date.parse(goal.next_check_in));
  return null;
}

function goalRow(goal, key) {
  const progress = Math.max(0, Math.min(100, Number(goal.progress) || 0));
  const next = nextCheckIn(goal);
  const row = h(
    'button',
    `row ${key === 'tracking' ? 'tracking-row' : ''}`,
    `<span class="check ${progress >= 100 ? 'done' : ''}"></span><span class="grow"><strong>${esc(goal.title)}</strong><span class="sub">${esc(goal.detail || '')}</span><span class="progress"><b style="width:${progress}%"></b></span><span class="meta">${progress}%${next ? ` · Next check-in ${esc(next)}` : ''}</span></span>${ICONS.chev}`
  );
  row.addEventListener('click', () => goalSheet(goal));
  return row;
}

function goalSheet(goal) {
  openSheet(goal.kind === 'tracking' ? 'Tracking' : 'Goal', (body) => {
    const next = nextCheckIn(goal);
    body.innerHTML = `<div class="group"><div class="item"><div class="grow"><strong>${esc(goal.title)}</strong><small>${esc(goal.detail || '')}</small>
      <div class="progress"><b style="width:${Math.min(100, Number(goal.progress) || 0)}%"></b></div>
      <small>${Number(goal.progress) || 0}% · ${next ? `Next check-in ${esc(next)}` : 'No check-in scheduled'}</small></div></div></div>`;
    if (goal.cron_id) {
      const now = h('button', 'primary', 'Check in now');
      now.addEventListener('click', async () => {
        await api.post(`/api/me/crons/${goal.cron_id}/run`).catch((err) => toast(err.message));
        closeSheet();
        toast(`${me.profile.agentName} is checking in. It will message you.`);
      });
      body.appendChild(now);
    }
    const ask = h('button', 'pill', 'Ask about it in chat');
    ask.style.marginTop = '10px';
    ask.addEventListener('click', () => {
      closeSheet();
      sendToMain(`How is "${goal.title}" going?`);
    });
    body.appendChild(ask);
  });
}

// ---- Library: what the agent made, listed through the Files API ----

const KINDS = [
  ['doc', 'Documents', /\.(md|txt|pdf|docx?|csv|xlsx?|json|rtf|pptx?)$/i],
  ['web', 'Web artifacts', /\.html?$/i],
  ['image', 'Images', /\.(png|jpe?g|gif|webp|svg)$/i],
  ['audio', 'Audio', /\.(mp3|wav|ogg|m4a|opus)$/i],
  ['other', 'Other', /./],
];

const kindOf = (name) => KINDS.find(([, , pattern]) => pattern.test(name));
const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'file').slice(0, 4).toUpperCase();
const sizeOf = (bytes) => (bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

async function loadLibrary() {
  const list = $('#library-list');
  if (!list.children.length) list.innerHTML = '<div class="skeleton"></div>';
  let data;
  try {
    ({ data } = await api.get('/api/me/library'));
  } catch (err) {
    list.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
    return;
  }
  list.replaceChildren();
  if (!data.length) list.appendChild(h('p', 'empty-state', `Documents, pages and images ${esc(me.profile.agentName)} makes for you land here.`));
  for (const [key, label] of KINDS) {
    const files = data.filter((file) => kindOf(file.name)[0] === key);
    if (!files.length) continue;
    list.appendChild(h('div', 'lib-group', label));
    const box = h('div', 'list');
    for (const file of files) {
      const row = h(
        'button',
        'row',
        `<span class="file-icon k-${key}">${extOf(file.name)}</span><span class="grow"><strong>${esc(file.name)}</strong><span class="meta">${sizeOf(file.size)} · ${ago(file.modified)}</span></span>${ICONS.chev}`
      );
      row.addEventListener('click', () => previewFile(file.name, key));
      box.appendChild(row);
    }
    list.appendChild(box);
  }
  list.appendChild(h('div', 'lib-group', 'System files'));
  const system = h('div', 'list');
  for (const [name, open] of [
    ['SOUL.md', soulSheet],
    ['USER.md', memorySheet],
    ['MEMORY.md', memorySheet],
  ]) {
    const row = h('button', 'row', `<span class="file-icon k-system">MD</span><span class="grow"><strong>${name}</strong></span>${ICONS.chev}`);
    row.addEventListener('click', () => open());
    system.appendChild(row);
  }
  list.appendChild(system);
}

$('#library-refresh').addEventListener('click', loadLibrary);

function previewFile(name, kind) {
  const url = `/api/me/library/file?name=${encodeURIComponent(name)}`;
  openSheet(name.split('/').pop(), async (body) => {
    if (kind === 'web') {
      // srcdoc in a sandbox without allow-same-origin: the page gets an opaque origin, so
      // whatever the agent wrote can run its own scripts but never touch this app.
      const frame = h('iframe', 'preview-frame');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = await (await fetch(url)).text();
      body.appendChild(frame);
    } else if (kind === 'image') {
      body.appendChild(Object.assign(h('img', 'preview-img'), { src: url, alt: name }));
    } else if (kind === 'audio') {
      body.appendChild(Object.assign(h('audio'), { src: url, controls: true, style: 'width:100%' }));
    } else if (/\.(md|txt|csv|json)$/i.test(name)) {
      const pre = h('pre', 'preview-text');
      pre.textContent = await (await fetch(url)).text();
      body.appendChild(pre);
    } else {
      body.appendChild(h('p', 'empty-state', 'No preview for this file type.'));
    }
    const download = h('a', 'primary', 'Download');
    download.href = `${url}&download=1`;
    download.style.textAlign = 'center';
    download.style.textDecoration = 'none';
    body.appendChild(download);
  });
}

function soulSheet() {
  openSheet('SOUL.md', async (body) => {
    const pre = h('pre', 'preview-text', 'Loading...');
    body.appendChild(pre);
    pre.textContent = (await api.get('/api/me/soul')).text;
  });
}

// ---- the Assistant menu (tap the mascot) ----

$('#avatar-btn').addEventListener('click', () => {
  openSheet('', (body) => {
    const hero = h('div', 'hero');
    hero.appendChild(mascot(h('span', 'mascot-slot lg')));
    hero.appendChild(h('h3', '', esc(me.profile.agentName)));
    hero.appendChild(h('p', 'muted', esc(me.profile.tagline || `${me.profile.yourName}'s personal agent`)));
    hero.lastChild.style.margin = '0';
    const group = h('div', 'group');
    for (const [label, sub, open] of [
      ['Identity', 'Name, look and personality', identitySheet],
      ['Memory', 'What it remembers about you', memorySheet],
      ['Upcoming', 'Reminders and scheduled tasks', upcomingSheet],
      ['Connectors', 'Gmail, Calendar, Notion and more', connectorsSheet],
    ]) {
      const row = h('button', 'item', `<div class="grow"><strong>${label}</strong><small>${sub}</small></div>${ICONS.chev}`);
      row.addEventListener('click', open);
      group.appendChild(row);
    }
    const data = h('div', 'group');
    const exportRow = h('a', 'item', '<div class="grow"><strong>Download my memories</strong><small>USER.md and MEMORY.md as one file</small></div>');
    exportRow.href = '/api/me/memory/export';
    exportRow.style.cssText = 'text-decoration:none;color:inherit';
    const reset = h('button', 'item', `<div class="grow"><strong class="danger">Reset ${esc(me.profile.agentName)}</strong><small>Deletes its computer, memory and files</small></div>`);
    reset.addEventListener('click', resetAgent);
    data.append(exportRow, reset);
    body.append(hero, group, data);
  });
});

async function resetAgent() {
  if (!confirm(`Delete ${me.profile.agentName} and everything on its computer? This cannot be undone.`)) return;
  try {
    await api.del('/api/me/agent');
  } catch (err) {
    return toast(err.message);
  }
  location.reload();
}

function identitySheet() {
  openSheet('Identity', (body) => {
    body.innerHTML = `
      <label class="field">Name<input name="agent_name" maxlength="30" value="${esc(me.profile.agentName)}"></label>
      <label class="field">Tagline<input name="tagline" maxlength="60" placeholder="Always one step ahead" value="${esc(me.profile.tagline || '')}"></label>
      <div class="field">Personality<div class="chips">${['warm', 'casual', 'concise', 'funny']
        .map((tone) => `<button type="button" data-value="${tone}" class="${tone === me.profile.tone ? 'on' : ''}">${tone[0].toUpperCase() + tone.slice(1)}</button>`)
        .join('')}</div></div>
      <div class="field">Look<div class="swatches"></div></div>
      <button class="primary" type="button">Save</button>`;
    const swatches = body.querySelector('.swatches');
    for (const color of ['sky', 'peach', 'mint', 'lilac']) {
      const button = h('button', color === me.profile.avatar ? 'on' : '');
      button.type = 'button';
      button.dataset.value = color;
      button.style.setProperty('--mascot', `url(#m-${color})`);
      button.appendChild(mascot(h('span', 'mascot-slot')));
      button.firstChild.style.cssText = 'width:100%;height:100%';
      swatches.appendChild(button);
    }
    for (const group of body.querySelectorAll('.chips, .swatches')) {
      group.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === button));
      });
    }
    body.querySelector('.primary').addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const before = me.main_session_id;
        me = await api.patch('/api/me/profile', {
          agent_name: body.querySelector('[name=agent_name]').value,
          tagline: body.querySelector('[name=tagline]').value,
          tone: body.querySelector('.chips .on')?.dataset.value,
          avatar: body.querySelector('.swatches .on')?.dataset.value,
        });
        applyProfile();
        closeSheet();
        if (me.main_session_id === before) {
          setMood('idle');
          return toast('Saved.');
        }
        // A session keeps the persona it started with, so the server moved the main chat
        // to a fresh one; the earlier conversation is under Chats.
        showTab('chat');
        await openThread(me.main_session_id);
        toast(`Saved. ${me.profile.agentName} starts a fresh chat; the earlier one is in Chats.`);
      } catch (err) {
        toast(err.message);
        event.target.disabled = false;
      }
    });
  });
}

// ---- Memory: entries of USER.md and MEMORY.md, each change a read-merge-write ----

function memorySheet() {
  openSheet('Memory', async (body) => {
    body.innerHTML = '<div class="skeleton"></div>';
    let data;
    try {
      data = await api.get('/api/me/memory');
    } catch (err) {
      body.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
      return;
    }
    body.replaceChildren();
    for (const [key, label, blurb] of [
      ['user', 'About you', `What ${me.profile.agentName} knows about you (USER.md).`],
      ['memory', 'Notes', `What ${me.profile.agentName} keeps for itself (MEMORY.md).`],
    ]) {
      const file = data[key];
      const used = file.entries.join('\n§\n').length;
      body.appendChild(h('div', 'group-label', `<span>${label}</span><span>${used} / ${file.limit}</span>`));
      const group = h('div', 'group');
      for (const entry of file.entries) group.appendChild(memoryRow(key, entry, body));
      const add = h('form', 'add-row', `<input placeholder="Add something to remember" maxlength="500"><button class="link" type="submit">Add</button>`);
      add.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = add.querySelector('input').value.trim();
        if (value) await saveMemory({ file: key, add: value });
      });
      group.appendChild(add);
      body.appendChild(group);
      body.appendChild(h('p', 'muted', esc(blurb))).style.cssText = 'font-size:13px;margin:-8px 4px 10px';
    }
    const exportLink = h('a', 'pill', 'Download my memories');
    exportLink.href = '/api/me/memory/export';
    exportLink.style.cssText = 'text-decoration:none;color:inherit;background:#fff';
    body.appendChild(exportLink);
  });
}

function memoryRow(key, entry) {
  const row = h('div', 'item');
  const show = () => {
    row.innerHTML = `<div class="grow entry">${esc(entry)}</div>`;
    const edit = h('button', 'link', 'Edit');
    edit.addEventListener('click', editMode);
    row.appendChild(edit);
  };
  const editMode = () => {
    row.innerHTML = `<div class="grow"><textarea class="entry-edit">${esc(entry)}</textarea><div class="entry-actions"><button class="link danger" data-act="forget">Forget</button><button class="link" data-act="cancel">Cancel</button><button class="link" data-act="save">Save</button></div></div>`;
    row.querySelector('[data-act=cancel]').addEventListener('click', show);
    row.querySelector('[data-act=forget]').addEventListener('click', () => saveMemory({ file: key, edit: { from: entry, to: '' } }));
    row.querySelector('[data-act=save]').addEventListener('click', () =>
      saveMemory({ file: key, edit: { from: entry, to: row.querySelector('textarea').value } })
    );
  };
  show();
  return row;
}

async function saveMemory(change) {
  try {
    await api.post('/api/me/memory', change);
  } catch (err) {
    return toast(err.message);
  }
  sheetStack.pop();
  memorySheet();
}

// ---- Upcoming: platform crons, whether the app or the agent created them ----

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeSchedule(expr) {
  const [minute, hour, dom, month, dow] = expr.split(/\s+/);
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') return expr;
  const time = new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dom === '*' && dow === '*') return `Every day at ${time}`;
  if (dom === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (dom === '*' && /^[0-6]$/.test(dow)) return `${DAYS[dow]}s at ${time}`;
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return expr;
}

function upcomingSheet() {
  openSheet('Upcoming', async (body) => {
    body.innerHTML = '<div class="skeleton"></div>';
    let data;
    try {
      ({ data } = await api.get('/api/me/crons'));
    } catch (err) {
      body.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
      return;
    }
    body.replaceChildren();
    const today = new Date().getDay();
    const form = h(
      'form',
      'group',
      `<div class="form-row"><input type="text" name="text" placeholder="Remind me to..." maxlength="300" required></div>
       <div class="form-row"><input type="time" name="time" value="09:00" required>
         <select name="repeat"><option value="*">Every day</option><option value="1-5">Weekdays</option><option value="${today}">Every ${DAYS[today]}</option></select>
         <span style="flex:1"></span><button class="link" type="submit">Add</button></div>`
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const { text, time, repeat } = form.elements;
      const [hourText, minuteText] = time.value.split(':');
      try {
        await api.post('/api/me/crons', { text: text.value, schedule: `${Number(minuteText)} ${Number(hourText)} * * ${repeat.value}` });
      } catch (err) {
        return toast(err.message);
      }
      sheetStack.pop();
      upcomingSheet();
    });
    body.append(h('div', 'group-label', '<span>New reminder</span>'), form);
    body.appendChild(h('div', 'group-label', `<span>Scheduled</span><span>${data.length}</span>`));
    const group = h('div', 'group');
    if (!data.length) group.appendChild(h('p', 'empty-state', `Nothing scheduled. Ask ${esc(me.profile.agentName)} to remind you of something.`));
    for (const cron of data) {
      const row = h(
        'div',
        'item',
        `<div class="grow"><strong>${esc(cron.name || cron.prompt.slice(0, 60))}</strong><small>${esc(describeSchedule(cron.schedule))}${cron.next_run ? ` · next ${esc(when(cron.next_run * 1000))}` : ' · paused'}</small>
         <small><button class="link" data-act="run">Run now</button> &nbsp; <button class="link danger" data-act="delete">Delete</button></small></div><button class="switch ${cron.enabled ? 'on' : ''}" aria-label="Enabled"></button>`
      );
      row.querySelector('.switch').addEventListener('click', async (event) => {
        const on = !event.currentTarget.classList.contains('on');
        await api.patch(`/api/me/crons/${cron.id}`, { enabled: on }).catch((err) => toast(err.message));
        sheetStack.pop();
        upcomingSheet();
      });
      row.querySelector('[data-act=run]').addEventListener('click', async () => {
        try {
          await api.post(`/api/me/crons/${cron.id}/run`);
          toast('Running now. It will message you if there is news.');
        } catch (err) {
          toast(err.message);
        }
      });
      row.querySelector('[data-act=delete]').addEventListener('click', async () => {
        await api.del(`/api/me/crons/${cron.id}`).catch((err) => toast(err.message));
        sheetStack.pop();
        upcomingSheet();
      });
      group.appendChild(row);
    }
    body.appendChild(group);
  });
}

// ---- Connectors: managed Composio on the visitor's instance ----

function connectorsSheet() {
  openSheet('Connectors', async (body) => {
    body.innerHTML = `<div class="search">${ICONS.search}<input placeholder="Search connectors" autocomplete="off"></div><div class="results"></div>`;
    const results = body.querySelector('.results');
    const input = body.querySelector('input');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderConnectors(results, input.value.trim()), 300);
    });
    renderConnectors(results, '');
  });
}

async function renderConnectors(results, search) {
  results.innerHTML = '<div class="skeleton"></div>';
  let connections;
  let toolkits;
  try {
    [{ connections }, toolkits] = await Promise.all([
      api.get('/api/me/integrations/connections'),
      api.get(`/api/me/integrations/toolkits?search=${encodeURIComponent(search.length >= 3 ? search : '')}`),
    ]);
  } catch (err) {
    results.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
    return;
  }
  results.replaceChildren();
  const active = connections.filter((c) => c.status === 'ACTIVE');
  if (active.length) {
    results.appendChild(h('div', 'group-label', '<span>Connected</span>'));
    const group = h('div', 'group');
    for (const connection of active) {
      const row = h('div', 'item', `<div class="grow"><strong>${esc(connection.toolkitName || connection.toolkitSlug)}</strong></div>`);
      const remove = h('button', 'link danger', 'Disconnect');
      remove.addEventListener('click', async () => {
        await api.del(`/api/me/integrations/connections/${connection.id}`).catch((err) => toast(err.message));
        renderConnectors(results, search);
      });
      row.appendChild(remove);
      group.appendChild(row);
    }
    results.appendChild(group);
  }
  results.appendChild(h('div', 'group-label', '<span>Available</span>'));
  const group = h('div', 'group');
  for (const toolkit of toolkits.items) {
    const row = h('div', 'item', `<img src="${esc(toolkit.logo)}" alt=""><div class="grow"><strong>${esc(toolkit.name)}</strong></div>`);
    const connect = h('button', 'link', 'Connect');
    connect.addEventListener('click', () => connectToolkit(toolkit, results, search));
    row.appendChild(connect);
    group.appendChild(row);
  }
  results.appendChild(group);
}

async function connectToolkit(toolkit, results, search) {
  // Open the tab inside the click so popup blockers allow it, then point it at the link.
  const popup = window.open('', '_blank');
  let started;
  try {
    started = await api.post('/api/me/integrations/connect', { toolkit: toolkit.slug });
  } catch (err) {
    popup?.close();
    return toast(err.message);
  }
  if (popup) popup.location = started.redirectUrl;
  else location.href = started.redirectUrl;
  toast(`Finish connecting ${toolkit.name} in the new tab.`);
  // Landing back on the callback page only means the user finished the OAuth screens;
  // the connection is live once it reads ACTIVE.
  for (let i = 0; i < 60; i += 1) {
    await delay(3000);
    const { connections } = await api.get('/api/me/integrations/connections').catch(() => ({ connections: [] }));
    if (connections.some((c) => c.id === started.connectedAccountId && c.status === 'ACTIVE')) {
      toast(`${toolkit.name} connected`);
      if (results.isConnected) renderConnectors(results, search);
      return;
    }
  }
}

// ---- sheets ----

const sheetStack = [];

function openSheet(title, render, options = {}) {
  sheetStack.push({ title, render, options });
  showSheet();
}

function showSheet() {
  const top = sheetStack[sheetStack.length - 1];
  if (!top) return closeSheet();
  $('#backdrop').hidden = false;
  $('#sheet').hidden = false;
  $('#sheet-title').textContent = top.title;
  $('#sheet-action').replaceChildren(...(top.options.action ? [top.options.action] : []));
  const body = $('#sheet-body');
  body.replaceChildren();
  body.scrollTop = 0;
  top.render(body);
}

function closeSheet() {
  sheetStack.length = 0;
  $('#backdrop').hidden = true;
  $('#sheet').hidden = true;
}

$('#sheet-back').addEventListener('click', () => {
  sheetStack.pop();
  showSheet();
});
$('#backdrop').addEventListener('click', closeSheet);

boot();
