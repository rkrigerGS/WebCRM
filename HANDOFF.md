# HANDOFF — audit fix batch, shipped

**Update 2026-08-19 (latest): a second batch — error reference codes, the invite-pending
fix, reorderable views, the header cleanup, and the first cut of Google Calendar
availability — is committed and pushed on top of `46ab845`. See "NEXT SESSION STARTS HERE"
at the very bottom of this file for the one thing this batch was explicitly deferred on
(Google Meet links) — read that section first, before anything else below.**

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

## NEXT SESSION STARTS HERE — Google Meet link / calendar event creation

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
