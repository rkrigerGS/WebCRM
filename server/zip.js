// zip.js — a minimal, dependency-free ZIP archive writer.
// Node has no built-in ZIP container format (zlib only gives raw deflate/gzip streams),
// and the brief for the backup feature forbids new dependencies. The ZIP format itself is
// a stable, decades-old binary layout — local file headers, a central directory, and an
// end-of-central-directory record — simple enough to construct by hand; this is literally
// what a zip library does internally. Supports one compression method (deflate, via
// Node's built-in zlib) and no zip64/encryption/multi-disk, which is everything a backup
// of this app's JSON/text data needs.

const zlib = require('zlib');

// CRC-32 (IEEE 802.3), computed from a lookup table built once at module load.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// DOS date/time encoding used by the ZIP format (local time, 2-second resolution).
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dosDate = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { time, date: dosDate };
}

// entries: [{ name: 'relative/path.json', data: Buffer|string }]. Returns a Buffer
// containing the complete .zip file. `now` lets callers pass a fixed timestamp (module
// scripts here can't call `new Date()` themselves during a workflow run, but the server
// itself calls this directly, so it defaults to the current time).
function createZip(entries, now) {
  now = now || new Date();
  // The end-of-central-directory record stores the entry count in 16 bits, so 65,535 is a
  // hard ceiling for a non-zip64 archive. Without this check the writeUInt16LE below
  // throws a bare ERR_OUT_OF_RANGE that says nothing about what to do — and the scheduled
  // backup would then fail silently every night forever.
  const MAX_ENTRIES = 0xFFFF;
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `Backup contains ${entries.length} files, over the ${MAX_ENTRIES}-file limit of the zip format used here. ` +
      `Archive or delete old files under the data directory (approved-emails and watched-dossiers grow without limit) and try again.`
    );
  }
  const { time, date } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(dataBuf);
    const compressed = zlib.deflateRawSync(dataBuf);
    const method = 8; // deflate
    // General-purpose bit 11 declares the filename as UTF-8. Without it, extractors read
    // names as CP437 and any non-ASCII character (reachable through watched-dossiers/,
    // whose names come from whatever the research tool wrote) produces a mangled name or
    // an outright extraction failure. Names here are always written UTF-8, so set it.
    const flags = 0x800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);   // local file header signature
    localHeader.writeUInt16LE(20, 4);           // version needed to extract
    localHeader.writeUInt16LE(flags, 6);        // general purpose flag (bit 11 = UTF-8 name)
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);           // extra field length

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed to extract
    centralHeader.writeUInt16LE(flags, 8);      // general purpose flag (bit 11 = UTF-8 name)
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra field length
    centralHeader.writeUInt16LE(0, 32);         // comment length
    centralHeader.writeUInt16LE(0, 34);         // disk number start
    centralHeader.writeUInt16LE(0, 36);         // internal attrs
    centralHeader.writeUInt32LE(0, 38);         // external attrs
    centralHeader.writeUInt32LE(offset, 42);    // offset of local header

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);                // disk number
  end.writeUInt16LE(0, 6);                // disk with central dir
  end.writeUInt16LE(entries.length, 8);   // entries on this disk
  end.writeUInt16LE(entries.length, 10);  // total entries
  end.writeUInt32LE(centralDirBuf.length, 12);
  end.writeUInt32LE(centralDirStart, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...localParts, centralDirBuf, end]);
}

module.exports = { createZip, crc32 };
