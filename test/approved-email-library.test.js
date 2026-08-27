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
  const dir = freshDir();
  const fname = catalogs.saveApprovedEmail(rec());
  const all = catalogs.listApprovedEmails();
  assert.strictEqual(all.length, 1);
  assert.ok(!all[0].subject);
  // The hard contract is "absent stays absent", not "absent or empty string" — !x passes
  // for both, so read the raw JSON off disk and assert the key is genuinely missing.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'approved-emails', fname), 'utf8'));
  assert.ok(!('subject' in raw), 'subject key must be absent from the stored record, not just falsy');
});

test('the library is capped and the oldest record is evicted', () => {
  freshDir();
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
  // The survivors are the newest ones: C0 is gone, the last one written is present.
  const names = all.map(r => r.company_name);
  assert.ok(!names.includes('C0'), 'the oldest record should have been evicted');
  assert.ok(names.includes('C' + (catalogs.MAX_APPROVED_EMAILS + 4)), 'the newest must survive');
});

test('older records evict before newer ones, so seeds retire on their own', () => {
  freshDir();
  // Stand in for the shipped starter set: seed:true with a saved_at older than any real
  // send. Production seeds this library from server.js at startup, not from catalogs.
  for (let i = 0; i < 11; i++) {
    catalogs.saveApprovedEmail(rec({ company_name: 'Seed' + i, seed: true,
      saved_at: '2026-06-01T00:00:00.000Z' }));
  }
  assert.strictEqual(catalogs.listApprovedEmails().filter(r => r.seed).length, 11);
  for (let i = 0; i < catalogs.MAX_APPROVED_EMAILS; i++) {
    catalogs.saveApprovedEmail(rec({ company_name: 'R' + i,
      saved_at: new Date(Date.UTC(2026, 6, 1) + i * 3600000).toISOString() }));
  }
  assert.strictEqual(catalogs.listApprovedEmails().filter(r => r.seed).length, 0,
    'every seed should have been displaced by newer real sends');
});

test('listing the library never writes to it', () => {
  const dir = freshDir();
  const dirPath = path.join(dir, 'approved-emails');
  assert.strictEqual(fs.readdirSync(dirPath).length, 0,
    'a fresh catalogs dir starts empty — server.js seeds, catalogs does not');
  catalogs.listApprovedEmails();
  catalogs.listApprovedEmails();
  assert.strictEqual(fs.readdirSync(dirPath).length, 0,
    'a read must never create records: buildDraftPrompt calls this on every draft, and ' +
    'with eviction in play a write-on-read would resurrect retired seeds');
});

test('reaching exactly the cap prunes nothing, crossing it by one evicts exactly one', () => {
  // The old version of this test (length <= 100 for 5 records) was near-vacuous: it
  // would pass even if pruning were wildly wrong. Pin the actual boundary behavior
  // instead, at the cap and one past it, where an off-by-one would actually show up.
  freshDir();
  for (let i = 0; i < catalogs.MAX_APPROVED_EMAILS; i++) {
    catalogs.saveApprovedEmail(rec({
      company_name: 'Z' + i,
      saved_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString()
    }));
  }
  assert.strictEqual(catalogs.listApprovedEmails().length, catalogs.MAX_APPROVED_EMAILS,
    'exactly at the cap, nothing should be pruned yet');

  catalogs.saveApprovedEmail(rec({ company_name: 'ZOverflow',
    saved_at: new Date(Date.UTC(2026, 0, 1) + catalogs.MAX_APPROVED_EMAILS * 86400000).toISOString() }));
  const all = catalogs.listApprovedEmails();
  assert.strictEqual(all.length, catalogs.MAX_APPROVED_EMAILS,
    'crossing the cap by one must evict exactly one, not drop below the cap');
  assert.ok(all.some(r => r.company_name === 'ZOverflow'), 'the newest record must survive');
  assert.ok(!all.some(r => r.company_name === 'Z0'), 'the single oldest record must be the one evicted');
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
