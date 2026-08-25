# HANDOFF

## Status: 2026-08-24

**Repo location moved** to `~/Desktop/life-dashboard/areas/GovSpring/sales work/WebCRM`
(git re-initialised there and reconnected to `origin` = GitHub `rkrigerGS/WebCRM`; the old
`~/Desktop/_GovSpring/govspring-web` copy and a stale nested `v2/` duplicate were deleted).

**Deployed (on origin/main, running in production):**
- One-click booking links with real Google Meet events (commit `81c1b31`)
- Secure developer backdoor login (commit `22b059c`) — random token per restart, auto-creates `dev_rafael` admin account. Token is regenerated each server start and printed to the startup log; NOT single-use; no prod/env guard (deliberate).
- Google Calendar write access support (requires `calendar.events` scope; SA must enable Calendar API in GCP and reconnect Gmail)
- Outreach history panel + date picker for external logging + full-screen prospect view (commit `a56f6e1`)
- Audit fixes on the above (commit `aa3abc7`): multi-line emails now show in outreach history (regex was newline-blind); full-screen toggle no longer collides with in-place refreshes (split `activateRow` from `openDetail`); external-log date uses NY timezone, caps at today, and is clamped server-side.
- Watch replies for externally-sent outreach (commit `74445ab`): reply poll now has a
  second pass that matches replies to app-logged-but-Gmail-sent outreach by the prospect's
  own contact address (`gmail.searchRepliesFrom`), since those have no thread id. Bounded
  by send date, reuses the existing recordReply/dedup/broadcast path.

**Setup steps pending (both external, on the SA / Google side — not code):**
1. Enable the Google Calendar API in GCP project `930064057128` at https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=930064057128 then reconnect Gmail in Settings. Until then, calendar availability fails with a ref code (last seen `7debfd`).
2. For the new externally-sent reply watching to work, the prospect must have a contact
   email on its dossier (general or a decision-maker). Prospects with no email can't be
   matched and are silently skipped.

**Unverified (needs live OAuth, same as other Gmail features):** the actual
`gmail.searchRepliesFrom` round-trip against a real inbox. Logic + boot verified locally;
first live test: log an external outreach for a prospect whose contact email you can send
from, reply from that address, wait one 3-minute poll cycle, confirm it appears in Replies.

---

## Editable outreach history + learning (2026-08-24, committed)

Closes a real gap: the "Log outreach sent elsewhere" path (`logExternal`) set `final_sent`
but **never fed the voice library** — only app-sent emails learned (`server.js` send path).
And the outreach-history timeline was read-only, so an outreach logged without the real
message could not be corrected later.

Now: each outreach-history entry is **clickable** → opens an "Outreach details" modal with
the full message editable. Saving records the message; for **email** it also updates
`final_sent` and (default-on checkbox, opt-out) saves the message to Marcos's voice library
so drafting learns from it. Re-editing overwrites the same exemplar (no duplicates that skew
the voice). Phone/LinkedIn entries are editable but never learned.

- Activity outreach entries now carry `{id, channel, message, exemplar_file}`; legacy entries
  (text-only) are targeted by `idx:N` and get a real id on first edit.
- New route `PATCH /api/prospects/:id/outreach/:entryId` (`{text, saveToLibrary}`).
- `catalogs.saveApprovedEmail(record, existingFile?)` overwrites a named exemplar when given
  one (path.basename-guarded), else creates a new stamped file.
- Verified: 6 db-logic assertions + 4 catalogs assertions in isolation, and 11 end-to-end
  HTTP assertions through the live route (ingest → log → edit → learn → overwrite dedup →
  opt-out → empty/unknown → 400s). Server boots clean.
- Files: `server/db.js`, `server/catalogs.js`, `server/server.js`, `public/renderer.js`,
  `public/api.js`.

---

## NEXT UP — Clio Manage integration (design/interview phase, no code yet)

**Goal (Rafael):** push a won client — all their info plus a *signed* retainer agreement —
straight into **Clio Manage** via Clio's API, skipping Clio Grow entirely.

**What the Clio Manage API (V4) gives us (researched 2026-08-24):**
- **Auth:** OAuth 2.0 authorization-code flow. Token endpoint `https://app.clio.com/oauth/token`.
  Access tokens expire (`expires_in` in the token response); **refresh tokens do not expire**
  (store encrypted, same discipline as the Gmail token). Very similar shape to the Gmail
  OAuth we already run — likely a parallel `clio.js` modelled on `gmail.js`.
- **Core objects:** Contacts (`/api/v4/contacts.json`, Person or Company), Matters
  (`/api/v4/matters.json`, links to a client Contact), Documents (`/api/v4/documents.json`).
- **Document upload is multi-step** (confirmed via Clio dev group): create the document
  record → Clio returns a presigned upload URL → PUT the binary → mark fully uploaded.
  Multipart fields `part_number`/`content_length`/`content_md5`; max file size 5 GB.
- **Rate limits / regions:** token-bucket limiter (429 + Retry-After). Regional base hosts
  exist (US `app.clio.com`, plus EU/CA/AU); GovSpring is US → `app.clio.com`. Exact
  endpoint field names + the upload finalize call to be pinned against live docs at build.

**KEY FINDING (2026-08-24) — Clio's e-signature is NOT API-triggerable:**
Rafael asked whether the app could call Clio Grow's e-signature service (send an
engagement/retainer template to a client to sign) via API. Researched: **no.**
- The **Clio Grow API** exposes only lead/contact intake — the legacy Lead Inbox endpoint
  (create lead) plus, on the newer Clio Platform API, Contacts / Contact Notes / "Custom
  Actions" (links added into the Grow UI). There is **no endpoint to send a template for
  e-signature or generate a document from a Grow template.**
- Clio's e-signature (both Grow and Manage) is a **UI-only feature powered by Dropbox Sign**;
  neither product's public API exposes a "send for signature" action.
- Implication: the Grow templates the other clerk is building are usable **only through
  Clio's own UI**, not reachable by our app.
- (Caveat: Clio's API reference is a JS-rendered SPA that couldn't be scraped directly;
  finding is triangulated from the lead-inbox guide, the Manage/Platform handbook, and help
  center. Worth a confirmation to Clio partner support before finalizing.)

**Therefore the signed-retainer path must be one of:**
- **Path A (full automation, no Clio Grow):** integrate an e-sign provider's OWN API
  (Dropbox Sign or DocuSign) — app sends the retainer, receives the signed PDF via webhook,
  then pushes contact + matter + signed PDF into Clio Manage. Templates would live in the
  e-sign provider, NOT Clio Grow (clerk's Grow templates not reused). May need a paid
  Dropbox Sign/DocuSign API plan (the Clio-bundled Dropbox Sign is UI-only).
- **Path B (hybrid, reuses Grow templates):** app creates the contact + matter in Clio
  Manage via API; the clerk sends the retainer for signature from Clio's UI using the
  templates being built; Clio stores the signed doc on the matter automatically. Signature
  step stays manual; no third-party integration.
- **Path C:** app generates the retainer from its own template AND uses an e-sign API (A +
  own doc generation). Most work.
Choosing between these is the first interview decision — it hinges on whether keeping Clio
Grow's template/e-sign workflow matters more than fully automating the send.

**Prerequisites Rafael/firm must provide (not code):**
1. A registered **Clio developer app** (client_id / client_secret + redirect URI) so we can
   run the OAuth connect, mirroring the Gmail client setup. Note: Manage API vs. Clio
   Platform API use different developer-app types — Manage for matters/documents.
2. If Path A/C: an **e-sign provider account with API access** (Dropbox Sign or DocuSign).

**Open product questions for interview mode:** trigger for the push (button vs. status →
"signed"); Person vs. Company contact mapping and which dossier fields map to which Clio
fields; matter naming/practice-area/responsible-attorney defaults; the retainer's source
(uploaded by hand? generated by the app? e-sign provider?); duplicate handling (client
already in Clio); single firm Clio account vs. per-user; error/verification UX.

---

## Historical updates

**Update 2026-08-19 (latest): one-click booking links with real Google Meet events are
built and committed. See "One-click booking links with real Meet events, BUILT" below — including the operational step this needs: Marcos must Disconnect and reconnect Gmail once after deploy to grant the new `calendar.events` scope.**

**Update 2026-08-19: a second batch — error reference codes, the invite-pending
fix, reorderable views, the header cleanup, and the first cut of Google Calendar
availability — is committed and pushed on top of `46ab845`.**

**2026-08-19 (earlier): audit fix batch committed, pushed, and deployed.** Commit `46ab845`
("Harden the CRM: close the audit's 57 findings") is on `origin/main` and was the commit
running in production (Railway service `WebCRM`, project `sunny-illumination`,
`https://webcrm-production-4555.up.railway.app`) before the batch described above.

The sections below are kept for historical record of what changed and why. Everything
under "Next steps" and "Do NOT do" in the original version of this file is done/moot.

## Status in one line

Deployed. Volume (`webcrm-volume` at `/data`) is attached and mounted. `RAILWAY_VOLUME_MOUNT_PATH`
is set, so the M19 boot guard is satisfied. Test-login backdoor (`b9adb3d`) is gone from the
running code.

## Companion file

`AUDIT.md` — the full findings list (C1-C11 / H1-H13 / M1-M21 / L1-L16) that this batch was
scoped against.

## What changed, by file

(unchanged from the original audit-fix pass — see `git show 46ab845` for the authoritative diff)

### `server/store.js` (NEW)
Shared atomic persistence used by every JSON store: `readJSON` / `writeJSON` / `writeText` /
`nextIdFrom`. Temp file + fsync + rename, so a crash mid-write can't truncate a data file.

### `server/server.js`
- Admin gates on `POST /api/config`, `POST /api/config/key`, `GET`+`POST /api/catalog/:which`.
- `CONFIG_POST_KEYS` whitelist on `POST /api/config` so it can't write the two secrets or
  internal bookkeeping keys.
- Test-login backdoor deleted entirely.
- `app.set('trust proxy', 1)`.
- M19 — refuses to boot on Railway with no volume attached.
- M5 — scheduled-backup backoff (15min / 1h / 6h).
- `process.on('unhandledRejection'/'uncaughtException')` safety nets.
- L1 — `fail()` no longer leaks internals to the client.
- L6 — data dir creation moved ahead of all `init()` calls.

### `package.json`
`"engines": {"node": ">=20"}` — real floor is 15.7, pinned to the nearest LTS above it.

### `server/backup.js`
Excludes `.session-secret` / `gmail-token.json` from backups; redacts API keys and Google
client secret; keeps password hashes (scrypt, salted) since stripping them would force a
full team password reset on restore.

### `server/zip.js`
`MAX_ENTRIES` cap with an actionable error; UTF-8 filename bit set for non-ASCII names.

### `server/catalogs.js`
`uniqueStamp()` fixes same-millisecond filename collisions on catalog approval.

### `server/gmail.js`
20s timeout on every Gmail HTTP call; 401-refresh-retry; error surfacing.

### `public/renderer.js`
`esc()` escapes quotes; `safeUrl()` blocks `javascript:` URLs; bulk actions match by id not
name-prefix; double-submit guards; failed loads/saves show errors instead of hanging.

### `public/api.js`
One shared `EventSource` instead of three.

### `public/index.html`
Candidates tab disabled with an explanatory title (no view exists behind it).

## Explicitly OUT of scope (decided, with reasons)

- **M4** — append-only audit log (redesign).
- **M6** — resumable upload endpoint (redesign).
- **M17** — removing the chokidar watcher (load-bearing for the research-folder workflow).
- **L10** — Message-ID threading (design change).

## Known follow-up, not part of this batch

Backup walk (`server/backup.js`) tolerates ENOENT (M12) but not EACCES — one unreadable
directory aborts the whole backup rather than being skipped and reported. Noted during the
original smoke test, deliberately not fixed (failing loudly on an unreadable dir is
defensible; just documenting the gap).

## 2026-08-19 — Gmail connect issue (Marcos)

Not a code bug. Marcos saved a Google OAuth Client ID/Secret and completed the Connect
Gmail flow; the token exchange succeeded, but the underlying Google Cloud project
(`930064057128`) never had the Gmail API itself enabled, so every Gmail API call
(profile fetch, send, reply poll) fails with `Gmail API has not been used in project ...
or is disabled`. Confirmed via `railway logs`.

Fix is on the Google Cloud Console side, not in this repo: enable the Gmail API for that
project, then Disconnect/Reconnect Gmail in Settings so the token picks up the connected
email address.

The "fields disappear after Save" behavior Marcos flagged is expected — the Client
ID/Secret inputs are intentionally never echoed back after saving (security), the
placeholder text just changes to indicate a value is stored.

## 2026-08-19 — UI batch: error reference codes, invite-pending fix, reorderable views, header

Locally smoke-tested (server boots, syntax-checked, exercised via curl — not yet clicked
through in a real browser). Not committed yet.

### Error reference codes (server.js, gmail.js, api.js, renderer.js)
Every unexpected server error now gets a short hex ref (e.g. `ref 383c00`), logged
server-side with the full stack under that ref and returned to the client in the same
error message — `fail()` in server.js does this for any HTTP 500. Background failures
that used to be silent `console.warn`s (Gmail reply polling, OAuth callback, profile
fetch, refresh-token revocation, scheduled backup, Monday digest) now go through a new
`reportIssue(scope, err)` helper that does the same and also broadcasts an SSE `issue`
event; admins see it as a toast with the ref. Repeats of the identical failure re-toast
at most once per 30 minutes (a 3-minute poll loop won't spam the same failure). To debug
a reported ref, `grep '\[<ref>\]' <server log>`.

### Invite-pending self-heal (users.js)
The Users panel showed Marcos as "invite pending" despite him having accepted the invite
and logged in. Root cause: `pending` is a separate stored flag from whether a password
hash exists, and the two can drift (confirmed reproducible: hand-editing a user record to
`pending: true` with a hash already set left it stuck that way — nothing in the normal
flows re-derives it). Fixed by treating passwordHash as the source of truth: on every
`users.json` load, any row that is `pending: true` but already has a password hash is
corrected in place (pending cleared, stale invite token/expiry cleared) and saved. Self-
heals on the next deploy without a data migration — verified locally.

### Reorderable sidebar views (index.html, renderer.js, styles.css)
The sidebar "Views" list (All prospects / Replies / Not contacted / Due for follow-up /
Awaiting reply / Replied / Signed) is now drag-to-reorder. Order is a personal display
preference stored in `localStorage` per browser, not synced through the server or shared
across the team.

### Header: dropped "Prospects"/"Candidates" tabs (index.html, renderer.js, styles.css)
Both were dead — "Candidates" was already disabled with no view behind it, and
"Prospects" was the only real option, so the pair was pure relic. Replaced with a plain
title (`#viewTitle`) that shows the label of whichever sidebar view is currently active
("All prospects", "Replies", etc.), updated on click.

### Not yet done
Real-browser click-through of the drag-reorder and header title change — no browser
automation tool was available in this session. Do that before deploying, same as any
other renderer.js change.

## 2026-08-19 — Google Calendar availability in generated emails

New: the outreach-email guided flow (Settings > generate email on a prospect) can offer
Marcos's actual open times instead of the boilerplate's generic "I'm available next week"
line. Opt-in per email, slots are checkboxes (pick up to 3), same idea as Gmail's own
"offer times you're free" composer feature.

### How it's wired (server/calendar.js, NEW)
No separate Calendar connection. Calendar rides on the existing Gmail OAuth token — the
scope requested on Connect is now `gmail.modify` + `calendar.readonly` together (one
consent screen, one account, one token; see `server/gmail.js`'s `SCOPE` constant). Google
returns the actually-granted scopes on token exchange; that's stored on the token and
checked by `gmail.hasCalendarAccess()`, since an account connected before this shipped
only has the mail grant until someone hits Disconnect/Connect again.

`calendar.getAvailableSlots()` calls the Calendar `freeBusy` API for the primary calendar,
9am-5pm ET, next 5 business days (weekends skipped, today excluded), chunks the free time
into 1-hour blocks, returns up to 10. `GET /api/calendar/availability` exposes this to any
logged-in user (not admin-gated — drafting itself isn't either); it never throws, a
disconnected/unauthorized calendar comes back as `{connected:false, reason, slots:[]}` so
the UI just hides the picker rather than erroring the whole flow.

### Prompt change (emailEngine.js)
`buildDraftPrompt` takes a new `chosenSlots` (array of formatted strings like "Thu, Aug 20,
2:00 PM–3:00 PM ET"). When present, the system prompt tells Claude to replace only the
"I'm available next week" phrasing with those times, keeping the rest of the scheduling
block (Clio link, phone number) verbatim. Empty/absent `chosenSlots` falls back to the
original static boilerplate — no behavior change for anyone who doesn't use the picker.

### Settings (renderer.js)
A "Calendar: connected / not yet granted / connects together with Gmail" status line sits
under the existing Gmail connection block. If Gmail is connected but the token predates
this feature, it tells the admin to Disconnect/Connect again rather than offering a
separate button.

### Verified
Slot math (timezone conversion, weekday filtering, busy-interval exclusion) tested directly
against a mocked Google response — correct EDT offset, correctly excludes a busy hour,
correct labels. Full server boot + `/api/calendar/availability` + `/api/admin/gmail/status`
exercised via curl with no Google connection (both degrade gracefully, no crash). node
--check clean on every touched file.

### Not yet done
No real Google account was used — the actual OAuth reconnect (to pick up the new combined
scope) and a real `freeBusy` call against Marcos's live calendar are unverified. First real
test: Disconnect Gmail in Settings, Connect again, approve both Gmail and Calendar on
Google's consent screen, then open the generate-email flow on any prospect and check the
open-times step appears. Also not yet extended to the reply-draft flow
(`/api/prospects/:id/reply/generate`) — only the main outreach generate flow has the
picker; say the word if replies should offer it too.

## 2026-08-19 — Audit pass on the above batch, 7 findings fixed

A 32-agent audit (dimension review + adversarial verify) was run against the entire
uncommitted batch above before it shipped. 26 findings raised, 16 refuted on verification
(including all 5 raised against the invite-pending fix — that fix held up). 10 survived,
collapsing to 7 distinct fixes, all applied and re-verified:

1. **SSE `issue` events leaked raw internal error text to non-admin browsers**
   (regressed audit finding L1) — `/api/events` had no role gate, so a clerk's tab
   received the same `EACCES`/absolute-path/GCP-project-id detail an admin's toast
   showed. Fixed by tagging each SSE connection with the viewer's role at connect time
   and only broadcasting `issue` events to admin connections — not a client-side
   check, an actual server-side filter. Verified: non-admin stream receives zero
   `issue` events on an admin's 500; admin stream still gets the full message + ref.
2. **An unreadable Google Calendar was reported as "the whole week is free"** —
   `calendar.js` read `.busy` off the freeBusy response without checking for a
   per-calendar `errors[]`, a missing `primary` key, or an unparseable interval, so
   any of those degraded to an empty busy list. Now throws instead of degrading in
   all three cases — verified directly against mocked bad responses.
3. **Draft generation failures got no reference code** — the one thing the user
   named by name ("generate them"). Both `/generate` and `/reply/generate` catch
   their own errors before `mutating()`/`fail()` ever see them; added an explicit
   `reportIssue()` call in each catch block.
4. **Calendar failures were indistinguishable from "not connected yet"** — both
   collapsed to the same `{connected:false}` shape with no ref and no server log
   line. Split into a `notConnected` marker (Gmail/Calendar genuinely not set up —
   stays quiet, no ref, self-explanatory message) versus everything else (gets a
   ref, a logged stack, `failed:true` in the response).
5. **Drag-reorder on the sidebar Views list silently didn't save** — persistence
   lived in the `drop` handler, which only fires when the pointer is released over
   another `.view-item`; releasing on the heading, the gap, or outside the sidebar
   left the on-screen order changed but reverted on reload. Moved the save to
   `dragend`, which always fires.
6. **One root cause produced N toasts** — the reply-poll failure used a per-prospect
   scope key (`gmail.replyPoll.prospect.${id}`), so a single global cause (e.g. the
   Gmail API being disabled, which is production's actual current state) produced
   one toast per prospect every 3-minute cycle. Collapsed to one shared scope;
   measured 100 prospects → 1 toast (was 100).
7. **A latent boot-time crash** — `reportIssue`'s backing state (`recentIssues`, the
   rebroadcast window) was declared after `gmail.init()`'s callsite, which passes it
   as a callback. Nothing hit this yet, but wiring the token-unreadable path (an
   obvious next step) would have thrown `ReferenceError` at boot. Moved the state
   and the `broadcast`/`reportIssue` functions above every `init()` call; the
   `/api/events` route registration itself stayed behind the auth gate.

Full regression suite re-run after the fixes: all admin gates 403, non-admin config
key-free, unauth routes 401 (including `/api/events`), prospect lifecycle intact, backup
zip valid (18 entries, secrets excluded, UTF-8 bit set), invite-pending heal re-verified
by injecting the drift state and confirming a restart fixes it, boot clean with no
audit-coverage warnings, all files `node --check` clean.

## 2026-08-19 (latest) — One-click booking links with real Meet events, BUILT

This closes the "NEXT SESSION STARTS HERE" item below. Rafael picked a **click-driven
Option B**: nothing is written to Marcos's calendar when the email goes out; the real
event (with a Meet link) is created only at the moment the prospect clicks a time.
Participants: an admin-set default list of app users, each pre-checked but deselectable
by the sender on a per-email basis.

**Committed locally, NOT pushed.** See "Before this goes live" below.

### The flow

1. In the draft questions step the SA picks up to 5 half-hour openings, pulled live from
   Marcos's calendar over the next two business days (`calendar.js` now builds 30-minute
   slots, `SLOT_MINUTES = 30`, `LOOKAHEAD_BUSINESS_DAYS = 2`, `MAX_SLOTS = 16`).
2. The draft screen shows which times will be offered and a "Meeting participants"
   checklist (defaults from `config.meetingParticipantIds`, deselectable per email).
3. On send, `saveFinal` mints one booking **offer** (`server/bookings.js`, new JSON store
   at `<data>/bookings.json`) holding an unguessable 40-hex token, the slots, the
   prospect's address and the chosen participants. The email goes out as
   multipart/alternative: the plain-text part lists each time with its URL, the HTML part
   renders them as inline-styled buttons.
4. The prospect opens `/book/<token>` (`public/book.html`, self-contained: no session, no
   app scripts, no styles.css) and clicks a time. `POST /book/<token>/confirm` re-checks
   free/busy, creates the Calendar event with `conferenceData.createRequest`
   (`?conferenceDataVersion=1&sendUpdates=all`, so Google emails the invite), marks the
   offer booked, writes an activity note plus an audit row under the system actor
   `prospect (booking link)`, and pushes a `booked` SSE event to open CRM tabs.

### Deliberate design points (don't "simplify" these away)

- **The offered/approved text and the learning library never contain the booking block.**
  `final_sent` and the approved-email library store exactly what the SA approved; the
  block is appended only to the wire message, so exemplars never learn tokens or URLs.
- **The `/book/*` routes are outside the `/api` session gate on purpose** (the gate is
  `app.use('/api', ...)`), rate-limited per IP (`BOOK_PROBE_MAX = 60`), and audited
  inline. They expose nothing but the offer's own slots.
- **Confirms are serialized** through a single promise chain (`bookingConfirmChain`) so
  two prospects clicking at once can't double-book.
- **Every calendar read failure throws** — an unreadable calendar is never degraded to
  "free". The booking page's load-time re-check is best-effort (page still renders, slots
  just aren't pre-marked taken); the confirm-time check is hard.
- **Participants are intersected server-side with active app users' emails**, so a
  tampered request can't invite arbitrary addresses.
- **Slot validation is strict** at send time (bad/past dates, reversed ranges, blank or
  over-long labels → 400) and `hasCalendarWriteAccess()` is required (→ 409 telling the
  admin to reconnect Gmail).
- The calendar event title has no em dash — it lands in the prospect's invite, and the
  firm's outward-facing writing rule bans them.

### Before this goes live

**Marcos must Disconnect and reconnect Gmail once.** The OAuth scope string in `gmail.js`
now includes `calendar.events` alongside `gmail.modify` and `calendar.readonly`; existing
tokens don't carry it. Until he reconnects, sending *with* offered times is refused with a
clear 409 (sending without them is unaffected), and Settings shows "Calendar: read-only
access. Disconnect and reconnect Gmail to enable one-click booking links."

### What was verified, and what wasn't

Verified in the local sandbox with the Gmail/Calendar modules stubbed: all four
`/book/<token>/data` states (open, booked, stale, unknown token), every confirm rejection
path (unknown token, unoffered time, past slot, already booked, no calendar scope, slot
taken since the email), the confirm happy path end to end (event payload, offer marked
booked, activity note, audit row), slot-validation rejections at send time, participant
filtering (case-insensitive, unknown addresses stripped, deduped), the rate limiter, the
booking page in a real browser (slot selection, `?slot=` deep-link preselect, booked and
invalid states, no JS errors), the draft screen's booking section, and the Settings
"Default meeting participants" block saving through to config.

**Not verified (needs live OAuth):** the actual Google `events.insert` call, whether the
minted Meet link comes back on `conferenceData.entryPoints` or `hangoutLink` for this
account, and `sendUpdates=all` invite delivery. First real test after deploy: reconnect
Gmail, send yourself an email with two offered times, click one, confirm the invite and
Meet link arrive.

## NEXT SESSION STARTS HERE — Google Meet link / calendar event creation

**(Resolved by the section above — kept for the reasoning behind the choice.)**

The calendar-availability feature above only **reads** free/busy and inserts text time
slots into the email ("I'm free Tuesday 2-3pm ET") alongside the existing Clio booking
link. It does **not** create a Google Meet link or a calendar event — Gmail's own "offer
times" feature does both (a Meet link on the invite, and an actual calendar event once
the recipient picks a slot). Rafael confirmed this gap is what he wants closed next.

This is a bigger feature than the read-only version, not a small addition:

- **Needs a new OAuth scope.** `calendar.readonly` (added in the batch above) cannot
  create events. Creating an event with a Meet link needs `calendar.events` (write) on
  the same combined-scope Gmail/Calendar connection in `gmail.js` — another
  Disconnect/Connect round for Marcos once this ships.
- **Needs a product decision on WHEN the event gets created**, which was not yet asked:
  - Option A: create a *tentative* Calendar event (with a Meet link) for each slot
    offered, up front, before the prospect even replies — riskier, since most cold
    outreach emails never get a reply, and it litters Marcos's calendar with holds
    for meetings that never happen.
  - Option B: only create the event once the prospect actually responds picking a
    time — needs a way to capture that response (reply parsing already exists via
    `pollForReplies`) and match it back to one of the offered slots, then create the
    event server-side and reply with the Meet link.
  - Option C: skip real Calendar events; just generate a bare Meet link per offered
    slot (`https://meet.google.com/new`-style ad hoc links don't work for this —
    real Meet links are minted by creating a Calendar event with
    `conferenceData.createRequest`, so this reduces to "create an event with no
    real time enforcement," which is closer to A than a true shortcut).
  Ask Rafael which before writing code — this determines whether calendar.js grows
  a `createTentativeSlot()` (Option A) or the reply-poll path grows new logic
  (Option B, more work but doesn't clutter the calendar with holds).
- **Existing building blocks to reuse, don't rebuild:** `server/calendar.js`'s
  `nyWallClockToUTC`/slot math, `gmail.js`'s `ensureAccessToken()`/`requestJSON()`
  (already exported for exactly this kind of reuse), and the `chosenSlots` plumbing
  already threading through `server.js` → `emailEngine.js` → `renderer.js`'s picker.
  The Calendar Events API endpoint is `POST /calendar/v3/events` with
  `conferenceData: {createRequest: {requestId: ..., conferenceSolutionKey: {type:
  'hangoutsMeet'}}}` and `?conferenceDataVersion=1` on the URL — that's what actually
  produces a Meet link on the response's `conferenceData.entryPoints`.

## Possible future upgrade — visual calendar-grid picker (NOT built, deliberately deferred)

Rafael asked for the exact Gmail-drafting experience: in Gmail, clicking the calendar
icon while composing opens Google Calendar in a side panel showing a visual grid of your
actual calendar, you click-drag to mark which specific blocks you're offering, and Gmail
inserts those as an interactive "Available times" card the recipient can pick from
inline, without leaving their inbox.

**What's built today (the "one-click booking links" feature above) is a lighter,
click-to-book version of this**, not the visual grid: the SA picks slots from a plain
checklist of already-computed 30-minute openings (no visual grid, no drag-to-select), and
nothing is put on the calendar until the recipient clicks a link that lands on a
standalone booking page (`/book/<token>`) outside Gmail — not an inline card in their
inbox. Rafael confirmed this simpler version is enough for now. **If a future request
asks to make it "look and feel like Gmail's own calendar picker," it means building the
following — hand this whole section to Claude verbatim to skip the back-and-forth:**

1. **A visual grid, not a checklist, in the draft questions step.** Replace the
   `slotsBlock` list in `public/renderer.js` (the `.opt[data-kind="slot"]` rows) with an
   actual week/day grid component — hours down the side, days across the top, the SA's
   already-fetched busy/free blocks shaded in, click-and-drag (or click-to-toggle) to mark
   which open blocks to offer. This is a genuinely new front-end component; nothing in the
   current codebase provides a calendar-grid UI, so it needs to be built from scratch (an
   HTML/CSS/JS grid is enough — no need for a calendar library/dependency for a single
   read-only-background + click-toggle grid).
2. **Keep everything server-side exactly as-is.** `server/calendar.js` (busy-interval
   fetch, `nyWallClockToUTC`, `isRangeFree`, `createMeetEvent`), `server/bookings.js` (the
   offer store), the `/book/<token>` + `/book/<token>/confirm` routes, and the
   HTML-button email rendering in `server/server.js` (`bookingHtmlEmail`/
   `bookingTextBlock`) do not need to change. The grid only changes *how the SA picks
   slots* on the draft screen — it still produces the same `bookingSlots: [{startISO,
   endISO, label}]` array that `saveFinal` already validates and turns into an offer.
3. **Optional, more ambitious stretch (only if explicitly asked for): an inline card in
   the recipient's inbox instead of a standalone booking page.** True Gmail-style inline
   "Available times" cards are a Gmail-client-side AMP/rendering feature Google reserves
   for its own product — there is no public API to make an arbitrary sent email render an
   interactive picker inside Gmail's UI itself. The realistic approximation (what's
   already built) is the HTML button email → standalone booking page. Don't attempt a true
   inline-card clone; explain this constraint if asked.
4. **Effort estimate:** the grid component itself is the only new, nontrivial piece —
   call it a solid day of front-end work (grid rendering, click/drag selection state,
   converting selected blocks into the same `{startISO, endISO, label}` shape the backend
   already expects). Nothing else in the stack changes.
