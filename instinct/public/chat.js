// Web chat with the same agent the user texts. Streaming, reattach, and cancel follow the
// hermes-chat example; the server scopes every call to the signed-in user's own instance.

const messagesEl = document.getElementById('messages');
const threadsEl = document.getElementById('threads');
const composer = document.getElementById('composer');
const readOnlyEl = document.getElementById('read-only');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');

let sessionId = null;
let inFlight = null; // { responseId } while a turn is streaming

async function request(path, init) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code, hint: body?.error?.hint });
  return body;
}
const stream = (path, init) => fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });

// Sessions the Inkbox plugin opens (texts, emails, calls) start with a skill preamble, then a
// routing marker such as "[inkbox:email from=...]", then what the person wrote. The list's
// preview is too short to reach the marker, so each of those is read once and cached (its
// first message never changes). Reminders the app set start with a fixed phrase instead.
const CHANNELS = { imessage: 'iMessage', group_imessage: 'iMessage', email: 'Email', sms: 'SMS', call: 'Call' };
const NOUNS = { iMessage: 'an iMessage thread', SMS: 'a text thread', Email: 'an email thread', Call: 'a call transcript', Inkbox: 'an Inkbox thread' };
const MARKER = /\[inkbox:(?!contact_memories)([a-z_]+)[^\]]*\]\s*/;
const REMINDER = 'Scheduled task from the app:';
const channelThreads = new Map();

function visibleText(content) {
  const marker = MARKER.exec(content || '');
  return marker ? content.slice(marker.index + marker[0].length) : content || '';
}

async function describe(session) {
  const preview = (session.preview || '').trim();
  if (preview.startsWith(REMINDER)) return { channel: 'Reminder', title: session.title || preview.slice(REMINDER.length).trim() };
  if (!preview.startsWith('[')) return { channel: null, title: session.title || preview || 'New thread' };
  if (!channelThreads.has(session.id)) {
    try {
      const { history } = await request(`/sessions/${session.id}`);
      const first = history.find((message) => message.role === 'user')?.content || '';
      const marker = MARKER.exec(first);
      // Hermes titles channel sessions after the skill it loaded, so show what the person wrote.
      const body = visibleText(first).replace(/\s+/g, ' ').trim();
      channelThreads.set(session.id, marker ? { channel: CHANNELS[marker[1].replace(/_burst$/, '')] || 'Inkbox', title: body.slice(0, 60) } : { channel: null });
    } catch {
      return { channel: null, title: session.title || 'Thread' };
    }
  }
  const known = channelThreads.get(session.id);
  return { channel: known.channel, title: known.title || session.title || 'Thread' };
}

// A reply typed into a text or email thread would stay in its session and never reach the
// phone or the inbox, so those threads are read-only here.
function setReadOnly(channel) {
  const locked = Boolean(NOUNS[channel]);
  composer.hidden = locked;
  readOnlyEl.hidden = !locked;
  if (locked) readOnlyEl.textContent = `This is ${NOUNS[channel]}. A reply typed here would stay in the app, so answer from your phone or your mail app, or start a new thread.`;
}

export async function loadThreads() {
  let data = [];
  try {
    ({ data } = await request('/sessions'));
  } catch {
    threadsEl.innerHTML = '<p class="faint">Waking your assistant...</p>';
    return;
  }
  const detailed = await Promise.all(data.slice(0, 30).map(async (session) => ({ ...session, ...(await describe(session)) })));
  threadsEl.innerHTML = '';
  const fresh = document.createElement('a');
  fresh.href = '#chat';
  fresh.textContent = '+ New thread';
  fresh.addEventListener('click', (event) => {
    event.preventDefault();
    newThread();
  });
  threadsEl.appendChild(fresh);
  for (const session of detailed) {
    const link = document.createElement('a');
    link.href = '#chat';
    link.title = session.title;
    link.dataset.id = session.id;
    link.dataset.channel = session.channel || '';
    link.innerHTML = session.channel ? `<span class="tag accent">${session.channel}</span>` : '';
    link.append(session.title);
    if (session.id === sessionId) link.className = 'on';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openSession(session.id);
    });
    threadsEl.appendChild(link);
  }
}

async function openSession(id) {
  sessionId = id;
  messagesEl.innerHTML = '';
  let channel = null;
  for (const link of threadsEl.querySelectorAll('a[data-id]')) {
    link.classList.toggle('on', link.dataset.id === id);
    if (link.dataset.id === id) channel = link.dataset.channel;
  }
  setReadOnly(channel);
  const { history } = await request(`/sessions/${id}`);
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const bubble = addMessage(message.role);
    bubble.setText(message.role === 'user' ? visibleText(message.content) : message.content);
  }
  scrollToBottom();
}

export function newThread() {
  sessionId = null;
  messagesEl.innerHTML = '';
  setReadOnly(null);
  for (const link of threadsEl.querySelectorAll('a.on')) link.className = '';
  inputEl.focus();
}

function addMessage(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  messagesEl.appendChild(el);
  let textEl = null;
  let toolsEl = null;
  let pendingEl = null;
  const ensureText = () => {
    if (!textEl) {
      textEl = document.createElement('span');
      el.appendChild(textEl);
    }
    return textEl;
  };
  return {
    setText(text) {
      this.clearPending();
      ensureText().textContent = text;
      scrollToBottom();
    },
    appendText(text) {
      this.clearPending();
      ensureText().textContent += text;
      scrollToBottom();
    },
    pending(text) {
      if (!pendingEl) {
        pendingEl = document.createElement('span');
        pendingEl.className = 'pending';
        el.appendChild(pendingEl);
      }
      pendingEl.textContent = text;
      scrollToBottom();
    },
    clearPending() {
      pendingEl?.remove();
      pendingEl = null;
    },
    remove() {
      el.remove();
    },
    tool(name, state) {
      this.clearPending();
      if (!toolsEl) {
        toolsEl = document.createElement('div');
        toolsEl.className = 'tools';
        el.insertBefore(toolsEl, textEl);
      }
      let chip = toolsEl.querySelector(`[data-tool="${CSS.escape(name)}"]:not([data-settled])`);
      if (!chip) {
        chip = document.createElement('span');
        chip.dataset.tool = name;
        toolsEl.appendChild(chip);
      }
      chip.className = `chip tool-${state}`;
      chip.textContent = state === 'running' ? `${name}...` : name;
      if (state !== 'running') chip.dataset.settled = '1';
    },
  };
}

function addNote(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// EventSource cannot POST, so the stream is a fetch whose body is parsed as SSE frames:
// blocks separated by a blank line, each with "event:" and "data:" lines.
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

async function consumeStream(response, bubble) {
  let sawTerminal = false;
  let sawToolCalls = false;
  for await (const { event, data } of sseFrames(response)) {
    if (event === 'response.created') {
      sessionId = data.session_id;
      inFlight = { responseId: data.id };
      bubble.pending('Thinking...');
    } else if (event === 'response.output_text.delta') {
      bubble.appendText(data.text);
    } else if (event === 'response.tool_call.started') {
      sawToolCalls = true;
      bubble.tool(data.label || data.tool, 'running');
    } else if (event === 'response.tool_call.completed' || event === 'response.tool_call.failed') {
      bubble.tool(data.label || data.tool, event.endsWith('failed') ? 'failed' : 'done');
    } else if (event === 'response.completed') {
      sawTerminal = true;
      // The terminal payload carries the full text: replace, never append, so a replayed
      // stream cannot duplicate it.
      const text = (data.output_text ?? '').replace(/^\n+/, '');
      bubble.setText(text);
      if (!text && !sawToolCalls) addNote('error', 'The reply came back empty. The instance budget or the workspace wallet is probably used up.');
    } else if (event === 'response.failed') {
      sawTerminal = true;
      bubble.remove();
      addNote('error', data.error?.message || 'The turn failed.');
    }
  }
  return { sawTerminal };
}

async function sendTurn(text) {
  const wasNew = !sessionId;
  addMessage('user').setText(text);
  let bubble = addMessage('assistant');
  bubble.pending('Waking your assistant...');
  setBusy(true);

  let response;
  try {
    response = await stream('/responses', { method: 'POST', body: JSON.stringify({ input: text, ...(sessionId ? { session_id: sessionId } : {}) }) });
  } catch (err) {
    setBusy(false);
    bubble.remove();
    return addNote('error', `Could not reach the server: ${err.message}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json().catch(() => null);
    setBusy(false);
    bubble.remove();
    return addNote('error', body?.error?.code === 'session_busy' ? 'A reply is still running in this thread.' : body?.error?.message || `Request failed (HTTP ${response.status}).`);
  }

  let outcome = { sawTerminal: false };
  try {
    outcome = await consumeStream(response, bubble);
  } catch {}
  // A stream that closes without a terminal event usually means the turn is still running:
  // reattach, which replays every event so far and then resumes live.
  for (let attempt = 0; !outcome.sawTerminal && inFlight && attempt < 8; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const replay = await stream(`/responses/${inFlight.responseId}/stream`);
      if (!replay.headers.get('content-type')?.includes('text/event-stream')) continue;
      bubble.remove();
      bubble = addMessage('assistant');
      outcome = await consumeStream(replay, bubble);
    } catch {}
  }
  if (!outcome.sawTerminal) {
    bubble.remove();
    addNote('system', 'Lost the connection. Reload to see the reply.');
  }
  bubble.clearPending();
  inFlight = null;
  setBusy(false);
  if (wasNew) loadThreads();
}

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  inputEl.disabled = busy;
  if (!busy) inputEl.focus();
}

stopBtn.addEventListener('click', async () => {
  if (!inFlight) return;
  try {
    await request(`/responses/${inFlight.responseId}/cancel`, { method: 'POST' });
    addNote('system', 'Stopping...');
  } catch (err) {
    addNote('error', `Cancel failed: ${err.message}`);
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || sendBtn.hidden) return;
  inputEl.value = '';
  sendTurn(text);
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
