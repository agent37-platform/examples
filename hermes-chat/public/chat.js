const instanceId = new URLSearchParams(location.search).get('instance');
if (!instanceId) location.href = '/';

const messagesEl = document.getElementById('messages');
const sessionsEl = document.getElementById('sessions');
const composer = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const modelEl = document.getElementById('model');
document.getElementById('instance-label').innerHTML = `Instance <code>${instanceId}</code>`;

let sessionId = null;
let inFlight = null; // { responseId } while a turn is streaming

const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};

async function request(path, init) {
  const res = await fetch(`/api/i/${instanceId}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code, hint: body?.error?.hint });
  return body;
}

// ---- models ----

async function loadModels() {
  try {
    const { data, default_model } = await api.get('/models');
    // A fresh managed instance exposes a single starter model; only show a picker when
    // there is a real choice. Omitting model/provider on a turn uses the instance default.
    if (data.length > 1) {
      modelEl.innerHTML = data
        .map((m) => `<option value="${m.id}::${m.provider ?? ''}" ${m.id === default_model ? 'selected' : ''}>${m.label}</option>`)
        .join('');
      modelEl.hidden = false;
    }
  } catch {} // an empty or failing picker should never block chat
}

function selectedModel() {
  if (modelEl.hidden || !modelEl.value) return {};
  const [model, provider] = modelEl.value.split('::');
  return provider ? { model, provider } : { model };
}

// ---- sessions sidebar ----

async function loadSessions() {
  const { data } = await api.get('/sessions');
  // The session list is metadata only (no titles), so derive one from each session's first
  // user message. Fine at example scale; a real app stores its own titles keyed by session_id.
  const detailed = await Promise.all(
    data.slice(0, 30).map(async (session) => {
      try {
        const { history } = await api.get(`/sessions/${session.id}`);
        const first = history.find((message) => message.role === 'user');
        return { ...session, title: first ? first.content.slice(0, 60) : 'New session' };
      } catch {
        return { ...session, title: 'Session' };
      }
    })
  );
  sessionsEl.innerHTML = '';
  for (const session of detailed) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = session.title;
    link.title = session.title;
    if (session.id === sessionId) link.className = 'active';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openSession(session.id);
    });
    sessionsEl.appendChild(link);
  }
}

async function openSession(id) {
  sessionId = id;
  messagesEl.innerHTML = '';
  for (const link of sessionsEl.children) link.className = '';
  const { history } = await api.get(`/sessions/${id}`);
  for (const message of history) {
    if (message.role === 'system') continue; // compaction markers, not conversation
    const bubble = addMessage(message.role);
    if (message.thinking) bubble.thinking(message.thinking, false);
    bubble.setText(message.content);
  }
  loadSessions();
  scrollToBottom();
}

document.getElementById('new-chat').addEventListener('click', () => {
  sessionId = null;
  messagesEl.innerHTML = '';
  for (const link of sessionsEl.children) link.className = '';
  inputEl.focus();
});

// ---- message rendering ----

function addMessage(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  messagesEl.appendChild(el);
  let thinkingEl = null;
  let toolsEl = null;
  let textEl = null;
  const ensureText = () => {
    if (!textEl) {
      textEl = document.createElement('span');
      el.appendChild(textEl);
    }
    return textEl;
  };
  return {
    el,
    setText(text) {
      ensureText().textContent = text;
      scrollToBottom();
    },
    appendText(text) {
      ensureText().textContent += text;
      scrollToBottom();
    },
    getText: () => textEl?.textContent ?? '',
    thinking(text, open = true) {
      if (!thinkingEl) {
        thinkingEl = document.createElement('details');
        thinkingEl.className = 'thinking';
        thinkingEl.open = open;
        thinkingEl.innerHTML = '<summary>Thinking</summary><div></div>';
        el.prepend(thinkingEl);
      }
      thinkingEl.querySelector('div').textContent += text;
    },
    closeThinking() {
      if (thinkingEl) thinkingEl.open = false;
    },
    tool(name, state) {
      if (!toolsEl) {
        toolsEl = document.createElement('div');
        toolsEl.className = 'tools';
        el.insertBefore(toolsEl, textEl);
      }
      let chip = toolsEl.querySelector(`[data-tool="${name}"]:not([data-settled])`);
      if (!chip) {
        chip = document.createElement('span');
        chip.dataset.tool = name;
        toolsEl.appendChild(chip);
      }
      chip.className = `chip tool-${state}`;
      chip.textContent = state === 'running' ? `${name}...` : name;
      if (state !== 'running') chip.dataset.settled = '1';
      scrollToBottom();
    },
  };
}

function addError(message, hint) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = hint ? `${message} ${hint}` : message;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addSystemNote(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- streaming a turn ----
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

async function sendTurn(text) {
  const wasNewSession = !sessionId;
  addMessage('user').setText(text);
  const bubble = addMessage('assistant');
  setBusy(true);

  let response;
  try {
    response = await fetch(`/api/i/${instanceId}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, stream: true, ...(sessionId ? { session_id: sessionId } : {}), ...selectedModel() }),
    });
  } catch (err) {
    setBusy(false);
    return addError(`Could not reach the server: ${err.message}`);
  }

  // Failures before the stream starts (busy session, bad request, instance asleep) come
  // back as plain JSON, not SSE.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json().catch(() => null);
    setBusy(false);
    if (body?.error?.code === 'session_busy') {
      return addError('A response is already running on this session.', 'Wait for it to finish, or start a new chat.');
    }
    return addError(body?.error?.message || `Request failed (HTTP ${response.status}).`, body?.error?.hint);
  }

  let sawTerminal = false;
  let sawToolCalls = false;
  try {
    for await (const { event, data } of sseFrames(response)) {
      switch (event) {
        case 'response.created':
          sessionId = data.session_id;
          inFlight = { responseId: data.id };
          break;
        case 'response.reasoning.delta':
          bubble.thinking(data.text);
          break;
        case 'response.output_text.delta':
          bubble.closeThinking();
          bubble.appendText(data.text);
          break;
        case 'response.tool_call.started':
          sawToolCalls = true;
          bubble.tool(data.label || data.tool, 'running');
          break;
        case 'response.tool_call.completed':
          bubble.tool(data.label || data.tool, 'done');
          break;
        case 'response.tool_call.failed':
          bubble.tool(data.label || data.tool, 'failed');
          break;
        case 'response.completed': {
          sawTerminal = true;
          bubble.closeThinking();
          // The terminal event carries the authoritative full text: replace, never append.
          // A replayed stream re-sends every delta, so appending would duplicate.
          bubble.setText((data.output_text ?? '').replace(/^\n+/, ''));
          if (!bubble.getText() && !sawToolCalls) {
            addError(
              'The agent returned an empty reply.',
              'This usually means the instance managed budget or the workspace balance is exhausted. Raise it, then try again.'
            );
          }
          break;
        }
        case 'response.failed':
          sawTerminal = true;
          addError(data.error?.message || 'The turn failed.', data.error?.hint);
          break;
      }
    }
  } catch {
    // Network drop mid-stream; fall through to the recovery below.
  }

  // A stream that closes without a terminal event proves nothing about the turn. Ask the
  // instance what really happened.
  if (!sawTerminal && inFlight) {
    try {
      const final = await api.get(`/responses/${inFlight.responseId}`);
      if (final.status === 'completed') bubble.setText(final.output_text.replace(/^\n+/, ''));
      else if (final.status === 'cancelled') addSystemNote('Stopped.');
      else if (final.error) addError(final.error.message, final.error.hint);
      else addSystemNote(`Turn ended with status: ${final.status}`);
    } catch {
      addSystemNote('Connection lost. Reload to see the final reply.');
    }
  }

  inFlight = null;
  setBusy(false);
  if (wasNewSession) loadSessions();
}

stopBtn.addEventListener('click', async () => {
  if (!inFlight) return;
  stopBtn.disabled = true;
  try {
    // Cancel is asynchronous: the call returns immediately while the turn unwinds, the
    // stream then ends with response.completed (partial text), and the stored status
    // becomes "cancelled" shortly after.
    await api.post(`/responses/${inFlight.responseId}/cancel`);
    addSystemNote('Stopping...');
  } catch (err) {
    addError(`Cancel failed: ${err.message}`);
  }
  stopBtn.disabled = false;
});

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  inputEl.disabled = busy; // one turn per session; the API answers 409 to overlap anyway
  if (!busy) inputEl.focus();
}

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

loadModels();
loadSessions();
inputEl.focus();
