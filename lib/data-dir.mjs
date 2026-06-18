// Resolve where VibeOps Tracker stores its data. The HTTP server, the CLI,
// and the MCP server all call this, so a human (board UI) and an agent (MCP)
// always read and write the same store.
//
// Precedence:
//   1. an explicit --data flag (passed in by the CLI). Caller wins.
//   2. the DATA_DIR environment variable (host / MCP config).
//   3. running from a git clone  →  <repoRoot>/data (gitignored, local).
//   4. installed globally or via npx (lives in node_modules) →  OS app-data dir
//
// Rationale: a cloned repo keeps its data beside the code (familiar, easy to
// back up). A globally-installed tool must persist data across upgrades and keep
// it private to the user, which is exactly what the per-user OS app-data dir
// gives you. It never lands inside node_modules, where a reinstall would wipe it.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'vibeops-tracker';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)); // <root>/lib
export const ROOT = path.dirname(MODULE_DIR); // package root

export function appDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP);
}

// True when this package lives inside a node_modules tree (global install / npx
// cache) rather than a developer's clone.
function isInstalledPackage() {
  return ROOT.split(path.sep).includes('node_modules');
}

export function resolveDataDir({ flag } = {}) {
  if (flag) return path.resolve(flag);
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (!isInstalledPackage()) return path.join(ROOT, 'data'); // clone → ./data
  return appDataDir();
}
