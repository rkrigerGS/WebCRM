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

  dirs = { userCatalogs, approvedDir };
  return dirs;
}

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

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

module.exports = {
  init, readFirmFacts, readServices, writeFirmFacts, writeServices,
  listApprovedEmails, saveApprovedEmail, dirs: () => dirs
};
