// emailEngine.js
// The drafting brain. Two jobs:
//   1. From a prospect's dossier, produce the guided-flow questions (which issue, which
//      services, optional personal note) with options drawn from that prospect's own
//      research and the service catalog.
//   2. Given the SA's answers, assemble a prompt and call the Claude API to produce a
//      draft in Marcos's voice, learned from the approved-email library.
//
// The API is called with plain https so the app has no heavy SDK dependency.

const https = require('https');
const config = require('./config');
const catalogs = require('./catalogs');

// ---- Step 1: build the guided questions for a prospect ----

function buildQuestions(dossier) {
  const issues = Array.isArray(dossier.issue_spotting) ? dossier.issue_spotting : [];

  // Question 1: which issue to lead with. Options are this prospect's actual issues,
  // plus a fallback for when the SA wants a general congratulatory opener.
  const issueOptions = issues.map((i, idx) => ({
    id: `issue_${idx}`,
    label: i.title,
    detail: i.explanation
  }));
  issueOptions.push({ id: 'general', label: 'General introduction (no specific issue)', detail: 'Warm, congratulatory opener tied to their contract without leading on a single legal issue.' });

  // Question 2: which services to pitch. Parse service names from the catalog; pre-mark
  // the ones whose "when it fits" hints match this prospect's issue titles/designations.
  const services = parseServiceNames(catalogs.readServices());
  const haystack = (
    issues.map(i => i.title + ' ' + i.explanation).join(' ') + ' ' +
    (dossier.designations || '') + ' ' + (dossier.industry || '')
  ).toLowerCase();

  const serviceOptions = services.map(s => ({
    id: s.name,
    label: s.name,
    proven: s.proven,
    suggested: s.fitHints.some(h => haystack.includes(h))
  }));

  // Question 3 (optional): personal notes. All catalog hooks that plausibly fit this prospect.
  const personalHooks = detectPersonalHooks(dossier);

  return {
    company: dossier.company_name,
    issueOptions,
    serviceOptions,
    personalHooks  // array of { id, label, suggestion }, possibly empty
  };
}

// Pull service names and their fit-hints out of the services catalog markdown.
function parseServiceNames(md) {
  const out = [];
  const blocks = md.split(/\n##\s+/).slice(1); // each service is a ## heading
  for (const b of blocks) {
    const name = b.split('\n')[0].replace(/\s*\[.*?\]\s*/g, '').trim();
    if (!name || /^overall framing/i.test(name)) continue;
    const proven = /\[PROVEN/i.test(b.split('\n')[0]) || /\bPROVEN\b/.test(b.slice(0, 200));
    // fit hints: keywords from the WHEN IT FITS line, lowercased single words worth matching
    const fitLine = (b.match(/WHEN IT FITS:(.*?)(?:\n\n|HOW IT IS PITCHED)/is) || [])[1] || '';
    const fitHints = extractHints(fitLine + ' ' + name);
    out.push({ name, proven, fitHints });
  }
  return out;
}

function extractHints(text) {
  // Multi-word, specific phrases only. Single generic words like "water" or "performance"
  // over-match (they appear in unrelated dossiers), so we use distinctive terms that
  // reliably indicate the service actually fits.
  const phrases = ['sba','8(a)','8a program','set-aside','affiliation','size protest',
    'bid protest','joint venture','limitations on subcontracting','differing site',
    'equitable adjustment','certified payroll','davis-bacon','prevailing wage',
    'conflict of interest','organizational conflict','data rights','privacy act',
    'code of conduct','fractional','sole-source','anc-sponsored','tribe','construction',
    'levee','water and sewer','subsurface'];
  const t = text.toLowerCase();
  return phrases.filter(w => t.includes(w));
}

// Look for personal-connection hooks that plausibly fit this prospect. Returns an array
// (possibly empty) so the SA can pick any that fit. Keyword-based for now; the fuller
// version can let the model judge relevance against the catalog directly.
function detectPersonalHooks(dossier) {
  const loc  = (dossier.city_state || '').toLowerCase();
  const work = ((dossier.current_contract && dossier.current_contract.work_details) || '').toLowerCase();
  const industry = (dossier.industry || '').toLowerCase();
  const blob = (loc + ' ' + work + ' ' + industry + ' ' + (dossier.designations || '')).toLowerCase();
  const hooks = [];

  if (loc.includes('atlanta') || /,\s*ga\b/.test(loc))
    hooks.push({ id: 'atlanta', label: 'Shared Atlanta tie', suggestion: 'Marcos earned his MA at Georgia State in Atlanta; a light shared-Atlanta note may fit.' });
  if (loc.includes('kansas city') || /,\s*(ks|mo)\b/.test(loc))
    hooks.push({ id: 'kc', label: 'Shared Kansas City tie', suggestion: 'Marcos did his undergrad at Rockhurst in Kansas City; a shared-KC note may fit.' });
  if (loc.includes('washington') || loc.includes('baltimore') || /,\s*(dc|md)\b/.test(loc))
    hooks.push({ id: 'dc', label: 'Shared DC/Baltimore area', suggestion: 'Marcos is based in the DC-Baltimore area; a local note may fit.' });
  if (/(water|sewer|fish|river|lake|pond|marine|coastal|levee|dam|wetland|environmental)/.test(blob))
    hooks.push({ id: 'outdoors', label: 'Outdoors/water angle', suggestion: "Their work touches water or the outdoors; Marcos's folksy outdoors humor (e.g. the bluegill line) may fit." });
  if (/(construction|infrastructure|building|civil works|rehabilitation)/.test(blob))
    hooks.push({ id: 'construction', label: 'Construction background', suggestion: 'Marcos has deep construction-contracts experience; a note connecting to their build work may fit.' });
  if (/(software|\bai\b|artificial intelligence|\bdata\b|information technology|cyber|cloud)/.test(blob))
    hooks.push({ id: 'tech', label: 'Tech-forward angle', suggestion: 'Marcos writes on AI in legal practice; a light tech-forward note may resonate.' });
  if (/(manufactur|domestic|sourcing|supply chain|buy american|food|product)/.test(blob))
    hooks.push({ id: 'sourcing', label: 'Domestic sourcing expertise', suggestion: 'Marcos trains contractors on Buy American Act and domestic sourcing; a note may fit if relevant.' });

  return hooks;
}

// ---- Step 2: assemble the prompt and call the API ----

function buildDraftPrompt({ dossier, chosenIssue, chosenServices, personalNote, isFollowup, priorEmailText }) {
  const firm = catalogs.readFirmFacts();
  const servicesCatalog = catalogs.readServices();
  const approved = catalogs.listApprovedEmails();

  // Use up to 6 approved emails as style exemplars, preferring ones sharing a chosen service.
  const ranked = rankExemplars(approved, chosenServices);
  const exemplars = ranked.slice(0, 6)
    .map((e, i) => `EXAMPLE ${i + 1} (to ${e.recipient} at ${e.company_name}):\n${e.final_text}`)
    .join('\n\n---\n\n');

  const cfg = config.get();

  const system = `You are drafting a cold outreach email for Marcos Gonzalez, Managing Attorney at GovSpring Legal, a boutique government-contracts law firm. You write in his exact voice, learned from the real approved examples below.

NON-NEGOTIABLE STYLE RULES:
- Length 150 to 240 words. These are short emails.
- Warm, congratulatory, never pushy or alarmist. Open by recognizing something specific and real about the prospect's actual work or contract.
- Bridge naturally from that specific fact to the chosen legal service(s), using the firm's real vocabulary.
- NO em dashes anywhere. NO en dashes except in numeric ranges. Use periods, commas, or semicolons.
- Always include the free-consultation offer and the scheduling/availability block, taken verbatim from the boilerplate.
- Always end with the CC line and the signature block, verbatim from the boilerplate.
- Frame legal help as keeping regulations from slowing operations down, protecting margin and schedule. Not crisis response.
- Only state facts about the prospect that appear in the dossier provided. Never invent a contract, an award, a name, or a detail.
- Only state facts about the firm/Marcos that are marked CONFIRMED in the firm facts, or that appear in the boilerplate. Do not assert LIKELY or UNVERIFIED facts as established.

FIRM AND PEOPLE FACTS (including verbatim boilerplate to reuse):
${firm}

SERVICE CATALOG (for how each service is pitched):
${servicesCatalog}

APPROVED EXAMPLES (match this voice, structure, and length; do not copy their specific facts):
${exemplars}`;

  const issueText = chosenIssue && chosenIssue.title
    ? `Lead the email around this issue: "${chosenIssue.title}". Context: ${chosenIssue.explanation}`
    : `Do not lead on a single legal issue. Use a warm, congratulatory general introduction tied to their contract.`;

  const personalText = personalNote
    ? `Include a brief, natural personal touch: ${personalNote}. Keep it light and genuine, one sentence at most.`
    : `Do not add a personal anecdote.`;

  const followupText = isFollowup
    ? `This is a FOLLOW-UP to a prior email that received no reply. Keep it short (under 120 words), reference that you reached out previously without being pushy, add light new value or a gentle nudge, and keep the same scheduling block and signature. Prior email was:\n\n${priorEmailText || '(not available)'}`
    : '';

  const user = `Draft the outreach email now.

PROSPECT DOSSIER:
Company: ${dossier.company_name}
Location: ${dossier.city_state || ''}
Industry: ${dossier.industry || ''}
Designations: ${dossier.designations || ''}
Current contract: ${JSON.stringify(dossier.current_contract || {}, null, 2)}
Prior contracts: ${dossier.prior_contracts || ''}
Sales notes: ${dossier.sales_notes || ''}
All spotted issues: ${JSON.stringify((dossier.issue_spotting||[]).map(i=>i.title))}

${issueText}

Services to pitch (1 to 2): ${chosenServices.join('; ') || '(choose the most fitting from the catalog)'}

${personalText}

${followupText}

Write only the email body, starting with the greeting. Use the recipient's first name if a decision-maker is known in the dossier contacts; otherwise use a reasonable greeting. Do not include a subject line unless asked.`;

  return { system, user, model: cfg.draftModel };
}

function rankExemplars(approved, chosenServices) {
  const chosen = new Set((chosenServices || []).map(s => s.toLowerCase()));
  return [...approved].sort((a, b) => score(b) - score(a));
  function score(e) {
    const svcs = (e.services || []).map(s => s.toLowerCase());
    return svcs.filter(s => chosen.has(s)).length;
  }
}

// The actual API call. Returns { text, usage } or throws with a readable message.
function callClaude({ system, user, model }) {
  const cfg = config.get();
  const apiKey = cfg.anthropicApiKey;
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return Promise.reject(new Error('NO_API_KEY'));
  }

  const payload = JSON.stringify({
    model,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: user }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode !== 200) {
            const msg = (json.error && json.error.message) || `HTTP ${res.statusCode}`;
            return reject(new Error(msg));
          }
          const text = (json.content || [])
            .filter(b => b.type === 'text').map(b => b.text).join('').trim();
          resolve({ text, usage: json.usage || {} });
        } catch (e) {
          reject(new Error('Bad response from API: ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

async function generateDraft(params) {
  const prompt = buildDraftPrompt(params);
  const { text, usage } = await callClaude(prompt);
  return { draft: text, usage };
}

module.exports = { buildQuestions, generateDraft, buildDraftPrompt, callClaude };
