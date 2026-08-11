// config.js
// Small local settings store: the Anthropic API key and a few preferences.
// Lives as a plain JSON file in the app's user-data directory, separate from the
// database, so it is easy to inspect and never travels in the export bundle.

const fs = require('fs');
const path = require('path');

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
  lastDigestWeekKey: ''          // NY-local date (YYYY-MM-DD) of the Monday last sent or logged-as-missed, so a restart never double-sends or loses the week
};

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  load();
  return configPath;
}

function load() {
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
    save();
  }
  return cache;
}

function get() { return cache || load(); }

function save() {
  fs.writeFileSync(configPath, JSON.stringify(cache, null, 2), 'utf8');
}

function update(patch) {
  cache = { ...get(), ...patch };
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
