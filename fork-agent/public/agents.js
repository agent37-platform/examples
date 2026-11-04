// The home page: each agent with its current round of attempts.
//
// An agent card shows either the "try it" form, or, while a round is out, one card per
// attempt plus a query box that compares the original's data with every attempt's.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { html } from 'htm/react';
import { api, ui, usePoll } from './lib.js';

function AgentsPage() {
  const [agents, setAgents] = useState(null);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      setAgents((await api('/api/agents')).data);
    } catch (err) {
      setStatus(`Could not load agents: ${err.message}`);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    const name = prompt('Name for the new agent:', 'inventory agent');
    if (name === null) return;
    setCreating(true);
    setStatus('Creating a Neon project and an Agent37 instance pointed at it...');
    try {
      await api('/api/agents', { method: 'POST', body: { name } });
      setStatus('');
    } catch (err) {
      setStatus(
        err.code === 'insufficient_balance'
          ? 'Your Agent37 wallet balance is too low. Top up at agent37.com/dashboard/cloud/billing.'
          : `Create failed: ${err.message}`
      );
    }
    setCreating(false);
    refresh();
  }

  return html`
    <div>
      <header className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-6 py-3.5">
        <div className="font-semibold">Fork agents <span className="font-normal text-stone-500">· Agent37 + Neon example</span></div>
        <button className=${ui.primary} disabled=${creating} onClick=${create}>${creating ? 'Creating...' : 'Create agent'}</button>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <p className="min-h-6 text-sm text-stone-500">${status}</p>
        <div className="flex flex-col gap-5">
          ${agents?.map((agent) => html`<${AgentCard} key=${agent.id} agent=${agent} onChange=${refresh} setStatus=${setStatus} />`)}
        </div>
        ${agents?.length === 0 &&
        html`
          <div className="px-6 py-16 text-center text-stone-500">
            <h2 className="mb-2 text-xl font-semibold text-stone-900">No agents yet</h2>
            <p className="mx-auto max-w-2xl">
              Create one: it gets its own computer on Agent37 and its own Postgres database on Neon. Chat with it to put some data in its database, then
              try a task several ways at once. Every attempt runs on a fork of the computer and a branch of the database, and you keep the one you like.
            </p>
          </div>
        `}
      </main>
    </div>
  `;
}

function AgentCard({ agent, onChange, setStatus }) {
  const m = agent.metadata;

  async function remove() {
    if (!confirm(`Delete ${agent.name}? This deletes its attempts, its instance, and its Neon project with all branches.`)) return;
    setStatus('Deleting...');
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      setStatus('');
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`);
    }
    onChange();
  }

  return html`
    <section className="rounded-2xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold">${agent.name} <${ReadyChip} id=${agent.id} /></h2>
        <div className="flex gap-2">
          <a className=${ui.btn} href=${`/chat.html?instance=${agent.id}`}>Chat</a>
          <button className=${ui.danger} onClick=${remove}>Delete</button>
        </div>
      </div>
      <div className="mt-1.5 mb-4 text-[13px] text-stone-500">
        Instance <code>${agent.id}</code> · Neon project <code>${m.neon_project_id}</code> · branch <code>${m.neon_branch_id}</code>
      </div>
      ${agent.attempts.length > 0
        ? html`<${Round} agent=${agent} onChange=${onChange} setStatus=${setStatus} />`
        : html`<${TryForm} agent=${agent} onChange=${onChange} setStatus=${setStatus} />`}
    </section>
  `;
}

// "running" means the container is up; the gateway inside answers a little later.
function ReadyChip({ id }) {
  const [ready, setReady] = useState(false);
  usePoll(
    async () => {
      const { ready } = await api(`/api/agents/${id}/ready`);
      setReady(ready);
      return !ready;
    },
    5000,
    [id]
  );
  return html`<span className=${ui.chip(ready ? 'ready' : 'starting')}>${ready ? 'Ready' : 'Starting'}</span>`;
}

function TryForm({ agent, onChange, setStatus }) {
  const [task, setTask] = useState('');
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(`Forking ${agent.name} ${count} times: a Neon branch and an instance fork per attempt, then the task on each. This takes about half a minute.`);
    try {
      const { data } = await api(`/api/agents/${agent.id}/attempts`, { method: 'POST', body: { task: task.trim(), count } });
      const failed = data.filter((entry) => entry.error);
      setStatus(failed.length ? `Some attempts did not start: ${failed.map((f) => `#${f.attempt}: ${f.error}`).join('; ')}` : '');
    } catch (err) {
      setStatus(`Could not start the attempts: ${err.message}`);
    }
    setBusy(false);
    onChange();
  }

  return html`
    <form onSubmit=${submit} className="flex items-start gap-2.5">
      <textarea
        required
        rows="2"
        value=${task}
        onChange=${(e) => setTask(e.target.value)}
        placeholder='A task to try several ways, e.g. "Clean up the products table: merge duplicates and normalize the categories."'
        className=${`${ui.input} min-h-11 flex-1 resize-y`}
      />
      <select className=${`${ui.input} py-1.5`} value=${count} onChange=${(e) => setCount(Number(e.target.value))} title="How many attempts">
        ${[2, 3, 4].map((n) => html`<option key=${n} value=${n}>${n} ways</option>`)}
      </select>
      <button className=${ui.primary} type="submit" disabled=${busy}>${busy ? 'Forking...' : 'Try it'}</button>
    </form>
  `;
}

function Round({ agent, onChange, setStatus }) {
  async function discard() {
    if (!confirm('Delete every attempt and its branch? The original agent stays as it is.')) return;
    setStatus('Discarding attempts...');
    try {
      await api(`/api/agents/${agent.id}/discard`, { method: 'POST' });
      setStatus('');
    } catch (err) {
      setStatus(`Discard failed: ${err.message}`);
    }
    onChange();
  }

  async function keep(attempt) {
    const message =
      `Keep attempt ${attempt.metadata.attempt}? It becomes the agent.\n\n` +
      'The original instance is deleted for good, with everything on its disk. Its database branch stays in Neon as the starting point of this round. ' +
      'The other attempts are deleted with their branches.';
    if (!confirm(message)) return;
    setStatus('Keeping attempt...');
    try {
      await api(`/api/attempts/${attempt.id}/keep`, { method: 'POST' });
      setStatus(`Attempt ${attempt.metadata.attempt} is now the agent.`);
    } catch (err) {
      setStatus(`Keep failed: ${err.message}`);
    }
    onChange();
  }

  return html`
    <div>
      <div className="mb-2.5 flex items-center justify-between">
        <strong className="text-[15px]">${agent.attempts.length} attempts, each on its own fork and branch</strong>
        <button className=${ui.danger} onClick=${discard}>Discard all</button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        ${agent.attempts.map((attempt) => html`<${AttemptCard} key=${attempt.id} attempt=${attempt} onKeep=${() => keep(attempt)} />`)}
      </div>
      <${CheckPanel} agentId=${agent.id} />
    </div>
  `;
}

const ATTEMPT_STATE = {
  starting: { label: 'Starting', tone: 'starting' },
  working: { label: 'Working', tone: 'starting' },
  done: { label: 'Done', tone: 'ready' },
};

// Follows one attempt's session until the agent has answered.
function AttemptCard({ attempt, onKeep }) {
  const [status, setStatus] = useState({ state: 'starting', reply: null });
  usePoll(
    async () => {
      const next = await api(`/api/attempts/${attempt.id}/status`);
      setStatus(next);
      return next.state !== 'done';
    },
    5000,
    [attempt.id]
  );
  const state = ATTEMPT_STATE[status.state] || ATTEMPT_STATE.starting;
  const m = attempt.metadata;

  return html`
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-stone-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <strong>Attempt ${m.attempt}</strong>
        <span className=${ui.chip(state.tone)}>${state.label}</span>
      </div>
      <div className=${`max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 px-2.5 py-2 text-[13.5px] ${status.reply ? '' : 'text-stone-500'}`}>
        ${status.reply || 'Waiting for the agent...'}
      </div>
      <div className="flex items-center gap-2.5 text-[13px]">
        <a className="text-stone-600 underline" href=${`/chat.html?instance=${attempt.id}`}>Open chat</a>
        <span className="text-stone-500">branch <code>${m.neon_branch_id}</code></span>
      </div>
      <button className=${ui.primary} onClick=${onKeep}>Keep this one</button>
    </div>
  `;
}

// One read-only query, run on the original's branch and every attempt's branch.
function CheckPanel({ agentId }) {
  const [sql, setSql] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  async function run(event) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResults((await api(`/api/agents/${agentId}/check`, { method: 'POST', body: { sql } })).data);
    } catch (err) {
      setError(err.message);
    }
    setRunning(false);
  }

  return html`
    <div>
      <form onSubmit=${run} className="mt-4 flex gap-2.5">
        <input
          required
          value=${sql}
          onChange=${(e) => setSql(e.target.value)}
          placeholder="Compare the data: a read-only SQL query run on the original and every attempt, e.g. select category, count(*) from products group by 1"
          className=${`${ui.input} flex-1 font-mono text-[13px]`}
        />
        <button className=${ui.btn} type="submit" disabled=${running}>${running ? 'Running...' : 'Run on every branch'}</button>
      </form>
      ${error && html`<p className="mt-2.5 text-[13px] text-red-700">${error}</p>`}
      ${results &&
      html`
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          ${results.map(
            (entry) => html`
              <div key=${entry.instance_id} className="overflow-x-auto rounded-xl border border-stone-200 p-2.5">
                <div className="mb-1.5 text-[13px]"><strong>${entry.label}</strong> <code className="text-stone-500">${entry.instance_id}</code></div>
                ${entry.error ? html`<p className="text-[13px] text-red-700">${entry.error}</p>` : html`<${RowsTable} rows=${entry.rows} />`}
              </div>
            `
          )}
        </div>
      `}
    </div>
  `;
}

function RowsTable({ rows }) {
  if (!rows.length) return html`<p className="text-[13px] text-stone-500">No rows.</p>`;
  const columns = Object.keys(rows[0]);
  const show = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
  return html`
    <div>
    <table className="w-full text-[12.5px]">
      <thead>
        <tr>${columns.map((c) => html`<th key=${c} className="px-2 py-1 text-left font-medium text-stone-500">${c}</th>`)}</tr>
      </thead>
      <tbody>
        ${rows.slice(0, 50).map(
          (row, i) => html`
            <tr key=${i} className="border-t border-stone-100">
              ${columns.map((c) => html`<td key=${c} className="px-2 py-1">${show(row[c])}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
    ${rows.length > 50 && html`<p className="text-[13px] text-stone-500">${rows.length - 50} more rows</p>`}
    </div>
  `;
}

createRoot(document.getElementById('root')).render(html`<${AgentsPage} />`);
