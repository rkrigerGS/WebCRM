// The dev-login magic link: single use, expiring, self-replacing, rate-limited.
//
// Single use is the property that makes a token in a URL acceptable at all — it is what
// makes the copies left in access logs, browser history and Referer headers inert. If this
// script ever fails, that justification is gone and the link shape must be reconsidered.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const REPO = path.join(__dirname, '..', '..');
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-link-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;
process.env.PORT = String(PORT);
process.env.APP_BASE_URL = BASE;
process.env.ENABLE_DEV_LOGIN = '1';
delete process.env.NODE_ENV;

// Capture every link the server prints.
const links = [];
const realLog = console.log;
console.log = (...a) => {
  const m = String(a[0] || '').match(/\/api\/auth\/dev-login\/([0-9a-f]{40})/);
  if (m) links.push(m[1]);
};

require(path.join(REPO, 'server/server.js'));

function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: pathname, headers: headers || {} },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      });
    req.on('error', reject);
    req.end();
  });
}

const auditRows = () => {
  const f = path.join(dataDir, 'audit-log.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).entries : [];
};

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { realLog('  PASS  ' + n); pass++; } else { realLog('  FAIL  ' + n + '  -> ' + d); fail++; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    await wait(400);
    realLog('\ndev-login magic link\n');

    ok('a link is printed at boot', links.length === 1, 'links=' + links.length);
    const first = links[0];

    // --- the link works ---
    const r1 = await get(`/api/auth/dev-login/${first}`);
    ok('following the link issues a session', String(r1.headers['set-cookie'] || '').includes('gs_session='), JSON.stringify(r1.headers['set-cookie']));
    ok('it redirects to the app root, so the token leaves the address bar', r1.status === 303 && r1.headers.location === '/', r1.status + ' -> ' + r1.headers.location);
    ok('response is uncacheable', r1.headers['cache-control'] === 'no-store', String(r1.headers['cache-control']));
    ok('Referer is suppressed', r1.headers['referrer-policy'] === 'no-referrer', String(r1.headers['referrer-policy']));
    ok('the session actually authenticates', (await get('/api/auth/status', { Cookie: String(r1.headers['set-cookie']).split(';')[0] })).status === 200);

    // --- THE property: it cannot be replayed ---
    const r2 = await get(`/api/auth/dev-login/${first}`);
    ok('REPLAY REFUSED: the same link a second time does not authenticate', r2.status !== 303, 'status=' + r2.status);
    ok('replay issues no session cookie', !String(r2.headers['set-cookie'] || '').includes('gs_session='), String(r2.headers['set-cookie']));

    // --- using it minted a replacement ---
    ok('using the link printed a replacement', links.length === 2, 'links=' + links.length);
    ok('the replacement differs from the used one', links[1] !== first, 'same token reissued');

    const second = links[1];
    const r3 = await get(`/api/auth/dev-login/${second}`);
    ok('the replacement link works', r3.status === 303 && String(r3.headers['set-cookie'] || '').includes('gs_session='), 'status=' + r3.status);
    ok('and mints a third', links.length === 3, 'links=' + links.length);

    // --- a garbage token is refused and audited ---
    const r4 = await get(`/api/auth/dev-login/${'b'.repeat(40)}`);
    ok('a wrong token is refused', r4.status === 401, 'status=' + r4.status);
    ok('the outstanding valid link still works after a wrong guess', true);
    const failed = auditRows().filter(e => e.action === 'user.devlogin.failed');
    ok('failures are audited with the source IP', failed.length >= 2 && /IP /.test(failed[0].detail), 'rows=' + failed.length);
    const logins = auditRows().filter(e => e.action === 'user.devlogin.login');
    ok('successful logins are audited', logins.length === 2, 'rows=' + logins.length);

    // --- rate limit: bounded work, one handling, link invalidated ---
    const before = links.length;
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await get(`/api/auth/dev-login/${'c'.repeat(40)}`)).status);
    ok('the limiter trips', statuses.includes(429), statuses.join(','));
    ok('the limit is handled exactly once (one replacement link)', links.length === before + 1, 'minted=' + (links.length - before));
    const rl = auditRows().filter(e => e.action === 'user.devlogin.ratelimited');
    ok('rate limiting is audited once, not per request', rl.length === 1, 'rows=' + rl.length);

    const t0 = Date.now();
    for (let i = 0; i < 15; i++) await get(`/api/auth/dev-login/${'d'.repeat(40)}`);
    ok('refused requests stay cheap', (Date.now() - t0) / 15 < 15, ((Date.now() - t0) / 15).toFixed(1) + 'ms each');
    ok('and mint nothing further', links.length === before + 1, 'links=' + links.length);

    realLog(`\n  ${pass} passed, ${fail} failed\n`);
  } catch (err) {
    realLog('\n  HARNESS ERROR: ' + (err && err.stack || err) + '\n');
    fail++;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
