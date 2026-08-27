const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogs = require('../server/catalogs');

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-'));
  catalogs.init(dir, path.join(__dirname, '..'));
  return dir;
}
const rec = over => ({
  company_name: 'Acme', recipient: 'gary@example.test', services: ['Bid Protests'],
  first_draft: 'd', final_text: 'body text', is_followup: false,
  saved_at: '2026-08-27T00:00:00.000Z', ...over
});

test('a subject is stored on the record and survives a round trip', () => {
  freshDir();
  catalogs.saveApprovedEmail(rec({ subject: 'Your Fort Bliss award and timing',
                                   suggested_subject: 'Your Fort Bliss award' }));
  const all = catalogs.listApprovedEmails();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].subject, 'Your Fort Bliss award and timing');
  assert.strictEqual(all[0].suggested_subject, 'Your Fort Bliss award');
});

test('a record saved without a subject is still stored and still lists', () => {
  // Pre-existing records and the 11 seeds have no subject. They remain valid body
  // exemplars; only the subject half of the prompt excludes them (Task B).
  freshDir();
  catalogs.saveApprovedEmail(rec());
  const all = catalogs.listApprovedEmails();
  assert.strictEqual(all.length, 1);
  assert.ok(!all[0].subject);
});

test('the library is capped and the oldest record is evicted', () => {
  const dir = freshDir();
  const seedCount = catalogs.listApprovedEmails().length; // seeds copied in by init
  for (let i = 0; i < catalogs.MAX_APPROVED_EMAILS + 5; i++) {
    catalogs.saveApprovedEmail(rec({
      company_name: 'C' + i,
      // strictly increasing timestamps so "oldest" is unambiguous
      saved_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString()
    }));
  }
  const all = catalogs.listApprovedEmails();
  assert.strictEqual(all.length, catalogs.MAX_APPROVED_EMAILS,
    `library must be capped at ${catalogs.MAX_APPROVED_EMAILS}, got ${all.length}`);
  assert.ok(seedCount >= 0);
  // The survivors are the newest ones: C0 is gone, the last one written is present.
  const names = all.map(r => r.company_name);
  assert.ok(!names.includes('C0'), 'the oldest record should have been evicted');
  assert.ok(names.includes('C' + (catalogs.MAX_APPROVED_EMAILS + 4)), 'the newest must survive');
});

test('seeds evict before real sends, because they are older', () => {
  // Seeds carry saved_at 2026-06-01, older than any real send, so oldest-out eviction
  // retires the training wheels first without needing a special case.
  freshDir();
  const before = catalogs.listApprovedEmails().filter(r => r.seed).length;
  assert.ok(before > 0, 'fixture requires the seeded library');
  for (let i = 0; i < catalogs.MAX_APPROVED_EMAILS; i++) {
    catalogs.saveApprovedEmail(rec({
      company_name: 'R' + i,
      saved_at: new Date(Date.UTC(2026, 6, 1) + i * 3600000).toISOString()
    }));
  }
  const after = catalogs.listApprovedEmails().filter(r => r.seed).length;
  assert.strictEqual(after, 0, 'every seed should have been displaced by real sends');
});

test('eviction never drops the library below the cap', () => {
  freshDir();
  for (let i = 0; i < 5; i++) catalogs.saveApprovedEmail(rec({ company_name: 'X' + i }));
  const all = catalogs.listApprovedEmails();
  assert.ok(all.length <= catalogs.MAX_APPROVED_EMAILS);
  assert.ok(all.length >= 5, 'a small library must not be pruned');
});

test('a record with no saved_at does not break eviction ordering', () => {
  freshDir();
  catalogs.saveApprovedEmail(rec({ company_name: 'NoDate', saved_at: undefined }));
  for (let i = 0; i < catalogs.MAX_APPROVED_EMAILS + 2; i++) {
    catalogs.saveApprovedEmail(rec({
      company_name: 'Y' + i,
      saved_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString()
    }));
  }
  assert.strictEqual(catalogs.listApprovedEmails().length, catalogs.MAX_APPROVED_EMAILS);
});
