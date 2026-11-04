// Programs the server runs on an instance through POST /v1/instances/{id}/exec.
//
// Exec runs on the same box the agent works on, so these see the agent's files and the
// Neon CLI's local credentials. Each one is a fixed Node program sent base64-encoded; the
// only values that vary are passed as arguments (a validated slug, a base64 value), so
// nothing a user typed is ever spliced into a shell command. Each prints one JSON line.
//
// Every app lives in ~/apps/<slug> on the instance. `neon claim create` leaves a .neon
// file there that names the app's Neon project.

// The Neon CLI version these scripts and the agent's brief run. Pinned, because the
// server runs it unattended on every user's instance, with the instance's environment:
// a new release should reach your users only after you have tried it.
export const NEON_CLI = 'neon@8.18.0';

// Lists every app folder that has a Neon project, with its claim state.
//
// `neon claim status` asks Neon for the live state: unclaimed, pending (a claim code is
// out), expired (that code lapsed; the project is claimable again), accepted, then
// reconciled. Once a claim reconciles, the CLI deletes its local
// credential for the project, and status then fails with "identity assertion ... is
// missing". So the script saves what it last saw in .neon-claim.json and reads it back:
//   - credential gone after a claim was started  -> claimed
//   - any other failure (npm or Neon unreachable) -> the last state seen, marked stale,
//     or expired once the saved expiry has passed
export const LIST_APPS_SCRIPT = `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.join(process.env.HOME, 'apps');
function neon(args) {
  try {
    const out = execFileSync('npx', ['-y', '${NEON_CLI}', ...args, '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return { data: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: String(err.stdout || '') + String(err.stderr || '') + String(err.message || '') };
  }
}
const CLAIMING = ['pending', 'accepted', 'reconciled', 'claimed'];
const apps = [];
for (const slug of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
  const dir = path.join(root, slug);
  let link;
  try { link = JSON.parse(fs.readFileSync(path.join(dir, '.neon'), 'utf8')); } catch { continue; }
  const saved = path.join(dir, '.neon-claim.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(saved, 'utf8')); } catch {}

  let state;
  let expires = last.expires_at || null;
  let stale = false;
  const status = neon(['claim', 'status', link.projectId]);
  if (status.data) {
    state = status.data.state;
    expires = status.data.project_expires_at || expires;
    // Here "expired" means the claim code lapsed (claim_expires_at), not the database:
    // the project is claimable again until project_expires_at.
    if (state === 'expired') state = expires && Date.parse(expires) < Date.now() ? 'expired' : 'unclaimed';
  } else if (/identity assertion/i.test(status.error)) {
    state = CLAIMING.includes(last.state) ? 'claimed' : 'unknown';
  } else if (expires && Date.parse(expires) < Date.now() && !['accepted', 'reconciled', 'claimed'].includes(last.state)) {
    state = 'expired';
  } else {
    state = last.state || 'unknown';
    stale = true;
  }
  if (state === 'accepted' || state === 'reconciled') state = 'claimed';
  if (!stale) fs.writeFileSync(saved, JSON.stringify({ state, expires_at: expires }));
  const temporary = state === 'unclaimed' || state === 'pending';
  apps.push({ slug, project_id: link.projectId, state, stale, expires_at: temporary ? expires : null });
}
console.log(JSON.stringify(apps));
`;

// Mints a claim code for one app's project. The code is good for 15 minutes; minting a
// new one cancels the previous unused code, so a second click is harmless.
export const CLAIM_SCRIPT = `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const slug = process.argv[1];
const dir = path.join(process.env.HOME, 'apps', slug);
const link = JSON.parse(fs.readFileSync(path.join(dir, '.neon'), 'utf8'));
const out = execFileSync('npx', ['-y', '${NEON_CLI}', 'claim', 'accept', link.projectId, '--no-open', '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).toString();
const claim = JSON.parse(out.slice(out.indexOf('{')));
// Remembered, with the expiry, so the Apps panel can still tell "claimed" from
// "expired" after the CLI drops its credential.
const saved = path.join(dir, '.neon-claim.json');
let last = {};
try { last = JSON.parse(fs.readFileSync(saved, 'utf8')); } catch {}
fs.writeFileSync(saved, JSON.stringify({ ...last, state: 'pending' }));
console.log(JSON.stringify(claim));
`;

// Claiming revokes the temporary database password, and the user's own Neon account
// issues a new connection string. This writes it into the app's .env and reruns its
// start.sh, so the app comes back on the database the user now owns.
//
// start.sh loads .env with sh, so the value is checked again here and written inside
// single quotes, where sh expands nothing.
export const SET_DATABASE_URL_SCRIPT = `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const [slug, b64] = process.argv.slice(1);
const url = Buffer.from(b64, 'base64').toString();
if (!/^postgres(ql)?:\\/\\/[^"'\`$\\\\\\s]+$/.test(url)) throw new Error('refusing a connection string with shell characters');
const dir = path.join(process.env.HOME, 'apps', slug);
const envFile = path.join(dir, '.env');
const kept = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\\n') : [])
  .filter((line) => line && !/^DATABASE_URL(_UNPOOLED)?=/.test(line));
const lines = ["DATABASE_URL='" + url + "'", "DATABASE_URL_UNPOOLED='" + url.replace('-pooler.', '.') + "'", ...kept];
fs.writeFileSync(envFile, lines.join('\\n') + '\\n');
execFileSync('sh', [path.join(dir, 'start.sh')], { stdio: 'ignore', timeout: 60000 });
console.log(JSON.stringify({ ok: true }));
`;
