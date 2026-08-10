// auth.js — simple shared-password login, using only Node's built-in crypto.
// No external dependencies, so the no-compilation promise holds.
//
// How it works: the password is stored as a salted hash (never in plaintext). On login,
// the server checks the password and issues a signed token cookie. Every protected request
// must carry a valid token. The signing secret is generated once and kept on disk.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let secretPath, hashPath, secret;

function init(dataDir) {
  secretPath = path.join(dataDir, '.session-secret');
  hashPath = path.join(dataDir, '.password-hash');
  // A per-install signing secret for tokens.
  if (fs.existsSync(secretPath)) {
    secret = fs.readFileSync(secretPath, 'utf8');
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, 'utf8');
  }
}

function isPasswordSet() {
  return fs.existsSync(hashPath);
}

// Store a salted hash of the password.
function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  fs.writeFileSync(hashPath, salt + ':' + hash, 'utf8');
}

function checkPassword(password) {
  if (!isPasswordSet()) return false;
  const [salt, stored] = fs.readFileSync(hashPath, 'utf8').split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  // constant-time compare
  const a = Buffer.from(hash), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Signed tokens (a tiny JWT-like value: payload.signature) ----

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  // Optional: expire tokens after 30 days.
  try {
    const { t } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - t > 30 * 24 * 60 * 60 * 1000) return false;
  } catch { return false; }
  return true;
}

// Read the token from the Cookie header.
function tokenFromReq(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/gs_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = { init, isPasswordSet, setPassword, checkPassword, issueToken, verifyToken, tokenFromReq };
