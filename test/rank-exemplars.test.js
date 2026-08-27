const test = require('node:test');
const assert = require('node:assert');
const { rankExemplars } = require('../server/emailEngine');

// Fixtures are built here rather than read from data/approved-emails, because that
// library is all seed records — seed decay could never fire against it at any threshold.
const rec = (over, when, seed) => ({
  services: over, saved_at: when, seed: !!seed, final_text: 'x', company_name: 'c', recipient: 'r'
});
const realFill = (n) => Array.from({ length: n }, (_, i) => rec([], '2026-01-0' + ((i % 9) + 1), false));

test('service overlap stays the primary signal', () => {
  const out = rankExemplars(
    [rec([], '2026-08-01'), rec(['Bid Protests'], '2020-01-01')],
    ['Bid Protests']
  );
  assert.strictEqual(out[0].services[0], 'Bid Protests');
});

test('recency breaks an overlap tie', () => {
  const out = rankExemplars(
    [rec(['A'], '2026-01-01'), rec(['A'], '2026-08-01')],
    ['A']
  );
  assert.strictEqual(out[0].saved_at, '2026-08-01');
});

test('seeds rank normally while the library is thin', () => {
  const out = rankExemplars([rec([], '2020-01-01', true), rec([], '2019-01-01', false)], []);
  assert.strictEqual(out[0].seed, true, 'newer seed should still win below the threshold');
});

test('seeds sort last once enough real exemplars exist', () => {
  const seedy = rec(['A'], '2026-08-01', true);   // best overlap AND newest
  const out = rankExemplars([seedy, ...realFill(12)], ['A']);
  assert.strictEqual(out[out.length - 1].seed, true, 'seed must fall to the end');
});

test('an empty library returns empty rather than throwing', () => {
  assert.deepStrictEqual(rankExemplars([], ['A']), []);
});

test('a record with no saved_at does not throw and sorts last among its ties', () => {
  const out = rankExemplars([rec(['A'], undefined), rec(['A'], '2026-08-01')], ['A']);
  assert.strictEqual(out[0].saved_at, '2026-08-01');
});

test('the input array is not mutated', () => {
  const input = [rec(['A'], '2020-01-01'), rec(['B'], '2026-01-01')];
  const copy = input.slice();
  rankExemplars(input, ['B']);
  assert.deepStrictEqual(input, copy);
});
