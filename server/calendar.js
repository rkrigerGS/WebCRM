// calendar.js — read-only Google Calendar free/busy lookup, used to offer Marcos's real
// open times in a generated draft (the "pick specific slots, like Gmail's own availability
// picker" flow). Reuses gmail.js's OAuth connection (same account, same token, combined
// gmail.modify + calendar.readonly scope) — there is no separate Calendar connect step.

const crypto = require('crypto');
const gmail = require('./gmail');

const TIMEZONE = 'America/New_York';
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
// Half-hour slots over the next two business days: short-notice, low-commitment openings
// suit a cold-outreach booking link better than week-out hour blocks did.
const LOOKAHEAD_BUSINESS_DAYS = 2;
const SLOT_MINUTES = 30;
const MAX_SLOTS = 16;

// Converts an America/New_York wall-clock instant (y/m/d/hour/minute) to the correct UTC
// Date, DST-correct. Two passes converge: format the first guess back into NY wall time,
// measure the drift against what we wanted, and shift by that drift.
function nyWallClockToUTC(y, month, d, hour, minute) {
  let guess = new Date(Date.UTC(y, month - 1, d, hour, minute, 0));
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(guess);
    const get = t => parseInt(parts.find(p => p.type === t).value, 10);
    const gotUTCMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    const wantUTCMs = Date.UTC(y, month - 1, d, hour, minute);
    guess = new Date(guess.getTime() + (wantUTCMs - gotUTCMs));
  }
  return guess;
}

// The next `count` business days (Mon-Fri, NY calendar), starting tomorrow — never today,
// so a slot offered in an afternoon-drafted email isn't already in the past by the time it
// sends. Drift in the UTC anchor used to walk days doesn't matter: each candidate is
// immediately re-read as NY wall-clock parts via Intl, which is DST-correct regardless.
function upcomingBusinessDays(now, count) {
  const days = [];
  let i = 1;
  while (days.length < count && i < 30) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(candidate);
    const get = t => parts.find(p => p.type === t).value;
    const weekday = get('weekday');
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      days.push({ y: +get('year'), month: +get('month'), d: +get('day') });
    }
    i++;
  }
  return days;
}

function formatSlotLabel(startUTC, endUTC) {
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
  return `${dayFmt.format(startUTC)}, ${timeFmt.format(startUTC)}–${timeFmt.format(endUTC)} ET`;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// `notConnected` marks the two expected "not set up yet" states, so the route can tell them
// apart from a genuine failure — see GET /api/calendar/availability in server.js.
function notConnected(message) {
  const e = new Error(message);
  e.notConnected = true;
  return e;
}

// Up to MAX_SLOTS free 1-hour blocks, business hours only, across the next
// LOOKAHEAD_BUSINESS_DAYS weekdays, skipping anything the primary calendar shows as busy.
// Throws gmail.js's own connection errors as-is (no creds, not connected, refresh failed)
// so the caller's existing error handling covers this too.
//
// Every failure here MUST throw rather than degrade to "no busy time". These slots get
// offered to a prospective client in an outreach email, so silently treating an unreadable
// calendar as an empty one would have Marcos offering hours he is already booked for.
async function getAvailableSlots() {
  if (!gmail.isConnected()) throw notConnected('Gmail is not connected.');
  if (!gmail.hasCalendarAccess()) throw notConnected('Calendar access has not been granted yet. Disconnect and reconnect Gmail in Settings to add it.');

  const now = new Date();
  const days = upcomingBusinessDays(now, LOOKAHEAD_BUSINESS_DAYS);
  const dayWindows = days.map(({ y, month, d }) => ({
    start: nyWallClockToUTC(y, month, d, BUSINESS_START_HOUR, 0),
    end: nyWallClockToUTC(y, month, d, BUSINESS_END_HOUR, 0)
  }));

  const busy = await getBusyIntervals(
    dayWindows[0].start.toISOString(),
    dayWindows[dayWindows.length - 1].end.toISOString()
  );

  const slotMs = SLOT_MINUTES * 60000;
  const slots = [];
  for (const { start: dayStart, end: dayEnd } of dayWindows) {
    for (let t = dayStart.getTime(); t + slotMs <= dayEnd.getTime(); t += slotMs) {
      const slotStart = new Date(t), slotEnd = new Date(t + slotMs);
      if (busy.some(b => overlaps(slotStart, slotEnd, b.start, b.end))) continue;
      slots.push({ startISO: slotStart.toISOString(), endISO: slotEnd.toISOString(), label: formatSlotLabel(slotStart, slotEnd) });
      if (slots.length >= MAX_SLOTS) return slots;
    }
  }
  return slots;
}

// The raw busy list for a window, with the same fail-loudly semantics as above — shared by
// the slot builder and the public booking page (which re-checks offered slots on load and
// again at confirm time, so a slot Marcos filled after the email went out can't be booked).
async function getBusyIntervals(timeMinISO, timeMaxISO) {
  // callGmail (not a bare ensureAccessToken + requestJSON) so a 401 from a token Google
  // invalidated early gets the same forced-refresh-and-retry every Gmail call gets.
  const freeBusy = await gmail.callGmail(accessToken => ({
    hostname: 'www.googleapis.com', path: '/calendar/v3/freeBusy', method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: { timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: 'primary' }] }
  }));
  // Google reports a per-calendar failure inside the 200 response rather than as an HTTP
  // error: calendars.primary carries an errors[] and an empty busy[]. Reading .busy straight
  // off it turned "we could not see the calendar" into "the whole week is free".
  const primary = freeBusy && freeBusy.calendars && freeBusy.calendars.primary;
  if (!primary) throw new Error('Google returned no free/busy data for the primary calendar, so open times cannot be determined.');
  if (Array.isArray(primary.errors) && primary.errors.length) {
    const why = primary.errors.map(e => e.reason || e.domain || 'unknown').join(', ');
    throw new Error(`Google could not read the primary calendar (${why}), so open times cannot be determined.`);
  }
  if (!Array.isArray(primary.busy)) throw new Error('Google returned a free/busy response with no busy list, so open times cannot be determined.');

  // An unparseable interval must not be silently dropped either — dropping it marks a booked
  // hour as free, which is the same outward-facing mistake as ignoring errors[].
  return primary.busy.map(b => {
    const start = new Date(b.start), end = new Date(b.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error(`Google returned an unreadable busy interval (${JSON.stringify(b)}), so open times cannot be determined.`);
    }
    return { start, end };
  });
}

// True only if the primary calendar shows nothing overlapping [startISO, endISO). Same
// throw-on-unreadable rule: a booking must never proceed on an unverifiable window.
async function isRangeFree(startISO, endISO) {
  const busy = await getBusyIntervals(startISO, endISO);
  const start = new Date(startISO), end = new Date(endISO);
  return !busy.some(b => overlaps(start, end, b.start, b.end));
}

// Creates the real Calendar event (on Marcos's primary calendar, with the prospect and any
// default participants as guests) and asks Google to attach a Meet link to it. Requires the
// calendar.events scope — callers gate on gmail.hasCalendarWriteAccess() first so a stale
// grant produces a clear "reconnect Gmail" message instead of a Google 403.
// sendUpdates=all makes Google email the invite to every attendee, so the prospect gets the
// Meet link even if they never see the confirmation page again.
async function createMeetEvent({ startISO, endISO, summary, description, attendees }) {
  const event = await gmail.callGmail(accessToken => ({
    hostname: 'www.googleapis.com',
    path: '/calendar/v3/events?conferenceDataVersion=1&sendUpdates=all',
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: TIMEZONE },
      end: { dateTime: endISO, timeZone: TIMEZONE },
      attendees: (attendees || []).map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: 'gs-' + crypto.randomBytes(8).toString('hex'),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }
  }));
  // The Meet link is usually on the response already; hangoutLink is Google's own shortcut
  // field for it. If the conference is still provisioning, the invite email carries it —
  // the booking has still succeeded, so this returns with meetLink ''.
  const entry = ((event.conferenceData && event.conferenceData.entryPoints) || []).find(p => p.entryPointType === 'video');
  return {
    eventId: event.id || '',
    meetLink: (entry && entry.uri) || event.hangoutLink || '',
    htmlLink: event.htmlLink || ''
  };
}

module.exports = { getAvailableSlots, getBusyIntervals, isRangeFree, createMeetEvent };
