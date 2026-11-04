// The home page: the workspace's agents, each one row, with its published apps.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';
import { api, ui, usePoll } from './lib.js';

function AgentsPage() {
  const [agents, setAgents] = useState(null);
  const [creating, setCreating] = useState(null); // the name being created, while it is
  const [status, setStatus] = useState('');

  async function refresh() {
    try {
      const { data } = await api('/api/instances');
      setAgents(data.filter((instance) => instance.status !== 'deleted'));
    } catch (err) {
      setStatus(
        err.code === 'invalid_api_key'
          ? 'Your API key was rejected. Check AGENT37_API_KEY in .env and restart the server.'
          : `Could not load agents: ${err.message}`
      );
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    const name = prompt('Name for the new agent:', 'My app agent');
    if (name === null) return;
    setCreating(name.trim() || 'app-builder agent');
    setStatus('Creating agent. This usually takes a few seconds, but can take a few minutes on a cold host...');
    try {
      await api('/api/instances', { method: 'POST', body: { name } });
      setStatus('');
    } catch (err) {
      setStatus(
        err.code === 'insufficient_balance'
          ? 'Your wallet balance is too low. Creating the smallest instance requires about $0.16 of balance (one day of compute; nothing is debited). Top up at agent37.com/dashboard/cloud/billing.'
          : `Create failed: ${err.message} (refresh the list, the agent may still appear)`
      );
    }
    setCreating(null);
    refresh();
  }

  async function remove(agent) {
    if (!confirm(`Delete agent ${agent.id}? Its apps go offline and billing ends immediately. Claimed databases stay in your Neon account; unclaimed ones expire on their own.`)) return;
    try {
      await api(`/api/instances/${agent.id}`, { method: 'DELETE' });
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`);
    }
    refresh();
  }

  const hasRows = creating || agents?.length > 0;

  return html`
    <div>
    <header className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-6 py-3.5">
      <div className="font-semibold">App builder <span className="font-normal text-stone-500">· Agent37 + Neon example</span></div>
      <button className=${ui.primary} disabled=${!!creating} onClick=${create}>${creating ? 'Creating...' : 'Create agent'}</button>
    </header>
    <main className="mx-auto max-w-4xl p-6">
      <p className="min-h-6 text-sm text-stone-500">${status}</p>
      ${hasRows &&
      html`
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Apps</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              ${creating && html`<${PendingRow} name=${creating} />`}
              ${agents?.map((agent) => html`<${AgentRow} key=${agent.id} agent=${agent} onDelete=${() => remove(agent)} />`)}
            </tbody>
          </table>
        </div>
      `}
      ${agents && !hasRows &&
      html`
        <div className="px-6 py-16 text-center text-stone-500">
          <h2 className="mb-2 text-xl font-semibold text-stone-900">No agents yet</h2>
          <p className="mx-auto max-w-xl">
            Create one, then ask it for an app that keeps data. Every app gets its own Postgres database on Neon, free for 72 hours, and you claim the ones
            you want to keep. The smallest instance costs $4.76 per month from your wallet, metered per minute while you hold it.
          </p>
        </div>
      `}
    </main>
    </div>
  `;
}

function PendingRow({ name }) {
  return html`
    <tr className="border-b border-stone-200 bg-amber-50/50 last:border-0">
      <td className="px-4 py-2.5">${name}</td>
      <td className="px-4 py-2.5 text-sm text-stone-500">creating...</td>
      <td className="px-4 py-2.5"><span className=${ui.chip('starting')}>Creating</span></td>
      <td></td>
      <td className="px-4 py-2.5 text-right text-sm text-stone-500">Please wait...</td>
    </tr>
  `;
}

function AgentRow({ agent, onDelete }) {
  // Public ports ride on every instance read. The publish route labels each app's port
  // "app:<slug>"; agent instances also carry a platform-minted Telegram webhook port.
  const apps = (agent.public_ports || []).filter((port) => port.label?.startsWith('app:'));
  const open = () => {
    if (agent.status === 'running') location.href = `/chat.html?instance=${agent.id}`;
  };
  const stop = (event) => event.stopPropagation();

  return html`
    <tr className="cursor-pointer border-b border-stone-200 last:border-0 hover:bg-stone-50" onClick=${open}>
      <td className="px-4 py-2.5">${agent.name || 'Untitled'}</td>
      <td className="px-4 py-2.5"><code className="text-[13px]">${agent.id}</code></td>
      <td className="px-4 py-2.5"><${StatusChip} agent=${agent} /></td>
      <td className="px-4 py-2.5 text-sm">
        ${apps.length === 0 && html`<span className="text-stone-400">None yet</span>`}
        ${apps.map(
          (port, index) => html`
            <span key=${port.port}>
              ${index > 0 && ', '}
              <a className="font-medium text-green-700 hover:underline" href=${port.url} target="_blank" rel="noopener" onClick=${stop}>${port.label.slice(4)}</a>
            </span>
          `
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <button className=${ui.danger} onClick=${(event) => (stop(event), onDelete())}>Delete</button>
      </td>
    </tr>
  `;
}

// "running" means the container is up, not that the agent inside has finished booting
// (minutes, on a cold host). Poll health until the chat surface actually answers.
function StatusChip({ agent }) {
  const [ready, setReady] = useState(false);
  usePoll(
    async () => {
      if (agent.status !== 'running') return false;
      const { ready } = await api(`/api/instances/${agent.id}/ready`);
      setReady(ready);
      return !ready;
    },
    5000,
    [agent.id, agent.status]
  );

  if (agent.status === 'running') return html`<span className=${ui.chip(ready ? 'ready' : 'starting')}>${ready ? 'Ready' : 'Starting'}</span>`;
  if (agent.status === 'failed') return html`<span className=${ui.chip('failed')}>Failed</span>`;
  return html`<span className=${ui.chip()}>${agent.status}</span>`;
}

createRoot(document.getElementById('root')).render(html`<${AgentsPage} />`);
