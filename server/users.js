// users.js — individual user accounts: login, role, active/inactive status.
// Same crypto approach as the rest of the app (Node's built-in `crypto`, scrypt hashing,
// timing-safe comparison) — see auth.js for the token/session half of authentication.
// Stored as its own atomic JSON file (data/users.json), independent of the main prospect
// database (server/db.js), which this feature does not touch.

const path = require('path');
const crypto = require('crypto');
const store_ = require('./store');

const MIN_PASSWORD_LENGTH = 8;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // reset links are short-lived: 1 hour

let usersPath;
let store = { users: [], nextId: 1 };

function init(dataDir) {
  usersPath = path.join(dataDir, 'users.json');
  load();
}

function load() {
  const raw = store_.readJSON(usersPath); // throws on a corrupt/unreadable file
  if (!raw) return save(); // genuinely no file yet: write the empty store
  store = raw;
  store.users = store.users || [];
  store.nextId = store.nextId || store_.nextIdFrom(store.users);
  let healed = false;
  for (const u of store.users) {
    if (u.email === undefined) u.email = ''; // forward-compat with pre-email accounts
    // Self-heal: `pending` and passwordHash must agree — every code path that sets a
    // password (acceptInvite, resetPassword, admin direct-password create) also clears
    // pending, so a row that is both pending and has a usable hash means the two fields
    // drifted (e.g. a hand-edited data file). The hash is the actual source of truth for
    // whether someone can log in; the badge should follow it, not a separate flag that
    // can get stuck stale after the person already finished setting up their account.
    if (u.pending && u.passwordHash) {
      u.pending = false;
      u.inviteToken = '';
      u.inviteExpiresAt = '';
      healed = true;
    }
  }
  if (healed) save();
}

function save() {
  store_.writeJSON(usersPath, store);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash), b = Buffer.from(check);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function normalizeUsername(u) { return String(u || '').trim().toLowerCase(); }

function hasAnyUser() { return store.users.length > 0; }

function findByUsername(username) {
  const n = normalizeUsername(username);
  return store.users.find(u => u.usernameLower === n) || null;
}

function findById(id) {
  return store.users.find(u => u.id === id) || null;
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

function createUser({ username, password, role, email }) {
  const clean = String(username || '').trim();
  if (!clean) throw err(400, 'Username required');
  if (findByUsername(clean)) throw err(400, 'Username already taken');
  if (!password || password.length < MIN_PASSWORD_LENGTH) throw err(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const cleanEmail = String(email || '').trim();
  if (cleanEmail && !EMAIL_PATTERN.test(cleanEmail)) throw err(400, 'Email address looks invalid');
  const u = {
    id: store.nextId++,
    username: clean,
    usernameLower: normalizeUsername(clean),
    passwordHash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    email: cleanEmail,
    active: true,
    createdAt: new Date().toISOString()
  };
  store.users.push(u);
  save();
  return safe(u);
}

// Creates a user with no usable password (empty hash — verifyPassword safely rejects any
// login attempt against it) and a random one-time invite token, valid 48 hours. Used only
// by the admin Users panel (POST /api/admin/users in server.js), which emails the token as
// a set-password link. Distinct from createUser() above, which stays exactly as it was for
// the one place that still sets a password directly: first-run setup, which has no admin
// or Gmail connection yet to send an invite through.
function createInvitedUser({ username, role, email }) {
  const clean = String(username || '').trim();
  if (!clean) throw err(400, 'Username required');
  if (findByUsername(clean)) throw err(400, 'Username already taken');
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw err(400, 'Email is required');
  if (!EMAIL_PATTERN.test(cleanEmail)) throw err(400, 'Email address looks invalid');
  const u = {
    id: store.nextId++,
    username: clean,
    usernameLower: normalizeUsername(clean),
    passwordHash: '',
    role: role === 'admin' ? 'admin' : 'user',
    email: cleanEmail,
    active: true,
    pending: true,
    inviteToken: crypto.randomBytes(24).toString('base64url'),
    inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString()
  };
  store.users.push(u);
  save();
  return { user: safe(u), inviteToken: u.inviteToken };
}

// Regenerates the token+expiry for a still-pending user (implicitly invalidating any
// earlier link, since only the current stored token is ever checked). Not meaningful once
// a user has set their password.
function resendInvite(id) {
  const u = findById(id);
  if (!u) throw err(404, 'User not found');
  if (!u.pending) throw err(400, 'This user has already set their password');
  u.inviteToken = crypto.randomBytes(24).toString('base64url');
  u.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  save();
  return { user: safe(u), inviteToken: u.inviteToken };
}

function findByInviteToken(token) {
  return store.users.find(u => u.pending && u.inviteToken && u.inviteToken === token) || null;
}

// Validates the token and expiry, sets the password, and clears the invite — the account
// is fully activated from here on, indistinguishable from one created via createUser().
function acceptInvite(token, password) {
  const u = findByInviteToken(token);
  if (!u) throw err(400, 'Invalid or already-used invitation link');
  if (new Date(u.inviteExpiresAt).getTime() < Date.now()) throw err(400, 'This invitation link has expired. Ask an admin to resend it.');
  if (!password || password.length < MIN_PASSWORD_LENGTH) throw err(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  u.passwordHash = hashPassword(password);
  u.pending = false;
  u.inviteToken = '';
  u.inviteExpiresAt = '';
  u.pwChangedAt = new Date().toISOString(); // see auth.js: retires sessions issued before now
  save();
  return safe(u);
}

// ---- Self-service password reset ("forgot password" on the login page) ----
// Same one-time-token pattern as invites, but shorter-lived and only for accounts that
// can already log in (active, not pending, hash set) AND have an email on file to send
// the link to. Returns null rather than throwing when nothing matches, so the route can
// give the same generic answer either way (no account enumeration).
function startPasswordReset(identifier) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return null;
  const u = store.users.find(x =>
    x.active && !x.pending && x.passwordHash &&
    (x.usernameLower === clean || (x.email && x.email.toLowerCase() === clean)));
  if (!u || !u.email) return null;
  u.resetToken = crypto.randomBytes(24).toString('base64url');
  u.resetExpiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  save();
  return { user: safe(u), resetToken: u.resetToken, email: u.email };
}

function findByResetToken(token) {
  return store.users.find(u => u.resetToken && u.resetToken === token) || null;
}

function completePasswordReset(token, password) {
  const u = findByResetToken(token);
  if (!u) throw err(400, 'Invalid or already-used reset link');
  if (new Date(u.resetExpiresAt).getTime() < Date.now()) throw err(400, 'This reset link has expired. Request a new one from the login page.');
  if (!password || password.length < MIN_PASSWORD_LENGTH) throw err(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  u.passwordHash = hashPassword(password);
  u.resetToken = '';
  u.resetExpiresAt = '';
  u.pwChangedAt = new Date().toISOString(); // see auth.js: retires sessions issued before now
  save();
  return safe(u);
}

// Used for the CC picker on the send screen — set (or cleared) by an admin from the
// Users panel. Not self-service; keeps the change scoped to what the feature needs.
function setEmail(id, email) {
  const u = findById(id);
  if (!u) throw err(404, 'User not found');
  const clean = String(email || '').trim();
  if (clean && !EMAIL_PATTERN.test(clean)) throw err(400, 'Email address looks invalid');
  u.email = clean;
  save();
  return safe(u);
}

// REMOVED: ensureTestUser() / findByTestLoginSlug().
// These created a permanent no-password account with role 'admin' and noLog: true, reached
// through a fixed URL slug that GET /api/auth/test-login/:slug traded for a 30-day admin
// session with no credentials. That route sat above the /api auth gate, the login rate
// limiter did not cover it, and noLog meant anything done through the account left no audit
// entry — and the slug travelled inside every emailed backup zip. Any existing 'test' row in
// users.json is left in place (it cannot log in: verifyPassword rejects an empty hash, and
// the route is gone), so no stored data changes. Deactivate it from the Users panel to hide
// it from the list.

function checkLogin(username, password) {
  const u = findByUsername(username);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.passwordHash)) return null;
  return safe(u);
}

function listUsers() { return store.users.map(safe); }

function setActive(id, active) {
  const u = findById(id);
  if (!u) throw err(404, 'User not found');
  u.active = !!active;
  save();
  return safe(u);
}

function setRole(id, role) {
  const u = findById(id);
  if (!u) throw err(404, 'User not found');
  if (role !== 'admin' && role !== 'user') throw err(400, 'Invalid role');
  u.role = role;
  save();
  return safe(u);
}

function resetPassword(id, newPassword) {
  const u = findById(id);
  if (!u) throw err(404, 'User not found');
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) throw err(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  u.passwordHash = hashPassword(newPassword);
  u.pending = false;
  u.inviteToken = '';
  u.inviteExpiresAt = '';
  u.resetToken = ''; // an admin reset also voids any outstanding self-service reset link
  u.resetExpiresAt = '';
  u.pwChangedAt = new Date().toISOString(); // see auth.js: retires sessions issued before now
  save();
  return safe(u);
}

// Never expose the password hash, the lowercased lookup key, or the raw invite token
// (a live, single-use credential — same trust boundary as a password) — pending/
// inviteExpiresAt are safe to show (they're what the Users panel needs to offer "resend").
function safe(u) {
  const { passwordHash, usernameLower, inviteToken, resetToken, testLoginSlug, ...rest } = u;
  return rest;
}

module.exports = {
  init, hasAnyUser, createUser, checkLogin, findById, findByUsername,
  listUsers, setActive, setRole, setEmail, resetPassword, MIN_PASSWORD_LENGTH,
  createInvitedUser, resendInvite, acceptInvite, findByInviteToken,
  startPasswordReset, findByResetToken, completePasswordReset
};
