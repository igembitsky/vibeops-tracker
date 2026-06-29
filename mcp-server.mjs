#!/usr/bin/env node
// MCP stdio server for the issue tracker. Reads/writes the markdown store
// directly, so it works even when the web server is down.
// Register (published):  claude mcp add vibeops -- npx -y -p vibeops-tracker vibeops-mcp
// Register (from clone):  claude mcp add vibeops -- node /path/to/vibeops-tracker/mcp-server.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  STATUSES,
  TYPES,
  listProjects,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addComment,
  resolveIssue,
  searchIssues,
  deleteIssue,
  iceboxIssue,
  reviveIssue,
} from './lib/store.mjs';
import { resolveDataDir } from './lib/data-dir.mjs';

const DATA_DIR = resolveDataDir();
const API_BASE = process.env.TRACKER_URL || 'http://localhost:4400';

const INSTRUCTIONS = `# Issue tracker: how agents should work with it

Issues are bug reports and feature requests captured from running apps (via an embedded
widget with a browser context snapshot) or filed by humans and agents. One markdown
file per issue lives under ${DATA_DIR}/<project>/issues/. NEVER edit those files directly.
Always go through these MCP tools (or the REST API at ${API_BASE}/api).
delete_issue permanently removes an issue (open or archived). It is IRREVERSIBLE. There
is no archive copy, and it requires confirm:true. Reserve it for stale, test,
duplicate, or clearly no-longer-relevant issues, and prefer to delete only when the
human asked or the issue is unambiguous junk. For real issues, prefer resolve_issue or
add_comment. Never move an issue to done yourself, since a human verifies in-review work.

Workflow:
1. search_issues first when filing, so you avoid duplicates; link regressions with related_to.
2. To pick up work: list_issues {project, status: "on-deck"}. On Deck is the human-curated,
   prioritized queue of work ready for agents; the FIRST result is the highest priority. Do NOT
   pull from Backlog (that is the human's triage pool), and never move issues into on-deck
   yourself; a human promotes Backlog to On Deck. Read the chosen issue fully with get_issue;
   the captured ## Context (URL, clicks, fetches, JS errors, capture-time git state) usually
   localizes the bug. Capture-time branch/worktree info may be stale, so verify against the
   repo's current state.
3. Before coding: update_issue {id, status: "in-progress"}. Reproduce from context first.
4. Leave add_comment notes (author: "claude") for anything notable mid-work.
5. Finish with resolve_issue {id, resolution, modified_files}, a PR-style summary of
   what changed, why, and how it was tested. This sets status to in-review; a HUMAN
   moves it to done after verifying. Never set done yourself.
6. File new issues you notice with create_issue (seeing/expecting required).

Statuses: ${STATUSES.join(' | ')}. Severity 1 (cosmetic) to 5 (blocker).
The icebox parks deferred backlog items: they keep their content but are hidden from
list_issues. Park a backlog item with icebox_issue {id} (backlog only) when it is not ready
to build, and bring it back to the Backlog with revive_issue {id}.`;

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List all projects registered in the issue tracker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => listProjects(DATA_DIR),
  },
  {
    name: 'list_issues',
    description:
      'List issues for a project, priority-ordered (by status, then board position). Optionally filter by status. Statuses: backlog, on-deck, in-progress, in-review, done. Agents pull work from on-deck (the human-curated ready queue); the first on-deck issue is the highest priority. Backlog is the human triage pool, not the agent queue. The captured browser context is omitted for brevity (hasContext flags it); call get_issue for the full snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key, e.g. "platform"' },
        status: { type: 'string', enum: STATUSES, description: 'Optional status filter' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: ({ project, status }) =>
      listIssues(DATA_DIR, project, { status }).map(({ context, ...rest }) => ({
        ...rest,
        hasContext: !!context,
      })),
  },
  {
    name: 'get_issue',
    description: 'Get one issue in full: fields, seeing/expecting, captured browser context, comments, and the path of its markdown file.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id, e.g. "platform-3"' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => {
      const issue = getIssue(DATA_DIR, id);
      if (!issue) {
        const err = new Error(`Issue not found: ${id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      return issue;
    },
  },
  {
    name: 'create_issue',
    description: 'File a new issue into the tracker (e.g. something noticed while working in a project).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key, e.g. "platform"' },
        title: { type: 'string' },
        type: { type: 'string', enum: TYPES, default: 'other' },
        severity: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        tags: { type: 'array', items: { type: 'string' } },
        seeing: { type: 'string', description: 'What is wrong / current behavior' },
        expecting: { type: 'string', description: 'Desired behavior / requirements' },
        relatedTo: { type: 'string', description: 'Optional id of a related prior issue' },
      },
      required: ['project', 'seeing', 'expecting'],
      additionalProperties: false,
    },
    handler: (args) => createIssue(DATA_DIR, args),
  },
  {
    name: 'update_issue',
    description:
      'Patch issue fields: status (set in-progress when you start working), title, type, severity, tags, related_to. Only the provided fields change. Board position (ordinal) is human-controlled and not patchable here.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        title: { type: 'string' },
        type: { type: 'string', enum: TYPES },
        severity: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' } },
        related_to: { type: 'string', description: 'Id of a related prior issue (regression chains)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id, related_to, ...rest }) => {
      const patch = { ...rest };
      if (related_to !== undefined) patch.relatedTo = related_to;
      if (!Object.keys(patch).length) throw new Error('provide at least one field to update');
      return updateIssue(DATA_DIR, id, patch);
    },
  },
  {
    name: 'resolve_issue',
    description:
      'Finish working an issue: record a PR-style resolution (what changed, why, how it was tested) plus the list of modified files, and move it to in-review for human verification. Use this instead of setting status done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        resolution: { type: 'string', description: 'What you changed, why, and how it was verified' },
        modified_files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you touched' },
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
    handler: ({ id, resolution, modified_files }) => resolveIssue(DATA_DIR, id, { resolution, modifiedFiles: modified_files }),
  },
  {
    name: 'search_issues',
    description:
      'Case-insensitive substring search across issue ids, titles, tags, seeing/expecting, resolutions, and comments. Search before filing to avoid duplicates. Searches all projects unless one is given; closed (swept) issues excluded unless include_closed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        include_closed: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: ({ query, project, status, include_closed, limit }) =>
      searchIssues(DATA_DIR, { query, project, status, includeClosed: include_closed, limit: limit || 20 }).map(
        ({ context, ...rest }) => ({ ...rest, hasContext: !!context })
      ),
  },
  {
    name: 'get_tracker_instructions',
    description: 'How to work with this issue tracker: the expected agent workflow, status semantics, and rules. Call this once before interacting with issues.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => INSTRUCTIONS,
    raw: true,
  },
  {
    name: 'add_comment',
    description: 'Append a comment to an issue (progress notes, questions, resolution summary).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        author: { type: 'string', description: 'Who is commenting, e.g. "claude"' },
        text: { type: 'string' },
      },
      required: ['id', 'author', 'text'],
      additionalProperties: false,
    },
    handler: ({ id, author, text }) => addComment(DATA_DIR, id, { author, text }),
  },
  {
    name: 'icebox_issue',
    description:
      'Park a backlog issue in the icebox to defer it. Only backlog issues can be iceboxed. It keeps its content but drops off the board and off list_issues until revived. Use this for backlog items that are not ready to build yet.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id, e.g. "platform-3"' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => iceboxIssue(DATA_DIR, id),
  },
  {
    name: 'revive_issue',
    description: 'Bring an iceboxed issue back onto the board, at the bottom of the Backlog column.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id, e.g. "platform-3"' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => reviveIssue(DATA_DIR, id),
  },
  {
    name: 'delete_issue',
    description:
      'Permanently delete an issue (open or archived). IRREVERSIBLE: the markdown file is removed with no archive copy (only git history could recover it). Reserve for stale, test, duplicate, or clearly no-longer-relevant issues; for real issues prefer resolve_issue or add_comment. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id, e.g. "platform-3"' },
        confirm: { type: 'boolean', description: 'Must be true to proceed. This is a deliberate-action guard for an irreversible delete.' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    handler: ({ id, confirm }) => {
      if (confirm !== true) throw new Error('refusing to delete without confirm: true (deletion is permanent and has no archive copy)');
      return deleteIssue(DATA_DIR, id);
    },
  },
];

const server = new Server(
  { name: 'issue-tracker', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    const result = tool.handler(req.params.arguments || {});
    const text = tool.raw ? String(result) : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const code = err.code ? ` [${err.code}]` : '';
    return { content: [{ type: 'text', text: `Error${code}: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
