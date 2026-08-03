# Hermes with a live desktop (VNC)

A Hermes agent whose desktop you can watch live from any browser tab. The agent opens Chromium, navigates, clicks, and fills forms while you (or your users) watch it happen in real time. Embeddable in your own app.

[`hermes-base`](https://github.com/orgs/agent37-platform/packages/container/package/hermes-base) already ships Chromium and a virtual display; this image adds the view: **x11vnc** screencasts the display, **noVNC + websockify** serve it over WebSocket on port **6901**, and Hermes' browser tool is pointed (via `BROWSER_CDP_URL`) at a *visible* Chromium instead of its default headless one, so the desktop shows the browser the agent is actually driving. The entrypoint also wires Hermes to the platform's [managed LLM endpoint](https://www.agent37.com/docs/agents-api/managed-services) on every boot, so chat works out of the box with no model keys.

## Build and run

You don't need Docker: Agent37 builds the image for you from this folder ([how cloud builds work](https://www.agent37.com/docs/agents-api/custom-image)).

```bash
export AGENT37_API_KEY=sk_live_...

# Build this folder into a workspace template (streams the build log)
npx agent37 templates build . --name hermes-vnc-desktop

# Create an instance from it
curl -X POST https://api.agent37.com/v1/instances \
  -H "Authorization: Bearer $AGENT37_API_KEY" -H "Content-Type: application/json" \
  -d '{ "template": "hermes-vnc-desktop" }'
```

## Open the desktop

Mint a [signed URL](https://www.agent37.com/docs/agents-api/urls#browser-access-with-signed-urls) for port 6901 and open the noVNC page on it:

```bash
curl -X POST https://api.agent37.com/v1/instances/<id>/signed-url \
  -H "Authorization: Bearer $AGENT37_API_KEY" -H "Content-Type: application/json" \
  -d '{ "port": 6901 }'
# → { "url": "https://<id>-6901.agent37.app/?a37_token=..." }
```

Take the returned URL and change the path from `/` to `/vnc.html`, keeping the token:

```
https://<id>-6901.agent37.app/vnc.html?a37_token=...&autoconnect=1&resize=scale
```

Ask the agent to browse something (`POST /v1/responses` on the instance, or the [hermes-chat](../../hermes-chat) example) and watch it work.

## Embedding it in your own app

The edge sends `Content-Security-Policy: frame-ancestors *`, so iframing is allowed. But the signed URL's auth cookie is `SameSite=Lax`: inside a **cross-site** iframe (your domain framing `agent37.app`) the browser won't send it, and the VNC WebSocket won't authenticate. Two ways that work:

- **[Custom domain](https://www.agent37.com/docs/agents-api/domains):** serve the instance URLs from your own domain; the iframe becomes same-site and the cookie flows.
- **Proxy through your backend:** reverse-proxy `https://<id>-6901.agent37.app` (WebSocket upgrade included) from your own server with the `X-Agent37-Key` header attached; the view is then same-origin with your app, and no Agent37 token ever reaches the browser.

For a quick demo you can instead give the port a permanent public URL with [public ports](https://www.agent37.com/docs/agents-api/public-ports): no token, but the URL is the credential, and anyone who has it can watch *and control* the desktop.

## Notes

- Managed LLM calls draw on the instance [budget](https://www.agent37.com/docs/agents-api/budgets), which starts at $0. Set one at create (`"budget": { "monthly_cap_micros": 5000000 }`) or `PATCH …/budget`, else chat returns `402`.
- Give it room: the default 2 vCPU / 4 GB works; use 4 / 8 if the agent opens heavy pages.
- Port 6901 serves noVNC; 5900 (VNC) and 9222 (DevTools) stay on loopback inside the container. Leave `default_port` unset so the bare instance URL keeps serving the chat API.
- The screen is 1440×900. Add `ENV AGENT37_SCREEN_GEOMETRY=1920x1080x24` to the Dockerfile for another size.
