// catalogs.js
// Loads the firm/people facts, the service catalog, and the library of approved emails.
// These are the raw materials every draft is built from. Kept as editable files on disk
// (not in the database) so the SA can open and hand-edit them, and so they travel in the
// export bundle for building v2.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

let dirs = null;

// The catalogs ship with the app (read-only template) but are copied into user-data on
// first run so the user's edits and the app's learned additions persist and export.
function init(userDataDir, appDir) {
  const userCatalogs = path.join(userDataDir, 'catalogs');
  const shippedCatalogs = path.join(appDir, 'catalogs');
  fs.mkdirSync(userCatalogs, { recursive: true });

  // Seed any missing catalog file from the shipped template.
  for (const name of ['firm-and-people.md', 'services.md']) {
    const dest = path.join(userCatalogs, name);
    if (!fs.existsSync(dest)) {
      const src = path.join(shippedCatalogs, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, dest);
      else fs.writeFileSync(dest, `# ${name}\n\n(empty)\n`, 'utf8');
    }
  }

  const approvedDir = path.join(userDataDir, 'approved-emails');
  fs.mkdirSync(approvedDir, { recursive: true });

  // The reply library is completely separate from the outreach library — reply exemplars
  // never mix with cold-outreach exemplars, and Claude draws from each independently (see
  // emailEngine.js's generateDraft vs generateReplyDraft).
  const replyDir = path.join(userDataDir, 'reply-emails');
  fs.mkdirSync(replyDir, { recursive: true });

  const linkedinDir = path.join(userDataDir, 'approved-linkedin');
  fs.mkdirSync(linkedinDir, { recursive: true });

  templatesPath = path.join(userDataDir, 'reply-templates.json');
  loadTemplates();

  dirs = { userCatalogs, approvedDir, replyDir, linkedinDir };
  return dirs;
}

let templatesPath;
let templateStore = { templates: [], nextId: 1 };
function loadTemplates() {
  const raw = store.readJSON(templatesPath); // throws on a corrupt/unreadable file
  if (!raw) return saveTemplates(); // genuinely no file yet: write the empty store
  templateStore = raw;
  templateStore.templates = templateStore.templates || [];
  templateStore.nextId = templateStore.nextId || store.nextIdFrom(templateStore.templates);
}
function saveTemplates() {
  store.writeJSON(templatesPath, templateStore);
}
const MAX_TEMPLATES = 300;

// Per voice library — email and LinkedIn each cap here independently, so a busy channel
// can never evict the other's history. A library is the voice reference for every draft,
// so it must reflect Marcos's CURRENT voice rather than averaging every voice he has ever
// had. 100 because list*() reads every file on every draft: at ~1.5KB a record, 200 would
// mean ~300KB and 200 file opens per generation, growing forever. The prompt uses 6
// exemplars ranked by service overlap and the catalog holds 13 services, so 100 still
// leaves 5-8 examples per service.
//
// This cap governs the VOICE LIBRARIES only. The services catalog, the firm-and-people
// facts and the prospect dossiers are never pruned — they grow until someone deletes
// them by hand, deliberately.
const MAX_LIBRARY_RECORDS = 100;

function readFirmFacts() {
  return safeRead(path.join(dirs.userCatalogs, 'firm-and-people.md'));
}

function readServices() {
  return safeRead(path.join(dirs.userCatalogs, 'services.md'));
}

// Atomic: a crash part-way through a save must not leave a truncated catalog behind,
// since these files are the raw material every draft is built from.
function writeFirmFacts(text) {
  store.writeText(path.join(dirs.userCatalogs, 'firm-and-people.md'), text);
}

function writeServices(text) {
  store.writeText(path.join(dirs.userCatalogs, 'services.md'), text);
}

// Library filenames were Date.now() plus the company name, so two approvals for the same
// company inside one millisecond — one user double-clicking Save, or two users approving
// at once — produced the same filename and the second silently overwrote the first. The
// random suffix makes each save its own file; ordering by the timestamp prefix still works.
function uniqueStamp() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// The approved-email library: each approved final email is saved as a small JSON file.
// These are the style reference the drafting prompt learns the voice from.
function listApprovedEmails() {
  const files = fs.readdirSync(dirs.approvedDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.approvedDir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function saveApprovedEmail(record, existingFile) {
  // record: { company_name, recipient, services, final_text, first_draft, saved_at }
  // existingFile (optional): overwrite this exemplar instead of creating a new one — used when
  // correcting a logged outreach's message so re-edits don't accumulate duplicate exemplars.
  // path.basename guards against traversal even though the value is app-supplied.
  let fname = null;
  if (existingFile) {
    const base = path.basename(String(existingFile));
    if (base.endsWith('.json')) fname = base;
  }
  if (!fname) {
    const safe = (record.company_name || 'unknown').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    fname = `${uniqueStamp()}_${safe}.json`;
  }
  store.writeJSON(path.join(dirs.approvedDir, fname), record);
  pruneLibrary(dirs.approvedDir);
  return fname;
}

// Keeps a voice library at MAX_LIBRARY_RECORDS by deleting its oldest exemplars once it
// grows past the cap. Takes the directory because BOTH libraries use it — email and
// LinkedIn cap independently at the same number, so neither one's volume can evict the
// other's history. Runs after every successful write, never before, so a failed write
// can't prune a library it didn't actually grow. A record with a missing or unparseable
// saved_at sorts as oldest (Date.parse(...) || 0) rather than crashing the sort.
function pruneLibrary(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length <= MAX_LIBRARY_RECORDS) return;
  const entries = files.map(f => {
    const full = path.join(dir, f);
    let savedAt = 0;
    try { savedAt = Date.parse(JSON.parse(fs.readFileSync(full, 'utf8')).saved_at) || 0; }
    catch { savedAt = 0; }
    return { file: full, savedAt };
  });
  entries.sort((a, b) => a.savedAt - b.savedAt);
  const excess = entries.length - MAX_LIBRARY_RECORDS;
  for (let i = 0; i < excess; i++) {
    // A file can disappear between this listing and the unlink (another save/prune racing,
    // an admin poking the directory). Skipping it is right: the alternative is the whole
    // save throwing and the just-written record disappearing along with it. See backup.js's
    // walk() for the same reasoning applied to its own directory read.
    try { fs.unlinkSync(entries[i].file); } catch {}
  }
}

// The LinkedIn voice library. Same mechanics as the approved-email library above and
// deliberately the same shape of code, but a separate directory: a LinkedIn message is
// shorter, has no subject and no signature block, so mixing the two would teach the
// drafting prompt a voice that is neither.
function listApprovedLinkedIn() {
  const files = fs.readdirSync(dirs.linkedinDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.linkedinDir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

// record: { company_name, recipient_name, recipient_title, recipient_role, services,
//           first_draft, final_text, saved_at }
// existingFile (optional): overwrite this exemplar instead of creating a new one, so
// correcting a logged message does not accumulate duplicates. path.basename guards
// against traversal even though the value is app-supplied.
function saveApprovedLinkedIn(record, existingFile) {
  let fname = null;
  if (existingFile) {
    const base = path.basename(String(existingFile));
    if (base.endsWith('.json')) fname = base;
  }
  if (!fname) {
    const safe = (record.company_name || 'unknown').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    fname = `${uniqueStamp()}_${safe}.json`;
  }
  store.writeJSON(path.join(dirs.linkedinDir, fname), record);
  pruneLibrary(dirs.linkedinDir);
  return fname;
}

// Read one exemplar by filename, or null. An edit to a logged message knows the new text
// but not who it went to, so the caller merges rather than overwriting: blanking the
// recipient and services would erase the identity the record exists to carry and zero the
// primary ranking signal.
function readApprovedLinkedIn(filename) {
  const base = path.basename(String(filename || ''));
  if (!base.endsWith('.json')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dirs.linkedinDir, base), 'utf8')); }
  catch { return null; }
}

// The reply library: same shape and save mechanics as the approved-email library above,
// in its own directory so replies never mix into the outreach exemplar pool.
function listReplyEmails() {
  const files = fs.readdirSync(dirs.replyDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dirs.replyDir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

// record: { company_name, recipient, recipient_name, final_text, saved_at }. Also extracts
// reusable sentence-level templates (see extractTemplates below) for the quick-select
// panel — done once here, at save time, rather than re-derived from the whole library on
// every panel open, so the panel stays fast.
function saveReplyEmail(record) {
  const safeName = (record.company_name || 'unknown').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  const fname = `${uniqueStamp()}_${safeName}.json`;
  store.writeJSON(path.join(dirs.replyDir, fname), record);
  addTemplatesFromText(record.final_text || '', record.company_name || '', record.recipient_name || '');
  return fname;
}

// Splits approved reply text into standalone sentences, replaces any occurrence of this
// prospect's company name or the recipient's known first name with [company]/[name], and
// stores each generalized sentence (deduped by exact text) for the quick-select panel.
// A placeholder that can't be matched is simply not substituted — left as plain historical
// text rather than guessed, which the panel then can't misfill.
function addTemplatesFromText(text, companyName, recipientName) {
  const sentences = text.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(s => s.length >= 20 && s.length <= 220);
  for (const s of sentences) {
    let t = s;
    if (companyName) t = t.split(companyName).join('[company]');
    if (recipientName) t = t.split(recipientName).join('[name]');
    if (templateStore.templates.some(x => x.text === t)) continue;
    templateStore.templates.push({ id: templateStore.nextId++, text: t, savedAt: new Date().toISOString() });
  }
  if (templateStore.templates.length > MAX_TEMPLATES) templateStore.templates = templateStore.templates.slice(-MAX_TEMPLATES);
  saveTemplates();
}

function listReplyTemplates() {
  return templateStore.templates.slice().reverse(); // most recently learned first
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

module.exports = {
  init, readFirmFacts, readServices, writeFirmFacts, writeServices,
  listApprovedEmails, saveApprovedEmail, listApprovedLinkedIn, saveApprovedLinkedIn, readApprovedLinkedIn,
  listReplyEmails, saveReplyEmail, listReplyTemplates,
  MAX_LIBRARY_RECORDS,
  dirs: () => dirs
};
