// auth.js — session tokens, using only Node's built-in crypto. No external dependencies,
// so the no-compilation promise holds.
//
// This module knows nothing about user accounts (see users.js for that) or passwords —
// it only issues and verifies signed tokens that carry a user id. On login (users.js
// checks the password), the server issues a signed token cookie naming that user. Every
// protected request must carry a valid token; server.js resolves the token back to a live
// user record on every request, so a role change or deactivation takes effect immediately
// rather than waiting for the token to expire. The signing secret is generated once and
// kept on disk.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let secretPath, secret;

function init(dataDir) {
  secretPath = path.join(dataDir, '.session-secret');
  // A per-install signing secret for tokens.
  if (fs.existsSync(secretPath)) {
    secret = fs.readFileSync(secretPath, 'utf8');
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    // 0600: this file forges any session if read, so no other account on the host needs it.
    fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  }
}

// ---- Signed tokens (a tiny JWT-like value: payload.signature) ----

function issueToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// Returns { uid, t } on a valid, unexpired token, or null otherwise.
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // Expire tokens after 30 days.
    if (Date.now() - decoded.t > 30 * 24 * 60 * 60 * 1000) return null;
    if (typeof decoded.uid !== 'number') return null;
    return decoded;
  } catch { return null; }
}

// Read the token from the Cookie header.
function tokenFromReq(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/gs_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = { init, issueToken, verifyToken, tokenFromReq };
