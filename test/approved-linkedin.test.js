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
