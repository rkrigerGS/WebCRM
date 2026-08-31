// api.js — the browser-side shim.
// The UI (renderer.js) was written to call window.api.* (originally Electron IPC).
// Here we recreate that same interface using fetch() to the local server, so the entire
// renderer works unchanged. This is what makes the desktop-to-web conversion clean.

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function sendJSON(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    const err = new Error(errBody.error || r.statusText);
    // Carried through so a do-not-contact block can be told apart from any other failure
    // and shown its own UI (see renderer.js's renderExclusionBlock), not just an error string.
    if (errBody.exclusion) err.exclusion = errBody.exclusion;
    throw err;
  }
  return r.json();
}
function toQuery(params) {
  const clean = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const qs = new URLSearchParams(clean).toString();
  return qs ? '?' + qs : '';
}

// Opened on first use and reused for every event type.
//
// The browser only auto-reconnects a stream that dropped mid-flight; a stream refused with an
// HTTP error is closed permanently. /api/events sits behind the session gate, and these
// listeners are registered while the login screen is still up, so the very first attempt gets
// a 401 and the app then ran the whole session with no live updates (no new-prospect toast, no
// reply notification, no auto-refresh) until a manual reload. So: keep the handlers in a
// registry, and whenever the stream closes, rebuild it on a backoff — once the user logs in,
// the next attempt carries the session cookie and succeeds on its own.
let eventStream = null;
let eventRetryMs = 1000;
const EVENT_RETRY_MAX_MS = 30000;
const eventHandlers = []; // { name, cb }

function connectEventStream() {
  if (eventStream) return;
  const es = new EventSource('/api/events');
  eventStream = es;
  for (const h of eventHandlers) {
    es.addEventListener(h.name, (e) => { try { h.cb(JSON.parse(e.data)); } catch {} });
  }
  es.addEventListener('open', () => { eventRetryMs = 1000; });
  es.addEventListener('error', () => {
    if (es.readyState !== EventSource.CLOSED) return; // transient: the browser retries itself
    es.close();
    if (eventStream === es) eventStream = null;
    setTimeout(connectEventStream, eventRetryMs);
    eventRetryMs = Math.min(EVENT_RETRY_MAX_MS, eventRetryMs * 2);
  });
}

function onServerEvent(name, cb) {
  eventHandlers.push({ name, cb });
  if (!eventStream) connectEventStream();
  else eventStream.addEventListener(name, (e) => { try { cb(JSON.parse(e.data)); } catch {} });
}

window.api = {
  listProspects:  ()          => getJSON('/api/prospects'),
  getProspect:    (id)        => getJSON('/api/prospects/' + id),
  updateProspect: (id, f)     => sendJSON('/api/prospects/' + id, 'PATCH', f),
  deleteProspect: (id)        => sendJSON('/api/prospects/' + id, 'DELETE'),
  // No UI calls getStats, readCatalog, writeCatalog or authStatus today — the catalog
  // editor screen was never built, so the two catalogs are edited on disk (or through
  // these from the console). Kept because the routes exist and are admin-guarded.
  getStats:       ()          => getJSON('/api/stats'),

  addNote:        (id, text)  => sendJSON('/api/prospects/' + id + '/note', 'POST', { text }),
  logExternal:    (id, data)  => sendJSON('/api/prospects/' + id + '/external', 'POST', data),
  editOutreach:   (id, entryId, data) => sendJSON('/api/prospects/' + id + '/outreach/' + encodeURIComponent(entryId), 'PATCH', data),
  editContact:    (id, patch) => sendJSON('/api/prospects/' + id + '/contact', 'POST', patch),
  uploadDossiers: (dossiers)  => sendJSON('/api/prospects/upload', 'POST', { dossiers }),

  emailQuestions: (id)        => getJSON('/api/prospects/' + id + '/questions'),
  calendarAvailability: ()    => getJSON('/api/calendar/availability'),
  emailGenerate:  (id, ans)   => sendJSON('/api/prospects/' + id + '/generate', 'POST', ans),
  emailSaveFinal: (id, t, m)  => sendJSON('/api/prospects/' + id + '/saveFinal', 'POST', { finalText: t, meta: m }),
  suggestSubjects: (id, b)    => sendJSON('/api/prospects/' + id + '/subjects', 'POST', b),

  linkedinQuestions: (id)     => getJSON('/api/prospects/' + id + '/linkedin/questions'),
  linkedinGenerate:  (id, a)  => sendJSON('/api/prospects/' + id + '/linkedin/generate', 'POST', a),
  linkedinSave:      (id, b)  => sendJSON('/api/prospects/' + id + '/linkedin/save', 'POST', b),

  getConfig:      ()          => getJSON('/api/config'),
  setApiKey:      (key)       => sendJSON('/api/config/key', 'POST', { key }),
  updateConfig:   (patch)     => sendJSON('/api/config', 'POST', patch),
  watchedPath:    ()          => getJSON('/api/watched/path').then(r => r.path),

  // In a browser we can't pop a native folder picker or open Finder/Explorer. Instead we
  // let the user type/paste the folder path. These return a shape the UI already handles.
  chooseWatched:  async () => {
    const cur = (await getJSON('/api/watched/path')).path;
    const entered = window.prompt('Paste the full path to your research output folder:', cur);
    if (!entered) return { chosen: false, path: cur };
    const r = await sendJSON('/api/config', 'POST', { watchFolder: entered });
    return { chosen: true, path: r.watchFolder };
  },
  resetWatched:   async () => {
    const r = await sendJSON('/api/config', 'POST', { watchFolder: '' });
    return { path: r.watchFolder };
  },
  revealWatched:  async () => {
    const p = (await getJSON('/api/watched/path')).path;
    window.alert('Research folder on the host machine:\n\n' + p);
  },

  readCatalog:    (which)     => getJSON('/api/catalog/' + which).then(r => r.text),
  writeCatalog:   (which, t)  => sendJSON('/api/catalog/' + which, 'POST', { text: t }),

  // Live updates over SSE. One stream per tab, shared by every listener below: each
  // EventSource is a held-open connection on the server, and opening three for one stream
  // tripled that cost for no benefit.
  onIngested:     (cb) => onServerEvent('ingested', cb),
  // A dossier the watcher could not read or parse. Separate from onIngested so a failure
  // can be shown differently from a success.
  onIngestFailed: (cb) => onServerEvent('ingest-failed', cb),
  onReply: (cb) => { onServerEvent('reply', cb); onServerEvent('dormant-return', cb); },
  // A prospect booked a meeting through an emailed time-slot link.
  onBooked: (cb) => onServerEvent('booked', cb),
  // Background failures (Gmail polling, digest, backup, OAuth, calendar) — {ref, scope, message}.
  // The message carries raw internal detail (paths, Google's verbatim errors), so the server
  // only writes this event to admin streams; non-admin sessions never receive it at all.
  onIssue: (cb) => onServerEvent('issue', cb),

  authStatus: ()                     => getJSON('/api/auth/status'),
  authLogout: ()                     => sendJSON('/api/auth/logout', 'POST'),

  listUsers:         ()                    => getJSON('/api/admin/users'),
  createUser:        (u)                   => sendJSON('/api/admin/users', 'POST', u),
  deactivateUser:    (id)                  => sendJSON(`/api/admin/users/${id}/deactivate`, 'POST'),
  reactivateUser:    (id)                  => sendJSON(`/api/admin/users/${id}/reactivate`, 'POST'),
  changeUserRole:    (id, role)            => sendJSON(`/api/admin/users/${id}/role`, 'POST', { role }),
  resetUserPassword: (id, password)        => sendJSON(`/api/admin/users/${id}/password`, 'POST', { password }),

  listAudit:         (filters)             => getJSON('/api/admin/audit' + toQuery(filters)),
  listAuditActions:  ()                    => getJSON('/api/admin/audit/actions'),

  getGmailStatus:      ()                  => getJSON('/api/gmail/status'),
  listCcableUsers:     ()                  => getJSON('/api/users/ccable'),
  setUserEmail:        (id, email)         => sendJSON(`/api/admin/users/${id}/email`, 'POST', { email }),

  getGmailAdminStatus: ()                  => getJSON('/api/admin/gmail/status'),
  disconnectGmail:     ()                  => sendJSON('/api/admin/gmail/disconnect', 'POST'),
  saveGoogleCreds:     (clientId, clientSecret) => sendJSON('/api/config/google', 'POST', { clientId, clientSecret }),

  getDeadPile:         ()                  => getJSON('/api/admin/backup/dead-pile'),
  saveBackupSchedule:  (backupFrequency)   => sendJSON('/api/config/backup-schedule', 'POST', { backupFrequency }),

  getReplyContext:     (id)                => getJSON('/api/prospects/' + id + '/reply-context'),
  getReplyTemplates:   (prospectId)        => getJSON('/api/reply-templates' + toQuery({ prospectId })),
  generateReply:       (id, body)          => sendJSON('/api/prospects/' + id + '/reply/generate', 'POST', body),
  sendReply:           (id, body)          => sendJSON('/api/prospects/' + id + '/reply/send', 'POST', body),
  setDormant:          (id, returnDate)    => sendJSON('/api/prospects/' + id + '/dormant', 'POST', { returnDate }),
  resendInvite:        (id)                => sendJSON('/api/admin/users/' + id + '/resend-invite', 'POST'),
  removeExclusion:     (match_type, value) => sendJSON('/api/admin/exclusions/remove', 'POST', { match_type, value }),

  saveDigestRecipients: (recipientIds)     => sendJSON('/api/config/digest-recipients', 'POST', { recipientIds }),
  sendDigestNow:        ()                 => sendJSON('/api/admin/digest/send-now', 'POST'),
  saveMeetingParticipants: (participantIds) => sendJSON('/api/config/meeting-participants', 'POST', { participantIds })
};
