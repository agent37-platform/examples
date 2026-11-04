// The chat page for an agent or an attempt: sessions on the left, the conversation in
// the middle. /chat.html?instance=<id>
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';
import { useChat } from './use-chat.js';
import { SessionsSidebar, MessageList, Starters, Composer } from './chat-ui.js';

const STARTERS = [
  'Create a products table with 30 realistic products (name, category, price, stock), some with duplicate names and messy categories.',
  'Create a customers table and an orders table with a few weeks of sample orders.',
  'What tables are in your database, and how many rows does each have?',
];

// The server prepends app context to the first turn of each session (and to each
// attempt's task). It is app plumbing, not conversation: hide it in stored history.
const BRIEF_START = 'App context (from the fork-agents app';
const BRIEF_END = /End of app context\. The (user message|task) follows\.\n*/;
function stripBrief(text) {
  if (!text?.startsWith(BRIEF_START)) return text;
  const match = text.match(BRIEF_END);
  return match ? text.slice(match.index + match[0].length) : text;
}

function ChatPage({ instanceId }) {
  const [turns, setTurns] = useState(0); // bumped after every turn, to refresh the sidebar
  const chat = useChat(instanceId, { stripBrief, onTurnEnd: () => setTurns((n) => n + 1) });
  const empty = chat.messages.length === 0 && !chat.sessionId;

  return html`
    <div className="flex h-screen">
      <${SessionsSidebar}
        instanceId=${instanceId}
        activeId=${chat.sessionId}
        reloadKey=${turns}
        stripBrief=${stripBrief}
        onOpen=${chat.openSession}
        onNew=${chat.newChat}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-stone-200 bg-white px-6 py-3.5 font-semibold">
          Agent <code>${instanceId}</code>
        </header>
        <${MessageList} messages=${chat.messages} />
        ${empty && !chat.busy && html`<${Starters} prompts=${STARTERS} onPick=${chat.send} />`}
        <${Composer} busy=${chat.busy} placeholder="Message the agent..." onSend=${chat.send} onStop=${chat.stop} />
      </main>
    </div>
  `;
}

const instanceId = new URLSearchParams(location.search).get('instance');
if (!instanceId) location.href = '/';
else createRoot(document.getElementById('root')).render(html`<${ChatPage} instanceId=${instanceId} />`);
