/* issue-tracker embeddable capture widget.
 * Install: <script src="http://localhost:4400/widget.js" data-project="<key>" defer></script>
 * Optional: window.IssueTracker.configure({ context: () => ({ ...appState }) })
 * The widget must never break the host app: every entry point is wrapped.
 */
(function () {
  'use strict';

  var BUFFER_CAP = 10;
  var TYPES = ['bug', 'improvement', 'feature', 'other'];

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        try {
          console.warn('[issue-tracker]', err);
        } catch (_) {}
      }
    };
  }

  var scriptTag = document.currentScript;
  if (!scriptTag || !scriptTag.src || !scriptTag.getAttribute('data-project')) {
    scriptTag = null;
    var candidates = document.querySelectorAll('script[data-project][src]');
    for (var ci = 0; ci < candidates.length; ci++) {
      try {
        if (new URL(candidates[ci].src).pathname === '/widget.js') {
          scriptTag = candidates[ci];
          break;
        }
      } catch (e) {}
    }
  }
  if (!scriptTag || !scriptTag.src) {
    console.warn('[issue-tracker] widget script tag not found; not mounting');
    return;
  }
  var project = scriptTag.getAttribute('data-project');
  var endpoint = new URL(scriptTag.src).origin;
  if (!project) {
    console.warn('[issue-tracker] data-project attribute missing; not mounting');
    return;
  }

  // A second copy of this script (double tag, SPA re-injection) must not
  // double-wrap fetch or double-mount.
  if (window.__issueTrackerWidgetLoaded) return;
  window.__issueTrackerWidgetLoaded = true;

  var state = {
    contextProvider: null,
    clickBreadcrumbs: [],
    fetchBreadcrumbs: [],
    recentErrors: [],
    recentFetchFailures: [],
    selectedText: '',
    selectedType: 'bug',
    selectedSeverity: 3,
  };

  function push(buffer, entry) {
    buffer.push(entry);
    if (buffer.length > BUFFER_CAP) buffer.shift();
  }

  function isWidgetNode(node) {
    return !!(node && node.closest && node.closest('[data-issue-tracker-ui]'));
  }

  // ---- ring buffers -------------------------------------------------------

  document.addEventListener(
    'click',
    safe(function (e) {
      var t = e.target;
      if (!t || isWidgetNode(t)) return;
      var dataAttrs = {};
      if (t.attributes) {
        for (var i = 0; i < t.attributes.length; i++) {
          var a = t.attributes[i];
          if (a.name.indexOf('data-') === 0) dataAttrs[a.name] = a.value;
        }
      }
      push(state.clickBreadcrumbs, {
        ts: new Date().toISOString(),
        tag: t.tagName,
        id: t.id || null,
        cls: t.className && t.className.slice ? t.className.slice(0, 80) : null,
        text: (t.textContent || '').trim().slice(0, 60),
        dataAttrs: dataAttrs,
      });
    }),
    true
  );

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      } catch (_) {}
      var method = (init && init.method) || (input && input.method) || 'GET';
      var started = Date.now();
      var result = origFetch(input, init);
      try {
        if (url.indexOf(endpoint) !== 0) {
          result.then(
            safe(function (res) {
              var entry = {
                ts: new Date().toISOString(),
                method: method,
                url: String(url).slice(0, 200),
                status: res.status,
                ms: Date.now() - started,
              };
              push(state.fetchBreadcrumbs, entry);
              if (res.status >= 400) push(state.recentFetchFailures, entry);
            }),
            safe(function (err) {
              push(state.fetchBreadcrumbs, {
                ts: new Date().toISOString(),
                method: method,
                url: String(url).slice(0, 200),
                status: 0,
                error: String((err && err.message) || err),
                ms: Date.now() - started,
              });
            })
          );
        }
      } catch (_) {}
      return result;
    };
  }

  window.addEventListener(
    'error',
    safe(function (e) {
      push(state.recentErrors, {
        ts: new Date().toISOString(),
        message: String(e.message || (e.error && e.error.message) || 'unknown error'),
        source: e.filename ? e.filename + ':' + e.lineno : null,
        stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 600) : null,
      });
    })
  );

  window.addEventListener(
    'unhandledrejection',
    safe(function (e) {
      var reason = e.reason;
      push(state.recentErrors, {
        ts: new Date().toISOString(),
        message: 'Unhandled rejection: ' + String((reason && reason.message) || reason),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 600) : null,
      });
    })
  );

  // ---- styles -------------------------------------------------------------

  var CSS = [
    '.it-fab{position:fixed;right:18px;bottom:18px;width:52px;height:52px;border-radius:50%;',
    'background:#1f2937;color:#fff;border:none;cursor:pointer;z-index:2147483000;font-size:22px;',
    'box-shadow:0 4px 14px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;}',
    '.it-fab:hover{background:#111827;transform:scale(1.06);}',
    '.it-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483001;}',
    '.it-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(440px,92vw);',
    'max-height:88vh;overflow:auto;background:#fff;color:#111827;border-radius:12px;z-index:2147483002;',
    'box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '.it-dialog *{box-sizing:border-box;font-family:inherit;}',
    '.it-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #e5e7eb;cursor:move;}',
    '.it-head b{font-size:15px;}',
    '.it-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
    '.it-row{display:flex;flex-direction:column;gap:4px;}',
    '.it-label{font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.04em;}',
    '.it-pills{display:flex;gap:6px;flex-wrap:wrap;}',
    '.it-type-pill{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:4px 12px;cursor:pointer;font-size:13px;color:#374151;}',
    '.it-type-pill.it-on{background:#1f2937;color:#fff;border-color:#1f2937;}',
    '.it-input,.it-ta{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;color:#111827;background:#fff;}',
    '.it-ta{resize:vertical;}',
    '.it-input:focus,.it-ta:focus{outline:2px solid #6366f1;outline-offset:-1px;}',
    '.it-sevs{display:flex;gap:6px;align-items:center;}',
    '.it-sev{width:26px;height:26px;border-radius:50%;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:12px;color:#374151;}',
    '.it-sev.it-on{background:#dc2626;border-color:#dc2626;color:#fff;}',
    '.it-selhead{display:flex;justify-content:space-between;align-items:center;}',
    '.it-selremove{background:none;border:none;color:#6b7280;font-size:12px;cursor:pointer;text-decoration:underline;padding:0;}',
    '.it-selremove:hover{color:#dc2626;}',
    '.it-selection{background:#f3f4f6;border:1px solid #e5e7eb;border-left:3px solid #6366f1;border-radius:6px;',
    'padding:6px 8px;font-size:12.5px;color:#374151;max-height:76px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;}',
    '.it-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#374151;cursor:pointer;}',
    '.it-check input{accent-color:#6366f1;margin:0;}',
    '.it-error{color:#dc2626;font-size:13px;min-height:16px;}',
    '.it-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e5e7eb;}',
    '.it-btn{border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#374151;}',
    '.it-submit{background:#1f2937;border-color:#1f2937;color:#fff;font-weight:600;}',
    '.it-submit:disabled{opacity:.6;cursor:wait;}',
    '.it-toast{position:fixed;right:18px;bottom:80px;background:#1f2937;color:#fff;padding:12px 16px;border-radius:10px;',
    'z-index:2147483003;box-shadow:0 8px 24px rgba(0,0,0,.3);font:13px/1.4 -apple-system,sans-serif;max-width:320px;}',
    '.it-toast a{color:#93c5fd;}',
  ].join('');

  function injectStyles() {
    if (document.querySelector('style[data-issue-tracker]')) return;
    var style = document.createElement('style');
    style.setAttribute('data-issue-tracker', '1');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- snapshot -----------------------------------------------------------

  function snapshot(opts) {
    opts = opts || {};
    var ctx = {
      capturedAt: new Date().toISOString(),
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      userAgent: navigator.userAgent,
      selectedText: opts.selection != null ? opts.selection : state.selectedText || '',
    };
    // The activity trail is bug forensics; "what am I looking at" above is
    // always attached, the trail only when wanted (dialog checkbox).
    if (opts.trail !== false) {
      ctx.clickBreadcrumbs = state.clickBreadcrumbs.slice();
      ctx.fetchBreadcrumbs = state.fetchBreadcrumbs.slice();
      ctx.recentErrors = state.recentErrors.slice();
      ctx.recentFetchFailures = state.recentFetchFailures.slice();
    }
    if (state.contextProvider) {
      try {
        ctx.app = state.contextProvider() || null;
      } catch (err) {
        ctx.app = { error: 'context provider threw: ' + String((err && err.message) || err) };
      }
    }
    return ctx;
  }

  // ---- dialog -------------------------------------------------------------

  var ui = { backdrop: null, dialog: null };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function closeDialog() {
    if (ui.backdrop) ui.backdrop.remove();
    if (ui.dialog) ui.dialog.remove();
    ui.backdrop = ui.dialog = null;
    dragState = null;
    document.removeEventListener('keydown', onKeydown);
  }

  var onKeydown = safe(function (e) {
    if (e.key === 'Escape') closeDialog();
  });

  // All toast content is plain text or an explicit link — never HTML, so a
  // compromised tracker response cannot inject markup into the host app.
  function toast(parts, ms) {
    var t = el('div', 'it-toast');
    t.setAttribute('data-issue-tracker-ui', '1');
    if (parts.prefix) t.appendChild(document.createTextNode(parts.prefix));
    if (parts.link) {
      var a = el('a', null, parts.link.text);
      a.href = parts.link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      t.appendChild(a);
    }
    if (parts.suffix) t.appendChild(document.createTextNode(parts.suffix));
    document.body.appendChild(t);
    setTimeout(safe(function () { t.remove(); }), ms || 6000);
  }

  function openDialog() {
    if (ui.dialog) return;
    injectStyles();
    state.selectedType = 'bug';
    state.selectedSeverity = 3;

    // Programmatic opens (IssueTracker.open) get no FAB mousedown; if a live
    // selection exists right now, prefer it over the last mousedown snapshot.
    var liveSel = window.getSelection ? String(window.getSelection()) : '';
    if (liveSel) state.selectedText = liveSel.slice(0, 500);
    var captured = { selection: state.selectedText || '' };
    var trail = null;
    var trailTouched = false;

    ui.backdrop = el('div', 'it-backdrop');
    ui.backdrop.setAttribute('data-issue-tracker-ui', '1');
    ui.backdrop.addEventListener('click', safe(closeDialog));
    document.body.appendChild(ui.backdrop);

    var d = el('div', 'it-dialog');
    d.setAttribute('data-issue-tracker-ui', '1');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Report an issue');

    var head = el('div', 'it-head');
    head.appendChild(el('b', null, 'Report an issue'));
    var x = el('button', 'it-btn it-cancel', '×');
    x.addEventListener('click', safe(closeDialog));
    head.appendChild(x);
    d.appendChild(head);

    var body = el('div', 'it-body');

    var typeRow = el('div', 'it-row');
    typeRow.appendChild(el('span', 'it-label', 'Type'));
    var pills = el('div', 'it-pills');
    TYPES.forEach(function (t) {
      var pill = el('button', 'it-type-pill' + (t === state.selectedType ? ' it-on' : ''), t);
      pill.setAttribute('data-type', t);
      pill.addEventListener(
        'click',
        safe(function () {
          state.selectedType = t;
          pills.querySelectorAll('.it-type-pill').forEach(function (p) {
            p.classList.toggle('it-on', p.getAttribute('data-type') === t);
          });
          // Trail default follows type (bug = forensics wanted) until the
          // reporter overrides the checkbox themselves.
          if (trail && !trailTouched) trail.checked = t === 'bug';
        })
      );
      pills.appendChild(pill);
    });
    typeRow.appendChild(pills);
    body.appendChild(typeRow);

    var titleRow = el('div', 'it-row');
    titleRow.appendChild(el('span', 'it-label', 'Title (optional)'));
    var title = el('input', 'it-input it-title');
    title.placeholder = 'Short summary';
    titleRow.appendChild(title);
    body.appendChild(titleRow);

    var seeingRow = el('div', 'it-row');
    seeingRow.appendChild(el('span', 'it-label', 'What are you seeing? *'));
    var seeing = el('textarea', 'it-ta it-seeing');
    seeing.rows = 4;
    seeing.placeholder = 'Describe the problem or current behavior';
    seeingRow.appendChild(seeing);
    body.appendChild(seeingRow);

    var expRow = el('div', 'it-row');
    expRow.appendChild(el('span', 'it-label', 'What do you expect? *'));
    var expecting = el('textarea', 'it-ta it-expecting');
    expecting.rows = 3;
    expecting.placeholder = 'Describe the desired behavior / requirements';
    expRow.appendChild(expecting);
    body.appendChild(expRow);

    var sevRow = el('div', 'it-row');
    sevRow.appendChild(el('span', 'it-label', 'Severity'));
    var sevs = el('div', 'it-sevs');
    for (var s = 1; s <= 5; s++) {
      (function (sev) {
        var dot = el('button', 'it-sev' + (sev <= state.selectedSeverity ? ' it-on' : ''), String(sev));
        dot.setAttribute('data-sev', String(sev));
        dot.addEventListener(
          'click',
          safe(function () {
            state.selectedSeverity = sev;
            sevs.querySelectorAll('.it-sev').forEach(function (el2) {
              el2.classList.toggle('it-on', Number(el2.getAttribute('data-sev')) <= sev);
            });
          })
        );
        sevs.appendChild(dot);
      })(s);
    }
    sevRow.appendChild(sevs);
    body.appendChild(sevRow);

    var tagsRow = el('div', 'it-row');
    tagsRow.appendChild(el('span', 'it-label', 'Tags (comma-separated)'));
    var tags = el('input', 'it-input it-tags');
    tags.placeholder = 'auth, ui, performance';
    tagsRow.appendChild(tags);
    body.appendChild(tagsRow);

    if (captured.selection) {
      var selRow = el('div', 'it-row');
      var selHead = el('div', 'it-selhead');
      selHead.appendChild(el('span', 'it-label', 'Highlighted text (attached)'));
      var selRemove = el('button', 'it-selremove', 'Remove');
      selRemove.setAttribute('type', 'button');
      selHead.appendChild(selRemove);
      selRow.appendChild(selHead);
      selRow.appendChild(el('div', 'it-selection', captured.selection));
      selRemove.addEventListener(
        'click',
        safe(function () {
          captured.selection = '';
          selRow.remove();
        })
      );
      body.appendChild(selRow);
    }

    var trailRow = el('label', 'it-check');
    trail = document.createElement('input');
    trail.type = 'checkbox';
    trail.className = 'it-trail';
    trail.checked = state.selectedType === 'bug';
    trail.addEventListener('change', safe(function () { trailTouched = true; }));
    trailRow.appendChild(trail);
    trailRow.appendChild(el('span', null, 'Include activity trail (clicks, network, errors)'));
    body.appendChild(trailRow);

    var error = el('div', 'it-error', '');
    body.appendChild(error);
    d.appendChild(body);

    var actions = el('div', 'it-actions');
    var cancel = el('button', 'it-btn it-cancel', 'Cancel');
    cancel.addEventListener('click', safe(closeDialog));
    actions.appendChild(cancel);
    var submit = el('button', 'it-btn it-submit', 'Submit issue');
    submit.addEventListener('click', safe(function () { doSubmit({ title: title, seeing: seeing, expecting: expecting, tags: tags, error: error, submit: submit, trail: trail, captured: captured }); }));
    actions.appendChild(submit);
    d.appendChild(actions);

    document.body.appendChild(d);
    ui.dialog = d;
    document.addEventListener('keydown', onKeydown);
    makeDraggable(d, head);
    try { seeing.focus(); } catch (_) {}
  }

  // Single module-level pair of drag listeners — repeated dialog opens must not
  // accumulate document-level handlers.
  var dragState = null;
  document.addEventListener(
    'mousemove',
    safe(function (e) {
      if (!dragState) return;
      var dialog = dragState.dialog;
      dialog.style.left = e.clientX - dragState.dx + dialog.offsetWidth / 2 + 'px';
      dialog.style.top = e.clientY - dragState.dy + dialog.offsetHeight / 2 + 'px';
    })
  );
  document.addEventListener('mouseup', safe(function () { dragState = null; }));

  function makeDraggable(dialog, handle) {
    handle.addEventListener(
      'mousedown',
      safe(function (e) {
        if (e.target.tagName === 'BUTTON') return;
        var rect = dialog.getBoundingClientRect();
        dragState = { dialog: dialog, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
      })
    );
  }

  function doSubmit(f) {
    var seeing = f.seeing.value.trim();
    var expecting = f.expecting.value.trim();
    if (!seeing || !expecting) {
      f.error.textContent = 'Please fill in both "seeing" and "expecting".';
      return;
    }
    f.error.textContent = '';
    f.submit.disabled = true;

    var payload = {
      project: project,
      title: f.title.value.trim(),
      type: state.selectedType,
      severity: state.selectedSeverity,
      tags: f.tags.value
        .split(',')
        .map(function (t) { return t.trim(); })
        .filter(Boolean),
      seeing: seeing,
      expecting: expecting,
      context: snapshot({ trail: f.trail ? f.trail.checked : true, selection: f.captured ? f.captured.selection : null }),
    };

    window
      .fetch(endpoint + '/api/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then(function (res) {
        if (!res.ok) throw new Error('tracker responded ' + res.status);
        return res.json();
      })
      .then(
        safe(function (issue) {
          state.selectedText = ''; // consumed by this report
          closeDialog();
          toast({
            prefix: 'Issue ',
            link: { href: endpoint + '/#' + encodeURIComponent(issue.id), text: String(issue.id) },
            suffix: ' captured.',
          });
        })
      )
      .catch(
        safe(function (err) {
          f.submit.disabled = false;
          f.error.textContent = 'Could not reach the tracker (' + String((err && err.message) || err) + '). Is it running?';
        })
      );
  }

  // ---- mount --------------------------------------------------------------

  var mount = safe(function () {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount);
      return;
    }
    injectStyles();
    var fab = el('button', 'it-fab', '🐞');
    fab.setAttribute('data-issue-tracker-ui', '1');
    fab.setAttribute('aria-label', 'Report an issue');
    fab.title = 'Report an issue';
    fab.addEventListener(
      'mousedown',
      safe(function () {
        // Always assign (even when empty) so a previous capture's selection
        // can never leak into a later, unrelated report.
        var sel = window.getSelection ? String(window.getSelection()) : '';
        state.selectedText = sel.slice(0, 500);
      })
    );
    fab.addEventListener('click', safe(openDialog));
    document.body.appendChild(fab);
  });

  window.IssueTracker = {
    configure: safe(function (opts) {
      if (opts && typeof opts.context === 'function') state.contextProvider = opts.context;
    }),
    open: safe(openDialog),
  };

  mount();
})();
