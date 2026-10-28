import { mintToken } from './token.js';

const userId = process.argv[2];
if (!/^[A-Za-z0-9_-]+$/.test(userId || '')) {
  console.error('usage: npm run create-agent -- <userId>   (letters, digits, - and _)');
  process.exit(1);
}

const res = await fetch('https://api.agent37.com/v1/instances', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.AGENT37_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    template: 'agent37-hermes',
    metadata: { user: userId },
    env: { BROWSER_CDP_URL: `${process.env.PUBLIC_URL}/browser/${mintToken(userId)}` },
    budget: { monthly_cap_micros: 2_000_000 },
  }),
});
const instance = await res.json();
if (!res.ok) {
  console.error(instance);
  process.exit(1);
}
console.log(`${instance.id} ${instance.url}`);
