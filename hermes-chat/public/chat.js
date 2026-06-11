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
  // SSE endpoints need the raw Response; request() would consume the body as JSON.
  stream: (path, init) => fetch(`/api/i/${instanceId}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init }),
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
  let pendingEl = null;
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
      this.clearPending();
      ensureText().textContent = text;
      scrollToBottom();
    },
    appendText(text) {
      this.clearPending();
      ensureText().textContent += text;
      scrollToBottom();
    },
    getText: () => textEl?.textContent ?? '',
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
      scrollToBottom();
    },
    thinking(text, open = true) {
      this.clearPending();
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
      this.clearPending();
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to keep recovering a dropped stream before giving up.
const MAX_RECOVERY_ATTEMPTS = 8;
const RECOVERY_DELAY_MS = 1500;

// Terminal states render the same whether they arrive as a stream event or from
// polling GET /responses/{id} after a drop.
function renderCompleted(bubble, outputText, sawToolCalls) {
  bubble.closeThinking();
  // The terminal payload carries the authoritative full text: replace, never append.
  // A replayed stream re-sends every delta, so appending would duplicate.
  const text = (outputText ?? '').replace(/^\n+/, '');
  bubble.setText(text);
  if (!text && !sawToolCalls) {
    addError(
      'The agent returned an empty reply.',
      'This usually means the instance managed budget or the workspace balance is exhausted. Raise it, then try again.'
    );
  }
}

function renderFailed(bubble, error) {
  bubble.remove();
  addError(error?.message || 'The turn failed.', error?.hint);
}

// Consume one SSE response stream, rendering into `bubble`. Returns what the
// stream proved: whether a terminal event arrived, and whether tools ran.
async function consumeStream(response, bubble) {
  let sawTerminal = false;
  let sawToolCalls = false;
  for await (const { event, data } of sseFrames(response)) {
    switch (event) {
      case 'response.created':
        sessionId = data.session_id;
        inFlight = { responseId: data.id };
        bubble.pending('Agent is working...');
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
      case 'response.completed':
        sawTerminal = true;
        renderCompleted(bubble, data.output_text, sawToolCalls);
        break;
      case 'response.failed':
        sawTerminal = true;
        renderFailed(bubble, data.error);
        break;
    }
  }
  return { sawTerminal, sawToolCalls };
}

async function sendTurn(text) {
  const wasNewSession = !sessionId;
  addMessage('user').setText(text);
  let bubble = addMessage('assistant');
  bubble.pending('Waiting for the agent...');
  setBusy(true);

  let response;
  try {
    response = await api.stream('/responses', {
      method: 'POST',
      body: JSON.stringify({ input: text, stream: true, ...(sessionId ? { session_id: sessionId } : {}), ...selectedModel() }),
    });
  } catch (err) {
    setBusy(false);
    bubble.remove();
    return addError(`Could not reach the server: ${err.message}`);
  }

  // Failures before the stream starts (busy session, bad request, instance asleep) come
  // back as plain JSON, not SSE.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json().catch(() => null);
    setBusy(false);
    bubble.remove();
    if (body?.error?.code === 'session_busy') {
      return addError('A response is already running on this session.', 'Wait for it to finish, or start a new chat.');
    }
    return addError(body?.error?.message || `Request failed (HTTP ${response.status}).`, body?.error?.hint);
  }

  let outcome = { sawTerminal: false, sawToolCalls: false };
  try {
    outcome = await consumeStream(response, bubble);
  } catch {
    // Network drop mid-stream; the reattach loop below recovers.
  }

  // A stream that closes without a terminal event proves nothing about the turn: it
  // is usually still running server-side. Reattach to the response stream — it
  // replays every event so far, then resumes live — until a terminal event arrives.
  let attempts = 0;
  while (!outcome.sawTerminal && inFlight && attempts < MAX_RECOVERY_ATTEMPTS) {
    attempts += 1;
    if (attempts > 1) await delay(RECOVERY_DELAY_MS); // the only sleep: every retry path funnels back here
    let final;
    try {
      bubble.pending('Checking the final reply...');
      final = await api.get(`/responses/${inFlight.responseId}`);
    } catch {
      continue;
    }
    if (final.status === 'completed') {
      outcome.sawTerminal = true;
      renderCompleted(bubble, final.output_text, outcome.sawToolCalls);
    } else if (final.status === 'cancelled') {
      outcome.sawTerminal = true;
      bubble.remove();
      addSystemNote('Stopped.');
    } else if (final.status === 'failed') {
      outcome.sawTerminal = true;
      renderFailed(bubble, final.error);
    } else {
      // Still in_progress: reattach. Replace the bubble, because the replayed
      // stream re-sends everything rendered so far.
      bubble.pending('Connection dropped — reattaching...');
      try {
        const replay = await api.stream(`/responses/${inFlight.responseId}/stream`);
        if (!replay.headers.get('content-type')?.includes('text/event-stream')) throw new Error('not a stream');
        bubble.remove();
        bubble = addMessage('assistant');
        bubble.pending('Reattached — catching up...');
        outcome = await consumeStream(replay, bubble);
      } catch {}
    }
  }
  if (!outcome.sawTerminal) {
    bubble.remove();
    addSystemNote('Lost the connection and could not reattach. Reload to see the reply.');
  }

  bubble.clearPending();
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
