# Integration checks (run by hand)

These boot the real server against a throwaway data directory on a random high port. They
live outside `test/` on purpose: `node --test` (which is what `npm test` runs) discovers
everything under a `test/` directory, so keeping them there made `npm test` bind real
sockets and depend on a port being free. Run them directly instead:

```
node scripts/integration/forged-host.js
node scripts/integration/dev-login-link.js
node scripts/integration/dev-login-disabled.js
```

Each prints `N passed, M failed` and exits non-zero on failure.

## `forged-host.js` (19 assertions)

The post-fix proof for item 1 of the 2026-09-02 hardening pass. Sends
`POST /api/auth/forgot` with a forged `Host`, then again with a forged
`X-Forwarded-Host`, and asserts the emailed body carries the configured origin and never
the attacker's domain — then confirms the token in that link still completes a real reset,
so the fix did not simply break the flow.

Also confirms the old `GET /api/auth/backdoor/:token` path no longer authenticates, and
covers item 8a's route boundary (`/book/__proto__/data` and friends return 404, not 500).

It uses Node's `http` module rather than `fetch` on purpose: undici treats `Host` as a
forbidden header and will not send it, which is the header under test.

## `dev-login-link.js` (21 assertions)

The dev-login magic link: it authenticates, redirects so the token leaves the address bar,
sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer` — and, the assertion the
whole design rests on, **cannot be replayed**. Single use is what makes a token in a URL
acceptable: it is why the copies left behind in access logs, browser history and `Referer`
headers are inert. If that assertion ever fails, the justification is gone and the link
shape has to be reconsidered.

Also covers the self-replacing behaviour (using a link mints the next one, so the log holds
exactly one live link), expiry, per-IP rate limiting, and that the limiter does bounded work
— an earlier version rotated the token and rewrote the whole audit file on *every* request
past the cutoff, which was an unauthenticated DoS that also flooded live tokens into the log.

## `dev-login-disabled.js` (3 assertions)

Item 7's most important property: with `ENABLE_DEV_LOGIN` unset the route is not mounted,
nothing can obtain a session through it, and the `dev_rafael` admin account is never
auto-created.

## Why these are not in `npm test`

They need a listening server, a writable temp directory, and a free port. The fast,
deterministic guards for the same items are unit tests under `test/`:
`base-url.test.js`, `bookings-token.test.js`, `labels.test.js`, `no-native-dialogs.test.js`.
