# GovSpring CRM — full audit, 2026-08-14

Scope: every file in `server/` and `public/`, plus deploy config and full git history.
Method: five parallel read-throughs (auth/routing, data layer, Gmail, frontend, deploy/ops),
then empirical proof of the security and data-loss findings against a real instance running
on an isolated scratch data directory. Findings marked **PROVEN** were reproduced, not inferred.

Counts: 11 critical, 13 high, 21 medium, 16 low.

---

## CRITICAL

### C1. Non-admin users can write every secret in the app — PROVEN
`server/server.js:730` (`POST /api/config`) and `:708` (`POST /api/config/key`) have no
`requireAdmin`, while every neighbouring config route does (`:720`, `:942`, `:1008`).
`config.update()` (`server/config.js:48`) merges an arbitrary patch with no key whitelist.

Reproduced with a `role: user` account: `POST /api/config/google` correctly returned
`{"error":"Admin access required"}`; the identical secrets then wrote successfully through
`POST /api/config`, persisting `anthropicApiKey`, `googleClientSecret`,
`watchFolder: "/etc"`, and `backupFrequency: "bogus-value"` — the last also bypassing the
`BACKUP_FREQUENCIES` whitelist that the admin-gated route enforces.

Fix: add `requireAdmin` to both routes; whitelist keys in `config.update()`.

### C2. That leads to full secret exfiltration and instant admin — PROVEN
With `watchFolder` writable (C1), a clerk pointed it at the app's own data directory. The
chokidar watcher (`server/server.js:260-264`, `:285`) ingested internal JSON as prospects,
readable via `GET /api/prospects`. Confirmed leaked: `anthropicApiKey`,
`googleClientSecret`, every `passwordHash` + salt, and **`testLoginSlug`** — the
no-password admin backdoor URL (C3). Clerk → admin in two requests. In production
`gmail-token.json` (OAuth refresh token, full mailbox access) is in the same directory.

Fix: C1 closes the door. Additionally confine `watchFolder` to a subdirectory of the data
dir, or drop the setting (see M17 — the watcher is inert on Railway anyway).

### C3. Passwordless admin account, recreated every boot, exempt from the audit log
`server/users.js:177-197` creates user `test` with `role: 'admin'`, `passwordHash: ''`,
`noLog: true`, and an 8-char slug from 48 bits of entropy. `server/server.js:46` calls it
unconditionally on every startup and prints the URL to the deploy log.
`server/server.js:157-163` mints a 30-day admin session for an unauthenticated GET.

Three compounding facts: the route sits above the `/api` auth gate (`:176`), so it is
reachable with no credentials; the login rate limiter guards only `POST /api/auth/login`
(`:131`), so the slug has unlimited brute-force attempts; and `noLog: true` makes
`mutating()` skip the audit entry (`:226`), so anything done through this account leaves no
trace. The comments at `:6` and `:1102-1106` still describe the old localhost/Tailscale
deployment — with `HOST=0.0.0.0` on Railway this is internet-facing.

Fix: delete `ensureTestUser` and its route, or gate it behind an env var that is unset in production.

### C4. Any unreadable store file is silently overwritten with an empty one on restart — PROVEN
`server/db.js:22-33`, `server/users.js:28-30`, `server/config.js:35-38`,
`server/audit.js:23-25`, `server/catalogs.js:52-54` all use one bare
`catch { save(); }` commented "no file yet". The catch cannot distinguish ENOENT from
EACCES, EIO, or truncated JSON, so it treats corruption as first-run and writes the empty
store over the real file.

Reproduced on all four stores:

| file | before | after one restart |
|---|---|---|
| `govspring.json` | 2 prospects, 1 exclusion | `{"prospects":[],"exclusions":[],"nextId":1,...}` |
| `users.json` | 1 admin account | `{"users":[],"nextId":1}` |
| `config.json` | live `sk-ant-…` key, `backupFrequency:"daily"` | all DEFAULTS |
| `audit-log.json` | 1 entry | `{"entries":[],"nextId":1}` |

The `tmp`+`rename` save succeeds even against an unreadable target, because rename only
needs directory write permission. One permission or I/O blip on the volume during a
redeploy destroys every prospect, every account, and the whole audit history — silently,
with the original bytes overwritten before anyone can look.

Fix: in each `load()`, rethrow unless `err.code === 'ENOENT'`.

### C5. A wiped `users.json` re-opens unauthenticated admin creation
`server/server.js:81-82` gates first-run setup on `users.hasAnyUser()`, which is just
`store.users.length > 0` (`users.js:62`). After C4 empties the file, `POST /api/auth/setup`
is live and unauthenticated — whoever reaches it first owns the CRM. `.session-secret`
survives, so no existing cookie is invalidated to signal anything is wrong.

Fix: C4 closes this; additionally persist a `setupCompleted` marker rather than inferring
first-run from an empty array.

### C6. The emailed backup zip contains the live Gmail OAuth tokens
`server/backup.js:15` excludes only `.session-secret`; `:29-35` redacts only
`anthropicApiKey` and `googleClientSecret`, and only inside `config.json`. The refresh and
access tokens live in a different file — `data/gmail-token.json` (`server/gmail.js:28`,
written verbatim at `:40-44`) — which `walk()` includes with no redaction. The zip is
emailed as a plaintext attachment on a schedule (`server.js:968-974`). The `accessToken` is
immediately usable for the `gmail.modify` scope (read *and* send as the connected account).
The module's own header comment claims it handles "the two secrets that must never travel
in a file"; it missed the more powerful one.

Fix: add `'gmail-token.json'` to `EXCLUDED_FILENAMES`. A restore just re-runs OAuth connect.

### C7. The same zip contains the no-password admin URL and live invite tokens
`users.js:245` `safe()` strips `passwordHash`, `usernameLower`, `inviteToken`, and
`testLoginSlug` — from **API responses only**. The backup ships raw `users.json`, so all
four travel: the never-rotating `testLoginSlug` (permanent admin via one GET, C3), live
48-hour password-setting `inviteToken`s that the code itself calls "same trust boundary as
a password" (`users.js:241-243`), and every scrypt hash.

Fix: strip those three fields from `users.json` in the backup, the way `redactConfig`
handles `config.json`.

### C8. `esc()` does not escape quotes, so every HTML attribute sink is injectable
`public/renderer.js:17` escapes `&`, `<`, `>` — not `"` or `'`. It is used inside quoted
attributes in eight places. The outsider-reachable path is `renderer.js:461`:
`value="${esc(defaultTo)}"` where `defaultTo` derives from the raw `From:` header of an
**inbound email** (`server/gmail.js:362` stores it verbatim). A crafted
`From: Bob <a" autofocus onfocus="…"@evil.com>` runs script in a logged-in staff session.
Same class at `:189`, `:252`, `:339`, `:600`, `:607`, `:820`, and `:175`, fed by uploaded
dossier JSON.

Concrete: a dossier whose `contact_general.website` is
`x" onmouseover="fetch('/api/admin/users/1/password',{method:'POST',…})"` resets an admin
password when anyone hovers the Website field — the session cookie authorizes it.

Fix: append `.replace(/"/g,'&quot;').replace(/'/g,'&#39;')` to `esc()`. One line, all eight sinks.

### C9. The reply poller re-flags every emailed prospect as "replied" every 3 minutes, forever
`server/server.js:659` dedupes on `p.last_reply_message_id`, but `p` comes from
`db.listProspects()`, whose projection (`server/db.js:132-145`) **does not include that
field**. The comparison is always `latest.id === undefined`, never true.

So every 3 minutes, for every prospect with a thread, `db.recordReply` re-sets
`awaiting_reply_review`, rewrites `last_reply_*`, saves the DB, writes an audit entry, and
broadcasts. The Replies tab never empties — a reviewer clears it and it returns within
3 minutes. With ~30 live threads that is ~14,400 audit entries/day against
`MAX_ENTRIES = 50000` (`server/audit.js:11,46`), so **the entire audit log is overwritten
with poll spam in under four days**, evicting every real record of who sent what. Silent
data loss. It also performs one full DB write and one multi-megabyte audit rewrite per
thread per cycle, stalling the event loop — a plausible secondary cause of the reported
send unreliability.

Fix: add `last_reply_message_id: p.last_reply_message_id` to the `listProspects` projection.

### C10. The poller compares Gmail resource IDs against RFC Message-ID headers
`server/server.js:655-658` filters out already-sent messages using `gmail_message_ids`,
which is populated exclusively from `sendResult.gmailMessageId` — the RFC `Message-ID`
**header value** (`server/gmail.js:244-245`). It compares those against `m.id`, the Gmail
API **resource id** (`gmail.js:363`). Two different namespaces, so the filter never matches
and `incoming` is the whole thread. There is also no check that `latest.from` isn't the
connected account.

Result: three minutes after any send, the prospect flips to `awaiting_reply_review` with
`last_reply_from = "marcos@govspringlegal.com"` and an audit entry claiming a reply was
detected. Compounds with C9: fixing only C9 still records one false reply per send.

Fix: filter on sender instead — drop messages whose `from` matches the connected account.

### C11. No timeout on any HTTPS request — the most likely cause of "sending is unreliable"
`server/gmail.js:64-85` passes no `timeout` option, calls no `req.setTimeout()`, and never
aborts. Node's HTTPS client has no default socket idle timeout, so a half-open TCP
connection to `gmail.googleapis.com` leaves the promise pending indefinitely.

A staffer hits Send, `await gmail.sendEmail(...)` (`server.js:482`) never settles, the HTTP
response is never written, the spinner hangs forever, and they have **no way to know
whether the mail went out** — retrying risks a duplicate. Meanwhile `pollForReplies`
awaits sequentially in a `for` loop (`:652-654`), so one hung call stalls the whole run,
and `setInterval(pollForReplies, 3*60*1000)` keeps launching fresh runs behind it, each
accumulating more pending sockets.

Fix: pass `timeout: 20000` in the request options and
`req.on('timeout', () => req.destroy(new Error('Gmail request timed out')))`.

---

## HIGH

### H1. The login rate limiter is fully bypassable — PROVEN
`app.set('trust proxy', true)` (`server.js:58`) makes `req.ip` attacker-controlled, and the
limiter keys on it (`:131`). Reproduced: 5 bad logins → 429; then six requests with
rotating spoofed `X-Forwarded-For` values all returned 401, never 429. Unlimited password
guessing against an internet-facing login form.

Fix: `app.set('trust proxy', 1)` (Railway is a single hop), or key the limiter on username.

### H2. No process-level error handlers — one ENOSPC takes the server down
`grep -rn "process.on"` across `server/` returns nothing. On Node 24 (this runtime) an
unhandled rejection is fatal. The awaited network calls *are* guarded, but synchronous code
outside those blocks is not: `server.js:651` (`db.listProspects()` in async
`pollForReplies`), `:674-681` (all of `checkDormantReturns`, no try at all), `:1039` and
`:1048` (`audit.log` / `config.update` in `checkDigestSchedule`), and `:1051`, which calls
`checkDigestSchedule()` bare at startup with no `.catch()` — so this can produce a
crash-restart loop. Any `writeFileSync` failure inside a timer exits the process and drops
every in-flight send.

Fix: add `process.on('unhandledRejection')` and `('uncaughtException')` that log and keep serving.

### H3. `config.json` is the only store written non-atomically — and its corruption wipes the API key — PROVEN
`server/config.js:44-46` is a plain `writeFileSync`; `db.js`, `users.js`, `audit.js`,
`catalogs.js`, and `gmail.js` all use temp+rename. It holds the Anthropic key, both Google
credentials, digest recipients, and the backup schedule, and is rewritten from timers every
5 and 15 minutes. Truncating it produced a clean startup with no error while `load()`'s
catch (C4) reset to DEFAULTS and *saved* them — key, secret, schedule, and recipients gone
irrecoverably.

Note: SIGTERM alone cannot cause this. `writeFileSync` is synchronous and signals are
delivered between ticks, so a redeploy never half-applies a write. The trigger is ENOSPC,
EACCES, or a host-level crash.

Fix: temp+rename, matching its five siblings.

### H4. Failed sends are deliberately excluded from the audit log
`server.js:488-492` and `:610-614` set `res.locals.skipAudit = true` in the catch, which
`mutating()` honours by returning before `audit.log`. When a send fails, **nothing is
persisted anywhere** — no audit row, not even a `console.warn`. The only record is a 502 in
one browser. This is precisely why "sending has been unreliable" cannot currently be
diagnosed: there is no history of how often it fails, for whom, or with what Gmail error.
The digest path does the opposite and correctly records `digest.missed` (`:1045`).

Fix: replace `skipAudit` with `res.locals.audit = { prospectId: id, detail: 'Gmail send FAILED: ' + e.message }`.

### H5. A background poller can silently disconnect Gmail for the whole team
`server/gmail.js:168-171` calls `clear()` on `invalid_grant`, which `unlinkSync`s the token
file. It is reached from `getThreadReplies` via the 3-minute poller, whose catch
(`server.js:666-668`) only does `console.warn`. All five staff instantly see "Gmail is not
connected" and the only record is one line on stdout — no audit entry, no broadcast.
`error_description` is discarded, so even that line won't say why.

Worth checking as a root cause of the reported unreliability: if the Google OAuth consent
screen is still in **Testing** publishing status, Google expires refresh tokens after
7 days, which reproduces exactly the "worked, then stopped, then worked after a reconnect"
pattern.

Fix: `audit.log({ action: 'gmail.revoked', detail: e.body.error_description })` before `clear()`.

### H6. `isConnected()` can report connected while every send fails
`gmail.js:51-53` checks only for a stored refresh token. `ensureAccessToken` calls
`requireCreds()` (`:150`, defined `:87-93`), which throws when the Google client
ID/secret are absent. Clear or rotate those in Settings with a token file on disk, and
`/api/gmail/status` says `connected: true`, the send screen enables itself, the
`!gmail.isConnected()` gates at `:465` and `:601` pass — then every send fails at the
refresh step. The status the team relies on is wrong.

Fix: `return !!(token && token.refreshToken) && config.hasGoogleCreds();`

### H7. Non-ASCII headers are emitted as raw 8-bit bytes — this fires on every digest and backup
`gmail.js:199-210` (and `:270`, `:274-280`) interpolate `Subject`, `To`, and `Cc` straight
into the header block with no RFC 2047 encoded-word wrapping; no such helper exists
anywhere in `server/`. This is not hypothetical: `server/digest.js:150` and
`server/server.js:971` both build subjects containing U+2014 EM DASH, so every scheduled
digest and every scheduled backup ships a Subject header with raw bytes `E2 80 94`, which
RFC 5322 forbids. Staff-typed subjects and recipient display names ("Ana Muñoz
<ana@agency.gov>", a smart quote pasted from Word) hit the same path.

Unsure whether the Gmail API rejects it or passes it through; what is certain is the spec
violation and that strict clients (Outlook, which government recipients predominantly use)
render mojibake in the subject line.

Fix: one shared helper encoding any value with a byte > 0x7F as `=?UTF-8?B?…?=`.

### H8. No in-flight guard on any scheduler — duplicate backups and duplicate digests
`server.js:960-981` and `:1032-1051` both write their watermark only *after* the send
succeeds, and neither has a running flag. If a backup send takes longer than the 5-minute
interval (very possible given C11 and a base64'd zip), the next tick still sees the stale
`lastBackupAt`, rebuilds the entire zip, and starts a second concurrent send — then a
third, each holding ~4× the zip size in memory. Same on the digest: a slow Monday 06:00
send means a new attempt every 15 minutes, and if they all eventually complete, recipients
get N copies. The startup call at `:1051` plus the interval is a second path to the same
overlap. The comment at `:1029-1031` claims this cannot happen.

Fix: a module-level boolean per scheduler, `try { … } finally { running = false }`.

### H9. Lost update: post-`await` writes derived from a pre-`await` snapshot
`server.js:456`/`:477`/`:500-502` (and `:593`/`:603`/`:617-618`) read `priorIds` and
`followup_count` from a `getProspect` copy taken at request start, then write them back
after a multi-second network `await`. Two concurrent sends on the same prospect (double
click, or an outreach send overlapping a reply send) both read `[A]`; the first writes
`[A,B]`, the second overwrites with `[A,C]`. Message id B is lost from the thread chain, so
the next follow-up builds `In-Reply-To`/`References` off the wrong message and threading
breaks. `followup_count` increments once for two sends, mis-scheduling follow-ups.

Fix: compute the append and the increment inside `db.updateProspect` from the live record.

### H10. Bulk status change applies partially and silently on any failure
`public/renderer.js:1046` loops `await window.api.updateProspect(id, …)` with no
`try/catch` (handler at `:1036-1052`). One failed request (401 after session expiry, 500,
network blip) rejects the loop: the remaining prospects are never updated, the selection is
never cleared, the bulk bar still reads "20 selected", the list still shows old statuses,
there is no undo, and **nothing is shown to the user**. Identical exposure in the delete
branch (`:1039`), where the loss is irreversible.

Fix: `try/catch` the loop body, `toast('Some updates failed: '+e.message)`.

### H11. Bulk selection survives view and filter changes, so Delete can hit invisible rows
`renderer.js:1022`, `:1024`, `:1025` all call `renderList()` without touching
`selectedIds`. Select 5 in "All prospects", switch to "Signed" (0 rows), and the bar still
says "5 selected"; Delete asks "Delete 5 prospect(s)?" and permanently deletes five records
the user cannot see and did not intend.

Fix: in `renderList()`, drop ids not in `filtered` from `selectedIds`, then `updateBulkBar()`.

### H12. `javascript:` URLs are rendered as clickable links
`renderer.js:189` and `:252` emit `<a href="${esc(v)}">` for dossier `website` and
`linkedin`. `esc()` sanitizes characters, not schemes, so
`"website":"javascript:fetch('/api/prospects/1',{method:'DELETE'})"` renders a link whose
click runs script in the app origin.

Fix: only emit an `<a>` when `/^https?:\/\//i.test(v)`, else plain text.

### H13. `logIngest` never saves, and nothing ever reads it
`server/db.js:121-124` pushes to `store.ingest_log` with no `save()`, and in
`ingestDossier` the `save()` at `:116` runs *before* `logIngest` at `:117`; the `duplicate`
and `excluded` branches (`:94`, `:99`) return with no save at all. Proven: after one
ingest plus one duplicate, disk shows `"ingest_log": []`. The field also has no accessor,
no route, and no UI reference — 4 lines and a store key that do nothing but bloat memory.

Fix: delete `ingest_log` and `logIngest`; the audit log already records
`prospect.ingest`/`prospect.upload`.

---

## MEDIUM

- **M1.** Session cookies carry no `Secure` flag — `server.js:91`, `:113`, `:151`, `:161`, `:166`. On an HTTPS-only deployment, add it.
- **M2.** A password reset does not invalidate existing sessions. `server/auth.js` verifies only HMAC validity and 30-day age, so a compromised session survives the reset meant to end it. Add a `passwordChangedAt` claim check.
- **M3.** `POST /api/catalog/:which` (`server.js:745`) is neither admin-gated nor validates `which` — any value other than `'services'` silently overwrites `firm-and-people.md`.
- **M4.** Every audit event rewrites the whole log. Measured at the 50,000 cap: 10.5 MB serialized in 25 ms plus 9 ms write = ~34 ms of blocked event loop *per mutating request*, 21 MB peak on disk while the `.tmp` twin exists. A 50-prospect bulk change is ~1.7 s of synchronous stalling. Append line-delimited JSON instead; trim on load.
- **M5.** `server/zip.js:99-100` hard-throws `ERR_OUT_OF_RANGE` at 65,536 entries (proven), and the scheduled path swallows it into `console.warn` (`server.js:977-979`) — backups then fail forever with nothing anyone reads. Also `config.update({lastBackupAt})` sits inside the `try`, so a failure means the whole zip is rebuilt and re-encoded every 5 minutes with no backoff. Approved-email and reply files accumulate with no cap (`catalogs.js:89-95`, `:111-117`) and watched-dossier files are never deleted after ingest.
- **M6.** `sendStandaloneEmail` posts the base64 attachment to the plain JSON endpoint (`gmail.js:308-312`), not the resumable upload URI, so backups will start failing silently once the zip passes that endpoint's request-size cap (believed ~5 MB, i.e. roughly a 3.7 MB zip).
- **M7.** The backup zip never sets general-purpose bit 11, so UTF-8 filenames fail to extract — proven: `unzip` reports "write error … probably truncated", Python reads `n├▓n-ascii-├▒ame.json`. Reachable via `watched-dossiers/`, whose names are not sanitized. Write `0x800` at `zip.js:56` and `:72`.
- **M8.** `db.js:169` captures `pre_dead_status`, then the allow-list loop at `:181-184` lets the same request overwrite it. `PATCH /api/prospects/:id` forwards `q.body` unfiltered (`server.js:342`), so `{status:'dead', pre_dead_status:''}` destroys it and dead-pile review restores to the wrong state. Remove `'pre_dead_status'` from `allowed`.
- **M9.** `logExternal` (`db.js:258-272`) sets `status = 'sent'` without the attention-flag clearing that `updateProspect:174-180` does for the same transition — logging a phone call on a prospect with a pending reply leaves it stuck in the Replies tab, and on a dormant prospect leaves a stale `dormant_until`.
- **M10.** `defaultFollowupDays` is configurable, persisted, and exposed to the UI, but never applied — `blankProspect()` hardcodes `followup_days: 4` (`db.js:48`) and the UI falls back to `4` (`renderer.js:30`). An admin who sets 10 sees the field remember 10 forever while every prospect still goes due after 4 days.
- **M11.** `pre_dormant_status` (`db.js:228`) and `newsletter` (`db.js:50`) are written and never read anywhere. `returnFromDormant` hardcodes `'sent'` and ignores the field the comment says it exists for.
- **M12.** Backup walks all paths then reads them in a second pass (`backup.js:46-53`), so an admin disconnecting Gmail in between makes `readFileSync` throw ENOENT and the whole backup fails. Per-file reads are also not a consistent snapshot.
- **M13.** No `res.setEncoding('utf8')` in `gmail.js:71-73`; Buffer chunks are string-concatenated, so a UTF-8 sequence split across a ~16 KB TLS boundary decodes to replacement characters — corrupting reply text shown on the review screen and fed to Claude for the draft.
- **M14.** No CRLF stripping on header values (`gmail.js:201-203`); `.trim()` at `server.js:459-461` doesn't remove interior newlines. A subject pasted from a document with an embedded newline splits the header block and Gmail 400s with no hint why.
- **M15.** The outreach body declares UTF-8 but sets no `Content-Transfer-Encoding` (defaults to `7bit`, false for "Muñoz") and never wraps to RFC 5322's 998-octet line limit. `Content-Transfer-Encoding: base64` plus one changed line fixes 8-bit, line length, and bare-LF together — and is less code than the alternatives.
- **M16.** A 401 mid-send is never retried (`gmail.js:226-230`); an access token invalidated server-side before its nominal expiry (password change, session revocation, clock ahead) becomes a hard 502 even though a refresh would immediately succeed.
- **M17.** `chokidar` is inert in production — the watched folder lives on the Railway volume with no way to drop files into it. Removing the watcher and the dependency is the one genuine "less code" win available, and it also closes C2's amplifier.
- **M18.** No Node version pinned anywhere — no `engines`, `.nvmrc`, Dockerfile, or Railway config. The real floor is Node 15.7+, set by `'base64url'` in `auth.js:32` (the session token itself), `users.js:119/135/180`, and six places in `gmail.js`. A silent Nixpacks default bump that broke `base64url` would lock every user out. Add `"engines": {"node": ">=20"}`.
- **M19.** `DATA_DIR` falls back silently to the container filesystem if `RAILWAY_VOLUME_MOUNT_PATH` is ever missing (`server.js:30`) — the app boots happily onto ephemeral storage, creates an empty DB, and discards everything on the next redeploy with no warning. Log the resolved path at startup; refuse to boot without the var in production.
- **M20.** No SIGTERM handler, so Railway's shutdown drops in-flight requests and cuts SSE mid-stream. Low cost at 1-5 users (browsers auto-reconnect SSE), and per H3's note it cannot corrupt files. `server.close()` on SIGTERM.
- **M21.** Frontend failure paths that lie or hang: status-change and follow-up-gap edits keep the new value on screen with no toast when the request fails (`renderer.js:283`, `:290`); "Writing the draft in Marcos's voice…" and "Loading…" stick forever on any error (`:576`, `:416`, `:793`, `:919`, `:949`); a failed `getDeadPile()` makes "Download backup" do literally nothing (`:355`); a 404 in `openDetail` leaves the *previous* prospect's data on screen while the new row highlights (`:194`). Faded toasts are never removed and have no `pointer-events:none` (`:1057`, `:1061-1077`), so they permanently block clicks at bottom-centre/right — and the invisible Undo button stays live, so a stray click minutes later silently reverts the last status change.

---

## LOW

- **L1.** `fail()` (`server.js:306`) returns raw internal error text to the client.
- **L2.** `tryIngestFile` (`server.js:269-281`) abandons a malformed dossier after 5 retries with no log, no audit entry, and no broadcast.
- **L3.** SSE has no heartbeat (`server.js:248-253`); idle proxies may drop the connection.
- **L4.** `nextId` poisons to `NaN` if any record lacks an `id` (`db.js:29` and three siblings) — every subsequent record gets `NaN`, and `find(x => x.id === id)` never matches, so every lookup 404s. Requires a hand-edit, which the design invites. Use `Math.max(m, Number(p.id) || 0)`.
- **L5.** No `fsync` before rename (`db.js:36-40`), so a host/power loss (not a process crash) can commit the rename ahead of the data blocks, yielding a zero-length store — which then feeds C4.
- **L6.** `init()` ordering is an undocumented dependency: only `db.init` creates the data dir (`db.js:16`). Reordering makes `config.load()`'s catch throw an uncaught ENOENT at startup. Move the `mkdirSync` to `server.js`.
- **L7.** Approved-email filenames can collide within the same millisecond (`catalogs.js:92-93`, `:113-114`).
- **L8.** `googleClientId` is not redacted from the backup (`backup.js:32-33`).
- **L9.** A transient blip at Monday 06:00 cancels the whole week's digest — `lastDigestWeekKey` is written unconditionally, including after a caught send failure (`server.js:1044-1048`).
- **L10.** A `Message-ID` read-back failure (`gmail.js:246-248`) permanently breaks threading for that prospect, surfaced only on stdout.
- **L11.** The "Candidates" tab (`index.html:78`) has no listener at all — clicking it does nothing, not even move the `active` class.
- **L12.** No double-submit guard on Log outreach, Add note, or Create user (`renderer.js:312`, `:328`, `:850`) — the two email *send* paths are correctly guarded, these three are not.
- **L13.** The dead-pile review modal stays open (and keeps `.modal-wide`) after the backup downloads (`renderer.js:359-362`).
- **L14.** Dead client API surface: `getStats`, `readCatalog`, `writeCatalog`, `authStatus` (`api.js:38`, `:72-73`, `:86`) — zero call sites; the catalog editing UI does not exist, so those catalogs are only editable on disk.
- **L15.** Two `EventSource` connections per tab for one stream (`api.js:76-84`).
- **L16.** Cosmetic frontend inconsistencies: `#selectAll` never re-syncs after a bulk action (`renderer.js:1031-1035`); status wording differs between list (`new`, `sent`) and toasts (`Not contacted`, `Awaiting reply`) on screen simultaneously (`:121` vs `:16`); "Delete undefined?" when a dossier lacks `company_name` (`:291`, `:597`); the dead-reason prompt is copy-pasted four times and has already drifted (`:280`, `:528`, `:1043`, `:1098`); an `outcome:'excluded'` ingest is silently dropped with no toast (`:1055`); a pending invited user has no Deactivate/Delete action (`:809-814`); an unknown `/api` GET returns `index.html` with status 200 (`server.js:1073`); `SETUP.md` documents only the old local install and `server.js:6`/`:1102-1106` still claim localhost + Tailscale.

---

## Verified clean

- **No secret was ever committed.** All 39 files ever added reviewed via `git log --all --diff-filter=A`; a history-wide path grep across all branches for `data/|.env|token|secret|config.json|users.json|session|.pem|.key|credential` returned nothing; `git grep` for `sk-ant-`/`AIza`/`GOCSPX-`/`BEGIN PRIVATE KEY`/`ya29.` over tracked files: no matches. `.gitignore` correct and `git check-ignore -v` confirms every sensitive path.
- **`zip.js` byte layout is correct** — a 5-entry archive validated with both `unzip -t` ("No errors detected") and Python `zipfile.testzip()` (`None`); all five CRCs matched `zlib.crc32`; `dosDateTime` round-tripped exactly; extraction byte-identical. Only the UTF-8 flag bit (M7) is wrong.
- **Atomic temp+rename is correct** in `db.js`, `users.js`, `audit.js`, `catalogs.js`, `gmail.js` — same-directory temp, so genuinely atomic. `config.js` is the sole exception (H3).
- **Send-then-write ordering is correct.** Both send paths call Gmail first and only touch the DB after it resolves; no path updates the DB for mail that didn't send.
- **`db.js`'s per-record mutators are race-safe** — all re-`find` the live object by id and mutate in place, fully synchronously. `config.update` likewise re-reads the live cache. The only lost-update exposure is a *caller* using a pre-await snapshot (H9).
- **Password hashing is sound** — scrypt, per-user 16-byte salt, `timingSafeEqual` with a length pre-check; the empty-hash trick safely rejects login, so C3's route is the only way in without a password.
- **Route ordering has no auth bypass** — the `/api` gate is registered before `express.static` and every data route; `public/` holds only 6 client assets; the catch-all shadows nothing. No path traversal anywhere: the only `sendFile` is hardcoded and the zip is built in memory.
- **Do-not-contact is enforced before the send** on both paths (`server.js:464`, `:595`).
- **Every path and method in `api.js` matches a real route** (all 50 verified individually), and every response field the UI reads exists on the server side.
- **Text-content escaping is correct everywhere** — reply bodies, snippets, notes, audit details, usernames, the `<textarea>` draft. Uploaded filenames are never rendered. Only *attribute* sinks are affected (C8).
- **No accumulating listeners**, no stale-copy-clobbers-newer-file across modules (each file has exactly one owning module), duplicate detection and `nextId` monotonicity correct, `safeParse` genuinely safe, forward-compat defaults sound for pre-existing records, both cap-and-trim implementations correct, admin gating consistent in the UI.
- **Lockfile in sync**, dependency set matches every `require()` exactly — nothing undeclared, nothing unused. Caret on `express ^4.21.0` cannot pull v5, so the `app._router` walk at `server.js:1083` is safe.
- **Railway bind is correct** — `app.listen` runs last, after all synchronous init, so the port opens only when the app is ready and there is no deploy flap.

---

## Unsure / needs a human check

- Which Node major Nixpacks currently resolves for this service (check the build log) — see M18.
- Whether the `/data` volume's uid/permissions match the app user. This is the most likely real-world trigger for C4.
- Whether the Google OAuth consent screen is still in **Testing** publishing status. If so, Google expires refresh tokens every 7 days, which alone would explain the reported send unreliability — see H5.
- Whether the Gmail API rejects or passes through the RFC violations in H7, M14, and M15.
