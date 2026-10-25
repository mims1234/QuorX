// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Is there an Electron release whose built-in Node has the October 2026 security fixes (Brotli, TLS hostnames), and
// does the desktop app use one yet? The desktop app runs QuorX's server on Electron's own Node, so the fix reaches
// installed apps only through an Electron bump. Run daily by .github/workflows/electron-watch.yml; by hand:
//   node scripts/electron-watch.mjs
// Prints the verdict and, on GitHub Actions, writes state=fixed|ready|waiting and the versions to GITHUB_OUTPUT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The first fixed release of each Node line (the Node.js security releases of 21 October 2026).
const FIXED = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const fixed = (v) => {
  const [maj, min, pat] = String(v).split('.').map(Number);
  if (maj > 26) return true;
  const f = FIXED[maj];
  return !!f && (min > f[0] || (min === f[0] && pat >= f[1]));
};
const num = (v) => String(v).split('.').map(Number);
const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
const current = String(pkg.devDependencies?.electron || pkg.dependencies?.electron || '').replace(/^[^\d]*/, '');
const releases = await (await fetch('https://releases.electronjs.org/releases.json')).json();
const stable = releases.filter((r) => /^\d+\.\d+\.\d+$/.test(r.version));
const mine = stable.find((r) => r.version === current);
const best = stable.filter((r) => fixed(r.node) && !newer(current, r.version)).sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
const sameMajor = best.find((r) => num(r.version)[0] === num(current)[0]);
const pick = sameMajor || best.at(-1) || null; // the newest fixed one in the same major, else the oldest fixed newer major

let state, text;
if (mine && fixed(mine.node)) { state = 'fixed'; text = `Electron ${current} ships Node ${mine.node}, which has the fix. Nothing to do.`; }
else if (pick) { state = 'ready'; text = `Electron ${current} ships Node ${mine?.node || '?'} (affected). Electron ${pick.version} (${pick.date}) ships Node ${pick.node}, which has the fix: bump desktop/package.json to it, run npm run desktop:setup, and release.`; }
else { state = 'waiting'; text = `Electron ${current} ships Node ${mine?.node || '?'} (affected), and no stable Electron release has a fixed Node yet. The watch checks again every day.`; }
console.log(text);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\ncurrent=${current}\nnode=${mine?.node || ''}\npick=${pick?.version || ''}\npick_node=${pick?.node || ''}\ntext=${text}\n`);
