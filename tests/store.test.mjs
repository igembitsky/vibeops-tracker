import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUSES,
  listProjects,
  ensureProject,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addComment,
  resolveIssue,
  sweepDone,
  listClosed,
  searchIssues,
  deleteIssue,
  iceboxIssue,
  reviveIssue,
  listIcebox,
} from '../lib/store.mjs';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tracker-test-'));
}

test('STATUSES exposes the workflow in order', () => {
  assert.deepEqual(STATUSES, ['backlog', 'on-deck', 'in-progress', 'in-review', 'done']);
});

test('on-deck sits between backlog and in-progress in priority order', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'a', seeing: 's', expecting: 'e' }); // backlog
  const b = createIssue(dir, { project: 'p', title: 'b', seeing: 's', expecting: 'e' });
  const c = createIssue(dir, { project: 'p', title: 'c', seeing: 's', expecting: 'e' });
  updateIssue(dir, b.id, { status: 'on-deck' });
  updateIssue(dir, c.id, { status: 'in-progress' });
  assert.equal(getIssue(dir, b.id).status, 'on-deck', 'on-deck is a valid status');
  assert.deepEqual(listIssues(dir, 'p').map((i) => i.id), [a.id, b.id, c.id], 'backlog, then on-deck, then in-progress');
});

test('ensureProject creates registry entries; explicit name upserts', () => {
  const dir = tmpDataDir();
  assert.deepEqual(listProjects(dir), []);
  const p = ensureProject(dir, 'platform', 'Platform');
  assert.deepEqual(p, { key: 'platform', name: 'Platform' });
  ensureProject(dir, 'platform', 'Renamed');
  assert.deepEqual(listProjects(dir), [{ key: 'platform', name: 'Renamed' }]);
  ensureProject(dir, 'other');
  assert.deepEqual(listProjects(dir).map((p) => p.key).sort(), ['other', 'platform']);
});

test('createIssue assigns sequential per-project ids and sensible defaults', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'platform', title: 'Login button broken', seeing: 'It breaks', expecting: 'It works' });
  assert.equal(a.id, 'platform-1');
  assert.equal(a.status, 'backlog');
  assert.equal(a.severity, 3);
  assert.equal(a.type, 'other');
  assert.deepEqual(a.tags, []);
  assert.equal(a.ordinal, 1000);
  assert.equal(a.project, 'platform');
  assert.ok(a.created && a.updated);

  const b = createIssue(dir, { project: 'platform', seeing: 'x', expecting: 'y' });
  assert.equal(b.id, 'platform-2');
  assert.equal(b.ordinal, 2000);

  const c = createIssue(dir, { project: 'other', seeing: 'x', expecting: 'y' });
  assert.equal(c.id, 'other-1');

  const files = fs.readdirSync(path.join(dir, 'platform', 'issues'));
  assert.ok(files.some((f) => /^platform-1-login-button-broken\.md$/.test(f)), files.join(','));
  // project auto-registered
  assert.ok(listProjects(dir).some((p) => p.key === 'platform'));
});

test('issue round-trips body sections, context, and tricky content', () => {
  const dir = tmpDataDir();
  const context = {
    url: 'http://localhost:4556/page?q=1',
    viewport: { w: 1512, h: 944 },
    userAgent: 'TestAgent/1.0',
    clickBreadcrumbs: [{ tag: 'BUTTON', id: 'save', text: 'Save' }],
    recentErrors: [{ message: 'boom', stack: 'Error: boom\n  at x.js:1' }],
    app: { tab: 'candidates' },
  };
  const made = createIssue(dir, {
    project: 'platform',
    title: 'Weird chars & "quotes"',
    type: 'bug',
    severity: 5,
    tags: ['auth', 'ui'],
    seeing: 'Code fence inside: ```js\nfoo()\n``` and --- dashes',
    expecting: 'Multi\n\nparagraph expectation',
    context,
    relatedTo: 'platform-0',
  });
  const got = getIssue(dir, made.id);
  assert.equal(got.title, 'Weird chars & "quotes"');
  assert.equal(got.type, 'bug');
  assert.equal(got.severity, 5);
  assert.deepEqual(got.tags, ['auth', 'ui']);
  assert.equal(got.relatedTo, 'platform-0');
  assert.equal(got.seeing, 'Code fence inside: ```js\nfoo()\n``` and --- dashes');
  assert.equal(got.expecting, 'Multi\n\nparagraph expectation');
  assert.deepEqual(got.context, context);
  assert.deepEqual(got.comments, []);
  assert.ok(got.file.endsWith('.md'));
});

test('getIssue returns null for unknown id', () => {
  const dir = tmpDataDir();
  assert.equal(getIssue(dir, 'platform-99'), null);
  createIssue(dir, { project: 'platform', seeing: 'x', expecting: 'y' });
  assert.equal(getIssue(dir, 'platform-99'), null);
});

test('listIssues sorts by status order then ordinal, supports status filter', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 'a', expecting: 'a' }); // ordinal 1000
  const b = createIssue(dir, { project: 'p', seeing: 'b', expecting: 'b' }); // 2000
  const c = createIssue(dir, { project: 'p', seeing: 'c', expecting: 'c' }); // 3000
  updateIssue(dir, b.id, { status: 'in-progress' });
  updateIssue(dir, c.id, { ordinal: 500 });
  const all = listIssues(dir, 'p');
  assert.deepEqual(all.map((i) => i.id), [c.id, a.id, b.id]); // backlog (500, 1000) then in-progress
  const wip = listIssues(dir, 'p', { status: 'in-progress' });
  assert.deepEqual(wip.map((i) => i.id), [b.id]);
  assert.deepEqual(listIssues(dir, 'nonexistent'), []);
});

test('updateIssue patches allowed fields, bumps updated, rejects bad input', async () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 't', seeing: 's', expecting: 'e' });
  await new Promise((r) => setTimeout(r, 5));
  const patched = updateIssue(dir, a.id, { status: 'in-review', severity: 1, title: 'New title', tags: ['x'], type: 'feature', ordinal: 1500 });
  assert.equal(patched.status, 'in-review');
  assert.equal(patched.severity, 1);
  assert.equal(patched.title, 'New title');
  assert.deepEqual(patched.tags, ['x']);
  assert.equal(patched.type, 'feature');
  assert.equal(patched.ordinal, 1500);
  assert.ok(patched.updated > a.updated, `${patched.updated} > ${a.updated}`);
  // body sections survive a metadata patch
  const got = getIssue(dir, a.id);
  assert.equal(got.seeing, 's');

  assert.throws(() => updateIssue(dir, a.id, { status: 'bogus' }), /status/);
  assert.throws(() => updateIssue(dir, a.id, { id: 'p-999' }), /id/);
  assert.throws(() => updateIssue(dir, 'p-404', { status: 'done' }), (e) => e.code === 'NOT_FOUND');
});

test('addComment appends comments and preserves earlier ones', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  addComment(dir, a.id, { author: 'igor', text: 'First comment\nwith two lines' });
  const after = addComment(dir, a.id, { author: 'claude', text: 'Second' });
  assert.equal(after.comments.length, 2);
  assert.equal(after.comments[0].author, 'igor');
  assert.equal(after.comments[0].text, 'First comment\nwith two lines');
  assert.equal(after.comments[1].author, 'claude');
  assert.ok(after.comments[1].at);
  assert.throws(() => addComment(dir, 'p-404', { author: 'x', text: 'y' }), (e) => e.code === 'NOT_FOUND');
});

test('malformed issue files are skipped without crashing', () => {
  const dir = tmpDataDir();
  createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  fs.writeFileSync(path.join(dir, 'p', 'issues', 'garbage.md'), ':::not frontmatter\nat all');
  fs.writeFileSync(path.join(dir, 'p', 'issues', 'no-id.md'), '---\ntitle: hi\n---\nbody');
  const all = listIssues(dir, 'p');
  assert.equal(all.length, 1);
});

test('content containing our own section headings round-trips intact (sentinel parsing)', () => {
  const dir = tmpDataDir();
  const made = createIssue(dir, {
    project: 'p',
    title: 'Pasted docs',
    seeing: 'Quoting the template:\n\n## Seeing\n\nfoo\n\n## Comments\n\nbar — end of quote',
    expecting: 'Also tricky:\n## Expecting\nnested',
  });
  const got = getIssue(dir, made.id);
  assert.equal(got.seeing, 'Quoting the template:\n\n## Seeing\n\nfoo\n\n## Comments\n\nbar — end of quote');
  assert.equal(got.expecting, 'Also tricky:\n## Expecting\nnested');
});

test('comment text containing heading-like lines survives round-trip', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  addComment(dir, a.id, { author: 'igor', text: 'Steps:\n### step one\ndo a thing\n### step two — careful' });
  const got = getIssue(dir, a.id);
  assert.equal(got.comments.length, 1);
  assert.equal(got.comments[0].text, 'Steps:\n### step one\ndo a thing\n### step two — careful');
});

test('legacy files without sentinels still parse via heading fallback', () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'p', 'issues', 'p-1-legacy.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\nid: p-1\nproject: p\ntitle: Legacy\nstatus: backlog\ntype: bug\ntags: []\nseverity: 2\nordinal: 1000\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\n---\n\n## Seeing\n\nold seeing\n\n## Expecting\n\nold expecting\n\n## Comments\n\n### igor — 2026-01-02T00:00:00.000Z\n\nlegacy comment\n`
  );
  const got = getIssue(dir, 'p-1');
  assert.equal(got.seeing, 'old seeing');
  assert.equal(got.expecting, 'old expecting');
  assert.equal(got.comments.length, 1);
  assert.equal(got.comments[0].text, 'legacy comment');
});

test('ordinal ties trigger column resequencing', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 'a', expecting: 'a' }); // 1000
  const b = createIssue(dir, { project: 'p', seeing: 'b', expecting: 'b' }); // 2000
  const c = createIssue(dir, { project: 'p', seeing: 'c', expecting: 'c' }); // 3000
  updateIssue(dir, b.id, { ordinal: 1000 }); // tie with a
  const column = listIssues(dir, 'p', { status: 'backlog' });
  const ordinals = column.map((i) => i.ordinal);
  assert.equal(new Set(ordinals).size, 3, `ordinals must be unique after resequence: ${ordinals}`);
  for (let i = 1; i < ordinals.length; i++) assert.ok(ordinals[i] > ordinals[i - 1]);
  assert.ok(getIssue(dir, c.id).ordinal > 0);
});

test('mutations clean up their lock directories', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  updateIssue(dir, a.id, { status: 'done' });
  addComment(dir, a.id, { author: 'x', text: 'y' });
  assert.ok(!fs.existsSync(path.join(dir, 'p', '.project.lock')), 'project lock dir should be removed');
  assert.ok(!fs.existsSync(path.join(dir, '.registry.lock')), 'registry lock dir should be removed');
  // a held lock makes writers wait, then proceed once released (steal after staleness)
  fs.mkdirSync(path.join(dir, 'p', '.project.lock'));
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(path.join(dir, 'p', '.project.lock'), old, old);
  const b = createIssue(dir, { project: 'p', seeing: 's2', expecting: 'e2' }); // steals stale lock
  assert.equal(b.id, 'p-2');
});

test('ids stay sequential even after status changes and across reloads', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  updateIssue(dir, a.id, { status: 'done' });
  const b = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  assert.equal(b.id, 'p-2');
  // ordinal for new issue is max+1000 across the project, not per column
  assert.equal(b.ordinal, 2000);
});

test('ensureProject upserts name and repo_path', () => {
  const dir = tmpDataDir();
  ensureProject(dir, 'platform');
  const updated = ensureProject(dir, 'platform', 'Platform', '/path/to/your/project');
  assert.deepEqual(updated, { key: 'platform', name: 'Platform', repo_path: '/path/to/your/project' });
  // calling again without args keeps existing values
  assert.deepEqual(ensureProject(dir, 'platform'), updated);
  assert.deepEqual(listProjects(dir), [updated]);
});

test('relatedTo is patchable via updateIssue', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  const b = createIssue(dir, { project: 'p', seeing: 's2', expecting: 'e2' });
  updateIssue(dir, b.id, { relatedTo: a.id });
  assert.equal(getIssue(dir, b.id).relatedTo, a.id);
});

test('resolveIssue writes resolution, modified files, and moves to in-review', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  const resolved = resolveIssue(dir, a.id, {
    resolution: 'Fixed the column shift.\n\nRoot cause: off-by-one in header render.\nTests: 3 added.',
    modifiedFiles: ['src/table.js', 'tests/table.test.js'],
  });
  assert.equal(resolved.status, 'in-review');
  assert.equal(resolved.modifiedFiles.length, 2);
  const got = getIssue(dir, a.id);
  assert.equal(got.resolution, 'Fixed the column shift.\n\nRoot cause: off-by-one in header render.\nTests: 3 added.');
  assert.deepEqual(got.modifiedFiles, ['src/table.js', 'tests/table.test.js']);
  assert.equal(got.status, 'in-review');
  assert.throws(() => resolveIssue(dir, a.id, { resolution: '' }), /resolution/);
  assert.throws(() => resolveIssue(dir, 'p-404', { resolution: 'x' }), (e) => e.code === 'NOT_FOUND');
});

test('sweepDone moves done issues to closed/, visible via listClosed and getIssue', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'finished', seeing: 's', expecting: 'e' });
  const b = createIssue(dir, { project: 'p', title: 'open', seeing: 's', expecting: 'e' });
  updateIssue(dir, a.id, { status: 'done' });
  const swept = sweepDone(dir, 'p');
  assert.deepEqual(swept.map((i) => i.id), [a.id]);

  // gone from the board, present in the archive
  assert.deepEqual(listIssues(dir, 'p').map((i) => i.id), [b.id]);
  const closed = listClosed(dir, 'p');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, a.id);
  assert.ok(closed[0].closed, 'closed timestamp set');

  // still retrievable by id; flagged closed
  const got = getIssue(dir, a.id);
  assert.equal(got.closed, closed[0].closed);

  // closed issues are immutable through mutations
  assert.throws(() => updateIssue(dir, a.id, { status: 'backlog' }), /closed/);
  assert.throws(() => addComment(dir, a.id, { author: 'x', text: 'y' }), /closed/);

  // id sequence never reuses swept ids
  const c = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  assert.equal(c.id, 'p-3');

  // sweeping again is a no-op
  assert.deepEqual(sweepDone(dir, 'p'), []);
});

test('deleteIssue permanently removes an open issue', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'keep', seeing: 's', expecting: 'e' });
  const b = createIssue(dir, { project: 'p', title: 'junk', seeing: 's', expecting: 'e' });
  const res = deleteIssue(dir, b.id);
  assert.deepEqual(res, { deleted: b.id, project: 'p', title: 'junk', wasClosed: false });

  assert.equal(getIssue(dir, b.id), null, 'gone from store');
  assert.ok(!fs.existsSync(b.file), 'file removed from disk');
  assert.deepEqual(listIssues(dir, 'p').map((i) => i.id), [a.id], 'sibling untouched');
});

test('deleteIssue removes an archived (swept) issue too', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'done thing', seeing: 's', expecting: 'e' });
  updateIssue(dir, a.id, { status: 'done' });
  sweepDone(dir, 'p');
  assert.equal(listClosed(dir, 'p').length, 1);

  const res = deleteIssue(dir, a.id);
  assert.equal(res.wasClosed, true);
  assert.equal(getIssue(dir, a.id), null);
  assert.deepEqual(listClosed(dir, 'p'), []);
});

test('deleteIssue throws NOT_FOUND for unknown or malformed ids', () => {
  const dir = tmpDataDir();
  createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  assert.throws(() => deleteIssue(dir, 'p-999'), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => deleteIssue(dir, 'not-an-id-format!!'), (err) => err.code === 'NOT_FOUND');
});

test('deleteIssue cannot escape the data dir via a traversal id', () => {
  const dir = tmpDataDir();
  // Plant an issue-shaped markdown file OUTSIDE the data dir that an attacker
  // would try to reach with a crafted id. parseId must sanitize the project so
  // the derived path stays inside dataDir, leaving the planted file untouched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'it-outside-'));
  const planted = path.join(outside, 'issues', 'evil-1-x.md');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, '---\nid: evil-1\nproject: evil\n---\n');

  const rel = path.relative(path.join(dir, 'x', 'issues'), planted).replace(/\.md$/, '');
  assert.throws(() => deleteIssue(dir, `${rel}`), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => deleteIssue(dir, '../../../etc/passwd-1'), (err) => err.code === 'NOT_FOUND');
  assert.ok(fs.existsSync(planted), 'file outside the data dir is never touched');
});

test('iceboxIssue parks a backlog item; reviveIssue returns it to the backlog bottom', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'park me', seeing: 's', expecting: 'e' });
  const b = createIssue(dir, { project: 'p', title: 'keep', seeing: 's', expecting: 'e' });

  const iced = iceboxIssue(dir, a.id);
  assert.ok(iced.iceboxed, 'iceboxed timestamp set');
  assert.equal(iced.status, 'backlog', 'status preserved while parked');

  // gone from the board, present in the icebox, still retrievable by id
  assert.deepEqual(listIssues(dir, 'p').map((i) => i.id), [b.id]);
  assert.deepEqual(listIcebox(dir, 'p').map((i) => i.id), [a.id]);
  assert.ok(getIssue(dir, a.id).iceboxed, 'getIssue finds it and flags it iceboxed');

  // iceboxed items reject board mutations until revived
  assert.throws(() => updateIssue(dir, a.id, { title: 'x' }), (e) => e.code === 'ICEBOXED');
  assert.throws(() => addComment(dir, a.id, { author: 'x', text: 'y' }), (e) => e.code === 'ICEBOXED');

  const revived = reviveIssue(dir, a.id);
  assert.equal(revived.status, 'backlog');
  assert.equal(revived.iceboxed, null, 'iceboxed cleared on revive');
  assert.deepEqual(listIcebox(dir, 'p'), []);
  assert.deepEqual(
    listIssues(dir, 'p', { status: 'backlog' }).map((i) => i.id),
    [b.id, a.id],
    'revived item lands at the bottom of the backlog'
  );
});

test('only backlog issues can be iceboxed', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  updateIssue(dir, a.id, { status: 'in-progress' });
  assert.throws(() => iceboxIssue(dir, a.id), /Only backlog issues/);

  const b = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  updateIssue(dir, b.id, { status: 'done' });
  sweepDone(dir, 'p');
  assert.throws(() => iceboxIssue(dir, b.id), (e) => e.code === 'CLOSED');
});

test('iceboxed ids are never reused by createIssue', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' }); // p-1
  iceboxIssue(dir, a.id);
  const c = createIssue(dir, { project: 'p', seeing: 's', expecting: 'e' });
  assert.equal(c.id, 'p-2', 'next id skips the parked p-1');
});

test('searchIssues matches across fields, optionally filtered and including closed', () => {
  const dir = tmpDataDir();
  const a = createIssue(dir, { project: 'p', title: 'Login button broken', tags: ['auth'], seeing: 'click does nothing', expecting: 'logs in' });
  const b = createIssue(dir, { project: 'p', title: 'Dark mode', tags: ['theme'], seeing: 'always light', expecting: 'toggle' });
  const c = createIssue(dir, { project: 'q', title: 'Other project login', seeing: 'login flaky', expecting: 'stable' });
  addComment(dir, b.id, { author: 'igor', text: 'mentions login in a comment' });

  const byTitle = searchIssues(dir, { query: 'login' });
  assert.deepEqual(new Set(byTitle.map((i) => i.id)), new Set([a.id, b.id, c.id])); // b via comment
  const scoped = searchIssues(dir, { query: 'login', project: 'p' });
  assert.deepEqual(new Set(scoped.map((i) => i.id)), new Set([a.id, b.id]));
  assert.deepEqual(searchIssues(dir, { query: 'theme' }).map((i) => i.id), [b.id]);
  assert.deepEqual(searchIssues(dir, { query: 'zzz-nope' }), []);

  updateIssue(dir, a.id, { status: 'done' });
  sweepDone(dir, 'p');
  assert.ok(!searchIssues(dir, { query: 'Login button' }).some((i) => i.id === a.id), 'closed excluded by default');
  assert.ok(searchIssues(dir, { query: 'Login button', includeClosed: true }).some((i) => i.id === a.id));
});
