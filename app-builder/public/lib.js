// Small helpers shared by the pages: Tailwind class strings, a fetch wrapper for this
// app's own /api routes, and a polling hook.
import { useEffect } from 'react';

export const ui = {
  btn: 'rounded-lg border border-stone-200 bg-white px-3.5 py-1.5 text-sm hover:border-stone-300 disabled:cursor-default disabled:opacity-50',
  primary: 'rounded-lg bg-stone-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-default disabled:opacity-50',
  danger: 'rounded-lg border border-stone-200 bg-white px-3.5 py-1.5 text-sm text-red-700 hover:border-red-200 disabled:opacity-50',
  input: 'rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm outline-none focus:border-stone-400',
  chip(tone = 'neutral') {
    const tones = {
      neutral: 'border-stone-200 text-stone-600',
      ready: 'border-green-200 bg-green-50 text-green-700',
      starting: 'border-amber-200 bg-amber-50 text-amber-700',
      failed: 'border-red-200 bg-red-50 text-red-700',
    };
    return `inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone] || tones.neutral}`;
  },
};

// Calls this app's server. Errors come back as { error: { code, message } }.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { code: json?.error?.code });
  return json;
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls `tick` every `ms` until it returns false or the component unmounts.
export function usePoll(tick, ms, deps) {
  useEffect(() => {
    let stopped = false;
    let timer;
    const run = async () => {
      const again = await tick().catch(() => true);
      if (!stopped && again !== false) timer = setTimeout(run, ms);
    };
    run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, deps);
}
