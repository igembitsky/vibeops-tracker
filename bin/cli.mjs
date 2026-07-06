#!/usr/bin/env node
// VibeOps Tracker CLI. Starts the board/API server (default) or the MCP stdio server.
// A thin, dependency-free dispatcher.
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  console.log(`VibeOps Tracker ${pkg.version}. Local-first issue tracker.

Usage:
  vibeops [start]        Start the board + API + capture widget (default)
  vibeops mcp            Start the MCP stdio server (for AI agent hosts)
  vibeops where          Print the data directory and exit
  vibeops service <install|uninstall|status>
                         Run the tracker as a login service that restarts if it
                         dies (macOS launchd; survives closed terminals/sessions)

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
} else if (cmd === 'service') {
  await service(args.filter((a) => !a.startsWith('-'))[1] || 'status');
} else if (cmd === 'start') {
  const port = Number(opt(['-p', '--port'], true) || process.env.PORT) || 4400;
  const { startServer, installCrashGuards } = await import('../server.mjs');
  installCrashGuards();
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

// ---- background service (macOS launchd) -------------------------------------
// `vibeops service install` registers a per-user LaunchAgent with RunAtLoad +
// KeepAlive: the tracker starts at login and launchd restarts it if it ever
// dies. This is the answer to servers started from a terminal tab or an agent
// session, which die with their parent. The node binary and data dir are pinned
// into the plist at install time (launchd agents get a minimal PATH, so "env
// node" would not resolve a version manager's node); re-run install after
// upgrading Node or moving the checkout.

async function service(sub) {
  if (process.platform !== 'darwin') {
    console.error('vibeops service currently supports macOS (launchd) only.');
    console.error('On Linux, run vibeops under a systemd user unit with Restart=always.');
    process.exit(1);
  }
  const label = 'com.vibeops.tracker';
  const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const logFile = path.join(os.homedir(), 'Library', 'Logs', 'vibeops-tracker.log');
  const domain = `gui/${process.getuid()}`;

  function launchctl(argv) {
    try {
      return execFileSync('launchctl', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return err; // callers inspect; launchctl "failures" are often benign (not loaded yet)
    }
  }
  function pid() {
    const out = launchctl(['list', label]);
    if (out instanceof Error) return null;
    const m = /"PID"\s*=\s*(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  }
  function xml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  if (sub === 'install') {
    const port = Number(opt(['-p', '--port'], true) || process.env.PORT) || 4400;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(ROOT, 'bin', 'cli.mjs'))}</string>
    <string>start</string>
    <string>--port</string><string>${port}</string>
    <string>--data</string><string>${xml(dataDir)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
    mkdirSync(path.dirname(plistFile), { recursive: true });
    writeFileSync(plistFile, plist);
    launchctl(['bootout', domain, plistFile]); // reinstall: ok if it was not loaded
    const res = launchctl(['bootstrap', domain, plistFile]);
    if (res instanceof Error) {
      console.error(`Could not load the service: ${res.stderr || res.message}`);
      process.exit(1);
    }
    console.log('VibeOps Tracker installed as a login service (launchd).');
    console.log(`  Board:   http://localhost:${port}`);
    console.log(`  Data:    ${dataDir}`);
    console.log(`  Plist:   ${plistFile}`);
    console.log(`  Log:     ${logFile}`);
    console.log('It starts at login and restarts automatically if it dies.');
    console.log('Note: the service pins this Node binary and checkout path; re-run');
    console.log('`vibeops service install` after upgrading Node or moving the repo.');
  } else if (sub === 'uninstall') {
    launchctl(['bootout', domain, plistFile]);
    if (existsSync(plistFile)) rmSync(plistFile);
    console.log('VibeOps Tracker service stopped and removed.');
  } else if (sub === 'status') {
    if (!existsSync(plistFile)) {
      console.log('Not installed. Run: vibeops service install');
      return;
    }
    const p = pid();
    console.log(p ? `Running (pid ${p}).` : 'Installed but not running (launchd will retry; check the log).');
    console.log(`  Plist:  ${plistFile}`);
    console.log(`  Log:    ${path.join(os.homedir(), 'Library', 'Logs', 'vibeops-tracker.log')}`);
  } else {
    console.error(`Unknown service subcommand: ${sub} (expected install, uninstall, or status)`);
    process.exit(1);
  }
}
