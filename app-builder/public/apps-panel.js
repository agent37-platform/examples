// The Apps panel: every app on the instance, its public URL, and its database.
// The server reads both from the instance with exec, so a refresh takes a few seconds.
import { useEffect, useState } from 'react';
import { html } from 'htm/react';
import { api, ui } from './lib.js';

const STATE = {
  unclaimed: { label: 'Temporary database', tone: 'starting' },
  pending: { label: 'Claim in progress', tone: 'starting' },
  claimed: { label: 'Claimed: yours to keep', tone: 'ready' },
  expired: { label: 'Database expired', tone: 'failed' },
  unknown: { label: 'Database state unknown', tone: 'neutral' },
};

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'expiring now';
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}h left` : `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

export function AppsPanel({ instanceId, reloadKey }) {
  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api(`/api/instances/${instanceId}/apps`)
      .then(({ data }) => !cancelled && (setApps(data), setError(null)))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [instanceId, reloadKey, refreshes]);

  const reload = () => setRefreshes((n) => n + 1);

  return html`
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-stone-200 bg-white p-3.5">
      <div className="flex items-center justify-between">
        <strong>Apps</strong>
        <button className=${`${ui.btn} !px-2.5 !py-1 !text-xs`} onClick=${reload}>Refresh</button>
      </div>
      <p className="my-2.5 text-[13px] text-stone-500">
        Each app runs on its own Neon Postgres database. Unclaimed databases are free and deleted 72 hours after creation; claim one to keep it in your
        own Neon account.
      </p>
      ${error && html`<p className="text-sm text-red-700">Could not load apps: ${error}</p>`}
      ${!error && !apps && html`<p className="text-sm text-stone-500">Loading...</p>`}
      ${apps?.length === 0 && html`<p className="text-sm text-stone-500">No apps yet. Ask the agent for one.</p>`}
      ${apps?.map((app) => html`<${AppCard} key=${app.slug} instanceId=${instanceId} app=${app} onChange=${reload} />`)}
    </aside>
  `;
}

function AppCard({ instanceId, app, onChange }) {
  const [claim, setClaim] = useState(null); // the claim link, once minted
  const state = STATE[app.state] || STATE.unknown;
  const canClaim = app.state === 'unclaimed' || app.state === 'pending';
  const canReconnect = app.state === 'claimed' || app.state === 'pending' || claim;

  return html`
    <div className="mb-2.5 flex flex-col gap-1.5 rounded-xl border border-stone-200 p-3">
      <div className="font-semibold">${app.slug}</div>
      ${app.url
        ? html`<a className="text-sm font-medium text-green-700 hover:underline" href=${app.url} target="_blank" rel="noopener">Open app ↗</a>`
        : html`<span className="text-sm text-stone-500">Not published yet</span>`}
      <div className="flex items-center gap-2 text-[13px]">
        <span className=${ui.chip(state.tone)}>${state.label}</span>
        ${app.expires_at && html`<span className="text-stone-500">${timeLeft(app.expires_at)}</span>`}
        ${app.stale && html`<span className="text-stone-500" title="Neon could not be reached; showing the last state seen">last known</span>`}
      </div>
      <div className="text-[13px] text-stone-500">Neon project <code>${app.project_id}</code></div>
      ${claim
        ? html`<${ClaimNote} claim=${claim} />`
        : canClaim && html`<${ClaimButton} instanceId=${instanceId} slug=${app.slug} onClaim=${setClaim} />`}
      ${canReconnect && html`<${ReconnectForm} instanceId=${instanceId} slug=${app.slug} onDone=${onChange} />`}
    </div>
  `;
}

// Mints a claim code on the instance and opens Neon's claim page. The code is good for
// 15 minutes; minting another cancels the previous unused one.
function ClaimButton({ instanceId, slug, onClaim }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/api/instances/${instanceId}/apps/${slug}/claim`, { method: 'POST' });
      window.open(result.verification_url, '_blank', 'noopener');
      onClaim(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return html`
    <div className="flex flex-col gap-1.5">
      <button className=${ui.primary} disabled=${busy} onClick=${claim}>${busy ? 'Getting claim link...' : 'Claim database'}</button>
      ${error && html`<p className="text-[13px] text-red-700">Claim failed: ${error}</p>`}
    </div>
  `;
}

function ClaimNote({ claim }) {
  return html`
    <p className="text-[13px]">
      Finish in the Neon tab (code <code>${claim.user_code}</code>, valid 15 minutes).${' '}
      <a className="underline" href=${claim.verification_url} target="_blank" rel="noopener">Reopen</a>. Treat the link like a password: whoever opens it first gets the
      database. Claiming revokes the temporary password, so paste your new connection string below to bring the app back.
    </p>
  `;
}

// After a claim, the user's Neon account issues a new connection string. The server
// writes it into the app's .env on the instance and restarts the app.
function ReconnectForm({ instanceId, slug, onDone }) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState(null); // null | 'saving' | 'done' | error message

  async function submit(event) {
    event.preventDefault();
    setStatus('saving');
    try {
      await api(`/api/instances/${instanceId}/apps/${slug}/database-url`, { method: 'POST', body: { database_url: url.trim() } });
      setStatus('done');
      setUrl('');
      onDone();
    } catch (err) {
      setStatus(err.message);
    }
  }

  return html`
    <form onSubmit=${submit} className="mt-1 flex flex-col gap-1.5">
      <label className="text-[13px] text-stone-500">New connection string from the Neon Console</label>
      <input
        className=${ui.input}
        type="password"
        placeholder="postgresql://..."
        required
        autoComplete="off"
        value=${url}
        onChange=${(e) => setUrl(e.target.value)}
      />
      <button className=${ui.btn} type="submit" disabled=${status === 'saving'}>${status === 'saving' ? 'Reconnecting...' : 'Reconnect app'}</button>
      ${status === 'done' && html`<p className="text-[13px] text-green-700">${slug} now runs on your claimed database.</p>`}
      ${status && !['saving', 'done'].includes(status) && html`<p className="text-[13px] text-red-700">Reconnect failed: ${status}</p>`}
    </form>
  `;
}
