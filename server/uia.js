// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The agent's view of desktop apps it started: their windows, their controls as numbered text, clicking, typing,
// keys, a picture of a window, closing. Windows uses UI Automation (uiahost.ps1), macOS the Accessibility API
// (axhost.swift, built once with Apple's Command Line Tools), Linux AT-SPI (atspihost.py). Every call is limited to
// the processes of one of the agent's background jobs (server/bgjobs.js), so the user's own windows are never read
// or touched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psHost, lineHost, jobCount } from './jobhost.js';
import { getBackground } from './bgjobs.js';
import { HOME } from './openrouter.js';
import { treeText, macKeyEvents, parseSendKeys } from './deskkit.js';

const OS = process.platform;
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

// macOS: the Swift helper is built on first use into QuorX's data folder (out of the agent's reach), named by a
// hash of its source so an update builds it again. Building takes a minute once.
function macHost() {
  const src = here('./axhost.swift');
  let sum = 'x'; try { sum = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10); } catch { /* reported when it runs */ }
  const bin = path.join(HOME, 'data', 'helpers', `axhost-${sum}`);
  const script = 'command -v swiftc >/dev/null 2>&1 || { echo "the desktop tool builds a small helper once and needs Apple’s Command Line Tools for that: run xcode-select --install yourself, then try again" >&2; exit 1; }; '
    + 'test -x "$1" || { mkdir -p "$(dirname "$1")" && swiftc -O -o "$1.tmp" "$2" && mv "$1.tmp" "$1"; } || exit 1; exec "$1"';
  return lineHost(() => spawn('/bin/sh', ['-c', script, 'sh', bin, src], { stdio: ['pipe', 'pipe', 'pipe'] }), { label: 'desktop helper', readyMs: 240000 });
}
const U = OS === 'win32' ? psHost('./uiahost.ps1', { label: 'desktop helper', readyMs: 30000 })
  : OS === 'darwin' ? macHost()
  : OS === 'linux' ? lineHost(() => spawn('python3', ['-I', here('./atspihost.py')], { stdio: ['pipe', 'pipe', 'pipe'] }), { label: 'desktop helper', readyMs: 30000 })
  : lineHost(() => null, { why: `the desktop tool doesn't work on ${OS} yet` });
export const desktopAvailable = U.available;

// The processes a job may show windows for: everything still alive in its job (Windows job or process group).
async function pidsOf(jobId) {
  const j = getBackground(jobId);
  if (!j) throw new Error(`no background job ${jobId}: start the app with shell and background: true first`);
  if (j.status !== 'running') throw new Error(`job ${jobId} has ${j.status}${j.code != null ? ` (exit code ${j.code})` : ''}; start the app again`);
  if (!j.proc?.qxJob) throw new Error('desktop apps can only be reached when the job host is running (⚙ Approvals & safety → Stop)');
  const c = await jobCount(j.proc.qxJob);
  if (!c.pids.length) throw new Error(`job ${jobId} has no running processes`);
  return c.pids.map(Number);
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** The job's top-level windows: [{ handle, pid, title }]. Waits up to `wait` ms for the first one to appear. */
export async function appWindows(jobId, wait = 0) {
  const t0 = Date.now();
  for (;;) {
    const r = await U.call('windows', { pids: await pidsOf(jobId) }, 20000);
    const w = arr(r.windows);
    if (w.length || Date.now() - t0 >= wait) return w;
    await new Promise((x) => setTimeout(x, 500));
  }
}
const pick = async (jobId, handle) => {
  const pids = await pidsOf(jobId);
  let h = Number(handle);
  if (!h) { const w = await appWindows(jobId, 8000); if (!w.length) throw new Error(`job ${jobId} has no window yet`); h = w[0].handle; }
  return { pids, handle: h };
};
// Windows' helper writes the text itself; the others return nodes, written the same way by deskkit.js.
export async function readWindow(jobId, handle, { depth = 25, max = 250 } = {}) {
  const p = await pick(jobId, handle);
  const r = await U.call('tree', { ...p, depth, max }, 30000);
  return { ...p, text: r.nodes ? treeText(r.nodes, { more: r.more }) : r.text };
}
export async function clickControl(jobId, handle, ref) { const p = await pick(jobId, handle); return (await U.call('click', { ...p, ref: Number(ref) }, 15000)).did; }
export async function clickAt(jobId, handle, x, y) { const p = await pick(jobId, handle); return (await U.call('clickxy', { ...p, x: Math.round(Number(x)), y: Math.round(Number(y)) }, 15000)).did; }
export async function setControl(jobId, handle, ref, text) { const p = await pick(jobId, handle); return (await U.call('set', { ...p, ref: Number(ref), text: String(text ?? '') }, 15000)).did; }
// SendKeys text on every system; on macOS ^ is the Command key, as Ctrl is on Windows (^s saves, ^c copies).
export async function sendKeys(jobId, handle, keys) {
  const p = await pick(jobId, handle), k = String(keys ?? '');
  const args = OS === 'win32' ? { keys: k } : { events: OS === 'darwin' ? macKeyEvents(k) : parseSendKeys(k) };
  return (await U.call('keys', { ...p, ...args }, 15000)).did;
}
export async function windowShot(jobId, handle) { const p = await pick(jobId, handle); return `data:image/png;base64,${(await U.call('shot', p, 20000)).png}`; }
export async function closeWindow(jobId, handle) { const p = await pick(jobId, handle); return (await U.call('close', p, 15000)).did; }
