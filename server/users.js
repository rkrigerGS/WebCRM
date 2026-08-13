// users.js — individual user accounts: login, role, active/inactive status.
// Same crypto approach as the rest of the app (Node's built-in `crypto`, scrypt hashing,
// timing-safe comparison) — see auth.js for the token/session half of authentication.
// Stored as its own atomic JSON file (data/users.json), independent of the main prospect
// database (server/db.js), which this feature does not touch.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

let usersPath;
let store = { users: [], nextId: 1 };

function init(dataDir) {
  usersPath = path.join(dataDir, 'users.json');
  load();
}

function load() {
  try {
    store = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    store.users = store.users || [];
    store.nextId = store.nextId || (store.users.reduce((m, u) => Math.max(m, u.id), 0) + 1);
    for (const u of store.users) if (u.email === undefined) u.email = ''; // forward-compat with pre-email accounts
  } catch {
    save(); // no file yet: write the empty store
  }
}

// Atomic save: write to a temp file then rename over the real one (matches db.js).
function save() {
  const tmp = usersPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, usersPath);
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

// A single, no-password "test" account for handing the app to someone quickly. It has no
// usable password (same empty-hash trick as createInvitedUser) and is instead reached via
// a fixed random URL slug (see /api/auth/test-login/:slug in server.js). Idempotent: if
// the account already exists (e.g. from a prior deploy), returns it and its existing slug
// unchanged rather than minting a new one, so the URL you shared with someone keeps working.
function ensureTestUser() {
  let u = findByUsername('test');
  if (u) return { user: safe(u), slug: u.testLoginSlug };
  const slug = crypto.randomBytes(6).toString('base64url');
  u = {
    id: store.nextId++,
    username: 'test',
    usernameLower: 'test',
    passwordHash: '',
    role: 'admin',
    email: '',
    active: true,
    testUser: true,
    noLog: true,
    testLoginSlug: slug,
    createdAt: new Date().toISOString()
  };
  store.users.push(u);
  save();
  return { user: safe(u), slug };
}

function findByTestLoginSlug(slug) {
  return store.users.find(u => u.testUser && u.testLoginSlug && u.testLoginSlug === slug) || null;
}

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
  save();
  return safe(u);
}

// Never expose the password hash, the lowercased lookup key, or the raw invite token
// (a live, single-use credential — same trust boundary as a password) — pending/
// inviteExpiresAt are safe to show (they're what the Users panel needs to offer "resend").
function safe(u) {
  const { passwordHash, usernameLower, inviteToken, testLoginSlug, ...rest } = u;
  return rest;
}

module.exports = {
  init, hasAnyUser, createUser, checkLogin, findById, findByUsername,
  listUsers, setActive, setRole, setEmail, resetPassword, MIN_PASSWORD_LENGTH,
  createInvitedUser, resendInvite, acceptInvite, findByInviteToken,
  ensureTestUser, findByTestLoginSlug
};
