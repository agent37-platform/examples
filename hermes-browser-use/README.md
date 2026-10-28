# hermes-browser-use

Give every user's Hermes agent a [Browser Use Cloud](https://browser-use.com) browser (stealth, residential proxies, CAPTCHA solving) without putting your Browser Use key in their sandbox. A user can ask their own agent to print its environment, so anything you put there, they can read. This example keeps the key on a small server of yours and gives each agent a per-user link instead. Plain Node, no dependencies.

```text
user's agent (agent37-hermes)
  env BROWSER_CDP_URL=https://your-server/browser/<user token>
    │  GET .../json/version
    ▼
this server (holds BROWSER_USE_API_KEY)
  checks the token, starts or reuses that user's Browser Use browser,
  replies with that one browser's address
    │
    ▼
Browser Use Cloud  ◄──  the agent drives the browser directly
```

Hermes treats `BROWSER_CDP_URL` the way it treats a Chrome debugging port: it asks for `/json/version` and drives whatever browser comes back. This server answers that one call.

## Run it

You need an Agent37 [API key](https://www.agent37.com/dashboard/cloud/api-keys) with at least $10 in your [wallet](https://www.agent37.com/dashboard/cloud/billing), and a Browser Use key from [cloud.browser-use.com](https://cloud.browser-use.com) with credits on it.

Agents run in the cloud, so `PUBLIC_URL` must be a public `https://` URL. Deploy the server, or for local dev open a quick tunnel:

```bash
# terminal 1: a public URL for this server (prints https://<something>.trycloudflare.com)
cloudflared tunnel --url http://localhost:3000

# terminal 2
cp .env.example .env   # AGENT37_API_KEY, BROWSER_USE_API_KEY, BROKER_SECRET (openssl rand -hex 32), PUBLIC_URL (the tunnel URL)
npm start

# terminal 3: an agent for the user "alice"
npm run create-agent -- alice
```

`create-agent` prints the new instance's id and URL. Once it is up, ask it to browse:

```bash
curl https://<id>.agent37.app/v1/responses \
  -H "X-Agent37-Key: $AGENT37_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "input": "Open https://ipinfo.io/json with your browser tool and tell me the ip and org fields." }'
```

An `org` that is a consumer internet provider (Charter, Comcast, and the like) means the page loaded in Browser Use, and the server logs `browser <id> for alice`.

## How it behaves

- **The key never leaves your server.** The sandbox holds only its user's token, which opens nothing but that user's own browser. A token for another user, or a made-up one, gets a 404.
- **One browser per user.** A user's first browse starts a Browser Use browser labelled `user: alice`; every chat after that reuses it until it times out (`BROWSER_TIMEOUT_MINUTES`, default 15), and the next browse starts a fresh one. Cookies and sign-ins carry across that user's chats while the browser lives. Filter the Browser Use dashboard by `user` to see each user's usage.
- **Concurrency.** Each user holds at most one browser, so your Browser Use plan's concurrent session limit caps how many users can browse inside the same window.
- **If this server is down,** browsing fails for that turn; the rest of the agent keeps working.

## What it costs

Browser Use bills each browser at $0.02 an hour by the minute until it times out, plus proxy traffic ([pricing](https://browser-use.com/pricing)), so a user who browses once costs about half a cent plus traffic. Each Agent37 agent is an `agent37-hermes` instance on the smallest shape ($4.76 per month while awake) with the $2 monthly LLM budget `create-agent.js` gives it.

## Use it in your app

Two pieces move into your own backend:

1. **The route.** `GET /browser/:token/json/version` from `server.js`. Swap `userFromToken` in `token.js` for a lookup in your own database, which is also where you cut a user off. The browser map is in memory, so run one copy of the server or keep the map in your database.
2. **The env line.** Wherever you create each user's instance, add `BROWSER_CDP_URL` with that user's token, as `create-agent.js` does.
