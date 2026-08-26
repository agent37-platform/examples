#!/usr/bin/env node
// Claude Code on your own OpenRouter key: create an agent37-claude-code instance whose
// model calls go to OpenRouter instead of Anthropic, chat with it, delete it.
//
//   node agent.js create
//   node agent.js chat <instanceId> "your message"
//   node agent.js delete <instanceId>
require('dotenv').config();

const HOSTING_API = 'https://api.agent37.com';
const KEY = process.env.AGENT37_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

if (!KEY) exit('Set AGENT37_API_KEY in .env');

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

function exit(message) {
  console.error(message);
  process.exit(1);
}

async function request(url, options = {}) {
  const res = await fetch(url, { headers, ...options, headers: { ...headers, ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) exit(`${options.method || 'GET'} ${url} -> ${res.status}\n${JSON.stringify(body, null, 2)}`);
  return body;
}

// Claude Code reads these role variables to pick a model per task; every entry is an
// OpenRouter model slug. Point any of them at a non-Anthropic model if you want, but
// Claude Code is built for Anthropic models and other ones can mishandle its tool calls.
function modelEnv() {
  const env = {};
  for (const role of ['FABLE', 'OPUS', 'SONNET', 'HAIKU']) {
    const slug = process.env[`${role}_MODEL`];
    if (slug) env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = slug;
  }
  return env;
}

async function create() {
  if (!OPENROUTER_KEY) exit('Set OPENROUTER_API_KEY in .env');
  const instance = await request(`${HOSTING_API}/v1/instances`, {
    method: 'POST',
    body: JSON.stringify({
      template: 'agent37-claude-code',
      name: 'claude-code-byo-model',
      env: {
        // The whole trick: Claude Code sends its normal Anthropic-shaped requests to
        // this base URL, and OpenRouter's Anthropic-compatible endpoint serves them.
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
        ...modelEnv(),
      },
    }),
  });
  console.log(`Created ${instance.id} (${instance.status})`);

  const agentUrl = `https://${instance.id}.agent37.app`;
  process.stdout.write('Waiting for Claude Code to come up');
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${agentUrl}/v1/health`, { headers }).catch(() => null);
    if (res && res.ok) {
      const health = await res.json();
      if (health.healthy) {
        console.log(`\nReady: ${agentUrl}`);
        console.log(`Try: node agent.js chat ${instance.id} "Which model are you? Answer in one line."`);
        return;
      }
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  exit('\nInstance is up but Claude Code never reported healthy. Check your OpenRouter key, then retry.');
}

async function chat(instanceId, message) {
  if (!instanceId || !message) exit('Usage: node agent.js chat <instanceId> "your message"');
  const turn = await request(`https://${instanceId}.agent37.app/v1/responses`, {
    method: 'POST',
    body: JSON.stringify({ input: message }),
  });
  if (turn.status !== 'completed') exit(`Turn ${turn.status}: ${JSON.stringify(turn.error || turn, null, 2)}`);
  console.log(turn.output_text);
  if (turn.usage?.cost_usd != null) console.log(`\n(model cost this turn: $${turn.usage.cost_usd} on your OpenRouter account)`);
}

async function destroy(instanceId) {
  if (!instanceId) exit('Usage: node agent.js delete <instanceId>');
  await request(`${HOSTING_API}/v1/instances/${instanceId}`, { method: 'DELETE' });
  console.log(`Deleted ${instanceId}. Billing stopped.`);
}

const [, , command, ...args] = process.argv;
const commands = { create, chat, delete: destroy };
if (!commands[command]) exit('Usage: node agent.js <create|chat|delete> ...');
commands[command](...args);
