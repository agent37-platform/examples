import { createServer } from 'node:http';
import { userFromToken } from './token.js';

const BROWSER_USE_API = 'https://api.browser-use.com/api/v3';
const TIMEOUT_MINUTES = Number(process.env.BROWSER_TIMEOUT_MINUTES || 15);

// One live Browser Use browser per user, reused while it is still running. In memory, so run
// one copy of this server, or move the map to your database.
const browsers = new Map();

async function browserUse(path, init = {}) {
  const res = await fetch(BROWSER_USE_API + path, {
    ...init,
    headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Browser Use ${res.status}: ${await res.text()}`);
  return res.json();
}

async function browserFor(userId) {
  const known = browsers.get(userId);
  if (known && (await browserUse(`/browsers/${known.id}`)).status === 'active') return known.wsUrl;

  const created = await browserUse('/browsers', {
    method: 'POST',
    body: JSON.stringify({ timeout: TIMEOUT_MINUTES, metadata: { user: userId } }),
  });
  const { webSocketDebuggerUrl } = await (await fetch(`${created.cdpUrl}/json/version`)).json();
  browsers.set(userId, { id: created.id, wsUrl: webSocketDebuggerUrl });
  console.log(`browser ${created.id} for ${userId}`);
  return webSocketDebuggerUrl;
}

// Hermes reads BROWSER_CDP_URL=<PUBLIC_URL>/browser/<token> and asks <that>/json/version for
// the browser to drive, the same discovery call Chrome answers on its debugging port.
createServer(async (req, res) => {
  const match = req.url.match(/^\/browser\/([^/]+)\/json\/version$/);
  const userId = match && userFromToken(match[1]);
  if (!userId) {
    res.writeHead(404).end();
    return;
  }
  try {
    const webSocketDebuggerUrl = await browserFor(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Browser Use', webSocketDebuggerUrl }));
  } catch (err) {
    console.error(`browser for ${userId} failed: ${err.message}`);
    res.writeHead(502).end();
  }
}).listen(Number(process.env.PORT || 3000), () => console.log(`broker on :${process.env.PORT || 3000}`));
