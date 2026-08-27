const test = require('node:test');
const assert = require('node:assert');
const { isSpammySubject, parseSubjectResponse } = require('../server/emailEngine');

// These fixtures are SYNTHETIC but structurally identical to subject lines Marcos has
// actually approved and sent: same lengths, same acronym shapes, same punctuation. Real
// ones are not committed — they carry live prospect names, and this repository keeps
// client data out of git (see .gitignore excluding data/).
//
// Measured against 14 real approved lines before this change, the filter rejected 2 —
// a 14% false-positive rate against the firm's own sent mail. Both causes are pinned below.

test('a government-contract vehicle acronym is not shouting', () => {
  // The real failure: a hyphenated vehicle name (shape of "G-CACS") tripped the all-caps
  // check, which claimed in its own comment to exempt acronyms the firm uses.
  assert.strictEqual(isSpammySubject('Northwind: X-BAND III & JV transition'), false);
});

test('common govcon acronyms survive the filter', () => {
  // The prompt tells the model to ground subjects in the prospect's contract and
  // designations, and the user message supplies exactly these terms — so the filter was
  // rejecting the output its own prompt asked for.
  for (const s of [
    'Your IDIQ ceiling and next steps',
    'Your SDVOSB status and the recompete',
    'A note on your HUBZone certification',
    'Your NAICS code and the size standard',
    'Your GWAC options after the merger'
  ]) {
    assert.strictEqual(isSpammySubject(s), false, s);
  }
});

test('three-letter acronyms still pass, as they always did', () => {
  assert.strictEqual(isSpammySubject('Your GSA schedule renewal'), false);
  assert.strictEqual(isSpammySubject('A note on your SBA size status'), false);
  assert.strictEqual(isSpammySubject('Your 8(a) graduation and what follows'), false);
});

test('a 63-character subject is accepted', () => {
  // Marcos's longest real approved line is 63 characters. The cap was 60, so his own
  // sent mail failed the filter meant to protect it.
  const s = 'Government Contracts Counsel for Northwind - Firmname Legal Intro';
  assert.ok(s.length >= 63, 'fixture must exercise the old 60-char ceiling');
  assert.strictEqual(isSpammySubject(s), false, `${s.length} chars`);
});

// The filter still has to earn its keep. Loosening the acronym and length rules must not
// let through what it exists to stop.
test('genuinely spammy subjects are still rejected', () => {
  const spam = {
    'exclamation mark': 'Your award is ready!',
    'currency symbol': 'Save $40,000 on your next protest',
    'percentage claim': 'Cut your protest costs by 50% this quarter',
    'spam vocabulary': 'Free consultation, no obligation',
    'urgency word': 'Urgent: your contract needs review',
    'faked reply': 'Re: our conversation last week',
    'emoji': 'Your federal award 🎉 and next steps',
    'too short': 'Quick question',
    'too long': 'A quick note about your recent federal award and the work that lies ahead for you'
  };
  for (const [why, s] of Object.entries(spam)) {
    assert.strictEqual(isSpammySubject(s), true, `${why}: ${s}`);
  }
});

test('parseSubjectResponse keeps five grounded options rather than dropping them', () => {
  // The end-to-end symptom: a realistic five-line response for an SDVOSB holding an IDIQ
  // lost two options to the filter, and enough losses produce the UI's
  // "None of the suggestions passed the spam-safety checks" message.
  const modelOutput = [
    'Your SDVOSB status and the recompete',
    'Your IDIQ ceiling and what comes next',
    'The Fort Bliss award and your timeline',
    'Your 8(a) runway and subcontract terms',
    'A note on your Huntsville facility work'
  ].join('\n');
  assert.strictEqual(parseSubjectResponse(modelOutput).length, 5);
});

test('parseSubjectResponse still strips numbering and quotes, and dedupes', () => {
  const out = parseSubjectResponse([
    '1. "Your Fort Bliss award and timing"',
    '- Your Fort Bliss award and timing',
    '2) A note on your Huntsville work'
  ].join('\n'));
  assert.deepStrictEqual(out, [
    'Your Fort Bliss award and timing',
    'A note on your Huntsville work'
  ]);
});
