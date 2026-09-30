// The shared computer's live screen: a noVNC client connected straight to the desktop's
// WebSocket on the instance, with a token this app's server mints for each connection.
// Watching is view-only; Take over lets mouse and keyboard through; Give back stops them.
// Only this page tells the two apart: the token itself grants full control.
// noVNC is plain ES modules, so the page imports a pinned release straight from a CDN: no
// install, no build step.
import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/core/rfb.js';

const $ = (id) => document.getElementById(id);
const CONNECTING = 'Connecting to the computer...';

export function startComputer({ isWorking }) {
  const slot = $('computer-slot');
  let rfb = null;
  let live = false;
  let connecting = false;
  let control = false;
  let failures = 0;
  let retryTimer = null;

  // Connected only while someone can see it. An open view is traffic, and traffic keeps the
  // computer awake, so a hidden tab or a closed pane lets it go back to sleep.
  const wanted = () => document.visibilityState === 'visible' && !$('app').hidden && !$('app').classList.contains('pane-closed');

  function render() {
    const working = isWorking();
    const badge = $('computer-badge');
    badge.textContent = !live ? (failures ? 'Reconnecting' : 'Connecting') : control ? "You're in control" : working ? 'Working' : 'Live';
    badge.className = `computer-badge ${live ? (control ? 'you' : working ? 'working' : 'live') : ''}`;
    slot.classList.toggle('control', control);
    $('computer-note').hidden = live;
    $('computer-take').textContent = control ? 'Give back' : 'Take over';
    $('computer-take').disabled = !live;
  }

  async function connect() {
    clearTimeout(retryTimer);
    if (rfb || connecting || !wanted()) return;
    connecting = true;
    let ws;
    try {
      const res = await fetch('/api/computer', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      ws = body.ws;
    } catch (err) {
      $('computer-note').textContent = `Could not open the screen: ${err.message}`;
      return retry();
    } finally {
      connecting = false;
    }
    if (!wanted()) return;
    $('computer-note').textContent = CONNECTING;
    // Opening the socket wakes a sleeping computer; the connect event fires once it is back.
    rfb = new RFB($('computer-view'), ws);
    rfb.scaleViewport = true;
    rfb.viewOnly = !control;
    rfb.background = '#0A0A0A';
    rfb.addEventListener('connect', () => {
      live = true;
      failures = 0;
      if (control) rfb.focus();
      render();
    });
    // A token is only checked when the socket opens, so a reconnect needs a fresh one.
    rfb.addEventListener('disconnect', () => {
      rfb = null;
      live = false;
      retry();
    });
    render();
  }

  function retry() {
    if (wanted()) {
      failures += 1;
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** failures, 15000));
    }
    render();
  }

  function sync() {
    if (wanted()) return connect();
    clearTimeout(retryTimer);
    failures = 0;
    rfb?.disconnect();
  }

  function expand(open) {
    slot.classList.toggle('expanded', open);
    if (!open && control) setControl(false);
  }

  function setControl(on) {
    control = on;
    if (on) expand(true);
    if (rfb) {
      rfb.viewOnly = !on;
      if (on) rfb.focus();
    }
    render();
  }

  $('computer-cover').addEventListener('click', () => expand(true));
  $('computer-close').addEventListener('click', () => expand(false));
  $('computer-take').addEventListener('click', () => setControl(!control));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !control && slot.classList.contains('expanded')) expand(false);
  });
  document.addEventListener('visibilitychange', sync);

  slot.hidden = false;
  render();
  sync();
  return { render, sync };
}
