// The "Start texting" panel, shared by onboarding and the workspace. Everything on it comes
// from Inkbox's triage-number call: the router number, the connect command, an sms: link
// with the command pre-drafted, and a QR code of the same draft.

export function formatPhone(e164) {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return match ? `+1 (${match[1]}) ${match[2]}-${match[3]}` : e164 || '';
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function renderTexting(container, me) {
  const connect = me.connect;
  if (!connect) {
    container.innerHTML = '<p class="muted">The connect code appears once setup finishes.</p>';
    return;
  }
  container.innerHTML = `
    <div class="tabs">
      <button type="button" class="on" data-tab="imessage">iMessage</button>
      <button type="button" data-tab="email">Email</button>
    </div>
    <div data-pane="imessage">
      <div class="qr-card desktop-only">
        <img src="${connect.qr}" alt="QR code that opens Messages with the connect text" />
        <div>
          <p>Scan with your iPhone camera. Messages opens with the text ready: just send it.</p>
          <p class="faint">Or text <code>${escapeHtml(connect.command)}</code> to</p>
          <div class="big-number">${formatPhone(connect.number)}</div>
        </div>
      </div>
      <div class="mobile-only">
        <a class="button primary" href="${escapeHtml(connect.smsLink)}">Open Messages</a>
        <p class="faint">It sends <code>${escapeHtml(connect.command)}</code> to ${formatPhone(connect.number)}.</p>
      </div>
      <p class="muted">${escapeHtml(me.agentName)} texts you back from its own number with a contact card. Save it, then say hi. Calls to that number are answered by Inkbox Voice AI, and ${escapeHtml(me.agentName)} gets the transcript.</p>
    </div>
    <div data-pane="email" hidden>
      <p class="muted">Email ${escapeHtml(me.agentName)} from ${escapeHtml(me.ownerEmail || 'your address')}, forward it a thread, or CC it:</p>
      <div class="big-number">${escapeHtml(me.email)}</div>
      <p class="faint">Replies come from that address. Memory is shared with your texts.</p>
    </div>`;
  for (const tab of container.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const other of container.querySelectorAll('[data-tab]')) other.classList.toggle('on', other === tab);
      for (const pane of container.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    });
  }
}
