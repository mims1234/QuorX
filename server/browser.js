// A headless browser for the agent: Edge or Chrome driven over the DevTools protocol (Node's built-in
// WebSocket, no dependencies). The agent opens what it built, reads it, clicks and types, and takes
// screenshots that the decision models can look at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { ROOT } from './openrouter.js';
import { desktopReady, desktopCall, onTabEvents } from './desktop.js';

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
async function headlessTransport() {
  const { port } = await ensureBrowser();
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
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

async function desktopTransport(chatId) {
  const id = await desktopCall('tab.create', { kind: 'agent', chatId });
  const subs = new Set();
  const off = onTabEvents(id, (method, params) => { for (const fn of subs) fn(method, params); });
  return {
    id, desktop: true,
    send: (method, params = {}) => desktopCall('tab.cdp', { tab: id, method, params }, 25000),
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
export async function openTab({ chatId, cdpPort } = {}) {
  let tr = null;
  if (cdpPort) tr = await cdpTransport(cdpPort);
  else if (chatId && desktopReady()) tr = await desktopTransport(chatId).catch(() => null);
  // A desktop tab that doesn't answer quickly is dropped for a headless one, so the agent never hangs on it.
  if (tr) {
    const ok = await Promise.race([tr.send('Page.enable').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
    if (!ok) { await tr.close(); tr = null; }
  }
  tr ||= await headlessTransport();
  const listeners = [];
  const tab = { id: tr.id, desktop: tr.desktop, app: !!tr.app, console: [], url: tr.url || 'about:blank' };
  tr.onEvent((method, params) => {
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  // Headless tabs in the background never get focus, so clicks wouldn't focus inputs and typing went nowhere.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  Object.assign(tab, {
    async open(url, { width = 1280, height = 800, mobile = width < 600 } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      tab.size = { width, height };
      tab.console = [];
      const loaded = once('Page.loadEventFired', 15000);
      await send('Page.navigate', { url });
      await loaded; await sleep(700);
      tab.url = url;
      return tab.summary();
    },
    // Waits until the page stops scrolling (smooth scrolls, anchor links), at most `ms`.
    async settle(ms = 2000) { return settle(ms); },
    async summary() {
      return js(`(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const label = (e) => (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.title || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        const controls = [...document.querySelectorAll('button, a[href], input, textarea, select, [role=button], canvas')].filter(vis).slice(0, 40)
          .map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.type && e.tagName === 'INPUT' ? '[' + e.type + ']' : '') + (label(e) ? ' "' + label(e) + '"' : ''));
        return { title: document.title, url: location.href, text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 2500), controls,
          size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], scroll: [Math.round(scrollX), Math.round(scrollY)], view: [innerWidth, innerHeight] };
      })()`);
    },
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
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      return `data:image/jpeg;base64,${r.data}`;
    },
    // Click by CSS selector, by visible text, or at x,y. Uses real mouse events at the element's centre.
    async click({ selector, text, x, y }) {
      // A selector or text wins over x/y: models often fill every field, sending x: 0, y: 0 next to the text they mean.
      let pt = !selector && !text && x != null && y != null ? { x, y, what: `point ${x},${y}` } : await js(`(() => {
        const sel = ${JSON.stringify(selector || '')}, txt = ${JSON.stringify(String(text || '').toLowerCase())};
        let el = sel ? document.querySelector(sel) : null;
        if (!el && txt) el = [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label, li, div, span')]
          .filter((e) => (e.innerText || e.value || '').trim().toLowerCase().includes(txt)).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' }); // instant: on smooth-scrolling pages the position would still be moving
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, what: el.tagName.toLowerCase() + ' "' + (el.innerText || el.value || '').trim().slice(0, 40) + '"' };
      })()`);
      if (!pt) throw new Error(`nothing matches ${selector ? `selector ${selector}` : `text "${text}"`}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sleep(400);
      await settle(); // an anchor link may scroll smoothly; the next screenshot should show where it lands
      return `clicked ${pt.what}`;
    },
    async type({ selector, text }) {
      if (selector) { const ok = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); return true; })()`); if (!ok) throw new Error(`no element ${selector}`); }
      await send('Input.insertText', { text: String(text ?? '') });
      await sleep(200);
      return `typed ${String(text).length} characters`;
    },
    async press(key) {
      // A real keyboard event: key (what was typed), code (which physical key) and the key code. Pages check any of
      // the three (e.key === ' ', e.code === 'Space', e.keyCode === 32), so all of them must be right.
      const named = { Enter: [13, '\r', 'Enter'], Tab: [9, '\t', 'Tab'], Escape: [27, '', 'Escape'], Esc: [27, '', 'Escape'], Backspace: [8, '', 'Backspace'], Delete: [46, '', 'Delete'], ArrowUp: [38, '', 'ArrowUp'], ArrowDown: [40, '', 'ArrowDown'], ArrowLeft: [37, '', 'ArrowLeft'], ArrowRight: [39, '', 'ArrowRight'], Space: [32, ' ', 'Space'], ' ': [32, ' ', 'Space'], Shift: [16, '', 'ShiftLeft'], Control: [17, '', 'ControlLeft'], Home: [36, '', 'Home'], End: [35, '', 'End'], PageUp: [33, '', 'PageUp'], PageDown: [34, '', 'PageDown'] };
      const ch = String(key);
      const k = named[ch] || (/^[a-z]$/i.test(ch) ? [ch.toUpperCase().charCodeAt(0), ch, `Key${ch.toUpperCase()}`] : /^[0-9]$/.test(ch) ? [ch.charCodeAt(0), ch, `Digit${ch}`] : [0, ch, '']);
      const keyName = ch === 'Space' ? ' ' : ch === 'Esc' ? 'Escape' : ch;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: k[2] || undefined, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0], text: k[1] || undefined, unmodifiedText: k[1] || undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: k[2] || undefined, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] });
      await sleep(300);
      await settle();
      return `pressed ${key}`;
    },
    async scroll(dy = 600) { await js(`window.scrollBy({ top: ${Number(dy) || 600}, left: 0, behavior: 'instant' })`); await settle(); return `scrolled ${dy}px`; },
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
    async clearViewport() { await send('Emulation.clearDeviceMetricsOverride').catch(() => {}); tab.size = null; },
    close: () => tr.close(),
  });
  return tab;
}

// Short-lived URLs for single-page HTML artifacts, so the browser can open them like any site.
const pages = new Map();
export function hostHtml(html) {
  const token = crypto.randomBytes(12).toString('hex');
  pages.set(token, { html, at: Date.now() });
  for (const [k, v] of pages) if (Date.now() - v.at > 30 * 60e3) pages.delete(k);
  return `/preview/page/${token}`;
}
export const hostedHtml = (token) => pages.get(token)?.html ?? null;
