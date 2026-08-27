# LinkedIn outreach: drafting, hand-off, and voice recency

Date: 2026-08-27
Status: approved in conversation; awaiting spec review

## Problem

The SA reaches prospects by email through the CRM, with Claude drafting from a library of
approved messages. LinkedIn is already a recognised channel — the external-touch logger offers
`email | linkedin | phone`, and the prospect detail already renders per-person LinkedIn links —
but there is no drafting, no learning, and no delivery path. A LinkedIn message is written
somewhere else, pasted somewhere else, and teaches the system nothing.

Separately, the email voice library grows but does not improve. `rankExemplars` sorts on exactly
one signal — how many chosen services an exemplar shares — and `buildDraftPrompt` takes the top
six. There is no recency and no seed decay, so a message approved in January ranks identically to
one approved last week, and the ten `seed_*` exemplars stay eligible forever. The library gets
bigger; the voice it teaches does not move toward current-Marcos.

## Goal

The SA drafts a personalised LinkedIn message inside the CRM, reviews and edits it, approves it,
and lands on the right LinkedIn page with the text on the clipboard. The approval feeds a LinkedIn
voice library that is separate from email's. Both libraries start teaching recent voice rather
than merely matching voice.

## Decisions (settled with Rafael, 2026-08-27)

| Question | Decision |
|---|---|
| Delivery | Hand-off. The CRM drafts, the SA sends as themselves on LinkedIn. No automated sending. |
| Why not automated | Every working option is unofficial and session-based. LinkedIn's User Agreement §8.2 prohibits it, 2026 enforcement suspends on first violation, and in March 2026 LinkedIn permanently banned a vendor's founder personally. The asset at risk is Marcos's own profile. |
| Recipient | Always a named person from `contacts[]`. Never a company. |
| Destination | Independent of recipient: the person's `/in/` URL when present, else the company `/company/` page, else copy-only. |
| Message library | One LinkedIn library, separate from email's. No person/company split. |
| Prospects with no contacts | The action is disabled with a stated reason, not hidden. A personalised message needs a person. |
| Questions | Unchanged for this spec: the existing deterministic `buildQuestions`. Learned suggestions are a later spec. |
| Voice recency | Ranking gains recency and seed decay. Applies to email and LinkedIn alike. |
| Outbox | Not used. Hand-off is synchronous by definition. |

## Baseline, measured

Read from the code, not estimated:

- `emailEngine.buildQuestions(dossier)` is fully deterministic — no model call. Framing options come
  from `dossier.issue_spotting[]` plus a "General introduction" fallback; service options come from
  the catalog, with `suggested: true` when a service's `fitHints` appear as substrings in a haystack
  of issue titles, explanations, designations and industry.
- `emailEngine.rankExemplars(approved, chosenServices)` sorts only by service-overlap count.
  `buildDraftPrompt` takes `ranked.slice(0, 6)`.
- Every approved record already carries `saved_at`, so recency ranking needs no migration and no
  backfill.
- `catalogs.uniqueStamp()` returns `${Date.now()}_${hex}`, so exemplar filenames are chronological.
- `db.logExternal(id, { channel, text, loggedAt })` already accepts `channel: 'linkedin'`: it appends
  an activity entry carrying `id`, `date`, `channel` and the full `message`, sets `status='sent'`,
  `channel`, `date_sent`, and clears the attention flags. Its one email-specific line
  (`if (channel === 'email' && !p.final_sent)`) correctly leaves `final_sent` alone for LinkedIn.
- `server.js:762` already guards voice-library learning on `result.entry.channel === 'email'`, so
  LinkedIn touches have never polluted the email library. The per-channel seam exists; email is
  simply the only channel with a library behind it.
- `renderer.js` already renders company LinkedIn (`c = d.contact_general`) and each decision-maker's
  `ct.linkedin` as a real anchor guarded by `safeUrl()`.
- There are no tests in this repository: no test script, no test files.

## Data contract

Supplied by the research agent, 2026-08-27. Two distinct facts about two distinct entities:

- `<root>.contact_general.linkedin` — the **company** page. 62 of 87 dossiers populated; 61 of those
  are `/company/` URLs.
- `<root>.contacts[i].linkedin` — an **individual person's** profile. 101 of 257 contacts populated;
  all 101 are `/in/` URLs.

`contacts` is optional at the top level: it may be absent or an empty array, and holds at most five
objects. Every object carries all nine keys and no others: `name`, `title`, `role` (`CEO|GC|other`),
`email`, `email_verified`, `phone`, `phone_verified`, `linkedin`, `source` (`internal|vibe_prospecting`).

**Absence is the empty string, never null and never a missing key.** Existence checks are therefore
useless; truthiness on the value is the only valid test. This holds for `email` and `phone` too.

Known format variance among populated person URLs: 14 have no trailing slash, one uses `http://`,
one uses a country subdomain (`jm.linkedin.com`). All three pass `safeUrl()`, which permits
`http:`, `https:` and `mailto:` with no host restriction.

Two known data defects, being corrected at source: one contact holds a company vanity URL in the
person field, and one `contact_general.linkedin` holds an `/in/` URL. A company vanity slug is
structurally identical to a personal one, so neither is programmatically detectable. The design
does not attempt to detect them.

**One guarantee this design leans on:** values are always absolute URLs, never bare slugs.
`safeUrl()` resolves its input against `window.location.origin`, so a bare slug would silently
become a link back into the CRM and pass the protocol check. The contract forbids this; a test
pins the behaviour so a regression at source surfaces as a failure rather than a bad link.

## Architecture — A: LinkedIn drafting

### New module: `server/linkedinEngine.js`

Mirrors `emailEngine.js` in shape and is deliberately smaller. Exports `buildDraftPrompt` and
`generateDraft`. It **reuses** `callClaude` and `rankExemplars` from `emailEngine` rather than
copying them; both are added to `emailEngine`'s exports. No subject generation, no reply drafting,
no booking slots.

The prompt differs from email in kind, not degree: no subject line, no formal salutation or
signature block, materially shorter, and it opens on the person rather than the company. It
receives the chosen contact's `name`, `title` and `role`, the chosen issue, the chosen services,
and the ranked LinkedIn exemplars.

### The exemplar record

New directory `data/approved-linkedin/`, alongside `approved-emails/`. Same file mechanics:
`${uniqueStamp()}_${company}.json`, written through `store.writeJSON`, overwritable in place when
an existing message is re-edited so re-edits do not accumulate duplicates.

```json
{
  "company_name": "Nava PBC",
  "recipient_name": "Charles Carey",
  "recipient_title": "General Counsel",
  "recipient_role": "GC",
  "services": ["Bid Protests"],
  "first_draft": "...",
  "final_text": "...",
  "saved_at": "2026-08-27T14:02:11.000Z"
}
```

Recipient identity is stored because a LinkedIn message is personal — title and role are what the
prompt personalises on, and they are what a future ranking pass would match against.

`catalogs.js` gains `listApprovedLinkedIn()` and `saveApprovedLinkedIn(record, existingFile)`,
mirroring the email pair exactly, and `init()` creates the directory.

### Flow

1. Prospect detail offers **Draft LinkedIn message**.
2. If `contacts` is absent or empty, the action is present but disabled, with the reason stated:
   there is no person to address.
3. **Contact picker first.** The up-to-five decision-makers, each showing name, title, role, and
   whether a personal LinkedIn URL exists. The choice drives personalisation and the default
   destination.
4. Framing and services, from the existing `buildQuestions(dossier)`, unchanged.
5. Generate. The SA reviews and edits freely.
6. Approve.

A live character count sits under the draft with the 300-character mark shown, because a
connection-request note caps at 300 while a message to an existing connection does not. This is a
readout, not a mode: the SA sees whether the draft would fit as a connection note and decides in
LinkedIn. No separate draft type.

### Hand-off and logging

Approving performs four things in one action:

1. Copies `final_text` to the clipboard.
2. Opens the destination in a new tab — the chosen person's `/in/` URL when truthy, else
   `contact_general.linkedin`, else no tab and copy-only, stated in the UI.
3. Calls `db.logExternal(id, { channel: 'linkedin', text: final_text })`, which records the
   activity entry and moves the prospect to `sent`.
4. Saves the exemplar via `catalogs.saveApprovedLinkedIn`, and records the filename on the entry
   through the existing `db.recordEntryExemplar`.

Clipboard write and tab open are best-effort and must not block logging: a blocked popup or a
denied clipboard permission still leaves a correctly logged outreach and a saved exemplar, with the
text selectable on screen as the fallback.

### Learning from later edits

`server.js:762` currently reads `if (saveToLibrary && result.entry.channel === 'email')`. It gains a
`linkedin` branch routing to `saveApprovedLinkedIn` with the same `existingFile` semantics. Editing
a logged LinkedIn message therefore improves the LinkedIn library exactly as editing an email
improves email's, without duplicating exemplars.

## Architecture — B: voice recency

`rankExemplars(approved, chosenServices)` gains two signals beyond service overlap, in this
precedence:

1. **Service overlap** — unchanged, still primary.
2. **Recency** — `saved_at` descending, breaking overlap ties. Present on every record already.
3. **Seed decay** — once the library holds at least twelve non-seed exemplars, records with
   `seed: true` sort last. Below that threshold seeds rank normally, so a cold library still has
   examples to teach from.

The twelve-record threshold is a constant in one place with the reason recorded beside it: the
prompt takes six exemplars, so twelve is the point at which real approvals can fill the window
twice over and seeds are no longer load-bearing.

This changes ranking only. The prompt still takes six, and both channels call the same function, so
email gains the improvement at the same time as LinkedIn.

## Reuse

Explicitly shared rather than duplicated: `callClaude`, `rankExemplars`, `buildQuestions`,
`store.writeJSON`, `db.logExternal`, `db.recordEntryExemplar`, `safeUrl`, and the existing
`emailModal` shell that the flow already renders into. The new surface is one server module, two
catalog functions, one renderer flow, and one branch in an existing route.

## Tests

The repository has no tests today. This spec adds `node --test` using Node's built-in test runner —
`package.json` already pins `>=20`, so this costs zero dependencies and holds the no-compilation
promise. A `"test": "node --test"` script is added.

Coverage is the pure logic, which is where the defects would be silent:

- `rankExemplars`: overlap still dominates; recency breaks ties; seeds sort last past the threshold
  and rank normally below it; an empty library returns empty rather than throwing.
- Destination selection: person URL preferred; company page when the person's is `""`; copy-only
  when both are `""`; and the contract's variance cases — no trailing slash, `http://`, country
  subdomain — all yield a usable absolute URL.
- The bare-slug case: a non-absolute value must not produce a link into the CRM's own origin.
- `buildDraftPrompt`: the chosen contact's name, title and role reach the prompt; exemplars are
  capped at six; a prospect with no services still produces a valid prompt.
- Exemplar save: `existingFile` overwrites in place rather than creating a second record.

Behavioural checks that need the running app — clipboard, tab opening, the character readout — are
listed for the rendered pass, not asserted here.

## Verification

```sh
node --check server/linkedinEngine.js
node --check public/renderer.js
npm test
```

Then, in the running app: draft to a contact with a personal URL, one without, and a prospect with
no contacts at all; confirm the activity entry, the saved exemplar, and that re-editing a logged
message overwrites rather than duplicates.

### Known verification limit

There is no browser in the implementing session. The clipboard write, the new-tab open, popup-blocked
behaviour, and the character readout are **not verified by the implementer** and are the user's
check. This is stated rather than assumed.

The local checkout's approved-email library is eleven records, all eleven seed-flagged, so seed
decay cannot fire against local data at any threshold. Its unit tests therefore construct their own
fixtures rather than reading the library, and the real-world effect is only observable against the
production volume.

## Risks

| Risk | Mitigation |
|---|---|
| A company vanity URL sits in a person field | Undetectable by contract; the SA sees the destination before it opens, and it is being fixed at source |
| Popup blocker swallows the destination tab | Logging and exemplar save happen regardless; the URL stays visible and clickable in the UI |
| Seed decay fires too early on a small library | Threshold is one constant with its reasoning recorded; below it seeds rank normally |
| Recency crowds out a better-matched older exemplar | Overlap stays the primary sort; recency only breaks ties |
| A prospect has contacts but none with any LinkedIn URL | Still draftable — recipient and destination are independent; the flow falls back to copy-only |

## Out of scope

Automated sending of any kind, connection-request automation, InMail, LinkedIn reply ingestion,
outbox scheduling, learned question suggestions, AI-proposed options with accept/decline signal, and
growing the issue, services or personal-facts libraries. Those are separate specs, in that order.
