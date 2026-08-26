# Outbox: staggered business-hour delivery

Date: 2026-08-26
Status: approved design, not yet implemented

## Problem

Every email in the app sends the instant the SA clicks Send. Two consequences:

1. **Drafting happens at night.** An email finalized at 11pm lands in the prospect's
   inbox at 11pm, where it is read (by both the human and the spam filter) as
   automated bulk mail. Cold outreach delivered outside business hours measurably
   underperforms and is a sender-reputation negative.
2. **Batches leave together.** Working through six prospects in one sitting fires six
   messages from one Workspace account within a few minutes. That burst pattern is
   itself a spam signal, independent of content.

## Goal

Emails finalized outside business hours queue automatically and leave the next morning
starting at 9am NY, spaced at randomized intervals that do not look machine-fired. The
SA can override the computed time, send immediately anyway, or cancel a queued send.

## Decisions (settled with Rafael, 2026-08-26)

| Question | Decision |
|---|---|
| What triggers queuing | Automatic. Anything finalized outside the send window queues by default. The UI always shows the computed send time before the SA commits, so nothing is ever delayed invisibly. |
| Send window | 09:00–18:00 America/New_York. |
| Outside-window handling | Queued to the next window start. Weekends roll to Monday 09:00. |
| Stagger | Randomized 12–25 minute gaps. Not evenly spaced: a fixed cadence is itself detectable. |
| Daily cap | 20 sends per day; overflow spills to the next morning. |
| Scope | Everything queues: cold outreach, follow-ups, and replies. |
| Manual override | The SA can set a specific send time, send now regardless of hour, or cancel. |

Window bounds, gap range, and cap are constants in one place, adjustable without
touching logic.

## Deployment context

Production is Railway (service `WebCRM`, `webcrm-production-4555.up.railway.app`), an
always-on container with a persistent volume at `RAILWAY_VOLUME_MOUNT_PATH`. The
scheduler pattern is proven here already: the reply poll runs every 3 minutes and the
Monday digest every 15 minutes, both on plain `setInterval`, both working in
production.

**The outbox file MUST resolve through `DATA_DIR`**, via the same `init(dataDir)`
pattern `db.js`, `bookings.js`, and `catalogs.js` use. Writing to the repo's `data/`
folder puts it on the container filesystem, where every redeploy would silently destroy
the queue.

## Architecture

### New module: `server/outbox.js`

Owns `<DATA_DIR>/outbox.json`. Same shape as `bookings.js`: `init(dataDir)`, whole file
held in memory (volume is a handful of entries), atomic writes via `store.writeJSON`.

Entry:

```
{
  id, kind: 'outreach' | 'followup' | 'reply',
  prospectId, to, cc: [], subject, finalText,
  services: [], saveToLibrary: bool,
  bookingSlots: [], meetingParticipants: [], baseUrl,
  queuedAt, queuedBy: { userId, username },
  sendAfterISO,
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled',
  sendingSince, attempts, lastError, gmailMessageId
}
```

### The core refactor

`saveFinal` (`server.js:901`) and `reply/send` (`server.js:1248`) are today each one
atomic block: validate, send via Gmail, then record. The **post-validation half** of
each moves into `outbox.performSend(entry)`.

Both the immediate path and the scheduler call `performSend`, so a queued send takes
the identical code path as an instant one — the prospect patch, the activity note, the
voice/reply library save, and the `*.send.failed` audit action all behave the same.
This is the single most important property of the design: there must not be two
divergent send implementations.

**All up-front validation stays at queue time**, in the route, before anything is
persisted: do-not-contact (`blockIfExcluded`), Gmail connected, recipient and subject
present, booking-slot sanity, calendar write access, participant allowlisting. The SA
learns immediately that something is wrong, not at 9am.

### Scheduling

At queue time an entry is stamped with a concrete `sendAfterISO`, so the UI can name the
exact minute:

```
sendAfter = max(nextWindowStart(now), lastQueuedSendAfter + random(12..25 min))
```

clamped into the window; past the window end or the daily cap it rolls to the next
window start. Reuses `calendar.js`'s `nyWallClockToUTC` for NY wall-clock arithmetic —
a fixed UTC offset would drift across the DST boundary, the exact bug the digest
scheduler's comment already warns about.

An SA-supplied explicit time bypasses the stagger computation but is still validated as
future-dated.

### Worker

`setInterval` every 60 seconds (finer than the digest's 15 minutes because stagger
accuracy is the point), plus one run at boot. Each tick sends every entry whose
`sendAfterISO` has passed, one at a time, never concurrently.

**Overdue re-spacing.** Entries that came due while the process was down (a redeploy) are
re-spaced from now using the same gap rule rather than fired together — dumping a held
queue in one second is precisely the burst pattern the feature exists to avoid.

**Crash safety.** An entry is marked `sending` with `sendingSince` before the Gmail call.
On boot, entries stuck in `sending` are reclaimed to `queued` only if no
`gmailMessageId` was recorded. There is no SIGTERM handler today (AUDIT.md M20), so a
redeploy can cut an in-flight send.

**Known limitation, accepted:** a restart landing in the gap between Gmail accepting a
message and the app writing down its id will resend that one email. The window is
milliseconds and closing it properly requires an idempotency key Gmail's API does not
offer. Adding the M20 SIGTERM handler narrows it further and is worth doing separately.

### Booking slots

Offers are minted at **flush** time, not queue time, so no live booking token sits
unsent overnight. `baseUrl` is captured at queue time (the worker has no request to read
it from).

Each slot is re-validated as still-future at flush. A slot that expired while queued
fails that entry loudly — status `failed` with a readable reason, surfaced in the Outbox
view — rather than mailing a dead link. Slots are minted starting tomorrow, so this is
rare, but an overnight queue is exactly the case that can hit it.

### Prospect state while queued

A queued prospect is **not** marked `sent`. It gets a new `kind:'queued'` Activity entry
("Queued for Tue 9:12am") and a badge in the list. `date_sent` and `status` are stamped
by `performSend` at actual send time.

The Activity log must never claim an email left that has not left. This also keeps the
weekly digest's sent-count honest, since it counts the `prospect.email.send` audit
action, which only `performSend` emits.

## UI

**Compose step.** Below the Send button, when the current time is outside the window:
"This will be queued for Tue 9:12am" with an editable time, plus "Send now anyway".
Inside the window, sending stays immediate and unchanged.

**New Outbox sidebar view.** Rows of what is queued: prospect, subject, scheduled time,
status. Per row: edit time, send now, cancel. Failed entries show the reason and offer a
retry. An overdue indicator covers the case where the worker is behind.

## Testing

Matching the repo's existing convention (isolated logic assertions plus live end-to-end
HTTP assertions through the real routes):

- **Scheduling logic, isolated:** after-6pm queues to 9am next day; before-9am queues to
  9am same day; Saturday and Sunday roll to Monday; gaps land in 12–25 min; the 20/day
  cap spills; DST boundary crossing lands on the right wall-clock hour; an explicit past
  time is rejected.
- **Worker, isolated:** overdue entries re-space rather than burst; a `sending` entry
  with no message id is reclaimed on boot; one with a message id is not.
- **End-to-end HTTP:** queue at night, confirm no Gmail send and no `sent` status, no
  `date_sent`; flush with a stubbed Gmail and confirm the prospect record, note, and
  library save match exactly what the immediate path produces; cancel; edit time; send
  now; an expired booking slot fails the entry without sending; a do-not-contact prospect
  is rejected at queue time.
- **Persistence:** the outbox file resolves under `DATA_DIR`, and a queue survives a
  process restart.

## Out of scope

- The SIGTERM handler (AUDIT.md M20) — related, worth doing, but a separate change.
- Per-user send windows. One firm-wide window.
- Warm-up ramping or per-domain throttling.
