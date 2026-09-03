// ui.js — in-app replacements for window.alert / confirm / prompt, plus the dialog shell
// every modal in the app shares.
//
// Why this exists (items 3, 5 and 4b of the 2026-09-02 hardening pass):
//
//  - The natives are BLOCKING and unstyled. A native prompt() froze the whole page mid
//    workflow, looked nothing like the rest of the app, and on some platforms the browser
//    lets the user suppress further dialogs — which would silently break marking a
//    prospect dead, because that workflow depends on the return value.
//  - They are also why two pieces of data are weak. A free-text dead reason cannot be
//    aggregated, so the dead-pile review it was collected for cannot actually use it; and
//    a hand-typed "YYYY-MM-DD" return date arrives as arbitrary text. Both get a real
//    control here (a <select>, a date picker) rather than a nicer-looking text box —
//    re-implementing them as free-text modals would preserve the defect in better styling.
//  - Nothing had anywhere to render a recoverable error except alert(), which item 4b needs.
//
// Dependency-free and framework-free: one file, no build step, reusing the existing
// .modal / .btn classes so these look like the five modals already in index.html.
//
// XSS: every caller-supplied string (messages, titles, button labels, choice values) is
// passed through esc() before it reaches innerHTML. The only markup assembled raw is this
// file's own template, built from those escaped pieces, and every attribute is quoted.
//
// CANCEL SEMANTICS — the migration's sharpest edge. window.prompt returns null when the
// user cancels and '' when they submit an empty box, and call sites distinguish the two.
// ui.prompt preserves that exactly: null on cancel/Escape/backdrop-click, '' on an empty
// submit. renderer.js's dead-reason callers rely on it — null aborts the whole action,
// '' means "mark dead, no reason given".
//
// KEY HANDLING is deliberately ONE document-level listener driven by a stack of open
// dialogs, not a listener per backdrop. Per-backdrop listeners had three bugs: a dialog
// raised over an app modal let a single Escape close both; Tab could not recover focus
// once a re-render destroyed the focused node (the event never reached the backdrop from
// <body>); and Enter on the Cancel button submitted the form.

(function () {
  'use strict';

  const ROOT_ID = 'ui-root';
  const APP_ID = 'appRoot';

  function root() {
    let el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ROOT_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Only one of ui.js's own dialogs at a time: a second call queues behind the first
  // rather than stacking two of them.
  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    // Swallow on the chain so one rejected dialog cannot poison every later one, while
    // still surfacing the rejection to this call's own caller.
    chain = run.then(() => {}, () => {});
    return run;
  }

  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // getClientRects() rather than offsetParent: offsetParent is null for position:fixed
  // elements, and every dialog here lives inside a fixed .modal-backdrop. It also
  // correctly excludes anything hidden by an ancestor, which is what we actually mean.
  function focusables(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE))
      .filter(el => !el.hidden && el.getClientRects().length > 0);
  }

  // Innermost dialog last. Replaces a plain depth counter so the key handler can tell
  // WHICH dialog is on top, and so a backgrounded dialog can be made inert.
  const openStack = [];
  const top = () => openStack[openStack.length - 1] || null;

  function setInert(el, on) {
    if (!el) return;
    if ('inert' in HTMLElement.prototype) el.inert = on;
    else if (on) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  }

  // The app shell and every dialog except the top one must be unreachable — by Tab AND by
  // screen-reader browsing, not merely painted over. The five app modals are SIBLINGS of
  // #appRoot, so inerting the shell alone left an underlying modal fully browsable when a
  // confirm was raised from inside it.
  function applyInertness() {
    const t = top();
    setInert(document.getElementById(APP_ID), !!t);
    for (const b of openStack) setInert(b, b !== t);
  }

  let keyHandlerInstalled = false;
  function installKeyHandler() {
    if (keyHandlerInstalled) return;
    keyHandlerInstalled = true;
    // Capture phase, document level, top dialog only: one Escape closes exactly one
    // dialog, and Tab can pull focus back from <body> after a re-render.
    document.addEventListener('keydown', (e) => {
      const backdrop = top();
      if (!backdrop) return;
      const dialog = backdrop.querySelector('.modal') || backdrop;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (backdrop._uiOnEscape) backdrop._uiOnEscape();
        return;
      }
      if (e.key !== 'Tab') return;

      // Re-queried on every Tab: dialog contents change (the dead-reason "Other" field
      // appears mid-dialog, the email flow replaces its whole body per step), so a cached
      // list would trap focus on a removed node.
      const items = focusables(dialog);
      if (!items.length) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (!dialog.contains(document.activeElement)) {
        // Focus escaped — almost always because a re-render destroyed the focused node
        // and the browser fell back to <body>. Pull it back in.
        e.preventDefault(); first.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      }
    }, true);
  }

  // Shared open/close lifecycle, exported so the five pre-existing modals in index.html
  // get identical semantics without adopting this file's markup.
  //
  // opts.onEscape      — what Escape should do (usually click the modal's own Close).
  // opts.initialFocusSelector — override which control receives focus.
  // opts.describedBy   — element whose text describes the dialog. Only pass this when the
  //                      body is static at open time; a generic .modal-body is wrong here,
  //                      because several callers open the shell and fill it afterwards, so
  //                      the description would be empty exactly when it is announced.
  function openDialog(backdrop, opts) {
    const o = opts || {};
    backdrop._uiOnEscape = o.onEscape || null;

    // Idempotent. Several call sites re-render an already-open modal in place (the email
    // flow advances step by step through the same shell), and pushing twice would leave
    // the app permanently inert once it closed.
    if (backdrop._uiOpen) {
      backdrop.hidden = false;
      return;
    }

    const dialog = backdrop.querySelector('.modal') || backdrop;
    const titleEl = backdrop.querySelector('.modal-head h3, h3');

    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (titleEl) {
      if (!titleEl.id) titleEl.id = 'ui-title-' + Math.random().toString(36).slice(2, 9);
      dialog.setAttribute('aria-labelledby', titleEl.id);
    }
    if (o.describedBy) {
      if (!o.describedBy.id) o.describedBy.id = 'ui-desc-' + Math.random().toString(36).slice(2, 9);
      dialog.setAttribute('aria-describedby', o.describedBy.id);
    } else {
      dialog.removeAttribute('aria-describedby');
    }
    // A dialog with no natural first control must still be able to take focus, or focus
    // stays on the trigger behind the backdrop.
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');

    backdrop._uiOpen = true;
    backdrop._uiReturnFocus = document.activeElement;
    backdrop.hidden = false;
    openStack.push(backdrop);
    applyInertness();
    installKeyHandler();

    const preferred = o.initialFocusSelector ? dialog.querySelector(o.initialFocusSelector) : null;
    (preferred || focusables(dialog)[0] || dialog).focus();
  }

  function closeDialog(backdrop) {
    backdrop.hidden = true;
    // Idempotent for the same reason as openDialog: several handlers hide two modals
    // defensively, and a second close must not disturb a different open dialog.
    if (!backdrop._uiOpen) return;
    backdrop._uiOpen = false;
    backdrop._uiOnEscape = null;

    const i = openStack.indexOf(backdrop);
    if (i !== -1) openStack.splice(i, 1);
    setInert(backdrop, false); // it may have been backgrounded while another dialog was up
    applyInertness();

    // Restoring focus is what keeps a keyboard user from losing their place. Guarded
    // because the trigger can be gone by now — deleting a prospect removes the very
    // button that opened the confirm.
    const back = backdrop._uiReturnFocus;
    backdrop._uiReturnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') {
      try { back.focus(); } catch (_) { /* nothing better available */ }
    }
  }

  // Builds one throwaway dialog, resolves when the user acts, always removes itself.
  function build(spec) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop ui-dialog';
      backdrop.innerHTML =
        '<div class="modal ui-dialog-modal">'
        + '<div class="modal-head"><h3>' + esc(spec.title) + '</h3></div>'
        + '<div class="modal-body">' + spec.bodyHtml + '</div>'
        + '<div class="modal-actions ui-dialog-actions">' + spec.buttonsHtml + '</div>'
        + '</div>';
      root().appendChild(backdrop);

      let done = false;
      const finish = function (value) {
        if (done) return;
        done = true;
        try {
          closeDialog(backdrop);
        } finally {
          // finally, so a throw in focus restoration can never leave the dialog on screen
          // or the promise unsettled.
          backdrop.remove();
          resolve(value);
        }
      };

      spec.wire(backdrop, finish);

      openDialog(backdrop, {
        onEscape: function () { finish(spec.onCancel()); },
        initialFocusSelector: spec.initialFocusSelector,
        // For alert/confirm the message IS the dialog, and without describedby a screen
        // reader announces only the title and the focused button. For prompt the message
        // is the input's own <label>, so pointing here too would announce it twice.
        describedBy: spec.describeSelector ? backdrop.querySelector(spec.describeSelector) : null
      });

      // Clicking the backdrop itself (never the dialog) cancels.
      backdrop.addEventListener('mousedown', function (e) {
        if (e.target === backdrop) finish(spec.onCancel());
      });
    });
  }

  const ui = {
    // Blocking acknowledgement. Reserved for what genuinely must be seen before
    // continuing — most former alert() calls were recoverable errors and became toasts.
    alert: function (message, opts) {
      const o = opts || {};
      return serialize(function () {
        return build({
          title: o.title || 'Notice',
          bodyHtml: '<div class="ui-dialog-text">' + esc(message) + '</div>',
          buttonsHtml: '<button class="btn" data-ui="ok">OK</button>',
          describeSelector: '.ui-dialog-text',
          onCancel: function () { return undefined; },
          wire: function (backdrop, finish) {
            backdrop.querySelector('[data-ui="ok"]').addEventListener('click', function () { finish(undefined); });
          }
        });
      });
    },

    // true only on explicit confirm; false on cancel, Escape, or backdrop click — the same
    // shape window.confirm had, so `if (!await ui.confirm(...)) return;` is a one-keyword
    // change at every call site.
    confirm: function (message, opts) {
      const o = opts || {};
      return serialize(function () {
        return build({
          title: o.title || 'Please confirm',
          bodyHtml: '<div class="ui-dialog-text">' + esc(message) + '</div>',
          buttonsHtml:
            '<button class="btn ' + (o.danger ? 'btn-danger' : '') + '" data-ui="yes">' + esc(o.confirmLabel || 'OK') + '</button>'
            + '<button class="btn btn-ghost" data-ui="no">Cancel</button>',
          describeSelector: '.ui-dialog-text',
          onCancel: function () { return false; },
          // For a destructive action, focus the safe option so a stray Enter deletes nothing.
          initialFocusSelector: o.danger ? '[data-ui="no"]' : '[data-ui="yes"]',
          wire: function (backdrop, finish) {
            backdrop.querySelector('[data-ui="yes"]').addEventListener('click', function () { finish(true); });
            backdrop.querySelector('[data-ui="no"]').addEventListener('click', function () { finish(false); });
          }
        });
      });
    },

    // Resolves to the entered string, or null if cancelled. An empty submit resolves to ''
    // — NOT null — because that is what window.prompt did and call sites rely on it.
    //
    // opts.choices turns this into a <select> of known values plus an "Other" free-text
    // field: that is how the dead-reason prompt stops producing unaggregatable text.
    // opts.type 'date' yields a real date picker and an ISO-shaped value.
    prompt: function (message, opts) {
      const o = opts || {};
      const type = o.type || 'text';
      const inputId = 'ui-prompt-input';
      const otherId = 'ui-prompt-other';
      const hasChoices = Array.isArray(o.choices) && o.choices.length > 0;

      let control;
      if (hasChoices) {
        const otherName = o.otherPlaceholder || 'Describe it';
      const options = o.choices.map(function (c) {
          const value = typeof c === 'string' ? c : c.value;
          const label = typeof c === 'string' ? c : (c.label || c.value);
          return '<option value="' + esc(value) + '">' + esc(label) + '</option>';
        }).join('');
        control =
          '<select id="' + inputId + '" class="tb-select ui-dialog-control">'
          + '<option value="">' + esc(o.emptyLabel || '(none)') + '</option>'
          + options
          + '<option value="__other__">' + esc(o.otherLabel || 'Other (type it below)') + '</option>'
          + '</select>'
          // The accessible name is the placeholder, not otherLabel: otherLabel is the
          // option's instruction text ("Other (type it below)"), which announces as a
          // direction rather than a name for the field the user is already in. One
          // fallback for both, so the announced name always matches the visible text.
          + '<input type="text" id="' + otherId + '" class="login-input ui-dialog-control ui-dialog-other"'
          + ' placeholder="' + esc(otherName) + '"'
          + ' aria-label="' + esc(otherName) + '" hidden />';
      } else {
        control = '<input type="' + esc(type) + '" id="' + inputId + '" class="login-input ui-dialog-control"'
          + ' value="' + esc(o.value || '') + '" placeholder="' + esc(o.placeholder || '') + '"'
          + (o.min ? ' min="' + esc(o.min) + '"' : '') + ' />';
      }

      return serialize(function () {
        return build({
          title: o.title || 'Enter a value',
          bodyHtml:
            '<label class="ui-dialog-text" for="' + inputId + '">' + esc(message) + '</label>'
            + control
            + '<div class="ui-dialog-error" data-ui="err" role="alert" hidden></div>',
          buttonsHtml:
            '<button class="btn" data-ui="ok">' + esc(o.okLabel || 'Save') + '</button>'
            + '<button class="btn btn-ghost" data-ui="cancel">Cancel</button>',
          onCancel: function () { return null; },
          initialFocusSelector: '#' + inputId,
          wire: function (backdrop, finish) {
            const input = backdrop.querySelector('#' + inputId);
            const other = backdrop.querySelector('#' + otherId);
            const errEl = backdrop.querySelector('[data-ui="err"]');

            if (other) {
              input.addEventListener('change', function () {
                const isOther = input.value === '__other__';
                other.hidden = !isOther;
                if (isOther) other.focus();
              });
            }

            const readValue = function () {
              if (other && input.value === '__other__') return other.value.trim();
              return input.value;
            };

            const submit = function () {
              const value = readValue();
              if (o.required && !String(value).trim()) {
                errEl.textContent = o.requiredMessage || 'This cannot be empty.';
                errEl.hidden = false;
                input.focus();
                return;
              }
              if (typeof o.validate === 'function') {
                const problem = o.validate(value);
                if (problem) {
                  errEl.textContent = problem;
                  errEl.hidden = false;
                  (other && !other.hidden ? other : input).focus();
                  return;
                }
              }
              finish(value);
            };

            backdrop.querySelector('[data-ui="ok"]').addEventListener('click', submit);
            backdrop.querySelector('[data-ui="cancel"]').addEventListener('click', function () { finish(null); });
            backdrop.addEventListener('keydown', function (e) {
              if (e.key !== 'Enter') return;
              // Never hijack Enter from a button — doing so made Enter on Cancel SAVE the
              // value, which for the dead-reason dialog marked a prospect dead from the
              // one control that promises not to.
              if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
              e.preventDefault();
              submit();
            });
          }
        });
      });
    },

    // Non-blocking; the replacement for alert() on recoverable failures. Delegates to
    // renderer.js's toast so there is one toast implementation, not two. The variant is
    // passed through so a failure actually looks like one.
    toast: function (message, opts) {
      const variant = (opts || {}).variant || 'info';
      window.toast(message, variant === 'error' ? 7000 : 2600, variant);
    },

    // One busy primitive for item 4b: an attribute the stylesheet keys off, plus aria-busy
    // so assistive tech knows the region is mid-update. Deliberately not a skeleton
    // system — a spinner and a flag cover every case the app currently has.
    setBusy: function (el, busy) {
      if (!el) return;
      if (busy) { el.setAttribute('data-busy', 'true'); el.setAttribute('aria-busy', 'true'); }
      else { el.removeAttribute('data-busy'); el.removeAttribute('aria-busy'); }
    },

    openDialog: openDialog,
    closeDialog: closeDialog
  };

  window.ui = ui;
})();
