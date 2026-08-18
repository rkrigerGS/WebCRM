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
  draftModel: 'claude-sonnet-4-5-20250929',
  clerkPhrase: 'my law clerk',   // "my law clerk" | "my law clerks" | "some summer law clerks"
  defaultFollowupDays: 4,
  watchFolder: '',               // where the research agent writes dossiers; '' = use built-in default
  googleClientId: '',            // Google Cloud OAuth client, pasted by an admin in Settings
  googleClientSecret: '',        // (Gmail sending — see server/gmail.js)
  backupFrequency: 'off',        // 'off' | 'daily' | '3days' | 'weekly' (see server/backup.js)
  lastBackupAt: '',              // ISO timestamp of the last scheduled backup sent, or '' if never
  digestRecipientIds: [],        // additional user ids to CC on the Monday digest, beyond Marcos (always included) — see server/digest.js
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

function update(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (ALLOWED_KEYS.has(k)) clean[k] = v;
  cache = { ...get(), ...clean };
  save();
  return cache;
}

function hasApiKey() {
  const k = get().anthropicApiKey;
  return typeof k === 'string' && k.startsWith('sk-ant-');
}

function hasGoogleCreds() {
  const c = get();
  return !!(c.googleClientId && c.googleClientSecret);
}

module.exports = { init, get, update, save, hasApiKey, hasGoogleCreds };
