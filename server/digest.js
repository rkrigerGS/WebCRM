// digest.js — compiles the Monday-morning digest email's content from the audit log and
// the prospect database only. No Claude calls, no AI summarization — every number here is
// either a direct count or a straightforward derivation, so a mistake is traceable back to
// real data rather than a model's phrasing. See server.js for the scheduler and manual
// "send now" endpoint that call buildDigest() and hand its output to gmail.js.

// Actions that mean an email actually left the building. 'prospect.email.send.orphaned'
// belongs here: the Gmail send succeeded and only the record write was lost, because the
// prospect was deleted mid-send. 'prospect.email.send.failed' is deliberately NOT here —
// nothing was sent in that case.
const SENT_ACTIONS = new Set(['prospect.email.send', 'prospect.reply.send', 'prospect.email.send.orphaned']);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function parseActivity(p) { try { return JSON.parse(p.activity || '[]'); } catch { return []; } }
function parseStatusFromDetail(detail) { try { return JSON.parse(detail || '{}').status; } catch { return undefined; } }

// New York wall-clock parts for a given instant — used by server.js's scheduler (Monday
// 6am *local* time, not a fixed UTC-5 offset that would drift an hour during daylight
// saving) via Node's built-in Intl support, no new dependency.
function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { weekday: get('weekday'), hour: parseInt(get('hour'), 10), year: get('year'), month: get('month'), day: get('day') };
}
function nyWeekKey(date) { const p = nyParts(date); return `${p.year}-${p.month}-${p.day}`; }

function section(title, lines) {
  return `${title}\n${'-'.repeat(title.length)}\n${lines.length ? lines.join('\n') : '(no data)'}`;
}

// prospects: db.listProspects(); auditEntries: audit.list({}) (everything, unfiltered —
// stats sections filter to the last 7 days themselves; records are all-time).
function buildDigest({ prospects, auditEntries, now }) {
  now = now || new Date();
  const weekStartISO = new Date(now.getTime() - WEEK_MS).toISOString();
  const thisWeek = e => e.at >= weekStartISO;
  const byId = new Map(prospects.map(p => [p.id, p]));

  // ---- Pipeline stats (this week) ----
  const statusCounts = {};
  for (const p of prospects) statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;

  const createdThisWeek = auditEntries.filter(e => thisWeek(e) && (e.action === 'prospect.upload' || e.action === 'prospect.ingest')).length;
  const emailsSentThisWeek = auditEntries.filter(e => thisWeek(e) && SENT_ACTIONS.has(e.action)).length;
  const repliesReceivedThisWeek = auditEntries.filter(e => thisWeek(e) && e.action === 'prospect.reply.detected').length;
  const signedThisWeek = auditEntries.filter(e => thisWeek(e) && e.action === 'prospect.update' && parseStatusFromDetail(e.detail) === 'signed').length;
  const dormantSetThisWeek = auditEntries.filter(e => thisWeek(e) && e.action === 'prospect.dormant.set').length;
  const dormantReturnedThisWeek = auditEntries.filter(e => thisWeek(e) && e.action === 'prospect.dormant.return').length;

  const in7ISO = new Date(now.getTime() + WEEK_MS).toISOString().slice(0, 10);
  const followupsDueThisWeek = prospects.filter(p => {
    if (p.status !== 'sent' || !p.date_sent) return false;
    const dueDate = new Date(new Date(p.date_sent).getTime() + (p.followup_days || 4) * DAY_MS).toISOString().slice(0, 10);
    return dueDate <= in7ISO; // includes anything already overdue, not just newly-due
  }).length;

  const pipelineLines = [
    `Total prospects: ${prospects.length}`,
    ...Object.entries(statusCounts).sort().map(([s, n]) => `  ${s}: ${n}`),
    `New prospects added this week: ${createdThisWeek}`,
    `Emails sent this week: ${emailsSentThisWeek}`,
    `Replies received this week: ${repliesReceivedThisWeek}`,
    `Moved to signed this week: ${signedThisWeek}`,
    `Moved to dormant this week: ${dormantSetThisWeek}`,
    `Returned from dormant this week: ${dormantReturnedThisWeek}`,
    `Follow-ups due in the coming week: ${followupsDueThisWeek}`
  ];

  // ---- Per-user activity (this week) ----
  const perUser = {};
  function bump(username, key) {
    perUser[username] = perUser[username] || { emails_sent: 0, notes_added: 0, prospects_uploaded: 0, replies_handled: 0 };
    perUser[username][key]++;
  }
  for (const e of auditEntries) {
    if (!thisWeek(e)) continue;
    if (SENT_ACTIONS.has(e.action)) bump(e.username, 'emails_sent');
    if (e.action === 'prospect.reply.send') bump(e.username, 'replies_handled');
    if (e.action === 'prospect.note.add') bump(e.username, 'notes_added');
    if (e.action === 'prospect.upload') bump(e.username, 'prospects_uploaded');
  }
  const userLines = Object.entries(perUser).map(([username, s]) =>
    `${username}: ${s.emails_sent} emails sent, ${s.notes_added} notes added, ${s.prospects_uploaded} prospects uploaded, ${s.replies_handled} replies handled`
  );

  // ---- Records (all-time, from the full audit history) ----
  let fastestSigned = null;
  for (const e of auditEntries) {
    if (e.action !== 'prospect.update' || parseStatusFromDetail(e.detail) !== 'signed') continue;
    const p = byId.get(e.prospectId);
    if (!p || !p.created_at) continue;
    const days = (new Date(e.at) - new Date(p.created_at)) / DAY_MS;
    if (days < 0) continue;
    if (!fastestSigned || days < fastestSigned.days) fastestSigned = { company: p.company_name, days };
  }

  let longestDormant = null;
  const dormantSets = auditEntries.filter(e => e.action === 'prospect.dormant.set');
  for (const e of auditEntries) {
    if (e.action !== 'prospect.dormant.return') continue;
    const setEntry = dormantSets.filter(s => s.prospectId === e.prospectId && s.at < e.at).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!setEntry) continue;
    const days = (new Date(e.at) - new Date(setEntry.at)) / DAY_MS;
    const p = byId.get(e.prospectId);
    if (!longestDormant || days > longestDormant.days) longestDormant = { company: p ? p.company_name : `prospect #${e.prospectId}`, days };
  }

  let mostActiveUser = null;
  for (const [username, s] of Object.entries(perUser)) {
    const total = s.emails_sent + s.notes_added + s.prospects_uploaded + s.replies_handled;
    if (!mostActiveUser || total > mostActiveUser.total) mostActiveUser = { username, total };
  }

  const repliedCandidates = prospects.filter(p => p.last_reply_at || p.status === 'replied' || p.status === 'signed');
  let mostFollowups = null;
  for (const p of repliedCandidates) {
    if (!mostFollowups || (p.followup_count || 0) > mostFollowups.count) mostFollowups = { company: p.company_name, count: p.followup_count || 0 };
  }

  const uncontacted = prospects.filter(p => p.status === 'new' && p.created_at).sort((a, b) => a.created_at.localeCompare(b.created_at))[0] || null;

  let mostNotes = null;
  for (const p of prospects) {
    const n = parseActivity(p).length;
    if (!mostNotes || n > mostNotes.count) mostNotes = { company: p.company_name, count: n };
  }

  const recordLines = [
    fastestSigned ? `Fastest new-to-signed: ${fastestSigned.company}, ${fastestSigned.days.toFixed(1)} days` : 'Fastest new-to-signed: no prospect has been marked signed yet.',
    longestDormant ? `Longest dormant-to-return: ${longestDormant.company}, ${longestDormant.days.toFixed(1)} days` : 'Longest dormant-to-return: no dormant prospect has returned yet.',
    mostActiveUser ? `Most active user this week: ${mostActiveUser.username} (${mostActiveUser.total} logged actions)` : 'Most active user this week: no activity logged this week.',
    mostFollowups && mostFollowups.count > 0 ? `Most follow-ups before a reply: ${mostFollowups.company}, ${mostFollowups.count} follow-up(s)` : 'Most follow-ups before a reply: no data yet.',
    uncontacted ? `Oldest prospect still not contacted: ${uncontacted.company_name} (added ${uncontacted.created_at.slice(0, 10)})` : 'Oldest prospect still not contacted: none — everything has been contacted.',
    mostNotes && mostNotes.count > 0 ? `Most activity-log entries on one prospect: ${mostNotes.company} (${mostNotes.count} entries)` : 'Most activity-log entries on one prospect: no data yet.'
  ];

  const rangeLabel = `${weekStartISO.slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
  const bodyText = [
    `GovSpring Prospecting — Weekly Digest (${rangeLabel})`,
    '',
    'Auto-compiled by GovSpring CRM, straight from the database and audit log. No AI summarization was used to write this email.',
    '',
    section('PIPELINE STATS', pipelineLines),
    '',
    section('USER ACTIVITY THIS WEEK', userLines),
    '',
    section('RECORDS AND NOTABLE PATTERNS (all-time, auto-compiled — not written by any team member)', recordLines),
    ''
  ].join('\n');

  return { subject: `GovSpring Prospecting — Weekly Digest — ${rangeLabel}`, bodyText };
}

module.exports = { buildDigest, nyParts, nyWeekKey };
