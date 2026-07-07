// Build a paste-ready Claude Code prompt for working an issue.

function selectionBlock(context) {
  if (!context?.selectedText) return '';
  const quoted = String(context.selectedText)
    .trimEnd()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return [
    '',
    '## What I highlighted',
    '',
    'I had this text selected on the page when I filed this. It is likely the exact thing I am referring to:',
    '',
    quoted,
    '',
  ].join('\n');
}

function contextBlock(context) {
  if (!context) return '';
  const lines = ['', '## Captured context', ''];
  if (context.url) lines.push(`- URL when reported: ${context.url}`);
  if (context.pointedElement?.selector) {
    const p = context.pointedElement;
    lines.push(`- Element the reporter pointed at: ${p.selector}${p.text ? ` ("${p.text}")` : ''}`);
  }
  if (context.viewport?.w) lines.push(`- Viewport: ${context.viewport.w}x${context.viewport.h}`);
  if (context.colorScheme) lines.push(`- Color scheme: ${context.colorScheme}`);
  // The user agent stays in the issue's full context JSON but out of the
  // prompt: retros across sixteen resolved issues never once used it.
  const errors = context.recentErrors || [];
  if (errors.length) {
    lines.push('', `Recent JS errors (${errors.length}):`);
    for (const e of errors) lines.push(`- ${e.message}`);
  }
  const failures = context.recentFetchFailures || [];
  if (failures.length) {
    lines.push('', `Recent failed requests (${failures.length}):`);
    for (const f of failures) lines.push(`- ${f.method} ${f.url} -> ${f.status}${f.bodySnippet ? ` — body: ${f.bodySnippet}` : ''}`);
  }
  const git = context.git || context.app?.git;
  if (git && (git.branch || git.commit || git.worktree)) {
    lines.push('', 'Environment as of capture. This may have changed since, so verify against the current state of the repo before relying on it:');
    if (git.branch) lines.push(`- Branch: ${git.branch}`);
    if (git.commit) lines.push(`- Commit: ${git.commit}`);
    if (git.worktree) lines.push(`- Worktree: ${git.worktree}`);
  }
  return lines.join('\n');
}

// Linked issues, with the working doctrine baked in: duplicates get cleaned out,
// related work gets batched. `links` is the resolved [{rel, to, title, ...}] list.
function linksBlock(links, selfId) {
  if (!links?.length) return '';
  const label = (l) => `${l.to}${l.title ? ` ("${l.title}")` : ''}`;
  const of = (rel) => links.filter((l) => l.rel === rel);
  const lines = ['', '## Linked issues', ''];

  const dupOf = of('duplicate_of');
  if (dupOf.length) {
    lines.push(
      `This issue is a duplicate of ${dupOf.map(label).join(', ')}. Do not do the work twice: do it on the canonical issue, then clean this one out (resolve it with a short "Duplicate of ${dupOf[0].to}" note, or delete it if it is pure noise).`,
      ''
    );
  }
  const dupBy = of('duplicated_by');
  if (dupBy.length) {
    lines.push(
      `These issues are duplicates of this one: ${dupBy.map(label).join(', ')}. This (${selfId}) is the canonical one to work; when you finish, clean the duplicates out (resolve each as "Duplicate of ${selfId}", or delete pure noise) so they do not linger.`,
      ''
    );
  }
  const related = of('related');
  if (related.length) {
    lines.push(
      `Related issues (they share this surface): ${related.map(label).join(', ')}.`,
      'Focus on what is asked above, but check these: if any can be handled in the same change, do them together and resolve them together so related work lands and moves through the board as one batch. Call out any you fold in when you resolve.',
      ''
    );
  }
  return lines.join('\n');
}

function repoBlock(project) {
  if (!project?.repo_path) return '';
  return `
## Repository

This issue belongs to the "${project.name || project.key}" project:
${project.repo_path}

Work in that repository (check its current branch/worktree state first, since the capture-time environment above may be stale).
`;
}

export function buildPrompt(issue, { apiBase, project, links } = {}) {
  const title = issue.title || issue.id;
  const tags = (issue.tags || []).length ? ` | tags: ${issue.tags.join(', ')}` : '';

  return `Work on this issue from my issue tracker.

# ${issue.id}: ${title}

Type: ${issue.type} | Severity: ${issue.severity}/5${tags} | Project: ${issue.project}

## What I'm seeing

${issue.seeing}

## What I expect

${issue.expecting}
${selectionBlock(issue.context)}${contextBlock(issue.context)}${linksBlock(links, issue.id)}
${repoBlock(project)}
## Issue file

The full issue (including the complete context snapshot JSON and comments) lives at:
${issue.file}

## Tracker workflow

The tracker API runs at ${apiBase}. As you work:

1. Mark the issue in-progress when you start:
   curl -X PATCH ${apiBase}/api/issues/${issue.id} -H 'Content-Type: application/json' -d '{"status": "in-progress"}'
2. Leave comments for anything notable along the way:
   curl -X POST ${apiBase}/api/issues/${issue.id}/comments -H 'Content-Type: application/json' -d '{"author": "claude", "text": "<note>"}'
3. When the fix is ready, resolve it (this records your summary + touched files and moves it to in-review for me to verify):
   curl -X POST ${apiBase}/api/issues/${issue.id}/resolve -H 'Content-Type: application/json' -d '{"resolution": "<what you changed, why, and how it was tested>", "modifiedFiles": ["path/one", "path/two"]}'

If this project's issue-tracker MCP server is connected, prefer its tools (update_issue, add_comment, resolve_issue) over curl. If the tracker server is down, you can edit the issue file's frontmatter directly (status: in-progress | in-review) and append to its ## Comments section (format: "### <author> — <ISO timestamp>").
`;
}
