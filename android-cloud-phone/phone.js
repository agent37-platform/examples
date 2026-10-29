#!/usr/bin/env node
// A cloud Android phone your agent can drive, end to end: create it, wait for Android to
// boot, run adb, install an APK, grab a screenshot, open the live screen, delete it.
// Zero dependencies: Node 20+ has fetch.
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';

const API = process.env.AGENT37_API_URL || 'https://api.agent37.com';
// exec is answered by the machine the instance runs on, at this address.
const SANDBOX = 'https://sandbox.agent37.app';
const KEY = process.env.AGENT37_API_KEY;
const STATE = '.phone';

if (!KEY) die('Set AGENT37_API_KEY to an sk_live_ key from https://www.agent37.com/dashboard/cloud/api-keys');

function die(message) {
  console.error(message);
  process.exit(1);
}

async function api(method, path, body, origin = API) {
  const auth = origin === SANDBOX ? { 'X-Agent37-Key': KEY } : { Authorization: `Bearer ${KEY}` };
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...auth, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) die(`${method} ${path} -> ${res.status} ${json.error?.code || ''} ${json.error?.message || text}`);
  return json;
}

// The instance id is remembered in ./.phone so every other command can be typed bare.
function instanceId() {
  const id = process.env.PHONE_ID || (existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : '');
  return id || die('No instance yet. Run `node phone.js create` first.');
}

// Every command below is one exec call. The phone is reached through the instance, so
// nothing has to be exposed to the internet for an agent to drive it.
async function exec(command) {
  return api('POST', `/v1/instances/${instanceId()}/exec`, { command }, SANDBOX);
}

async function create() {
  // 4 vCPU / 8 GB is the smallest shape the emulator is comfortable on, and 20 GB of disk
  // leaves the phone's own storage room to grow. type: "vm" is required: the emulator needs
  // hardware virtualisation, which only a real kernel gives it.
  const instance = await api('POST', '/v1/instances', {
    template: 'agent37-android',
    type: 'vm',
    resources: { cpu: 4, memory: 8, disk: 20 },
  });
  writeFileSync(STATE, instance.id);
  console.log(`created ${instance.id} (${instance.status})`);
  console.log('Android is booting. `node phone.js wait` blocks until it has finished.');
}

async function wait() {
  // First boot also creates the AVD, so it takes longer than every boot after it.
  const r = await exec('android-wait 600');
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.exit_code);
}

async function adb(args) {
  if (!args.length) die('Usage: node phone.js adb <args...>   e.g. adb shell getprop ro.build.version.release');
  const r = await exec(`adb ${args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')}`);
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.exit_code);
}

async function install([source]) {
  if (!source) die('Usage: node phone.js install <apk-url>');
  const r = await exec(`curl -fsSL '${source}' -o /tmp/app.apk && adb install -r /tmp/app.apk`);
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.exit_code);
}

// android-shot is on the image: a scaled WebP frame, because a full-resolution PNG of a
// 1080x2400 phone does not fit in an exec response.
async function shot([file = 'screen.webp']) {
  const r = await exec('android-shot');
  if (r.exit_code !== 0) die(r.stderr || 'screencap failed');
  writeFileSync(file, Buffer.from(r.stdout.trim(), 'base64'));
  console.log(`wrote ${file}`);
}

// A signed URL carries its own auth in the query string, so this link opens the phone's
// screen in any browser tab. It expires; mint a new one whenever you need it.
async function screen() {
  const r = await api('POST', `/v1/instances/${instanceId()}/signed-url`, { port: 6901, ttl_seconds: 3600 });
  const url = new URL(r.url);
  url.pathname = '/vnc.html';
  url.searchParams.set('autoconnect', '1');
  url.searchParams.set('resize', 'scale');
  console.log(url.toString());
}

async function status() {
  const r = await api('GET', `/v1/instances/${instanceId()}`);
  console.log(JSON.stringify({ id: r.id, status: r.status, type: r.type, resources: r.resources, url: r.url }, null, 2));
}

async function destroy() {
  const id = instanceId();
  await api('DELETE', `/v1/instances/${id}`);
  writeFileSync(STATE, '');
  console.log(`deleted ${id}`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { create, wait, adb, install, shot, screen, status, delete: destroy };
if (!commands[command]) {
  console.log('Usage: node phone.js <create|wait|screen|status|adb|install|shot|delete>');
  process.exit(command ? 1 : 0);
}
await commands[command](args);
