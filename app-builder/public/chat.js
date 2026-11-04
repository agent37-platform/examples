// The chat page: sessions on the left, the conversation in the middle, the agent's apps
// on the right. /chat.html?instance=<id>
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';
import { useChat } from './use-chat.js';
import { SessionsSidebar, MessageList, Starters, Composer } from './chat-ui.js';
import { AppsPanel } from './apps-panel.js';

const STARTERS = [
  'Build me a guestbook where visitors leave a name and a message, and give me the link.',
  'Make a todo list app that saves my todos, with a done checkbox and a delete button.',
  'Build a habit tracker: I add habits, tick them off each day, and see my streaks.',
];

// The server prepends an app-building brief to the first turn of each session. It is app
// plumbing, not conversation: hide it when rendering stored history.
const BRIEF_START = 'App context (from the app-builder app';
const BRIEF_END = 'End of app context. The user message follows.';
function stripBrief(text) {
  if (!text?.startsWith(BRIEF_START)) return text;
  const cut = text.indexOf(BRIEF_END);
  return cut === -1 ? text : text.slice(cut + BRIEF_END.length).replace(/^\n+/, '');
}

function ChatPage({ instanceId }) {
  // Bumped after every turn: the sidebar picks up a new session's title, and the Apps
  // panel picks up anything the turn just built or published.
  const [turns, setTurns] = useState(0);
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
        <${Composer} busy=${chat.busy} placeholder="Describe the app you want..." onSend=${chat.send} onStop=${chat.stop} />
      </main>
      <${AppsPanel} instanceId=${instanceId} reloadKey=${turns} />
    </div>
  `;
}

const instanceId = new URLSearchParams(location.search).get('instance');
if (!instanceId) location.href = '/';
else createRoot(document.getElementById('root')).render(html`<${ChatPage} instanceId=${instanceId} />`);
