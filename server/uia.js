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

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// What a call may reach (`scope`): a background job's id ("bg1": every process still alive in its job), or
// { app: { name, appId } }, an app the chat opened by name (desktop open): the windows that app has open now.
async function reach(scope) {
  if (scope && typeof scope === 'object') {
    const wins = await windowsOfApp(scope.app);
    if (!wins.length) throw new Error(`${scope.app.name} has no open window: open it again with desktop open`);
    return { pids: [...new Set(wins.flatMap((w) => [w.pid, w.appPid]))], wins };
  }
  const jobId = scope, j = getBackground(jobId);
  if (!j) throw new Error(`no background job ${jobId}: start the app with shell and background: true first, or open an installed app with desktop open`);
  if (j.status !== 'running') throw new Error(`job ${jobId} has ${j.status}${j.code != null ? ` (exit code ${j.code})` : ''}; start the app again`);
  if (!j.proc?.qxJob) throw new Error('desktop apps can only be reached when the job host is running (⚙ Approvals & safety → Stop)');
  const c = await jobCount(j.proc.qxJob);
  if (!c.pids.length) throw new Error(`job ${jobId} has no running processes`);
  return { pids: c.pids.map(Number), wins: null };
}

/** Start-menu apps whose name matches `name` (exact names first): [{ name, appId }]. Windows only. */
export async function findApps(name) {
  if (OS !== 'win32') throw new Error('opening apps by name works on Windows for now');
  return arr((await U.call('apps', { name: String(name) }, 30000)).apps);
}
/** The names of the apps that have a window open now (Store apps by their Start-menu name). Windows only. */
export async function openAppNames() {
  if (OS !== 'win32') return [];
  return arr((await U.call('openapps', {}, 30000)).names).map(String);
}
/** The windows `app` ({ name, appId }) has open now: [{ handle, pid, appPid, title }]. */
export async function windowsOfApp(app) {
  if (OS !== 'win32') return [];
  return arr((await U.call('appwins', { appId: app.appId, name: app.name }, 20000)).windows);
}

/** The top-level windows in reach: [{ handle, pid, title }]. Waits up to `wait` ms for the first one to appear. */
export async function appWindows(scope, wait = 0) {
  const t0 = Date.now();
  for (;;) {
    const r = await reach(scope);
    const w = r.wins || arr((await U.call('windows', { pids: r.pids }, 20000)).windows);
    if (w.length || Date.now() - t0 >= wait) return w;
    await new Promise((x) => setTimeout(x, 500));
  }
}
const pick = async (scope, handle) => {
  const r = await reach(scope);
  let h = Number(handle);
  // An app's other windows are its own; any other window of the same host process (every Store app's frame is drawn
  // by ApplicationFrameHost) is not.
  if (h && r.wins && !r.wins.some((w) => Number(w.handle) === h)) throw new Error(`window ${h} isn't one of ${scope.app.name}'s windows: list them with windows`);
  if (!h) { const w = r.wins || await appWindows(scope, 8000); if (!w.length) throw new Error(`${typeof scope === 'object' ? scope.app.name : `job ${scope}`} has no window yet`); h = w[0].handle; }
  return { pids: r.pids, handle: h };
};
// Windows' helper writes the text itself; the others return nodes, written the same way by deskkit.js.
/** The words in a window's picture (Windows text recognition): "text" @x,y per line. */
export async function windowText(scope, handle) {
  winOnly('reading text from a picture');
  const p = await pick(scope, handle);
  const r = await U.call('ocr', p, 45000);
  return { ...p, text: String(r.text || '').trim(), via: r.via || 'window' };
}
// The title bar's own controls: a window that shows only these has no readable controls of its own.
const TITLE_BAR = /^\s*\[\d+\] (MenuItem "System"|Button "(Minimi[sz]e|Maximi[sz]e|Restore|Close)\b)/;
/** A window's controls as text. With none of its own (Unity, games, canvas apps) on Windows, the words in its picture
 *  are added, read by Windows' text recognition, each with the point to click_at. */
export async function readWindow(scope, handle, { depth = 25, max = 250 } = {}) {
  const p = await pick(scope, handle);
  // A window still filling in (a Save dialog listing its folders) can drop controls while they are read: wait a
  // little and read again before giving up. A read that timed out is not tried again.
  let r;
  for (let i = 0; ; i++) {
    try { r = await U.call('tree', { ...p, depth, max }, 30000); break; }
    catch (e) { if (i >= 2 || /timed out/i.test(e.message)) throw e; await new Promise((ok) => setTimeout(ok, 700 * (i + 1))); }
  }
  const text = r.nodes ? treeText(r.nodes, { more: r.more }) : r.text;
  const own = String(text).split('\n').filter((l) => /^\s*\[\d+\]/.test(l) && !TITLE_BAR.test(l));
  if (OS !== 'win32' || own.length) return { ...p, text };
  const seen = await U.call('ocr', p, 45000).catch((e) => ({ error: e.message }));
  if (seen.error) return { ...p, text: `${text}\n(No controls can be read in this window, and its text couldn't be read from its picture: ${seen.error}. Use screenshot and click_at.)` };
  const via = seen.via && seen.via !== 'window' ? ` (picture taken from the ${seen.via})` : '';
  return { ...p, ocr: true, text: `${text}\nThis window has no readable controls. Text read from its picture${via}, each line with its middle point for click_at:\n${String(seen.text || '').trim() || '(no text found: the window may be blank or still loading)'}` };
}
export async function clickControl(scope, handle, ref) { const p = await pick(scope, handle); return (await U.call('click', { ...p, ref: Number(ref) }, 15000)).did; }
export async function clickAt(scope, handle, x, y) { const p = await pick(scope, handle); return (await U.call('clickxy', { ...p, x: Math.round(Number(x)), y: Math.round(Number(y)) }, 15000)).did; }
// Typing goes key by key: a 1,500-character brief into Cline took longer than 15 s and came back "timed out" while it
// was still typing. The wait grows with the text (about 60 ms a character, up to 3 minutes).
const typeMs = (text) => Math.min(180000, 15000 + String(text ?? '').length * 60);
export async function setControl(scope, handle, ref, text) { const p = await pick(scope, handle); return (await U.call('set', { ...p, ref: Number(ref), text: String(text ?? '') }, typeMs(text))).did; }
// SendKeys text on every system; on macOS ^ is the Command key, as Ctrl is on Windows (^s saves, ^c copies).
export async function sendKeys(scope, handle, keys) {
  const p = await pick(scope, handle), k = String(keys ?? '');
  const args = OS === 'win32' ? { keys: k } : { events: OS === 'darwin' ? macKeyEvents(k) : parseSendKeys(k) };
  return (await U.call('keys', { ...p, ...args }, typeMs(k))).did;
}
// How the last picture was taken: 'window', or from the screen when the window's own picture was one flat colour.
let lastVia = '';
export const shotVia = () => lastVia;
export async function windowShot(scope, handle) { const p = await pick(scope, handle); const r = await U.call('shot', p, 20000); lastVia = r.via || 'window'; return `data:image/png;base64,${r.png}`; }
export async function closeWindow(scope, handle) { const p = await pick(scope, handle); return (await U.call('close', p, 15000)).did; }

// Windows only: the helpers for macOS and Linux don't have these yet.
const winOnly = (what) => { if (OS !== 'win32') throw new Error(`${what} works on Windows for now`); };
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Math.round(Number(v)));
/** Part of the window (window pixels), enlarged to read small text. */
export async function zoomWindow(scope, handle, x, y, w, h) { winOnly('zoom'); const p = await pick(scope, handle); return `data:image/png;base64,${(await U.call('zoom', { ...p, x: num(x), y: num(y), w: num(w, 200), h: num(h, 200) }, 20000)).png}`; }
/** kind: right, middle, double, hover, down, up; at a control (ref) or window pixels (x, y). */
export async function mouseAt(scope, handle, kind, { ref, x, y, button } = {}) { winOnly('that mouse action'); const p = await pick(scope, handle); return (await U.call('mouse', { ...p, kind, ref: num(ref), x: num(x), y: num(y), button: button || '' }, 15000)).did; }
export async function dragIn(scope, handle, x, y, x2, y2, button) { winOnly('drag'); const p = await pick(scope, handle); return (await U.call('drag', { ...p, x: num(x), y: num(y), x2: num(x2), y2: num(y2), button: button || '' }, 15000)).did; }
/** dir: up, down, left, right; at a control (ref), a point (x, y) or the window's middle. */
export async function scrollIn(scope, handle, dir, amount, { ref, x, y } = {}) { winOnly('scroll'); const p = await pick(scope, handle); return (await U.call('scroll', { ...p, dir, amount: num(amount, 3), ref: num(ref), ...(x != null ? { x: num(x), y: num(y) } : {}) }, 15000)).did; }
export async function holdKey(scope, handle, key, ms) { winOnly('hold_key'); const p = await pick(scope, handle); return (await U.call('hold', { ...p, key: String(key || ''), ms: num(ms, 1000) }, 20000)).did; }
/** what: focus, minimize, maximize, restore, move (x, y: screen pixels), resize (w, h). */
export async function windowDo(scope, handle, what, { x, y, w, h } = {}) { winOnly('window actions'); const p = await pick(scope, handle); return (await U.call('win', { ...p, what, x: num(x), y: num(y), w: num(w), h: num(h) }, 15000)).did; }
/** The clipboard's text, or puts `text` on it. */
export async function clipboard(text = null) { winOnly('the clipboard'); const r = await U.call('board', text == null ? {} : { set: true, text: String(text) }, 10000); return text == null ? String(r.text ?? '') : r.did; }
