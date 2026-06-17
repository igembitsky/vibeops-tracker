import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SERVER = new URL('../mcp-server.mjs', import.meta.url).pathname;

function startMcp(dataDir) {
  const proc = spawn('node', [SERVER], { env: { ...process.env, DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  });
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 5000);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  return { proc, request, notify };
}

test('mcp server speaks the protocol and round-trips issues', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tracker-mcp-'));
  const mcp = startMcp(dataDir);
  t.after(() => mcp.proc.kill());

  const init = await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'issue-tracker');
  mcp.notify('notifications/initialized');

  const tools = await mcp.request('tools/list', {});
  const names = tools.result.tools.map((t2) => t2.name).sort();
  assert.deepEqual(names, [
    'add_comment',
    'create_issue',
    'delete_issue',
    'get_issue',
    'get_tracker_instructions',
    'list_issues',
    'list_projects',
    'resolve_issue',
    'search_issues',
    'update_issue',
  ]);

  const created = await mcp.request('tools/call', {
    name: 'create_issue',
    arguments: { project: 'test', title: 'From MCP', type: 'feature', seeing: 'agent saw', expecting: 'agent expects' },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result));
  const createdIssue = JSON.parse(created.result.content[0].text);
  assert.equal(createdIssue.id, 'test-1');

  const got = await mcp.request('tools/call', { name: 'get_issue', arguments: { id: 'test-1' } });
  const gotIssue = JSON.parse(got.result.content[0].text);
  assert.equal(gotIssue.seeing, 'agent saw');

  const projects = await mcp.request('tools/call', { name: 'list_projects', arguments: {} });
  assert.match(projects.result.content[0].text, /test/);

  await mcp.request('tools/call', {
    name: 'update_issue',
    arguments: { id: 'test-1', status: 'in-progress', severity: 5, tags: ['mcp'], title: 'Retitled by agent' },
  });
  const listed = await mcp.request('tools/call', { name: 'list_issues', arguments: { project: 'test', status: 'in-progress' } });
  const issues = JSON.parse(listed.result.content[0].text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'test-1');
  assert.equal(issues[0].title, 'Retitled by agent');
  assert.equal(issues[0].severity, 5);

  const commented = await mcp.request('tools/call', {
    name: 'add_comment',
    arguments: { id: 'test-1', author: 'claude', text: 'working on it' },
  });
  const after = JSON.parse(commented.result.content[0].text);
  assert.equal(after.comments.length, 1);

  const resolved = await mcp.request('tools/call', {
    name: 'resolve_issue',
    arguments: { id: 'test-1', resolution: 'Implemented the feature; tests added.', modified_files: ['src/x.js'] },
  });
  const resolvedIssue = JSON.parse(resolved.result.content[0].text);
  assert.equal(resolvedIssue.status, 'in-review');
  assert.deepEqual(resolvedIssue.modifiedFiles, ['src/x.js']);

  const found = await mcp.request('tools/call', { name: 'search_issues', arguments: { query: 'retitled' } });
  const hits = JSON.parse(found.result.content[0].text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'test-1');

  const instructions = await mcp.request('tools/call', { name: 'get_tracker_instructions', arguments: {} });
  const doctrine = instructions.result.content[0].text;
  assert.match(doctrine, /in-progress/);
  assert.match(doctrine, /resolve_issue/);
  assert.match(doctrine, /never edit/i);

  const bad = await mcp.request('tools/call', { name: 'update_issue', arguments: { id: 'test-1', status: 'bogus' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /status/i);

  const missing = await mcp.request('tools/call', { name: 'get_issue', arguments: { id: 'test-999' } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /NOT_FOUND/);

  // delete_issue: refuses without confirm, then permanently removes
  const noConfirm = await mcp.request('tools/call', { name: 'delete_issue', arguments: { id: 'test-1' } });
  assert.equal(noConfirm.result.isError, true, 'delete without confirm is refused');
  assert.match(noConfirm.result.content[0].text, /confirm/i);

  const stillThere = await mcp.request('tools/call', { name: 'get_issue', arguments: { id: 'test-1' } });
  assert.ok(!stillThere.result.isError, 'refused delete left the issue intact');

  const deleted = await mcp.request('tools/call', { name: 'delete_issue', arguments: { id: 'test-1', confirm: true } });
  assert.ok(!deleted.result.isError, JSON.stringify(deleted.result));
  assert.match(deleted.result.content[0].text, /"deleted":\s*"test-1"/);

  const goneAfterDelete = await mcp.request('tools/call', { name: 'get_issue', arguments: { id: 'test-1' } });
  assert.equal(goneAfterDelete.result.isError, true);
  assert.match(goneAfterDelete.result.content[0].text, /NOT_FOUND/);
});
