import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../lib/prompt.mjs';

const issue = {
  id: 'platform-3',
  project: 'platform',
  title: 'Login button broken',
  status: 'backlog',
  type: 'bug',
  tags: ['auth'],
  severity: 4,
  ordinal: 3000,
  created: '2026-06-12T08:30:00.000Z',
  updated: '2026-06-12T08:30:00.000Z',
  relatedTo: null,
  seeing: 'Clicking login does nothing',
  expecting: 'Should log me in',
  context: {
    url: 'http://localhost:4556/login',
    viewport: { w: 1512, h: 944 },
    userAgent: 'TestAgent/1.0',
    recentErrors: [{ message: 'TypeError: x is undefined' }],
    recentFetchFailures: [{ method: 'POST', url: '/api/login', status: 500 }],
  },
  comments: [],
  file: '/data/platform/issues/platform-3-login-button-broken.md',
};

test('buildPrompt includes repo path and staleness caveat when project has one', () => {
  const text = buildPrompt(issue, {
    apiBase: 'http://localhost:4400',
    project: { key: 'platform', name: 'Platform', repo_path: '/path/to/your/project' },
  });
  assert.match(text, /\/path\/to\/your\/project/);
  assert.match(text, /Repository/i);
  assert.match(text, /current branch|worktree/i);
});

test('buildPrompt instructs finishing with resolve', () => {
  const text = buildPrompt(issue, { apiBase: 'http://localhost:4400' });
  assert.match(text, /curl -X POST http:\/\/localhost:4400\/api\/issues\/platform-3\/resolve/);
  assert.match(text, /"resolution"/);
  assert.match(text, /modifiedFiles/);
});

test('buildPrompt includes all key issue facts and workflow instructions', () => {
  const text = buildPrompt(issue, { apiBase: 'http://localhost:4400' });
  assert.match(text, /platform-3/);
  assert.match(text, /Login button broken/);
  assert.match(text, /bug/);
  assert.match(text, /severity.*4/i);
  assert.match(text, /auth/);
  assert.match(text, /Clicking login does nothing/);
  assert.match(text, /Should log me in/);
  assert.match(text, /http:\/\/localhost:4556\/login/);
  assert.match(text, /TypeError: x is undefined/);
  assert.match(text, /POST \/api\/login.*500/);
  assert.match(text, /\/data\/platform\/issues\/platform-3-login-button-broken\.md/);
  // workflow instructions
  assert.match(text, /curl -X PATCH http:\/\/localhost:4400\/api\/issues\/platform-3/);
  assert.match(text, /"status": ?"in-progress"/);
  assert.match(text, /curl -X POST http:\/\/localhost:4400\/api\/issues\/platform-3\/comments/);
});

test('buildPrompt renders capture-time git state with a staleness caveat', () => {
  const withGit = {
    ...issue,
    context: { ...issue.context, app: { git: { branch: 'feature/login-fix', commit: 'abc1234', worktree: '/path/to/worktrees/login-fix' } } },
  };
  const text = buildPrompt(withGit, { apiBase: 'http://localhost:4400' });
  assert.match(text, /feature\/login-fix/);
  assert.match(text, /abc1234/);
  assert.match(text, /worktrees\/login-fix/);
  assert.match(text, /as of capture/i);
  assert.match(text, /may have changed|verify against the current/i);
});

test('buildPrompt promotes highlighted text to its own block', () => {
  const withSel = { ...issue, context: { ...issue.context, selectedText: 'Submit\nyour application' } };
  const text = buildPrompt(withSel, { apiBase: 'http://localhost:4400' });
  assert.match(text, /## What I highlighted/);
  assert.match(text, /> Submit\n> your application/);
  assert.match(text, /exact thing I am referring to/);
});

test('buildPrompt omits the highlight block when nothing was selected', () => {
  const text = buildPrompt(issue, { apiBase: 'http://localhost:4400' });
  assert.doesNotMatch(text, /What I highlighted/);
});

test('buildPrompt handles missing context and title gracefully', () => {
  const bare = { ...issue, title: '', context: null };
  const text = buildPrompt(bare, { apiBase: 'http://localhost:4400' });
  assert.match(text, /platform-3/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /null/);
});
