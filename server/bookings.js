// bookings.js — booking offers behind the "pick a time" links in outreach emails.
//
// When an email goes out with offered slots, one offer record is created here with an
// unguessable token; the email's booking links all carry that token. The public /book
// routes in server.js resolve the token back to the offer, and when the prospect confirms
// a slot the offer is marked booked with the created Calendar event and Meet link.
//
// Same persistence pattern as every other store: one JSON file in the data directory,
// written atomically via store.writeJSON. Volume is low (one offer per sent email that
// included slots), so the whole file is held in memory like config.json is.

const path = require('path');
const crypto = require('crypto');
const store = require('./store');

let filePath;
let offers = null; // { [token]: offer }

function init(dataDir) {
  filePath = path.join(dataDir, 'bookings.json');
  offers = store.readJSON(filePath) || {}; // throws on a corrupt file, same as the other stores
}

function save() {
  store.writeJSON(filePath, offers);
}

// slots: [{ startISO, endISO, label }] — already validated by the send route.
// participants: extra attendee emails beyond the prospect (Marcos is the organizer, so his
// own calendar carries the event without being listed here).
function createOffer({ prospectId, companyName, prospectEmail, participants, slots }) {
  const token = crypto.randomBytes(20).toString('hex');
  const offer = {
    token,
    prospectId,
    companyName: companyName || '',
    prospectEmail,
    participants: participants || [],
    slots,
    createdAt: new Date().toISOString(),
    status: 'open', // 'open' | 'booked'
    booked: null    // { startISO, endISO, label, eventId, meetLink, bookedAt }
  };
  offers[token] = offer;
  save();
  return offer;
}

// Tokens are 40 hex characters (crypto.randomBytes(20)). Anything else cannot be a real
// offer, so it is rejected before it ever reaches a property lookup.
const TOKEN_PATTERN = /^[0-9a-f]{40}$/;
function isValidTokenShape(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

// `offers` is a plain object deserialized from JSON, so a bare offers[token] lookup
// resolved inherited keys: /book/__proto__/data returned Object.prototype — an object, so
// the "not found" branch never ran — and the route then 500'd on it instead of 404ing.
// `constructor`, `toString` and `valueOf` were reachable the same way. Two layers here:
// the shape check above rejects them at the door, and Object.hasOwn means even a future
// caller that skips the shape check cannot walk the prototype chain.
function getOffer(token) {
  if (!offers || !isValidTokenShape(token)) return null;
  if (!Object.hasOwn(offers, token)) return null;
  const offer = offers[token];
  // A JSON file hand-edited to hold a non-object value would otherwise flow onward as one.
  return (offer && typeof offer === 'object') ? offer : null;
}

function markBooked(token, booked) {
  const offer = getOffer(token);
  if (!offer) throw new Error('Unknown booking token.');
  offer.status = 'booked';
  offer.booked = { ...booked, bookedAt: new Date().toISOString() };
  save();
  return offer;
}

module.exports = { init, createOffer, getOffer, markBooked };
