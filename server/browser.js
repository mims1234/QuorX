// A headless browser for the agent: Edge or Chrome driven over the DevTools protocol (Node's built-in
// WebSocket, no dependencies). The agent opens what it built, reads it, clicks and types, and takes
// screenshots that the decision models can look at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './openrouter.js';
import { desktopReady, desktopCall, onTabEvents } from './desktop.js';

const CANDIDATES = [
  process.env.AGENT_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
export const browserPath = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;

let chrome = null, starting = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => { for (let p = 9333; p < 9400; p++) { const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); }); if (ok) return p; } throw new Error('no free debugging port'); };

// Callers that arrive while the browser is starting share that one start: two launches on the same
// profile folder would fight over it, and all but one would fail with "the browser did not start".
function ensureBrowser() {
  if (chrome && chrome.proc.exitCode == null) return Promise.resolve(chrome);
  starting ??= launchBrowser().finally(() => { starting = null; });
  return starting;
}
async function launchBrowser() {
  const exe = browserPath();
  if (!exe) throw new Error('No Edge or Chrome found. Set AGENT_BROWSER in .env to a Chromium-based browser.');
  const port = await freePort();
  // A profile per harness process: two processes can't share one, and nothing from earlier runs leaks in.
  const profile = path.join(os.tmpdir(), `quorx-browser-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars', '--window-size=1280,800',
    // Every tab here works in the background: keep its timers and animation frames at full speed, so games and
    // animations really run while the agent, the checks or the judge look at them.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { chrome = { proc, port }; return chrome; } } catch { /* starting */ }
    await sleep(250);
  }
  proc.kill();
  throw new Error('the browser did not start');
}
process.on('exit', () => {
  try { chrome?.proc.kill(); } catch { /* gone */ }
  try { fs.rmSync(path.join(os.tmpdir(), `quorx-browser-${process.pid}`), { recursive: true, force: true }); } catch { /* still locked */ }
});

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
 * One tab with a small DevTools client. With `{ chatId }` and the desktop app linked, the tab is a real
 * view in the app (the pane shows it live); otherwise it is a tab of the headless browser.
 */
export async function openTab({ chatId } = {}) {
  let tr = null;
  if (chatId && desktopReady()) tr = await desktopTransport(chatId).catch(() => null);
  // A desktop tab that doesn't answer quickly is dropped for a headless one, so the agent never hangs on it.
  if (tr) {
    const ok = await Promise.race([tr.send('Page.enable').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
    if (!ok) { await tr.close(); tr = null; }
  }
  tr ||= await headlessTransport();
  const listeners = [];
  const tab = { id: tr.id, desktop: tr.desktop, console: [], url: 'about:blank' };
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
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      return `data:image/jpeg;base64,${r.data}`;
    },
    // Click by CSS selector, by visible text, or at x,y. Uses real mouse events at the element's centre.
    async click({ selector, text, x, y }) {
      let pt = x != null && y != null ? { x, y, what: `point ${x},${y}` } : await js(`(() => {
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
