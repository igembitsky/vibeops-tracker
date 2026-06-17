#!/usr/bin/env node
// VibeOps Tracker CLI — start the board/API server (default) or the MCP stdio server.
// A thin, dependency-free dispatcher.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveDataDir, ROOT } from '../lib/data-dir.mjs';

const args = process.argv.slice(2);

function opt(names, takesValue) {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1) return takesValue ? args[i + 1] : true;
  }
  return undefined;
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function help() {
  console.log(`VibeOps Tracker ${pkg.version} — local-first issue tracker

Usage:
  vibeops [start]        Start the board + API + capture widget (default)
  vibeops mcp            Start the MCP stdio server (for AI agent hosts)
  vibeops where          Print the data directory and exit

Options:
  -p, --port <n>      Server port (default 4400, or $PORT)
  -d, --data <dir>    Data directory (default: ./data in a clone, otherwise your
                      OS app-data dir; or set $DATA_DIR)
  -h, --help          Show this help
  -v, --version       Print the version

Everything runs locally. Docs: ${pkg.homepage || 'https://github.com/igembitsky/vibeops-tracker'}`);
}

if (opt(['-v', '--version'])) {
  console.log(pkg.version);
  process.exit(0);
}
if (opt(['-h', '--help'])) {
  help();
  process.exit(0);
}

const cmd = args.find((a) => !a.startsWith('-')) || 'start';
const dataDir = resolveDataDir({ flag: opt(['-d', '--data'], true) });

if (cmd === 'where') {
  console.log(dataDir);
} else if (cmd === 'mcp') {
  process.env.DATA_DIR = dataDir; // mcp-server.mjs resolves DATA_DIR at import time
  await import('../mcp-server.mjs');
} else if (cmd === 'start') {
  const port = Number(opt(['-p', '--port'], true) || process.env.PORT) || 4400;
  const { startServer } = await import('../server.mjs');
  try {
    await startServer({ port, dataDir });
    console.log('VibeOps Tracker is running.');
    console.log(`  Board:  http://localhost:${port}`);
    console.log(`  Data:   ${dataDir}`);
    console.log('Press Ctrl+C to stop.');
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: vibeops --port <other-port>`);
      process.exit(1);
    }
    throw err;
  }
} else {
  console.error(`Unknown command: ${cmd}\n`);
  help();
  process.exit(1);
}
