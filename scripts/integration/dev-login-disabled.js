// item 7, the property that matters most: with ENABLE_DEV_LOGIN unset the route is not
// registered at all, no session can be obtained through it, and dev_rafael is never created.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const REPO = require('path').join(__dirname, '..', '..');
// Random high port: these boot a real listener, and a fixed port makes the script fail
// for reasons unrelated to the code whenever something else already holds it.
const PORT = 3300 + Math.floor(Math.random() * 600);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcrm-off-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dataDir;
process.env.PORT = String(PORT);
process.env.APP_BASE_URL = 'https://crm.canonical.test';
delete process.env.ENABLE_DEV_LOGIN; // the point of this test
delete process.env.NODE_ENV;

require(path.join(REPO, 'server/server.js'));

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: pathname,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
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

(async () => {
  try {
    console.log('\nitem 7 — ENABLE_DEV_LOGIN unset\n');

    const r = await request('GET', `/api/auth/dev-login/${'d'.repeat(40)}`);
    check('the dev-login link does not authenticate', r.status !== 303 && r.status !== 200, `status=${r.status} body=${r.text}`);
    check('it issues no session cookie', !String(r.headers['set-cookie'] || '').includes('gs_session='), String(r.headers['set-cookie']));

    // dev_rafael must not exist after an attempt
    const usersFile = path.join(dataDir, 'users.json');
    const raw = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : { users: [] };
    const list = raw.users || [];
    check('dev_rafael was not auto-created', !list.some(u => u.username === 'dev_rafael'), JSON.stringify(list.map(u => u.username)));

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
  } catch (e) {
    console.log(`\n  HARNESS ERROR: ${e && e.stack || e}\n`);
    fail++;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
