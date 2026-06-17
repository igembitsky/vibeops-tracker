// REST API router. handleApi returns true when the request was an /api route.
import {
  listProjects,
  ensureProject,
  getProject,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addComment,
  resolveIssue,
  sweepDone,
  listClosed,
  deleteIssue,
} from './store.mjs';
import { buildPrompt } from './prompt.mjs';

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// CSRF guard for destructive, board-only mutations. The capture widget POSTs
// cross-origin (that must stay allowed), but DELETE/PATCH are only ever issued
// by the same-origin board UI or by header-less callers (curl, MCP). A browser
// always attaches a truthful Origin on cross-origin unsafe requests, so any
// request whose Origin doesn't match this server is a drive-by and is refused.
// Header-less callers (no Origin) pass — they aren't the CSRF threat.
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${req.headers.host}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        const err = new Error('body too large');
        err.statusCode = 400;
        req.destroy(err);
        reject(err);
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    const err = new Error('invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

export async function handleApi(req, res, { dataDir }) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return false;

  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if ((req.method === 'DELETE' || req.method === 'PATCH') && !isSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin mutation refused' });
    return true;
  }

  const route = `${req.method} ${pathname}`;
  let match;
  try {
    if (route === 'GET /api/projects') {
      sendJson(res, 200, listProjects(dataDir));
    } else if (route === 'POST /api/projects') {
      const body = await readJsonBody(req);
      sendJson(res, 201, ensureProject(dataDir, body.key, body.name, body.repo_path));
    } else if ((match = /^GET \/api\/projects\/([^/]+)\/issues$/.exec(route))) {
      const status = url.searchParams.get('status') || undefined;
      sendJson(res, 200, listIssues(dataDir, decodeURIComponent(match[1]), { status }));
    } else if ((match = /^GET \/api\/projects\/([^/]+)\/closed$/.exec(route))) {
      sendJson(res, 200, listClosed(dataDir, decodeURIComponent(match[1])));
    } else if ((match = /^POST \/api\/projects\/([^/]+)\/sweep$/.exec(route))) {
      sendJson(res, 200, sweepDone(dataDir, decodeURIComponent(match[1])));
    } else if (route === 'POST /api/issues') {
      const body = await readJsonBody(req);
      sendJson(res, 201, createIssue(dataDir, body));
    } else if ((match = /^GET \/api\/issues\/([^/]+)\/prompt$/.exec(route))) {
      const issue = getIssue(dataDir, decodeURIComponent(match[1]));
      if (!issue) return sendJson(res, 404, { error: `Issue not found: ${match[1]}` }), true;
      const project = getProject(dataDir, issue.project);
      sendText(res, 200, buildPrompt(issue, { apiBase: `http://${req.headers.host}`, project }));
    } else if ((match = /^POST \/api\/issues\/([^/]+)\/resolve$/.exec(route))) {
      const body = await readJsonBody(req);
      sendJson(res, 200, resolveIssue(dataDir, decodeURIComponent(match[1]), body));
    } else if ((match = /^GET \/api\/issues\/([^/]+)$/.exec(route))) {
      const issue = getIssue(dataDir, decodeURIComponent(match[1]));
      if (!issue) return sendJson(res, 404, { error: `Issue not found: ${match[1]}` }), true;
      sendJson(res, 200, issue);
    } else if ((match = /^PATCH \/api\/issues\/([^/]+)$/.exec(route))) {
      const body = await readJsonBody(req);
      sendJson(res, 200, updateIssue(dataDir, decodeURIComponent(match[1]), body));
    } else if ((match = /^DELETE \/api\/issues\/([^/]+)$/.exec(route))) {
      sendJson(res, 200, deleteIssue(dataDir, decodeURIComponent(match[1])));
    } else if ((match = /^POST \/api\/issues\/([^/]+)\/comments$/.exec(route))) {
      const body = await readJsonBody(req);
      sendJson(res, 200, addComment(dataDir, decodeURIComponent(match[1]), body));
    } else {
      sendJson(res, 404, { error: `No route: ${route}` });
    }
  } catch (err) {
    if (err.code === 'NOT_FOUND') sendJson(res, 404, { error: err.message });
    else if (err.code === 'CLOSED') sendJson(res, 409, { error: err.message });
    else if (err.statusCode) sendJson(res, err.statusCode, { error: err.message });
    else if (err.name === 'Error') sendJson(res, 400, { error: err.message }); // validation throws are plain Errors
    else sendJson(res, 500, { error: err.message });
  }
  return true;
}
