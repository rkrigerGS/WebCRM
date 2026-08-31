const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogs = require('../server/catalogs');

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-'));
  catalogs.init(dir, path.join(__dirname, '..'));
  return dir;
}

const record = (over) => ({
  company_name: 'Nava PBC', recipient_name: 'Charles Carey',
  recipient_title: 'General Counsel', recipient_role: 'GC',
  services: ['Bid Protests'], first_draft: 'd', final_text: 'f',
  saved_at: '2026-08-27T00:00:00.000Z', ...over
});

test('init creates the approved-linkedin directory', () => {
  const dir = freshDir();
  assert.ok(fs.existsSync(path.join(dir, 'approved-linkedin')));
});

test('a saved record round-trips through the list', () => {
  freshDir();
  catalogs.saveApprovedLinkedIn(record());
  const all = catalogs.listApprovedLinkedIn();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].recipient_name, 'Charles Carey');
  assert.strictEqual(all[0].recipient_role, 'GC');
});

test('existingFile overwrites in place instead of adding a second record', () => {
  freshDir();
  const first = catalogs.saveApprovedLinkedIn(record({ final_text: 'v1' }));
  const second = catalogs.saveApprovedLinkedIn(record({ final_text: 'v2' }), first);
  assert.strictEqual(second, first, 'same filename');
  const all = catalogs.listApprovedLinkedIn();
  assert.strictEqual(all.length, 1, 're-editing must not duplicate the exemplar');
  assert.strictEqual(all[0].final_text, 'v2');
});

test('the LinkedIn library is separate from the email library', () => {
  freshDir();
  catalogs.saveApprovedLinkedIn(record());
  assert.strictEqual(catalogs.listApprovedEmails().length, 0,
    'a LinkedIn message must never land in the email voice library');
});

test('an empty library lists as empty rather than throwing', () => {
  freshDir();
  assert.deepStrictEqual(catalogs.listApprovedLinkedIn(), []);
});

test('readApprovedLinkedIn returns the record for a real filename', () => {
  freshDir();
  const fname = catalogs.saveApprovedLinkedIn(record());
  const got = catalogs.readApprovedLinkedIn(fname);
  assert.ok(got);
  assert.strictEqual(got.recipient_name, 'Charles Carey');
  assert.deepStrictEqual(got.services, ['Bid Protests']);
});

test('readApprovedLinkedIn returns null for a missing filename', () => {
  freshDir();
  assert.strictEqual(catalogs.readApprovedLinkedIn('does_not_exist.json'), null);
});

test('readApprovedLinkedIn returns null for a non-.json name', () => {
  freshDir();
  const fname = catalogs.saveApprovedLinkedIn(record());
  const notJson = fname.replace(/\.json$/, '.txt');
  assert.strictEqual(catalogs.readApprovedLinkedIn(notJson), null);
});

test('readApprovedLinkedIn does not escape the directory for a traversal filename', () => {
  const dir = freshDir();
  // A file that genuinely exists one level up, outside approved-linkedin/, so a working
  // traversal would find it and a guarded read would not.
  const secret = path.join(dir, 'secret.json');
  fs.writeFileSync(secret, JSON.stringify({ leaked: true }), 'utf8');
  assert.strictEqual(catalogs.readApprovedLinkedIn('../secret.json'), null);
});

test('merge behaviour: saving over an existing record with preserved identity keeps recipient_name and services intact while final_text changes', () => {
  freshDir();
  const fname = catalogs.saveApprovedLinkedIn(record({ final_text: 'original text' }));
  const prior = catalogs.readApprovedLinkedIn(fname);
  // Mirrors the server's outreach-edit merge: only final_text (and saved_at) change; the
  // recipient identity and services are carried forward from what was read back.
  const merged = catalogs.saveApprovedLinkedIn({
    company_name: prior.company_name,
    recipient_name: prior.recipient_name,
    recipient_title: prior.recipient_title,
    recipient_role: prior.recipient_role,
    services: prior.services,
    first_draft: prior.first_draft,
    final_text: 'corrected text',
    saved_at: new Date().toISOString()
  }, fname);
  assert.strictEqual(merged, fname, 'same filename, not a new exemplar');
  const after = catalogs.readApprovedLinkedIn(fname);
  assert.strictEqual(after.recipient_name, 'Charles Carey');
  assert.deepStrictEqual(after.services, ['Bid Protests']);
  assert.strictEqual(after.final_text, 'corrected text');
});
