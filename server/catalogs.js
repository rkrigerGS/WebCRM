// catalogs.js
// Loads the firm/people facts, the service catalog, and the library of approved emails.
// These are the raw materials every draft is built from. Kept as editable files on disk
// (not in the database) so the SA can open and hand-edit them, and so they travel in the
// export bundle for building v2.

const fs = require('fs');
const path = require('path');

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

  templatesPath = path.join(userDataDir, 'reply-templates.json');
  loadTemplates();

  dirs = { userCatalogs, approvedDir, replyDir };
  return dirs;
}

let templatesPath;
let templateStore = { templates: [], nextId: 1 };
function loadTemplates() {
  try {
    templateStore = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    templateStore.templates = templateStore.templates || [];
    templateStore.nextId = templateStore.nextId || (templateStore.templates.reduce((m, t) => Math.max(m, t.id), 0) + 1);
  } catch {
    saveTemplates();
  }
}
function saveTemplates() {
  const tmp = templatesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(templateStore, null, 2), 'utf8');
  fs.renameSync(tmp, templatesPath);
}
const MAX_TEMPLATES = 300;

function readFirmFacts() {
  return safeRead(path.join(dirs.userCatalogs, 'firm-and-people.md'));
}

function readServices() {
  return safeRead(path.join(dirs.userCatalogs, 'services.md'));
}

function writeFirmFacts(text) {
  fs.writeFileSync(path.join(dirs.userCatalogs, 'firm-and-people.md'), text, 'utf8');
}

function writeServices(text) {
  fs.writeFileSync(path.join(dirs.userCatalogs, 'services.md'), text, 'utf8');
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

function saveApprovedEmail(record) {
  // record: { company_name, recipient, services, final_text, first_draft, saved_at }
  const safe = (record.company_name || 'unknown').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  const fname = `${Date.now()}_${safe}.json`;
  fs.writeFileSync(path.join(dirs.approvedDir, fname), JSON.stringify(record, null, 2), 'utf8');
  return fname;
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
  const fname = `${Date.now()}_${safeName}.json`;
  fs.writeFileSync(path.join(dirs.replyDir, fname), JSON.stringify(record, null, 2), 'utf8');
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
  listApprovedEmails, saveApprovedEmail, listReplyEmails, saveReplyEmail, listReplyTemplates,
  dirs: () => dirs
};
