// Issue screenshots: the one binary attachment an issue can carry (what the reporter
// was looking at when they filed). Store round-trip plus the two HTTP routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { createIssue, getIssue, deleteIssue, saveIssueScreenshot, readIssueScreenshot, sniffImage } from '../lib/store.mjs';

// Real magic bytes: the store sniffs these, so a fake header would not do.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);

let server;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tracker-shot-'));
  server = await startServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const newIssue = (title = 'Something broke') =>
  createIssue(dataDir, { project: 'shots', title, seeing: 's', expecting: 'e' });

test('sniffImage recognizes JPEG and PNG, and nothing else', () => {
  assert.equal(sniffImage(JPEG).ext, 'jpg');
  assert.equal(sniffImage(PNG).ext, 'png');
  assert.equal(sniffImage(Buffer.from('<svg/>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage(null), null);
});

test('an attached screenshot round-trips and is recorded in the issue file', () => {
  const issue = newIssue();
  assert.equal(issue.screenshot, null, 'issues start with none');
  const updated = saveIssueScreenshot(dataDir, issue.id, JPEG);
  assert.equal(updated.screenshot, `${issue.id}.jpg`);
  const shot = readIssueScreenshot(dataDir, issue.id);
  assert.deepEqual(shot.bytes, JPEG);
  assert.equal(shot.mime, 'image/jpeg');
  // The record is the file: re-read from disk, not from the returned object.
  assert.equal(getIssue(dataDir, issue.id).screenshot, `${issue.id}.jpg`);
  assert.match(fs.readFileSync(issue.file, 'utf8'), /screenshot: /);
});

test('replacing a screenshot with another format leaves no stale file behind', () => {
  const issue = newIssue();
  saveIssueScreenshot(dataDir, issue.id, JPEG);
  saveIssueScreenshot(dataDir, issue.id, PNG);
  const dir = path.join(dataDir, 'shots', 'attachments');
  assert.ok(fs.existsSync(path.join(dir, `${issue.id}.png`)));
  assert.ok(!fs.existsSync(path.join(dir, `${issue.id}.jpg`)), 'the old jpg is gone');
  assert.equal(readIssueScreenshot(dataDir, issue.id).mime, 'image/png');
});

test('a non-image is refused; an issue with no screenshot reads as null', () => {
  const issue = newIssue();
  assert.throws(() => saveIssueScreenshot(dataDir, issue.id, Buffer.from('<script>alert(1)</script>')), /JPEG or PNG/);
  assert.equal(readIssueScreenshot(dataDir, issue.id), null);
});

test('deleting an issue takes its screenshot with it', () => {
  const issue = newIssue();
  saveIssueScreenshot(dataDir, issue.id, JPEG);
  const file = path.join(dataDir, 'shots', 'attachments', `${issue.id}.jpg`);
  assert.ok(fs.existsSync(file));
  deleteIssue(dataDir, issue.id);
  assert.ok(!fs.existsSync(file), 'no orphan image left on disk');
});

test('an unknown issue id is a 404, not a path', () => {
  assert.throws(() => saveIssueScreenshot(dataDir, 'shots-9999', JPEG), /not found/i);
  assert.equal(readIssueScreenshot(dataDir, '../../etc/passwd'), null);
  assert.equal(readIssueScreenshot(dataDir, 'nonsense'), null);
});

test('POST then GET /api/issues/:id/screenshot over HTTP', async () => {
  const created = await (await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'shots', title: 'Over the wire', seeing: 's', expecting: 'e' }),
  })).json();

  const missing = await fetch(`${base}/api/issues/${created.id}/screenshot`);
  assert.equal(missing.status, 404, 'no image before one is attached');

  const post = await fetch(`${base}/api/issues/${created.id}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: JPEG,
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).screenshot, `${created.id}.jpg`);

  const get = await fetch(`${base}/api/issues/${created.id}/screenshot`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), JPEG, 'bytes survive the wire unmangled');

  // And the issue payload the board reads names it.
  const issue = await (await fetch(`${base}/api/issues/${created.id}`)).json();
  assert.equal(issue.screenshot, `${created.id}.jpg`);
});

test('a lying content-type buys nothing: the bytes decide', async () => {
  const created = await (await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'shots', title: 'Liar', seeing: 's', expecting: 'e' }),
  })).json();
  const res = await fetch(`${base}/api/issues/${created.id}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from('<html>not an image</html>'),
  });
  assert.equal(res.status, 400);
});
