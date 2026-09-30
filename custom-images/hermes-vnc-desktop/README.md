# Hermes with a live desktop (VNC)

A Hermes agent whose computer you can watch live from any browser tab, and take over when it needs you: the agent opens Chromium, navigates, clicks, and fills forms while you (or your users) watch it happen in real time. Embeddable in your own app.

The image is the stock `agent37-hermes` image ([`ghcr.io/agent37-platform/hermes`](https://github.com/orgs/agent37-platform/packages/container/package/hermes)) plus a view. **x11vnc** screencasts the display, **noVNC + websockify** serve it over WebSocket on port **6901**, and Hermes' browser tool is pointed (via `BROWSER_CDP_URL`) at a *visible* Chromium instead of its default headless one, so the desktop shows the browser the agent is actually driving.

Everything the stock template does still happens, because the image's entrypoint only starts the view and then hands over to the stock entrypoint: the [managed model](https://www.agent37.com/docs/agents-api/managed-services), managed [app connections](https://www.agent37.com/docs/agents-api/integrations), web search, the `agent37` CLI the agent uses to [schedule itself](https://www.agent37.com/docs/agents-api/crons#your-agent-can-schedule-itself), and the stock approval and browser settings. Chat works out of the box with no model keys.

## What changed

Earlier versions of this recipe were built `FROM hermes-base`, the clean image, and wired only the model by hand. They had no `agent37` CLI, no app connections, no web search, and no paid tools. Now:

- `FROM ghcr.io/agent37-platform/hermes:latest`, and the entrypoint wraps the stock one instead of replacing it.
- Chromium keeps a persistent profile in `~/.config/desktop-chromium`, on the instance's persisted home. A login you do during a takeover stays logged in across restarts, updates, and sleep, and the agent's browser uses the same profile, so it is logged in too. Chromium writes cookies to disk within about 30 seconds, so only a login finished moments before a restart can be lost.
- The VNC server, websockify, and Chromium come back if they exit: closing the browser window during a takeover just reopens it.
- Restarts bring the display back reliably (a stale X lock left in `/tmp` could stop it before).

## Build and run

You don't need Docker: Agent37 builds the image for you from this folder ([how cloud builds work](https://www.agent37.com/docs/agents-api/custom-image)).

```bash
export AGENT37_API_KEY=sk_live_...

# Build this folder into a workspace template (streams the build log)
npx agent37 templates build . --name hermes-vnc-desktop --default-port 3737

# Create an instance from it: a budget so the managed model answers, and auto-sleep
curl -X POST https://api.agent37.com/v1/instances \
  -H "Authorization: Bearer $AGENT37_API_KEY" -H "Content-Type: application/json" \
  -d '{ "template": "hermes-vnc-desktop", "budget": { "monthly_cap_micros": 5000000 }, "auto_sleep": true }'
```

`--default-port 3737` makes the create wait for the gateway, so the instance is ready to chat when it returns. Poll `GET https://<id>.agent37.app/v1/health` until `"healthy": true` before the first message.

## Open the desktop

Mint a [signed URL](https://www.agent37.com/docs/agents-api/urls#browser-access-with-signed-urls) for port 6901 and open the noVNC page on it:

```bash
curl -X POST https://api.agent37.com/v1/instances/<id>/signed-url \
  -H "Authorization: Bearer $AGENT37_API_KEY" -H "Content-Type: application/json" \
  -d '{ "port": 6901, "ttl_seconds": 300 }'
# → { "url": "https://<id>-6901.agent37.app/?a37_token=...", ... }
```

Take the returned URL and change the path from `/` to `/vnc.html`, keeping the token:

```
https://<id>-6901.agent37.app/vnc.html?a37_token=...&autoconnect=1&resize=scale
```

Add `&view_only=1` to watch without controlling. Ask the agent to browse something (`POST /v1/responses` on the instance, or the [hermes-chat](../../hermes-chat) example) and watch it work.

## Embed it in your own app

Don't iframe the signed URL cross-site: its auth rides a `SameSite=Lax` cookie, so inside an iframe on your own domain noVNC's sub-resources come back `401`. The signed URL page is for top-level tabs.

To embed, load the noVNC client in your page and connect its WebSocket straight to the instance with the signed token in the URL. The token rides in the WebSocket URL's query string, so the connection needs no cookie and works from any origin, in every browser, with no extra infrastructure.

**Server** (Express). Mint a token for the signed-in user's own instance and hand the browser only the WebSocket URL.

```js
import express from 'express';

const app = express();

app.post('/api/computer', async (req, res) => {
  const instanceId = instanceIdForUser(req); // your own session lookup
  const r = await fetch(`https://api.agent37.com/v1/instances/${instanceId}/signed-url`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AGENT37_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 6901, ttl_seconds: 60 }),
  });
  if (!r.ok) return res.status(r.status).json(await r.json());
  const signed = new URL((await r.json()).url);
  res.json({ ws: `wss://${signed.host}/websockify?a37_token=${signed.searchParams.get('a37_token')}` });
});
```

**Browser.** noVNC is plain ES modules, so the page imports a pinned release straight from a CDN, with no install and no build step. Start in view-only mode; Take over flips `viewOnly` off, Hand back flips it on again:

```html
<div id="computer" style="width: 960px; height: 600px"></div>
<button id="take-over">Take over</button>
<button id="hand-back">Hand back</button>

<script type="module">
  import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/core/rfb.js';

  const { ws } = await (await fetch('/api/computer', { method: 'POST' })).json();
  const rfb = new RFB(document.getElementById('computer'), ws);
  rfb.scaleViewport = true;
  rfb.viewOnly = true;

  document.getElementById('take-over').onclick = () => { rfb.viewOnly = false; rfb.focus(); };
  document.getElementById('hand-back').onclick = () => { rfb.viewOnly = true; };
  rfb.addEventListener('disconnect', () => { /* fetch a fresh URL and connect again */ });
</script>
```

What to know about the token:

- **It grants full control.** `viewOnly` is a setting in your page, not a permission: anyone holding the token can connect a VNC client that clicks and types. Hand tokens only to the instance's owner.
- **It cannot be revoked.** A minted token works until it expires, so mint a short one. 60 seconds is enough: the token only has to be valid when the connection opens, and an open connection keeps working after it expires. A reconnect needs a fresh token.
- **Opening it wakes a sleeping instance.** The edge holds the connection while the instance restores, usually a few seconds, and the screen comes back as the agent left it.

Two alternatives, if you prefer a framed page over mounting the client:

- **[Custom domain](https://www.agent37.com/docs/agents-api/domains):** serve the instance URLs from your own domain; the iframe becomes same-site and the cookie flows. Only helps when your app runs on the same registrable domain as the delegated apex.
- **Proxy through your backend:** reverse-proxy `https://<id>-6901.agent37.app` (WebSocket upgrade included) from your own server with the `X-Agent37-Key` header attached; the view is then same-origin with your app, and no Agent37 token ever reaches the browser. Needs a host that allows long-lived WebSockets (not serverless).

## Scheduled tasks

[Crons](https://www.agent37.com/docs/agents-api/crons) work as on `agent37-hermes`, with one difference: on a workspace template, set `"agent": "hermes"` when you create one. Without it the firing still runs on Hermes, but its run records `session_id` only once the turn finishes instead of the moment it fires:

```bash
curl -X POST https://api.agent37.com/v1/instances/<id>/crons \
  -H "Authorization: Bearer $AGENT37_API_KEY" -H "Content-Type: application/json" \
  -d '{ "schedule": "0 9 * * 1-5", "timezone": "America/New_York", "prompt": "Check my inbox and summarise anything urgent.", "agent": "hermes" }'
```

Crons the agent creates for itself with `agent37 cron add` have no `agent` set. `PATCH` them with `{ "agent": "hermes" }` if your app lists their runs.

## Notes

- Managed model calls draw on the instance [budget](https://www.agent37.com/docs/agents-api/budgets), which starts at $0. Set one at create, as above, or `PATCH …/budget`, else chat returns `402`.
- Give it room: the default 2 vCPU / 4 GB works; use 4 / 8 if the agent opens heavy pages.
- [Auto-sleep](https://www.agent37.com/docs/agents-api/instances#auto-sleep) works with the desktop: the VNC stack and the visible Chromium survive the checkpoint and restore, with the page the agent left open. The desktop adds nothing to the bill; a running instance is priced by its shape, not by what runs inside.
- Port 6901 serves noVNC; 5900 (VNC) and 9222 (DevTools) stay on loopback inside the instance.
- Telegram: `agent37-hermes` instances get a [webhook port](https://www.agent37.com/docs/agents-api/public-ports) wired at create; workspace templates do not. A Telegram bot on this template polls instead, which only works while the instance is awake, so leave `auto_sleep` off for a Telegram agent.
- The screen is 1440×900. Add `ENV AGENT37_SCREEN_GEOMETRY=1920x1080x24` to the Dockerfile for another size.
- For reproducible rebuilds, pin the base to a dated tag instead of `:latest` (the current one is in `agent37-hermes`'s `image_ref` on `GET /v1/templates`).
