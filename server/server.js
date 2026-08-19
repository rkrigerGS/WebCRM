// server.js — the web server that runs on the host machine.
// This replaces Electron's main process. Instead of IPC channels, each operation is an
// HTTP endpoint the browser UI calls with fetch(). The server holds the database, the
// API key, the catalogs, and watches the research folder.
//
// It binds to all interfaces (0.0.0.0) because it is deployed behind Railway's edge
// proxy, so access control is the session cookie and the /api/* auth gate below — not
// the network. Do not run it on an untrusted network without that gate.

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const chokidar = require('chokidar');

const db = require('./db');
const config = require('./config');
const catalogs = require('./catalogs');
const emailEngine = require('./emailEngine');
const auth = require('./auth');
const users = require('./users');
const audit = require('./audit');
const gmail = require('./gmail');
const calendarAvailability = require('./calendar');
const backup = require('./backup');
const digest = require('./digest');

const APP_DIR = path.join(__dirname, '..');
// On Railway, RAILWAY_VOLUME_MOUNT_PATH points at the persistent volume (e.g. /data) —
// use it when present so restarts/redeploys don't wipe users, prospects, and the audit
// log. Falls back to APP_DIR/data for local dev, where there is no volume.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(APP_DIR, 'data');
const PORT = process.env.PORT || 3000;

// If the volume is ever detached or renamed, the fallback above would quietly point at the
// container's own filesystem: the app would boot looking empty, staff would re-enter data
// into it, and every byte would vanish at the next redeploy. Refusing to start instead
// makes the misconfiguration loud and leaves the real volume's data untouched on disk.
// Only enforced on Railway — local dev has no volume and is meant to use APP_DIR/data.
const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
if (ON_RAILWAY && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.error(
    'REFUSING TO START: running on Railway but RAILWAY_VOLUME_MOUNT_PATH is not set.\n' +
    'That means no persistent volume is attached, and anything written would be lost on the\n' +
    'next redeploy. Attach the volume to this service in the Railway dashboard (Settings →\n' +
    'Volumes) and redeploy. No existing data has been touched.'
  );
  process.exit(1);
}

// ---- Startup ----
// The data directory is created here, before any module initializes, rather than as a side
// effect of whichever init happened to run first. It used to be db.init() alone that made it,
// which meant the order of the calls below was load-bearing and undocumented: moving config
// ahead of db — the very thing the next comment asks for — would have had config.init()
// writing into a directory that did not exist yet.
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Live-update fan-out and background-failure reporting ----
// Declared here, above the init() calls, because gmail.init() below is handed reportIssue
// as its failure hook. These were originally defined further down next to the /api/events
// route; that left `recentIssues` in its temporal dead zone at the moment gmail.init() ran,
// so the first background failure reported during startup would have thrown a
// ReferenceError instead of a toast. The route registration itself stays down there, after
// the session gate — moving it up here would put it in front of authentication.
const clients = new Set(); // open SSE responses, each tagged with the viewer's role
function broadcast(event, data, adminOnly = false) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (adminOnly && !res.__isAdmin) continue;
    try { res.write(payload); } catch {}
  }
}

// Background failures (Gmail polling, digest, backup, OAuth, calendar) used to only reach
// console.warn — invisible unless someone happened to be tailing the server log. Every call
// site now also broadcasts a short reference code an admin can see as a toast and read back
// to whoever is debugging it, so "the connection isn't working" turns into "ref 4f2a91".
//
// The broadcast is adminOnly. err.message routinely contains exactly what audit finding L1
// says must not reach a browser — absolute paths, JSON parse offsets, Google's verbatim
// error text including cloud project ids. Gating it on the client (a role check before
// rendering the toast) is not access control: the payload is in the browser either way and
// readable in devtools. So the filter lives in broadcast(), server-side.
//
// Same scope+message re-suppresses for 30 minutes so a 3-minute poll loop doesn't retoast
// the identical failure every cycle; it still logs a fresh ref each time so the server log
// has a trail even while the UI stays quiet. Scopes must therefore be COARSE — one scope
// per failing subsystem, not per record — or a single root cause that affects N records
// produces N toasts and defeats the suppression entirely.
const ISSUE_REBROADCAST_MS = 30 * 60 * 1000;
const MAX_TRACKED_ISSUES = 200; // bound the map; scopes are coarse, so this is far above real use
const recentIssues = new Map(); // scope -> { message, at }
function reportIssue(scope, err, logDetail) {
  const message = (err && err.message) || String(err);
  const ref = crypto.randomBytes(3).toString('hex');
  console.error(`[${ref}] ${scope}:`, (err && err.stack) || err);
  if (logDetail) console.error(`[${ref}] context: ${logDetail}`);
  const prev = recentIssues.get(scope);
  if (prev && prev.message === message && Date.now() - prev.at < ISSUE_REBROADCAST_MS) return ref;
  if (recentIssues.size >= MAX_TRACKED_ISSUES && !recentIssues.has(scope)) {
    recentIssues.delete(recentIssues.keys().next().value); // oldest insertion first
  }
  recentIssues.set(scope, { message, at: Date.now() });
  broadcast('issue', { ref, scope, message }, true);
  return ref;
}

// config first: db.js reads defaultFollowupDays out of it when creating a prospect.
console.log(`Data directory: ${DATA_DIR}`);
config.init(DATA_DIR);
db.init(DATA_DIR);
catalogs.init(DATA_DIR, APP_DIR);
auth.init(DATA_DIR);
users.init(DATA_DIR);
audit.init(DATA_DIR);
gmail.init(DATA_DIR, (scope, err) => reportIssue(scope, err));
// Backfill for installations that were set up before setupCompleted existed: accounts are
// already here, so record that setup happened and let the gate on /api/auth/setup work.
if (users.hasAnyUser() && !config.get().setupCompleted) config.update({ setupCompleted: true });
seedApprovedEmails();

let watcher = null;
startWatching();

const app = express();
// This app deploys behind Railway's edge proxy — without trusting it, req.ip would
// resolve to the proxy's own address for every request, not the real client IP, which
// would make the login rate limiter below lock out every user together instead of one
// abusive IP. Railway is the only proxy this app ever sits behind (local dev has no
// proxy in the chain at all, so this has no effect there).
//
// The value is 1, not true: `true` trusts the whole X-Forwarded-For chain, so a client
// could send its own X-Forwarded-For header, express would believe it, and req.ip would
// become attacker-chosen — a fresh "IP" per login attempt defeats the rate limiter
// entirely. 1 trusts exactly one hop (Railway's proxy, which appends the real client
// address) and ignores anything the client claims beyond it.
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

// Cookies get the Secure flag in production so the session token is never sent over
// plain HTTP. Left off locally, where there is no TLS and Secure cookies would simply
// be dropped, making login impossible.
// Keyed on Railway's own platform variables rather than the volume path, so pointing a
// local run at a scratch data directory (RAILWAY_VOLUME_MOUNT_PATH) doesn't switch Secure
// on and lock the developer out of their own http://localhost.
const COOKIE_SECURE = process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
function sessionCookie(token, maxAgeSeconds) {
  return `gs_session=${token}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Path=/${COOKIE_SECURE ? '; Secure' : ''}`;
}
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

// ---- Auth endpoints (these must be reachable without a token) ----
// Login/logout are not audited: they don't create, modify, or delete app data (see the
// AUDIT CONVENTION comment below `mutating()`). /api/auth/setup is the one exception that
// DOES create data (the first user) — it audits itself manually since there's no session
// yet to attribute the action to anything other than the account being created.

// Resolves the session cookie to a live user record, or null. Every place that accepts a
// session goes through here so they all apply the same three checks: a valid signature,
// an account that still exists and is active, and — the reason this is a function rather
// than two inline copies — a token issued before the account's password was last changed
// is refused. Without that last check, resetting a password left every already-issued
// cookie working, so the point of the reset (locking out whoever had the old password)
// was silently lost.
// ---- Dev auto-login (local sandboxes only) ----
// NOT the removed test-login backdoor (see the comment in users.js): this has no URL, no
// hidden account, and no way to turn on remotely. It only activates when the person who
// starts the server sets DEV_AUTOLOGIN=<existing username> in the environment, and it is
// hard-refused whenever the production markers are present (same COOKIE_SECURE detection
// as above — NODE_ENV=production or any RAILWAY_* variable), so it cannot ship live.
const DEV_AUTOLOGIN = String(process.env.DEV_AUTOLOGIN || '').trim();
const devAutologinAllowed = !!DEV_AUTOLOGIN && !COOKIE_SECURE;
if (DEV_AUTOLOGIN && COOKIE_SECURE) console.error('DEV_AUTOLOGIN is set but this looks like production — ignoring it.');
if (devAutologinAllowed) console.error(`DEV_AUTOLOGIN: every request without a session runs as "${DEV_AUTOLOGIN}" — local development only.`);

function userFromReq(req) {
  const payload = auth.verifyToken(auth.tokenFromReq(req));
  if (payload) {
    const user = users.findById(payload.uid);
    if (user && user.active && !(user.pwChangedAt && payload.t < new Date(user.pwChangedAt).getTime())) return user;
  }
  if (devAutologinAllowed) {
    const u = users.findByUsername(DEV_AUTOLOGIN);
    if (u && u.active && !u.pending) return u;
  }
  return null;
}

// Tells the login page whether any account exists yet (first-run creates the admin), and
// who (if anyone) the current request is authenticated as.
app.get('/api/auth/status', (req, res) => {
  const user = userFromReq(req);
  const authed = !!user;
  res.json({
    usersExist: users.hasAnyUser() || config.get().setupCompleted,
    authed,
    user: authed ? { id: user.id, username: user.username, role: user.role } : null
  });
});

// First run: create the initial account. It is always the admin. Only allowed once.
//
// Gated twice, on two different files. "No users exist" alone is a dangerous test: if
// users.json is ever lost or emptied while the rest of the volume survives, this route
// reopens and the next visitor — anyone on the internet — is handed a fresh admin
// account. config.setupCompleted records that setup has already happened, so that case
// fails closed and needs a deliberate hand-edit on the server to recover, rather than
// silently granting the CRM to a stranger.
app.post('/api/auth/setup', (q, res) => {
  if (users.hasAnyUser()) return res.status(400).json({ error: 'Setup already completed' });
  if (config.get().setupCompleted) {
    console.error('SETUP REFUSED: config says setup is complete but users.json has no accounts. ' +
      'Restore users.json from a backup, or clear setupCompleted in config.json to re-run setup.');
    return res.status(409).json({ error: 'This installation is already set up but its accounts are missing. Restore from a backup — contact your administrator.' });
  }
  let user;
  try {
    user = users.createUser({ username: q.body && q.body.username, password: q.body && q.body.password, role: 'admin' });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  config.update({ setupCompleted: true });
  audit.log({ userId: user.id, username: user.username, action: 'user.create', detail: 'Initial admin account created on first run' });
  const token = auth.issueToken(user.id);
  res.set('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE));
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

// Lets the pre-auth invite-acceptance page (see auth-client.js) show a clear error before
// the user even types a password, rather than only on submit.
app.get('/api/auth/invite-status', (q, res) => {
  const u = users.findByInviteToken(q.query.token || '');
  if (!u) return res.json({ valid: false, reason: 'Invalid or already-used invitation link.' });
  if (new Date(u.inviteExpiresAt).getTime() < Date.now()) return res.json({ valid: false, reason: 'This invitation link has expired. Ask an admin to resend it.' });
  res.json({ valid: true, username: u.username });
});

// Pre-session, like /api/auth/setup — sets the password via a one-time invite link and
// logs the user in immediately after. Audits itself inline (see the AUDIT CONVENTION
// exception list below) since there is no session yet to attribute it through mutating().
app.post('/api/auth/accept-invite', (q, res) => {
  try {
    const { token, password } = q.body || {};
    const u = users.acceptInvite(token, password);
    audit.log({ userId: u.id, username: u.username, action: 'user.invite.accept', detail: 'Password set via invitation link' });
    const sessToken = auth.issueToken(u.id);
    res.set('Set-Cookie', sessionCookie(sessToken, SESSION_MAX_AGE));
    res.json({ ok: true, user: { id: u.id, username: u.username, role: u.role } });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- Login rate limiting ----
// In-memory only (no persistence needed, no new dependency): 5 failed attempts from one
// IP within a 15-minute window locks that IP out for the remainder of that window. A
// correct password at any point before the 5th failure succeeds normally and clears the
// entry. No cleanup of stale entries — at this app's scale (1-2 users) the map never
// grows large enough for that to matter.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map(); // ip -> { count, firstFailureAt, lockedUntil }

// Log in with a username and password.
app.post('/api/auth/login', (q, res) => {
  const ip = q.ip;
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && entry.lockedUntil && now < entry.lockedUntil) {
    const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many failed login attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }
  const { username, password } = q.body || {};
  const user = users.checkLogin(username || '', password || '');
  if (!user) {
    let e = entry;
    if (!e || now - e.firstFailureAt > LOGIN_WINDOW_MS) e = { count: 0, firstFailureAt: now, lockedUntil: 0 };
    e.count++;
    if (e.count >= LOGIN_MAX_ATTEMPTS) e.lockedUntil = e.firstFailureAt + LOGIN_WINDOW_MS;
    loginAttempts.set(ip, e);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginAttempts.delete(ip);
  const token = auth.issueToken(user.id);
  res.set('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE));
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (_q, res) => {
  res.set('Set-Cookie', sessionCookie('', 0));
  res.json({ ok: true });
});

// ---- Forgot password (pre-session, like the invite flow) ----
// Anti-enumeration: the response is identical whether or not the identifier matched an
// account, and the lookup + email send happen after the response is already written.
// Rate limited per IP with the same window/threshold as login, since every request can
// trigger an outbound email through the connected Gmail account.
const forgotAttempts = new Map(); // ip -> { count, firstAt }
app.post('/api/auth/forgot', (q, res) => {
  const now = Date.now();
  let e = forgotAttempts.get(q.ip);
  if (!e || now - e.firstAt > LOGIN_WINDOW_MS) e = { count: 0, firstAt: now };
  e.count++;
  forgotAttempts.set(q.ip, e);
  if (e.count > LOGIN_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many reset requests. Try again later.' });
  const identifier = (q.body && q.body.identifier) || '';
  const link = (token) => `${q.protocol}://${q.get('host')}/?reset=${token}`;
  res.json({ ok: true }); // always the same answer — never confirms whether an account exists
  let result = null;
  try { result = users.startPasswordReset(identifier); } catch { return; }
  if (!result) return;
  audit.log({ userId: result.user.id, username: result.user.username, action: 'user.password.forgot', detail: 'Password reset link requested from the login page' });
  if (!gmail.isConnected()) {
    console.error(`Password reset requested for "${result.user.username}" but Gmail is not connected — no email sent. An admin can reset the password from the Users panel instead.`);
    return;
  }
  gmail.sendInviteEmail({
    to: result.email,
    subject: 'Reset your GovSpring Prospecting password',
    bodyText: `Hi ${result.user.username},\n\nA password reset was requested for your GovSpring Prospecting account. Use this link within 1 hour to choose a new password:\n\n${link(result.resetToken)}\n\nIf you didn't request this, you can ignore this email — your password is unchanged.`
  }).catch(err2 => console.error('Password reset email failed:', err2.message));
});

// Mirrors /api/auth/invite-status: lets the reset page show a clear error before the
// user even types a new password.
app.get('/api/auth/reset-status', (q, res) => {
  const u = users.findByResetToken(q.query.token || '');
  if (!u) return res.json({ valid: false, reason: 'Invalid or already-used reset link.' });
  if (new Date(u.resetExpiresAt).getTime() < Date.now()) return res.json({ valid: false, reason: 'This reset link has expired. Request a new one from the login page.' });
  res.json({ valid: true, username: u.username });
});

// Pre-session, like /api/auth/accept-invite — sets the new password via the one-time
// emailed link and logs the user in immediately after. Audits itself inline.
app.post('/api/auth/reset-password', (q, res) => {
  try {
    const { token, password } = q.body || {};
    const u = users.completePasswordReset(token, password);
    audit.log({ userId: u.id, username: u.username, action: 'user.password.reset', detail: 'Password changed via emailed reset link' });
    const sessToken = auth.issueToken(u.id);
    res.set('Set-Cookie', sessionCookie(sessToken, SESSION_MAX_AGE));
    res.json({ ok: true, user: { id: u.id, username: u.username, role: u.role } });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---- Gate: every /api/* route below this line requires a valid session ----
// (Static files like the login page and CSS are served after and are public, but they
// contain no data; the data only flows through /api, which is protected.)
// The user record is looked up fresh on every request (not cached in the token), so a
// role change or deactivation takes effect on the user's very next request rather than
// waiting for their token to expire or for them to log in again.
app.use('/api', (req, res, next) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────────────
// AUDIT CONVENTION — READ BEFORE ADDING AN ENDPOINT
//
// Any endpoint that creates, modifies, or deletes app data (a prospect, a user, config,
// a catalog) MUST be registered with mutating() below, not app.get/post/patch/delete
// directly. mutating() requires an action label and writes an audit-log entry (who did
// it, what they did, which prospect if applicable, and when) after the handler succeeds.
// Skipping this for a state-changing route is a bug — a startup check further down warns
// on the console if a route is ever added without it. Read-only endpoints (GET) keep
// using app.get() directly; they are not audited by design.
//
// Handler contract: `handler(req, res)` does the work and returns the value to send as
// JSON (mutating() calls res.json(value) and then logs the audit entry). To attach a
// prospectId or a human-readable detail string, set `res.locals.audit = { prospectId, detail }`
// before returning. If the handler already sent its own response (e.g. a 404) and/or the
// call didn't actually change anything, set `res.locals.skipAudit = true` — the audit
// entry is skipped but any value the handler returned is still ignored (the handler must
// have called res.json/res.status itself in that case).
//
// Documented exceptions (do not follow this pattern, and why):
//   - POST /api/auth/setup   — pre-session; creates the first user; audits itself inline.
//   - POST /api/auth/login   — not a data mutation.
//   - POST /api/auth/logout  — not a data mutation.
//   - POST /api/prospects/upload — one call can ingest many prospects; it logs one audit
//     entry per ingested item in its own loop, not one entry per request.
//   - tryIngestFile() (folder watcher, below) — not an HTTP route; there is no logged-in
//     user, so it calls audit.log() directly with a "system" actor.
//   - GET /api/admin/gmail/callback — the OAuth redirect target. It's a GET that responds
//     with a redirect, not JSON, so it doesn't fit mutating()'s res.json() contract; it
//     audits the connection manually.
//   - POST /api/auth/accept-invite — pre-session, like /api/auth/setup; sets a password via
//     a one-time invite link and audits itself inline.
// ─────────────────────────────────────────────────────────────────────────────────────
function mutating(action, handler) {
  const fn = async (req, res) => {
    try {
      const value = await handler(req, res);
      if (res.locals.skipAudit || req.user.noLog) {
        if (!res.headersSent) res.json(value);
        return;
      }
      const a = res.locals.audit || {};
      audit.log({ userId: req.user.id, username: req.user.username, action, prospectId: a.prospectId ?? null, detail: a.detail || '' });
      if (!res.headersSent) res.json(value);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      fail(res, e);
    }
  };
  fn.__audited = true;
  return fn;
}

app.use(express.static(path.join(APP_DIR, 'public')));

// ---- Live updates via Server-Sent Events ----
// When a dossier is ingested, the server pushes an event so the browser refreshes live,
// the same way the desktop app updated when a batch landed.
// `clients`, broadcast() and reportIssue() are defined near the top of this file, ahead of
// the init() calls that need reportIssue. Only the route lives here, where the session gate
// above already applies.
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  // Recorded per connection so broadcast() can withhold admin-only events (see reportIssue).
  // A role change mid-session is not reflected until the stream reconnects, which a reload does.
  res.__isAdmin = !!(req.user && req.user.role === 'admin');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// An idle SSE stream can go minutes without traffic, and proxies (Railway's edge included)
// drop connections they think are dead. A comment line every 25s keeps the stream alive;
// it is ignored by the EventSource client, so nothing in the browser has to handle it.
setInterval(() => {
  for (const res of clients) { try { res.write(': keep-alive\n\n'); } catch {} }
}, 25 * 1000).unref();

// ---- Watched folder ----
function watchedDir() {
  const configured = config.get().watchFolder;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(DATA_DIR, 'watched-dossiers');
}
// Dossiers dropped into the watched folder are ingested without an HTTP request (no
// logged-in user), so this is the one mutation path in the app not reachable via
// mutating(). Attributed to a synthetic "system (folder watch)" actor — see the AUDIT
// CONVENTION comment above.
function tryIngestFile(filePath, attempt = 0) {
  const name = path.basename(filePath);
  fs.readFile(filePath, 'utf8', (err, text) => {
    // A file that can't be read at all: retried like a partial write, then given up on
    // loudly. Silence here meant a dossier could vanish with no trace anywhere.
    if (err) {
      if (attempt < 5) return setTimeout(() => tryIngestFile(filePath, attempt + 1), 400);
      return reportIngestFailure(name, `could not be read (${err.code || err.message})`);
    }
    let dossier;
    try { dossier = JSON.parse(text); }
    catch (e) {
      // The usual cause is reading mid-write, which the retries cover. Past that, the file
      // really is malformed and someone has to look at it.
      if (attempt < 5) return setTimeout(() => tryIngestFile(filePath, attempt + 1), 400);
      return reportIngestFailure(name, `is not valid JSON (${e.message})`);
    }
    let result;
    try {
      result = db.ingestDossier(dossier, name);
    } catch (e) {
      return reportIngestFailure(name, `could not be ingested (${e.message})`);
    }
    if (result.outcome === 'ingested') {
      audit.log({ userId: null, username: 'system (folder watch)', action: 'prospect.ingest', prospectId: result.id, detail: name });
    }
    // The filename travels with the result so a skipped file (duplicate, do-not-contact)
    // can be named in the toast instead of appearing as an anonymous "skipped".
    broadcast('ingested', { ...result, file: name });
  });
}
// One place so a dropped dossier always leaves three marks: stdout, the audit log, and a
// toast in every open browser.
function reportIngestFailure(name, why) {
  const detail = `${name} ${why}`;
  console.error('DOSSIER NOT INGESTED —', detail);
  audit.log({ userId: null, username: 'system (folder watch)', action: 'prospect.ingest.failed', detail });
  broadcast('ingest-failed', { file: name, reason: why });
}
function startWatching() {
  const dir = watchedDir();
  fs.mkdirSync(dir, { recursive: true });
  watcher = chokidar.watch(dir, { ignoreInitial: false, depth: 4, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } });
  watcher.on('add', p => { if (p.toLowerCase().endsWith('.json')) tryIngestFile(p); });
  console.log('Watching for dossiers in', dir);
}
function restartWatching() {
  if (watcher) { watcher.close(); watcher = null; }
  startWatching();
}

function seedApprovedEmails() {
  const seedDir = path.join(APP_DIR, 'seed-approved-emails');
  const destDir = catalogs.dirs().approvedDir;
  if (!fs.existsSync(seedDir)) return;
  if (fs.readdirSync(destDir).length > 0) return;
  for (const f of fs.readdirSync(seedDir)) if (f.endsWith('.json')) fs.copyFileSync(path.join(seedDir, f), path.join(destDir, f));
  console.log('Seeded approved-email library');
}

// ---- API endpoints (each mirrors an old IPC handler) ----

const ok = (res, data) => res.json(data);

// Two kinds of error reach here. One is deliberate — a handler throwing with an .status set
// ("Prospect not found", "Invalid backup frequency"); that message is written for the person
// reading it, so it goes through as-is with its own code. The other is an unexpected throw,
// whose message is an internal detail (a filesystem path, a JSON parse offset, a stack-shaped
// string) that tells the user nothing and describes the server's insides. Those get logged in
// full where they're useful — the server log — and a generic line in the response.
const fail = (res, e) => {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  const ref = reportIssue('request', e);
  return res.status(500).json({ error: `Something went wrong on the server (ref ${ref}). If this keeps happening, report that code.`, ref });
};

app.get('/api/prospects', (_q, res) => { try { ok(res, db.listProspects()); } catch (e) { fail(res, e); } });

// Who added this prospect, read straight from its creation event in the audit log
// (prospect.upload for a browser upload, prospect.ingest for the folder watcher) — no new
// storage; this is a record, not an editable field.
function findAddedBy(id) {
  const entry = audit.list({ prospectId: id }).find(e => e.action === 'prospect.upload' || e.action === 'prospect.ingest');
  return entry ? { by: entry.username, at: entry.at } : null;
}
app.get('/api/prospects/:id', (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const added = findAddedBy(p.id);
    ok(res, { ...p, added_by: added ? added.by : '', added_at: added ? added.at : '' });
  } catch (e) { fail(res, e); }
});

// Do-not-contact enforcement at the send layer (the exclusions list already runs at
// ingest time — see db.js's isExcluded/ingestDossier, unchanged). Checked first, before
// anything else, in both send routes below. On a match: nothing is sent, nothing is
// persisted, and — unlike a plain precondition failure — the attempt itself is audited,
// since a blocked send attempt on a do-not-contact company is meaningful history.
function blockIfExcluded(req, res, id) {
  const rule = db.checkExclusion(id);
  if (!rule) return false;
  audit.log({ userId: req.user.id, username: req.user.username, action: 'prospect.send.blocked', prospectId: id, detail: `Blocked: matched exclusion ${rule.match_type}="${rule.value}"` });
  res.status(400).json({ error: `This company is on the do-not-contact list (matched: ${rule.value}). Sending is blocked.`, exclusion: rule });
  res.locals.skipAudit = true;
  return true;
}

app.patch('/api/prospects/:id', mutating('prospect.update', (q, res) => {
  const id = +q.params.id;
  const result = db.updateProspect(id, q.body || {});
  res.locals.audit = { prospectId: id, detail: JSON.stringify(q.body || {}) };
  return result;
}));

app.delete('/api/prospects/:id', mutating('prospect.delete', (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  const result = db.deleteProspect(id);
  res.locals.audit = { prospectId: id, detail: p ? `Deleted "${p.company_name}"` : '' };
  return result;
}));

app.get('/api/stats', (_q, res) => { try { ok(res, db.stats()); } catch (e) { fail(res, e); } });

app.post('/api/prospects/:id/note', mutating('prospect.note.add', (q, res) => {
  const id = +q.params.id;
  const result = db.addNote(id, q.body.text);
  res.locals.audit = { prospectId: id, detail: (q.body.text || '').slice(0, 140) };
  return result;
}));

app.post('/api/prospects/:id/external', mutating('prospect.outreach.log', (q, res) => {
  const id = +q.params.id;
  const result = db.logExternal(id, q.body);
  res.locals.audit = { prospectId: id, detail: `${q.body.channel}: ${(q.body.text || '').slice(0, 140)}` };
  return result;
}));

app.post('/api/prospects/:id/contact', mutating('prospect.contact.edit', (q, res) => {
  const id = +q.params.id;
  const result = db.editContact(id, q.body);
  res.locals.audit = { prospectId: id, detail: JSON.stringify(q.body || {}) };
  return result;
}));

// Upload dossiers directly through the browser (from any device). Accepts an array of
// parsed dossier objects; runs each through the same ingest path as the watched folder,
// so de-dup, exclusions, and fit-score handling are identical.
// NOTE: bypasses mutating() deliberately — one call can ingest many prospects, each
// needing its own audit entry (below), whereas mutating() logs exactly one entry per
// request. See the AUDIT CONVENTION comment above.
app.post('/api/prospects/upload', (q, res) => {
  try {
    const items = Array.isArray(q.body && q.body.dossiers) ? q.body.dossiers : [];
    if (!items.length) return res.status(400).json({ error: 'No dossiers provided' });
    const results = { ingested: 0, duplicate: 0, excluded: 0, errors: [] };
    for (const item of items) {
      try {
        // A file that parsed as valid JSON but isn't a dossier object (null, an array, a
        // bare string) used to reach ingestDossier and surface as "Cannot read properties
        // of null (reading 'uei')" next to the filename — true, but not something the
        // person who dropped the file can act on.
        const d = item && item.dossier;
        if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Not a dossier — the file is valid JSON but does not contain a company record');
        const r = db.ingestDossier(d, item.filename || 'upload.json');
        if (r.outcome === 'ingested') {
          results.ingested++;
          broadcast('ingested', r);
          audit.log({ userId: q.user.id, username: q.user.username, action: 'prospect.upload', prospectId: r.id, detail: item.filename || 'upload.json' });
        }
        else if (r.outcome === 'duplicate') results.duplicate++;
        else if (r.outcome === 'excluded') results.excluded++;
      } catch (e) {
        results.errors.push({ filename: item.filename || '?', error: String(e && e.message || e) });
      }
    }
    ok(res, results);
  } catch (e) { fail(res, e); }
});

// Email flow
app.get('/api/prospects/:id/questions', (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    ok(res, emailEngine.buildQuestions(p.dossier));
  } catch (e) { fail(res, e); }
});

// Open only to logged-in users, same as the questions/generate endpoints below — drafting
// isn't admin-gated, so offering real times shouldn't be either. Not wrapped in mutating():
// this reads Marcos's calendar, it doesn't change any app state.
// Two different outcomes share the "no slots" shape, and they must not look alike: Gmail or
// the Calendar grant simply not being set up yet is an expected state with a self-explanatory
// message, while anything else is a real failure that needs a ref code and a logged stack.
// Previously both collapsed into {connected:false, reason}, so a broken calendar was
// indistinguishable from an unconfigured one and produced no ref and no server-log entry.
app.get('/api/calendar/availability', (_q, res) => {
  calendarAvailability.getAvailableSlots()
    .then(slots => ok(res, { connected: true, slots }))
    .catch(e => {
      if (e && e.notConnected) return ok(res, { connected: false, reason: e.message, slots: [] });
      const ref = reportIssue('calendar.availability', e);
      // The raw message stays server-side (audit finding L1); the ref is what gets reported back.
      ok(res, { connected: false, failed: true, ref, reason: `Calendar lookup failed (ref ${ref}).`, slots: [] });
    });
});

// Every successful generation is audited — including regenerates and follow-up drafts —
// since each call spends Claude API tokens even when nothing is persisted to the prospect
// record yet (that only happens on the very first draft; see `persisted` below).
app.post('/api/prospects/:id/generate', mutating('prospect.draft.generate', async (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  const a = q.body || {};
  let chosenIssue = null;
  if (a.issueId && a.issueId !== 'general') {
    const idx = parseInt(String(a.issueId).replace('issue_', ''), 10);
    chosenIssue = (p.dossier.issue_spotting || [])[idx] || null;
  }
  try {
    const { draft, usage } = await emailEngine.generateDraft({
      dossier: p.dossier, chosenIssue, chosenServices: a.services || [],
      personalNote: a.personalNote || null, isFollowup: !!a.isFollowup,
      priorEmailText: a.priorEmailText || p.final_sent || p.first_draft || '',
      chosenSlots: Array.isArray(a.chosenSlots) ? a.chosenSlots.filter(s => typeof s === 'string').slice(0, 5) : []
    });
    let persisted = false;
    if (!a.isFollowup && !p.first_draft) { db.updateProspect(id, { first_draft: draft }); persisted = true; }
    const kind = a.isFollowup ? 'Follow-up draft' : (persisted ? 'First draft (saved)' : 'Draft regenerated');
    res.locals.audit = { prospectId: id, detail: `${kind} — tokens in ${(usage && usage.input_tokens) || 0} / out ${(usage && usage.output_tokens) || 0}` };
    return { ok: true, draft, usage };
  } catch (e) {
    // Same reasoning as the failed sends: a draft that never came back is worth a line in
    // the log, otherwise a run of Claude failures is invisible.
    // This handler catches its own errors, so mutating()'s catch (and therefore fail()) never
    // sees them — without the explicit reportIssue here a failed generation produced no ref
    // code at all, which is the one case the reference-code feature was asked for by name.
    const ref = reportIssue('draft.generate', e, `prospect ${id}`);
    res.locals.audit = { prospectId: id, detail: `Draft generation FAILED — ${String(e && e.message || e)} (ref ${ref})` };
    return res.json({ ok: false, error: String(e && e.message || e), ref });
  }
}));

// Saving a final email now actually sends it via Gmail (channel 'email' — the only
// channel this endpoint is ever called with; "log outreach sent elsewhere" is the
// separate /external endpoint above, untouched). Sequenced so the send is atomic from
// the caller's perspective: the do-not-contact check and the Gmail-connected check run
// before anything happens, and the prospect record is only updated AFTER the Gmail send
// itself has actually succeeded. If gmail.sendEmail() throws, execution never reaches the
// db.updateProspect()/catalogs.saveApprovedEmail() calls below, so a failed send leaves
// the prospect record completely untouched — no partial state.
app.post('/api/prospects/:id/saveFinal', mutating('prospect.email.send', async (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  const { finalText, meta } = q.body;
  const to = ((meta && meta.to) || '').trim();
  const subject = ((meta && meta.subject) || '').trim();
  const cc = Array.isArray(meta && meta.cc) ? meta.cc.filter(e => typeof e === 'string' && e.trim()).map(e => e.trim()) : [];
  const saveToLibrary = !(meta && meta.saveToLibrary === false);

  if (blockIfExcluded(q, res, id)) return;
  if (!gmail.isConnected()) {
    res.status(409).json({ error: 'Gmail is not connected. Ask an admin to connect it in Settings.' });
    res.locals.skipAudit = true;
    return;
  }
  if (!to || !subject) {
    res.status(400).json({ error: 'A recipient and subject are required.' });
    res.locals.skipAudit = true;
    return;
  }

  const isFollowup = !!(meta && meta.isFollowup);
  const priorIds = JSON.parse(p.gmail_message_ids || '[]');
  const hasThread = isFollowup && p.gmail_thread_id && priorIds.length;

  let sendResult;
  try {
    sendResult = await gmail.sendEmail({
      to, cc, subject, bodyText: finalText,
      threadId: hasThread ? p.gmail_thread_id : undefined,
      inReplyTo: hasThread ? priorIds[priorIds.length - 1] : undefined,
      references: hasThread ? priorIds.join(' ') : undefined
    });
  } catch (e) {
    // A failed send is recorded, not swallowed. Without this the only trace of a failure
    // was a 502 in one browser tab, which is why "sending is unreliable" could never be
    // pinned down: no history of how often it fails, for whom, or with what Gmail error.
    res.status(502).json({ error: 'Could not send via Gmail: ' + e.message });
    res.locals.audit = { prospectId: id, detail: `Gmail send FAILED to ${to} — ${e.message}` };
    return;
  }

  // Only reached once the Gmail send has actually succeeded.
  const patch = {
    final_sent: finalText, status: 'sent', channel: 'email',
    date_sent: new Date().toISOString().slice(0, 10),
    gmail_thread_id: p.gmail_thread_id || sendResult.gmailThreadId || ''
  };
  // Both of these are applied against the live record inside db.updateProspect, not
  // computed from `p` — which was read before the multi-second Gmail send above.
  if (isFollowup) patch.incFollowupCount = true;
  if (sendResult.gmailMessageId) patch.appendMessageId = sendResult.gmailMessageId;
  db.updateProspect(id, patch);
  db.addNote(id, `Sent ${isFollowup ? 'follow-up' : 'outreach'} email to ${to}: "${subject}"`, isFollowup ? 'followup' : 'outreach');
  if (saveToLibrary) {
    catalogs.saveApprovedEmail({
      company_name: p.company_name, recipient: to,
      services: (meta && meta.services) || [], first_draft: p.first_draft || '',
      final_text: finalText, is_followup: isFollowup, saved_at: new Date().toISOString()
    });
  }
  res.locals.audit = {
    prospectId: id,
    detail: `Sent via Gmail to ${to}${cc.length ? ` (cc: ${cc.join(', ')})` : ''}${isFollowup ? (hasThread ? ' — follow-up, threaded' : ' — follow-up, new thread (no prior Gmail thread on file)') : ''}${saveToLibrary ? '' : ' — not saved to library'}`
  };
  return { ok: true };
}));

// ---- Reply lifecycle ----
// Builds a compact, readable history string for the reply-draft prompt (see
// emailEngine.buildReplyPrompt) from the same activity log the reply-review screen
// renders, so Claude and the reviewer are looking at the same timeline.
function buildHistoryText(p) {
  let activity = [];
  try { activity = JSON.parse(p.activity || '[]'); } catch {}
  if (!activity.length) return '(no activity logged yet)';
  return activity.map(a => `- ${a.date}${a.kind ? ` [${a.kind}]` : ''}: ${a.text}`).join('\n');
}
function firstName(full) { return (full || '').trim().split(/\s+/)[0] || ''; }

// Sentence-level templates for the reply screen's quick-select panel, with [company]/
// [name] placeholders filled from the given prospect's dossier. A placeholder that can't
// be matched (no known contact name) is left as literal text rather than guessed.
app.get('/api/reply-templates', (q, res) => {
  try {
    const pid = q.query.prospectId ? +q.query.prospectId : null;
    const p = pid ? db.getProspect(pid) : null;
    const company = p ? (p.dossier.company_name || p.company_name || '') : '';
    const contacts = p && Array.isArray(p.dossier.contacts) ? p.dossier.contacts : [];
    const name = contacts.length ? firstName(contacts[0].name) : '';
    const templates = catalogs.listReplyTemplates().map(t => ({
      id: t.id,
      text: (company ? t.text.split('[company]').join(company) : t.text).split('[name]').join(name || '[name]')
    }));
    ok(res, templates);
  } catch (e) { fail(res, e); }
});

// Read-only: fetches the live reply body from Gmail on demand (not cached — polling only
// stores a snippet, see server.js's pollForReplies below). Any authenticated user.
app.get('/api/prospects/:id/reply-context', async (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!p.last_reply_message_id) return ok(res, { replyText: '' });
    if (!gmail.isConnected()) return res.status(409).json({ error: 'Gmail is not connected.' });
    const replyText = await gmail.getMessageBody(p.last_reply_message_id);
    ok(res, { replyText });
  } catch (e) { fail(res, e); }
});

// Drafts a reply with Claude, from the reply library only (see emailEngine.js). Audited
// like the outreach /generate route: every call spends API tokens even when nothing is
// persisted yet.
app.post('/api/prospects/:id/reply/generate', mutating('prospect.reply.draft.generate', async (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  const { instruction, seedDraft, replyText } = q.body || {};
  if ((instruction || '').length > 280) {
    res.status(400).json({ error: 'Instruction is too long (280 characters max).' });
    res.locals.skipAudit = true;
    return;
  }
  try {
    const { draft, usage } = await emailEngine.generateReplyDraft({
      dossier: p.dossier, replyText: replyText || p.last_reply_snippet || '',
      instruction, historyText: buildHistoryText(p), seedDraft
    });
    res.locals.audit = { prospectId: id, detail: `Reply draft generated — tokens in ${(usage && usage.input_tokens) || 0} / out ${(usage && usage.output_tokens) || 0}` };
    return { ok: true, draft, usage };
  } catch (e) {
    // Same reasoning as the failed sends: a draft that never came back is worth a line in
    // the log, otherwise a run of Claude failures is invisible.
    const ref = reportIssue('reply.draft.generate', e, `prospect ${id}`); // see the outreach-draft catch above
    res.locals.audit = { prospectId: id, detail: `Reply draft generation FAILED — ${String(e && e.message || e)} (ref ${ref})` };
    return res.json({ ok: false, error: String(e && e.message || e), ref });
  }
}));

// Atomic exactly like /saveFinal above: the Gmail send happens first, and the prospect
// record, activity note, and reply-library save only happen once it has actually
// succeeded. Sets status to 'replied' (which also clears awaiting_reply_review and any
// stale dormant tag via db.updateProspect's auto-clear — see db.js).
app.post('/api/prospects/:id/reply/send', mutating('prospect.reply.send', async (q, res) => {
  const id = +q.params.id;
  const p = db.getProspect(id);
  if (!p) { res.status(404).json({ error: 'not found' }); res.locals.skipAudit = true; return; }
  if (blockIfExcluded(q, res, id)) return;
  const { finalText, to, subject, saveToLibrary } = q.body || {};
  const toClean = (to || '').trim();
  const subjClean = (subject || '').trim();
  if (!toClean || !subjClean) { res.status(400).json({ error: 'A recipient and subject are required.' }); res.locals.skipAudit = true; return; }
  if (!p.gmail_thread_id) { res.status(400).json({ error: 'This prospect has no Gmail thread to reply on.' }); res.locals.skipAudit = true; return; }
  if (!gmail.isConnected()) { res.status(409).json({ error: 'Gmail is not connected. Ask an admin to connect it in Settings.' }); res.locals.skipAudit = true; return; }

  const priorIds = JSON.parse(p.gmail_message_ids || '[]');
  let sendResult;
  try {
    sendResult = await gmail.sendEmail({
      to: toClean, subject: subjClean, bodyText: finalText,
      threadId: p.gmail_thread_id, inReplyTo: priorIds[priorIds.length - 1], references: priorIds.join(' ')
    });
  } catch (e) {
    // Recorded rather than swallowed, for the same reason as the outreach send above.
    res.status(502).json({ error: 'Could not send via Gmail: ' + e.message });
    res.locals.audit = { prospectId: id, detail: `Gmail reply send FAILED to ${toClean} — ${e.message}` };
    return;
  }

  const shouldSave = saveToLibrary !== false;
  const patch = { status: 'replied' };
  if (sendResult.gmailMessageId) patch.appendMessageId = sendResult.gmailMessageId;
  db.updateProspect(id, patch);
  db.addNote(id, `Sent reply to ${toClean}: "${subjClean}"`, 'reply');
  if (shouldSave) {
    const dossierContact = (p.dossier.contacts || []).find(c => c.email === toClean);
    catalogs.saveReplyEmail({
      company_name: p.company_name, recipient: toClean,
      recipient_name: dossierContact ? firstName(dossierContact.name) : '',
      final_text: finalText, saved_at: new Date().toISOString()
    });
  }
  res.locals.audit = { prospectId: id, detail: `Sent reply via Gmail to ${toClean}${shouldSave ? '' : ' — not saved to library'}` };
  return { ok: true };
}));

// Admin-only, reachable only from the reply screen (not the main prospect record).
app.post('/api/prospects/:id/dormant', requireAdmin, mutating('prospect.dormant.set', (q, res) => {
  const id = +q.params.id;
  const until = (q.body || {}).returnDate;
  if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) { const e = new Error('A valid return date is required.'); e.status = 400; throw e; }
  const p = db.getProspect(id);
  if (!p) { const e = new Error('not found'); e.status = 404; throw e; }
  db.setDormant(id, until);
  db.addNote(id, `Marked dormant by ${q.user.username}, returns ${until}`, 'dormant');
  res.locals.audit = { prospectId: id, detail: `Marked dormant, returns ${until}` };
  return { ok: true };
}));

// "Ana Muñoz <ana@agency.gov>" → "ana@agency.gov". A bare address passes through.
function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

// Polls only prospects with a Gmail thread on file and not dead — one cheap metadata-only
// Gmail call per active thread, not a global inbox scan. At this app's scale (a bounded
// number of active outreach threads, not thousands) this is well within Gmail's API
// quota. Runs only when Gmail is connected; skips the cycle otherwise, no error surfaced.
// The calls are awaited one at a time, so with enough threads a run can outlast the
// 3-minute interval; the flag keeps the ticks from stacking runs on top of each other.
let pollRunning = false;
async function pollForReplies() {
  if (pollRunning || !gmail.isConnected()) return;
  // Every thread also contains the messages we sent. They cannot be identified by id: the
  // ids stored on a prospect are RFC Message-ID *header* values, while Gmail returns
  // resource ids here — two different namespaces, so the old id filter never matched and
  // each of our own sends was recorded as an incoming reply three minutes later. Filter on
  // the sender instead, which means the poll can't run until we know our own address.
  const ours = gmail.connectedEmail().trim().toLowerCase();
  if (!ours) {
    reportIssue('gmail.replyPoll', new Error('Reply poll skipped: the connected Gmail address is unknown, so our own sent messages cannot be told apart from replies. Reconnect Gmail in Settings.'));
    return;
  }
  pollRunning = true;
  try {
    const candidates = db.listProspects().filter(p => p.gmail_thread_id && p.status !== 'dead');
    for (const p of candidates) {
      try {
        const messages = await gmail.getThreadReplies(p.gmail_thread_id);
        const incoming = messages.filter(m => addressOf(m.from) !== ours);
        if (!incoming.length) continue;
        const latest = incoming[incoming.length - 1];
        if (latest.id === p.last_reply_message_id) continue; // already surfaced
        db.recordReply(p.id, {
          messageId: latest.id, from: latest.from, snippet: latest.snippet,
          at: latest.internalDate ? new Date(Number(latest.internalDate)).toISOString() : new Date().toISOString()
        });
        audit.log({ userId: null, username: 'system (reply poll)', action: 'prospect.reply.detected', prospectId: p.id, detail: `From ${latest.from}` });
        broadcast('reply', { id: p.id, company_name: p.company_name });
      } catch (e) {
        // One coarse scope, deliberately not per-prospect: the usual cause here is global
        // (the Gmail API disabled for the project, a revoked grant), which fails identically
        // for every prospect in the loop. A per-prospect scope gave the identical message a
        // distinct dedup key each time, so one root cause produced one toast per prospect
        // every cycle and grew recentIssues with the prospect count. The id goes to the log.
        reportIssue('gmail.replyPoll', e, `prospect ${p.id}`);
      }
    }
  } finally {
    pollRunning = false;
  }
}
setInterval(() => { pollForReplies().catch(e => reportIssue('gmail.replyPoll', e)); }, 3 * 60 * 1000);

// Independent of Gmail — a plain date check, same cadence. Wrapped because everything in
// here is synchronous file I/O: before the process-level handlers below existed, one failed
// write in a timer took the whole server down.
function checkDormantReturns() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const id of db.listDormantDue(today)) {
      db.returnFromDormant(id);
      db.addNote(id, 'Returned from dormant', 'dormant');
      audit.log({ userId: null, username: 'system (dormant check)', action: 'prospect.dormant.return', prospectId: id, detail: `Returned on ${today}` });
      broadcast('dormant-return', { id });
    }
  } catch (e) {
    reportIssue('dormantReturn', e);
  }
}
setInterval(checkDormantReturns, 3 * 60 * 1000);

// Gmail connection status (boolean only) — any authenticated user, so the send screen
// can gate itself regardless of who's logged in. Full detail (which account, whether
// credentials are configured) is admin-only, in the Admin: Gmail section below.
app.get('/api/gmail/status', (_q, res) => { try { ok(res, { connected: gmail.isConnected() }); } catch (e) { fail(res, e); } });

// CC picker source — any authenticated user. Read-only, minimal shape (no role, no
// creation date) since this is exposed beyond admins.
app.get('/api/users/ccable', (_q, res) => {
  try { ok(res, users.listUsers().filter(u => u.active && u.email).map(u => ({ id: u.id, username: u.username, email: u.email }))); }
  catch (e) { fail(res, e); }
});

// Config
// Readable by any signed-in user, but only the two fields the drafting flow actually
// needs. The rest — the API key's tail, the server's watch-folder path, and the backup
// and digest schedule state — is operational detail that only admins see, and that only
// admins can change through the routes below.
app.get('/api/config', (q, res) => {
  const c = config.get();
  const body = { hasApiKey: config.hasApiKey(), defaultFollowupDays: c.defaultFollowupDays };
  if (q.user && q.user.role === 'admin') Object.assign(body, {
    isAdmin: true,
    keyTail: c.anthropicApiKey ? c.anthropicApiKey.slice(-4) : '',
    draftModel: c.draftModel, watchFolder: watchedDir(),
    backupFrequency: c.backupFrequency, lastBackupAt: c.lastBackupAt,
    digestRecipientIds: c.digestRecipientIds || [], lastDigestWeekKey: c.lastDigestWeekKey
  });
  ok(res, body);
});

// The Anthropic key is app-wide: whoever sets it sets it for every user, and a wrong or
// hostile value silently redirects every draft. Admin-only.
app.post('/api/config/key', requireAdmin, mutating('config.apiKey.update', (q, res) => {
  config.update({ anthropicApiKey: q.body.key });
  res.locals.audit = { detail: 'API key updated' }; // never log the key itself
  return { ok: true, hasApiKey: config.hasApiKey() };
}));

// Google Cloud OAuth client (Client ID/Secret) for the Gmail connection — admin-only,
// same treatment as the Anthropic key: pasted in, stored server-side, never echoed back
// to the browser and never logged. Like the Anthropic key field, the browser never sees
// the stored value (only whether one is set), so a blank submitted field means "leave
// this one alone," not "clear it" — otherwise updating just the Client ID would wipe an
// already-saved Secret the admin didn't retype.
app.post('/api/config/google', requireAdmin, mutating('config.google.update', (q, res) => {
  const body = q.body || {};
  const patch = {};
  if (typeof body.clientId === 'string' && body.clientId.trim()) patch.googleClientId = body.clientId.trim();
  if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) patch.googleClientSecret = body.clientSecret.trim();
  config.update(patch);
  res.locals.audit = { detail: 'Google OAuth client updated' }; // never log the secret itself
  return { ok: true, hasGoogleCreds: config.hasGoogleCreds() };
}));

// Every key here is app-wide (the watch folder, the default follow-up gap, the draft
// model), so the same reasoning as /api/config/key applies.
//
// The whitelist below is narrower than config.update()'s: that one only rejects keys the
// app never reads, which still left this route able to write the two secrets and the
// internal bookkeeping keys (setupCompleted, lastBackupAt, lastDigestWeekKey) that belong
// to the dedicated routes and the schedulers. Those have their own validation and their
// own audit lines; a hand-written body reaching them through here would bypass both.
const CONFIG_POST_KEYS = new Set(['draftModel', 'clerkPhrase', 'defaultFollowupDays', 'watchFolder']);

app.post('/api/config', requireAdmin, mutating('config.update', (q, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(q.body || {})) if (CONFIG_POST_KEYS.has(k)) patch[k] = v;
  config.update(patch);
  if ('watchFolder' in patch) restartWatching();
  res.locals.audit = { detail: JSON.stringify(patch) };
  return { ok: true, watchFolder: watchedDir() };
}));

app.get('/api/watched/path', requireAdmin, (_q, res) => ok(res, { path: watchedDir() }));

// Catalogs
// The firm facts and service catalog are the raw material of every draft the app writes,
// so both reading and rewriting them is admin-only. `which` is validated against an
// explicit list rather than falling through to firm-and-people on anything unrecognized:
// a typo'd path used to silently read (or overwrite) the wrong catalog.
const CATALOGS = {
  services: [catalogs.readServices, catalogs.writeServices],
  firm: [catalogs.readFirmFacts, catalogs.writeFirmFacts],
  'firm-and-people': [catalogs.readFirmFacts, catalogs.writeFirmFacts] // matches the filename on disk
};

app.get('/api/catalog/:which', requireAdmin, (q, res) => {
  const entry = CATALOGS[q.params.which];
  if (!entry) return res.status(404).json({ error: 'Unknown catalog' });
  ok(res, { text: entry[0]() });
});

app.post('/api/catalog/:which', requireAdmin, mutating('catalog.update', (q, res) => {
  const which = q.params.which;
  const entry = CATALOGS[which];
  if (!entry) { res.status(404).json({ error: 'Unknown catalog' }); res.locals.skipAudit = true; return; }
  const text = (q.body || {}).text;
  if (typeof text !== 'string') { res.status(400).json({ error: 'text must be a string' }); res.locals.skipAudit = true; return; }
  entry[1](text);
  res.locals.audit = { detail: `${which} catalog updated (${text.length} chars)` };
  return { ok: true };
}));

// ---- Admin: user management ----
// Self-lockout protection: an admin may not deactivate their own account, or demote
// themselves away from admin, unless another active admin exists. This is the enforced
// version of "appoint another admin before removing your own access."
function otherActiveAdminExists(excludeId) {
  return users.listUsers().some(u => u.role === 'admin' && u.active && u.id !== excludeId);
}
function blockSelfLockout(req, targetId, wouldLoseAdminAccess) {
  if (targetId === req.user.id && wouldLoseAdminAccess && !otherActiveAdminExists(targetId)) {
    const e = new Error('You are the only admin. Appoint another admin before removing your own access.');
    e.status = 403;
    throw e;
  }
}

app.get('/api/admin/users', requireAdmin, (_q, res) => { try { ok(res, users.listUsers()); } catch (e) { fail(res, e); } });

// Invite link + email body shared by user creation and resend below.
function inviteLink(req, token) { return `${req.protocol}://${req.get('host')}/?invite=${token}`; }
function inviteEmailBody(username, link) {
  return `Hi ${username},\n\nAn account has been created for you on GovSpring Prospecting. Use the link below to set your password and log in. This link expires in 48 hours.\n\n${link}\n\nIf you weren't expecting this, you can ignore this email.`;
}

// Creates the account and emails an invite with a one-time set-password link (see
// users.createInvitedUser) — no password is set here; that only happens via the link. If
// Gmail isn't connected, the account is still created (not blocked on an unrelated
// integration being down) but the response flags that the email couldn't be sent, so the
// admin knows to use "Resend invite" later.
//
// If the request includes a `password` field, skip the invite/email flow entirely and set
// it directly (users.createUser) — for handing someone a working login when Gmail isn't
// connected yet to send the invite link. The admin should tell them to change it via
// "Reset password" in this same panel once they're in.
app.post('/api/admin/users', requireAdmin, mutating('user.create', async (q, res) => {
  const body = q.body || {};
  if (body.password) {
    const user = users.createUser(body);
    res.locals.audit = { detail: `Created user "${user.username}" (${user.role}) with a directly-set password` };
    return { ...user, inviteEmailSent: false, inviteEmailError: '' };
  }
  const { user, inviteToken } = users.createInvitedUser(body);
  let inviteEmailSent = false, inviteEmailError = '';
  if (gmail.isConnected()) {
    try {
      await gmail.sendInviteEmail({ to: user.email, subject: 'Set up your GovSpring Prospecting account', bodyText: inviteEmailBody(user.username, inviteLink(q, inviteToken)) });
      inviteEmailSent = true;
    } catch (e) { inviteEmailError = e.message; }
  } else {
    inviteEmailError = 'Gmail is not connected — the invite email could not be sent. Use "Resend invite" once Gmail is connected.';
  }
  res.locals.audit = { detail: `Created user "${user.username}" (${user.role})${inviteEmailSent ? '' : ' — invite email not sent'}` };
  return { ...user, inviteEmailSent, inviteEmailError };
}));

app.post('/api/admin/users/:id/resend-invite', requireAdmin, mutating('user.invite.resend', async (q, res) => {
  const { user, inviteToken } = users.resendInvite(+q.params.id);
  let inviteEmailSent = false, inviteEmailError = '';
  if (gmail.isConnected()) {
    try {
      await gmail.sendInviteEmail({ to: user.email, subject: 'Set up your GovSpring Prospecting account', bodyText: inviteEmailBody(user.username, inviteLink(q, inviteToken)) });
      inviteEmailSent = true;
    } catch (e) { inviteEmailError = e.message; }
  } else {
    inviteEmailError = 'Gmail is not connected — the invite email could not be sent.';
  }
  res.locals.audit = { detail: `Resent invite to "${user.username}"${inviteEmailSent ? '' : ' — invite email not sent'}` };
  return { ...user, inviteEmailSent, inviteEmailError };
}));

app.post('/api/admin/users/:id/deactivate', requireAdmin, mutating('user.deactivate', (q, res) => {
  const id = +q.params.id;
  blockSelfLockout(q, id, true);
  const u = users.setActive(id, false);
  res.locals.audit = { detail: `Deactivated user "${u.username}"` };
  return u;
}));

app.post('/api/admin/users/:id/reactivate', requireAdmin, mutating('user.reactivate', (q, res) => {
  const u = users.setActive(+q.params.id, true);
  res.locals.audit = { detail: `Reactivated user "${u.username}"` };
  return u;
}));

app.post('/api/admin/users/:id/role', requireAdmin, mutating('user.role.change', (q, res) => {
  const id = +q.params.id;
  const newRole = (q.body || {}).role;
  blockSelfLockout(q, id, newRole !== 'admin');
  const before = users.findById(id);
  const beforeRole = before ? before.role : '?';
  const u = users.setRole(id, newRole);
  res.locals.audit = { detail: `Changed role of "${u.username}" from ${beforeRole} to ${u.role}` };
  return u;
}));

app.post('/api/admin/users/:id/password', requireAdmin, mutating('user.password.reset', (q, res) => {
  const u = users.resetPassword(+q.params.id, (q.body || {}).password);
  res.locals.audit = { detail: `Reset password for "${u.username}"` }; // never log the password itself
  return { ok: true };
}));

// Sets a user's email address (used by the CC picker on the send screen — see
// /api/users/ccable). Admin-only, not self-service; keeps this change scoped to what the
// Gmail feature needs rather than building a full profile-editing surface.
app.post('/api/admin/users/:id/email', requireAdmin, mutating('user.email.update', (q, res) => {
  const u = users.setEmail(+q.params.id, (q.body || {}).email);
  res.locals.audit = { detail: `Set email for "${u.username}" to "${u.email || '(cleared)'}"` };
  return u;
}));

// ---- Admin: Gmail connection ----
// The redirect_uri Google requires must exactly match what's registered on the OAuth
// client and what's sent on both the authorize request and the token exchange — derived
// from the incoming request so the same code works for local dev and the Railway domain
// without configuration, as long as both are registered as authorized redirect URIs.
function gmailRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/api/admin/gmail/callback`;
}

app.get('/api/admin/gmail/status', requireAdmin, (_q, res) => {
  try { ok(res, { ...gmail.getStatus(), hasCreds: config.hasGoogleCreds() }); }
  catch (e) { fail(res, e); }
});

app.get('/api/admin/gmail/connect', requireAdmin, (req, res) => {
  try { res.redirect(gmail.getAuthUrl(gmailRedirectUri(req))); }
  catch (e) { res.status(400).send(String(e.message || e)); }
});

// OAuth redirect target — see the AUDIT CONVENTION exception list above for why this
// doesn't use mutating(). Reached by the browser navigating back from Google's consent
// screen, still carrying the admin's session cookie from when they clicked Connect.
app.get('/api/admin/gmail/callback', requireAdmin, async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?gmail=error');
    await gmail.exchangeCode(req.query.code, gmailRedirectUri(req));
    audit.log({ userId: req.user.id, username: req.user.username, action: 'gmail.connect', detail: `Connected as ${gmail.getStatus().email}` });
    res.redirect('/?gmail=connected');
  } catch (e) {
    const ref = reportIssue('gmail.oauthCallback', e);
    res.redirect('/?gmail=error&ref=' + ref);
  }
});

app.post('/api/admin/gmail/disconnect', requireAdmin, mutating('gmail.disconnect', (_q, res) => {
  const wasEmail = gmail.getStatus().email;
  gmail.disconnect();
  res.locals.audit = { detail: wasEmail ? `Disconnected ${wasEmail}` : 'Disconnected' };
  return { ok: true };
}));

// ---- Admin: backup ----
// Dead-pile review (see public/renderer.js): every currently-dead prospect, plus enough
// context to decide keep/restore at a glance. "Who marked it dead" comes from the audit
// log (no schema change needed there); "why" comes from the prospect's own activity log,
// since marking a prospect dead now optionally prompts for a one-line reason that gets
// saved as its most recent note (see renderer.js) — for prospects marked dead before this
// existed, there simply isn't one to show. Read-only: no mutating() needed.
app.get('/api/admin/backup/dead-pile', requireAdmin, (_q, res) => {
  try {
    const dead = db.listProspects().filter(p => p.status === 'dead');
    const result = dead.map(p => {
      let activity = [];
      try { activity = JSON.parse(p.activity || '[]'); } catch {}
      const reason = activity.length ? activity[activity.length - 1].text : '';
      const entries = audit.list({ action: 'prospect.update', prospectId: p.id });
      let markedBy = '', markedAt = '';
      for (const e of entries) {
        try {
          if (JSON.parse(e.detail || '{}').status === 'dead') { markedBy = e.username; markedAt = e.at; break; }
        } catch {}
      }
      return { id: p.id, company_name: p.company_name, fit_score: p.fit_score, reason, markedBy, markedAt, restoreStatus: p.pre_dead_status || 'new' };
    });
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// Generates and streams the backup zip. A GET that returns binary, not JSON, so it
// doesn't fit mutating()'s res.json() contract (same reasoning as the Gmail OAuth
// callback) — audited manually instead, matching that precedent.
app.get('/api/admin/backup/download', requireAdmin, (req, res) => {
  try {
    const { buffer, filename } = backup.buildBackupZip(DATA_DIR);
    audit.log({ userId: req.user.id, username: req.user.username, action: 'backup.download', detail: filename });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(buffer);
  } catch (e) { fail(res, e); }
});

const BACKUP_FREQUENCIES = new Set(['off', 'daily', '3days', 'weekly']);
app.post('/api/config/backup-schedule', requireAdmin, mutating('config.backup.update', (q, res) => {
  const freq = (q.body || {}).backupFrequency;
  if (!BACKUP_FREQUENCIES.has(freq)) { const e = new Error('Invalid backup frequency'); e.status = 400; throw e; }
  if (freq !== 'off' && !gmail.isConnected()) { const e = new Error('Connect Gmail before enabling scheduled backups.'); e.status = 400; throw e; }
  const patch = { backupFrequency: freq };
  // Start the clock now, the first time scheduling is turned on, so the first automatic
  // backup fires one full interval from now rather than immediately.
  if (freq !== 'off' && !config.get().lastBackupAt) patch.lastBackupAt = new Date().toISOString();
  config.update(patch);
  res.locals.audit = { detail: `Backup schedule set to ${freq}` };
  return { ok: true, backupFrequency: freq };
}));

// Checked periodically rather than with one long-lived setTimeout, so a server restart, a
// schedule change, or Gmail disconnecting all self-correct on the next check instead of
// needing special-case handling. lastBackupAt persists in config.json, so the schedule
// survives restarts.
const BACKUP_INTERVAL_MS = { daily: 24 * 60 * 60 * 1000, '3days': 3 * 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
// The watermark (lastBackupAt) is only written once a send succeeds, so a run that takes
// longer than the 5-minute check interval would otherwise be started again by the next
// tick — and again by the one after that, each rebuilding the whole zip and holding it in
// memory. One flag, cleared in a finally, is enough to make the checks skip a run in flight.
let backupRunning = false;
// A failing backup used to be retried every 5 minutes forever — rebuilding and
// re-compressing the entire data directory each time, for a cause (no Gmail creds, a file
// too big, a Google outage) that five minutes never fixes. Back off instead: 15 min, then
// 1 h, then 6 h between attempts, reset the moment one succeeds.
const BACKUP_RETRY_BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
let backupFailures = 0;
let backupRetryAfter = 0;
async function checkScheduledBackup() {
  if (backupRunning) return;
  if (Date.now() < backupRetryAfter) return;
  const cfg = config.get();
  const intervalMs = BACKUP_INTERVAL_MS[cfg.backupFrequency];
  if (!intervalMs) return; // 'off'
  const last = cfg.lastBackupAt ? new Date(cfg.lastBackupAt).getTime() : Date.now();
  if (Date.now() - last < intervalMs) return;
  if (!gmail.isConnected()) { reportIssue('backup.scheduled', new Error('Scheduled backup is due but Gmail is not connected; will retry next check.')); return; }
  backupRunning = true;
  try {
    const { buffer, filename, skipped } = backup.buildBackupZip(DATA_DIR);
    await gmail.sendAttachmentEmail({
      to: 'marcos@govspringlegal.com',
      subject: `GovSpring Prospecting backup — ${filename}`,
      bodyText: 'Attached is the scheduled backup of the GovSpring Prospecting database.',
      attachment: { filename, contentType: 'application/zip', data: buffer }
    });
    config.update({ lastBackupAt: new Date().toISOString() });
    backupFailures = 0;
    backupRetryAfter = 0;
    const note = skipped && skipped.length ? ` (${skipped.length} file(s) skipped: ${skipped.join(', ')})` : '';
    audit.log({ userId: null, username: 'system (scheduled backup)', action: 'backup.scheduled', detail: filename + note });
  } catch (e) {
    const waitMs = BACKUP_RETRY_BACKOFF_MS[Math.min(backupFailures, BACKUP_RETRY_BACKOFF_MS.length - 1)];
    backupFailures++;
    backupRetryAfter = Date.now() + waitMs;
    const retryIn = `next attempt in ${Math.round(waitMs / 60000)} min`;
    const ref = reportIssue('backup.scheduled', e);
    audit.log({ userId: null, username: 'system (scheduled backup)', action: 'backup.failed', detail: `${e.message} (attempt ${backupFailures}, ${retryIn}, ref ${ref})` });
  } finally {
    backupRunning = false;
  }
}
setInterval(() => { checkScheduledBackup().catch(e => reportIssue('backup.scheduled', e)); }, 5 * 60 * 1000);

// Admin-only removal, used from a blocked-send screen's "remove and send" action. Not a
// general exclusions-management surface — that's out of scope for this feature.
app.post('/api/admin/exclusions/remove', requireAdmin, mutating('exclusion.remove', (q, res) => {
  const { match_type, value } = q.body || {};
  if (!match_type || !value) { const e = new Error('match_type and value are required'); e.status = 400; throw e; }
  const result = db.removeExclusion(match_type, value);
  res.locals.audit = { detail: `Removed exclusion ${match_type}="${value}"` };
  return result;
}));

// ---- Weekly digest ----
// Compiled entirely from db.js/audit.js data (see digest.js) — no Claude calls. Shared by
// the Monday scheduler and the manual "send now" endpoint below.
async function sendDigest() {
  const cfg = config.get();
  const recipientEmails = (cfg.digestRecipientIds || [])
    .map(id => users.findById(id))
    .filter(u => u && u.active && u.email)
    .map(u => u.email);
  const to = [...new Set(['marcos@govspringlegal.com', ...recipientEmails])].join(', ');
  const { subject, bodyText } = digest.buildDigest({ prospects: db.listProspects(), auditEntries: audit.list({}) });
  await gmail.sendStandaloneEmail({ to, subject, bodyText });
  return { to, subject };
}

app.post('/api/config/digest-recipients', requireAdmin, mutating('config.digest.update', (q, res) => {
  const ids = Array.isArray((q.body || {}).recipientIds) ? q.body.recipientIds.map(Number).filter(Number.isInteger) : [];
  config.update({ digestRecipientIds: ids });
  res.locals.audit = { detail: `Digest recipients set to [${ids.join(', ')}] (plus marcos@govspringlegal.com, always included)` };
  return { ok: true, digestRecipientIds: ids };
}));

// Immediate, clear feedback to the admin if Gmail isn't connected — unlike the scheduled
// path below, someone is actually waiting on this response.
app.post('/api/admin/digest/send-now', requireAdmin, mutating('digest.sent', async (q, res) => {
  if (!gmail.isConnected()) { const e = new Error('Gmail is not connected. Connect it in Settings first.'); e.status = 409; throw e; }
  const { to, subject } = await sendDigest();
  config.update({ lastDigestWeekKey: digest.nyWeekKey(new Date()) });
  res.locals.audit = { detail: `Sent to ${to} — ${subject} (manual)` };
  return { ok: true, to };
}));

// Checked every 15 minutes (coarser than the reply-poll's 3 minutes — this only needs to
// fire once a week) rather than one long-lived timer, so a restart mid-window just picks
// up on the next check. "6am EST" is resolved as actual America/New_York wall-clock time
// (via Node's built-in Intl, no new dependency), not a fixed UTC-5 offset that would drift
// during daylight saving. lastDigestWeekKey persists in config.json, so neither a restart
// nor a missed week can cause a double-send; a week where Gmail was disconnected the whole
// time is logged once as missed and not retried into the following week.
//
// The week key is written only when the digest actually goes out, or once the retry window
// below has closed. Writing it unconditionally meant one blip at 06:00 — a Gmail hiccup, a
// redeploy mid-send — cancelled the entire week silently.
const DIGEST_RETRY_UNTIL_HOUR = 12; // NY time; after this the week is recorded as missed
let digestRunning = false;          // a slow send must not be started again by the next tick
async function checkDigestSchedule() {
  if (digestRunning) return;
  const now = new Date();
  const ny = digest.nyParts(now);
  if (ny.weekday !== 'Mon' || ny.hour < 6) return;
  const weekKey = digest.nyWeekKey(now);
  if (config.get().lastDigestWeekKey === weekKey) return;
  const windowClosed = ny.hour >= DIGEST_RETRY_UNTIL_HOUR;

  if (!gmail.isConnected()) {
    if (!windowClosed) { reportIssue('digest.schedule', new Error('Monday digest: Gmail is not connected; will retry at the next check.')); return; }
    audit.log({ userId: null, username: 'system (digest schedule)', action: 'digest.missed', detail: 'Gmail was not connected between 06:00 and 12:00; the Monday digest could not be sent.' });
    config.update({ lastDigestWeekKey: weekKey });
    return;
  }

  digestRunning = true;
  try {
    const { to, subject } = await sendDigest();
    audit.log({ userId: null, username: 'system (digest schedule)', action: 'digest.sent', detail: `Sent to ${to} — ${subject}` });
    config.update({ lastDigestWeekKey: weekKey });
  } catch (e) {
    if (!windowClosed) { reportIssue('digest.schedule', e); return; }
    const ref = reportIssue('digest.schedule', e);
    audit.log({ userId: null, username: 'system (digest schedule)', action: 'digest.missed', detail: `Send kept failing until 12:00: ${e.message} (ref ${ref})` });
    config.update({ lastDigestWeekKey: weekKey });
  } finally {
    digestRunning = false;
  }
}
setInterval(() => { checkDigestSchedule().catch(e => reportIssue('digest.schedule', e)); }, 15 * 60 * 1000);
checkDigestSchedule().catch(e => reportIssue('digest.schedule', e));

// ---- Admin: audit log ----
// Supports three views admins need: (1) who did a given action — filter by action, read
// the username per row; (2) everything one user did, with timestamps — filter by user;
// (3) everything anyone did in a recent window — the range filter, independent of the
// other two.
function rangeCutoff(range) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (range === 'day') return new Date(now - day).toISOString();
  if (range === 'week') return new Date(now - 7 * day).toISOString();
  if (range === 'month') return new Date(now - 30 * day).toISOString();
  return null;
}
app.get('/api/admin/audit', requireAdmin, (q, res) => {
  try { ok(res, audit.list({ userId: q.query.userId, action: q.query.action, since: rangeCutoff(q.query.range) })); }
  catch (e) { fail(res, e); }
});
app.get('/api/admin/audit/actions', requireAdmin, (_q, res) => { try { ok(res, audit.distinctActions()); } catch (e) { fail(res, e); } });

// An unknown /api path is a bug, not a page. Without this it fell through to the catch-all
// below and returned index.html with status 200, so a typo'd or removed endpoint looked to
// the browser like a successful call whose JSON just failed to parse.
// Registered with app.use, not app.all: app.all would add a route layer that the audit
// coverage self-check below then reports as an unaudited state-changing endpoint.
app.use('/api', (_q, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// Fallback to the UI for any other route.
app.get('*', (_q, res) => res.sendFile(path.join(APP_DIR, 'public', 'index.html')));

// ---- Startup self-check: warn if a state-changing route isn't audited ----
// Walks the registered routes and flags any POST/PATCH/PUT/DELETE /api/* route that
// wasn't wired through mutating(). The four routes documented as exceptions in the AUDIT
// CONVENTION comment above are expected to fail this check and are excluded on purpose.
const AUDIT_EXEMPT_ROUTES = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/prospects/upload', '/api/admin/gmail/callback', '/api/auth/accept-invite']);
function checkAuditCoverage() {
  try {
    const offenders = [];
    for (const layer of app._router.stack) {
      if (!layer.route) continue;
      const routePath = layer.route.path;
      const methods = Object.keys(layer.route.methods).filter(m => ['post', 'patch', 'put', 'delete'].includes(m));
      if (!methods.length || !routePath.startsWith('/api/') || AUDIT_EXEMPT_ROUTES.has(routePath)) continue;
      const audited = layer.route.stack.some(s => s.handle && s.handle.__audited);
      if (!audited) offenders.push(`${methods.join('/').toUpperCase()} ${routePath}`);
    }
    if (offenders.length) {
      console.warn('\n⚠️  AUDIT COVERAGE WARNING — these state-changing routes are not wired through mutating():');
      offenders.forEach(o => console.warn('   ' + o));
      console.warn('   Every route that creates/modifies/deletes data must call mutating(), or be added to AUDIT_EXEMPT_ROUTES with a reason.\n');
    }
  } catch (e) {
    console.warn('Audit coverage self-check could not run:', e.message);
  }
}
checkAuditCoverage();

// ---- Process-level safety nets ----
// Node makes an unhandled promise rejection fatal by default (v15+), so one rejected
// promise anywhere — a Gmail call in an interval, a digest send — would take the whole
// server down and log nothing useful. These log the real error and keep serving; a crash
// on Railway means every user is signed out of a working app for no reason.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION — the server is staying up. Cause:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — the server is staying up. Cause:', err);
});

// Bind to 0.0.0.0 so Railway's proxy can reach the container (and, on a local run, so the
// app is reachable from another device on the same private network). Access control is the
// session cookie and the /api gate above, not the bind address.
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  GovSpring Prospecting is running.');
  // The Tailscale line here was left over from the desktop build; this deploys on Railway
  // now, and the team reaches it at the service's public domain.
  if (ON_RAILWAY) console.log('  Public URL: whatever domain is attached to this Railway service');
  else console.log('  On this computer:      http://localhost:' + PORT);
  console.log(`  Secure session cookies: ${COOKIE_SECURE ? 'on' : 'off (no TLS expected)'}`);
  console.log('');
});

// Railway sends SIGTERM on every redeploy and then SIGKILLs after a grace period. Closing
// the listener first lets in-flight requests finish, so a redeploy landing mid-save can't
// cut a write off part-way; the watcher is closed too so it doesn't hold the process open.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received — shutting down.`);
    server.close(() => {
      if (watcher) watcher.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref(); // don't hang forever on a stuck socket
  });
}
