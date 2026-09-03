const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Item 2 of the 2026-09-02 hardening pass: every form control in index.html must have an
// accessible name. Pre-fix the file had 76 element ids and zero `for` attributes, so all
// 12 controls were unlabelled (6 relying on a placeholder, which is not an accessible
// name, and 6 selects with a visually adjacent <label> that was associated with nothing).
//
// This wires scripts/check-labels.mjs into the suite so a newly added unlabelled control
// fails the build rather than quietly shipping.

const REPO = path.join(__dirname, '..');

test('scripts/check-labels.mjs reports no unlabelled control in index.html', () => {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'check-labels.mjs')], { encoding: 'utf8' });
  } catch (e) {
    assert.fail(`check-labels failed:\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /every control has an accessible name/);
});

test('the checker is capable of failing (it is not a no-op)', () => {
  // Feed it a file with a deliberately unlabelled control and confirm a non-zero exit.
  // Without this, a checker that silently matched nothing would "pass" forever.
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gs-lbl-'));
  fs.mkdirSync(path.join(tmp, 'public'));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.writeFileSync(path.join(tmp, 'public', 'index.html'),
    '<html><body><input type="text" id="nope" placeholder="unnamed" /></body></html>');
  fs.copyFileSync(path.join(REPO, 'scripts', 'check-labels.mjs'), path.join(tmp, 'scripts', 'check-labels.mjs'));
  let failed = false, out = '';
  try {
    execFileSync(process.execPath, [path.join(tmp, 'scripts', 'check-labels.mjs')], { encoding: 'utf8' });
  } catch (e) {
    failed = true;
    out = String(e.stdout || '');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(failed, 'the checker must exit non-zero on an unlabelled control');
  assert.match(out, /not an accessible name/);
});

test('the toolbar labels point at the ids renderer.js actually selects', () => {
  // A `for` pointing at a renamed or typo'd id is a silent no-op in the browser, and
  // renaming an id would break renderer.js's getElementById calls. Assert both halves.
  const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(REPO, 'public', 'renderer.js'), 'utf8');
  const pairs = { Fit: 'filterFit', State: 'filterState', Agency: 'filterAgency', Designation: 'filterDesignation', Sort: 'sortBy' };
  for (const [text, id] of Object.entries(pairs)) {
    assert.ok(html.includes(`for="${id}">${text}</label>`), `label "${text}" must be associated with #${id}`);
    assert.ok(html.includes(`id="${id}"`), `#${id} must still exist in index.html`);
    assert.ok(renderer.includes(`'${id}'`) || renderer.includes(`"${id}"`), `renderer.js must still resolve #${id}`);
  }
});

test('no duplicate ids among form controls', () => {
  // A duplicate id makes every `for` pointing at it bind to the first occurrence only.
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'check-labels.mjs'), '--json'], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.deepStrictEqual(report.findings.filter(f => /duplicate id/.test(f.problem)), []);
});
