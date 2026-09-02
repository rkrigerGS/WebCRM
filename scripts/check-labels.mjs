#!/usr/bin/env node
// check-labels.mjs — every form control in public/index.html must have an accessible name.
//
// Item 2 of the 2026-09-02 hardening pass. Before it, index.html had 74 element ids and
// zero `for` attributes: no label was associated with any control, so a screen reader
// announced the filter selects as bare comboboxes and the login fields as unlabelled text
// inputs. A placeholder is NOT an accessible name — it is not announced by every AT, and
// it disappears the moment the user types.
//
// Deliberately dependency-free (the app ships only express + chokidar) and deliberately
// scoped to index.html: renderer.js builds its controls inside JS template strings, which
// a static parser cannot resolve reliably. Those need a runtime check — axe DevTools
// against the live DOM — see STATUS.md.
//
// Usage: node scripts/check-labels.mjs [--json]
// Exits non-zero if any control lacks an accessible name.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'public', 'index.html');
const html = readFileSync(target, 'utf8');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
    || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
};

// Collect label targets and every wrapped control (a control nested inside its own <label>
// is named by that label, no `for` needed).
const labelFor = new Set();
for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
  const f = attr(m[1], 'for');
  if (f) labelFor.add(f);
}
const wrapped = new Set();
for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
  for (const c of m[1].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const id = attr(c[2], 'id');
    if (id) wrapped.add(id);
  }
}

// Controls that carry no accessible name of their own.
const NAMELESS_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const findings = [];
const seenIds = new Map();
let controls = 0;

const lineOf = (index) => html.slice(0, index).split('\n').length;

for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
  const [full, tagName, rawAttrs] = m;
  const type = (attr(rawAttrs, 'type') || '').toLowerCase();
  // <input type="submit"> and friends are named by their value, not a label.
  if (tagName.toLowerCase() === 'input' && NAMELESS_TYPES.has(type)) continue;
  controls++;

  const id = attr(rawAttrs, 'id');
  const line = lineOf(m.index);
  if (id) {
    if (seenIds.has(id)) {
      findings.push({ line, id, tag: tagName, problem: `duplicate id (also on line ${seenIds.get(id)}) — a "for" pointing here binds to the first only` });
    } else {
      seenIds.set(id, line);
    }
  }

  const named = !!(attr(rawAttrs, 'aria-label')
    || attr(rawAttrs, 'aria-labelledby')
    || attr(rawAttrs, 'title')
    || (id && (labelFor.has(id) || wrapped.has(id))));

  if (!named) {
    const hasPlaceholder = !!attr(rawAttrs, 'placeholder');
    findings.push({
      line, id: id || '(no id)', tag: tagName,
      problem: hasPlaceholder
        ? 'only a placeholder — not an accessible name; add aria-label or a <label for>'
        : 'no accessible name; add a <label for> or aria-label'
    });
  }
}

// A `for` that points at nothing is a silent failure: it looks associated in the source
// and does nothing in the browser.
for (const f of labelFor) {
  if (!seenIds.has(f)) {
    findings.push({ line: 0, id: f, tag: 'label', problem: `<label for="${f}"> points at no control in this file` });
  }
}

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ file: 'public/index.html', controls, findings }, null, 2));
} else {
  console.log(`\ncheck-labels: ${controls} form controls in public/index.html`);
  if (!findings.length) {
    console.log('  OK — every control has an accessible name.\n');
  } else {
    console.log(`  ${findings.length} problem(s):\n`);
    for (const f of findings.sort((a, b) => a.line - b.line)) {
      console.log(`  line ${String(f.line).padStart(4)}  <${f.tag} id=${f.id}>  ${f.problem}`);
    }
    console.log('');
  }
}
process.exit(findings.length ? 1 : 0);
