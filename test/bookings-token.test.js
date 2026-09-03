const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bookings = require('../server/bookings');

// Item 8a of the 2026-09-02 hardening pass. `offers` is a plain object deserialized from
// bookings.json, so `offers[token]` resolved inherited keys: /book/__proto__/data got
// Object.prototype back, which is truthy, so the "unknown token" branch never ran and the
// route went on to read .status and .slots off it and 500'd. The 500 was only the symptom
// — the real finding is that unvalidated user input reached a property lookup, which also
// made `constructor`, `toString` and `valueOf` reachable as keys.

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-book-'));
  bookings.init(dir);
  return dir;
}

const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype'];

test('prototype-chain keys resolve to no offer instead of an inherited object', () => {
  freshStore();
  for (const key of PROTOTYPE_KEYS) {
    assert.strictEqual(bookings.getOffer(key), null, `${key} must not resolve to an offer`);
  }
});

test('a real token still resolves, so the guard did not break booking', () => {
  freshStore();
  const offer = bookings.createOffer({
    prospectId: 1, companyName: 'Northwind', prospectEmail: 'a@b.test',
    participants: [], slots: [{ startISO: '2030-01-01T15:00:00.000Z', endISO: '2030-01-01T15:30:00.000Z', label: 'Tue, Jan 1, 10:00 AM' }]
  });
  assert.match(offer.token, /^[0-9a-f]{40}$/, 'tokens are 20 random bytes as hex');
  const found = bookings.getOffer(offer.token);
  assert.ok(found, 'the genuine token resolves');
  assert.strictEqual(found.token, offer.token);
  assert.strictEqual(found.status, 'open');
});

test('a well-formed but absent token resolves to no offer', () => {
  freshStore();
  assert.strictEqual(bookings.getOffer('a'.repeat(40)), null);
});

test('malformed tokens are rejected on shape before any lookup happens', () => {
  freshStore();
  for (const bad of ['', '  ', 'short', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '../../etc/passwd', 'a'.repeat(40) + '?x']) {
    assert.strictEqual(bookings.getOffer(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

test('non-string tokens cannot reach the lookup', () => {
  freshStore();
  for (const bad of [null, undefined, 0, 1, {}, [], true, Object.prototype]) {
    assert.strictEqual(bookings.getOffer(bad), null, `${String(bad)} must not resolve`);
  }
});

test('markBooked refuses a prototype key rather than mutating Object.prototype', () => {
  freshStore();
  for (const key of PROTOTYPE_KEYS) {
    assert.throws(() => bookings.markBooked(key, { label: 'x', eventId: 'e', meetLink: 'm' }), /Unknown booking token/);
  }
  // Nothing leaked onto the prototype as a side effect.
  assert.strictEqual({}.status, undefined);
  assert.strictEqual({}.booked, undefined);
});

test('markBooked still works on a genuine token', () => {
  freshStore();
  const offer = bookings.createOffer({
    prospectId: 3, companyName: 'Y', prospectEmail: 'y@z.test',
    participants: [], slots: [{ startISO: '2030-03-01T15:00:00.000Z', endISO: '2030-03-01T15:30:00.000Z', label: 'slot' }]
  });
  const updated = bookings.markBooked(offer.token, { startISO: '2030-03-01T15:00:00.000Z', endISO: '2030-03-01T15:30:00.000Z', label: 'slot', eventId: 'evt1', meetLink: 'https://meet.example/abc' });
  assert.strictEqual(updated.status, 'booked');
  assert.strictEqual(updated.booked.eventId, 'evt1');
  assert.ok(updated.booked.bookedAt, 'bookedAt is stamped');
});
