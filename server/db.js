// db.js — a small, dependency-free JSON-file database.
// Replaces better-sqlite3 so nothing needs compiling: this runs identically on any
// machine with Node, which is what makes the app trivial to host on the SA's Windows box.
//
// All data lives in one JSON file (data/govspring.json). For this app's scale (a few
// thousand prospects, one user) that is simple and fast. Writes are atomic (write to a
// temp file, then rename) so a crash mid-write can never corrupt the store.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store_ = require('./store');

let dbPath;
let store = { prospects: [], exclusions: [], nextId: 1 };

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'govspring.json');
  load();
  return dbPath;
}

function load() {
  const raw = store_.readJSON(dbPath); // throws on a corrupt/unreadable file
  if (!raw) return save(); // genuinely no file yet: write the empty store
  store = raw;
  // Ensure all expected top-level keys exist (forward-compatible with older files).
  store.prospects = store.prospects || [];
  store.exclusions = store.exclusions || [];
  // Never trust a stored nextId that lags behind the records (a hand-edited or restored
  // file): a low counter would hand out an id that already exists, and every lookup/update
  // on the duplicated id would hit whichever record happens to sit first in the array.
  store.nextId = Math.max(Number(store.nextId) || 1, store_.nextIdFrom(store.prospects));
}

function save() {
  store_.writeJSON(dbPath, store);
}

// Required lazily, inside the function, so db.js and config.js don't have to agree on
// init() order at require time.
function defaultFollowupDays() {
  const n = Number(require('./config').get().defaultFollowupDays);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

// ---- Prospect shape ----
// Each prospect record. Mirrors the old SQLite columns so the rest of the app is unchanged.
function blankProspect() {
  return {
    id: null, uei: null, company_name: '', city_state: '', industry: '',
    fit_score: null, designations: '', dossier_json: '',
    status: 'new', channel: '', first_draft: '', final_sent: '',
    // Honours the Settings value at ingest time; 4 only if config is unreadable or unset.
    date_sent: '', followup_count: 0, followup_days: defaultFollowupDays(), next_action_date: '',
    newsletter: 0, activity: '[]',
    // Gmail threading: the thread id Gmail assigned on the first send, and the RFC
    // "Message-ID" header value(s) sent so far in that thread (JSON array, oldest
    // first) — used to build In-Reply-To/References on the next follow-up so it lands
    // as a reply rather than a new message. Empty until the prospect's first Gmail send.
    gmail_thread_id: '', gmail_message_ids: '[]',
    // Captured automatically the moment a prospect transitions into 'dead' (see
    // updateProspect below) so the backup feature's dead-pile review can restore it.
    pre_dead_status: '',
    // Reply lifecycle (see server.js's reply-poll interval and /api/prospects/:id/reply/*).
    // awaiting_reply_review is the Replies-tab flag: true whenever a reply has arrived
    // that hasn't been acted on yet. last_reply_message_id is the dedup watermark that
    // tells the poll which inbound messages it has already surfaced.
    awaiting_reply_review: false,
    last_reply_at: '', last_reply_from: '', last_reply_snippet: '', last_reply_message_id: '',
    // Dormant status (admin-only, set only from the reply screen — see server.js).
    // pre_dormant_status mirrors pre_dead_status: captured on the way in so a return (or an
    // undo) can restore the exact prior status. dormant_returned is the "returned from
    // dormant" tag shown in the Due for follow-up view; it clears on the next status change
    // or send.
    dormant_until: '', dormant_returned: false, pre_dormant_status: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

// ---- Ingestion ----

// Returns the whole matched rule ({match_type, value}), not just its value, so the send-
// layer block (see server.js's blockIfExcluded) can tell the user precisely which rule
// matched and let an admin remove that exact rule.
function isExcluded(dossier) {
  const uei = str(dossier.uei);
  const name = str(dossier.company_name).toUpperCase();
  for (const r of store.exclusions) {
    if (!r.value) continue; // an empty name_contains rule would match every company
    if (r.match_type === 'uei' && uei && r.value === uei) return r;
    if (r.match_type === 'name_contains' && name.includes(String(r.value).toUpperCase())) return r;
  }
  return null;
}

// Topline fields are copied straight out of externally-authored dossier JSON, and several
// downstream paths call .localeCompare/.toUpperCase/.includes on them — one dossier with
// `"company_name": {…}` would make listProspects() throw on every call from then on. A
// string passes through as-is, a finite number is stringified, anything else becomes ''.
function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function ingestDossier(dossier, filename) {
  const uei = str(dossier.uei) || null;

  if (uei && store.prospects.some(p => p.uei === uei)) {
    return { outcome: 'duplicate', uei };
  }
  // Dossiers without a UEI have no natural dedup key, so the same file re-ingested (e.g.
  // the watcher re-scanning the folder on every restart) piled up as a new prospect each
  // time. Hash the dossier content instead and skip exact re-imports.
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(dossier)).digest('hex');
  if (!uei && store.prospects.some(p => !p.uei && p.content_hash === contentHash)) {
    return { outcome: 'duplicate', uei };
  }
  const excludedBy = isExcluded(dossier);
  if (excludedBy) {
    return { outcome: 'excluded', uei };
  }

  const score = dossier.fit_score && typeof dossier.fit_score.score !== 'undefined'
    ? parseInt(dossier.fit_score.score, 10) : null;

  const p = blankProspect();
  p.id = store.nextId++;
  p.uei = uei;
  p.company_name = str(dossier.company_name) || '(unnamed)';
  p.city_state = str(dossier.city_state);
  p.industry = str(dossier.industry);
  p.fit_score = Number.isNaN(score) ? null : score;
  p.designations = str(dossier.designations);
  p.dossier_json = JSON.stringify(dossier);
  p.content_hash = contentHash;
  store.prospects.push(p);
  save();
  return { outcome: 'ingested', uei, id: p.id };
}

// REMOVED: logIngest() and the store.ingest_log array it appended to.
// Nothing ever read it — no route, no view, no report — and it grew inside the same
// govspring.json that holds every prospect, so each ingest made every subsequent save of
// the whole database larger for no benefit. Every ingest is already recorded in the audit
// log (see audit.js), which is where a human actually looks. An existing ingest_log key in
// govspring.json is left untouched on disk: load() no longer normalizes it, but it also
// never deletes it, so nothing already stored is lost.

// ---- Reads ----

function listProspects() {
  // Return topline fields plus the parsed dossier (the web UI needs the dossier for
  // filtering by agency and for the follow-up logic). Sorted by fit score ascending.
  return store.prospects
    .map(p => ({
      id: p.id, uei: p.uei, company_name: p.company_name, city_state: p.city_state,
      industry: p.industry, fit_score: p.fit_score, designations: p.designations,
      status: p.status, channel: p.channel, followup_count: p.followup_count,
      followup_days: p.followup_days, next_action_date: p.next_action_date,
      date_sent: p.date_sent, final_sent: p.final_sent, activity: p.activity,
      pre_dead_status: p.pre_dead_status,
      awaiting_reply_review: p.awaiting_reply_review, last_reply_at: p.last_reply_at,
      last_reply_from: p.last_reply_from, last_reply_snippet: p.last_reply_snippet,
      // The reply poller dedupes on this: without it in the projection, the reply screen
      // can't tell an already-reviewed message from a new one.
      last_reply_message_id: p.last_reply_message_id,
      dormant_until: p.dormant_until, dormant_returned: p.dormant_returned,
      gmail_thread_id: p.gmail_thread_id, gmail_message_ids: p.gmail_message_ids,
      created_at: p.created_at,
      dossier: safeParse(p.dossier_json, {})
    }))
    .sort((a, b) => ((a.fit_score == null) - (b.fit_score == null))
      || ((a.fit_score ?? 99) - (b.fit_score ?? 99))
      || (a.company_name || '').localeCompare(b.company_name || ''));
}

function getProspect(id) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return null;
  return { ...p, dossier: safeParse(p.dossier_json, {}) };
}

function deleteProspect(id) {
  const before = store.prospects.length;
  store.prospects = store.prospects.filter(p => p.id !== id);
  if (store.prospects.length === before) return { deleted: false }; // nothing matched; no ghost success
  save();
  return { deleted: true };
}

// opts.internal marks a call made by server code itself (the Gmail send paths), as opposed
// to one relaying a request body. Gmail threading state and the read-modify-write ops are
// only honored on internal calls: they are bookkeeping the send path maintains, and letting
// a PATCH body set gmail_thread_id/gmail_message_ids would let any user silently detach a
// prospect from its real thread (breaking reply polling) or point it at another one.
function updateProspect(id, fields, opts = {}) {
  const internal = !!opts.internal;
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { updated: false };
  // Capture the status a prospect had right before being marked dead, on the actual
  // new->dead transition only (not on repeated writes while already dead), so a dead-pile
  // review can restore it correctly.
  if (fields.status === 'dead' && p.status !== 'dead') p.pre_dead_status = p.status;
  // Any deliberate status change (from anywhere — the main detail pane, bulk actions, or
  // the reply screen's quick-action buttons) acknowledges whatever attention flags were
  // pending: a reviewed reply, or a stale dormant-return tag / dormant window that no
  // longer applies once the status has moved on.
  if ('status' in fields && fields.status !== p.status) {
    p.awaiting_reply_review = false;
    if (fields.status !== 'dormant') {
      p.dormant_returned = false;
      p.dormant_until = '';
    }
  }
  // pre_dead_status is deliberately NOT writable from here: it is bookkeeping this
  // function maintains itself (above), and letting a request body set it would let a
  // client rewrite where the dead-pile review restores a prospect to.
  // A standalone status change (from the detail dropdown or bulk actions) is logged as its
  // own activity entry so the prospect's log reflects it. Status changes that are part of a
  // larger logged action — a send, or logExternal — pass internal:true (send) or don't route
  // through here at all (logExternal), so the outreach entry represents the change and there
  // is no duplicate "Status →" line. Captured before the field copy overwrites p.status.
  const logStatusChange = ('status' in fields && fields.status !== p.status && !internal);
  const newStatus = fields.status;

  // `activity` is deliberately NOT writable from a plain request: it is the prospect's
  // permanent log, it is appended to through addNote/logExternal/appendActivity, and a
  // whole-field overwrite would erase every note and outreach record irrecoverably.
  const allowed = ['status', 'channel', 'first_draft', 'final_sent', 'date_sent',
    'followup_count', 'followup_days', 'next_action_date', 'newsletter'];
  if (internal) allowed.push('gmail_thread_id', 'gmail_message_ids', 'activity');
  // The numeric fields are rendered straight into the detail pane (one of them inside an HTML
  // attribute), so a string here becomes stored XSS. Coerced to integers at the boundary —
  // the client is not the only caller, so this cannot live in the route alone.
  const NUMERIC = { followup_count: { min: 0, max: 9999 }, followup_days: { min: 1, max: 365 }, newsletter: { min: 0, max: 1 } };
  for (const k of allowed) {
    if (!(k in fields)) continue;
    const bounds = NUMERIC[k];
    if (bounds) {
      const n = Math.trunc(Number(fields[k]));
      if (!Number.isFinite(n)) continue; // ignore junk rather than storing it
      p[k] = Math.min(bounds.max, Math.max(bounds.min, n));
    } else {
      p[k] = fields[k];
    }
  }

  if (logStatusChange) {
    appendActivity(p, {
      id: crypto.randomBytes(8).toString('hex'), date: store_.todayNY(),
      kind: 'status', status: newStatus, text: `Status changed to ${newStatus}`
    });
  }

  // Read-modify-write operations, applied here against the live record rather than from a
  // snapshot the caller read earlier. The email send path reads the prospect, awaits the
  // Gmail API for several seconds, then writes — long enough for a second send to land in
  // between, and a caller-computed `followup_count: n + 1` or a rebuilt message-id array
  // would then silently discard the other one's increment.
  if (internal && fields.incFollowupCount) p.followup_count = (Number(p.followup_count) || 0) + 1;
  if (internal && fields.appendMessageId) {
    const parsed = safeParse(p.gmail_message_ids, []);
    const ids = Array.isArray(parsed) ? parsed : []; // a corrupt/non-array field is rebuilt, not thrown on
    if (!ids.includes(fields.appendMessageId)) ids.push(fields.appendMessageId);
    p.gmail_message_ids = JSON.stringify(ids);
  }

  p.updated_at = new Date().toISOString();
  save();
  return { updated: true };
}

// kind is optional and purely presentational (the reply-review screen's history timeline
// uses it to distinguish sent-email/status entries from plain notes) — entries written
// before this existed simply have no kind, and render exactly as they always have.
// Notes are stored inside the prospect record itself, so both are bounded: one pasted
// email chain as a "note", or years of activity, would otherwise grow every save of the
// whole database. 2000 chars keeps any real note intact; 500 entries is years of activity.
const NOTE_MAX_CHARS = 2000;
const ACTIVITY_MAX_ENTRIES = 500;

function appendActivity(p, entry) {
  const parsed = safeParse(p.activity, []);
  const log = Array.isArray(parsed) ? parsed : [];
  log.push(entry);
  if (log.length > ACTIVITY_MAX_ENTRIES) log.splice(0, log.length - ACTIVITY_MAX_ENTRIES);
  p.activity = JSON.stringify(log);
}

function addNote(id, text, kind) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const clean = String(text || '').slice(0, NOTE_MAX_CHARS);
  const entry = { date: store_.todayNY(), text: clean };
  if (kind) entry.kind = kind;
  appendActivity(p, entry);
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

// Called by the reply-poll interval in server.js when a new inbound message is found on a
// tracked thread. Does not touch status — dormant stays dormant, sent stays sent — so the
// reviewer decides the next status from the reply screen.
function recordReply(id, { messageId, from, snippet, at }) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  p.awaiting_reply_review = true;
  p.last_reply_message_id = messageId || '';
  p.last_reply_from = from || '';
  p.last_reply_snippet = snippet || '';
  p.last_reply_at = at || new Date().toISOString();
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

// Admin-only, set only from the reply screen (see server.js). Captures pre_dormant_status
// the same way marking dead captures pre_dead_status, so an undo or a manual restore has
// somewhere correct to go back to.
function setDormant(id, until) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  p.pre_dormant_status = p.status;
  p.status = 'dormant';
  p.dormant_until = until;
  p.dormant_returned = false;
  p.awaiting_reply_review = false;
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

// Called by server.js's dormant-return interval for every dormant prospect whose
// dormant_until has passed. Returns to whatever status it held before going dormant
// (captured by setDormant), falling back to 'sent' — which is what the Due for follow-up
// view requires to surface it — tagged dormant_returned until the next status change.
function returnFromDormant(id) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  p.status = p.pre_dormant_status && p.pre_dormant_status !== 'dormant' ? p.pre_dormant_status : 'sent';
  p.dormant_until = '';
  p.dormant_returned = true;
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

// Every prospect currently dormant whose return date has passed — used by server.js's
// interval check so it doesn't need to know db.js's internal store shape.
function listDormantDue(today) {
  return store.prospects.filter(p => p.status === 'dormant' && p.dormant_until && p.dormant_until <= today).map(p => p.id);
}

function logExternal(id, { channel, text, loggedAt }) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  // Use provided date or default to today (NY timezone). loggedAt should be ISO YYYY-MM-DD.
  // This field records outreach that already happened, so a future date (past the client's
  // max=today cap, i.e. a hand-crafted request) is ignored rather than stored — otherwise it
  // would push the follow-up clock out past the real send.
  const today = store_.todayNY();
  const date = (loggedAt && /^\d{4}-\d{2}-\d{2}$/.test(loggedAt) && loggedAt <= today) ? loggedAt : today;
  // id + channel + message are stored on the entry (not just the truncated display `text`)
  // so the outreach can be reopened and its full message edited later — see editOutreachEntry.
  appendActivity(p, {
    id: crypto.randomBytes(8).toString('hex'), date, channel, message: text,
    text: `Outreach via ${channel}: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`
  });
  p.status = 'sent';
  p.channel = channel;
  p.date_sent = date;
  // Logging fresh outreach is a deliberate status change, so it acknowledges the same
  // attention flags updateProspect() clears — otherwise a prospect stays flagged as
  // awaiting reply review, or keeps a stale dormant tag, after being contacted again.
  p.awaiting_reply_review = false;
  p.dormant_returned = false;
  p.dormant_until = '';
  if (channel === 'email' && !p.final_sent) p.final_sent = text;
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true, channel };
}

// Add or correct the full message on a previously-logged outreach entry. `entryId` is either
// the entry's stored id, or "idx:N" (its index in the activity array) for legacy entries that
// predate ids — those get a real id assigned here so later edits are stable. Returns the
// entry's channel/message/exemplar_file so the caller (server.js) can handle voice-library
// learning, which lives with the catalog layer, not here.
function editOutreachEntry(id, entryId, { text }) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const log = safeParse(p.activity, []);
  if (!Array.isArray(log)) return { ok: false };
  let entry = null;
  if (String(entryId).startsWith('idx:')) {
    entry = log[parseInt(String(entryId).slice(4), 10)] || null;
  } else {
    entry = log.find(e => e && e.id === entryId) || null;
  }
  if (!entry) return { ok: false, notFound: true };
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, empty: true };
  // Channel: prefer the stored field, else recover it from the legacy "Outreach via X:" text.
  const m = String(entry.text || '').match(/^Outreach via (\w+):/);
  const channel = entry.channel || (m && m[1]) || 'email';
  if (!entry.id) entry.id = crypto.randomBytes(8).toString('hex');
  entry.channel = channel;
  entry.message = clean;
  entry.text = `Outreach via ${channel}: ${clean.slice(0, 200)}${clean.length > 200 ? '…' : ''}`;
  // For email, final_sent mirrors the latest sent body — it's what the "Sent email" panel
  // shows and what a follow-up draft builds on, so a corrected message should replace it.
  if (channel === 'email') p.final_sent = clean;
  p.activity = JSON.stringify(log);
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true, entry: { id: entry.id, channel, message: clean, exemplar_file: entry.exemplar_file || '' } };
}

// Records which voice-library file an outreach entry produced, so re-editing that entry
// overwrites the same exemplar instead of piling up duplicates that would skew the voice.
function recordEntryExemplar(id, entryId, filename) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const log = safeParse(p.activity, []);
  if (!Array.isArray(log)) return { ok: false };
  const entry = log.find(e => e && e.id === entryId);
  if (!entry) return { ok: false };
  entry.exemplar_file = filename || '';
  p.activity = JSON.stringify(log);
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

function editContact(id, patch) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const dossier = safeParse(p.dossier_json, {});
  dossier.contact_general = { ...(dossier.contact_general || {}), ...patch };
  p.dossier_json = JSON.stringify(dossier);
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

// Do-not-contact check for an existing prospect (used before sending email — see
// server.js). Reuses the same exclusions logic ingestDossier() already applies at
// ingest time; a prospect's own uei/company_name are in the same shape isExcluded()
// expects. Returns the matched exclusion value, or null if the prospect isn't excluded
// (including if the prospect id doesn't exist, since there's nothing to block then).
function checkExclusion(id) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return null;
  return isExcluded(p);
}

function listExclusions() {
  return store.exclusions.slice();
}

// Used by the admin "remove and send" action from a blocked-send screen (see server.js).
// Matches by content (match_type + value), not an id — existing exclusion entries have
// none, and the caller always already knows exactly which rule matched.
function removeExclusion(match_type, value) {
  const before = store.exclusions.length;
  store.exclusions = store.exclusions.filter(r => !(r.match_type === match_type && r.value === value));
  save();
  return { removed: before !== store.exclusions.length };
}

function stats() {
  const c = { total: 0, new: 0, sent: 0, replied: 0, signed: 0 };
  for (const p of store.prospects) {
    c.total++;
    if (p.status === 'new') c.new++;
    if (p.status === 'sent') c.sent++;
    if (p.status === 'replied') c.replied++;
    if (p.status === 'signed') c.signed++;
  }
  return c;
}

function safeParse(s, fallback) {
  try { return JSON.parse(s || ''); } catch { return fallback; }
}

module.exports = {
  init, ingestDossier, listProspects, getProspect, deleteProspect,
  updateProspect, addNote, logExternal, editOutreachEntry, recordEntryExemplar, editContact, checkExclusion, stats,
  recordReply, setDormant, returnFromDormant, listDormantDue,
  listExclusions, removeExclusion
};
