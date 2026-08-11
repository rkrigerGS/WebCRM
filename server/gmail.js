// gmail.js — OAuth connection to one Gmail account (marcos@govspringlegal.com) and the
// Gmail API calls needed to send outreach email through it. Plain Node `https`, exactly
// like emailEngine.js's callClaude() — Google's OAuth token endpoint and the Gmail REST
// API are both plain JSON-over-HTTPS, so no SDK dependency is needed.
//
// Token storage: data/gmail-token.json (own atomic JSON file, same read/write pattern as
// db.js/users.js/audit.js). Holds the refresh token, the current access token + its
// expiry, the connected account's email, and the cached "WebApp Outreach" label id.
// Never sent to the browser, never logged.
//
// Scope: https://www.googleapis.com/auth/gmail.modify — covers send, read (to fetch the
// RFC Message-ID header back off a sent message for threading), and label management in
// one grant, so there's only one scope to reason about.

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const LABEL_NAME = 'WebApp Outreach';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000; // refresh 2 minutes before actual expiry

let tokenPath;
let token = null; // { refreshToken, accessToken, accessTokenExpiry, email, labelId } | null

function init(dataDir) {
  tokenPath = path.join(dataDir, 'gmail-token.json');
  load();
}

function load() {
  try {
    token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    token = null;
  }
}

function save() {
  const tmp = tokenPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), 'utf8');
  fs.renameSync(tmp, tokenPath);
}

function clear() {
  token = null;
  try { fs.unlinkSync(tokenPath); } catch {}
}

function isConnected() {
  return !!(token && token.refreshToken);
}

function getStatus() {
  return { connected: isConnected(), email: (token && token.email) || '' };
}

function disconnect() {
  clear();
}

// ---- Raw HTTPS JSON helper (mirrors emailEngine.js's callClaude request shape) ----
function requestJSON({ hostname, path: p, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname, path: p, method,
      headers: { ...(headers || {}), ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : {}; }
        catch { return reject(new Error(`Bad response from Google (${res.statusCode}): ${data.slice(0, 200)}`)); }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(Object.assign(new Error((json.error && (json.error.message || json.error)) || `HTTP ${res.statusCode}`), { status: res.statusCode, body: json }));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requireCreds() {
  const cfg = config.get();
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    throw new Error('Google Client ID/Secret are not configured. Set them in Settings first.');
  }
  return { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret };
}

// ---- OAuth: authorize URL + code exchange ----

function getAuthUrl(redirectUri) {
  const { clientId } = requireCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'marcos@govspringlegal.com'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = requireCreds();
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code'
  }).toString();
  const json = await requestJSON({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke the app\'s access at myaccount.google.com/permissions and try connecting again (this forces a fresh consent).');
  }
  token = {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    accessTokenExpiry: Date.now() + (json.expires_in * 1000),
    email: '',
    labelId: ''
  };
  save();
  // Fetch and store the connected account's address so Settings can show it.
  try {
    const profile = await requestJSON({
      hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/profile', method: 'GET',
      headers: { authorization: `Bearer ${token.accessToken}` }
    });
    token.email = profile.emailAddress || '';
    save();
  } catch (e) {
    console.warn('Gmail connected, but could not fetch the account profile:', e.message);
  }
}

async function ensureAccessToken() {
  if (!isConnected()) throw new Error('Gmail is not connected.');
  if (token.accessToken && token.accessTokenExpiry && Date.now() < token.accessTokenExpiry - TOKEN_REFRESH_SKEW_MS) {
    return token.accessToken;
  }
  const { clientId, clientSecret } = requireCreds();
  const body = new URLSearchParams({
    refresh_token: token.refreshToken, client_id: clientId, client_secret: clientSecret,
    grant_type: 'refresh_token'
  }).toString();
  try {
    const json = await requestJSON({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    });
    token.accessToken = json.access_token;
    token.accessTokenExpiry = Date.now() + (json.expires_in * 1000);
    save();
    return token.accessToken;
  } catch (e) {
    // invalid_grant means the refresh token itself was revoked/expired — the connection
    // is genuinely gone and re-authorizing is the only fix, so reflect that in status
    // rather than leaving a connection that will fail on every future send.
    if (e.body && e.body.error === 'invalid_grant') {
      clear();
      throw new Error('Gmail access was revoked. Reconnect in Settings.');
    }
    throw new Error('Could not refresh the Gmail connection: ' + e.message);
  }
}

// ---- Label: get-or-create "WebApp Outreach", cached on the token record ----

async function ensureLabel(accessToken) {
  if (token.labelId) return token.labelId;
  const list = await requestJSON({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const existing = (list.labels || []).find(l => l.name === LABEL_NAME);
  if (existing) { token.labelId = existing.id; save(); return existing.id; }
  const created = await requestJSON({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: { name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  token.labelId = created.id;
  save();
  return created.id;
}

// ---- Build and send the actual message ----

function buildRawMessage({ from, to, cc, subject, bodyText, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${subject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"'
  ];
  const raw = headers.join('\r\n') + '\r\n\r\n' + bodyText;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// params: { to, cc: [], subject, bodyText, threadId, inReplyTo, references }
// Returns { gmailThreadId, gmailMessageId } — gmailMessageId is the RFC "Message-ID"
// header value (needed to thread a future follow-up), best-effort: if it can't be
// fetched back, the send has still succeeded and the function still returns normally
// with gmailMessageId as ''.
async function sendEmail({ to, cc, subject, bodyText, threadId, inReplyTo, references }) {
  const accessToken = await ensureAccessToken();
  const from = (token.email || 'marcos@govspringlegal.com');
  const raw = buildRawMessage({ from, to, cc, subject, bodyText, inReplyTo, references });

  const sendBody = { raw };
  if (threadId) sendBody.threadId = threadId;

  const sent = await requestJSON({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: sendBody
  });

  const result = { gmailThreadId: sent.threadId, gmailMessageId: '' };

  // Best-effort from here: the email is already out. A failure fetching the Message-ID
  // header only affects whether a *future* follow-up threads correctly, and a failure
  // applying the label only affects Gmail-side organization — neither should make this
  // call report failure for an email that actually sent.
  try {
    const full = await requestJSON({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
      method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
    });
    const header = ((full.payload && full.payload.headers) || []).find(h => h.name === 'Message-ID');
    if (header) result.gmailMessageId = header.value;
  } catch (e) {
    console.warn('Sent via Gmail, but could not read back the Message-ID header (future follow-ups on this prospect will start a new thread):', e.message);
  }

  try {
    const labelId = await ensureLabel(accessToken);
    await requestJSON({
      hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${sent.id}/modify`, method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: { addLabelIds: [labelId] }
    });
  } catch (e) {
    console.warn('Sent via Gmail, but could not apply the "WebApp Outreach" label:', e.message);
  }

  return result;
}

// Builds a standalone MIME message — plain text/plain, or multipart/mixed with one
// attachment if given. Separate from buildRawMessage() above (outreach mail): these are
// plain notifications to a fixed address, never threaded or labeled, so they don't share
// that function's shape.
function buildStandaloneMessage({ from, to, subject, bodyText, attachment }) {
  if (!attachment) {
    const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"'];
    return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + bodyText, 'utf8').toString('base64url');
  }
  const boundary = 'gs_mail_' + Date.now().toString(36);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];
  const bodyPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
    ''
  ].join('\r\n');
  const attachmentPart = [
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    attachment.data.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ''
  ].join('\r\n');
  const raw = headers.join('\r\n') + '\r\n\r\n' + bodyPart + attachmentPart + `--${boundary}--`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// params: { to, subject, bodyText, attachment?: { filename, contentType, data: Buffer } }.
// No threading, no CC, no label — used for the scheduled backup email (with an
// attachment) and the user-invitation email (without one). Neither is outreach.
async function sendStandaloneEmail({ to, subject, bodyText, attachment }) {
  const accessToken = await ensureAccessToken();
  const from = (token.email || 'marcos@govspringlegal.com');
  const raw = buildStandaloneMessage({ from, to, subject, bodyText, attachment });
  return requestJSON({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: { raw }
  });
}

function sendAttachmentEmail({ to, subject, bodyText, attachment }) {
  return sendStandaloneEmail({ to, subject, bodyText, attachment });
}

function sendInviteEmail({ to, subject, bodyText }) {
  return sendStandaloneEmail({ to, subject, bodyText });
}

// ---- Reply watching: reading thread/message content ----
// Covered by the existing gmail.modify scope (a superset of read access), so no new
// consent grant is needed from a previously connected account.

// Walks a message's MIME payload tree for a text/plain part (preferring it over
// text/html — if only HTML is present, a crude tag-strip is used as a last resort; the
// caller must still escape this before rendering, since it is untrusted sender content).
function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    const direct = payload.parts.find(p => p.mimeType === 'text/plain' && p.body && p.body.data);
    if (direct) return Buffer.from(direct.body.data, 'base64url').toString('utf8');
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Cheap, metadata-only look at a thread's messages (no body fetch) — used by the reply
// poll in server.js to detect new inbound messages without the cost of a full fetch per
// message on every poll cycle.
async function getThreadReplies(threadId) {
  const accessToken = await ensureAccessToken();
  const thread = await requestJSON({
    hostname: 'gmail.googleapis.com',
    path: `/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date`,
    method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
  });
  return (thread.messages || []).map(m => {
    const headers = (m.payload && m.payload.headers) || [];
    const from = (headers.find(h => h.name === 'From') || {}).value || '';
    return { id: m.id, from, snippet: m.snippet || '', internalDate: m.internalDate };
  });
}

// Full body fetch — only called on demand when the reply review screen opens, not during
// polling, so polling stays cheap.
async function getMessageBody(messageId) {
  const accessToken = await ensureAccessToken();
  const full = await requestJSON({
    hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${messageId}?format=full`,
    method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
  });
  return extractPlainText(full.payload);
}

module.exports = {
  init, isConnected, getStatus, disconnect, getAuthUrl, exchangeCode, sendEmail,
  sendAttachmentEmail, sendInviteEmail, getThreadReplies, getMessageBody
};
