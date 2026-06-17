// Issue tracker server: tracker UI, /api/*, and the embeddable /widget.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleApi, setCors } from './lib/api.mjs';
import { resolveDataDir } from './lib/data-dir.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  if (pathname === '/widget.js') setCors(res);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(file));
}

export function startServer({ port = 4400, dataDir }) {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleApi(req, res, { dataDir });
      if (!handled) serveStatic(req, res);
    } catch (err) {
      console.error('[issue-tracker] request error:', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 4400;
  const dataDir = resolveDataDir();
  startServer({ port, dataDir }).then(() => {
    console.log(`VibeOps Tracker running at http://localhost:${port} (data: ${dataDir})`);
  });
}
