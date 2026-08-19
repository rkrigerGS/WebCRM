// store.js — shared atomic JSON persistence for the five hand-rolled stores
// (db.js, users.js, config.js, audit.js, catalogs.js).
//
// Each of those used to carry its own copy of this logic, and each copy had the same
// bug: a bare `catch { save(); }` around the initial read, commented "no file yet".
// That catch could not tell a genuine first run (ENOENT) from a truncated file, a
// permissions error, or an I/O error — so any of those was treated as "fresh install"
// and the empty store was written straight over real data, silently, with the original
// bytes gone before anyone could look. readJSON() below draws that line properly:
// missing means missing, everything else throws and the app refuses to start.

const fs = require('fs');

// Reads and parses a JSON store file.
// Returns null only when the file genuinely does not exist yet — that is the one case
// where a caller may legitimately initialize an empty store. Every other failure throws.
function readJSON(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(
      `Cannot read ${file} (${e.code || e.message}). Refusing to start rather than ` +
      `overwrite it with an empty store — fix the permissions or restore from a backup.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e.message}). Refusing to start rather than ` +
      `overwrite it with an empty store — restore from a backup.`
    );
  }
  // Every store's root is a plain object. Valid JSON like `null`, `[]`, or `"x"` would
  // pass parsing, then blow up (or worse, be silently normalized over) deep inside a
  // store's load() — same data-loss shape the ENOENT/parse guards above exist to prevent.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${file} does not contain a JSON object at the top level. Refusing to start rather ` +
      `than overwrite it with an empty store — restore from a backup.`
    );
  }
  return parsed;
}

// Writes to a temp file in the same directory, flushes it to disk, then renames over
// the real file. The rename is atomic within a filesystem, so a reader never sees a
// half-written store; the fsync is what makes that hold across a host-level crash or
// power loss, which can otherwise commit the rename ahead of the data blocks and leave
// a zero-length file behind.
function writeJSON(file, value) {
  writeText(file, JSON.stringify(value, null, 2));
}

// Same guarantee for plain-text files (the hand-editable catalogs).
function writeText(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Highest existing numeric id, plus one. Records with a missing or non-numeric id are
// ignored rather than poisoning the result: Math.max(0, undefined) is NaN, and once
// nextId is NaN every new record gets id NaN, nextId stays NaN, and `find(r => r.id === id)`
// never matches anything again because NaN !== NaN — every lookup silently 404s.
function nextIdFrom(records) {
  return (records || []).reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
}

// Today's date (YYYY-MM-DD) in the business's timezone, New York — shared by every
// "today" stamp (date_sent, activity dates, dormant-return checks). The old
// toISOString().slice(0,10) stamps were UTC, which after 7/8pm ET is already tomorrow:
// follow-up gaps ran a day short and dormant returns fired an evening early.
function todayNY() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = { readJSON, writeJSON, writeText, nextIdFrom, todayNY };
