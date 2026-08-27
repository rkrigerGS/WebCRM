// linkedinEngine.js — drafting for the LinkedIn channel.
//
// Deliberately smaller than emailEngine: no subject generation, no reply drafting, no
// booking slots. It reuses callClaude and rankExemplars from emailEngine rather than
// copying them, so a change to ranking reaches both channels at once.
//
// Recipient and destination are independent. The recipient is always a named person from
// the dossier's contacts; the destination is wherever the SA can actually reach them,
// which may be that person's profile or, when they have none, the company page. 156 of
// 257 contacts have no personal URL, so the fallback is the common case, not the edge.

const config = require('./config');
const catalogs = require('./catalogs');
const emailEngine = require('./emailEngine');

// Absolute http(s) URLs only. Parsing with no base is the point: renderer.js's safeUrl
// resolves against window.location.origin, so a bare slug there would become a link back
// into the CRM and still pass a protocol check. Here a bare slug throws and is rejected.
function isAbsoluteHttpUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function resolveDestination(contact, contactGeneral) {
  const person = (contact && contact.linkedin) || '';
  if (isAbsoluteHttpUrl(person)) return { url: String(person).trim(), kind: 'person' };
  const company = (contactGeneral && contactGeneral.linkedin) || '';
  if (isAbsoluteHttpUrl(company)) return { url: String(company).trim(), kind: 'company' };
  return { url: '', kind: 'none' };
}

function buildDraftPrompt({ dossier, contact, chosenIssue, chosenServices, personalNote }) {
  const firm = catalogs.readFirmFacts();
  const servicesCatalog = catalogs.readServices();
  const approved = catalogs.listApprovedLinkedIn();

  const ranked = emailEngine.rankExemplars(approved, chosenServices);
  const exemplars = ranked.slice(0, 6)
    .map((e, i) => `EXAMPLE ${i + 1} (to ${e.recipient_name} at ${e.company_name}):\n${e.final_text}`)
    .join('\n\n---\n\n');

  const cfg = config.get();

  const system = `You are drafting a LinkedIn message for Marcos Gonzalez, Managing Attorney at GovSpring Legal, a boutique government-contracts law firm. You write in his exact voice, learned from the real approved examples below.

NON-NEGOTIABLE STYLE RULES:
- This is LinkedIn, not email. Length 60 to 120 words. Shorter is better.
- No subject line. No formal salutation block. No signature block. No CC line.
- Open on the person, not the company: something specific and real about their role or their firm's actual work.
- Bridge naturally to the chosen legal service(s) in one or two sentences, using the firm's real vocabulary.
- NO em dashes anywhere. NO en dashes except in numeric ranges. Use periods, commas, or semicolons.
- Close with a light, low-friction offer to talk. No scheduling links, no phone numbers, no calendar times: those belong in email.
- Warm and direct. Never pushy, never alarmist, never salesy.
- Only state facts about the prospect that appear in the dossier provided. Never invent a contract, an award, a name, or a detail.
- Only state facts about the firm or Marcos that are marked CONFIRMED in the firm facts. Do not assert LIKELY or UNVERIFIED facts as established.

FIRM AND PEOPLE FACTS:
${firm}

SERVICE CATALOG (for how each service is pitched):
${servicesCatalog}

APPROVED EXAMPLES (match this voice, structure, and length; do not copy their specific facts):
${exemplars}`;

  const issueText = chosenIssue && chosenIssue.title
    ? `Lead around this issue: "${chosenIssue.title}". Context: ${chosenIssue.explanation}`
    : `Do not lead on a single legal issue. Open warmly on their work generally.`;

  const personalText = personalNote
    ? `Include a brief, natural personal touch: ${personalNote}. One short clause at most.`
    : `Do not add a personal anecdote.`;

  const user = `Draft the LinkedIn message now.

RECIPIENT:
Name: ${contact.name || '(name not found)'}
Title: ${contact.title || ''}
Role: ${contact.role || ''}

PROSPECT DOSSIER:
Company: ${dossier.company_name}
Location: ${dossier.city_state || ''}
Industry: ${dossier.industry || ''}
Designations: ${dossier.designations || ''}
Current contract: ${JSON.stringify(dossier.current_contract || {}, null, 2)}
Sales notes: ${dossier.sales_notes || ''}
All spotted issues: ${JSON.stringify((dossier.issue_spotting || []).map(i => i.title))}

${issueText}

Services to mention (1 to 2): ${(chosenServices || []).join('; ') || '(choose the most fitting from the catalog)'}

${personalText}

Write only the message body, addressed to ${contact.name || 'them'} by first name. Do not write a greeting line on its own; open directly.`;

  return { system, user, model: cfg.draftModel };
}

async function generateDraft(params) {
  const prompt = buildDraftPrompt(params);
  const { text, usage } = await emailEngine.callClaude(prompt);
  return { draft: text, usage };
}

module.exports = { resolveDestination, buildDraftPrompt, generateDraft };
