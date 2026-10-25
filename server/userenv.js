// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The environment for the user's own terminal, and a PATH that keeps up with installers.
// - userEnv(): your Terminal tabs are a normal terminal: everything QuorX was started with (your tokens too),
//   colours on, and programs may open the browser (gh auth login, npm login). The agent's commands use childEnv()
//   in workspace.js instead, which drops secrets and turns colours and the browser off.
// - freshPath(): on Windows an installer (winget, rustup, the Node or Python setup) adds its folder to PATH in the
//   registry, but QuorX keeps the PATH it started with, so a tool installed during a chat would not be found until
//   QuorX restarted. Every command's PATH is QuorX's own, then whatever the registry has that it lacks.
import { execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';

// %VAR% in a registry entry, from `env` (any case, as Windows does); an unknown one stays as written.
const expand = (s, env) => String(s || '').replace(/%([^%]+)%/g, (all, v) => {
  const k = Object.keys(env).find((x) => x.toLowerCase() === v.toLowerCase());
  return k != null && env[k] != null ? env[k] : all;
});
const same = (p) => p.trim().replace(/[\\/]+$/, '').toLowerCase();

/**
 * PATH from the current one plus the registry's Machine and User PATH: the current entries first, unchanged (so nvm
 * and other entries only this session has survive), then each registry entry the current PATH lacks. Compared
 * without case or a trailing slash. A pure function: `env` only expands %VAR% in the registry strings.
 */
export function mergePath(current, machine, user, env = {}) {
  const out = String(current || '').split(';').filter((p) => p.trim());
  const have = new Set(out.map(same));
  for (const p of [...String(machine || '').split(';'), ...String(user || '').split(';')].map((x) => expand(x, env).trim())) {
    if (!p || have.has(same(p))) continue;
    have.add(same(p));
    out.push(p);
  }
  return out.join(';');
}

// The registry's PATH strings, read again at most every few seconds (reg.exe takes a few milliseconds).
const KEEP_MS = 5000;
let cached = null;
const regPath = (key) => {
  try {
    const o = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = o.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
    return m ? m[1].trim() : '';
  } catch { return ''; }
};
function registryPath() {
  if (cached && Date.now() - cached.at < KEEP_MS) return cached;
  cached = { at: Date.now(), machine: regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), user: regPath('HKCU\\Environment') };
  return cached;
}

/** `env` with its PATH brought up to date from the registry (Windows only; elsewhere `env` as it is). */
export function freshPath(env) {
  if (!WIN) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const r = registryPath();
  if (!r.machine && !r.user) return env;
  return { ...env, [key]: mergePath(env[key], r.machine, r.user, env) };
}

// What the desktop app sets only to start QuorX itself: a terminal with them would run Electron apps (and VS Code's
// `code`) as plain Node, or point another QuorX at this one's data and port.
const QUORX_ONLY = ['ELECTRON_RUN_AS_NODE', 'OH_DESKTOP', 'AGENT_PORT', 'OH_HOME'];

/** The user's terminal: the whole environment, a fresh PATH, and `extra` (TERM and the like). Nothing is hidden. */
export function userEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of QUORX_ONLY) delete env[k];
  return { ...freshPath(env), ...extra };
}
