// backup.js — builds the backup zip shared by the manual download endpoint and the
// scheduled-email sender (see server.js). Walks the whole data/ directory, redacts the
// two secrets that must never travel in a file (the Anthropic API key and the Google
// OAuth Client Secret — both inside config.json), and excludes the session-signing
// secret entirely (not named in the brief, but if it leaked, someone could forge a valid
// login session for any account with no password at all — a categorically worse risk
// than the password hashes in users.json, which still require cracking). Everything else
// under data/ is included so a restore is actually complete (accounts, Gmail connection,
// prospects, catalogs, approved emails, audit history).

const fs = require('fs');
const path = require('path');
const zip = require('./zip');

// gmail-token.json holds the live OAuth refresh and access tokens for the connected
// mailbox. An access token is immediately usable to read and send mail as that account,
// so it must never travel in an emailed attachment. Excluded outright rather than
// redacted: a restore simply re-runs the one-click OAuth connect in Settings.
const EXCLUDED_FILENAMES = new Set(['.session-secret', 'gmail-token.json']);

function walk(dir, baseDir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue; // transient atomic-write artifact, shouldn't exist at rest
    const full = path.join(dir, name);
    let stat;
    // A file can disappear between the readdir and the stat — an admin disconnecting
    // Gmail, a .tmp being renamed into place, a dossier being consumed. Skipping it is
    // right: the alternative is the whole backup throwing ENOENT and no backup at all.
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) { walk(full, baseDir, out); continue; }
    if (EXCLUDED_FILENAMES.has(name)) continue;
    out.push(path.relative(baseDir, full).split(path.sep).join('/'));
  }
  return out;
}

function redactConfig(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return rawText; }
  if ('anthropicApiKey' in parsed) parsed.anthropicApiKey = '';
  if ('googleClientSecret' in parsed) parsed.googleClientSecret = '';
  // The client ID is not a secret on its own, but it is half of a credential pair and has
  // no restore value once the secret is gone — both are re-entered together in Settings.
  if ('googleClientId' in parsed) parsed.googleClientId = '';
  return JSON.stringify(parsed, null, 2);
}

// users.json ships so a restore keeps everyone's accounts and passwords. What must not
// ship is anything that grants access *without* a password: a live invite token is, in
// this code's own words, on the same trust boundary as a password, and testLoginSlug (from
// the removed test-login backdoor) was a permanent admin session in a single URL. Password
// hashes stay — they are scrypt with a per-user salt, and dropping them would turn every
// restore into a full password reset for the whole team.
function redactUsers(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return rawText; }
  const users = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.users) ? parsed.users : null;
  if (!users) return rawText;
  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    if ('inviteToken' in u) u.inviteToken = '';
    if ('testLoginSlug' in u) delete u.testLoginSlug;
    // Password-reset tokens are live credentials for their whole validity window: a backup
    // taken minutes after someone clicks "forgot password" would otherwise carry a working
    // reset link for that account out to the emailed zip.
    if ('resetToken' in u) u.resetToken = '';
    if ('resetExpiresAt' in u) u.resetExpiresAt = '';
  }
  return JSON.stringify(parsed, null, 2);
}

const REDACTORS = { 'config.json': redactConfig, 'users.json': redactUsers };

function backupFilename(now) {
  now = now || new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `govspring-backup-${stamp}.zip`;
}

// Returns { buffer, filename, skipped } — skipped lists files that vanished mid-walk.
function buildBackupZip(dataDir, now) {
  const relPaths = walk(dataDir, dataDir, []);
  const entries = [];
  const skipped = [];
  for (const rel of relPaths) {
    const full = path.join(dataDir, ...rel.split('/'));
    const redact = REDACTORS[rel];
    try {
      entries.push(redact
        ? { name: rel, data: redact(fs.readFileSync(full, 'utf8')) }
        : { name: rel, data: fs.readFileSync(full) });
    } catch (e) {
      // Same race as in walk(): read what is still there rather than losing the backup.
      if (e.code === 'ENOENT') { skipped.push(rel); continue; }
      throw e;
    }
  }
  return { buffer: zip.createZip(entries, now), filename: backupFilename(now), skipped };
}

module.exports = { buildBackupZip, backupFilename };
