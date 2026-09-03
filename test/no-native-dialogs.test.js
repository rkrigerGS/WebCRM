const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Item 3 of the 2026-09-02 hardening pass. The 21 native window.alert / confirm / prompt
// calls in renderer.js are replaced by window.ui equivalents (see public/ui.js). This is
// the guard that keeps them from creeping back: the natives are blocking, unstyled,
// suppressible by the browser, and — for the dead-reason and dormant-date prompts — the
// direct reason those two fields held unaggregatable free text.

const PUBLIC = path.join(__dirname, '..', 'public');

// ui.js is exempt: it is the replacement, and it must be free to mention the names in its
// own documentation. book.html is a standalone page that loads no app scripts.
const EXEMPT = new Set(['ui.js']);

// Matches a call to a bare or window-qualified native dialog, while ignoring
// `ui.prompt(...)`, `this.confirm(...)`, `foo.alert(...)` and the like.
const NATIVE_CALL = /(?:^|[^.\w])(?:window\s*\.\s*)?(prompt|confirm|alert)\s*\(/;

function scan(file) {
  const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    // Skip comment-only lines so prose about the migration does not trip the guard.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (NATIVE_CALL.test(line)) hits.push(`${file}:${i + 1}: ${trimmed}`);
  });
  return hits;
}

test('no native alert/confirm/prompt calls remain in the front-end', () => {
  const files = fs.readdirSync(PUBLIC).filter(f => (f.endsWith('.js') || f.endsWith('.html')) && !EXEMPT.has(f));
  const offenders = files.flatMap(scan);
  assert.deepStrictEqual(offenders, [], `use window.ui.alert / .confirm / .prompt / .toast instead:\n${offenders.join('\n')}`);
});

test('the guard is capable of failing (it is not a no-op regex)', () => {
  // Guards that silently match nothing are worse than no guard, because they read as
  // coverage. Prove the pattern fires on each form it is meant to catch.
  for (const line of [
    "  if(!confirm('really?'))return;",
    "  const r=window.prompt('why?');",
    "  alert(e.message);",
    "  } catch(e) { alert(e.message); }"
  ]) {
    assert.ok(NATIVE_CALL.test(line), `should have matched: ${line}`);
  }
  // And that it does not fire on the replacements or on unrelated member calls.
  for (const line of [
    "  const ok=await window.ui.confirm('really?');",
    "  window.ui.toast(e.message,{variant:'error'});",
    "  const r=await window.ui.prompt('why?');",
    "  ui.alert('x');",
    "  someObj.confirm(1);"
  ]) {
    assert.ok(!NATIVE_CALL.test(line), `should NOT have matched: ${line}`);
  }
});

test('ui.js exposes the full replacement surface the call sites rely on', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');
  for (const name of ['alert:', 'confirm:', 'prompt:', 'toast:', 'setBusy:', 'openDialog:', 'closeDialog:']) {
    assert.ok(src.includes(name), `ui.js must export ${name.replace(':', '')}`);
  }
});

test('ui.js is loaded before every script that calls window.ui', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const uiAt = html.indexOf('src="ui.js"');
  const apiAt = html.indexOf('src="api.js"');
  const rendererAt = html.indexOf('src="renderer.js"');
  assert.ok(uiAt !== -1, 'index.html must load ui.js');
  assert.ok(apiAt !== -1 && rendererAt !== -1, 'index.html must load api.js and renderer.js');
  // Both api.js (the research-folder dialogs) and renderer.js call window.ui.
  assert.ok(uiAt < apiAt, 'ui.js must be loaded before api.js');
  assert.ok(uiAt < rendererAt, 'ui.js must be loaded before renderer.js');
});

test('the ui-root host element exists for the dialogs to mount into', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /id="ui-root"/, 'ui.js mounts its dialogs into #ui-root');
});

test('the dead-reason prompt offers a fixed choice list, not free text', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'renderer.js'), 'utf8');
  assert.match(src, /const DEAD_REASONS\s*=\s*\[/, 'a canonical reason list must exist');
  assert.match(src, /function askDeadReason/, 'one shared helper so the four callers cannot drift');
  // All four callers must go through the helper.
  const callers = (src.match(/askDeadReason\(/g) || []).length;
  assert.ok(callers >= 5, `expected the helper plus 4 call sites, saw ${callers} occurrences`);
});

test('the dormant return date uses a date control with a strict format check', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'renderer.js'), 'utf8');
  assert.match(src, /type:'date'/, 'the dormant prompt must use a real date input');
  assert.match(src, /\\d\{4\}-\\d\{2\}-\\d\{2\}/, 'and validate the ISO shape rather than accepting free text');
});

test('every modal goes through the shared dialog lifecycle, not a raw hidden toggle', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'renderer.js'), 'utf8');
  const raw = [];
  src.split('\n').forEach((line, i) => {
    if (/\b(emailModal|settingsModal|usersModal|auditModal|replyModal)\.hidden\s*=/.test(line)) {
      raw.push(`renderer.js:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepStrictEqual(raw, [], `use showModal()/hideModal() so ARIA and focus management apply:\n${raw.join('\n')}`);
});

test('the draft flows carry a sequence guard against the wrong-prospect race', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'renderer.js'), 'utf8');
  assert.match(src, /let flowSeq=0;/, 'flowSeq must exist');
  // Both flows must claim a sequence number and both must re-check it after awaiting.
  const claims = (src.match(/const seq=\+\+flowSeq;/g) || []).length;
  assert.strictEqual(claims, 2, 'openEmailFlow and openLinkedInFlow must each claim a sequence');
  const checks = (src.match(/if\(seq!==flowSeq\)return;/g) || []).length;
  assert.ok(checks >= 6, `expected a re-check after every await, saw ${checks}`);
});

test('loadProspects handles its own failure instead of throwing into the void', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function loadProspects()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /try\{/, 'loadProspects must catch its own load failure');
  assert.match(body, /listError/, 'and surface it in the error panel');
  assert.match(body, /variant:'error'/, 'and toast it');
});

test('the empty-state headline cannot paint before the first load completes', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /id="emptyState" hidden/, 'emptyState must start hidden');
  assert.match(html, /id="listError" hidden/, 'the error panel must start hidden too');
});
