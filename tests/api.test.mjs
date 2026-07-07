import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

let server;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tracker-api-'));
  server = await startServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

async function json(res) {
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  return res.json();
}

test('GET /api/projects starts empty', async () => {
  const res = await fetch(`${base}/api/projects`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await json(res), []);
});

test('POST /api/issues creates issue and auto-registers project', async () => {
  const res = await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'demo',
      title: 'Broken thing',
      type: 'bug',
      severity: 4,
      tags: ['ui'],
      seeing: 'It is broken',
      expecting: 'It works',
      context: { url: 'http://localhost:9999/x', viewport: { w: 100, h: 50 } },
    }),
  });
  assert.equal(res.status, 201);
  const issue = await json(res);
  assert.equal(issue.id, 'demo-1');
  assert.equal(issue.status, 'backlog');
  assert.equal(issue.context.url, 'http://localhost:9999/x');

  const projects = await (await fetch(`${base}/api/projects`)).json();
  assert.deepEqual(projects, [{ key: 'demo', name: 'demo' }]);
});

test('POST /api/issues validates input', async () => {
  const res = await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'demo', expecting: 'no seeing' }),
  });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.match(body.error, /seeing/);

  const bad = await fetch(`${base}/api/issues`, { method: 'POST', body: 'not json{{' });
  assert.equal(bad.status, 400);
});

test('GET /api/projects/:key/issues lists sorted issues', async () => {
  await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'demo', seeing: 'second', expecting: 'works' }),
  });
  const res = await fetch(`${base}/api/projects/demo/issues`);
  assert.equal(res.status, 200);
  const issues = await json(res);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((i) => i.id), ['demo-1', 'demo-2']);
});

test('GET /api/issues/:id returns issue, 404 when unknown', async () => {
  const res = await fetch(`${base}/api/issues/demo-1`);
  assert.equal(res.status, 200);
  const issue = await json(res);
  assert.equal(issue.seeing, 'It is broken');

  const missing = await fetch(`${base}/api/issues/demo-999`);
  assert.equal(missing.status, 404);
  assert.match((await json(missing)).error, /not found/i);
});

test('PATCH /api/issues/:id updates status and ordinal, validates', async () => {
  const res = await fetch(`${base}/api/issues/demo-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in-progress', ordinal: 123.5 }),
  });
  assert.equal(res.status, 200);
  const issue = await json(res);
  assert.equal(issue.status, 'in-progress');
  assert.equal(issue.ordinal, 123.5);

  const bad = await fetch(`${base}/api/issues/demo-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'bogus' }),
  });
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}/api/issues/demo-999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(missing.status, 404);
});

test('POST /api/issues/:id/comments appends comment', async () => {
  const res = await fetch(`${base}/api/issues/demo-1/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'igor', text: 'Please prioritize' }),
  });
  assert.equal(res.status, 200);
  const issue = await json(res);
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.comments[0].author, 'igor');

  const bad = await fetch(`${base}/api/issues/demo-1/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: '', text: '' }),
  });
  assert.equal(bad.status, 400);
});

test('GET /api/issues/:id/prompt returns text/plain prompt', async () => {
  const res = await fetch(`${base}/api/issues/demo-1/prompt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const text = await res.text();
  assert.match(text, /demo-1/);
  assert.match(text, /curl -X PATCH/);
});

test('link/unlink endpoints write two-sided links; GET enriches; prompt carries doctrine', async () => {
  const mk = (title) =>
    fetch(`${base}/api/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'linkproj', title, seeing: 's', expecting: 'e' }),
    }).then((r) => r.json());
  const a = await mk('canonical'); // linkproj-1
  const b = await mk('the duplicate'); // linkproj-2

  // b is a duplicate of a
  const linked = await fetch(`${base}/api/issues/${b.id}/links`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: a.id, rel: 'duplicate_of' }),
  });
  assert.equal(linked.status, 200);
  const bAfter = await json(linked);
  // GET returns enriched links (title/status carried through)
  assert.equal(bAfter.links.length, 1);
  assert.equal(bAfter.links[0].rel, 'duplicate_of');
  assert.equal(bAfter.links[0].to, a.id);
  assert.equal(bAfter.links[0].title, 'canonical');

  // the mirror lands on the canonical issue
  const aGet = await json(await fetch(`${base}/api/issues/${a.id}`));
  assert.deepEqual(aGet.links.map((l) => [l.rel, l.to]), [['duplicated_by', b.id]]);

  // board list carries raw links so the card can show a count
  const board = await (await fetch(`${base}/api/projects/linkproj/issues`)).json();
  assert.equal(board.find((i) => i.id === a.id).links.length, 1);

  // the copy-prompt for the canonical issue tells the agent to clean out the dup
  const prompt = await (await fetch(`${base}/api/issues/${a.id}/prompt`)).text();
  assert.match(prompt, /Linked issues/);
  assert.match(prompt, /duplicates of this one/i);

  // unlink clears both ends
  const unlinked = await fetch(`${base}/api/issues/${b.id}/links/${a.id}`, { method: 'DELETE' });
  assert.equal(unlinked.status, 200);
  assert.deepEqual((await json(unlinked)).links, []);
  assert.deepEqual((await json(await fetch(`${base}/api/issues/${a.id}`))).links, []);

  // linking is same-origin guarded (PATCH)
  const evil = await fetch(`${base}/api/issues/${b.id}/links`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ to: a.id, rel: 'related' }),
  });
  assert.equal(evil.status, 403);
});

test('POST /api/projects registers a named project', async () => {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'platform', name: 'Platform' }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await json(res), { key: 'platform', name: 'Platform' });
});

test('POST /api/issues/:id/resolve records resolution and moves to in-review', async () => {
  const res = await fetch(`${base}/api/issues/demo-2/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution: 'Fixed by doing X', modifiedFiles: ['a.js'] }),
  });
  assert.equal(res.status, 200);
  const issue = await json(res);
  assert.equal(issue.status, 'in-review');
  assert.equal(issue.resolution, 'Fixed by doing X');
  assert.deepEqual(issue.modifiedFiles, ['a.js']);

  const bad = await fetch(`${base}/api/issues/demo-2/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

test('sweep moves done issues to the archive; closed list serves them', async () => {
  await fetch(`${base}/api/issues/demo-2`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  const res = await fetch(`${base}/api/projects/demo/sweep`, { method: 'POST' });
  assert.equal(res.status, 200);
  const swept = await json(res);
  assert.deepEqual(swept.map((i) => i.id), ['demo-2']);

  const closed = await (await fetch(`${base}/api/projects/demo/closed`)).json();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, 'demo-2');
  assert.ok(closed[0].closed);

  const board = await (await fetch(`${base}/api/projects/demo/issues`)).json();
  assert.ok(!board.some((i) => i.id === 'demo-2'));

  // closed issues reject mutations with a clear error
  const patch = await fetch(`${base}/api/issues/demo-2`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'backlog' }),
  });
  assert.equal(patch.status, 409);
  assert.match((await json(patch)).error, /closed/i);
});

test('icebox: park a backlog issue, list it, revive it; non-backlog is refused', async () => {
  const created = await (await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'demo', title: 'park via api', seeing: 's', expecting: 'e' }),
  })).json();
  const id = created.id;

  const iced = await fetch(`${base}/api/issues/${id}/icebox`, { method: 'POST' });
  assert.equal(iced.status, 200);
  assert.ok((await json(iced)).iceboxed);

  const board = await (await fetch(`${base}/api/projects/demo/issues`)).json();
  assert.ok(!board.some((i) => i.id === id), 'parked item is off the board');
  const box = await (await fetch(`${base}/api/projects/demo/icebox`)).json();
  assert.ok(box.some((i) => i.id === id), 'parked item is in the icebox list');

  // iceboxed items reject board mutations
  const patch = await fetch(`${base}/api/issues/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(patch.status, 409);
  assert.match((await json(patch)).error, /icebox/i);

  const revived = await fetch(`${base}/api/issues/${id}/revive`, { method: 'POST' });
  assert.equal(revived.status, 200);
  const revivedIssue = await json(revived);
  assert.equal(revivedIssue.status, 'backlog');
  assert.equal(revivedIssue.iceboxed, null);
  const board2 = await (await fetch(`${base}/api/projects/demo/issues`)).json();
  assert.ok(board2.some((i) => i.id === id), 'revived item is back on the board');

  // a non-backlog issue cannot be iceboxed
  await fetch(`${base}/api/issues/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in-progress' }),
  });
  const bad = await fetch(`${base}/api/issues/${id}/icebox`, { method: 'POST' });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /backlog/i);
});

test('project upsert stores repo_path and prompt uses it', async () => {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'demo', name: 'Demo', repo_path: '/tmp/demo-repo' }),
  });
  assert.equal(res.status, 201);
  assert.equal((await json(res)).repo_path, '/tmp/demo-repo');

  const prompt = await (await fetch(`${base}/api/issues/demo-1/prompt`)).text();
  assert.match(prompt, /\/tmp\/demo-repo/);
  assert.match(prompt, /resolve/);
});

test('DELETE /api/issues/:id permanently removes an issue', async () => {
  const created = await (await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'demo', title: 'delete me', seeing: 's', expecting: 'e' }),
  })).json();

  const res = await fetch(`${base}/api/issues/${created.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.deleted, created.id);

  const gone = await fetch(`${base}/api/issues/${created.id}`);
  assert.equal(gone.status, 404);

  const missing = await fetch(`${base}/api/issues/demo-99999`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.match((await json(missing)).error, /not found/i);
});

test('DELETE/PATCH from a foreign Origin are refused (CSRF guard); same-origin and header-less pass', async () => {
  const created = await (await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'demo', title: 'csrf', seeing: 's', expecting: 'e' }),
  })).json();

  // a malicious cross-origin page (browser attaches a truthful Origin)
  const evilDelete = await fetch(`${base}/api/issues/${created.id}`, {
    method: 'DELETE',
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(evilDelete.status, 403);
  const evilPatch = await fetch(`${base}/api/issues/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ status: 'in-progress' }),
  });
  assert.equal(evilPatch.status, 403);

  // the issue survived the refused requests
  assert.equal((await fetch(`${base}/api/issues/${created.id}`)).status, 200);

  // same-origin board request (Origin matches host) is allowed
  const host = new URL(base).host;
  const ok = await fetch(`${base}/api/issues/${created.id}`, {
    method: 'DELETE',
    headers: { Origin: `http://${host}` },
  });
  assert.equal(ok.status, 200);
});

test('tag vocabulary and maintenance routes: list, rename/merge, delete', async () => {
  for (const tags of [['ux', 'widget'], ['ux'], ['ui']]) {
    const res = await fetch(`${base}/api/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'tagproj', seeing: 's', expecting: 'e', tags }),
    });
    assert.equal(res.status, 201);
  }

  // vocabulary is per project, most-used first, with counts
  let res = await fetch(`${base}/api/projects/tagproj/tags`);
  assert.equal(res.status, 200);
  let vocab = await json(res);
  assert.deepEqual(vocab.map((t) => [t.name, t.count]), [['ux', 2], ['ui', 1], ['widget', 1]]);
  assert.ok(vocab[0].lastUsed, 'lastUsed is stamped');

  // rename onto an existing name merges
  res = await fetch(`${base}/api/projects/tagproj/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'ui', to: 'ux' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { from: 'ui', to: 'ux', retagged: 1, merged: true });
  vocab = await json(await fetch(`${base}/api/projects/tagproj/tags`));
  assert.deepEqual(vocab.map((t) => [t.name, t.count]), [['ux', 3], ['widget', 1]]);

  // delete removes the tag everywhere; deleting again is a 404
  res = await fetch(`${base}/api/projects/tagproj/tags/widget`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { name: 'widget', untagged: 1 });
  res = await fetch(`${base}/api/projects/tagproj/tags/widget`, { method: 'DELETE' });
  assert.equal(res.status, 404);

  // renaming a nonexistent tag is a 404; a missing name is a 400
  res = await fetch(`${base}/api/projects/tagproj/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'nope', to: 'x' }),
  });
  assert.equal(res.status, 404);
  res = await fetch(`${base}/api/projects/tagproj/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'ux' }),
  });
  assert.equal(res.status, 400);
});

test('tag maintenance is refused cross-origin (CSRF guard)', async () => {
  const evilRename = await fetch(`${base}/api/projects/tagproj/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ from: 'ux', to: 'pwned' }),
  });
  assert.equal(evilRename.status, 403);
  const evilDelete = await fetch(`${base}/api/projects/tagproj/tags/ux`, {
    method: 'DELETE',
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(evilDelete.status, 403);
  const vocab = await json(await fetch(`${base}/api/projects/tagproj/tags`));
  assert.deepEqual(vocab.map((t) => t.name), ['ux'], 'vocabulary survived the refused requests');
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await fetch(`${base}/api/issues`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /PATCH/);
  assert.match(res.headers.get('access-control-allow-methods'), /DELETE/);
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);
});

test('unknown api route returns 404 json', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  await json(res);
});

test('GET / serves the tracker UI html', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<html/i);
});

test('GET /widget.js serves the widget with CORS', async () => {
  const res = await fetch(`${base}/widget.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('static serving blocks path traversal', async () => {
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(res.status, 404);
});
