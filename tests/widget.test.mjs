import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const WIDGET_SRC = fs.readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

function loadWidget({ project = 'platform', fetchImpl, beforeEval } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><h1>Host app</h1><button id="host-btn" data-x="1">Save</button></body></html>',
    { url: 'http://localhost:4556/page?tab=main', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const calls = [];
  window.fetch =
    fetchImpl ||
    ((url, opts = {}) => {
      calls.push({ url: String(url), opts });
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'platform-1' }) });
    });
  const tag = window.document.createElement('script');
  tag.src = 'http://localhost:4400/widget.js';
  tag.setAttribute('data-project', project);
  window.document.body.appendChild(tag);
  if (beforeEval) beforeEval(window);
  window.eval(WIDGET_SRC);
  return { window, document: window.document, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function openDialog(document) {
  document.querySelector('.it-fab').dispatchEvent(new document.defaultView.MouseEvent('mousedown', { bubbles: true }));
  document.querySelector('.it-fab').click();
}

function fillAndSubmit(document, { seeing = 'I see breakage', expecting = 'It should work', title = 'My bug', tags = 'auth, ui' } = {}) {
  document.querySelector('.it-title').value = title;
  document.querySelector('.it-seeing').value = seeing;
  document.querySelector('.it-expecting').value = expecting;
  document.querySelector('.it-tags').value = tags;
  document.querySelector('.it-submit').click();
}

test('loading the widget renders the FAB', () => {
  const { document } = loadWidget();
  const fab = document.querySelector('.it-fab');
  assert.ok(fab, 'FAB should exist');
  assert.ok(document.querySelector('style[data-issue-tracker]'), 'styles injected');
});

test('the FAB drags vertically and suppresses the dialog; a plain click still opens it', () => {
  const { window, document } = loadWidget();
  const fab = document.querySelector('.it-fab');
  const md = (clientY) => fab.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientY }));
  const move = (clientY) => document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientY }));
  const up = () => document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  const click = () => fab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // Drag upward past the threshold, then the click that ends the drag.
  md(500); move(490); move(360); up(); click();
  assert.equal(document.querySelector('.it-dialog'), null, 'a drag does not open the dialog');
  assert.ok(fab.style.bottom, 'a vertical position was applied');
  assert.ok(window.localStorage.getItem('itFabBottom'), 'the position was persisted');

  // A plain click (no movement) still opens the dialog.
  md(300); up(); click();
  assert.ok(document.querySelector('.it-dialog'), 'a plain click opens the dialog');
});

test('the FAB restores its saved vertical position on load', () => {
  const { document } = loadWidget({ beforeEval: (win) => win.localStorage.setItem('itFabBottom', '200') });
  assert.equal(document.querySelector('.it-fab').style.bottom, '200px');
});

test('widget aborts politely without data-project', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x.test/', runScripts: 'outside-only' });
  const tag = dom.window.document.createElement('script');
  tag.src = 'http://localhost:4400/widget.js';
  dom.window.document.body.appendChild(tag);
  dom.window.eval(WIDGET_SRC); // must not throw
  assert.equal(dom.window.document.querySelector('.it-fab'), null);
});

test('clicking FAB opens the dialog with all fields', () => {
  const { document } = loadWidget();
  openDialog(document);
  assert.ok(document.querySelector('.it-dialog'));
  assert.equal(document.querySelectorAll('.it-type-pill').length, 4);
  assert.ok(document.querySelector('.it-title'));
  assert.ok(document.querySelector('.it-seeing'));
  assert.ok(document.querySelector('.it-expecting'));
  assert.equal(document.querySelectorAll('.it-sev').length, 5);
  assert.ok(document.querySelector('.it-tags'));
  assert.ok(document.querySelector('.it-trail'), 'activity trail toggle');
});

test('submit with empty required fields shows error and does not POST', async () => {
  const { document, calls } = loadWidget();
  openDialog(document);
  document.querySelector('.it-submit').click();
  await tick();
  const err = document.querySelector('.it-error');
  assert.ok(err && err.textContent.length > 0, 'inline error shown');
  assert.equal(calls.filter((c) => c.url.includes('/api/issues')).length, 0);
  assert.ok(document.querySelector('.it-dialog'), 'dialog stays open');
});

test('filled submit POSTs the right payload with captured context', async () => {
  const { window, document, calls } = loadWidget();
  window.IssueTracker.configure({ context: () => ({ tab: 'candidates', custom: 42 }) });

  // generate some breadcrumbs
  const hostBtn = document.querySelector('#host-btn');
  for (let i = 0; i < 3; i++) hostBtn.click();
  await window.fetch('http://localhost:4556/api/things', { method: 'GET' });
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'Kaboom', error: new Error('Kaboom') }));

  openDialog(document);
  document.querySelectorAll('.it-type-pill')[2].click(); // feature
  document.querySelector('.it-trail').click(); // feature defaults trail off; reporter re-enables it
  document.querySelectorAll('.it-sev')[4].click(); // severity 5
  fillAndSubmit(document);
  await tick();

  const post = calls.find((c) => c.url === 'http://localhost:4400/api/issues');
  assert.ok(post, 'POST to tracker endpoint derived from script src');
  assert.equal(post.opts.method, 'POST');
  const payload = JSON.parse(post.opts.body);
  assert.equal(payload.project, 'platform');
  assert.equal(payload.title, 'My bug');
  assert.equal(payload.type, 'feature');
  assert.equal(payload.severity, 5);
  assert.deepEqual(payload.tags, ['auth', 'ui']);
  assert.equal(payload.seeing, 'I see breakage');
  assert.equal(payload.expecting, 'It should work');

  const ctx = payload.context;
  assert.equal(ctx.url, 'http://localhost:4556/page?tab=main');
  assert.ok(ctx.viewport.w > 0 && ctx.viewport.h > 0);
  assert.ok(ctx.userAgent.length > 0);
  assert.ok(ctx.capturedAt);
  assert.equal(ctx.clickBreadcrumbs.length >= 3, true, 'click breadcrumbs recorded');
  assert.equal(ctx.clickBreadcrumbs.at(-1).id, 'host-btn');
  assert.ok(ctx.fetchBreadcrumbs.some((f) => f.url.includes('/api/things')));
  assert.ok(ctx.recentErrors.some((e) => e.message.includes('Kaboom')));
  assert.deepEqual(ctx.app, { tab: 'candidates', custom: 42 });

  await tick();
  assert.equal(document.querySelector('.it-dialog'), null, 'dialog closes on success');
  assert.ok(document.querySelector('.it-toast'), 'success toast shown');
});

test('widget clicks are excluded from breadcrumbs; buffers cap at 10', async () => {
  const { document, calls } = loadWidget();
  const hostBtn = document.querySelector('#host-btn');
  for (let i = 0; i < 14; i++) hostBtn.click();
  openDialog(document);
  document.querySelector('.it-seeing').click(); // widget-internal click
  fillAndSubmit(document);
  await tick();
  const payload = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body);
  assert.equal(payload.context.clickBreadcrumbs.length, 10);
  assert.ok(payload.context.clickBreadcrumbs.every((b) => b.id === 'host-btn'));
});

test('tracker POSTs are excluded from fetch breadcrumbs', async () => {
  const { document, calls } = loadWidget();
  openDialog(document);
  fillAndSubmit(document);
  await tick();
  openDialog(document);
  fillAndSubmit(document, { title: 'second' });
  await tick();
  const posts = calls.filter((c) => c.url.endsWith('/api/issues'));
  assert.equal(posts.length, 2);
  const payload = JSON.parse(posts[1].opts.body);
  assert.ok(!payload.context.fetchBreadcrumbs.some((f) => f.url.includes('4400')), 'tracker traffic not in breadcrumbs');
});

test('failed POST keeps dialog open and shows error, never throws', async () => {
  const calls = [];
  const { document } = loadWidget({
    fetchImpl: (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      return Promise.reject(new Error('ECONNREFUSED'));
    },
  });
  openDialog(document);
  fillAndSubmit(document);
  await tick();
  await tick();
  assert.ok(document.querySelector('.it-dialog'), 'dialog stays open so input is not lost');
  const err = document.querySelector('.it-error');
  assert.ok(err && /tracker|reach|fail/i.test(err.textContent));
});

test('Escape closes the dialog', () => {
  const { window, document } = loadWidget();
  openDialog(document);
  assert.ok(document.querySelector('.it-dialog'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.it-dialog'), null);
});

test('a backdrop click with a typed draft keeps the dialog open (draft is not lost)', () => {
  const { document } = loadWidget();
  openDialog(document);
  document.querySelector('.it-seeing').value = 'A long report I do not want to lose to a stray click';
  document.querySelector('.it-backdrop').click();
  assert.ok(document.querySelector('.it-dialog'), 'dialog stays open when there is a draft');
  assert.ok(
    document.querySelector('.it-dialog').classList.contains('it-shake'),
    'a nudge signals the dialog is intentionally sticky'
  );
});

test('a backdrop click on an untouched dialog still dismisses it', () => {
  const { document } = loadWidget();
  openDialog(document);
  document.querySelector('.it-backdrop').click();
  assert.equal(document.querySelector('.it-dialog'), null, 'empty dialog dismisses on outside click');
  assert.equal(document.querySelector('.it-backdrop'), null, 'backdrop removed too');
});

test('window.IssueTracker public API exists', () => {
  const { window } = loadWidget();
  assert.equal(typeof window.IssueTracker.configure, 'function');
  assert.equal(typeof window.IssueTracker.open, 'function');
});

test('loading the script twice does not double-mount or double-wrap fetch', async () => {
  const { window, document, calls } = loadWidget();
  window.eval(WIDGET_SRC); // second load
  assert.equal(document.querySelectorAll('.it-fab').length, 1, 'one FAB only');
  await window.fetch('http://localhost:4556/api/things');
  openDialog(document);
  fillAndSubmit(document);
  await tick();
  const payload = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body);
  const hits = payload.context.fetchBreadcrumbs.filter((f) => f.url.includes('/api/things'));
  assert.equal(hits.length, 1, 'fetch recorded exactly once');
});

test('toast renders server-provided issue id as text, never as HTML', async () => {
  const calls = [];
  const { document } = loadWidget({
    fetchImpl: (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: '<img src=x onerror=alert(1)>' }) });
    },
  });
  openDialog(document);
  fillAndSubmit(document);
  await tick();
  await tick();
  const toast = document.querySelector('.it-toast');
  assert.ok(toast, 'toast shown');
  assert.equal(toast.querySelector('img'), null, 'no HTML injected');
  assert.ok(toast.textContent.includes('<img src=x onerror=alert(1)>'), 'id shown as literal text');
});

test('the capture toast copies an agent-ready reference for pasting to an agent', async () => {
  const { window, document } = loadWidget({
    fetchImpl: () => Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'platform-9', title: 'My bug' }) }),
  });
  let copied = null;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { copied = t; return Promise.resolve(); } },
  });
  openDialog(document);
  fillAndSubmit(document);
  await tick();
  await tick();
  const cp = document.querySelector('.it-toast .it-copyref');
  assert.ok(cp, 'copy-reference button in the toast');
  assert.equal(cp.getAttribute('aria-label'), 'Copy issue reference');
  cp.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(copied, 'VibeOps issue platform-9: "My bug"', 'copies the branded id + title reference');
});

test('highlighted text is previewed in the dialog and attached to the payload', async () => {
  const { window, document, calls } = loadWidget();
  window.getSelection = () => ({ toString: () => 'the broken label' });
  openDialog(document);
  const preview = document.querySelector('.it-selection');
  assert.ok(preview, 'selection preview shown in dialog');
  assert.equal(preview.textContent, 'the broken label');
  fillAndSubmit(document);
  await tick();
  const payload = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body);
  assert.equal(payload.context.selectedText, 'the broken label');
});

test('a stale selection from a canceled dialog never leaks into a later report', async () => {
  const { window, document, calls } = loadWidget();
  window.getSelection = () => ({ toString: () => 'old selection' });
  openDialog(document);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  window.getSelection = () => ({ toString: () => '' });
  openDialog(document);
  assert.equal(document.querySelector('.it-selection'), null, 'no preview without a live selection');
  fillAndSubmit(document);
  await tick();
  const payload = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body);
  assert.equal(payload.context.selectedText, '');
});

test('Remove detaches the highlighted text from the report', async () => {
  const { window, document, calls } = loadWidget();
  window.getSelection = () => ({ toString: () => 'grabbed by accident' });
  openDialog(document);
  document.querySelector('.it-selremove').click();
  assert.equal(document.querySelector('.it-selection'), null, 'preview removed');
  fillAndSubmit(document);
  await tick();
  const payload = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body);
  assert.equal(payload.context.selectedText, '');
});

test('activity-trail checkbox defaults by type until manually overridden', () => {
  const { document } = loadWidget();
  openDialog(document);
  const trail = document.querySelector('.it-trail');
  assert.equal(trail.checked, true, 'bug (default type) starts with trail on');
  document.querySelectorAll('.it-type-pill')[1].click(); // improvement
  assert.equal(trail.checked, false, 'non-bug type defaults trail off');
  document.querySelectorAll('.it-type-pill')[0].click(); // back to bug
  assert.equal(trail.checked, true);
  document.querySelectorAll('.it-type-pill')[1].click(); // improvement again
  trail.click(); // manual re-enable
  assert.equal(trail.checked, true);
  document.querySelectorAll('.it-type-pill')[2].click(); // feature
  assert.equal(trail.checked, true, 'manual choice sticks across type changes');
});

test('unchecked trail omits clicks/network/errors but keeps page context', async () => {
  const { window, document, calls } = loadWidget();
  window.IssueTracker.configure({ context: () => ({ tab: 'jobs' }) });
  document.querySelector('#host-btn').click();
  await window.fetch('http://localhost:4556/api/things');
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'Kaboom', error: new Error('Kaboom') }));
  openDialog(document);
  document.querySelectorAll('.it-type-pill')[1].click(); // improvement → trail off
  fillAndSubmit(document);
  await tick();
  const ctx = JSON.parse(calls.find((c) => c.url.endsWith('/api/issues')).opts.body).context;
  assert.ok(!('clickBreadcrumbs' in ctx), 'no click trail');
  assert.ok(!('fetchBreadcrumbs' in ctx), 'no fetch trail');
  assert.ok(!('recentErrors' in ctx), 'no error log');
  assert.ok(!('recentFetchFailures' in ctx), 'no failure log');
  assert.equal(ctx.url, 'http://localhost:4556/page?tab=main');
  assert.ok(ctx.capturedAt && ctx.userAgent && ctx.viewport.w > 0, 'page context kept');
  assert.deepEqual(ctx.app, { tab: 'jobs' }, 'app context kept');
});

test('repeated dialog open/close does not accumulate document keydown/drag listeners', () => {
  const { window, document } = loadWidget();
  for (let i = 0; i < 5; i++) {
    openDialog(document);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  openDialog(document);
  // dispatch a mousemove: with leaked per-open handlers this would throw on stale state;
  // primarily we assert a single dialog and working close after churn
  document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
  assert.equal(document.querySelectorAll('.it-dialog').length, 1);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.it-dialog'), null);
});

// ---- tag suggestions --------------------------------------------------------

const VOCAB = [
  { name: 'ux', count: 4, lastUsed: '2026-07-01T00:00:00Z' },
  { name: 'widget', count: 2, lastUsed: '2026-07-03T00:00:00Z' },
  { name: 'mcp', count: 1, lastUsed: '2026-07-02T00:00:00Z' },
];

function loadWidgetWithVocab(vocabResponse) {
  const calls = [];
  const loaded = loadWidget({
    fetchImpl: (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('/api/projects/platform/tags')) return vocabResponse();
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'platform-1' }) });
    },
  });
  return { ...loaded, calls };
}

test('tag field lists fetched vocabulary; clicking a suggestion commits a chip and closes the list', async () => {
  const { window, document, calls } = loadWidgetWithVocab(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => VOCAB })
  );
  openDialog(document);
  await tick(); // vocabulary fetch resolves

  // recent row: most recently used first
  const recents = [...document.querySelectorAll('.it-recent-chip')].map((b) => b.textContent);
  assert.deepEqual(recents, ['+widget', '+mcp', '+ux']);

  // focusing lists suggestions, most used first, with counts
  document.querySelector('.it-tags').focus();
  const rows = [...document.querySelectorAll('.it-dd-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.it-dd-name').textContent), ['ux', 'widget', 'mcp']);
  assert.deepEqual(rows.map((r) => r.querySelector('.it-dd-count').textContent), ['4', '2', '1']);

  rows[0].click(); // pick "ux"
  assert.match(document.querySelector('.it-chip').textContent, /^ux/);
  assert.equal(document.querySelector('.it-dd.it-open'), null, 'list closes after picking');

  // chips + uncommitted typed text both reach the payload
  document.querySelector('.it-seeing').value = 's';
  document.querySelector('.it-expecting').value = 'e';
  document.querySelector('.it-tags').value = 'infra';
  document.querySelector('.it-submit').click();
  await tick();
  const post = calls.find((c) => c.url === 'http://localhost:4400/api/issues');
  assert.deepEqual(JSON.parse(post.opts.body).tags, ['ux', 'infra']);
});

test('typing an unknown tag shows an explicit new-tag row; a known one does not', async () => {
  const { document } = loadWidgetWithVocab(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => VOCAB })
  );
  openDialog(document);
  await tick();

  const input = document.querySelector('.it-tags');
  input.focus();
  input.value = 'infra';
  input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  const create = document.querySelector('.it-dd-create');
  assert.ok(create, 'create row appears for an unknown name');
  assert.match(create.textContent, /Create “infra”/);
  assert.match(create.textContent, /new tag/);

  input.value = 'ux';
  input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('.it-dd-create'), null, 'no create row for an existing tag');
});

test('a failed vocabulary fetch never breaks the dialog; typed tags still submit', async () => {
  const { document, calls } = loadWidgetWithVocab(() => Promise.reject(new Error('tracker offline')));
  openDialog(document);
  await tick();

  assert.ok(document.querySelector('.it-dialog'), 'dialog opened despite failed fetch');
  assert.equal(document.querySelectorAll('.it-recent-chip').length, 0);
  document.querySelector('.it-seeing').value = 's';
  document.querySelector('.it-expecting').value = 'e';
  document.querySelector('.it-tags').value = 'auth, ui';
  document.querySelector('.it-submit').click();
  await tick();
  const post = calls.find((c) => c.url === 'http://localhost:4400/api/issues');
  assert.deepEqual(JSON.parse(post.opts.body).tags, ['auth', 'ui']);
});

test('a committed chip makes the dialog sticky against backdrop clicks', async () => {
  const { document } = loadWidgetWithVocab(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => VOCAB })
  );
  openDialog(document);
  await tick();
  document.querySelector('.it-recent-chip').click(); // commit a chip, nothing typed
  document.querySelector('.it-backdrop').click();
  assert.ok(document.querySelector('.it-dialog'), 'chips count as a started draft');
});
