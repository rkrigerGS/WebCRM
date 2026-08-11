// db.js — a small, dependency-free JSON-file database.
// Replaces better-sqlite3 so nothing needs compiling: this runs identically on any
// machine with Node, which is what makes the app trivial to host on the SA's Windows box.
//
// All data lives in one JSON file (data/govspring.json). For this app's scale (a few
// thousand prospects, one user) that is simple and fast. Writes are atomic (write to a
// temp file, then rename) so a crash mid-write can never corrupt the store.

const fs = require('fs');
const path = require('path');

let dbPath;
let store = { prospects: [], exclusions: [], nextId: 1, ingest_log: [] };

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'govspring.json');
  load();
  return dbPath;
}

function load() {
  try {
    store = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Ensure all expected top-level keys exist (forward-compatible with older files).
    store.prospects = store.prospects || [];
    store.exclusions = store.exclusions || [];
    store.ingest_log = store.ingest_log || [];
    store.nextId = store.nextId || (store.prospects.reduce((m, p) => Math.max(m, p.id), 0) + 1);
  } catch {
    save(); // no file yet: write the empty store
  }
}

// Atomic save: write to a temp file then rename over the real one.
function save() {
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}

// ---- Prospect shape ----
// Each prospect record. Mirrors the old SQLite columns so the rest of the app is unchanged.
function blankProspect() {
  return {
    id: null, uei: null, company_name: '', city_state: '', industry: '',
    fit_score: null, designations: '', dossier_json: '',
    status: 'new', channel: '', first_draft: '', final_sent: '',
    date_sent: '', followup_count: 0, followup_days: 4, next_action_date: '',
    newsletter: 0, activity: '[]',
    // Gmail threading: the thread id Gmail assigned on the first send, and the RFC
    // "Message-ID" header value(s) sent so far in that thread (JSON array, oldest
    // first) — used to build In-Reply-To/References on the next follow-up so it lands
    // as a reply rather than a new message. Empty until the prospect's first Gmail send.
    gmail_thread_id: '', gmail_message_ids: '[]',
    // Captured automatically the moment a prospect transitions into 'dead' (see
    // updateProspect below) so the backup feature's dead-pile review can restore it.
    pre_dead_status: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

// ---- Ingestion ----

function isExcluded(dossier) {
  const uei = dossier.uei || '';
  const name = (dossier.company_name || '').toUpperCase();
  for (const r of store.exclusions) {
    if (r.match_type === 'uei' && uei && r.value === uei) return r.value;
    if (r.match_type === 'name_contains' && name.includes((r.value || '').toUpperCase())) return r.value;
  }
  return null;
}

function ingestDossier(dossier, filename) {
  const uei = dossier.uei || null;

  if (uei && store.prospects.some(p => p.uei === uei)) {
    logIngest(filename, uei, 'duplicate', 'UEI already in CRM');
    return { outcome: 'duplicate', uei };
  }
  const excludedBy = isExcluded(dossier);
  if (excludedBy) {
    logIngest(filename, uei, 'excluded', `matched exclusion: ${excludedBy}`);
    return { outcome: 'excluded', uei };
  }

  const score = dossier.fit_score && typeof dossier.fit_score.score !== 'undefined'
    ? parseInt(dossier.fit_score.score, 10) : null;

  const p = blankProspect();
  p.id = store.nextId++;
  p.uei = uei;
  p.company_name = dossier.company_name || '(unnamed)';
  p.city_state = dossier.city_state || '';
  p.industry = dossier.industry || '';
  p.fit_score = Number.isNaN(score) ? null : score;
  p.designations = dossier.designations || '';
  p.dossier_json = JSON.stringify(dossier);
  store.prospects.push(p);
  save();
  logIngest(filename, uei, 'ingested', null);
  return { outcome: 'ingested', uei, id: p.id };
}

function logIngest(filename, uei, outcome, detail) {
  store.ingest_log.push({ filename: filename || '', uei: uei || '', outcome, detail: detail || '', at: new Date().toISOString() });
  if (store.ingest_log.length > 1000) store.ingest_log = store.ingest_log.slice(-1000);
}

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
  store.prospects = store.prospects.filter(p => p.id !== id);
  save();
  return { deleted: true };
}

function updateProspect(id, fields) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { updated: false };
  // Capture the status a prospect had right before being marked dead, on the actual
  // new->dead transition only (not on repeated writes while already dead), so a dead-pile
  // review can restore it correctly.
  if (fields.status === 'dead' && p.status !== 'dead') p.pre_dead_status = p.status;
  const allowed = ['status', 'channel', 'first_draft', 'final_sent', 'date_sent',
    'followup_count', 'followup_days', 'next_action_date', 'newsletter', 'activity',
    'gmail_thread_id', 'gmail_message_ids', 'pre_dead_status'];
  for (const k of allowed) if (k in fields) p[k] = fields[k];
  p.updated_at = new Date().toISOString();
  save();
  return { updated: true };
}

function addNote(id, text) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const log = safeParse(p.activity, []);
  log.push({ date: new Date().toISOString().slice(0, 10), text });
  p.activity = JSON.stringify(log);
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true };
}

function logExternal(id, { channel, text }) {
  const p = store.prospects.find(x => x.id === id);
  if (!p) return { ok: false };
  const log = safeParse(p.activity, []);
  const today = new Date().toISOString().slice(0, 10);
  log.push({ date: today, text: `Outreach via ${channel}: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` });
  p.activity = JSON.stringify(log);
  p.status = 'sent';
  p.channel = channel;
  p.date_sent = today;
  if (channel === 'email' && !p.final_sent) p.final_sent = text;
  p.updated_at = new Date().toISOString();
  save();
  return { ok: true, channel };
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
  updateProspect, addNote, logExternal, editContact, checkExclusion, stats
};
