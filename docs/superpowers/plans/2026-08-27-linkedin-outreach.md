# LinkedIn Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The SA drafts a personalised LinkedIn message to a named decision-maker inside the CRM, approves it, and lands on the right LinkedIn page with the text on the clipboard — while the approval feeds a LinkedIn voice library separate from email's, and both libraries start teaching recent voice rather than merely matching it.

**Architecture:** Additive. One new server module (`linkedinEngine.js`) that reuses `callClaude` and `rankExemplars` from `emailEngine` rather than copying them, one new exemplar directory with a matching pair of catalog functions, three new routes following the existing `mutating()` pattern, one new branch in an existing route, and one new client flow modelled on `openEmailFlow`. The only change to existing behaviour is the ranking function, which both channels share.

**Tech Stack:** Node ≥20, Express 4, plain browser JavaScript with no framework and no build step. Only two runtime dependencies exist (`express`, `chokidar`) and this plan adds none. Tests use Node's built-in `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-08-27-linkedin-outreach-design.md`

---

## Global Constraints

- **No new dependencies.** `package.json` has exactly two, and the "no-compilation promise" in `auth.js` depends on keeping it that way. `node:test` is built in; use it.
- **Node ≥20** is pinned in `engines`. The comment there explains why the real floor is 15.7 (`base64url`); do not lower it.
- **Absence is the empty string.** Across all 257 contacts, `linkedin`, `email` and `phone` are never `null` and never missing. Existence checks (`'linkedin' in contact`) are always true and therefore useless. Test truthiness on the value.
- **`contacts` is optional** at the top level: it may be absent entirely or an empty array, and holds at most five objects. Every object carries all nine keys and no others: `name`, `title`, `role` (`CEO|GC|other`), `email`, `email_verified`, `phone`, `phone_verified`, `linkedin`, `source` (`internal|vibe_prospecting`).
- **Two LinkedIn facts, two meanings.** `contact_general.linkedin` is the company page. `contacts[i].linkedin` is a person. A company page is not a person's profile; never substitute one for the other silently.
- **`data/` is gitignored.** Never commit anything under it. Never commit credentials, the Anthropic key, or Google OAuth values.
- **The prompt takes six exemplars.** `buildDraftPrompt` uses `ranked.slice(0, 6)`; the LinkedIn prompt matches.
- **Do not touch** `gmail.js`, `auth.js`, `users.js`, `backup.js`, or the reply libraries. This work does not intersect them.
- **Working directory for every command:** `/Users/rafaelkriger/Desktop/life-dashboard/areas/GovSpring/sales work/WebCRM`
- **Verification block** (run at the end of every task):

  ```sh
  node --check server/linkedinEngine.js
  node --check server/emailEngine.js
  node --check server/catalogs.js
  node --check server/server.js
  node --check public/renderer.js
  node --check public/api.js
  npm test
  ```

- **Never claim visual verification.** There is no browser in the implementing session. The clipboard write, the new-tab open, popup-blocked behaviour, and the character readout are the user's check.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | **Modify.** Add `"test": "node --test"`. No dependency changes. |
| `test/rank-exemplars.test.js` | **Create.** Ranking precedence: overlap, recency, seed decay. |
| `test/linkedin-destination.test.js` | **Create.** Destination resolution and the URL-shape contract. |
| `test/linkedin-prompt.test.js` | **Create.** Prompt assembly and exemplar capping. |
| `test/approved-linkedin.test.js` | **Create.** Exemplar save/list, including in-place overwrite. |
| `server/emailEngine.js` | **Modify.** Rewrite `rankExemplars`; export it. |
| `server/catalogs.js` | **Modify.** Add the LinkedIn library pair; create its directory in `init()`. |
| `server/linkedinEngine.js` | **Create.** Destination resolution, prompt assembly, draft generation. |
| `server/db.js` | **Modify.** `logExternal` returns the id of the entry it created. |
| `server/server.js` | **Modify.** Three routes; one branch in the outreach-edit route. |
| `public/api.js` | **Modify.** Three client methods. |
| `public/renderer.js` | **Modify.** Entry button and the LinkedIn flow. |

---

## Task 1: Test harness and voice recency

Delivers value alone: it fixes why the email voice never improved, and it establishes the harness every later task uses.

**Files:**
- Modify: `package.json`
- Create: `test/rank-exemplars.test.js`
- Modify: `server/emailEngine.js` (`rankExemplars` at ~line 377; exports at ~line 452)

**Interfaces:**
- Consumes: nothing.
- Produces: `emailEngine.rankExemplars(approved, chosenServices)` — same signature, new ordering, now exported for Task 3.

- [ ] **Step 1: Add the test script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server/server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `test/rank-exemplars.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { rankExemplars } = require('../server/emailEngine');

// Fixtures are built here rather than read from data/approved-emails, because that
// library is all seed records — seed decay could never fire against it at any threshold.
const rec = (over, when, seed) => ({
  services: over, saved_at: when, seed: !!seed, final_text: 'x', company_name: 'c', recipient: 'r'
});
const realFill = (n) => Array.from({ length: n }, (_, i) => rec([], '2026-01-0' + ((i % 9) + 1), false));

test('service overlap stays the primary signal', () => {
  const out = rankExemplars(
    [rec([], '2026-08-01'), rec(['Bid Protests'], '2020-01-01')],
    ['Bid Protests']
  );
  assert.strictEqual(out[0].services[0], 'Bid Protests');
});

test('recency breaks an overlap tie', () => {
  const out = rankExemplars(
    [rec(['A'], '2026-01-01'), rec(['A'], '2026-08-01')],
    ['A']
  );
  assert.strictEqual(out[0].saved_at, '2026-08-01');
});

test('seeds rank normally while the library is thin', () => {
  const out = rankExemplars([rec([], '2020-01-01', true), rec([], '2019-01-01', false)], []);
  assert.strictEqual(out[0].seed, true, 'newer seed should still win below the threshold');
});

test('seeds sort last once enough real exemplars exist', () => {
  const seedy = rec(['A'], '2026-08-01', true);   // best overlap AND newest
  const out = rankExemplars([seedy, ...realFill(12)], ['A']);
  assert.strictEqual(out[out.length - 1].seed, true, 'seed must fall to the end');
});

test('an empty library returns empty rather than throwing', () => {
  assert.deepStrictEqual(rankExemplars([], ['A']), []);
});

test('a record with no saved_at does not throw and sorts last among its ties', () => {
  const out = rankExemplars([rec(['A'], undefined), rec(['A'], '2026-08-01')], ['A']);
  assert.strictEqual(out[0].saved_at, '2026-08-01');
});

test('the input array is not mutated', () => {
  const input = [rec(['A'], '2020-01-01'), rec(['B'], '2026-01-01')];
  const copy = input.slice();
  rankExemplars(input, ['B']);
  assert.deepStrictEqual(input, copy);
});
```

- [ ] **Step 3: Run them and watch them fail**

```sh
npm test
```

Expected: `rankExemplars is not a function` — it is not exported yet. That is the first failure to fix.

- [ ] **Step 4: Rewrite the ranking**

In `server/emailEngine.js`, replace the whole `rankExemplars` function with:

```js
// Seeds are training wheels. Once the library holds this many real approvals, the prompt
// window (6) can be filled twice over from real material and the seeds are no longer
// load-bearing, so they sort last. Below it they rank normally — a cold library still
// needs examples to teach from.
const SEED_DECAY_THRESHOLD = 12;

// Ranking has three signals, in strict precedence. Service overlap stays primary: a
// well-matched example teaches more than a recent mismatched one. Recency breaks ties,
// which is what makes the library track Marcos's current voice instead of averaging
// every voice he has ever had. Seed decay applies only past the threshold above.
function rankExemplars(approved, chosenServices) {
  const chosen = new Set((chosenServices || []).map(s => s.toLowerCase()));
  const overlap = e => (e.services || []).map(s => s.toLowerCase()).filter(s => chosen.has(s)).length;
  // Date.parse returns NaN for a missing or malformed stamp; || 0 sorts those last
  // among their ties rather than throwing or poisoning the comparison.
  const when = e => Date.parse(e && e.saved_at) || 0;
  const decay = (approved || []).filter(e => e && !e.seed).length >= SEED_DECAY_THRESHOLD;

  return [...(approved || [])].sort((a, b) => {
    if (decay && !!a.seed !== !!b.seed) return a.seed ? 1 : -1;
    const byOverlap = overlap(b) - overlap(a);
    if (byOverlap) return byOverlap;
    return when(b) - when(a);
  });
}
```

- [ ] **Step 5: Export it**

In the `module.exports` at the end of `server/emailEngine.js`, add `rankExemplars` to the list:

```js
module.exports = { buildQuestions, generateDraft, buildDraftPrompt, callClaude, rankExemplars,
  buildReplyPrompt, generateReplyDraft,
  generateSubjects, buildSubjectPrompt, cleanSubjectLine, isSpammySubject, parseSubjectResponse };
```

- [ ] **Step 6: Run the tests and the checks**

```sh
npm test
node --check server/emailEngine.js
```

Expected: 7 tests passing.

- [ ] **Step 7: Commit**

```sh
git add package.json test/rank-exemplars.test.js server/emailEngine.js
git commit -m "Rank exemplars by recency and decay seeds, with a test harness

The voice library grew but the voice it taught did not move: ranking used
service overlap alone, so a January approval outranked nothing and the ten
seeds stayed eligible forever. Overlap stays primary, recency now breaks
ties, and seeds sort last once twelve real approvals exist.

Adds node --test, which is built into the pinned Node 20, so the repo gains
a test harness without gaining a dependency."
```

---

## Task 2: The LinkedIn exemplar library

**Files:**
- Modify: `server/catalogs.js` (`init` at ~line 16; the email pair at ~lines 154-180; exports at ~line 228)
- Create: `test/approved-linkedin.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `catalogs.listApprovedLinkedIn()` → array of records; `catalogs.saveApprovedLinkedIn(record, existingFile)` → filename string. Consumed by Tasks 3, 4 and 5.

- [ ] **Step 1: Write the failing tests**

Create `test/approved-linkedin.test.js`:

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

```sh
npm test
```

Expected: `catalogs.saveApprovedLinkedIn is not a function`.

- [ ] **Step 3: Create the directory in `init`**

In `server/catalogs.js`, `init()` already builds `approvedDir` and `replyDir`. Add a third alongside them, and add it to the `dirs` object:

```js
  const linkedinDir = path.join(userDataDir, 'approved-linkedin');
  fs.mkdirSync(linkedinDir, { recursive: true });
```

and extend the assignment to `dirs` so it reads:

```js
  dirs = { userCatalogs, approvedDir, replyDir, linkedinDir };
```

- [ ] **Step 4: Add the library pair**

In `server/catalogs.js`, directly after `saveApprovedEmail`, add:

```js
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
  return fname;
}
```

- [ ] **Step 5: Export them**

Add `listApprovedLinkedIn, saveApprovedLinkedIn` to the `module.exports` object at the end of `server/catalogs.js`.

- [ ] **Step 6: Run the tests**

```sh
npm test
node --check server/catalogs.js
```

Expected: 12 tests passing (7 from Task 1, 5 new).

- [ ] **Step 7: Commit**

```sh
git add server/catalogs.js test/approved-linkedin.test.js
git commit -m "Add the LinkedIn voice library, separate from email's

Same file mechanics as approved-emails, including in-place overwrite so
re-editing a logged message corrects its exemplar rather than adding a
second one. Separate directory because a LinkedIn message has no subject
and no signature block: mixing the two would teach a voice that is neither."
```

---

## Task 3: `linkedinEngine.js` — destination and prompt

**Files:**
- Create: `server/linkedinEngine.js`
- Create: `test/linkedin-destination.test.js`
- Create: `test/linkedin-prompt.test.js`

**Interfaces:**
- Consumes: `emailEngine.callClaude`, `emailEngine.rankExemplars` (exported in Task 1), `catalogs.listApprovedLinkedIn` (Task 2), `catalogs.readFirmFacts`, `catalogs.readServices`, `config.get`.
- Produces:
  - `resolveDestination(contact, contactGeneral)` → `{ url: string, kind: 'person'|'company'|'none' }`
  - `buildDraftPrompt({ dossier, contact, chosenIssue, chosenServices, personalNote })` → `{ system, user, model }`
  - `generateDraft(params)` → `{ draft, usage }`

- [ ] **Step 1: Write the failing destination tests**

Create `test/linkedin-destination.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { resolveDestination } = require('../server/linkedinEngine');

const person = u => ({ name: 'C', title: 'GC', role: 'GC', linkedin: u });
const company = u => ({ linkedin: u });
const PERSON = 'https://www.linkedin.com/in/charles-carey-409546350/';
const COMPANY = 'https://www.linkedin.com/company/nava-pbc';

test('a person URL wins over the company page', () => {
  const d = resolveDestination(person(PERSON), company(COMPANY));
  assert.deepStrictEqual(d, { url: PERSON, kind: 'person' });
});

test('the company page is the fallback when the person has none', () => {
  const d = resolveDestination(person(''), company(COMPANY));
  assert.strictEqual(d.kind, 'company');
});

test('both empty yields copy-only, not a broken link', () => {
  assert.deepStrictEqual(resolveDestination(person(''), company('')),
    { url: '', kind: 'none' });
});

test('absent contacts and absent contact_general do not throw', () => {
  assert.strictEqual(resolveDestination(undefined, undefined).kind, 'none');
  assert.strictEqual(resolveDestination(null, {}).kind, 'none');
});

// The three variance cases the data contract documents.
test('a URL with no trailing slash is usable', () => {
  assert.strictEqual(resolveDestination(person('https://www.linkedin.com/in/jim-filla-a080a77'), {}).kind, 'person');
});

test('an http:// URL is usable', () => {
  assert.strictEqual(resolveDestination(person('http://www.linkedin.com/in/someone'), {}).kind, 'person');
});

test('a country subdomain is usable', () => {
  assert.strictEqual(resolveDestination(person('https://jm.linkedin.com/in/someone'), {}).kind, 'person');
});

// The trap: renderer.js's safeUrl resolves against window.location.origin, so a bare
// slug would silently become a link back into the CRM and pass its protocol check. The
// contract guarantees absolute URLs; this pins the guarantee so a regression at source
// surfaces as a failure rather than a link to nowhere.
test('a bare slug is rejected rather than resolved against our own origin', () => {
  assert.strictEqual(resolveDestination(person('charles-carey'), {}).kind, 'none');
  assert.strictEqual(resolveDestination(person('/in/charles-carey'), {}).kind, 'none');
});

test('whitespace-only is absence', () => {
  assert.strictEqual(resolveDestination(person('   '), company('  ')).kind, 'none');
});

test('a non-http scheme is rejected', () => {
  assert.strictEqual(resolveDestination(person('javascript:alert(1)'), {}).kind, 'none');
});
```

- [ ] **Step 2: Write the failing prompt tests**

Create `test/linkedin-prompt.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogs = require('../server/catalogs');
const { buildDraftPrompt } = require('../server/linkedinEngine');

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-'));
  catalogs.init(dir, path.join(__dirname, '..'));
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

test('an empty LinkedIn library still produces a prompt', () => {
  freshDir();
  const { system } = buildDraftPrompt({ dossier, contact, chosenIssue: null, chosenServices: [] });
  assert.ok(system.includes('APPROVED EXAMPLES'));
});
```

- [ ] **Step 3: Run them and watch them fail**

```sh
npm test
```

Expected: `Cannot find module '../server/linkedinEngine'`.

- [ ] **Step 4: Write the module**

Create `server/linkedinEngine.js`:

```js
// linkedinEngine.js — drafting for the LinkedIn channel.
//
// Deliberately smaller than emailEngine: no subject generation, no reply drafting, no
// booking slots. It reuses callClaude and rankExemplars from emailEngine rather than
// copying them, so a change to ranking reaches both channels at once.
//
// Recipient and destination are independent. The recipient is always a named person from
// the dossier's contacts; the destination is wherever the SA can actually reach them,
// which may be that person's profile or, when they have none, the company page. 156 of
// 257 contacts have no personal URL, so the fallback is the common case, not the edge.

const config = require('./config');
const catalogs = require('./catalogs');
const emailEngine = require('./emailEngine');

// Absolute http(s) URLs only. Parsing with no base is the point: renderer.js's safeUrl
// resolves against window.location.origin, so a bare slug there would become a link back
// into the CRM and still pass a protocol check. Here a bare slug throws and is rejected.
function isAbsoluteHttpUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function resolveDestination(contact, contactGeneral) {
  const person = (contact && contact.linkedin) || '';
  if (isAbsoluteHttpUrl(person)) return { url: String(person).trim(), kind: 'person' };
  const company = (contactGeneral && contactGeneral.linkedin) || '';
  if (isAbsoluteHttpUrl(company)) return { url: String(company).trim(), kind: 'company' };
  return { url: '', kind: 'none' };
}

function buildDraftPrompt({ dossier, contact, chosenIssue, chosenServices, personalNote }) {
  const firm = catalogs.readFirmFacts();
  const servicesCatalog = catalogs.readServices();
  const approved = catalogs.listApprovedLinkedIn();

  const ranked = emailEngine.rankExemplars(approved, chosenServices);
  const exemplars = ranked.slice(0, 6)
    .map((e, i) => `EXAMPLE ${i + 1} (to ${e.recipient_name} at ${e.company_name}):\n${e.final_text}`)
    .join('\n\n---\n\n');

  const cfg = config.get();

  const system = `You are drafting a LinkedIn message for Marcos Gonzalez, Managing Attorney at GovSpring Legal, a boutique government-contracts law firm. You write in his exact voice, learned from the real approved examples below.

NON-NEGOTIABLE STYLE RULES:
- This is LinkedIn, not email. Length 60 to 120 words. Shorter is better.
- No subject line. No formal salutation block. No signature block. No CC line.
- Open on the person, not the company: something specific and real about their role or their firm's actual work.
- Bridge naturally to the chosen legal service(s) in one or two sentences, using the firm's real vocabulary.
- NO em dashes anywhere. NO en dashes except in numeric ranges. Use periods, commas, or semicolons.
- Close with a light, low-friction offer to talk. No scheduling links, no phone numbers, no calendar times: those belong in email.
- Warm and direct. Never pushy, never alarmist, never salesy.
- Only state facts about the prospect that appear in the dossier provided. Never invent a contract, an award, a name, or a detail.
- Only state facts about the firm or Marcos that are marked CONFIRMED in the firm facts. Do not assert LIKELY or UNVERIFIED facts as established.

FIRM AND PEOPLE FACTS:
${firm}

SERVICE CATALOG (for how each service is pitched):
${servicesCatalog}

APPROVED EXAMPLES (match this voice, structure, and length; do not copy their specific facts):
${exemplars}`;

  const issueText = chosenIssue && chosenIssue.title
    ? `Lead around this issue: "${chosenIssue.title}". Context: ${chosenIssue.explanation}`
    : `Do not lead on a single legal issue. Open warmly on their work generally.`;

  const personalText = personalNote
    ? `Include a brief, natural personal touch: ${personalNote}. One short clause at most.`
    : `Do not add a personal anecdote.`;

  const user = `Draft the LinkedIn message now.

RECIPIENT:
Name: ${contact.name || '(name not found)'}
Title: ${contact.title || ''}
Role: ${contact.role || ''}

PROSPECT DOSSIER:
Company: ${dossier.company_name}
Location: ${dossier.city_state || ''}
Industry: ${dossier.industry || ''}
Designations: ${dossier.designations || ''}
Current contract: ${JSON.stringify(dossier.current_contract || {}, null, 2)}
Sales notes: ${dossier.sales_notes || ''}
All spotted issues: ${JSON.stringify((dossier.issue_spotting || []).map(i => i.title))}

${issueText}

Services to mention (1 to 2): ${(chosenServices || []).join('; ') || '(choose the most fitting from the catalog)'}

${personalText}

Write only the message body, addressed to ${contact.name || 'them'} by first name. Do not write a greeting line on its own; open directly.`;

  return { system, user, model: cfg.draftModel };
}

async function generateDraft(params) {
  const prompt = buildDraftPrompt(params);
  const { text, usage } = await emailEngine.callClaude(prompt);
  return { draft: text, usage };
}

module.exports = { resolveDestination, buildDraftPrompt, generateDraft };
```

- [ ] **Step 5: Run the tests**

```sh
npm test
node --check server/linkedinEngine.js
```

Expected: 27 tests passing (12 prior, 10 destination, 5 prompt).

- [ ] **Step 6: Commit**

```sh
git add server/linkedinEngine.js test/linkedin-destination.test.js test/linkedin-prompt.test.js
git commit -m "Add linkedinEngine: destination resolution and LinkedIn drafting

Recipient and destination are independent, so a contact with no personal
profile is still addressable through the company page — the common case,
since 156 of 257 contacts have no /in/ URL.

Destination parsing rejects bare slugs deliberately: renderer.js's safeUrl
resolves against window.location.origin, so a slug there would become a
link back into the CRM and still pass a protocol check."
```

---

## Task 4: Server routes

**Files:**
- Modify: `server/db.js` — `logExternal` at ~line 358
- Modify: `server/server.js` — three new routes near the email ones (`/questions` at ~818, `/generate` at ~848, `/saveFinal` at ~934); one branch in the outreach-edit route at ~762

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces:
  - `db.logExternal(...)` → gains `entryId` on its return value
  - `GET /api/prospects/:id/linkedin/questions` → `{ ...buildQuestions(dossier), contacts: [{ index, name, title, role, hasPersonalUrl }] }`
  - `POST /api/prospects/:id/linkedin/generate` → `{ draft, usage, destination }`
  - `POST /api/prospects/:id/linkedin/save` → `{ ok: true, destination }`

- [ ] **Step 1: Return the entry id from `logExternal`**

The save route needs to attach an exemplar filename to the entry it just created. Digging the newest entry back out of `p.activity` would be both fragile — `activity` is a JSON *string*, not an array — and racy if two requests interleave. Return the id instead.

In `server/db.js`, in `logExternal`, hoist the generated id and add it to the return. The `appendActivity` call becomes:

```js
  const entryId = crypto.randomBytes(8).toString('hex');
  appendActivity(p, {
    id: entryId, date, channel, message: text,
    text: `Outreach via ${channel}: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`
  });
```

and the function's final return becomes:

```js
  return { ok: true, channel, entryId };
```

This is additive — every existing caller reads only `ok` and `channel`.

- [ ] **Step 2: Add the questions route**

In `server/server.js`, immediately after the existing `/api/prospects/:id/questions` route, add. Note the `try`/`fail` wrapper: that is the convention every GET route here follows, and `ok`/`fail` are the response helpers defined at ~line 652.

```js
// The LinkedIn flow asks the same framing and service questions as email — the choice of
// issue and service is a fact about the prospect, not about the channel — plus the
// decision-maker picker, which is what makes the draft personal. `contacts` is optional in
// the dossier and holds at most five, and absence is always "" rather than null, so every
// check here is on truthiness.
app.get('/api/prospects/:id/linkedin/questions', (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const dossier = p.dossier || {};
    const contacts = (Array.isArray(dossier.contacts) ? dossier.contacts : [])
      .map((ct, index) => ({
        index,
        name: ct.name || '',
        title: ct.title || '',
        role: ct.role || '',
        hasPersonalUrl: !!(ct.linkedin && String(ct.linkedin).trim())
      }));
    ok(res, { ...emailEngine.buildQuestions(dossier), contacts });
  } catch (e) { fail(res, e); }
});
```

- [ ] **Step 3: Add the generate route**

Immediately after the existing `/api/prospects/:id/generate` route, add:

```js
app.post('/api/prospects/:id/linkedin/generate', mutating('prospect.linkedin.generate', async (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  const a = q.body || {};
  const dossier = p.dossier || {};
  const contacts = Array.isArray(dossier.contacts) ? dossier.contacts : [];
  const contact = contacts[parseInt(a.contactIndex, 10)];
  if (!contact) {
    res.status(400).json({ error: 'Choose who this message is for' });
    res.locals.skipAudit = true;
    return;
  }
  let chosenIssue = null;
  if (a.issueId && a.issueId !== 'general') {
    const idx = parseInt(String(a.issueId).replace('issue_', ''), 10);
    chosenIssue = (dossier.issue_spotting || [])[idx] || null;
  }
  const { draft, usage } = await linkedinEngine.generateDraft({
    dossier, contact, chosenIssue,
    chosenServices: a.services || [], personalNote: a.personalNote || null
  });
  res.locals.audit = { prospectId: id, detail: `Generated LinkedIn draft for ${contact.name || 'a contact'}` };
  return { draft, usage, destination: linkedinEngine.resolveDestination(contact, dossier.contact_general) };
}));
```

Add the require at the top of `server/server.js`, beside the `emailEngine` one:

```js
const linkedinEngine = require('./linkedinEngine');
```

- [ ] **Step 4: Add the save route**

After the generate route, add:

```js
// Approving is the whole delivery step: there is no send. The CRM records the outreach and
// learns from it; the SA pastes it into LinkedIn themselves. Logging and learning happen
// server-side and unconditionally, so a blocked popup or a denied clipboard permission in
// the browser still leaves a correctly recorded outreach.
app.post('/api/prospects/:id/linkedin/save', mutating('prospect.linkedin.save', (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  const body = q.body || {};
  const finalText = String(body.finalText || '').trim();
  if (!finalText) {
    res.status(400).json({ error: 'Message cannot be empty' });
    res.locals.skipAudit = true;
    return;
  }
  const dossier = p.dossier || {};
  const contacts = Array.isArray(dossier.contacts) ? dossier.contacts : [];
  const contact = contacts[parseInt(body.contactIndex, 10)];
  if (!contact) {
    res.status(400).json({ error: 'Choose who this message is for' });
    res.locals.skipAudit = true;
    return;
  }

  const result = db.logExternal(id, { channel: 'linkedin', text: finalText });
  if (!result.ok) { res.status(400).json({ error: 'Could not log the outreach' }); res.locals.skipAudit = true; return; }

  const fname = catalogs.saveApprovedLinkedIn({
    company_name: p.company_name,
    recipient_name: contact.name || '', recipient_title: contact.title || '',
    recipient_role: contact.role || '',
    services: Array.isArray(body.services) ? body.services : [],
    first_draft: String(body.firstDraft || ''), final_text: finalText,
    saved_at: new Date().toISOString()
  });

  // Bind the exemplar to the entry logExternal just created, so a later edit corrects this
  // exemplar in place instead of adding a second one. The id comes back from logExternal
  // (Step 1) rather than being dug out of p.activity, which is a JSON string and would be
  // racy to re-read under concurrent requests.
  if (result.entryId) db.recordEntryExemplar(id, result.entryId, fname);

  res.locals.audit = { prospectId: id, detail: `Logged LinkedIn outreach to ${contact.name || 'a contact'} — saved to voice library` };
  return { ok: true, destination: linkedinEngine.resolveDestination(contact, dossier.contact_general) };
}));
```

- [ ] **Step 5: Extend the learn-from-edits branch**

In `server/server.js` at ~line 762, the outreach-edit route currently reads `if (saveToLibrary && result.entry.channel === 'email')`. Replace that whole block with:

```js
  let learned = '';
  if (saveToLibrary && result.entry.channel === 'email') {
    const fname = catalogs.saveApprovedEmail({
      company_name: p.company_name, recipient: (p.dossier && p.dossier.contact_general && p.dossier.contact_general.email) || '',
      services: [], first_draft: '', final_text: result.entry.message,
      is_followup: false, saved_at: new Date().toISOString()
    }, result.entry.exemplar_file || null);
    db.recordEntryExemplar(id, result.entry.id, fname);
    learned = ' — saved to voice library';
  } else if (saveToLibrary && result.entry.channel === 'linkedin') {
    const fname = catalogs.saveApprovedLinkedIn({
      company_name: p.company_name, recipient_name: '', recipient_title: '', recipient_role: '',
      services: [], first_draft: '', final_text: result.entry.message,
      saved_at: new Date().toISOString()
    }, result.entry.exemplar_file || null);
    db.recordEntryExemplar(id, result.entry.id, fname);
    learned = ' — saved to voice library';
  }
```

Recipient identity is empty on this path deliberately: an edit corrects the text of an already-logged entry, and the entry does not carry which contact it went to. The exemplar still teaches voice, which is what the library is for.

- [ ] **Step 6: Verify the checks pass**

```sh
node --check server/server.js
npm test
```

Expected: still 27 tests passing, no syntax errors. These routes are exercised by hand in Task 5's verification, not unit-tested — they are thin wiring over logic already covered.

- [ ] **Step 7: Commit**

```sh
git add server/server.js
git commit -m "Add LinkedIn questions, generate, and save routes

Save is the whole delivery step: there is no send. Logging and library
learning happen server-side and unconditionally, so a blocked popup or a
denied clipboard permission still leaves a correctly recorded outreach.

Editing a logged LinkedIn message now learns into the LinkedIn library,
the branch the channel guard has been waiting for since it was written."
```

---

## Task 5: The client flow

The only task with no automated coverage: it is browser code and this repo has no DOM test harness. Everything testable was deliberately pushed server-side in Task 3.

**Files:**
- Modify: `public/api.js` (~line 89, beside the email methods)
- Modify: `public/renderer.js` (entry button near ~line 384; new flow beside `openEmailFlow` at ~784)

**Interfaces:**
- Consumes: the three routes from Task 4.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the client methods**

In `public/api.js`, after `suggestSubjects`, add:

```js
  linkedinQuestions: (id)     => getJSON('/api/prospects/' + id + '/linkedin/questions'),
  linkedinGenerate:  (id, a)  => sendJSON('/api/prospects/' + id + '/linkedin/generate', 'POST', a),
  linkedinSave:      (id, b)  => sendJSON('/api/prospects/' + id + '/linkedin/save', 'POST', b),
```

- [ ] **Step 2: Add the entry button**

In `public/renderer.js`, beside the existing `generateBtn` in the prospect detail, add a `linkedinBtn`. Wire it next to the existing listener at ~line 384:

```js
  const lb = document.getElementById('linkedinBtn');
  if (lb) lb.addEventListener('click', () => openLinkedInFlow(id, d));
```

Render it disabled with the reason stated when there is nobody to address — a personalised message needs a person, and gate-killed prospects legitimately have no contacts:

```js
  const hasContacts = Array.isArray(d.contacts) && d.contacts.length > 0;
  // markup, beside the Generate button:
  // `<button class="btn btn-ghost" id="linkedinBtn" ${hasContacts ? '' : 'disabled title="No decision-makers on file to address"'}>LinkedIn message</button>`
```

- [ ] **Step 3: Build the flow**

Add `openLinkedInFlow(prospectId, dossier)` beside `openEmailFlow`, modelled on it and rendering into the same `emailModal` shell. Four steps:

1. **Contact picker.** From `linkedinQuestions().contacts`, one `.opt` row each showing `name`, `title`, `role`, and a quiet marker when `hasPersonalUrl` is false reading "no personal profile — will open the company page". Selecting one sets `flowState.contactIndex`.
2. **Framing and services.** Identical markup and handlers to `renderQuestions`, minus the calendar-slots block, which is email-only.
3. **Draft.** `linkedinGenerate()`, rendered into a textarea with `id="liDraftArea"`, exactly as the email flow renders its draft.
4. **Review and approve.**

Under the textarea, a live character readout. It is a readout, not a mode: a connection-request note caps at 300 characters while a message to an existing connection does not, so the SA sees whether this draft would fit as a note and decides in LinkedIn.

```js
  const draftArea = document.getElementById('liDraftArea');
  const counter = document.getElementById('liCount');
  const updateCount = () => {
    const n = draftArea.value.length;
    counter.textContent = n <= 300
      ? `${n} characters — fits a connection request`
      : `${n} characters — too long for a connection request (300 max), fine as a message`;
  };
  draftArea.addEventListener('input', updateCount);
  updateCount();
```

- [ ] **Step 4: Wire approve**

Approving calls `linkedinSave()` **first** and only then touches the browser, so recording never depends on the clipboard or the popup blocker:

```js
  const res = await window.api.linkedinSave(flowState.prospectId, {
    finalText: draftArea.value,
    contactIndex: flowState.contactIndex,
    services: flowState.services,
    firstDraft: flowState.firstDraft
  });
  // Recorded. Everything below is best-effort convenience.
  try { await navigator.clipboard.writeText(draftArea.value); } catch { /* selectable on screen */ }
  if (res.destination && res.destination.url) window.open(res.destination.url, '_blank', 'noopener');
  emailModal.hidden = true;
  toast(res.destination && res.destination.url
    ? 'Logged and copied. LinkedIn opened in a new tab — paste and send.'
    : 'Logged and copied. No LinkedIn URL on file, so paste it wherever you reach them.', 6000);
  openDetail(flowState.prospectId);
```

If the popup is blocked the destination URL must still be reachable, so render it as a plain anchor in the toast area or leave the modal's link visible rather than relying solely on `window.open`.

- [ ] **Step 5: Syntax check**

```sh
node --check public/renderer.js
node --check public/api.js
npm test
```

Expected: no syntax errors; 27 tests still passing.

- [ ] **Step 6: Commit**

```sh
git add public/api.js public/renderer.js
git commit -m "Add the LinkedIn drafting flow

Contact picker first, so the draft is personalised to a named
decision-maker. Approve records and learns server-side before touching the
browser, so a blocked popup or a denied clipboard permission cannot cost a
logged outreach. The character readout marks the 300-character connection
request limit without forcing the SA into a mode."
```

- [ ] **Step 7: Hand back for the rendered check**

State plainly that these were not verified, because there is no browser in the implementing session:

- the clipboard write, and the fallback when permission is denied
- the new tab, and the fallback when a popup blocker swallows it
- the character readout updating as the SA types
- the button's disabled state on a prospect with no contacts
- a draft to a contact with a personal URL, one without, and one where the company page is also absent

---

## Self-review

**Spec coverage.** Every section maps to a task. Spec §A "new module" → Task 3. §A "exemplar record" → Task 2. §A "flow" → Tasks 4 and 5. §A "hand-off and logging" → Task 4 step 3 and Task 5 step 4. §A "learning from later edits" → Task 4 step 4. §B "voice recency" → Task 1. §"Reuse" → Task 1 step 5 exports `rankExemplars`; Task 3 requires `emailEngine` rather than duplicating. §"Tests" → Tasks 1, 2, 3, with the spec's five listed areas all covered: ranking precedence, destination selection including all three variance cases, the bare-slug case, prompt assembly and the six-exemplar cap, and in-place exemplar overwrite.

**Two deliberate deviations from the spec.**

1. The spec says the client resolves the destination; this plan resolves it server-side in `linkedinEngine.js` and returns it on the generate and save responses. Reason: it is the logic most likely to be wrong — it carries the contract's three variance cases and the bare-slug trap — and in the renderer it would be untestable. Moving it into Node puts it under test at no cost to behaviour.
2. The spec does not mention `db.js`; this plan adds one line to `logExternal` so it returns the id of the entry it created. Reason found during self-review: the save route must bind an exemplar filename to that entry, and the alternative was re-reading `p.activity` — which is a JSON *string*, not an array — and taking the newest element. That is fragile to parse and racy under concurrent requests. Returning the id is additive and every existing caller is unaffected.

**Placeholder scan.** No TBDs. Every code step carries real code. Task 5 describes markup rather than quoting the full modal because it renders into the existing `emailModal` shell whose structure is read at implementation time; its four steps, its handlers, and its approve sequence are all specified concretely.

**Type consistency.** `resolveDestination` returns `{ url, kind }` in Task 3 and is consumed with that exact shape in Task 4 (twice) and Task 5. `saveApprovedLinkedIn(record, existingFile)` returns a filename in Task 2 and is consumed as one in Task 4 (twice). `listApprovedLinkedIn()` returns an array in Task 2 and is consumed as one in Task 3. `contactIndex` is the integer index into `dossier.contacts` in Tasks 4 and 5 alike. The exemplar record's eight keys are identical in the spec, Task 2's tests, Task 3's exemplar rendering (`recipient_name`, `company_name`, `final_text`), and both Task 4 call sites.

**Running test count:** 7 after Task 1, 12 after Task 2, 27 after Task 3, unchanged thereafter.
