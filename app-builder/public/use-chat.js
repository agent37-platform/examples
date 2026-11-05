// useChat: one conversation with an agent instance, through this app's /api/i/:id proxy.
//
// It owns the part of a chat UI that is easy to get wrong: streaming a turn, recovering
// when the stream drops, and cancelling. Components only render `messages`.
//
// A message is { id, role: 'user' | 'assistant' | 'error' | 'system', text, thinking,
// tools: [{ name, state }], pending }.
import { useRef, useState } from 'react';
import { delay } from './lib.js';

// How long to keep recovering a dropped stream before giving up.
const MAX_RECOVERY_ATTEMPTS = 8;
const RECOVERY_DELAY_MS = 1500;

const isEventStream = (res) => res.headers.get('content-type')?.includes('text/event-stream');

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

// `stripBrief` hides the app context the server prepends to a session's first turn.
export function useChat(instanceId, { stripBrief = (text) => text, onTurnEnd } = {}) {
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [busy, setBusy] = useState(false);
  const session = useRef(null); // the current session id, readable mid-turn
  const running = useRef(null); // the running response id, while a turn streams
  const base = `/api/i/${instanceId}`;

  const push = (message) => {
    const id = crypto.randomUUID();
    setMessages((list) => [...list, { id, text: '', thinking: '', tools: [], ...message }]);
    return id;
  };
  const update = (id, change) =>
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...(typeof change === 'function' ? change(m) : change) } : m)));
  const remove = (id) => setMessages((list) => list.filter((m) => m.id !== id));
  const setSession = (id) => {
    session.current = id;
    setSessionId(id);
  };

  async function openSession(id) {
    setSession(id);
    setMessages([]);
    const res = await fetch(`${base}/sessions/${id}`);
    const { history = [] } = await res.json();
    setMessages(
      history
        .filter((m) => m.role !== 'system') // compaction markers, not conversation
        .map((m) => ({
          id: crypto.randomUUID(),
          role: m.role,
          text: m.role === 'user' ? stripBrief(m.content) : m.content,
          thinking: m.thinking || '',
          tools: [],
        }))
    );
  }

  function newChat() {
    setSession(null);
    setMessages([]);
  }

  // Render one SSE response stream into the reply bubble. Returns what the stream
  // proved: whether a terminal event arrived.
  async function consume(response, replyId) {
    let sawTerminal = false;
    let sawTools = false;
    for await (const { event, data } of sseFrames(response)) {
      switch (event) {
        case 'response.created':
          setSession(data.session_id);
          running.current = data.id;
          update(replyId, { pending: 'Agent is working...' });
          break;
        case 'response.reasoning.delta':
          update(replyId, (m) => ({ thinking: m.thinking + data.text, pending: null }));
          break;
        case 'response.output_text.delta':
          update(replyId, (m) => ({ text: m.text + data.text, pending: null }));
          break;
        case 'response.tool_call.started':
          sawTools = true;
          update(replyId, (m) => ({ tools: [...m.tools, { name: data.label || data.tool, state: 'running' }], pending: null }));
          break;
        case 'response.tool_call.completed':
        case 'response.tool_call.failed': {
          const state = event.endsWith('completed') ? 'done' : 'failed';
          const name = data.label || data.tool;
          update(replyId, (m) => {
            const tools = [...m.tools];
            const index = tools.findLastIndex((t) => t.name === name && t.state === 'running');
            if (index !== -1) tools[index] = { name, state };
            return { tools };
          });
          break;
        }
        case 'response.completed': {
          sawTerminal = true;
          // The terminal payload carries the full text: replace, never append. A replayed
          // stream re-sends every delta, so appending would duplicate.
          const text = (data.output_text ?? '').replace(/^\n+/, '');
          update(replyId, { text, pending: null });
          if (!text && !sawTools) {
            push({
              role: 'error',
              text: 'The agent returned an empty reply. This usually means the instance managed budget or the workspace balance is exhausted. Raise it, then try again.',
            });
          }
          break;
        }
        case 'response.failed':
          sawTerminal = true;
          remove(replyId);
          push({ role: 'error', text: [data.error?.message || 'The turn failed.', data.error?.hint].filter(Boolean).join(' ') });
          break;
      }
    }
    return sawTerminal;
  }

  async function send(input) {
    const startedNewSession = !session.current;
    push({ role: 'user', text: input });
    const replyId = push({ role: 'assistant', pending: 'Waiting for the agent...' });
    setBusy(true);
    try {
      const response = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, stream: true, ...(session.current ? { session_id: session.current } : {}) }),
      });

      // Failures before the stream starts (busy session, bad request, instance asleep)
      // come back as plain JSON, not SSE.
      if (!isEventStream(response)) {
        const body = await response.json().catch(() => null);
        remove(replyId);
        push({
          role: 'error',
          text:
            body?.error?.code === 'session_busy'
              ? 'A response is already running on this session. Wait for it to finish, or start a new chat.'
              : body?.error?.message || `Request failed (HTTP ${response.status}).`,
        });
        return;
      }

      let finished = await consume(response, replyId).catch(() => false);

      // A stream that closes without a terminal event proves nothing about the turn: it is
      // usually still running on the instance. Reattach to the response stream, which
      // replays every event so far and then stays live, until a terminal event arrives.
      for (let attempt = 1; !finished && running.current && attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        if (attempt > 1) await delay(RECOVERY_DELAY_MS);
        update(replyId, { pending: 'Connection dropped, reattaching...' });
        try {
          const replay = await fetch(`${base}/responses/${running.current}/stream`);
          if (!isEventStream(replay)) throw new Error('not a stream');
          // The replay re-sends everything from the start: reset the bubble first.
          update(replyId, { text: '', thinking: '', tools: [], pending: 'Reattached, catching up...' });
          finished = await consume(replay, replyId);
        } catch {
          // Still unreachable, or no longer retained; back off and retry.
        }
      }
      if (!finished) {
        remove(replyId);
        push({ role: 'system', text: 'Lost the connection and could not reattach. Reload to see the reply.' });
      }
    } catch (err) {
      remove(replyId);
      push({ role: 'error', text: `Could not reach the server: ${err.message}` });
    } finally {
      update(replyId, { pending: null });
      running.current = null;
      setBusy(false);
      onTurnEnd?.({ startedNewSession });
    }
  }

  // Cancel is asynchronous: the call returns at once, the stream then ends with
  // response.completed carrying the partial text.
  async function stop() {
    if (!running.current) return;
    try {
      await fetch(`${base}/responses/${running.current}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      push({ role: 'system', text: 'Stopping...' });
    } catch (err) {
      push({ role: 'error', text: `Cancel failed: ${err.message}` });
    }
  }

  return { messages, sessionId, busy, send, stop, openSession, newChat };
}
