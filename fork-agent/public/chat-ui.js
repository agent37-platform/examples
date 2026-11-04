// The chat view's building blocks: the sessions sidebar, the message list, and the
// composer. They render what useChat holds and call back into it.
import { useEffect, useRef, useState } from 'react';
import { html } from 'htm/react';
import { ui } from './lib.js';

const BUBBLE = {
  user: 'max-w-3xl self-end whitespace-pre-wrap rounded-2xl rounded-br-sm bg-stone-900 px-3.5 py-2.5 text-white',
  assistant: 'max-w-3xl self-start whitespace-pre-wrap',
  error: 'max-w-3xl self-start rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-red-700',
  system: 'self-center text-[13px] text-stone-500',
};
const TOOL_TONE = { running: 'starting', done: 'ready', failed: 'failed' };

// The sidebar lists the instance's sessions, newest first. Hermes titles sessions on its
// own; untitled ones fall back to the first thing the user said. A title that is just the
// start of the app's brief counts as untitled too.
export function SessionsSidebar({ instanceId, activeId, reloadKey, stripBrief, onOpen, onNew }) {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data = [] } = await (await fetch(`/api/i/${instanceId}/sessions`)).json();
      const titled = await Promise.all(
        data.slice(0, 30).map(async (session) => {
          if (session.title && !session.title.startsWith('App context (')) return session;
          try {
            const { history = [] } = await (await fetch(`/api/i/${instanceId}/sessions/${session.id}`)).json();
            const first = history.find((m) => m.role === 'user');
            return { ...session, title: first ? stripBrief(first.content).slice(0, 60) : 'New session' };
          } catch {
            return { ...session, title: 'Session' };
          }
        })
      );
      if (!cancelled) setSessions(titled);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [instanceId, reloadKey]);

  return html`
    <aside className="flex w-64 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-stone-200 bg-white p-3.5">
      <a className="text-sm text-stone-500 hover:text-stone-900" href="/">← Agents</a>
      <button className=${ui.primary} onClick=${onNew}>New chat</button>
      <nav className="flex flex-col gap-0.5">
        ${sessions.map(
          (s) => html`
            <button
              key=${s.id}
              title=${s.title}
              onClick=${() => onOpen(s.id)}
              className=${`truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-stone-100 ${s.id === activeId ? 'bg-stone-200/70 font-medium' : ''}`}
            >
              ${s.title}
            </button>
          `
        )}
      </nav>
    </aside>
  `;
}

function Message({ message }) {
  const { role, text, thinking, tools, pending } = message;
  return html`
    <div className=${BUBBLE[role] || BUBBLE.assistant}>
      ${thinking &&
      html`
        <details className="mb-1.5 text-[13.5px] text-stone-500" open=${!text}>
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-stone-200 pl-3.5">${thinking}</div>
        </details>
      `}
      ${tools.length > 0 &&
      html`
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          ${tools.map(
            (tool, index) => html`
              <span key=${index} className=${ui.chip(TOOL_TONE[tool.state])}>${tool.state === 'running' ? `${tool.name}...` : tool.name}</span>
            `
          )}
        </div>
      `}
      ${text}
      ${pending && html`<span className="animate-pulse text-sm text-stone-500">${pending}</span>`}
    </div>
  `;
}

export function MessageList({ messages }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);
  return html`
    <div ref=${ref} className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-6">
      ${messages.map((message) => html`<${Message} key=${message.id} message=${message} />`)}
    </div>
  `;
}

export function Starters({ prompts, onPick }) {
  return html`
    <div className="flex flex-wrap gap-2 px-6 pb-3.5">
      ${prompts.map(
        (prompt) => html`
          <button
            key=${prompt}
            onClick=${() => onPick(prompt)}
            className="max-w-full rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-left text-[13.5px] text-stone-500 hover:text-stone-900"
          >
            ${prompt}
          </button>
        `
      )}
    </div>
  `;
}

// One turn at a time per session: the composer locks while a turn runs (the API answers
// 409 to overlap anyway), and Stop cancels the running turn.
export function Composer({ busy, placeholder, onSend, onStop }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const submit = (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    onSend(value);
  };

  return html`
    <form onSubmit=${submit} className="flex gap-2.5 border-t border-stone-200 bg-white px-6 pt-3.5 pb-5">
      <textarea
        ref=${ref}
        rows="1"
        value=${text}
        disabled=${busy}
        placeholder=${placeholder}
        onChange=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
        }}
        className="max-h-40 flex-1 resize-none rounded-xl border border-stone-200 px-3 py-2.5 outline-none focus:border-stone-400 disabled:bg-stone-50"
      />
      ${busy
        ? html`<button type="button" className=${ui.btn} onClick=${onStop}>Stop</button>`
        : html`<button type="submit" className=${ui.primary}>Send</button>`}
    </form>
  `;
}
