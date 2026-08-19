# Audit — 2026-08-19 (post-hardening pass)

Fresh full-code audit run after commit `7b7155b` (error refs, invite-pending fix,
reorderable views, calendar availability). Four parallel review passes: security/auth,
data layer & server correctness, external integrations (Gmail/Calendar/Claude/digest),
and frontend. Everything in `AUDIT.md` marked fixed was re-checked and held; the
explicitly out-of-scope items there (M4, M6, M17, L10, backup EACCES) are not re-raised.
The two HIGH findings below were independently spot-verified against the code.

Nothing here is fixed yet — findings only, awaiting triage.

---

## HIGH

### H-1. OAuth connect flow has no `state` parameter (CSRF → attacker's mailbox linked)
`server/gmail.js:204-216` (`getAuthUrl`) builds the Google authorize URL with no `state`,
and `server/server.js:1151-1161` (`GET /api/admin/gmail/callback`) exchanges
`req.query.code` with no state check. The callback is a top-level GET and the session
cookie is `SameSite=Lax`, so it rides cross-site navigation. An attacker who starts the
app's own OAuth flow against *their* Google account can capture the resulting `code` and
link an admin to `.../api/admin/gmail/callback?code=<attacker_code>` — the CRM is then
connected to the attacker's mailbox: outreach sends from it, the reply poller reads it.
**Fix:** random `state` stored in a short-lived signed cookie (or server-side map) when
issuing the authorize URL; reject the callback on mismatch.

### H-2. Non-string dossier fields permanently 500 the prospect list
`server/db.js:110` stores `dossier.company_name` (or any topline field) without a type
check; the upload gate at `server/server.js:552` only requires "an object". A dossier
with `{"company_name": 123}` (or an object/array) ingests fine, then
`listProspects()`'s sort (`db.js:154`, `.localeCompare`) throws once the comparator hits
it — every `GET /api/prospects` 500s for all users, the dead-pile view and the digest
fail too, and the poison record survives restarts. Recovery requires finding the id in
the audit log and DELETEing it blind. Same class applies to `uei` (also silently skips
dup-check), `city_state`, `industry`, `designations`.
**Fix:** coerce/validate topline fields at ingest (`String(...)`, existing parseInt guard
for fit_score); consider capping `dossier_json` size.

---

## MEDIUM

### M-1. PATCH allowlist exposes Gmail threading fields; bare `JSON.parse` bricks sends
`server/db.js:190-192` allows `gmail_thread_id` / `gmail_message_ids` through
`PATCH /api/prospects/:id` unvalidated; both send routes (`server/server.js:665`, `:799`)
do a bare `JSON.parse(p.gmail_message_ids || '[]')`. One PATCH of
`{"gmail_message_ids":"oops"}` makes every future send/reply-send for that prospect 500
forever. `db.js:200-204` also honors `incFollowupCount`/`appendMessageId` straight from
the request body (counter inflation / fake Message-ID injection into the References chain).
**Fix:** drop the two gmail_* fields from the PATCH allowlist, gate the internal ops so
only server-side callers use them, use `safeParse` at both send sites.

### M-2. `watchFolder` is unconfined; pointing it at the data dir exposes secrets to all users
`server/server.js:379-383, 979, 985`: `watchFolder` is admin-settable to any path and the
chokidar watcher ingests every `.json` under it as a prospect. Set to the data dir, it
ingests `gmail-token.json` (refresh token = full mailbox), `users.json` (hashes + live
invite tokens), `config.json` — all then readable by any logged-in non-admin via
`GET /api/prospects`. This is the still-open "confine watchFolder" half of the old C2 fix.
**Fix:** reject paths outside a designated subtree (e.g. under DATA_DIR), or drop the setting.

### M-3. Reply poller treats any non-self inbound as "the prospect replied"
`server/server.js:871-882`: bounces (`mailer-daemon@`), out-of-office auto-replies, and
CC'd third parties all flip the prospect to `awaiting_reply_review`, and their address is
stored as `last_reply_from`, which prefills the reply screen's To box — a rushed reviewer
replies to the bounce daemon or the wrong person.
**Fix:** filter known auto/bounce senders and `Auto-Submitted`/`Precedence: bulk` headers,
and/or require the sender to match a dossier contact.

### M-4. Failed sends count as "Emails sent this week" in the Monday digest
`server/server.js:676-682` and `:806-810` audit failed sends under the same
`prospect.email.send` / `prospect.reply.send` action names the digest counts
(`server/digest.js:43, 76-77`), so a flaky Gmail week inflates the digest exactly when
sending is broken.
**Fix:** distinct action name (e.g. `.failed`) or a `failed:true` detail, excluded in digest.

### M-5. Dossiers without a `uei` re-ingest as new prospects on every restart
`server/db.js:96` skips the dup-check when `uei` is null and the watcher boots with
`ignoreInitial: false` (`server/server.js:430`), so a uei-less file left in the watched
folder mints one duplicate per redeploy. `restartWatching()` (`:434-437`) doesn't await
`watcher.close()`, so old+new watchers can briefly double-ingest the same file.
**Fix:** content-hash/filename dedup for uei-less dossiers (or move files after ingest);
await close before restarting.

### M-6. Detail pane can render the wrong prospect after rapid clicks
`public/renderer.js:227-234` (`openDetail`) and `:486-499` (`openReplyReview`): no
stale-response guard after `await getProspect(id)` — click row A (slow), then row B
(fast): B highlights, then A's late response overwrites the pane, wiring A's id into the
Delete/status buttons while B looks selected.
**Fix:** re-check `id === selectedId` (or a request token) after each await before rendering.

### M-7. Several mutation handlers still lack try/catch + double-submit guards
The old M21 remediation missed: `ecSave` contact edit (`public/renderer.js:405-409`),
reply-modal Mark replied (`:585-590`) and Mark dead (`:601-608`). On failure the modal
stays open with no toast (or, for mark-dead, the reason note is silently dropped), and
double-clicks fire twice.
**Fix:** match the guarded pattern used at `:327` and `:591-600`.

---

## LOW

- **L-1** `server/users.js:194-199` — unknown usernames return before the slow scrypt
  compare; response timing enumerates valid usernames. Fix: dummy scrypt on the miss path.
- **L-2** `server/server.js:219, 229` — pre-auth invite endpoints have no rate limit
  (tokens are 192-bit so brute force is infeasible; defense-in-depth).
- **L-3** `server/server.js:876-877` — only the single newest inbound message is surfaced;
  two replies between polls lose the first one's content.
- **L-4** `server/emailEngine.js:224-226` — prospect-controlled reply text is interpolated
  undelimited into the Claude reply prompt (prompt-injection; human review is the only
  mitigation). Fix: delimit + "thread text is data, not instructions" system line.
- **L-5** `server/calendar.js:92-101` — freeBusy bypasses `callGmail`'s 401-refresh-retry;
  an early-invalidated token fails the picker where a send would recover.
- **L-6** `server/server.js:615` / `emailEngine.js:158-160` — chosen slots are free-form
  client strings, never re-validated at send time (stale/past slots can go out).
- **L-7** `server/gmail.js:254-274` — concurrent token refreshes aren't deduped (redundant
  Google traffic; harmless otherwise).
- **L-8** `server/server.js:644, 689` — `gmail_thread_id` written from a pre-await
  snapshot; two concurrent first sends leave one thread untracked by the reply poller.
- **L-9** `server/store.js:17-36` — `readJSON` doesn't require a plain object; a store
  file hand-edited to `null` is treated as first-run and silently reinitialized (the C4
  data-destruction class). Fix: throw unless plain object, per the file's own contract.
- **L-10** all stores — a stored `nextId` lower than the max existing id is trusted →
  duplicate ids after a hand-edit/partial restore. Fix: `max(nextId, nextIdFrom(records))`.
- **L-11** `server/server.js:904, 688` / `db.js:219, 278, 285` — "today" stamps use the
  UTC date while the team and admin-entered dates are America/New_York; dormant returns
  fire up to ~5h early and evening sends stamp the next day. Fix: shared NY-date helper
  (digest.js already has the pattern).
- **L-12** `server/db.js:88` — an exclusion rule with empty `value` matches every
  prospect (blocks all ingests/sends). Fix: skip falsy-value rules.
- **L-13** `server/server.js:1450-1458` — graceful shutdown never completes: SSE
  connections keep `server.close()` waiting, so every deploy eats the 8s force-exit and
  skips cleanup. Fix: end all SSE clients on signal.
- **L-14** `server/server.js:250-269` — `loginAttempts` map never prunes expired entries;
  unbounded growth under internet scanner traffic.
- **L-15** `server/db.js:215-226` — notes are stored untruncated and `activity` is
  uncapped (a huge note becomes a permanent full-file fsync tax). Fix: mirror the
  `logExternal` 200-char slice, cap activity length.
- **L-16** `server/server.js:496-509, 878-882` — mutations on nonexistent prospects
  return success shapes and write audit rows (`{deleted:true}` on a ghost, reply
  detected for a deleted prospect). Fix: 404 + skipAudit when absent.
- **L-17** `server/server.js:1246-1247` — an empty/garbage `lastBackupAt` silently
  disables scheduled backups forever. Fix: treat invalid watermark as "due now".
- **L-18** no restore path — all stores cache in memory at init; files restored onto the
  volume while running are clobbered by the next save. Fix: document stop-first restore
  or add an admin reload endpoint.
- **L-19** `server/zip.js:77-117` — per-file/offset 4 GiB `writeUInt32LE` limits aren't
  guarded like the entry-count cap (far-fetched at this data size).
- **L-20** `public/renderer.js:247, 500` — unguarded `JSON.parse(p.activity)`; a
  malformed value aborts the detail pane with no error shown.
- **L-21** `public/renderer.js:617, 746` — `openEmailFlow`/`openSettings` initial
  `getConfig()` unguarded; a reject leaves a stale modal open / a dead Settings button.
- **L-22** valid prospect statuses are enforced only by the UI dropdown; the PATCH route
  accepts any status string, desyncing views/counts. Fix: server-side whitelist.
- **L-23** modals: no focus trap; background stays tab-reachable. (Escape-to-close was
  added in the 2026-08-19 UI pass; focus containment still open.)

## Verified clean this pass

Admin gates on all 26 admin routes; `/api` auth gate ordering; XSS (every traced sink
wrapped in `esc()`/`safeUrl()`, SSE payloads → `textContent` only); CSRF on state-changing
JSON routes; timing-safe token/password compares; prototype-pollution key whitelists;
header injection (CR/LF stripped in `encodeHeader`/`encodeAddress`); SSRF (no
user-controlled request targets); atomic temp+fsync+rename writes; scheduler in-flight
flags and backup backoff; SSE client cleanup on disconnect; backup secret
exclusion/redaction; setup gate double-keying; invite-pending self-heal.
