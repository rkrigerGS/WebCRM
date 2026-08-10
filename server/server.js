// server.js — the web server that runs on the host machine.
// This replaces Electron's main process. Instead of IPC channels, each operation is an
// HTTP endpoint the browser UI calls with fetch(). The server holds the database, the
// API key, the catalogs, and watches the research folder.
//
// It binds to 127.0.0.1 (localhost) only, so it is reachable only from this machine's
// own browser and never exposed to the network or internet.

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chokidar = require('chokidar');

const db = require('./db');
const config = require('./config');
const catalogs = require('./catalogs');
const emailEngine = require('./emailEngine');
const auth = require('./auth');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const PORT = process.env.PORT || 3000;

// ---- Startup ----
db.init(DATA_DIR);
config.init(DATA_DIR);
catalogs.init(DATA_DIR, APP_DIR);
auth.init(DATA_DIR);
seedApprovedEmails();

let watcher = null;
startWatching();

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---- Auth endpoints (these must be reachable without a token) ----

// Tells the login page whether a password has been set yet (first-run sets one).
app.get('/api/auth/status', (_q, res) => res.json({ passwordSet: auth.isPasswordSet(), authed: auth.verifyToken(auth.tokenFromReq(_q)) }));

// First run: set the shared password. Only allowed if none is set yet.
app.post('/api/auth/setup', (q, res) => {
  if (auth.isPasswordSet()) return res.status(400).json({ error: 'Password already set' });
  const pw = (q.body && q.body.password) || '';
  if (pw.length < 4) return res.status(400).json({ error: 'Password too short' });
  auth.setPassword(pw);
  const token = auth.issueToken();
  res.set('Set-Cookie', `gs_session=${token}; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`);
  res.json({ ok: true });
});

// Log in with the shared password.
app.post('/api/auth/login', (q, res) => {
  const pw = (q.body && q.body.password) || '';
  if (!auth.checkPassword(pw)) return res.status(401).json({ error: 'Wrong password' });
  const token = auth.issueToken();
  res.set('Set-Cookie', `gs_session=${token}; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_q, res) => {
  res.set('Set-Cookie', 'gs_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
  res.json({ ok: true });
});

// ---- Gate: every /api/* route below this line requires a valid session ----
// (Static files like the login page and CSS are served after and are public, but they
// contain no data; the data only flows through /api, which is protected.)
app.use('/api', (req, res, next) => {
  if (auth.verifyToken(auth.tokenFromReq(req))) return next();
  return res.status(401).json({ error: 'Not authenticated' });
});

app.use(express.static(path.join(APP_DIR, 'public')));

// ---- Live updates via Server-Sent Events ----
// When a dossier is ingested, the server pushes an event so the browser refreshes live,
// the same way the desktop app updated when a batch landed.
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

// ---- Watched folder ----
function watchedDir() {
  const configured = config.get().watchFolder;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(DATA_DIR, 'watched-dossiers');
}
function tryIngestFile(filePath, attempt = 0) {
  fs.readFile(filePath, 'utf8', (err, text) => {
    if (err) return;
    let dossier;
    try { dossier = JSON.parse(text); }
    catch { if (attempt < 5) return setTimeout(() => tryIngestFile(filePath, attempt + 1), 400); return; }
    const result = db.ingestDossier(dossier, path.basename(filePath));
    broadcast('ingested', result);
  });
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
const fail = (res, e) => res.status(500).json({ error: String(e && e.message || e) });

app.get('/api/prospects', (_q, res) => { try { ok(res, db.listProspects()); } catch (e) { fail(res, e); } });
app.get('/api/prospects/:id', (q, res) => { try { const p = db.getProspect(+q.params.id); p ? ok(res, p) : res.status(404).json({ error: 'not found' }); } catch (e) { fail(res, e); } });
app.patch('/api/prospects/:id', (q, res) => { try { ok(res, db.updateProspect(+q.params.id, q.body || {})); } catch (e) { fail(res, e); } });
app.delete('/api/prospects/:id', (q, res) => { try { ok(res, db.deleteProspect(+q.params.id)); } catch (e) { fail(res, e); } });
app.get('/api/stats', (_q, res) => { try { ok(res, db.stats()); } catch (e) { fail(res, e); } });

app.post('/api/prospects/:id/note', (q, res) => { try { ok(res, db.addNote(+q.params.id, q.body.text)); } catch (e) { fail(res, e); } });
app.post('/api/prospects/:id/external', (q, res) => { try { ok(res, db.logExternal(+q.params.id, q.body)); } catch (e) { fail(res, e); } });
app.post('/api/prospects/:id/contact', (q, res) => { try { ok(res, db.editContact(+q.params.id, q.body)); } catch (e) { fail(res, e); } });

// Upload dossiers directly through the browser (from any device). Accepts an array of
// parsed dossier objects; runs each through the same ingest path as the watched folder,
// so de-dup, exclusions, and fit-score handling are identical.
app.post('/api/prospects/upload', (q, res) => {
  try {
    const items = Array.isArray(q.body && q.body.dossiers) ? q.body.dossiers : [];
    if (!items.length) return res.status(400).json({ error: 'No dossiers provided' });
    const results = { ingested: 0, duplicate: 0, excluded: 0, errors: [] };
    for (const item of items) {
      try {
        const r = db.ingestDossier(item.dossier, item.filename || 'upload.json');
        if (r.outcome === 'ingested') { results.ingested++; broadcast('ingested', r); }
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
app.post('/api/prospects/:id/generate', async (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const a = q.body || {};
    let chosenIssue = null;
    if (a.issueId && a.issueId !== 'general') {
      const idx = parseInt(String(a.issueId).replace('issue_', ''), 10);
      chosenIssue = (p.dossier.issue_spotting || [])[idx] || null;
    }
    const { draft, usage } = await emailEngine.generateDraft({
      dossier: p.dossier, chosenIssue, chosenServices: a.services || [],
      personalNote: a.personalNote || null, isFollowup: !!a.isFollowup,
      priorEmailText: a.priorEmailText || p.final_sent || p.first_draft || ''
    });
    if (!a.isFollowup && !p.first_draft) db.updateProspect(+q.params.id, { first_draft: draft });
    ok(res, { ok: true, draft, usage });
  } catch (e) { ok(res, { ok: false, error: String(e && e.message || e) }); }
});
app.post('/api/prospects/:id/saveFinal', (q, res) => {
  try {
    const p = db.getProspect(+q.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const { finalText, meta } = q.body;
    const patch = { final_sent: finalText, status: 'sent', channel: (meta && meta.channel) || 'email', date_sent: new Date().toISOString().slice(0, 10) };
    if (meta && meta.isFollowup) patch.followup_count = (p.followup_count || 0) + 1;
    db.updateProspect(+q.params.id, patch);
    catalogs.saveApprovedEmail({
      company_name: p.company_name, recipient: (meta && meta.recipient) || '',
      services: (meta && meta.services) || [], first_draft: p.first_draft || '',
      final_text: finalText, is_followup: !!(meta && meta.isFollowup), saved_at: new Date().toISOString()
    });
    ok(res, { ok: true });
  } catch (e) { fail(res, e); }
});

// Config
app.get('/api/config', (_q, res) => {
  const c = config.get();
  ok(res, { hasApiKey: config.hasApiKey(), keyTail: c.anthropicApiKey ? c.anthropicApiKey.slice(-4) : '', draftModel: c.draftModel, defaultFollowupDays: c.defaultFollowupDays, watchFolder: watchedDir() });
});
app.post('/api/config/key', (q, res) => { config.update({ anthropicApiKey: q.body.key }); ok(res, { ok: true, hasApiKey: config.hasApiKey() }); });
app.post('/api/config', (q, res) => { config.update(q.body || {}); if ('watchFolder' in (q.body || {})) restartWatching(); ok(res, { ok: true, watchFolder: watchedDir() }); });
app.get('/api/watched/path', (_q, res) => ok(res, { path: watchedDir() }));

// Catalogs
app.get('/api/catalog/:which', (q, res) => ok(res, { text: q.params.which === 'services' ? catalogs.readServices() : catalogs.readFirmFacts() }));
app.post('/api/catalog/:which', (q, res) => { q.params.which === 'services' ? catalogs.writeServices(q.body.text) : catalogs.writeFirmFacts(q.body.text); ok(res, { ok: true }); });

// Fallback to the UI for any other route.
app.get('*', (_q, res) => res.sendFile(path.join(APP_DIR, 'public', 'index.html')));

// Bind to 0.0.0.0 so the app is reachable both locally (localhost) and over your private
// Tailscale network from your other devices. It is NOT on the public internet: Tailscale is
// a private encrypted network only your signed-in devices can join, and the password gates
// access on top of that. If you ever want to lock it to this machine only, change the host
// below back to '127.0.0.1'.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  GovSpring Prospecting is running.');
  console.log('  On this computer:      http://localhost:' + PORT);
  console.log('  From your other devices (via Tailscale): http://<this-machine-tailscale-address>:' + PORT);
  console.log('');
});
