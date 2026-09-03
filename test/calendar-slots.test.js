const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Slot selection for the "offer specific open times" flow. These times go out to a
// prospective client in a cold outreach email, so the two properties that matter most are
// (a) a busy calendar is never mistaken for a free one, and (b) the offered times are
// spread across days and across the working day rather than bunched.
//
// gmail.js is stubbed at require time so this runs with no network and no OAuth. The
// freeBusy response shape mirrors Google's, including the failure shapes it reports inside
// a 200.

function loadCalendarWith({ busy = [], connected = true, calendarAccess = true, freeBusyOverride = null } = {}) {
  const gmailPath = require.resolve('../server/gmail');
  const calPath = require.resolve('../server/calendar');
  delete require.cache[calPath];
  delete require.cache[gmailPath];

  const stub = {
    isConnected: () => connected,
    hasCalendarAccess: () => calendarAccess,
    callGmail: async () => freeBusyOverride || { calendars: { primary: { busy } } }
  };
  require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: stub };
  const calendar = require(calPath);
  delete require.cache[calPath];
  delete require.cache[gmailPath];
  return calendar;
}

// Slots come back as UTC instants; assert on what a New York reader would see.
const ny = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(new Date(iso));
const hourOf = iso => Number(ny(iso, { hour: 'numeric', hour12: false }).replace(/\D/g, ''));
const dayKey = iso => ny(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });

test('suggests three business days, three per morning and three per afternoon', async () => {
  const calendar = loadCalendarWith();
  const slots = await calendar.getAvailableSlots();
  const suggested = slots.filter(s => s.suggested);

  const days = [...new Set(suggested.map(s => dayKey(s.startISO)))];
  assert.strictEqual(days.length, 3, 'exactly three distinct days');

  for (const day of days) {
    const onDay = suggested.filter(s => dayKey(s.startISO) === day);
    assert.strictEqual(onDay.filter(s => s.period === 'morning').length, 3, `${day}: three morning suggestions`);
    assert.strictEqual(onDay.filter(s => s.period === 'afternoon').length, 3, `${day}: three afternoon suggestions`);
  }
  assert.strictEqual(suggested.length, 18, 'three days x two blocks x three suggestions');
});

// The SA must be able to offer a time the spread happened not to pick, without closing and
// reopening the flow (which is what it used to take).
test('every free slot is returned, not just the suggested ones', async () => {
  const slots = await loadCalendarWith().getAvailableSlots();
  const unsuggested = slots.filter(s => !s.suggested);
  assert.ok(unsuggested.length > 0, 'the full list must include alternatives to the suggestions');
  // A wide-open day has 6 morning + 6 afternoon candidates, of which 3 + 3 are suggested.
  // Midday contributes nothing here because neither block is short.
  assert.strictEqual(slots.length, 36, 'three days x two blocks x six half-hours');
  for (const s of slots) assert.strictEqual(typeof s.suggested, 'boolean', 'every slot is flagged');
});

test('every slot is inside business hours and on the right side of noon', async () => {
  const calendar = loadCalendarWith();
  for (const s of await calendar.getAvailableSlots()) {
    const h = hourOf(s.startISO);
    assert.ok(h >= 9 && h < 17, `slot at ${h}:00 is outside 9-17`);
    if (s.period === 'morning') assert.ok(h >= 9 && h < 12, `morning slot at ${h}:00 should be 9-12`);
    else assert.ok(h >= 14, `afternoon slot at ${h}:00 should be 2pm or later`);
  }
});

// Midday (12:00-14:00) is held back as a fallback: offered only to top up a block that
// cannot field three openings on its own, and always on its own side of the 13:00 line.
test('midday is NOT offered when both blocks have enough of their own', async () => {
  for (const s of await loadCalendarWith().getAvailableSlots()) {
    const h = hourOf(s.startISO);
    assert.ok(h < 12 || h >= 14, `${s.label} used the midday fallback on a wide-open day`);
  }
});

test('a thin morning borrows forward to 1pm, never past it', async () => {
  // Block 9:00-11:00, leaving only 11:00 and 11:30 free before noon: a shortfall of one.
  const open = await loadCalendarWith().getAvailableSlots();
  const day = open.find(s => s.period === 'morning');
  const at = (h, m) => {
    const d = new Date(day.startISO);
    const shift = (h - hourOf(day.startISO)) * 3600000 + m * 60000;
    return new Date(d.getTime() + shift).toISOString();
  };
  const slots = await loadCalendarWith({ busy: [{ start: at(9, 0), end: at(11, 0) }] }).getAvailableSlots();
  const morning = slots.filter(s => s.period === 'morning' && dayKey(s.startISO) === dayKey(day.startISO));
  const suggested = morning.filter(s => s.suggested);

  assert.strictEqual(suggested.length, 3, 'the shortfall is made up to three');
  const hours = suggested.map(s => hourOf(s.startISO));
  assert.ok(hours.some(h => h === 12), `expected a midday top-up, got ${hours.join(',')}`);
  assert.ok(hours.every(h => h < 13), `morning must never reach past 1pm, got ${hours.join(',')}`);
});

test('a thin afternoon borrows back to 1pm, never before it', async () => {
  const open = await loadCalendarWith().getAvailableSlots();
  const day = open.find(s => s.period === 'afternoon');
  const at = (h, m) => {
    const d = new Date(day.startISO);
    const shift = (h - hourOf(day.startISO)) * 3600000 + m * 60000;
    return new Date(d.getTime() + shift).toISOString();
  };
  // Block 14:00-16:00, leaving only 16:00 and 16:30: a shortfall of one.
  const slots = await loadCalendarWith({ busy: [{ start: at(14, 0), end: at(16, 0) }] }).getAvailableSlots();
  const afternoon = slots.filter(s => s.period === 'afternoon' && dayKey(s.startISO) === dayKey(day.startISO));
  const suggested = afternoon.filter(s => s.suggested);

  assert.strictEqual(suggested.length, 3, 'the shortfall is made up to three');
  const hours = suggested.map(s => hourOf(s.startISO));
  assert.ok(hours.some(h => h === 13), `expected a 1pm top-up, got ${hours.join(',')}`);
  assert.ok(hours.every(h => h >= 13), `afternoon must never reach before 1pm, got ${hours.join(',')}`);
});

test('with BOTH blocks starved, each borrows only its own side of 1pm', async () => {
  const open = await loadCalendarWith().getAvailableSlots();
  const day = open.find(s => s.period === 'morning');
  const at = (h, m) => {
    const d = new Date(day.startISO);
    return new Date(d.getTime() + (h - hourOf(day.startISO)) * 3600000 + m * 60000).toISOString();
  };
  // Everything gone except the midday hours, so each block MUST fall back to survive.
  const slots = await loadCalendarWith({
    busy: [{ start: at(9, 0), end: at(12, 0) }, { start: at(14, 0), end: at(17, 0) }]
  }).getAvailableSlots();

  const sameDay = slots.filter(s => dayKey(s.startISO) === dayKey(day.startISO));
  const morning = sameDay.filter(s => s.period === 'morning');
  const afternoon = sameDay.filter(s => s.period === 'afternoon');

  // Proves the fallback actually fired, so the boundary assertions below mean something.
  assert.ok(morning.length > 0, 'a starved morning should still borrow midday');
  assert.ok(afternoon.length > 0, 'a starved afternoon should still borrow midday');

  for (const s of morning) {
    const h = hourOf(s.startISO);
    assert.ok(h >= 12 && h < 13, `starved morning borrowed ${h}:00, outside 12:00-13:00`);
  }
  for (const s of afternoon) {
    const h = hourOf(s.startISO);
    assert.ok(h >= 13 && h < 14, `starved afternoon borrowed ${h}:00, outside 13:00-14:00`);
  }
  // 12:00-13:00 is two half-hours, so a fully-starved block tops out at two, not three.
  assert.strictEqual(morning.length, 2);
  assert.strictEqual(afternoon.length, 2);
});

test('never offers a weekend', async () => {
  const calendar = loadCalendarWith();
  for (const s of await calendar.getAvailableSlots()) {
    const wd = ny(s.startISO, { weekday: 'short' });
    assert.ok(wd !== 'Sat' && wd !== 'Sun', `offered a ${wd}`);
  }
});

test('never offers a time in the past — the first day is always ahead of now', async () => {
  const calendar = loadCalendarWith();
  const now = Date.now();
  for (const s of await calendar.getAvailableSlots()) {
    assert.ok(new Date(s.startISO).getTime() > now, `${s.label} is not in the future`);
  }
});

test('options are spread across the block, not three consecutive half-hours', async () => {
  const calendar = loadCalendarWith();
  const slots = await calendar.getAvailableSlots();
  const firstDay = dayKey(slots[0].startISO);
  const morning = slots.filter(s => s.suggested && dayKey(s.startISO) === firstDay && s.period === 'morning');
  const starts = morning.map(s => new Date(s.startISO).getTime()).sort((a, b) => a - b);
  const span = (starts[starts.length - 1] - starts[0]) / 60000;
  // Three consecutive 30-minute slots span 60 minutes. A wide-open 9-12 block has six
  // candidates, so a real spread should cover well beyond that.
  assert.ok(span > 60, `morning options span only ${span} minutes — they are bunched`);
});

test('a busy interval removes every slot it touches, including partial overlaps', async () => {
  const open = await loadCalendarWith().getAvailableSlots();
  const target = open.find(s => s.suggested && s.period === 'morning');

  // A 15-minute meeting starting 5 minutes into the slot still makes it unofferable.
  const start = new Date(new Date(target.startISO).getTime() + 5 * 60000).toISOString();
  const end = new Date(new Date(target.startISO).getTime() + 20 * 60000).toISOString();
  const withBusy = await loadCalendarWith({ busy: [{ start, end }] }).getAvailableSlots();

  assert.ok(!withBusy.some(s => s.startISO === target.startISO), 'a partially-overlapped slot must not be offered');
});

test('a fully booked day still yields the other two days', async () => {
  const open = await loadCalendarWith().getAvailableSlots();
  const firstDay = dayKey(open[0].startISO);
  const anyOnFirst = open.find(s => dayKey(s.startISO) === firstDay);
  const dayStart = new Date(new Date(anyOnFirst.startISO));
  dayStart.setUTCHours(dayStart.getUTCHours() - 12); // comfortably before 9am ET
  const dayEnd = new Date(dayStart.getTime() + 36 * 3600000);

  const slots = await loadCalendarWith({
    busy: [{ start: dayStart.toISOString(), end: dayEnd.toISOString() }]
  }).getAvailableSlots();

  assert.ok(!slots.some(s => dayKey(s.startISO) === firstDay), 'the blocked day contributes nothing');
  assert.ok(slots.length > 0, 'the remaining days are still offered');
  assert.ok(new Set(slots.map(s => dayKey(s.startISO))).size >= 1);
});

test('a blocked morning is not padded from the afternoon', async () => {
  const open = await loadCalendarWith().getAvailableSlots();
  const firstDay = dayKey(open[0].startISO);
  const firstMorning = open.find(s => s.suggested && dayKey(s.startISO) === firstDay && s.period === 'morning');
  const mStart = new Date(new Date(firstMorning.startISO).getTime() - 60 * 60000);
  const mEnd = new Date(new Date(firstMorning.startISO).getTime() + 4 * 3600000); // through noon

  const slots = await loadCalendarWith({ busy: [{ start: mStart.toISOString(), end: mEnd.toISOString() }] }).getAvailableSlots();
  const sameDay = slots.filter(s => s.suggested && dayKey(s.startISO) === firstDay);
  assert.strictEqual(sameDay.filter(s => s.period === 'morning').length, 0, 'blocked morning offers nothing');
  assert.strictEqual(sameDay.filter(s => s.period === 'afternoon').length, 3, 'afternoon is unaffected, not inflated');
});

test('each slot carries a day label and a period for grouping in the picker', async () => {
  const calendar = loadCalendarWith();
  for (const s of await calendar.getAvailableSlots()) {
    assert.match(s.dayLabel, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/, `unexpected dayLabel: ${s.dayLabel}`);
    assert.ok(s.period === 'morning' || s.period === 'afternoon');
    assert.match(s.label, /ET$/, 'the full label is what goes into the email');
    assert.ok(s.startISO && s.endISO);
  }
});

test('slots are half an hour long', async () => {
  for (const s of await loadCalendarWith().getAvailableSlots()) {
    assert.strictEqual(new Date(s.endISO) - new Date(s.startISO), 30 * 60000);
  }
});

// ---- the fail-loudly contract ----
// An unreadable calendar must never look like an empty one: these times are offered to a
// client, so degrading to "everything is free" would have Marcos offering booked hours.

test('a per-calendar error inside a 200 throws rather than reading as free', async () => {
  const calendar = loadCalendarWith({ freeBusyOverride: { calendars: { primary: { errors: [{ reason: 'notFound' }], busy: [] } } } });
  await assert.rejects(() => calendar.getAvailableSlots(), /could not read the primary calendar/i);
});

test('a missing primary calendar throws', async () => {
  const calendar = loadCalendarWith({ freeBusyOverride: { calendars: {} } });
  await assert.rejects(() => calendar.getAvailableSlots(), /no free\/busy data/i);
});

test('an unparseable busy interval throws instead of being dropped', async () => {
  const calendar = loadCalendarWith({ busy: [{ start: 'not-a-date', end: 'also-not' }] });
  await assert.rejects(() => calendar.getAvailableSlots(), /unreadable busy interval/i);
});

test('no calendar grant is reported as not-connected, not as an empty calendar', async () => {
  const calendar = loadCalendarWith({ calendarAccess: false });
  await assert.rejects(() => calendar.getAvailableSlots(), e => e.notConnected === true);
});
