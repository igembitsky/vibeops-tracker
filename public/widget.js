/* issue-tracker embeddable capture widget.
 * Install: <script src="http://localhost:4400/widget.js" data-project="<key>" defer></script>
 * Optional: window.IssueTracker.configure({ context: () => ({...}) }) enriches captures
 * with app state the widget cannot see: active view/tab/modal, user or tenant id, data
 * counts, git branch/commit/worktree, port. Small JSON only; pointers, not dumps; never
 * secrets or PII.
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
    '.it-fab.it-dragging{cursor:grabbing;transform:none;}',
    '.it-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483001;}',
    '.it-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(440px,92vw);',
    'max-height:88vh;overflow:auto;background:#fff;color:#111827;border-radius:12px;z-index:2147483002;',
    'box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '.it-dialog *{box-sizing:border-box;font-family:inherit;}',
    '@keyframes it-shake{10%,90%{transform:translate(-50%,-50%) translateX(-3px);}30%,70%{transform:translate(-50%,-50%) translateX(5px);}50%{transform:translate(-50%,-50%) translateX(-5px);}}',
    '.it-shake{animation:it-shake .32s cubic-bezier(.36,.07,.19,.97);}',
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
    '.it-tagbox{display:flex;flex-wrap:wrap;align-items:center;gap:5px;border:1px solid #d1d5db;border-radius:8px;padding:5px 8px;background:#fff;cursor:text;}',
    '.it-tagbox:focus-within{outline:2px solid #6366f1;outline-offset:-1px;}',
    '.it-tagbox .it-tags{flex:1;min-width:80px;border:none;outline:none;padding:3px 2px;font-size:14px;color:#111827;background:none;}',
    '.it-chip{display:inline-flex;align-items:center;gap:4px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:999px;padding:1px 4px 1px 9px;font-size:12.5px;color:#374151;}',
    '.it-chip-x{background:none;border:none;color:#6b7280;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;border-radius:999px;}',
    '.it-chip-x:hover{color:#111827;background:rgba(0,0,0,.06);}',
    '.it-dd{display:none;margin-top:5px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);overflow:hidden;}',
    '.it-dd.it-open{display:block;}',
    '.it-dd-list{max-height:180px;overflow-y:auto;padding:4px;}',
    '.it-dd-row{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;font-size:13.5px;color:#111827;cursor:pointer;}',
    '.it-dd-row.it-active{background:#eef2ff;}',
    '.it-dd-name b{color:#4f46e5;font-weight:600;}',
    '.it-dd-count{margin-left:auto;color:#9ca3af;font-size:11px;font-variant-numeric:tabular-nums;}',
    '.it-dd-create{border-top:1px solid #f3f4f6;}',
    '.it-dd-plus{flex:none;width:18px;height:18px;border:1px dashed #16a34a;border-radius:999px;color:#16a34a;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;}',
    '.it-dd-new{margin-left:auto;border:1px solid #16a34a;background:rgba(22,163,74,.07);color:#16a34a;border-radius:999px;padding:1px 8px;font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;}',
    '.it-recent{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:6px;}',
    '.it-recent-label{color:#9ca3af;font-size:11px;margin-right:2px;}',
    '.it-recent-chip{background:none;border:1px dashed #d1d5db;border-radius:999px;color:#6b7280;padding:2px 10px;font-size:12px;cursor:pointer;}',
    '.it-recent-chip:hover{color:#111827;border-color:#9ca3af;}',
    '.it-recent-chip span{color:#6366f1;margin-right:3px;}',
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
    '.it-copyref{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin:0 3px;padding:2px;',
    'border:none;background:transparent;color:#cbd5e1;cursor:pointer;border-radius:5px;line-height:0;}',
    '.it-copyref:hover{color:#fff;background:rgba(255,255,255,.14);}',
    '.it-copyref.it-copied{color:#34d399;}',
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
    tagOutsideClose = null;
    document.removeEventListener('keydown', onKeydown);
  }

  var onKeydown = safe(function (e) {
    if (e.key === 'Escape') closeDialog();
  });

  // ---- icons + issue reference --------------------------------------------

  var IT_SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attrs) {
    var n = document.createElementNS(IT_SVG_NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function iconSvg(kids) {
    var svg = svgNode('svg', {
      viewBox: '0 0 24 24', width: '13', height: '13', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    for (var i = 0; i < kids.length; i++) svg.appendChild(kids[i]);
    return svg;
  }
  function copyIcon() {
    return iconSvg([
      svgNode('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }),
      svgNode('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
    ]);
  }
  function checkIcon() {
    return iconSvg([svgNode('path', { d: 'M20 6L9 17l-5-5' })]);
  }

  // Agent-ready reference, matching the board's copy button, so a pasted
  // "VibeOps issue <id>" resolves via the tracker's MCP get_issue tool.
  function issueRef(issue) {
    var title = (issue.title || '').trim();
    return 'VibeOps issue ' + issue.id + (title ? ': "' + title + '"' : '');
  }

  // Toast content is plain text, an explicit link, or a static copy control,
  // never HTML from the tracker, so a compromised response cannot inject markup.
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
    if (parts.copyText) {
      var cp = el('button', 'it-copyref');
      cp.type = 'button';
      cp.title = 'Copy a reference to paste to an agent';
      cp.setAttribute('aria-label', 'Copy issue reference');
      cp.appendChild(copyIcon());
      cp.addEventListener('click', safe(function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) return;
        navigator.clipboard.writeText(parts.copyText).then(
          safe(function () {
            cp.replaceChildren(checkIcon());
            cp.classList.add('it-copied');
            setTimeout(safe(function () { cp.replaceChildren(copyIcon()); cp.classList.remove('it-copied'); }), 1400);
          }),
          function () {}
        );
      }));
      t.appendChild(cp);
    }
    if (parts.suffix) t.appendChild(document.createTextNode(parts.suffix));
    document.body.appendChild(t);
    // Auto-dismiss, but pause while hovered so there is time to grab the reference.
    var timer = setTimeout(safe(function () { t.remove(); }), ms || 6000);
    t.addEventListener('mouseenter', function () { clearTimeout(timer); });
    t.addEventListener('mouseleave', function () { timer = setTimeout(safe(function () { t.remove(); }), 2500); });
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

    // Guard the draft: a click on the backdrop (outside the dialog) must not
    // discard a started report. An untouched, empty form still dismisses on an
    // outside click; once anything is typed the dialog is sticky and closes
    // only via ×, Cancel, or Escape. A brief shake makes that stickiness felt,
    // so the no-op does not read as a frozen dialog.
    function isDirty() {
      return !!(
        (title && title.value.trim()) ||
        (seeing && seeing.value.trim()) ||
        (expecting && expecting.value.trim()) ||
        (tags && tags.isDirty())
      );
    }
    function nudge() {
      var d = ui.dialog;
      if (!d) return;
      d.classList.remove('it-shake');
      void d.offsetWidth; // reflow so the shake replays on every stray click
      d.classList.add('it-shake');
    }

    ui.backdrop = el('div', 'it-backdrop');
    ui.backdrop.setAttribute('data-issue-tracker-ui', '1');
    ui.backdrop.addEventListener('click', safe(function () {
      if (isDirty()) { nudge(); return; }
      closeDialog();
    }));
    document.body.appendChild(ui.backdrop);

    var d = el('div', 'it-dialog');
    d.setAttribute('data-issue-tracker-ui', '1');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Report an issue');

    // Keystrokes typed in the dialog stay in the dialog. Host pages often bind
    // document-level shortcuts (arrow-key navigation and the like) that
    // preventDefault, which silently kills native editing such as shift+arrow
    // selection in our fields. Escape is handled here because the document
    // listener behind it never sees keys pressed inside the dialog anymore.
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      d.addEventListener(
        type,
        safe(function (e) {
          if (type === 'keydown' && e.key === 'Escape') closeDialog();
          e.stopPropagation();
        })
      );
    });

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
    tagsRow.appendChild(el('span', 'it-label', 'Tags'));
    var tags = tagField();
    tagsRow.appendChild(tags.root);
    body.appendChild(tagsRow);
    tagOutsideClose = tags.outsideClose;

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

  // Single module-level pair of drag listeners, so repeated dialog opens do not
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

  // ---- tag suggestions ------------------------------------------------------
  // The board's tag field, minus vocabulary editing (rename / merge / delete
  // live on the board; the tracker refuses cross-origin tag maintenance).
  // Focusing lists the project's most-used tags with counts, typing filters
  // them, an unknown name gets an explicit "new tag" row, and recently used
  // tags sit under the field one click away. Picking a tag commits a chip and
  // closes the list. The vocabulary fetch is best-effort: an offline tracker
  // or an older server just means no suggestions, and the field still accepts
  // comma-typed tags like before.

  // Single module-level outside-click listener (like the drag listeners), so
  // repeated dialog opens never accumulate document handlers.
  var tagOutsideClose = null;
  document.addEventListener(
    'mousedown',
    safe(function (e) {
      if (tagOutsideClose) tagOutsideClose(e);
    })
  );

  function tagField() {
    var vocab = []; // [{name, count, lastUsed}] from the tracker
    var selected = [];
    var open = false;
    var active = -1;

    var root = el('div', 'it-tagfield');
    var box = el('div', 'it-tagbox');
    var input = el('input', 'it-tags');
    input.placeholder = 'Type to search or create…';
    input.setAttribute('autocomplete', 'off');
    box.appendChild(input);
    var dd = el('div', 'it-dd');
    var list = el('div', 'it-dd-list');
    dd.appendChild(list);
    var recent = el('div', 'it-recent');
    root.appendChild(box);
    root.appendChild(dd);
    root.appendChild(recent);

    function query() {
      return input.value.trim().toLowerCase();
    }
    function knownName(name) {
      for (var i = 0; i < vocab.length; i++) {
        if (vocab[i].name.toLowerCase() === name.toLowerCase()) return vocab[i].name;
      }
      return null;
    }
    function matches() {
      var q = query();
      return vocab
        .filter(function (t) {
          return selected.indexOf(t.name) === -1 && (!q || t.name.toLowerCase().indexOf(q) !== -1);
        })
        .sort(function (a, b) {
          return b.count - a.count || a.name.localeCompare(b.name);
        });
    }

    function addTag(name) {
      name = name.replace(/,/g, '').trim();
      if (!name) return;
      name = knownName(name) || name;
      if (selected.indexOf(name) === -1) selected.push(name);
      input.value = '';
      active = -1;
      open = false;
      renderAll();
      try {
        input.blur();
      } catch (_) {}
    }

    function renderChips() {
      box.querySelectorAll('.it-chip').forEach(function (c) {
        c.remove();
      });
      selected.forEach(function (name) {
        var chip = el('span', 'it-chip', name);
        var x = el('button', 'it-chip-x', '×');
        x.setAttribute('type', 'button');
        x.setAttribute('aria-label', 'Remove tag ' + name);
        x.addEventListener(
          'click',
          safe(function (e) {
            e.stopPropagation();
            selected = selected.filter(function (n) {
              return n !== name;
            });
            renderAll();
          })
        );
        chip.appendChild(x);
        box.insertBefore(chip, input);
      });
    }

    function renderRecent() {
      while (recent.firstChild) recent.removeChild(recent.firstChild);
      var latest = vocab
        .filter(function (t) {
          return selected.indexOf(t.name) === -1;
        })
        .sort(function (a, b) {
          return String(b.lastUsed).localeCompare(String(a.lastUsed));
        })
        .slice(0, 6);
      if (!latest.length) return;
      recent.appendChild(el('span', 'it-recent-label', 'Recent:'));
      latest.forEach(function (t) {
        var b = el('button', 'it-recent-chip');
        b.setAttribute('type', 'button');
        b.appendChild(el('span', null, '+'));
        b.appendChild(document.createTextNode(t.name));
        b.addEventListener(
          'click',
          safe(function () {
            addTag(t.name);
          })
        );
        recent.appendChild(b);
      });
    }

    function highlightName(name) {
      var holder = el('span', 'it-dd-name');
      var q = query();
      var i = q ? name.toLowerCase().indexOf(q) : -1;
      if (i < 0) {
        holder.textContent = name;
        return holder;
      }
      holder.appendChild(document.createTextNode(name.slice(0, i)));
      holder.appendChild(el('b', null, name.slice(i, i + q.length)));
      holder.appendChild(document.createTextNode(name.slice(i + q.length)));
      return holder;
    }

    function paintActive() {
      var rows = list.querySelectorAll('.it-dd-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('it-active', i === active);
    }

    function renderDd() {
      while (list.firstChild) list.removeChild(list.firstChild);
      var rows = matches();
      var q = query();
      var creatable =
        q &&
        !knownName(q) &&
        !selected.some(function (n) {
          return n.toLowerCase() === q;
        });
      active = Math.min(active, rows.length - (creatable ? 0 : 1));

      rows.forEach(function (t, i) {
        var row = el('div', 'it-dd-row' + (i === active ? ' it-active' : ''));
        row.appendChild(highlightName(t.name));
        row.appendChild(el('span', 'it-dd-count', String(t.count)));
        row.addEventListener(
          'click',
          safe(function () {
            addTag(t.name);
          })
        );
        row.addEventListener(
          'mousemove',
          safe(function () {
            if (active !== i) {
              active = i;
              paintActive();
            }
          })
        );
        list.appendChild(row);
      });

      if (creatable) {
        var createRow = el('div', 'it-dd-row it-dd-create' + (active === rows.length ? ' it-active' : ''));
        createRow.appendChild(el('span', 'it-dd-plus', '+'));
        var label = el('span', 'it-dd-name');
        label.appendChild(document.createTextNode('Create “'));
        label.appendChild(el('b', null, input.value.trim()));
        label.appendChild(document.createTextNode('”'));
        createRow.appendChild(label);
        createRow.appendChild(el('span', 'it-dd-new', 'new tag'));
        createRow.addEventListener(
          'click',
          safe(function () {
            addTag(input.value);
          })
        );
        createRow.addEventListener(
          'mousemove',
          safe(function () {
            active = rows.length;
            paintActive();
          })
        );
        list.appendChild(createRow);
      }

      // Nothing to suggest and nothing typed: keep the list closed rather than
      // showing an empty box.
      dd.classList.toggle('it-open', open && !!list.children.length);
    }

    function renderAll() {
      renderChips();
      renderRecent();
      renderDd();
    }

    box.addEventListener(
      'click',
      safe(function () {
        try {
          input.focus();
        } catch (_) {}
      })
    );
    input.addEventListener(
      'focus',
      safe(function () {
        open = true;
        renderDd();
      })
    );
    input.addEventListener(
      'input',
      safe(function () {
        open = true;
        active = query() ? 0 : -1;
        renderDd();
      })
    );
    input.addEventListener(
      'keydown',
      safe(function (e) {
        var rowCount = list.querySelectorAll('.it-dd-row').length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          open = true;
          active = Math.min(active + 1, rowCount - 1);
          renderDd();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          active = Math.max(active - 1, 0);
          renderDd();
        } else if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          var rows = list.querySelectorAll('.it-dd-row');
          if (active >= 0 && rows[active]) rows[active].click();
          else if (query()) addTag(input.value);
        } else if (e.key === 'Escape') {
          if (open && list.children.length) e.stopPropagation(); // eat it so the dialog stays open
          open = false;
          renderDd();
        } else if (e.key === 'Backspace' && !input.value && selected.length) {
          selected.pop();
          renderAll();
        }
      })
    );

    window
      .fetch(endpoint + '/api/projects/' + encodeURIComponent(project) + '/tags')
      .then(function (res) {
        return res.ok ? res.json() : [];
      })
      .then(
        safe(function (data) {
          if (!Array.isArray(data)) return;
          vocab = data.filter(function (t) {
            return t && typeof t.name === 'string';
          });
          renderRecent();
          if (open) renderDd();
        })
      )
      .catch(function (_) {});

    return {
      root: root,
      isDirty: function () {
        return !!(selected.length || input.value.trim());
      },
      outsideClose: function (e) {
        if (open && !root.contains(e.target)) {
          open = false;
          renderDd();
        }
      },
      // Selected chips plus whatever is still typed in the field, so an
      // uncommitted tag isn't lost when the reporter goes straight to submit.
      getTags: function () {
        var out = selected.slice();
        input.value.split(',').forEach(function (part) {
          var name = part.trim();
          if (!name) return;
          name = knownName(name) || name;
          if (out.indexOf(name) === -1) out.push(name);
        });
        return out;
      },
    };
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
      tags: f.tags.getTags(),
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
            copyText: issueRef(issue),
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
    fab.title = 'Report an issue (drag to move it up or down)';

    // The FAB stays pinned to the right edge, but you can drag it vertically so
    // it never covers the host app. The chosen position is remembered per origin.
    // A plain click (no drag) still opens the capture dialog.
    var FAB_POS_KEY = 'itFabBottom';
    var FAB_SIZE = 52; // matches .it-fab width/height in CSS
    function clampBottom(px) {
      var max = Math.max(8, window.innerHeight - FAB_SIZE - 8);
      return Math.min(Math.max(8, px), max);
    }
    try {
      var savedBottom = parseFloat(window.localStorage.getItem(FAB_POS_KEY));
      if (!isNaN(savedBottom)) fab.style.bottom = clampBottom(savedBottom) + 'px';
    } catch (_) {}

    var fabDrag = null;
    var fabWasDragged = false;

    fab.addEventListener(
      'mousedown',
      safe(function (e) {
        // Capture any current selection (always reassign so a previous capture's
        // selection can never leak into a later, unrelated report).
        var sel = window.getSelection ? String(window.getSelection()) : '';
        state.selectedText = sel.slice(0, 500);
        // Begin a potential drag.
        fabWasDragged = false;
        var rect = fab.getBoundingClientRect();
        fabDrag = { startY: e.clientY, startBottom: window.innerHeight - rect.bottom };
        e.preventDefault();
      })
    );

    document.addEventListener(
      'mousemove',
      safe(function (e) {
        if (!fabDrag) return;
        var dy = fabDrag.startY - e.clientY; // dragging up increases bottom
        if (!fabWasDragged && Math.abs(dy) > 4) {
          fabWasDragged = true;
          fab.classList.add('it-dragging');
        }
        if (fabWasDragged) fab.style.bottom = clampBottom(fabDrag.startBottom + dy) + 'px';
      })
    );

    document.addEventListener(
      'mouseup',
      safe(function () {
        if (!fabDrag) return;
        fabDrag = null;
        if (fabWasDragged) {
          fab.classList.remove('it-dragging');
          try {
            window.localStorage.setItem(FAB_POS_KEY, String(parseFloat(fab.style.bottom)));
          } catch (_) {}
        }
      })
    );

    fab.addEventListener(
      'click',
      safe(function () {
        // Swallow the click that ends a drag; a real click opens the dialog.
        if (fabWasDragged) {
          fabWasDragged = false;
          return;
        }
        openDialog();
      })
    );
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
