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
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e.message}). Refusing to start rather than ` +
      `overwrite it with an empty store — restore from a backup.`
    );
  }
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

module.exports = { readJSON, writeJSON, writeText, nextIdFrom };
