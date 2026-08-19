// audit.js — the audit trail. Every route in server.js that creates, modifies, or deletes
// app data calls audit.log() through the mutating() helper (see server.js, the
// "AUDIT CONVENTION" comment above it) so this file is the single source of truth for who
// did what, to which prospect, and when. Visible to admins only (enforced in server.js).

const path = require('path');
const store_ = require('./store');

let logPath;
let store = { entries: [], nextId: 1 };
const MAX_ENTRIES = 50000; // oldest entries roll off past this, so the log can't grow without bound

function init(dataDir) {
  logPath = path.join(dataDir, 'audit-log.json');
  load();
}

function load() {
  const raw = store_.readJSON(logPath); // throws on a corrupt/unreadable file
  if (!raw) return save(); // genuinely no file yet: write the empty store
  store = raw;
  store.entries = store.entries || [];
  // Take the max so a stored counter that lags the records (hand-edited/restored file)
  // can never mint a duplicate entry id.
  store.nextId = Math.max(Number(store.nextId) || 1, store_.nextIdFrom(store.entries));
}

function save() {
  store_.writeJSON(logPath, store);
}

// userId is null for actions with no logged-in actor (e.g. the folder watcher).
function log({ userId, username, action, prospectId, detail }) {
  store.entries.push({
    id: store.nextId++,
    at: new Date().toISOString(),
    userId: userId ?? null,
    username: username || 'system',
    action,
    prospectId: prospectId ?? null,
    detail: detail || ''
  });
  if (store.entries.length > MAX_ENTRIES) store.entries = store.entries.slice(-MAX_ENTRIES);
  save();
}

// Filters: userId (exact match), action (exact match), since (ISO string — entries at or
// after this instant), prospectId (exact match — used by the backup dead-pile review to
// find who last marked a given prospect dead). Returns newest-first.
function list({ userId, action, since, prospectId } = {}) {
  let out = store.entries;
  if (userId != null && userId !== '') out = out.filter(e => String(e.userId) === String(userId));
  if (action) out = out.filter(e => e.action === action);
  if (since) out = out.filter(e => e.at >= since);
  if (prospectId != null && prospectId !== '') out = out.filter(e => String(e.prospectId) === String(prospectId));
  return out.slice().reverse();
}

function distinctActions() {
  return [...new Set(store.entries.map(e => e.action))].sort();
}

module.exports = { init, log, list, distinctActions };
