// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A headless browser for the agent: Edge or Chrome driven over the DevTools protocol (Node's built-in
// WebSocket, no dependencies). The agent opens what it built, reads it, clicks and types, and takes
// screenshots that the decision models can look at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { desktopReady, desktopCall, onTabEvents } from './desktop.js';
import { extCall, extCaps, onExtTabEvents } from './extlink.js';
import { pageOp } from './pageops.js';

const LOCAL = process.env.LOCALAPPDATA || '';
const CANDIDATES = [
  process.env.AGENT_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  // Chrome installed for one user only (no admin rights), and Brave.
  LOCAL && path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
  LOCAL && path.join(LOCAL, 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  LOCAL && path.join(LOCAL, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  LOCAL && path.join(LOCAL, 'Chromium/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium',
].filter(Boolean);
export const browserPath = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

let chrome = null, starting = null, failed = null; // failed: { at, message } of the last start that didn't work
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => { for (let p = 9333; p < 9400; p++) { const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); }); if (ok) return p; } throw new Error('no free debugging port'); };

// Callers that arrive while the browser is starting share that one start: two launches on the same
// profile folder would fight over it, and all but one would fail with "the browser did not start".
// The DevTools port answers: the browser is up, even when the process we started has exited (see startOnce).
const answers = async (port) => { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };
async function ensureBrowser() {
  if (chrome && (chrome.proc.exitCode == null || await answers(chrome.port))) return chrome;
  // The browser closed (or crashed): its profile folder goes with it.
  if (chrome) { dropProfile(chrome.profile); chrome = null; }
  // After a failed start, later callers hear why at once for two minutes instead of waiting for it to fail again.
  if (failed && Date.now() - failed.at < 120e3) return Promise.reject(new Error(failed.message));
  starting ??= launchBrowser().then((c) => { failed = null; return c; }, (e) => { failed = { at: Date.now(), message: e.message }; throw e; }).finally(() => { starting = null; });
  return starting;
}
async function launchBrowser() {
  const exe = browserPath();
  if (!exe) throw new Error('no Edge, Chrome or Brave found on this computer: install one, or set AGENT_BROWSER in .env to a Chromium-based browser');
  try { return await startOnce(exe, ''); }
  catch (e) {
    // Once more with a fresh profile folder: a profile left locked by a browser that crashed is the usual cause.
    try { return await startOnce(exe, `-${Date.now().toString(36)}`); }
    catch { throw new Error(`${path.basename(exe)} did not start: ${e.message}`); }
  }
}
async function startOnce(exe, suffix) {
  const port = await freePort();
  // A profile per harness process: two processes can't share one, and nothing from earlier runs leaks in.
  const profile = path.join(os.tmpdir(), `quorx-browser-${process.pid}${suffix}`);
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars', '--window-size=1280,800',
    // Every tab here works in the background: keep its timers and animation frames at full speed, so games and
    // animations really run while the agent, the checks or the judge look at them.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // What the browser said on the way out, for the error (a policy that blocks remote debugging, a missing library…).
  let said = '', spawnErr = null;
  proc.stderr.on('data', (d) => { said = (said + d).slice(-2000); });
  proc.on('error', (e) => { spawnErr = e; });
  // Up to 30 s: a first start on a slow or busy computer (antivirus scanning the new profile) can take a while.
  // Edge on Windows may hand off to a new browser process and exit with code 0 at once; that browser keeps our port,
  // so a clean exit means "keep waiting for the port", and only an error exit is a failed start.
  try {
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { chrome = { proc, port, profile, pid: await browserPid(await r.json()) }; return chrome; } } catch { /* starting */ }
      if (spawnErr) throw new Error(spawnErr.message);
      if (proc.exitCode != null && proc.exitCode !== 0) throw new Error(`it closed at once (exit code ${proc.exitCode})${lastLine(said)}`);
      if (proc.exitCode === 0 && i >= 60) throw new Error(`it closed at once (exit code 0) and nothing answered on its port${lastLine(said)}`);
      await sleep(250);
    }
    throw new Error(`it gave no answer within 30 s${lastLine(said)}`);
  } catch (e) { try { proc.kill(); } catch { /* gone */ } dropProfile(profile); throw e; }
}
// The real browser's process id (after a hand-off it isn't the one we spawned), so it can be closed when QuorX exits.
async function browserPid(version) {
  try {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(j, 2000); });
    const info = await new Promise((r, j) => { ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) r(m.result); }; ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })); setTimeout(j, 2000); });
    ws.close();
    return info?.processInfo?.find((p) => p.type === 'browser')?.id || null;
  } catch { return null; }
}
// The browser's last meaningful message line, without its [pid:tid:time:LEVEL:file] prefix.
const lastLine = (s) => { const l = String(s).split(/\r?\n/).map((x) => x.replace(/^\[[^\]]*\]\s*/, '').trim()).filter((x) => x && !/DevTools listening/i.test(x)).pop(); return l ? `: ${l.slice(0, 200)}` : ''; };
/** Ends the headless browser now (tests: a running browser keeps the process from exiting). It starts again on next use. */
export function closeBrowser() {
  const c = chrome; chrome = null; if (!c) return;
  try { c.proc.kill(); } catch { /* gone */ }
  try { if (c.pid && c.pid !== c.proc.pid) process.kill(c.pid); } catch { /* gone */ }
}
process.on('exit', () => {
  try { chrome?.proc.kill(); } catch { /* gone */ }
  try { if (chrome?.pid && chrome.pid !== chrome.proc.pid) process.kill(chrome.pid); } catch { /* gone */ }
  // A folder the closing browser still holds is left for the sweep below, the next time QuorX starts.
  for (const dir of new Set([chrome?.profile, path.join(os.tmpdir(), `quorx-browser-${process.pid}`)])) {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* still locked */ }
  }
});
// Removes a profile folder in the background, waiting a little for a browser that is still closing.
function dropProfile(dir) { return dir ? fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {}) : Promise.resolve(); }
// On start: profiles left behind by QuorX processes that have ended (a crash, a kill, a folder still locked at exit).
// The number in the name is the process that made it; one still running (another QuorX, a test) keeps its own.
const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Browsers still open on those profiles: a QuorX that was killed (Task Manager, taskkill /F) never ran its exit
// cleanup, and on Windows Edge hands off to a process outside QuorX's tree, so its headless browser lives on and
// keeps the folder locked. Found by the --user-data-dir on their command lines. Resolves to their process ids.
function profileUsers(dirs) {
  const want = dirs.map((d) => d.toLowerCase());
  const uses = (cmd) => { const c = cmd.toLowerCase(); return want.some((d) => [`--user-data-dir=${d}`, `--user-data-dir="${d}`].some((a) => { const i = c.indexOf(a); return i >= 0 && /^("|\s|$)/.test(c.slice(i + a.length)); })); };
  const ps = "Get-CimInstance Win32_Process -Filter \"CommandLine like '%quorx-browser-%'\" | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }";
  const [cmd, args] = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]] : ['ps', ['-eo', 'pid=,args=']];
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 30000, maxBuffer: 16e6 }, (err, out) => resolve(String(out || '').split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m && Number(m[1]) !== process.pid && uses(m[2])).map((m) => Number(m[1])))));
}
(async () => {
  const names = await fs.promises.readdir(os.tmpdir()).catch(() => []);
  const left = names.filter((name) => { const m = /^quorx-browser-(\d+)(?:-[a-z0-9]+)?$/.exec(name); return m && Number(m[1]) !== process.pid && !running(Number(m[1])); }).map((name) => path.join(os.tmpdir(), name));
  if (!left.length) return;
  const users = await profileUsers(left).catch(() => []);
  for (const pid of users) { try { process.kill(pid); } catch { /* already gone */ } }
  if (users.length) await sleep(1000); // let them let go of their files
  for (const dir of left) await dropProfile(dir);
})();

// Two ways to reach a tab, with the same DevTools commands: the hidden headless browser (always
// available), or a real tab in the desktop app's window (desktop/main.js, through server/desktop.js).
// Your own tabs (the pane's Browser tab) live in a browser context of their own: their sign-ins and cookies are never
// in the agent's tabs, which share the default one.
let userContext = null;
async function browserCall(port, method, params = {}) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('could not reach the browser')); });
  try {
    return await new Promise((r, j) => { ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) (m.error ? j(new Error(m.error.message)) : r(m.result)); }; ws.send(JSON.stringify({ id: 1, method, params })); setTimeout(() => j(new Error(`${method} timed out`)), 10000); });
  } finally { ws.close(); }
}
async function headlessTransport({ own = false } = {}) {
  const { port } = await ensureBrowser();
  let t;
  if (own) {
    if (!userContext || userContext.port !== port) userContext = { port, id: (await browserCall(port, 'Target.createBrowserContext', { disposeOnDetach: false })).browserContextId };
    const { targetId } = await browserCall(port, 'Target.createTarget', { url: 'about:blank', browserContextId: userContext.id });
    t = { id: targetId, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` };
  } else t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('could not connect to the browser tab')); });
  let seq = 0;
  const waiting = new Map(), subs = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method) for (const fn of subs) fn(m.method, m.params);
  };
  return {
    id: t.id, desktop: false,
    send: (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`${method} timed out`)); } }, 20000); }),
    onEvent: (fn) => subs.add(fn),
    close: async () => { try { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); } catch { /* closed */ } },
  };
}
// Console lines the page didn't cause: Electron's own security warning in desktop-app tabs, missing source maps.
const CONSOLE_NOISE = /Electron Security Warning|DevTools failed to load source ?map/i;

// A page's data requests (XHR and fetch only), from the DevTools Network events: method, address, status, type and
// size, never headers or cookies. The desktop app and the extension pass on only these fields too. 200 at most.
const DATA_REQ = new Set(['XHR', 'Fetch', 'EventSource']);
export function noteRequest(list, method, p) {
  if (method === 'Network.requestWillBeSent') {
    if (!DATA_REQ.has(p.type)) return;
    list.push({ id: p.requestId, ref: `n${(list.seq = (list.seq || 0) + 1)}`, method: p.request?.method || p.method || 'GET', url: String(p.request?.url || p.url || '').slice(0, 2000), type: p.type, at: Date.now(), status: 0, mime: '', size: 0, done: false, failed: '' });
    if (list.length > 200) list.splice(0, list.length - 200);
    return;
  }
  const r = list.find((x) => x.id === p.requestId);
  if (!r) return;
  if (method === 'Network.responseReceived') { r.status = p.response?.status ?? p.status ?? 0; r.mime = String(p.response?.mimeType || p.mimeType || ''); }
  else if (method === 'Network.loadingFinished') { r.done = true; r.size = Math.round(p.encodedDataLength || 0); }
  else if (method === 'Network.loadingFailed') r.failed = String(p.errorText || 'failed');
}
/** Only what noteRequest uses, for the desktop app and the extension to pass on (no headers, cookies or bodies). */
export function slimNetworkEvent(method, p) {
  if (method === 'Network.requestWillBeSent') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, method: p.request?.method, url: String(p.request?.url || '').slice(0, 2000) } : null;
  if (method === 'Network.responseReceived') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, status: p.response?.status, mimeType: p.response?.mimeType } : null;
  if (method === 'Network.loadingFinished') return { requestId: p.requestId, encodedDataLength: p.encodedDataLength };
  if (method === 'Network.loadingFailed') return { requestId: p.requestId, errorText: p.errorText };
  return null;
}

// A tab of your everyday Chrome that you gave to a chat, through the QuorX extension. Closing only lets go of it.
// When you let the extension read pages (its popup), reading, screenshots and the agent's mark go through page scripts
// and Chrome's own capture, so the "started debugging this browser" bar shows only while the agent clicks, types or
// reads network data. The debugger is attached on the first such command (and the extension lets go after a quiet
// spell, which this hears as Extension.detached and enables the page again next time).
async function extTransport(tab) {
  const subs = new Set();
  const lazy = !!extCaps().script;
  let enabled = null;
  const off = onExtTabEvents(tab, (method, params) => { if (method === 'Extension.detached') enabled = null; for (const fn of subs) fn(method, params); });
  const raw = (method, params = {}) => extCall('tab.cdp', { tab, method, params }, method === 'Page.captureScreenshot' ? 20000 : 25000);
  const where = lazy ? await extCall('tab.where', { tab }, 15000).catch((e) => { off(); throw e; }) : null;
  const t = lazy ? null : await raw('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch((e) => { off(); throw e; });
  const enable = async () => {
    await raw('Page.enable'); await raw('Runtime.enable'); await raw('Log.enable');
    await raw('Network.enable', { maxPostDataSize: 0 }).catch(() => {});
    await raw('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  };
  return {
    id: `chrome-${tab}`, chrome: true, lazy, url: (lazy ? where?.href : t?.result?.value) || '',
    send: async (method, params = {}) => { if (lazy) { enabled ||= enable().catch((e) => { enabled = null; throw e; }); await enabled; } return raw(method, params); },
    ...(lazy ? {
      op: (name, args) => extCall('tab.op', { tab, name, args }, name === 'ready' ? 25000 : 20000),
      shot: async () => { const r = await extCall('tab.shot', { tab }, 15000); return r?.image || null; },
      where: () => extCall('tab.where', { tab }, 10000),
      navigate: (url) => extCall('tab.go', { tab, url }, 20000),
    } : {}),
    onEvent: (fn) => subs.add(fn),
    close: async () => { off(); },
  };
}
// One of the user's own tabs in the desktop app, lent to the agent (🤖 Give to agent). Closing only lets go of it.
async function desktopAttachTransport(sid) {
  const id = await desktopCall('tab.attach', { tab: sid });
  const subs = new Set();
  const off = onTabEvents(id, (method, params) => { for (const fn of subs) fn(method, params); });
  const t = await desktopCall('tab.cdp', { tab: id, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } }).catch(() => null);
  return {
    id, desktop: true, url: t?.result?.value || '',
    send: (method, params = {}) => desktopCall('tab.cdp', { tab: id, method, params }, method === 'Page.captureScreenshot' && !params.captureBeyondViewport ? 16000 : 25000),
    onEvent: (fn) => subs.add(fn),
    close: async () => { off(); },
  };
}
async function desktopTransport(chatId) {
  const id = await desktopCall('tab.create', { kind: 'agent', chatId });
  const subs = new Set();
  const off = onTabEvents(id, (method, params) => { for (const fn of subs) fn(method, params); });
  return {
    id, desktop: true,
    // A screenshot of what shows gives up sooner: the app answers within ~12 s even when the page stalls, with a
    // picture of the view instead. A whole-page one (an export) can rightly take longer.
    send: (method, params = {}) => desktopCall('tab.cdp', { tab: id, method, params }, method === 'Page.captureScreenshot' && !params.captureBeyondViewport ? 16000 : 25000),
    onEvent: (fn) => subs.add(fn),
    close: async () => { off(); await desktopCall('tab.close', { tab: id }).catch(() => {}); },
  };
}

/**
 * Whether a command line opens DevTools port `port`: Electron's --remote-debugging-port=N, or the same flag handed to
 * WebView2 through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (a Tauri app), in any shell's way of setting it.
 */
export const startedWithDevtoolsPort = (line, port) => new RegExp(`--remote-debugging-port[= ]${Number(port)}(?!\\d)`).test(String(line || ''));

// An app the agent started with a DevTools port (an Electron app run with --remote-debugging-port=N): its first
// window. Closing the transport only disconnects; the app keeps running until its job is stopped.
async function cdpTransport(port) {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { throw new Error(`nothing answers on DevTools port ${port} yet (is the app still starting?)`); }
  const t = list.find((x) => x.type === 'page' && !/^devtools:/i.test(x.url)) || list.find((x) => x.type === 'page');
  if (!t?.webSocketDebuggerUrl) throw new Error(`no app window on DevTools port ${port}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`could not connect to the app on port ${port}`)); });
  let seq = 0;
  const waiting = new Map(), subs = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method) for (const fn of subs) fn(m.method, m.params);
  };
  return {
    id: t.id, desktop: false, app: true, url: t.url, title: t.title,
    // An app whose main process is stopped at a breakpoint doesn't answer for its windows either.
    send: (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`the app did not answer ${method} within 10 s: if a debug session has it stopped at a breakpoint, read it with debug state and continue`)); } }, 10000); }),
    onEvent: (fn) => subs.add(fn),
    close: async () => { try { ws.close(); } catch { /* closed */ } },
  };
}

/**
 * One tab with a small DevTools client. With `{ chatId }` and the desktop app linked, the tab is a real
 * view in the app (the pane shows it live); otherwise it is a tab of the headless browser. With `{ cdpPort }` it is
 * the window of an app the agent started (Electron), reached through that app's own DevTools port.
 */
export async function openTab({ chatId, cdpPort, own = false, attachTab, extTab } = {}) {
  let tr = null;
  if (extTab != null) tr = await extTransport(extTab);
  else if (attachTab) tr = await desktopAttachTransport(attachTab);
  else if (cdpPort) tr = await cdpTransport(cdpPort);
  else if (chatId && desktopReady()) tr = await desktopTransport(chatId).catch(() => null);
  // A desktop tab that doesn't answer quickly is dropped for a headless one, so the agent never hangs on it.
  if (tr && !tr.lazy) {
    const ok = await Promise.race([tr.send('Page.enable').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
    if (!ok) { await tr.close(); tr = null; }
  }
  if (!tr && (attachTab || extTab != null)) throw new Error('that tab is gone');
  tr ||= await headlessTransport({ own });
  const listeners = [];
  const tab = { id: tr.id, desktop: tr.desktop, app: !!tr.app, given: !!attachTab || extTab != null, lazy: !!tr.lazy, console: [], url: tr.url || 'about:blank', net: [] };
  tr.onEvent((method, params) => {
    if (method.startsWith('Network.')) noteRequest(tab.net, method, params);
    else if (method === 'Page.frameNavigated' && !params.frame?.parentId) tab.net.length = 0; // a new page: its own requests only
    if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type) && !CONSOLE_NOISE.test(params.args.map((a) => a.value ?? a.description ?? '').join(' '))) tab.console.push(`${params.type}: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
    if (method === 'Runtime.exceptionThrown') tab.console.push(`exception: ${(params.exceptionDetails.exception?.description || params.exceptionDetails.text || '').split('\n')[0]}`.slice(0, 300));
    if (method === 'Log.entryAdded' && params.entry.level === 'error' && !CONSOLE_NOISE.test(params.entry.text || '')) tab.console.push(`error: ${params.entry.text} ${params.entry.url || ''}`.slice(0, 300));
    for (const l of [...listeners]) l({ method, params });
  });
  const send = tr.send;
  const once = (method, ms) => new Promise((r) => { const l = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(l), 1); r(true); } }; listeners.push(l); setTimeout(() => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); r(false); }, ms); });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'script error'); return r.result.value; };
  // The page has stopped scrolling when its scroll position reads the same twice in a row (checked every 120 ms).
  const settle = async (ms = 2000) => { const end = Date.now() + ms; let last = null; while (Date.now() < end) { const pos = await js('Math.round(scrollX) + "," + Math.round(scrollY)').catch(() => null); if (pos !== null && pos === last) return; last = pos; await sleep(120); } };
  // A Chrome tab read through page scripts (tr.lazy) enables the page only when the debugger is first needed.
  if (!tr.lazy) {
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    // The page's own data requests (XHR and fetch), for network list/read and for waiting on one. Bodies stay in the
    // browser until asked for; headers are never kept.
    await send('Network.enable', { maxPostDataSize: 0 }).catch(() => {});
  }
  const cdpOp = async (name, args) => { try { return await js(pageOp(name, args)); } catch (e) { if (!/context|navigat|destroyed|not found/i.test(e.message)) throw e; await sleep(300); return js(pageOp(name, args)); } };
  const op = tr.op ? async (name, args) => { try { return await tr.op(name, args); } catch (e) { if (!/navigat|closed|frame|context|cannot access|no tab/i.test(e.message)) throw e; await sleep(300); return tr.op(name, args); } } : cdpOp;
  const ready = (o = {}) => op('ready', o).catch(() => null);
  // Headless tabs in the background never get focus, so clicks wouldn't focus inputs and typing went nowhere.
  if (!tr.lazy) await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // Sound can't be heard here, so every page counts what it starts: Web Audio contexts and sources, and <audio>/<video>
  // playing. summary() reports it, so the agent knows whether a game or a player made any sound at all.
  if (!tr.lazy) await send('Page.addScriptToEvaluateOnNewDocument', { source: SOUND_PROBE }).catch(() => {});

  Object.assign(tab, {
    // A raw DevTools call (tests stand a headless tab in for a Chrome tab behind the extension).
    cdp: (method, params = {}) => send(method, params),
    async open(url, { width = 1280, height = 800, mobile = width < 600 } = {}) {
      // A tab the user lent keeps the size the user sees it at.
      if (!tab.given) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); tab.size = { width, height }; }
      tab.console = [];
      if (tr.navigate) await tr.navigate(url); // the user's Chrome, read through page scripts: no debugger to navigate
      else { const loaded = once('Page.loadEventFired', 15000); await send('Page.navigate', { url }); await loaded; }
      // Loaded is not ready: single-page apps draw their content after it. Wait until the page is quiet (10 s at most).
      // A page from this computer (the agent's own work) is not kept waiting for a "Loading…" shell to fill in.
      tab.readyInfo = await ready({ quiet: 500, cap: 10000, thinMs: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url) ? 500 : 2000 });
      tab.url = url;
      return tab.summary();
    },
    // Waits until the page stops scrolling (smooth scrolls, anchor links), at most `ms`.
    async settle(ms = 2000) { return settle(ms); },
    // Loaded and quiet for `quiet` ms (no added or removed content, no new downloads), at most `cap` ms.
    ready,
    // The page operations in pageops.js: what is on screen, the snapshot with refs, find, the whole text, feeds.
    // Snapshot numbers carry on from page to page in this tab (see seed in pageops.js).
    snapshot: async (o = {}) => { const r = await op('snapshot', { ...o, seed: tab.snapN || 0 }); if (r?.n) tab.snapN = Math.max(tab.snapN || 0, r.n); return r; },
    find: async (query, limit = 15) => { const r = await op('find', { query, limit, seed: tab.snapN || 0 }); if (r?.n) tab.snapN = Math.max(tab.snapN || 0, r.n); return r; },
    pageText: (o = {}) => op('pageText', o),
    pageState: () => op('state', {}).catch(() => null),
    collectStep: (o = {}) => op('collect', o),
    scrollItems: (o = {}) => op('scrollItems', o),
    // The data requests since this page opened, newest last: { id, method, url, type, status, mime, size, done, failed }.
    netList: () => tab.net.slice(-100),
    async netRead(id) {
      const r = tab.net.find((x) => x.id === id || x.ref === id);
      if (!r) throw new Error(`no request ${id} on this page (network list shows the ids)`);
      if (!r.done) throw new Error(`request ${r.ref} has not finished loading yet${r.failed ? ` (it failed: ${r.failed})` : ''}`);
      const b = await send('Network.getResponseBody', { requestId: r.id });
      return { ...r, body: b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body };
    },
    // Until a data request whose address contains `part` has finished (one that started after `since`), at most `ms`.
    async waitRequest(part, ms = 10000, since = 0) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const r = tab.net.find((x) => x.at >= since && x.url.includes(part) && (x.done || x.failed)); if (r) return r; await sleep(150); }
      return null;
    },
    // Built-in tabs only (the agent's own and test pages): requests to these address patterns are refused.
    block: (urls) => send('Network.setBlockedURLs', { urls }),
    // Title, address, size, controls, sound and the text on screen (not the first 2,500 characters of the page: on a
    // chat app those were the server and channel lists, before any message). One page operation, any transport.
    summary: () => op('summary', {}),
    // Where the page is: { href, readyState, title }.
    where: () => (tr.where ? tr.where() : op('where', {})),
    // Any page operation from pageops.js, by name.
    op,
    // The thin border on the user's tab while the agent works in it.
    mark: (on = true) => op('mark', { on }).catch(() => null),
    // 💬 Comment: the element under a point of the view: a selector that finds it again (id, data-qx-id, or a short
    // path), its tag, text, section and box. Prefers the meaningful element (a button, a heading) over a span inside it.
    async inspect(x, y) {
      return js(`((x, y) => {
        const hit = document.elementFromPoint(x, y); if (!hit) return null;
        const el = hit.closest('button, a, input, select, textarea, label, img, svg, video, canvas, h1, h2, h3, h4, h5, h6, p, li, td, th, figure, blockquote, [data-qx-id], [role=button]') || hit;
        const one = (e) => {
          if (e.id) return '#' + CSS.escape(e.id);
          const q = e.getAttribute('data-qx-id'); if (q) return '[data-qx-id="' + q.replace(/"/g, '') + '"]';
          let s = e.tagName.toLowerCase();
          const cls = [...e.classList].filter((c) => !/^(is-|has-|active$|hover|focus|open$|show$)/.test(c)).slice(0, 2);
          if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
          const p = e.parentElement;
          if (p) { const same = [...p.children].filter((c) => c.tagName === e.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; }
          return s;
        };
        const parts = []; let e = el;
        while (e && e !== document.body && e !== document.documentElement && parts.length < 5) { parts.unshift(one(e)); if (e.id || e.getAttribute('data-qx-id')) break; e = e.parentElement; }
        const selector = parts.join(' > ') || el.tagName.toLowerCase();
        const r = el.getBoundingClientRect();
        const sec = el.closest('[data-qx-id]')?.getAttribute('data-qx-id') || el.closest('section[id], header[id], footer[id], nav[id], main[id], aside[id], article[id]')?.id || null;
        return { selector, unique: document.querySelectorAll(selector).length === 1, tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.alt || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
          section: sec, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, scroll: { x: scrollX, y: scrollY }, html: el.outerHTML.slice(0, 300) };
      })(${Number(x) || 0}, ${Number(y) || 0})`);
    },
    // A picture of one part of the page (view coordinates, as inspect returns them), with a little margin around it.
    async crop(rect, scroll = { x: 0, y: 0 }, pad = 12) {
      const w = Math.max(8, Math.min(1600, rect.w + pad * 2)), h = Math.max(8, Math.min(1200, rect.h + pad * 2));
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: true, clip: { x: Math.max(0, rect.x + scroll.x - pad), y: Math.max(0, rect.y + scroll.y - pad), width: w, height: h, scale: 1 } });
      return `data:image/jpeg;base64,${r.data}`;
    },
    // Export: the whole page as one PNG (up to 20000 px tall), or as a PDF with its print styles.
    async fullPage() {
      const m = await send('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(20000, Math.ceil(size.height)), scale: 1 } });
      return Buffer.from(r.data, 'base64');
    },
    async pdf({ landscape = false } = {}) {
      const r = await send('Page.printToPDF', { printBackground: true, landscape, preferCSSPageSize: true, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 });
      return Buffer.from(r.data, 'base64');
    },
    async screenshot() {
      if (tr.shot) { const img = await tr.shot(); if (img) return img; }
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      return `data:image/jpeg;base64,${r.data}`;
    },
    // A screenshot that gives up after `ms` (null): a window Chrome isn't drawing (behind others, minimised) can make
    // the capture wait until the transport's own timeout.
    shotWithin: (ms = 8000) => Promise.race([tab.screenshot(), sleep(ms).then(() => null)]).catch(() => null),
    // Click a ref from the snapshot, a CSS selector, visible text, or x,y. Before a click by ref, selector or text the
    // element must be visible, still, enabled and the thing under the point (Playwright's checks, retried for up to
    // 3 s); otherwise the error says which check failed. Then real mouse events at its centre.
    async click({ ref, selector, text, x, y }) {
      // A ref, selector or text wins over x/y: models often fill every field, sending x: 0, y: 0 next to the text they mean.
      const pt = !ref && !selector && !text && x != null && y != null ? { x, y, what: `point ${x},${y}` } : await op('point', { ref, selector, text });
      if (pt.err) throw new Error(pt.err);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sleep(400);
      await settle(); // an anchor link may scroll smoothly; the next screenshot should show where it lands
      return `clicked ${pt.what}${pt.others ? ` (${pt.others} other element${pt.others > 1 ? 's' : ''} also match; use a ref to be exact)` : ''}`;
    },
    // Typing into a ref replaces what the field holds (append: add to it), then reads the field back: a box that
    // already held "hi" once sent "hih".
    async type({ ref, selector, text, append }) {
      const want = String(text ?? '');
      let was = null;
      if (ref || selector) { const f = await op('focus', { ref, selector, select: !append }); if (f.err) throw new Error(f.err); was = f.was ?? null; }
      await send('Input.insertText', { text: want });
      await sleep(200);
      const now = await op('value', {}).catch(() => null);
      const before = was ? ` (it held "${was.length > 80 ? `${was.slice(0, 80)}…` : was}" before${append ? '' : ', replaced'})` : '';
      if (!now || now.none) return `typed ${want.length} characters${before}`;
      const expect = append && was ? was + want : want;
      const shown = now.value.length > 200 ? `${now.value.slice(0, 200)}…` : now.value;
      if (now.value.trim() === expect.trim() || (!ref && !selector && now.value.includes(want))) return `typed ${want.length} characters${before}; the field now holds "${shown}"`;
      return `typed ${want.length} characters${before}, but the field now holds "${shown}", not what you meant. Fix it before sending: type again with the whole text (it replaces), or press Backspace.`;
    },
    async press(combo) {
      // A real keyboard event: key (what was typed), code (which physical key) and the key code. Pages check any of
      // the three (e.key === ' ', e.code === 'Space', e.keyCode === 32), so all of them must be right.
      // Combinations (Shift+R, Control+S, Control+Shift+Z) hold their modifiers; a capital letter holds Shift.
      const parts = String(combo).length > 1 ? String(combo).split('+').filter(Boolean) : [String(combo)];
      const MOD = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };
      let modifiers = 0;
      for (const m of parts.slice(0, -1)) { const bit = MOD[m.toLowerCase()]; if (!bit) throw new Error(`unknown modifier ${m}: use Shift, Control, Alt or Meta`); modifiers |= bit; }
      let key = parts.at(-1) ?? String(combo);
      if (/^[a-z]$/i.test(key)) { if (modifiers & 8) key = key.toUpperCase(); else if (key !== key.toLowerCase()) modifiers |= 8; }
      const named = { Enter: [13, '\r', 'Enter'], Tab: [9, '\t', 'Tab'], Escape: [27, '', 'Escape'], Esc: [27, '', 'Escape'], Backspace: [8, '', 'Backspace'], Delete: [46, '', 'Delete'], ArrowUp: [38, '', 'ArrowUp'], ArrowDown: [40, '', 'ArrowDown'], ArrowLeft: [37, '', 'ArrowLeft'], ArrowRight: [39, '', 'ArrowRight'], Space: [32, ' ', 'Space'], ' ': [32, ' ', 'Space'], Shift: [16, '', 'ShiftLeft'], Control: [17, '', 'ControlLeft'], Home: [36, '', 'Home'], End: [35, '', 'End'], PageUp: [33, '', 'PageUp'], PageDown: [34, '', 'PageDown'] };
      const ch = Object.keys(named).find((n) => n.length > 1 && n.toLowerCase() === key.toLowerCase()) || key; // enter, arrowup
      const k = named[ch] || (/^[a-z]$/i.test(ch) ? [ch.toUpperCase().charCodeAt(0), ch, `Key${ch.toUpperCase()}`] : /^[0-9]$/.test(ch) ? [ch.charCodeAt(0), ch, `Digit${ch}`] : [0, ch, '']);
      const keyName = ch === 'Space' ? ' ' : ch === 'Esc' ? 'Escape' : ch;
      // Control, Alt and Meta combinations type nothing (Control+S saves, it doesn't insert an s).
      const text = modifiers & 7 ? undefined : k[1] || undefined;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: keyName, code: k[2] || undefined, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0], text, unmodifiedText: text && k[1].toLowerCase() });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: keyName, code: k[2] || undefined, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] });
      await sleep(300);
      await settle();
      return `pressed ${combo}`;
    },
    // Scrolls the page, or when the page can't move that way the area under the middle of the screen (a chat list, a
    // feed column), or the one holding a ref. screens: how many screens (0.85 of the area's height each).
    async scroll(dy = 600, { screens, ref } = {}) {
      const r = await op('scroll', { dy: screens == null ? Number(dy) || 600 : undefined, screens, ref }).catch(async () => { await js(`window.scrollBy({ top: ${Number(dy) || 600}, left: 0, behavior: 'instant' })`); return null; });
      await settle();
      if (!r) return `scrolled ${dy}px`;
      if (r.err) throw new Error(r.err);
      if (!r.moved) return `nothing scrolled: ${r.what === 'nothing' ? 'neither the page nor any area under the middle of the screen can move that way' : `${r.what} is already at its end`}`;
      return r.what === 'page' ? `scrolled ${r.moved}px` : `scrolled ${r.what} by ${r.moved}px (the page itself doesn't scroll here) · now at ${r.pos[0]} of ${r.pos[1]} px`;
    },
    // Typing like a keyboard, one key event per character (some pages ignore inserted text).
    async keys(text) {
      for (const ch of String(text ?? '')) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
      await sleep(150);
      return `typed ${String(text).length} characters`;
    },
    // The page's size, without reloading it (the pane's Browser tab follows the pane).
    // mobile: false keeps the page's layout exactly as wide as its picture, so picture coordinates are page coordinates.
    async viewport(width, height, mobile = false) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); tab.size = { width, height }; },
    eval: js, // internal use only (not offered to the agent)
    // Back to the page's own size (the desktop app's pane decides it once the agent is done).
    // 🤖 A lent tab: what a click, Enter or typing would act on, when it sends, deletes, buys, posts, signs out or
    // changes the account (null when it doesn't look like any of that). Reads only.
    riskOf: (a) => op('risk', { action: a.action, ref: a.ref, selector: a.selector, text: a.text, x: a.x, y: a.y, key: a.key }),

    async clearViewport() { await send('Emulation.clearDeviceMetricsOverride').catch(() => {}); tab.size = null; },
    close: () => tr.close(),
  });
  return tab;
}

// Counts the sound a page starts (see openTab). Wrapped, never changed: the page's own audio works as before.
const SOUND_PROBE = `(() => {
  if (window.__qxSound) return;
  const q = window.__qxSound = { ctxs: [], sources: 0, media: 0 };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const C = window[name]; if (!C) continue;
    window[name] = new Proxy(C, { construct(T, a, nt) { const c = Reflect.construct(T, a, nt); q.ctxs.push(c); return c; } });
  }
  const S = window.AudioScheduledSourceNode;
  if (S) { const start = S.prototype.start; S.prototype.start = function (...a) { q.sources++; return start.apply(this, a); }; }
  const M = window.HTMLMediaElement;
  if (M) { const play = M.prototype.play; M.prototype.play = function (...a) { q.media++; return play.apply(this, a); }; }
})();`;

// Short-lived URLs for single-page HTML artifacts, so the browser can open them like any site.
const pages = new Map();
export function hostHtml(html) {
  const token = crypto.randomBytes(12).toString('hex');
  pages.set(token, { html, at: Date.now() });
  for (const [k, v] of pages) if (Date.now() - v.at > 30 * 60e3) pages.delete(k);
  return `/preview/page/${token}`;
}
export const hostedHtml = (token) => pages.get(token)?.html ?? null;
