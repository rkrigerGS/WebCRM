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

const EXCLUDED_FILENAMES = new Set(['.session-secret']);

function walk(dir, baseDir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue; // transient atomic-write artifact, shouldn't exist at rest
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
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
  return JSON.stringify(parsed, null, 2);
}

function backupFilename(now) {
  now = now || new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `govspring-backup-${stamp}.zip`;
}

// Returns { buffer, filename }.
function buildBackupZip(dataDir, now) {
  const relPaths = walk(dataDir, dataDir, []);
  const entries = relPaths.map(rel => {
    const full = path.join(dataDir, ...rel.split('/'));
    if (rel === 'config.json') {
      return { name: rel, data: redactConfig(fs.readFileSync(full, 'utf8')) };
    }
    return { name: rel, data: fs.readFileSync(full) };
  });
  return { buffer: zip.createZip(entries, now), filename: backupFilename(now) };
}

module.exports = { buildBackupZip, backupFilename };
