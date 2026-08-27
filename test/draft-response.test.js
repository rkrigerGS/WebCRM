const test = require('node:test');
const assert = require('node:assert');
const { parseDraftResponse } = require('../server/emailEngine');

const BODY = 'Dear Gary,\n\nCongratulations on the Fort Bliss award.\n\nMarcos';
const withSubjects = (subs) => `${BODY}\n\n<<<SUBJECTS\n${subs.join('\n')}\nSUBJECTS>>>`;

test('body and five subjects are split out of one response', () => {
  const r = parseDraftResponse(withSubjects([
    'Your Fort Bliss award and timing',
    'A note on your Huntsville facility work',
    'Your IDIQ ceiling and what comes next',
    'The recompete timeline and your options',
    'Your SDVOSB status and the award'
  ]));
  assert.strictEqual(r.body, BODY);
  assert.strictEqual(r.subjects.length, 5);
  assert.ok(!r.body.includes('SUBJECTS'), 'the fence must not leak into the body');
});

test('subjects still pass through the deliverability filter', () => {
  const r = parseDraftResponse(withSubjects([
    'Free consultation, no obligation',      // spam vocabulary -> dropped
    'Your Fort Bliss award and timing',
    'Save 50% on your next protest',         // percentage claim -> dropped
    'A note on your Huntsville facility work'
  ]));
  assert.deepStrictEqual(r.subjects, [
    'Your Fort Bliss award and timing',
    'A note on your Huntsville facility work'
  ]);
});

test('a response with no fence still yields the body', () => {
  // The model not complying must degrade to "no suggestions", never to a lost draft.
  const r = parseDraftResponse(BODY);
  assert.strictEqual(r.body, BODY);
  assert.deepStrictEqual(r.subjects, []);
});

test('an unclosed fence still yields the body and any usable subjects', () => {
  const r = parseDraftResponse(`${BODY}\n\n<<<SUBJECTS\nYour Fort Bliss award and timing`);
  assert.strictEqual(r.body, BODY);
  assert.deepStrictEqual(r.subjects, ['Your Fort Bliss award and timing']);
});

test('empty input does not throw', () => {
  const r = parseDraftResponse('');
  assert.strictEqual(r.body, '');
  assert.deepStrictEqual(r.subjects, []);
});

test('at most five subjects survive even if the model returns more', () => {
  const r = parseDraftResponse(withSubjects([
    'Your Fort Bliss award and timing', 'A note on your Huntsville work',
    'Your IDIQ ceiling and next steps', 'The recompete and your options',
    'Your SDVOSB status and the award', 'A sixth option that should be cut'
  ]));
  assert.strictEqual(r.subjects.length, 5);
});
