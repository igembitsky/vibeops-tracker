// Markdown-file issue store. One file per issue under <dataDir>/<project>/issues/.
// All functions take dataDir explicitly so tests can use temp dirs.
//
// Body sections are delimited by HTML-comment sentinels (Backlog.md-style) so user
// content containing markdown headings round-trips intact. Files without sentinels
// (hand-written) fall back to heading-based parsing.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const STATUSES = ['backlog', 'on-deck', 'in-progress', 'in-review', 'done'];
export const TYPES = ['bug', 'improvement', 'feature', 'other'];

const SECTIONS = [
  { name: 'SEEING', heading: 'Seeing' },
  { name: 'EXPECTING', heading: 'Expecting' },
  { name: 'CONTEXT', heading: 'Context' },
  { name: 'RESOLUTION', heading: 'Resolution' },
  { name: 'COMMENTS', heading: 'Comments' },
];
const PATCHABLE = ['status', 'ordinal', 'title', 'tags', 'severity', 'type', 'relatedTo'];
const MIN_ORDINAL_GAP = 1e-6;
const ORDINAL_STEP = 1000;
// Comment headers must carry an ISO timestamp, so heading-like lines inside
// comment text don't get mistaken for comment boundaries.
const COMMENT_HEADER_RE = /^### (.+) — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)[ \t]*$/;

// ---- locking ---------------------------------------------------------------
// mkdir is atomic across processes; the web server and the MCP server may both
// mutate the store. Sync spin keeps the store API synchronous.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(lockBase, fn) {
  const dir = `${lockBase}.lock`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 5000) {
          fs.rmdirSync(dir); // stale lock from a crashed process
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        const e = new Error(`store lock timeout: ${dir}`);
        e.statusCode = 503; // contention, not a client error
        throw e;
      }
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function notFound(id) {
  const err = new Error(`Issue not found: ${id}`);
  err.code = 'NOT_FOUND';
  return err;
}

function sanitizeProjectKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('project key is required');
  const clean = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!clean) throw new Error(`invalid project key: ${key}`);
  return clean;
}

function projectsFile(dataDir) {
  return path.join(dataDir, 'projects.json');
}

export function listProjects(dataDir) {
  const file = projectsFile(dataDir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ensureProject(dataDir, key, name, repoPath) {
  const clean = sanitizeProjectKey(key);
  return withLock(path.join(dataDir, '.registry'), () => {
    const projects = listProjects(dataDir);
    let project = projects.find((p) => p.key === clean);
    let changed = false;
    if (!project) {
      project = { key: clean, name: name || clean };
      projects.push(project);
      changed = true;
    }
    if (name && project.name !== name) {
      project.name = name;
      changed = true;
    }
    if (repoPath && project.repo_path !== repoPath) {
      project.repo_path = repoPath;
      changed = true;
    }
    if (changed) writeFileAtomic(projectsFile(dataDir), JSON.stringify(projects, null, 2) + '\n');
    return project;
  });
}

export function getProject(dataDir, key) {
  return listProjects(dataDir).find((p) => p.key === key) || null;
}

function issuesDir(dataDir, projectKey) {
  return path.join(dataDir, projectKey, 'issues');
}

function closedDir(dataDir, projectKey) {
  return path.join(dataDir, projectKey, 'closed');
}

function iceboxDir(dataDir, projectKey) {
  return path.join(dataDir, projectKey, 'icebox');
}

function projectLock(dataDir, projectKey) {
  return path.join(dataDir, projectKey, '.project');
}

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'untitled'
  );
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

// ---- serialization ----------------------------------------------------------

function contextSummaryLines(context) {
  const lines = [];
  if (context?.url) lines.push(`- **URL:** ${context.url}`);
  if (context?.viewport?.w) lines.push(`- **Viewport:** ${context.viewport.w}x${context.viewport.h}`);
  if (context?.capturedAt) lines.push(`- **Captured:** ${context.capturedAt}`);
  return lines;
}

function sectionBlock(name, heading, content) {
  return `<!-- SECTION:${name}:BEGIN -->\n## ${heading}\n\n${content}\n<!-- SECTION:${name}:END -->`;
}

function serializeIssue(issue) {
  const fm = {
    id: issue.id,
    project: issue.project,
    title: issue.title,
    status: issue.status,
    type: issue.type,
    tags: issue.tags,
    severity: issue.severity,
    ordinal: issue.ordinal,
    created: issue.created,
    updated: issue.updated,
  };
  if (issue.relatedTo) fm.related_to = issue.relatedTo;
  if (issue.modifiedFiles?.length) fm.modified_files = issue.modifiedFiles;
  if (issue.closed) fm.closed = issue.closed;
  if (issue.iceboxed) fm.iceboxed = issue.iceboxed;

  const blocks = [];
  blocks.push(sectionBlock('SEEING', 'Seeing', `${issue.seeing || ''}\n`));
  blocks.push(sectionBlock('EXPECTING', 'Expecting', `${issue.expecting || ''}\n`));
  if (issue.context) {
    const summary = contextSummaryLines(issue.context);
    const body =
      (summary.length ? summary.join('\n') + '\n\n' : '') +
      '```json\n' +
      JSON.stringify(issue.context, null, 2) +
      '\n```\n';
    blocks.push(sectionBlock('CONTEXT', 'Context', body));
  }
  if (issue.resolution) blocks.push(sectionBlock('RESOLUTION', 'Resolution', `${issue.resolution}\n`));
  const comments = (issue.comments || [])
    .map((c) => `### ${c.author} — ${c.at || new Date().toISOString()}\n\n${c.text}\n`)
    .join('\n');
  blocks.push(sectionBlock('COMMENTS', 'Comments', comments));

  return matter.stringify('\n' + blocks.join('\n\n') + '\n', fm);
}

// ---- parsing ----------------------------------------------------------------

function extractSentinelSection(body, name) {
  const re = new RegExp(`<!-- SECTION:${name}:BEGIN -->\\n([\\s\\S]*?)<!-- SECTION:${name}:END -->`);
  const m = re.exec(body);
  if (!m) return null;
  let content = m[1];
  content = content.replace(/^## [^\n]*\n/, ''); // drop the human-readable heading line
  return content.replace(/^\n+/, '').replace(/\s+$/, '');
}

// Heading-based fallback for hand-written files without sentinels.
function splitSectionsByHeadings(body) {
  const names = SECTIONS.map((s) => s.heading);
  const re = new RegExp(`^## (${names.join('|')})[ \\t]*$`, 'gm');
  const hits = [];
  let m;
  while ((m = re.exec(body)) !== null) hits.push({ name: m[1], start: m.index, contentStart: m.index + m[0].length });
  const sections = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : body.length;
    sections[hits[i].name] = body.slice(hits[i].contentStart, end).replace(/^\n+/, '').replace(/\s+$/, '');
  }
  return sections;
}

function extractSections(body) {
  if (body.includes('<!-- SECTION:')) {
    const out = {};
    for (const s of SECTIONS) out[s.heading] = extractSentinelSection(body, s.name);
    return out;
  }
  return splitSectionsByHeadings(body);
}

function parseContextSection(text) {
  if (!text) return null;
  const open = text.indexOf('```json\n');
  if (open === -1) return null;
  const close = text.indexOf('\n```', open + 8);
  if (close === -1) return null;
  try {
    return JSON.parse(text.slice(open + 8, close));
  } catch {
    return null;
  }
}

function parseCommentsSection(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const comments = [];
  let current = null;
  for (const line of lines) {
    const m = COMMENT_HEADER_RE.exec(line);
    if (m) {
      if (current) comments.push(finishComment(current));
      current = { author: m[1], at: m[2], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) comments.push(finishComment(current));
  return comments;
}

function finishComment(c) {
  const text = c.body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { author: c.author, at: c.at, text };
}

function parseIssueFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = matter(raw);
  const data = { ...fm.data };
  if (!data.id || !data.project) return null;
  const sections = extractSections(fm.content);
  return {
    id: String(data.id),
    project: String(data.project),
    title: data.title == null ? '' : String(data.title),
    status: data.status || 'backlog',
    type: data.type || 'other',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    severity: Number(data.severity) || 3,
    ordinal: Number(data.ordinal) || 0,
    created: toIso(data.created) || null,
    updated: toIso(data.updated) || null,
    relatedTo: data.related_to ? String(data.related_to) : null,
    modifiedFiles: Array.isArray(data.modified_files) ? data.modified_files.map(String) : [],
    closed: toIso(data.closed) || null,
    iceboxed: toIso(data.iceboxed) || null,
    seeing: sections.Seeing || '',
    expecting: sections.Expecting || '',
    context: parseContextSection(sections.Context),
    resolution: sections.Resolution || null,
    comments: parseCommentsSection(sections.Comments),
    file,
  };
}

function readProjectIssues(dataDir, projectKey, dir = issuesDir(dataDir, projectKey)) {
  if (!fs.existsSync(dir)) return [];
  const issues = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      const issue = parseIssueFile(file);
      if (issue) issues.push(issue);
      else console.warn(`[issue-tracker] skipping malformed issue file: ${file}`);
    } catch (err) {
      console.warn(`[issue-tracker] skipping unreadable issue file: ${file} (${err.message})`);
    }
  }
  return issues;
}

function parseId(id) {
  const m = /^(.+)-(\d+)$/.exec(String(id || ''));
  if (!m) return null;
  // Sanitize the project segment the same way createIssue does, so a crafted id
  // (e.g. "../../etc-1") can never steer the derived issues/closed path outside
  // the data dir. Stored ids are already clean, so legit lookups are unaffected.
  const project = m[1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return { project, seq: Number(m[2]) };
}

function findIssue(dataDir, id) {
  const parsed = parseId(id);
  if (!parsed) return null;
  return (
    readProjectIssues(dataDir, parsed.project).find((i) => i.id === id) ||
    readProjectIssues(dataDir, parsed.project, iceboxDir(dataDir, parsed.project)).find((i) => i.id === id) ||
    readProjectIssues(dataDir, parsed.project, closedDir(dataDir, parsed.project)).find((i) => i.id === id) ||
    null
  );
}

function assertOpen(issue) {
  if (issue.closed) {
    const err = new Error(`Issue is closed (swept to archive): ${issue.id}`);
    err.code = 'CLOSED';
    throw err;
  }
  if (issue.iceboxed) {
    const err = new Error(`Issue is in the icebox; bring it back to the board first: ${issue.id}`);
    err.code = 'ICEBOXED';
    throw err;
  }
}

function validatePatchValue(key, value) {
  if (key === 'status' && !STATUSES.includes(value)) throw new Error(`Invalid status: ${value}`);
  if (key === 'type' && !TYPES.includes(value)) throw new Error(`Invalid type: ${value}`);
  if (key === 'severity') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`Invalid severity: ${value}`);
    return n;
  }
  if (key === 'ordinal') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid ordinal: ${value}`);
    return n;
  }
  if (key === 'tags') {
    if (!Array.isArray(value)) throw new Error('Invalid tags: expected array');
    return value.map(String);
  }
  if (key === 'title') return String(value);
  if (key === 'relatedTo') return value == null ? null : String(value);
  return value;
}

// When midpoint inserts exhaust the gap between neighbors, rewrite the whole
// column on a fresh 1000-step grid (Backlog.md's approach).
function resequenceIfCramped(dataDir, projectKey, status) {
  const column = readProjectIssues(dataDir, projectKey)
    .filter((i) => i.status === status)
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  let cramped = false;
  for (let i = 1; i < column.length; i++) {
    if (Math.abs(column[i].ordinal - column[i - 1].ordinal) < MIN_ORDINAL_GAP) {
      cramped = true;
      break;
    }
  }
  if (!cramped) return;
  column.forEach((issue, idx) => {
    issue.ordinal = (idx + 1) * ORDINAL_STEP;
    writeFileAtomic(issue.file, serializeIssue(issue));
  });
}

export function createIssue(dataDir, input) {
  const project = sanitizeProjectKey(input.project);
  if (!input.seeing || !String(input.seeing).trim()) throw new Error('seeing is required');
  if (!input.expecting || !String(input.expecting).trim()) throw new Error('expecting is required');
  ensureProject(dataDir, project);

  return withLock(projectLock(dataDir, project), () => {
    const existing = readProjectIssues(dataDir, project);
    const closed = readProjectIssues(dataDir, project, closedDir(dataDir, project));
    const iced = readProjectIssues(dataDir, project, iceboxDir(dataDir, project));
    const maxSeq = [...existing, ...closed, ...iced].reduce((max, i) => Math.max(max, parseId(i.id)?.seq || 0), 0);
    const maxOrdinal = existing.reduce((max, i) => Math.max(max, i.ordinal || 0), 0);
    const now = new Date().toISOString();

    const issue = {
      id: `${project}-${maxSeq + 1}`,
      project,
      title: input.title ? String(input.title) : '',
      status: 'backlog',
      type: TYPES.includes(input.type) ? input.type : 'other',
      tags: validatePatchValue('tags', Array.isArray(input.tags) ? input.tags : []),
      severity: input.severity == null ? 3 : validatePatchValue('severity', input.severity),
      ordinal: maxOrdinal + ORDINAL_STEP,
      created: now,
      updated: now,
      relatedTo: input.relatedTo ? String(input.relatedTo) : null,
      seeing: String(input.seeing),
      expecting: String(input.expecting),
      context: input.context ?? null,
      comments: [],
    };
    const file = path.join(issuesDir(dataDir, project), `${issue.id}-${slugify(issue.title)}.md`);
    writeFileAtomic(file, serializeIssue(issue));
    return { ...issue, file };
  });
}

export function getIssue(dataDir, id) {
  return findIssue(dataDir, id);
}

export function listIssues(dataDir, projectKey, { status } = {}) {
  let issues = readProjectIssues(dataDir, projectKey);
  if (status) issues = issues.filter((i) => i.status === status);
  return issues.sort((a, b) => {
    const s = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
    if (s !== 0) return s;
    return a.ordinal - b.ordinal || a.id.localeCompare(b.id);
  });
}

export function updateIssue(dataDir, id, patch) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    assertOpen(issue);
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCHABLE.includes(key)) throw new Error(`Cannot update field: ${key}`);
      issue[key] = validatePatchValue(key, value);
    }
    issue.updated = new Date().toISOString();
    writeFileAtomic(issue.file, serializeIssue(issue));
    if ('ordinal' in patch) resequenceIfCramped(dataDir, issue.project, issue.status);
    return 'ordinal' in patch ? findIssue(dataDir, id) : issue;
  });
}

export function resolveIssue(dataDir, id, { resolution, modifiedFiles } = {}) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  if (!resolution || !String(resolution).trim()) throw new Error('resolution is required');
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    assertOpen(issue);
    issue.resolution = String(resolution);
    issue.modifiedFiles = Array.isArray(modifiedFiles) ? modifiedFiles.map(String) : issue.modifiedFiles;
    issue.status = 'in-review';
    issue.updated = new Date().toISOString();
    writeFileAtomic(issue.file, serializeIssue(issue));
    return issue;
  });
}

export function sweepDone(dataDir, projectKey) {
  const project = sanitizeProjectKey(projectKey);
  return withLock(projectLock(dataDir, project), () => {
    const done = readProjectIssues(dataDir, project).filter((i) => i.status === 'done');
    const now = new Date().toISOString();
    const swept = [];
    for (const issue of done) {
      issue.closed = now;
      const dest = path.join(closedDir(dataDir, project), path.basename(issue.file));
      writeFileAtomic(dest, serializeIssue(issue));
      fs.rmSync(issue.file);
      swept.push({ ...issue, file: dest });
    }
    return swept;
  });
}

// Permanently remove an issue file (open OR archived). Unlike the other
// mutations this intentionally does NOT assertOpen. Deleting stale / test /
// no-longer-useful issues, including swept ones, is the whole point. Hard
// delete is irreversible and has no MCP equivalent, so only a human at the
// board (or a deliberate REST call) can do it. Note on ids: deleting the
// highest-numbered issue frees that id for reuse by the next createIssue;
// deleting any other issue just leaves a gap in the sequence.
export function deleteIssue(dataDir, id) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    // force: if the file vanished after findIssue (an out-of-lock `rm`, a git
    // checkout in data/), treat it as already-deleted rather than throwing a
    // path-leaking ENOENT. The intent (make it gone) is satisfied either way.
    fs.rmSync(issue.file, { force: true });
    return { deleted: issue.id, project: issue.project, title: issue.title, wasClosed: !!issue.closed };
  });
}

export function listClosed(dataDir, projectKey) {
  return readProjectIssues(dataDir, projectKey, closedDir(dataDir, projectKey)).sort((a, b) =>
    String(b.closed).localeCompare(String(a.closed))
  );
}

// ---- icebox ----------------------------------------------------------------
// A parking lot for backlog items you are deferring. Sending one here moves its
// file to <project>/icebox/ and stamps `iceboxed`; it drops off the board (and
// off agents' list_issues, which only read issues/) but is fully revivable.
// Only backlog issues can be iceboxed, and reviving always returns the item to
// the bottom of the Backlog column.

export function iceboxIssue(dataDir, id) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    if (issue.iceboxed) return issue; // already parked
    assertOpen(issue); // rejects closed/archived issues
    if (issue.status !== 'backlog') throw new Error('Only backlog issues can be moved to the icebox');
    issue.iceboxed = new Date().toISOString();
    issue.updated = issue.iceboxed;
    const dest = path.join(iceboxDir(dataDir, parsed.project), path.basename(issue.file));
    writeFileAtomic(dest, serializeIssue(issue));
    fs.rmSync(issue.file);
    return { ...issue, file: dest };
  });
}

export function reviveIssue(dataDir, id) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    if (!issue.iceboxed) throw new Error(`Issue is not in the icebox: ${id}`);
    // Always return to the bottom of the Backlog column.
    const backlogMax = readProjectIssues(dataDir, parsed.project)
      .filter((i) => i.status === 'backlog')
      .reduce((max, i) => Math.max(max, i.ordinal || 0), 0);
    issue.iceboxed = null;
    issue.status = 'backlog';
    issue.ordinal = backlogMax + ORDINAL_STEP;
    issue.updated = new Date().toISOString();
    const dest = path.join(issuesDir(dataDir, parsed.project), path.basename(issue.file));
    writeFileAtomic(dest, serializeIssue(issue));
    if (issue.file !== dest) fs.rmSync(issue.file);
    return { ...issue, file: dest };
  });
}

export function listIcebox(dataDir, projectKey) {
  return readProjectIssues(dataDir, projectKey, iceboxDir(dataDir, projectKey)).sort((a, b) =>
    String(b.iceboxed).localeCompare(String(a.iceboxed))
  );
}

export function searchIssues(dataDir, { query, project, status, includeClosed = false, limit = 50 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const keys = project ? [sanitizeProjectKey(project)] : listProjects(dataDir).map((p) => p.key);
  const results = [];
  for (const key of keys) {
    let issues = listIssues(dataDir, key, { status });
    if (includeClosed) issues = issues.concat(listClosed(dataDir, key));
    for (const issue of issues) {
      const haystack = [
        issue.id,
        issue.title,
        issue.tags.join(' '),
        issue.seeing,
        issue.expecting,
        issue.resolution || '',
        issue.comments.map((c) => `${c.author} ${c.text}`).join(' '),
      ]
        .join('\n')
        .toLowerCase();
      if (haystack.includes(q)) results.push(issue);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export function addComment(dataDir, id, { author, text }) {
  const parsed = parseId(id);
  if (!parsed) throw notFound(id);
  if (!author || !String(author).trim()) throw new Error('author is required');
  if (!text || !String(text).trim()) throw new Error('text is required');
  return withLock(projectLock(dataDir, parsed.project), () => {
    const issue = findIssue(dataDir, id);
    if (!issue) throw notFound(id);
    assertOpen(issue);
    issue.comments.push({ author: String(author), at: new Date().toISOString(), text: String(text) });
    issue.updated = new Date().toISOString();
    writeFileAtomic(issue.file, serializeIssue(issue));
    return issue;
  });
}
