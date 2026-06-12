const statusEl = document.getElementById('status');
const table = document.getElementById('instances');
const tbody = table.querySelector('tbody');
const emptyEl = document.getElementById('empty');
const createBtn = document.getElementById('create');

const readinessPollers = new Map();
let pendingCreate = null;
let currentInstances = [];

async function api(path, init) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code });
  return body;
}

function statusChip(instance) {
  if (instance.status === 'running') return '<span class="chip starting" data-ready-chip>Starting</span>';
  if (instance.status === 'failed') return '<span class="chip failed">Failed</span>';
  if (instance.status === 'creating') return '<span class="chip starting">Creating</span>';
  return `<span class="chip">${instance.status}</span>`;
}

function render(instances) {
  tbody.innerHTML = '';
  const rows = pendingCreate ? [pendingCreate, ...instances] : instances;
  table.hidden = rows.length === 0;
  emptyEl.hidden = rows.length > 0;
  for (const instance of rows) {
    const tr = document.createElement('tr');
    tr.className = instance.pending ? 'pending-row' : 'clickable';
    tr.innerHTML = `
      <td>${escapeHtml(instance.name || 'Untitled')}</td>
      <td><code>${instance.id}</code></td>
      <td>${statusChip(instance)}</td>
      <td class="muted">${new Date(instance.created * 1000).toLocaleString()}</td>
      <td>${instance.pending ? '<span class="muted">Please wait...</span>' : '<button class="danger" data-delete>Delete</button>'}</td>`;
    if (instance.pending) {
      tbody.appendChild(tr);
      continue;
    }
    tr.addEventListener('click', () => {
      if (instance.status === 'running') location.href = `/chat.html?instance=${instance.id}`;
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete instance ${instance.id}? Unused prepaid time is refunded.`)) return;
      try {
        await api(`/api/instances/${instance.id}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        statusEl.textContent = `Delete failed: ${err.message}`;
      }
    });
    tbody.appendChild(tr);
    if (instance.status === 'running') pollReadiness(instance.id, tr);
  }
}

// The create call returns once the container runs, but the agent inside keeps booting for a
// bit (minutes, on a cold host). Poll health until the chat surface actually answers.
function pollReadiness(id, row) {
  if (readinessPollers.has(id)) readinessPollers.get(id).row = row;
  const state = { row, tries: 0 };
  readinessPollers.set(id, state);
  const tick = async () => {
    if (!state.row.isConnected) return readinessPollers.delete(id);
    try {
      const { ready } = await api(`/api/instances/${id}/ready`);
      const chip = state.row.querySelector('[data-ready-chip]');
      if (ready && chip) {
        chip.textContent = 'Ready';
        chip.className = 'chip ready';
        return readinessPollers.delete(id);
      }
    } catch {}
    if (++state.tries < 75) setTimeout(tick, 5000);
  };
  tick();
}

async function refresh() {
  try {
    const { data } = await api('/api/instances');
    currentInstances = data.filter((instance) => instance.status !== 'deleted');
    render(currentInstances);
    if (!pendingCreate) statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = err.code === 'invalid_api_key'
      ? 'Your API key was rejected. Check AGENT37_API_KEY in .env and restart the server.'
      : `Could not load instances: ${err.message}`;
  }
}

createBtn.addEventListener('click', async () => {
  const name = prompt('Name for the new instance:', 'My Hermes agent');
  if (name === null) return;
  const label = name.trim() || 'hermes-chat example';
  pendingCreate = {
    pending: true,
    name: label,
    id: 'creating...',
    status: 'creating',
    created: Math.floor(Date.now() / 1000),
  };
  render(currentInstances);
  createBtn.disabled = true;
  createBtn.textContent = 'Creating...';
  statusEl.textContent = 'Creating instance. This usually takes a few seconds, but can take a few minutes on a cold host...';
  try {
    await api('/api/instances', { method: 'POST', body: JSON.stringify({ name }) });
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = err.code === 'insufficient_balance'
      ? 'Your wallet balance is too low. The smallest instance debits about $0.16 at create. Top up at agent37.com/dashboard/cloud/billing.'
      : `Create failed: ${err.message} (refresh the list, the instance may still appear)`;
  }
  pendingCreate = null;
  createBtn.disabled = false;
  createBtn.textContent = 'Create instance';
  refresh();
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

refresh();
