const test = require('node:test');
const assert = require('node:assert');
const { resolveDestination } = require('../server/linkedinEngine');

const person = u => ({ name: 'C', title: 'GC', role: 'GC', linkedin: u });
const company = u => ({ linkedin: u });
const PERSON = 'https://www.linkedin.com/in/charles-carey-409546350/';
const COMPANY = 'https://www.linkedin.com/company/nava-pbc';

test('a person URL wins over the company page', () => {
  const d = resolveDestination(person(PERSON), company(COMPANY));
  assert.deepStrictEqual(d, { url: PERSON, kind: 'person' });
});

test('the company page is the fallback when the person has none', () => {
  const d = resolveDestination(person(''), company(COMPANY));
  assert.strictEqual(d.kind, 'company');
});

test('both empty yields copy-only, not a broken link', () => {
  assert.deepStrictEqual(resolveDestination(person(''), company('')),
    { url: '', kind: 'none' });
});

test('absent contacts and absent contact_general do not throw', () => {
  assert.strictEqual(resolveDestination(undefined, undefined).kind, 'none');
  assert.strictEqual(resolveDestination(null, {}).kind, 'none');
});

// The three variance cases the data contract documents.
test('a URL with no trailing slash is usable', () => {
  assert.strictEqual(resolveDestination(person('https://www.linkedin.com/in/jim-filla-a080a77'), {}).kind, 'person');
});

test('an http:// URL is usable', () => {
  assert.strictEqual(resolveDestination(person('http://www.linkedin.com/in/someone'), {}).kind, 'person');
});

test('a country subdomain is usable', () => {
  assert.strictEqual(resolveDestination(person('https://jm.linkedin.com/in/someone'), {}).kind, 'person');
});

// The trap: renderer.js's safeUrl resolves against window.location.origin, so a bare
// slug would silently become a link back into the CRM and pass its protocol check. The
// contract guarantees absolute URLs; this pins the guarantee so a regression at source
// surfaces as a failure rather than a link to nowhere.
test('a bare slug is rejected rather than resolved against our own origin', () => {
  assert.strictEqual(resolveDestination(person('charles-carey'), {}).kind, 'none');
  assert.strictEqual(resolveDestination(person('/in/charles-carey'), {}).kind, 'none');
});

test('whitespace-only is absence', () => {
  assert.strictEqual(resolveDestination(person('   '), company('  ')).kind, 'none');
});

test('a non-http scheme is rejected', () => {
  assert.strictEqual(resolveDestination(person('javascript:alert(1)'), {}).kind, 'none');
});
