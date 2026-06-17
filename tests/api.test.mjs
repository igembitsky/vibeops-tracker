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
