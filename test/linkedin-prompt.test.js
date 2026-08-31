const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogs = require('../server/catalogs');
const config = require('../server/config');
const { buildDraftPrompt } = require('../server/linkedinEngine');

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-'));
  catalogs.init(dir, path.join(__dirname, '..'));
  config.init(dir); // buildDraftPrompt reads config.get().draftModel; config.js needs its
                     // own init separately from catalogs.init to set its store path.
  return dir;
}

const dossier = { company_name: 'Nava PBC', city_state: 'DC', industry: 'IT',
  designations: '8(a)', issue_spotting: [{ title: 'T', explanation: 'E' }] };
const contact = { name: 'Charles Carey', title: 'General Counsel', role: 'GC',
  linkedin: 'https://www.linkedin.com/in/x' };

test('the chosen person reaches the prompt', () => {
  freshDir();
  const { user } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.match(user, /Charles Carey/);
  assert.match(user, /General Counsel/);
});

test('exemplars are capped at six', () => {
  freshDir();
  for (let i = 0; i < 9; i++) {
    catalogs.saveApprovedLinkedIn({ company_name: 'C' + i, recipient_name: 'R' + i,
      recipient_title: 't', recipient_role: 'GC', services: [], first_draft: '',
      final_text: 'BODY' + i, saved_at: '2026-08-0' + (i + 1) + 'T00:00:00.000Z' });
  }
  const { system } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.strictEqual((system.match(/EXAMPLE \d/g) || []).length, 6);
});

test('no services still produces a valid prompt', () => {
  freshDir();
  const p = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.ok(p.system.length > 0 && p.user.length > 0 && p.model);
});

// Tests the instruction, not the absence of a phrase: the system prompt says "No subject
// line", so asserting that the string is absent would fail against a correct prompt.
test('the prompt forbids a subject line and a signature block', () => {
  freshDir();
  const { system } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.match(system, /No subject line/i);
  assert.match(system, /No signature block/i);
});

test('an empty LinkedIn library still produces a prompt, without an APPROVED EXAMPLES header', () => {
  freshDir();
  const { system } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.ok(system.length > 0);
  assert.ok(!system.includes('APPROVED EXAMPLES'),
    'day-one state has no exemplars, so the prompt must not claim examples follow');
  assert.match(system, /No prior approved LinkedIn messages yet/);
});

test('a populated LinkedIn library still shows the APPROVED EXAMPLES header', () => {
  freshDir();
  catalogs.saveApprovedLinkedIn({ company_name: 'Nava PBC', recipient_name: 'Charles Carey',
    recipient_title: 'GC', recipient_role: 'GC', services: [], first_draft: '',
    final_text: 'BODY', saved_at: '2026-08-01T00:00:00.000Z' });
  const { system } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.ok(system.includes('APPROVED EXAMPLES'));
});
