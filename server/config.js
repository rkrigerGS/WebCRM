// config.js
// Small local settings store: the Anthropic API key and a few preferences.
// Lives as a plain JSON file in the app's user-data directory, separate from the
// database, so it is easy to inspect and never travels in the export bundle.

const path = require('path');
const store = require('./store');

let configPath;
let cache = null;

const DEFAULTS = {
  anthropicApiKey: '',           // pasted by the user at setup
  baseUrl: '',                   // canonical origin for outbound links; '' = take it from APP_BASE_URL (see resolveBaseUrl)
  draftModel: 'claude-sonnet-4-5-20250929',
  clerkPhrase: 'my law clerk',   // "my law clerk" | "my law clerks" | "some summer law clerks"
  defaultFollowupDays: 4,
  watchFolder: '',               // where the research agent writes dossiers; '' = use built-in default
  googleClientId: '',            // Google Cloud OAuth client, pasted by an admin in Settings
  googleClientSecret: '',        // (Gmail sending — see server/gmail.js)
  backupFrequency: 'off',        // 'off' | 'daily' | '3days' | 'weekly' (see server/backup.js)
  lastBackupAt: '',              // ISO timestamp of the last scheduled backup sent, or '' if never
  digestRecipientIds: [],        // additional user ids to CC on the Monday digest, beyond Marcos (always included) — see server/digest.js
  meetingParticipantIds: [],     // user ids added by default to meetings booked through emailed slot links (the SA can deselect per email) — see the /book routes in server.js
  lastDigestWeekKey: '',         // NY-local date (YYYY-MM-DD) of the Monday last sent or logged-as-missed, so a restart never double-sends or loses the week
  setupCompleted: false          // set once the first admin exists; a second gate on /api/auth/setup (see server.js)
};

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  load();
  return configPath;
}

function load() {
  const raw = store.readJSON(configPath); // throws on a corrupt/unreadable file
  cache = { ...DEFAULTS, ...(raw || {}) };
  if (!raw) save(); // genuinely no file yet: write the defaults
  return cache;
}

function get() { return cache || load(); }

function save() {
  store.writeJSON(configPath, cache);
}

// Only keys that exist in DEFAULTS can be written. Callers reach this from request
// handlers, and without the filter an arbitrary request body could add fields the app
// never reads but that persist forever, or set an internal bookkeeping key by hand.
// This is a shape guard, not an access control — the routes that expose update() are
// admin-gated separately in server.js.
const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

// Read once at boot and then cached (see resolveBaseUrl), so writing it at runtime would
// look inert until the next restart and then silently redirect every password-reset and
// invite link the app sends. No route needs to change it, so nothing may: it is set by
// hand in config.json, or by the APP_BASE_URL environment variable.
const BOOT_ONLY_KEYS = new Set(['baseUrl']);

function update(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (ALLOWED_KEYS.has(k) && !BOOT_ONLY_KEYS.has(k)) clean[k] = v;
  cache = { ...get(), ...clean };
  save();
  return cache;
}

// ---- Canonical base URL ----
// Every link that leaves this process — password-reset and invite emails, the Google OAuth
// callback, and the booking buttons in outreach emails — must be built from a configured
// origin, never from the incoming request. `Host` (and `X-Forwarded-Host`) are chosen by
// the client, so an unauthenticated POST /api/auth/forgot carrying a forged Host made the
// server email the victim a genuinely working reset token pointing at the attacker's
// domain. Trusting the proxy does not help: forwarded headers are just as forgeable, so
// the only fix is to ignore the request entirely and use a value the operator configured.
//
// Resolved once at boot, so a misconfiguration fails loudly at startup instead of quietly
// on the first reset email months later.
let baseUrlCache = null;

// port/isProduction are passed in rather than read here: PORT and the Railway markers are
// already resolved in server.js, and duplicating that detection is how the two drift.
function resolveBaseUrl({ port, isProduction }) {
  const raw = String(process.env.APP_BASE_URL || '').trim()
    || String(get().baseUrl || '').trim()
    || (!isProduction ? `http://localhost:${port}` : '');

  // No soft fallback in production. Falling back to the request header here would silently
  // reintroduce the vulnerability on the exact deploy where it matters most.
  if (!raw) {
    throw new Error(
      'APP_BASE_URL is not set. Refusing to start: outbound links (password resets, invites, '
      + 'booking links) would have to be built from the client-controlled Host header. '
      + 'Set APP_BASE_URL=https://your-host to fix this.'
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`APP_BASE_URL is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`APP_BASE_URL must be http or https, got ${JSON.stringify(parsed.protocol)}`);
  }

  // .origin normalizes away any path, query, or trailing slash the operator pasted in.
  baseUrlCache = parsed.origin;
  return baseUrlCache;
}

function baseUrl() {
  if (!baseUrlCache) throw new Error('resolveBaseUrl() must run at boot before any outbound link is built.');
  return baseUrlCache;
}

// Path is resolved against the canonical origin, so callers pass '/?reset=x' and never
// concatenate a host themselves.
function absoluteUrl(pathname) {
  return new URL(pathname, baseUrl()).toString();
}

function hasApiKey() {
  const k = get().anthropicApiKey;
  return typeof k === 'string' && k.startsWith('sk-ant-');
}

function hasGoogleCreds() {
  const c = get();
  return !!(c.googleClientId && c.googleClientSecret);
}

module.exports = { init, get, update, save, hasApiKey, hasGoogleCreds, resolveBaseUrl, baseUrl, absoluteUrl };
