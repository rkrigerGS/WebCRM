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
const store = require('./store');
const audit = require('./audit');

// calendar.readonly rides on the same OAuth grant as Gmail — one Google account, one
// consent screen, one token. calendar.js reuses ensureAccessToken()/requestJSON() below
// to call the Calendar API; it never gets its own connect flow. An already-connected
// account only has the gmail.modify grant until it's reconnected once (prompt: 'consent'
// below forces the combined consent screen on every connect), so isConnected() alone
// isn't enough to know calendar access is usable — see hasCalendarAccess().
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly';
const LABEL_NAME = 'WebApp Outreach';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000; // refresh 2 minutes before actual expiry
const REQUEST_TIMEOUT_MS = 20000;            // see requestJSON()

let tokenPath;
let token = null; // { refreshToken, accessToken, accessTokenExpiry, email, labelId } | null
let loadError = ''; // non-empty when the token file exists but could not be read
let onIssue = () => {}; // (scope, err) => ref — wired to server.js's reportIssue so background failures reach a toast

function init(dataDir, issueReporter) {
  tokenPath = path.join(dataDir, 'gmail-token.json');
  if (issueReporter) onIssue = issueReporter;
  load();
}

// Unlike the database, an unreadable token file is not worth refusing to boot over: the
// worst case is that Gmail shows as disconnected and an admin reconnects, which rewrites
// the file anyway. But it must be loud and it must be visible in Settings — "silently
// disconnected, no reason given" is exactly the failure mode the team reported.
function load() {
  loadError = '';
  try {
    token = store.readJSON(tokenPath);
  } catch (e) {
    token = null;
    // store.readJSON's message is written for the stores that refuse to start; say what
    // actually happens here instead.
    loadError = `${tokenPath} could not be read (${e.code || 'invalid JSON'}). Gmail will show as disconnected until an admin reconnects it in Settings.`;
    console.error('GMAIL TOKEN UNREADABLE —', loadError, '\n  underlying:', e.message);
  }
}

function save() {
  store.writeJSON(tokenPath, token); // atomic (temp + fsync + rename), same as every other store
}

function clear() {
  token = null;
  loadError = '';
  try { fs.unlinkSync(tokenPath); } catch {}
}

// Both halves are required to actually send: the stored refresh token AND the Google client
// ID/secret it must be exchanged against. Reporting "connected" on the token alone let the
// send screen enable itself after the credentials were cleared or rotated, and every send
// then failed at the refresh step.
function isConnected() {
  return !!(token && token.refreshToken) && config.hasGoogleCreds();
}

// The calendar.readonly scope was added after gmail.modify was already in production use,
// so an account connected before this shipped only has the mail grant until someone hits
// Disconnect/Connect again — Google's `prompt: 'consent'` then re-shows the combined
// screen. Checked against the scope string Google actually returned on token exchange,
// not just "is calendar.js reachable," since the token can be old.
function hasCalendarAccess() {
  return !!(token && token.scope && token.scope.includes('calendar'));
}

function getStatus() {
  return {
    connected: isConnected(),
    email: (token && token.email) || '',
    // Distinguishes "never connected" from "connected, but the Google client credentials
    // are gone" — the second is fixed in Settings, not by reconnecting.
    needsCreds: !!(token && token.refreshToken) && !config.hasGoogleCreds(),
    calendarConnected: isConnected() && hasCalendarAccess(),
    loadError
  };
}

function disconnect() {
  clear();
}

// ---- Raw HTTPS JSON helper (mirrors emailEngine.js's callClaude request shape) ----
// Node's HTTPS client has no default socket idle timeout, so without the timeout below a
// half-open connection to Google leaves this promise pending forever: the staffer's Send
// spinner never stops and they have no way to know whether the mail went out.
function requestJSON({ hostname, path: p, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname, path: p, method, timeout: REQUEST_TIMEOUT_MS,
      headers: { ...(headers || {}), ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      // Decode as UTF-8 across chunk boundaries. Concatenating raw Buffers into a string
      // splits multi-byte characters at TLS record edges, which corrupted reply text on the
      // review screen and in the text handed to Claude for the draft.
      res.setEncoding('utf8');
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
    req.on('timeout', () => req.destroy(new Error(
      `Gmail request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${method} ${String(p).split('?')[0]}). ` +
      `The email may or may not have been sent — check the Sent folder before retrying.`
    )));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// One call against the Gmail API with a valid access token. A 401 here means the token was
// invalidated server-side before its nominal expiry (a password change, a revoked session,
// a clock ahead of Google's); one forced refresh and retry turns that from a hard failure
// into a recovery the user never sees. `build(accessToken)` returns the requestJSON options.
async function callGmail(build) {
  const accessToken = await ensureAccessToken();
  try {
    return await requestJSON(build(accessToken));
  } catch (e) {
    if (e.status !== 401) throw e;
    return requestJSON(build(await ensureAccessToken({ force: true })));
  }
}

// ---- RFC 2047 header encoding ----
// A header value containing any byte above 0x7F is invalid under RFC 5322 if emitted raw.
// Gmail may pass it through, but strict clients (Outlook, which government recipients
// predominantly use) then render mojibake in the subject line. Every subject the app builds
// contains an em dash, so this is not a corner case.
function encodeHeader(value) {
  // Interior CR/LF would split the header block and make Gmail reject the message with no
  // usable explanation — a subject pasted from a document is enough to trigger it.
  const clean = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  if (!/[^\x00-\x7F]/.test(clean)) return clean;
  // RFC 2047 caps one encoded-word at 75 characters, so long values become several words
  // joined by a folding CRLF+space. Chunks are cut on character boundaries, never mid-
  // sequence, so no character is ever split across two words.
  const words = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 36) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join('\r\n ');
}

// Address headers differ: only the display name may be encoded, since an encoded address
// itself is not a valid address. "Ana Muñoz <ana@x.gov>" → "=?UTF-8?B?…?= <ana@x.gov>".
// A bare address is passed through untouched (minus CR/LF) rather than mangled.
function encodeAddress(value) {
  const clean = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  const m = clean.match(/^(.*?)\s*<([^>]+)>$/);
  if (!m) return clean;
  const name = m[1].replace(/^"|"$/g, '').trim();
  return (name ? encodeHeader(name) + ' ' : '') + `<${m[2].trim()}>`;
}

// Bodies go out base64-encoded rather than raw. That fixes three RFC problems in one line:
// 8-bit characters under a 7bit default encoding, the 998-octet line limit, and bare LFs.
function encodeBody(text) {
  return Buffer.from(String(text == null ? '' : text), 'utf8')
    .toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function requireCreds() {
  const cfg = config.get();
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    throw new Error('Google Client ID/Secret are not configured. Set them in Settings first.');
  }
  return { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret };
}

// ---- OAuth: authorize URL + code exchange ----

// `state` is the anti-CSRF token minted by the /connect route (server.js) — Google echoes
// it back to the callback, which rejects any mismatch. Without it, a forged callback URL
// could silently connect an attacker's mailbox as the app's sending account.
function getAuthUrl(redirectUri, state) {
  const { clientId } = requireCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'marcos@govspringlegal.com',
    ...(state ? { state } : {})
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
    labelId: '',
    scope: json.scope || '' // Google's actually-granted scopes; see hasCalendarAccess()
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
    onIssue('gmail.profileFetch', e);
  }
}

// force: true skips the cached access token — used by callGmail() after a 401.
async function ensureAccessToken({ force = false } = {}) {
  // Checked separately from isConnected() so a missing client ID/secret produces
  // requireCreds()'s specific message instead of a generic "not connected".
  if (!token || !token.refreshToken) throw new Error('Gmail is not connected.');
  if (!force && token.accessToken && token.accessTokenExpiry && Date.now() < token.accessTokenExpiry - TOKEN_REFRESH_SKEW_MS) {
    return token.accessToken;
  }
  // Concurrent callers landing here together (the reply poll, a user's send, a calendar
  // lookup) share one refresh rather than racing several token exchanges at once — the
  // slower duplicates would overwrite a fresher token with a staler response for no gain.
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

let refreshInFlight = null; // Promise<string> while a refresh is running, else null

async function refreshAccessToken() {
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
      // This disconnects Gmail for the whole team, and it is usually reached from the
      // background reply poller, whose only handler is a console.warn. Record it in the
      // audit trail with Google's own explanation so there is something to look at
      // afterwards besides one line of stdout.
      const why = e.body.error_description || e.body.error || '';
      onIssue('gmail.disconnected', new Error(`Google rejected the refresh token: ${why}`));
      try {
        audit.log({ userId: null, username: 'system (gmail)', action: 'gmail.revoked', detail: why });
      } catch { /* never let audit failure mask the real error */ }
      clear();
      throw new Error('Gmail access was revoked. Reconnect in Settings.');
    }
    throw new Error('Could not refresh the Gmail connection: ' + e.message);
  }
}

// ---- Label: get-or-create "WebApp Outreach", cached on the token record ----

async function ensureLabel() {
  if (token.labelId) return token.labelId;
  const list = await callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` }
  }));
  const existing = (list.labels || []).find(l => l.name === LABEL_NAME);
  if (existing) { token.labelId = existing.id; save(); return existing.id; }
  const created = await callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: { name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  }));
  token.labelId = created.id;
  save();
  return created.id;
}

// ---- Build and send the actual message ----

function buildRawMessage({ from, to, cc, subject, bodyText, inReplyTo, references }) {
  const headers = [
    `From: ${encodeAddress(from)}`,
    `To: ${encodeAddress(to)}`,
    ...(cc && cc.length ? [`Cc: ${cc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${encodeHeader(inReplyTo)}`] : []),
    ...(references ? [`References: ${encodeHeader(references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ];
  const raw = headers.join('\r\n') + '\r\n\r\n' + encodeBody(bodyText);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// params: { to, cc: [], subject, bodyText, threadId, inReplyTo, references }
// Returns { gmailThreadId, gmailMessageId } — gmailMessageId is the RFC "Message-ID"
// header value (needed to thread a future follow-up), best-effort: if it can't be
// fetched back, the send has still succeeded and the function still returns normally
// with gmailMessageId as ''.
async function sendEmail({ to, cc, subject, bodyText, threadId, inReplyTo, references }) {
  const from = (token && token.email) || 'marcos@govspringlegal.com';
  const raw = buildRawMessage({ from, to, cc, subject, bodyText, inReplyTo, references });

  const sendBody = { raw };
  if (threadId) sendBody.threadId = threadId;

  const sent = await callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: sendBody
  }));

  const result = { gmailThreadId: sent.threadId, gmailMessageId: '' };

  // Best-effort from here: the email is already out. A failure fetching the Message-ID
  // header only affects whether a *future* follow-up threads correctly, and a failure
  // applying the label only affects Gmail-side organization — neither should make this
  // call report failure for an email that actually sent.
  try {
    const full = await callGmail(accessToken => ({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
      method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
    }));
    const header = ((full.payload && full.payload.headers) || []).find(h => h.name === 'Message-ID');
    if (header) result.gmailMessageId = header.value;
  } catch (e) {
    console.warn('Sent via Gmail, but could not read back the Message-ID header (future follow-ups on this prospect will start a new thread):', e.message);
  }

  try {
    const labelId = await ensureLabel();
    await callGmail(accessToken => ({
      hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${sent.id}/modify`, method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: { addLabelIds: [labelId] }
    }));
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
    const headers = [
      `From: ${encodeAddress(from)}`, `To: ${encodeAddress(to)}`, `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'
    ];
    return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + encodeBody(bodyText), 'utf8').toString('base64url');
  }
  const boundary = 'gs_mail_' + Date.now().toString(36);
  const headers = [
    `From: ${encodeAddress(from)}`,
    `To: ${encodeAddress(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];
  const bodyPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(bodyText),
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
  const from = (token && token.email) || 'marcos@govspringlegal.com';
  const raw = buildStandaloneMessage({ from, to, subject, bodyText, attachment });
  return callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: { raw }
  }));
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
  const thread = await callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com',
    path: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Date`,
    method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
  }));
  return (thread.messages || []).map(m => {
    const headers = (m.payload && m.payload.headers) || [];
    const from = (headers.find(h => h.name === 'From') || {}).value || '';
    return { id: m.id, from, snippet: m.snippet || '', internalDate: m.internalDate };
  });
}

// Full body fetch — only called on demand when the reply review screen opens, not during
// polling, so polling stays cheap.
async function getMessageBody(messageId) {
  const full = await callGmail(accessToken => ({
    hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    method: 'GET', headers: { authorization: `Bearer ${accessToken}` }
  }));
  return extractPlainText(full.payload);
}

// The address the app sends from — the reply poller needs it to tell our own messages in a
// thread apart from the prospect's.
function connectedEmail() {
  return (token && token.email) || '';
}

module.exports = {
  init, isConnected, getStatus, disconnect, getAuthUrl, exchangeCode, sendEmail,
  sendAttachmentEmail, sendInviteEmail, sendStandaloneEmail, getThreadReplies, getMessageBody,
  connectedEmail, hasCalendarAccess,
  // Exposed so calendar.js can make its own read-only Calendar API calls through the same
  // connection — same token, same refresh-on-401 handling, no second OAuth client.
  ensureAccessToken, requestJSON, callGmail
};
