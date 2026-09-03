// calendar.js — read-only Google Calendar free/busy lookup, used to offer Marcos's real
// open times in a generated draft (the "pick specific slots, like Gmail's own availability
// picker" flow). Reuses gmail.js's OAuth connection (same account, same token, combined
// gmail.modify + calendar.readonly scope) — there is no separate Calendar connect step.

const crypto = require('crypto');
const gmail = require('./gmail');

const TIMEZONE = 'America/New_York';
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
// Morning runs 9:00–12:00 and afternoon 14:00–17:00. The midday hours between them are held
// back as a FALLBACK: a block that cannot field SLOTS_PER_PERIOD openings on its own borrows
// from its own side of the 13:00 line — morning reaches forward to 13:00, afternoon reaches
// back to 13:00 — rather than offering nothing. A block that already has enough never
// borrows, so midday is not offered by default.
const MORNING_END_HOUR = 12;
const AFTERNOON_START_HOUR = 14;
const MIDDAY_SPLIT_HOUR = 13;
// Half-hour slots: short-notice, low-commitment openings suit a cold-outreach booking link
// better than week-out hour blocks did.
const SLOT_MINUTES = 30;
// Three business days ahead, each split into morning and afternoon, three options in each.
// The previous shape was a flat chronological list capped at 16, which front-loaded badly:
// a wide-open two days produced 32 candidates and the cap meant you saw all sixteen of
// day one and none of day two. Bucketing guarantees a spread across days and across the
// working day, which is the point of offering times at all.
const LOOKAHEAD_BUSINESS_DAYS = 3;
const SLOTS_PER_PERIOD = 3;

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

// Weekday and date, never "Tomorrow": the first business day ahead is only literally
// tomorrow four days a week — drafted on a Friday it is Monday — and a label that lies
// about the date is worse than one that is merely less chatty.
function formatDayLabel(startUTC) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(startUTC);
}

// Up to `n` items spread across the list rather than the first n. Three consecutive
// half-hours (9:00, 9:30, 10:00) is not a choice; first / middle / last across whatever is
// actually free is. Indices are computed against the free slots, so the spread adapts to a
// partly-booked block instead of assuming fixed times.
function pickSpread(items, n) {
  if (items.length <= n) return items.slice();
  if (n <= 1) return items.slice(0, n);
  const out = [];
  const last = items.length - 1;
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * last) / (n - 1))]);
  return out;
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

// Free half-hour openings across the next LOOKAHEAD_BUSINESS_DAYS weekdays, grouped into a
// morning (9:00–12:00) and an afternoon (14:00–17:00) block per day.
//
// EVERY free slot is returned, not just the chosen ones: SLOTS_PER_PERIOD of them are
// flagged `suggested`, spread through the block, and the picker shows those by default with
// the rest one click away. Returning only the suggestions meant the SA had no way to offer a
// time the algorithm happened not to pick, and getting one required closing and reopening
// the whole draft flow. The full list costs nothing — at most 3 days x 2 blocks x 6.
// Each slot carries dayLabel and period so the picker can group them under headings.
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
  // Only used to bound the single freeBusy query; the per-block windows are computed below.
  const dayWindows = days.map(({ y, month, d }) => ({
    start: nyWallClockToUTC(y, month, d, BUSINESS_START_HOUR, 0),
    end: nyWallClockToUTC(y, month, d, BUSINESS_END_HOUR, 0)
  }));

  const busy = await getBusyIntervals(
    dayWindows[0].start.toISOString(),
    dayWindows[dayWindows.length - 1].end.toISOString()
  );

  const slotMs = SLOT_MINUTES * 60000;
  // Every free half-hour in [fromHour, toHour) on one day, in order.
  const freeSlotsIn = ({ y, month, d }, fromHour, toHour) => {
    const windowStart = nyWallClockToUTC(y, month, d, fromHour, 0).getTime();
    const windowEnd = nyWallClockToUTC(y, month, d, toHour, 0).getTime();
    const free = [];
    for (let t = windowStart; t + slotMs <= windowEnd; t += slotMs) {
      const slotStart = new Date(t), slotEnd = new Date(t + slotMs);
      if (busy.some(b => overlaps(slotStart, slotEnd, b.start, b.end))) continue;
      free.push({ startISO: slotStart.toISOString(), endISO: slotEnd.toISOString(), label: formatSlotLabel(slotStart, slotEnd), dayLabel: formatDayLabel(slotStart) });
    }
    return free;
  };

  // Each block has a preferred window and a midday fallback on its own side of 13:00.
  const blocks = [
    { period: 'morning', from: BUSINESS_START_HOUR, to: MORNING_END_HOUR, fallbackFrom: MORNING_END_HOUR, fallbackTo: MIDDAY_SPLIT_HOUR },
    { period: 'afternoon', from: AFTERNOON_START_HOUR, to: BUSINESS_END_HOUR, fallbackFrom: MIDDAY_SPLIT_HOUR, fallbackTo: AFTERNOON_START_HOUR }
  ];
  const byStart = (a, b) => a.startISO.localeCompare(b.startISO);

  const slots = [];
  for (const day of days) {
    for (const b of blocks) {
      const preferred = freeSlotsIn(day, b.from, b.to);

      // Borrow from midday only to make up a shortfall, and only as many as are missing —
      // a block with three openings of its own never shows a midday time. Note a block is
      // still never padded from the OTHER half of the day: "Thu morning" offering a Thu
      // afternoon slot would misrepresent the choice, so the fallback stays on its own side
      // of 13:00.
      const shortfall = SLOTS_PER_PERIOD - preferred.length;
      const fallback = shortfall > 0 ? freeSlotsIn(day, b.fallbackFrom, b.fallbackTo) : [];
      const borrowed = pickSpread(fallback, shortfall);

      // Suggest everything the preferred window has, topped up with what was borrowed, then
      // spread across the result if the preferred window alone was already over quota.
      const pool = [...preferred, ...borrowed].sort(byStart);
      const suggested = new Set(pickSpread(pool, SLOTS_PER_PERIOD).map(x => x.startISO));

      // The full list keeps every borrowed hour too, so "+N more" can reveal the rest of a
      // thin block rather than dead-ending at three.
      const all = [...preferred, ...fallback].sort(byStart);
      for (const slot of all) {
        slots.push({ ...slot, period: b.period, suggested: suggested.has(slot.startISO) });
      }
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
