const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Item 1 of the 2026-09-02 hardening pass: every link that leaves the process is built
// from a configured origin, never from the request's Host header. The vulnerability these
// guard against: POST /api/auth/forgot needs no session, so a forged Host made the server
// email a victim a genuinely working reset token pointing at an attacker's domain.
//
// The end-to-end proof (a forged Host/X-Forwarded-Host against a live server, asserting
// the emailed body carries the canonical origin) needs a listening server and lives in
// scripts/integration/. These are the fast, deterministic guards.

// resolveBaseUrl caches per module instance, so each case gets a fresh require.
// `seed` is written straight into config.json because baseUrl is deliberately boot-only:
// config.update() refuses it, so a test that set it through update() would be exercising a
// path no operator can use.
function freshConfig(seed) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('server', 'config.js'))) delete require.cache[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-cfg-'));
  if (seed) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(seed));
  const config = require('../server/config');
  config.init(dir);
  return config;
}

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'APP_BASE_URL');
  const prev = process.env.APP_BASE_URL;
  if (value === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = value;
  try { fn(); } finally {
    if (had) process.env.APP_BASE_URL = prev; else delete process.env.APP_BASE_URL;
  }
}

test('production with nothing configured refuses to boot rather than trusting the request', () => {
  const config = freshConfig();
  withEnv(undefined, () => {
    assert.throws(
      () => config.resolveBaseUrl({ port: 3000, isProduction: true }),
      /APP_BASE_URL is not set/,
      'a soft fallback here would silently reintroduce the vulnerability on the deploy that matters'
    );
  });
});

test('APP_BASE_URL takes precedence over config.json baseUrl', () => {
  const config = freshConfig({ baseUrl: 'https://from-config.test' });
  withEnv('https://from-env.test', () => {
    assert.strictEqual(config.resolveBaseUrl({ port: 3000, isProduction: true }), 'https://from-env.test');
  });
});

test('config.json baseUrl is used when the env var is absent', () => {
  const config = freshConfig({ baseUrl: 'https://crm.govspring.test' });
  withEnv(undefined, () => {
    assert.strictEqual(config.resolveBaseUrl({ port: 3000, isProduction: true }), 'https://crm.govspring.test');
  });
});

test('a pasted path, query, or trailing slash is normalized away to the origin', () => {
  const config = freshConfig();
  withEnv('https://crm.example.com/some/path/?x=1', () => {
    assert.strictEqual(config.resolveBaseUrl({ port: 3000, isProduction: true }), 'https://crm.example.com');
  });
});

test('a non-default port survives normalization', () => {
  const config = freshConfig();
  withEnv('https://crm.example.com:8443/x', () => {
    assert.strictEqual(config.resolveBaseUrl({ port: 3000, isProduction: true }), 'https://crm.example.com:8443');
  });
});

test('a malformed base URL fails at boot, not at the first password reset', () => {
  const config = freshConfig();
  withEnv('not-a-url', () => {
    assert.throws(() => config.resolveBaseUrl({ port: 3000, isProduction: true }), /not a valid absolute URL/);
  });
});

test('a non-http scheme is refused', () => {
  const config = freshConfig();
  withEnv('javascript:alert(1)', () => {
    assert.throws(() => config.resolveBaseUrl({ port: 3000, isProduction: true }), /must be http or https/);
  });
});

test('local dev with nothing configured falls back to localhost on the real port', () => {
  const config = freshConfig();
  withEnv(undefined, () => {
    assert.strictEqual(config.resolveBaseUrl({ port: 3199, isProduction: false }), 'http://localhost:3199');
  });
});

test('absoluteUrl builds the reset, invite, and OAuth callback links off the canonical origin', () => {
  const config = freshConfig();
  withEnv('https://crm.example.com/ignored/', () => {
    config.resolveBaseUrl({ port: 3000, isProduction: true });
    assert.strictEqual(config.absoluteUrl('/?reset=abc123'), 'https://crm.example.com/?reset=abc123');
    assert.strictEqual(config.absoluteUrl('/?invite=tok'), 'https://crm.example.com/?invite=tok');
    assert.strictEqual(config.absoluteUrl('/api/admin/gmail/callback'), 'https://crm.example.com/api/admin/gmail/callback');
  });
});

// baseUrl is read once at boot and cached, so a runtime write would look inert until the
// next restart and then silently redirect every reset and invite link the app sends. No
// route needs to change it, so update() must refuse it outright.
test('config.update() cannot change baseUrl', () => {
  const config = freshConfig({ baseUrl: 'https://original.test' });
  config.update({ baseUrl: 'https://attacker.test', clerkPhrase: 'my law clerks' });
  assert.strictEqual(config.get().baseUrl, 'https://original.test', 'baseUrl must be boot-only');
  assert.strictEqual(config.get().clerkPhrase, 'my law clerks', 'other keys must still be writable');
});

test('baseUrl() before resolution throws instead of returning a wrong origin', () => {
  const config = freshConfig();
  assert.throws(() => config.baseUrl(), /must run at boot/);
});

// ---- Static regression guard ----
// The original fix touched two known lines; a grep of the whole tree found four sites,
// two of them worse than the reported ones (the unauthenticated reset link, and the
// booking URLs embedded in outreach emails to prospects). This guard is what keeps a
// fifth from appearing: any request-derived host reaching a generated link is the bug.
test('no route builds a URL from the incoming request host or protocol', () => {
  const serverDir = path.join(__dirname, '..', 'server');
  const offenders = [];
  // config.js parses APP_BASE_URL with the URL class and legitimately reads
  // parsed.protocol; linkedinEngine.js validates a URL the same way. Neither touches a
  // request. Anything else matching is a real finding.
  const ALLOWLIST = new Set(['config.js', 'linkedinEngine.js']);
  for (const file of fs.readdirSync(serverDir)) {
    if (!file.endsWith('.js') || ALLOWLIST.has(file)) continue;
    const src = fs.readFileSync(path.join(serverDir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      // Case-insensitive, and forwarded headers included: express header lookups are
      // case-insensitive, so req.get('Host') is valid code, and X-Forwarded-Host is just
      // as forgeable as Host.
      if (/\.get\(\s*['"](?:host|x-forwarded-host|x-forwarded-proto)['"]\s*\)/i.test(line)
          || /\.headers\s*\[\s*['"](?:host|x-forwarded-host|x-forwarded-proto)['"]\s*\]/i.test(line)
          || /\b[a-z_$][\w$]*\.hostname\b/i.test(line)
          || /\.protocol\s*\}?\s*:\/\//.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], `outbound links must use config.absoluteUrl(), not the request:\n${offenders.join('\n')}`);
});
