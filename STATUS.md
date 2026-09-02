# WebCRM — current status

Last reviewed against the live codebase: 2026-09-02. Repo is on `main`, up to date with
`origin/main`, clean working tree.

## Deployed and working

- Prospect list/detail, outreach drafting (email + LinkedIn) via Claude, voice libraries
  that learn from approved sends.
- One-click booking links: prospect picks an offered time, a real Google Calendar event
  with a Meet link is created only on click (`server/bookings.js`, `public/book.html`).
- Google Calendar availability in outreach drafts (opt-in slot picker).
- Gmail send + reply polling, including matching replies to externally-logged outreach.
- Unified per-prospect Activity log (outreach, notes, status changes), editable history
  that feeds the voice library.
- Admin/security hardening from the 2026-08-14 and 2026-08-19 audits (see
  `docs/audits/`) — all HIGH/CRITICAL findings from both fixed and re-verified in code as
  of today (e.g. OAuth `state` CSRF protection is present in `server/gmail.js`).

## Open — external/operational (not code)

- Confirm whether Marcos has actually reconnected Gmail since the `calendar.events`
  scope was added — the code requests the right combined scope
  (`server/gmail.js:31`), but only a real reconnect grants it. Until then, sending
  *with* offered times is refused with a 409; sending without them still works.
- Live-OAuth paths never verified against a real Google account: `gmail.searchRepliesFrom`
  round-trip, and the booking flow's real `events.insert` / Meet link shape.

## Hardening backlog — 7 of 8 items FIXED 2026-09-02 (not yet deployed)

Implemented from `webcrm-hardening-spec.md` on branch `hardening-backlog`. Seven of the
eight deferred audit items are closed; item 6 is explicitly re-deferred with triggers
(below). Each item has a recorded pre-fix reproduction and post-fix re-verification.

**1. Host-header link spoofing — FIXED.** One canonical origin resolved once at boot
(`config.resolveBaseUrl`), used by every outbound link. Resolution order: `APP_BASE_URL`
env var → `baseUrl` in config.json → `http://localhost:$PORT` in non-production only. In
production with neither set the app **refuses to boot** rather than falling back to the
request header. The spec's warning not to fix only the two reported lines was correct:
a full-tree grep found **four** sites, and the two unreported ones were the worse pair —
the unauthenticated password-reset link (`/api/auth/forgot`, the actual attack path) and
the booking URLs embedded in outreach emails sent to prospects. `X-Forwarded-Host` is
ignored too, which trusting the proxy would not have achieved.

**7. Dev backdoor — FIXED, and this changes your access.** The route is now **not
registered at all** unless `ENABLE_DEV_LOGIN=1`, replacing the old "deliberately no
production guard" stance. The shape is now a **single-use, 30-minute magic link** printed
whole into the startup log: copy it, open it, you are in — and it dies on first use.

Single use is what makes a token in a URL acceptable at all. The copies it leaves in
Railway's access logs, the proxy's logs, browser history, and the `Referer` of the next
link clicked are all inert the moment it is followed. That is strictly safer than the
original backdoor, which was a URL token that stayed valid and **reusable** for the whole
process lifetime. On top of single use: a 303 redirect so the token leaves the address bar,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, 5 attempts per IP per 15 min
(down from 60/hour), and an audit row with IP and user-agent for every attempt (failures
were previously invisible). Using a link mints the next one, so the log always holds exactly
one live link; following an expired link also mints a fresh one, so a stale copy is
self-healing rather than a dead end.

Confirmed the auto-created `dev_rafael` account gets 32 random bytes as its password, never
stored in plaintext or returned, so it cannot be used through the normal login form.
**Set `ENABLE_DEV_LOGIN=1` when you need it** — at `0` or unset, that path 404s. A value
that is neither `0` nor `1` (e.g. `true`) leaves it disabled and now warns at boot, since
the moment you would otherwise discover that is while locked out.

**3. Native prompt/confirm/alert — FIXED.** New `public/ui.js`: promise-based
`ui.alert/confirm/prompt/toast` plus `setBusy`, dependency-free, reusing the
existing `.modal`/`.btn` classes. The true call-site count was **23, not the ~15
estimated** — and two of them were in `api.js`, not `renderer.js` (found by the new
regression guard, not by the original grep, because they were `window.`-qualified). Two
sites got better inputs rather than a prettier text box, per the spec: the dead reason is
now a fixed `<select>` (`DEAD_REASONS`) with an "Other" escape hatch, because free-typed
reasons cannot be aggregated by the dead-pile review they exist for; and the dormant
return date is a real date picker with an ISO check and a no-past-dates bound.
`window.prompt`'s null-on-cancel vs `''`-on-empty distinction is preserved exactly.

**5. Modal ARIA and focus — FIXED.** The dialog shell provides `role="dialog"`,
`aria-modal`, `aria-labelledby`/`aria-describedby`, focus move on open, a Tab/Shift-Tab
trap, Escape-to-close, focus restore in a `finally`, and `inert` on `#appRoot`. All
**five** existing modals (the spec said three) were retrofitted onto it via
`showModal`/`hideModal` — 38 raw `.hidden` toggles routed through the shared lifecycle.

**4a. openEmailFlow wrong-prospect race — FIXED.** The spec was right to reclassify this
from polish to data correctness. A monotonic `flowSeq` guard now drops superseded
responses in both the email and LinkedIn flows (they share the counter because they share
`flowState` and the same modal). Same pattern applied to Settings, Users, and Audit.
Reproduced and re-verified in a real browser with a deliberately slowed fetch.
*Deviation:* the spec's server-side half does not fit this codebase — it assumes question
ids are posted back, but `saveFinal` posts `finalText` + `meta` and the recipient is a
field the SA can legitimately edit, so validating recipient-belongs-to-prospect would
reject valid sends. The client guard fixes the root cause (the render mismatch); after it,
no path exists where the payload's parts disagree. A per-flow server token is available as
defence-in-depth if you want it — say so and I'll add it.

**4b. Loading and error states — FIXED.** `loadProspects()` catches its own failure and
shows a stated reason plus a working retry, instead of an empty table that reads as "no
prospects". Settings/Users/Audit open immediately in a busy state rather than after their
fetches. The empty-state headline now starts `hidden`, so it can no longer flash before
the first load — and the genuine empty case still renders (verified separately, since
that is the easy thing to break while fixing the flash).

**2. Label/control association — FIXED for `index.html`.** The tree differed from the
spec's assumption: only **12** controls live in `index.html` (not ~30), and they already
carried ids, so this was "add 5 `for` attributes + 7 `aria-label`s", not "mint 30 ids".
No existing id was renamed (verified: all 76 ids byte-identical before/after).
`scripts/check-labels.mjs` reports 12 findings pre-fix, 0 post-fix, and is wired into the
test suite. **Still open:** ~41 controls are built inside `renderer.js` template strings.
A static parser cannot resolve those reliably, so they need a runtime pass — run axe
DevTools against the live app, or fold it into the next renderer.js change.

**8a/8b. Edge cases — FIXED.** `bookings.getOffer` confirmed to be a plain-object lookup
(so `offers['__proto__']` returned `Object.prototype`, truthy, skipping the not-found
branch and 500ing on `.slots`); now guarded by a 40-hex shape check plus `Object.hasOwn`,
returning 404. `saveFinal` no longer answers `{ok:true}` when the prospect was deleted
mid-send: since the Gmail send is already irreversible at that point, it returns 409 with
wording that says the email **did** go out and must not be resent, and audits it under
`prospect.email.send.orphaned` (a distinct action, so the weekly digest's sent-count is
unaffected).

### Item 6 — inline styles and token system: explicitly RE-DEFERRED

Zero functional and zero accessibility impact, ~70 sites, and PR-B already churned some of
the same DOM. Partially captured as the spec directed: `--space-1..6` (4px base) and a
five-step type scale (`--text-xs..xl`) are now defined in `styles.css` and used by all new
code; existing inline styles are untouched. Note the tree already had colour, radius,
shadow, and duration tokens — what was missing was spacing and type. Actual counts: **12**
distinct font sizes, **6** of them half-pixel (the spec said 11 and 4); the half-pixel
values are not carried into the new scale.

**Revisit when any of:** (a) this branch has landed and settled, (b) a second developer
joins the codebase, or (c) any styling work would touch more than a handful of the ~70
sites — at which point do the full pass rather than growing the inconsistency.

### Self-audit, 2026-09-02 (after the implementation, before deploy)

The implementation above was then reviewed adversarially, including two independent
read-only passes over `public/ui.js` and `server/`. **Eleven real defects were found in the
new code and fixed.** The ones worth knowing about:

1. **CRITICAL — the dev-login rate limiter did unbounded work past its own cutoff.**
   `e.count++` ran before the limit check, so every request after the 5th re-entered the
   rotation branch: a fresh 16 MB scrypt, a full synchronous audit-file rewrite, a token
   rotation, and a *new live admin token printed to the log* — on every request, from an
   unauthenticated caller. Measured: 20 requests → 15 rotations, 15 audit rows. That is
   both a cheap DoS and the exact "admin session sitting in plaintext in the logs" failure
   the rewrite existed to remove; ~50k requests would also have rolled the entire audit
   history off the 50k-entry log. Now: rotate and audit **once** per window, then answer
   429 with no work. Guarded by `scripts/integration/dev-login-link.js`.
2. **`Enter` on a dialog's Cancel button SAVED instead of cancelling.** The keydown handler
   was on the backdrop, so it fired regardless of focus and `preventDefault()` suppressed
   the button's own activation. A keyboard user pressing Enter on Cancel would have marked a
   prospect dead — from the one control that promises not to.
3. **`npm test` had started booting two real HTTP servers on fixed ports.** Node's test
   runner discovers everything under `test/`, so the integration scripts I put in
   `test/manual/` were being executed by the suite, making it port-dependent and flaky —
   and the README claimed the opposite. Moved to `scripts/integration/` (outside discovery)
   with random ports.
4. **`trust proxy` was unconditional, so `req.ip` was forgeable off Railway.** With nothing
   in front of the process, `X-Forwarded-For` was believed verbatim: one header per request
   bypassed *every* per-IP limiter in the app (login, forgot-password, booking probes,
   dev-login) and wrote attacker-chosen addresses into the audit trail as fact. Now
   `trust proxy` is enabled only on Railway.
5. **An audit write could invert the message it accompanied.** `audit.log` is fully
   synchronous; if it threw (read-only volume, full disk) inside the orphaned-send branch,
   `mutating()` turned the deliberate 409 into a generic 500 — telling the SA the send
   failed when the email had already gone out, the precise outcome that branch exists to
   prevent. Now routed through an `auditSafe()` wrapper.
6. **Cancelling the dead-reason dialog still marked the prospect dead** (faithful to the old
   `window.prompt`, but a labelled Cancel button next to "Mark dead" reads as "abort" — and
   in the bulk path it silently killed every selected row). Cancel now aborts; choosing
   "(no reason given)" is how you mark dead without a reason.
7. **A failed token rotation bricked dev-login for the process lifetime** (the hash was
   nulled, and the guard then blocked any further rotation) with no log line saying why.
8. **`aria-live` on `#ui-root` was justified by a false claim** — toasts append to
   `document.body`, never there — and made every dialog announce twice, then re-announce on
   internal changes. Removed.
9. **One Escape could close a dialog *and* the modal underneath it**, and an app modal stayed
   fully screen-reader-browsable while a confirm was raised from inside it (the five modals
   are siblings of `#appRoot`, so inerting the shell alone missed them). Key handling is now
   one document-level listener over a stack of open dialogs; only the top one responds.
10. **`variant: 'error'` had no effect** — error toasts looked identical to success toasts
    and stayed `role="status"`. Now `role="alert"`/assertive on a red ground.
11. **The `Host` regression guard was case-sensitive and ignored forwarded headers**, so
    `req.get('Host')` or `x-forwarded-host` would have walked straight past it.

Also removed as dead weight: `ui.setState` and its `[data-state]`/`[data-when]` CSS (zero
callers), `ui.prompt`'s `textarea` branch and its CSS, six unused option parameters, a
`console` fallback that no page could reach, an always-40 length computation, and a
`bookings.isValidTokenShape` export that existed only for a test. `baseUrl` is now
boot-only, so no route can repoint outbound links at runtime.

**Deliberately kept:** six of the eleven `--space-*`/`--text-*` tokens are still
unreferenced. The spec directed defining the complete scale for the deferred item 6, and a
scale with gaps is not a scale — it is 11 lines of custom properties, not churn.

**Known limitation, not fixed:** the multi-step draft flow re-renders its body in place, so
focus falls to `<body>` between steps. Tab now recovers it (previously it walked the whole
document), but focus does not automatically advance to each new step. Pre-existing; the flow
had no focus management at all before this pass.

### Verification status

- `npm test` — **88 passing** (54 pre-existing + 34 new), no regressions, ~2s, no sockets.
- `node scripts/integration/forged-host.js` — 25 assertions (forged Host and
  X-Forwarded-Host, dev-login, prototype-key routes).
- `node scripts/integration/dev-login-disabled.js` — 3 assertions.
- `node scripts/integration/dev-login-link.js` — 21 assertions (single use / no replay,
  redirect, no-store, no-referrer, self-replacement, expiry, and the critical
  unbounded-work defect: one handling, one audit row, cheap refusals).
- `node scripts/check-labels.mjs` — clean.
- Real-browser pass against a sandbox: 63 runtime assertions covering ARIA wiring, focus
  move/trap/restore, `inert`, cancel-vs-empty semantics, the dead-reason select, dialog
  queueing, the 4a race, and the 4b error/retry/empty paths.
- Four regression guards added as required: no request-derived host outside an allowlist;
  no native dialogs outside `ui.js`; zero unlabelled controls in `index.html`;
  prototype-key route tests.

**Not verified — needs your eyes or a real account:** axe DevTools scan, a VoiceOver/NVDA
pass on the delete confirmation, DevTools network throttling, a real Google OAuth round
trip against the canonical callback, whether a live token is sitting in existing Railway
logs (which would mean rotating it), and item 8b's end-to-end delete-during-send.

**Before deploying:** set `APP_BASE_URL` in Railway — PR-A's boot fails without it.

## Deliberately not started

- **Clio Manage integration** — pushing won clients into Clio Manage (contact + matter +
  signed retainer). Design/interview only, no code. Key finding: Clio's e-signature is
  UI-only (Dropbox Sign-backed), not reachable via API — the real decision is whether to
  integrate a third-party e-sign API directly (full automation) or keep the signature
  step manual in Clio's own UI (reuses the paralegal's Grow templates, less work).
  Parked at Rafael's request as of 2026-09-02.

## Where things live

- `docs/audits/` — dated, fully-resolved security audit reports (historical reference).
- `docs/history/` — the full session-by-session narrative this file was distilled from.
- `docs/superpowers/` — feature specs and plans (LinkedIn outreach, outbox staggered
  delivery), already dated and named by feature.
- `SETUP.md` — end-user install/run guide for the Windows host machine (unchanged, still
  current).
