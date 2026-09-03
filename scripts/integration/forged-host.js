// End-to-end: a forged Host / X-Forwarded-Host must not reach any emailed link.
// Uses the raw http module, not fetch: undici treats Host as a forbidden header and
// silently refuses to send it, which is exactly the header under test here.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const REPO = require('path').join(__dirname, '..', '..');
const CANONICAL = 'https://crm.canonical.test';
const FORGED = 'evil.example.com';
// Random high port: these boot a real listener, and a fixed port makes the script fail
// for reasons unrelated to the code whenever something else already holds it.
const PORT = 3300 + Math.floor(Math.random() * 600);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-e2e-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;
process.env.PORT = String(PORT);
process.env.APP_BASE_URL = CANONICAL;
process.env.ENABLE_DEV_LOGIN = '1';
delete process.env.NODE_ENV;

const users = require(path.join(REPO, 'server/users.js'));
users.init(dataDir);
users.createUser({ username: 'seeded_tester', password: 'correct-horse-battery', role: 'admin', email: 'tester@example.test' });

// Capture instead of send. Patched before server.js requires the same module instance.
const sent = [];
const gmail = require(path.join(REPO, 'server/gmail.js'));
gmail.sendInviteEmail = async (msg) => { sent.push(msg); return { ok: true }; };
gmail.isConnected = () => true;

require(path.join(REPO, 'server/server.js'));

function request(method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: pathname,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); fail++; }
};
const settle = () => new Promise(r => setTimeout(r, 400)); // route emails after responding

(async () => {
  try {
    console.log('\nitem 1 — forged host cannot reach an emailed link\n');

    // Sanity: confirm the forged Host actually arrived at the app, so a PASS below means
    // "ignored", not "never sent".
    const echo = await request('POST', '/api/auth/forgot', { body: { identifier: 'nobody' }, headers: { Host: FORGED } });
    check('forged Host request is accepted by the server', echo.status === 200, `status=${echo.status} body=${echo.text}`);

    for (const [label, headers] of [
      ['Host', { Host: FORGED }],
      ['X-Forwarded-Host', { 'X-Forwarded-Host': FORGED, 'X-Forwarded-Proto': 'http' }]
    ]) {
      sent.length = 0;
      await request('POST', '/api/auth/forgot', { body: { identifier: 'seeded_tester' }, headers });
      await settle();
      const m = sent[0];
      check(`forged ${label}: an email was produced`, !!m, `sent=${sent.length}`);
      if (m) {
        const linkLine = (m.bodyText.match(/^.*reset=.*$/m) || [''])[0].trim();
        check(`forged ${label}: link uses the canonical origin`, m.bodyText.includes(`${CANONICAL}/?reset=`), linkLine);
        check(`forged ${label}: attacker domain absent from the body`, !m.bodyText.includes(FORGED), linkLine);
      }
    }

    // The canonical link must still carry a genuinely usable token — proving the fix
    // didn't just break the reset flow.
    sent.length = 0;
    await request('POST', '/api/auth/forgot', { body: { identifier: 'seeded_tester' }, headers: { Host: FORGED } });
    await settle();
    const tok = (sent[0] && sent[0].bodyText.match(/\?reset=([A-Za-z0-9_-]+)/)) || null;
    check('canonical link carries a reset token', !!tok, sent[0] && sent[0].bodyText);
    if (tok) {
      const st = await request('GET', `/api/auth/reset-status?token=${tok[1]}`);
      check('that token is accepted by reset-status', JSON.parse(st.text).valid === true, st.text);
    }

    console.log('\nitem 7 — dev login\n');

    // The old reusable URL token is gone; dev-login is now a single-use magic link, covered
    // in full by scripts/integration/dev-login-link.js. All that matters here is that the
    // old path is dead. It is unrouted, so it falls through to the /api session gate and
    // gets a 401 rather than a 404 — either way it must not authenticate anyone.
    const oldGet = await request('GET', `/api/auth/backdoor/${'a'.repeat(40)}`);
    check('the old /api/auth/backdoor/:token path no longer authenticates', oldGet.status === 401 || oldGet.status === 404, `status=${oldGet.status}`);
    check('and it sets no session cookie', !String(oldGet.headers['set-cookie'] || '').includes('gs_session='), String(oldGet.headers['set-cookie']));

    // ---- item 8a: prototype-chain keys at the route boundary ----
    // Pre-fix these returned 500, because offers['__proto__'] handed back Object.prototype
    // (truthy), so the "unknown token" branch was skipped and the route read .slots off it.
    console.log('\nitem 8a — booking token route boundary\n');
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'prototype']) {
      const r = await request('GET', `/book/${encodeURIComponent(key)}/data`);
      check(`/book/${key}/data -> 404, not 500`, r.status === 404, `status=${r.status} body=${r.text}`);
    }
    const absent = await request('GET', `/book/${'a'.repeat(40)}/data`);
    check('a well-formed but absent token -> 404', absent.status === 404, `status=${absent.status}`);

    for (const key of ['__proto__', 'constructor']) {
      const r = await request('POST', `/book/${encodeURIComponent(key)}/confirm`, { startISO: '2030-01-01T15:00:00.000Z' });
      check(`POST /book/${key}/confirm -> 404, not 500`, r.status === 404, `status=${r.status} body=${r.text}`);
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
  } catch (e) {
    console.log(`\n  HARNESS ERROR: ${e && e.stack || e}\n`);
    fail++;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
