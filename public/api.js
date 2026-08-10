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
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

window.api = {
  listProspects:  ()          => getJSON('/api/prospects'),
  getProspect:    (id)        => getJSON('/api/prospects/' + id),
  updateProspect: (id, f)     => sendJSON('/api/prospects/' + id, 'PATCH', f),
  deleteProspect: (id)        => sendJSON('/api/prospects/' + id, 'DELETE'),
  getStats:       ()          => getJSON('/api/stats'),

  addNote:        (id, text)  => sendJSON('/api/prospects/' + id + '/note', 'POST', { text }),
  logExternal:    (id, data)  => sendJSON('/api/prospects/' + id + '/external', 'POST', data),
  editContact:    (id, patch) => sendJSON('/api/prospects/' + id + '/contact', 'POST', patch),
  uploadDossiers: (dossiers)  => sendJSON('/api/prospects/upload', 'POST', { dossiers }),

  emailQuestions: (id)        => getJSON('/api/prospects/' + id + '/questions'),
  emailGenerate:  (id, ans)   => sendJSON('/api/prospects/' + id + '/generate', 'POST', ans),
  emailSaveFinal: (id, t, m)  => sendJSON('/api/prospects/' + id + '/saveFinal', 'POST', { finalText: t, meta: m }),

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

  // Live updates: the server pushes an SSE event when a dossier is ingested.
  onIngested: (cb) => {
    const es = new EventSource('/api/events');
    es.addEventListener('ingested', (e) => { try { cb(JSON.parse(e.data)); } catch {} });
  }
};
