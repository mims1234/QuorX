// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// QuorX desktop: the same page in a window, plus real Chromium tabs for the pane's Browser tab.
// The page draws the tab strip and the address bar; this process places a native browser view (a real
// Chromium page: smooth scrolling, video and sound, sign-ins that last, downloads, DevTools) exactly
// over the Browser tab's page area. Ordinary browsers keep the streamed view.
//
// The server: if this data folder's harness already answers on its port, the window attaches to it (two servers on
// the same data folder would fight). Another QuorX on that port (its own data folder, so its own app key) is left
// alone, and this one starts server.js with Electron's own Node on the next free port.
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, ipcMain, session, shell, dialog, Notification, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { pngIcon } = require('./icon.js');
const { createStorage, cleanAtStart } = require('./storage.js');
const PKG = require('./package.json');

// The harness's code: the repo while developing, the copy bundled in the installer once installed.
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app-server') : path.resolve(__dirname, '..');
// DEV: the app run from a QuorX git checkout (npm run desktop). Both must hold, so an installer or Store build, which is
// packaged and has no .git, can never look like DEV. The DEV badge, title and tray text all come from this one value.
const DEV = !app.isPackaged && fs.existsSync(path.join(ROOT, '.git'));
// Your data (chats, projects, keys, logs, .env): the repo while developing; once installed, a folder you
// choose on first run (a new one in your profile by default), so updates never touch it.
const CONFIG = () => path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(path.dirname(CONFIG()), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2)); };
let HOME = null;
// The harness's app key (server/access.js): the window opens with it once, and the app's own calls carry it.
// The data folder the harness uses: the one chosen here, else OH_HOME (a test copy), else the repo.
const appKey = () => { try { return fs.readFileSync(path.join(HOME || process.env.OH_HOME || ROOT, 'data', 'app-key'), 'utf8').trim(); } catch { return ''; } };
const keyed = (h = {}) => ({ ...h, 'X-QuorX-Key': appKey() });
const HIDDEN = process.argv.includes('--hidden'); // started at login: tray only
let PORT = 5188;
let server = null, origin = null, win = null, tray = null, quitting = false;
// The window shows QuorX at its own name, quorx.localhost (server/access.js): its sign-in cookie never goes to dev
// servers on localhost. `origin` (localhost) stays for this process's own calls, which carry the key instead.
const appOrigin = () => origin && origin.replace('//localhost:', '//quorx.localhost:');
// An address under QuorX's name on another port is somebody else's page: it opens at localhost, without the cookie.
const offAppHost = (u) => { try { const x = new URL(u); if (x.hostname === 'quorx.localhost' && x.origin !== appOrigin()) { x.hostname = 'localhost'; return x.href; } } catch { /* not an address */ } return u; };

// OH_USER_DATA: a separate settings folder, so a test copy can run next to your own (one copy per folder).
if (process.env.OH_USER_DATA) app.setPath('userData', process.env.OH_USER_DATA);
// Before the name QuorX the app was OpenHarness, with its settings in %APPDATA%\OpenHarness. The first start copies
// what matters (which data folder to use and the browser tabs' sign-ins), so nothing has to be set up again. Chats
// stay in the data folder those settings point to; the old folder itself is left alone.
(function adoptOldSettings() {
  if (process.env.OH_USER_DATA) return;
  try {
    const neu = app.getPath('userData'), old = path.join(app.getPath('appData'), 'OpenHarness');
    if (fs.existsSync(path.join(neu, 'config.json')) || !fs.existsSync(path.join(old, 'config.json'))) return;
    fs.mkdirSync(neu, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(old, 'config.json'), 'utf8'));
    if (/\/OpenHarness\/releases/i.test(cfg.updateUrl || '')) delete cfg.updateUrl; // the feed moved with the name
    fs.writeFileSync(path.join(neu, 'config.json'), JSON.stringify(cfg, null, 2));
    const from = path.join(old, 'Partitions');
    if (fs.existsSync(from)) fs.cpSync(from, path.join(neu, 'Partitions'), { recursive: true, filter: (p) => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|CacheStorage)([\\/]|$)/.test(p) });
  } catch { /* then it starts fresh and asks where to keep the data */ }
})();
if (!app.requestSingleInstanceLock()) app.quit();
// Only the copy that owns the settings folder clears caches there (desktop/storage.js); a second copy quits above.
else try { if (cleanAtStart(app.getPath('userData'), readConfig())) writeConfig({ ...readConfig(), clearGpuAtStart: false }); } catch { /* next time */ }
// Windows shows the page's notifications ("Needs your approval", "Reply finished") under this app's name.
if (process.platform === 'win32') app.setAppUserModelId('dev.quorx.desktop');
app.whenReady().then(() => registerToastName());
app.on('second-instance', () => showWindow());

function readEnvPort(dir) {
  try { return (fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/^\s*AGENT_PORT\s*=\s*(\d+)/m) || [])[1]; } catch { return null; }
}
async function chooseHome() {
  if (!app.isPackaged) return null; // developing: the repo itself
  const cfg = readConfig();
  if (cfg.home && fs.existsSync(cfg.home)) return cfg.home;
  const fresh = path.join(app.getPath('userData'), 'data-home');
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'QuorX', message: 'Where should QuorX keep your chats, projects and keys?',
    detail: `A new folder in your profile is best for a fresh start:\n${fresh}\n\nOr pick an existing QuorX (or OpenHarness) folder, one with a data folder in it, to keep using its chats and projects.`,
    buttons: ['New folder (recommended)', 'Use an existing folder…', 'Quit'], defaultId: 0, cancelId: 2, noLink: true,
  });
  if (response === 2) return false;
  let home = fresh;
  if (response === 1) {
    const r = await dialog.showOpenDialog({ title: 'Pick your QuorX folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return chooseHome();
    home = r.filePaths[0];
  }
  fs.mkdirSync(home, { recursive: true });
  writeConfig({ ...cfg, home });
  return home;
}
async function harnessAt(port) {
  try { const r = await fetch(`http://localhost:${port}/api/config`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); return !!j && 'defaults' in j; } catch { return false; }
}
// A harness on that port that takes this data folder's app key is ours to attach to.
async function oursAt(port) {
  try { return (await fetch(`http://localhost:${port}/api/chats`, { headers: keyed(), signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
// Attach to our running harness, or start one (past any other QuorX's port) and wait for its "→ http://localhost:<port>" line.
async function startServer() {
  for (let p = PORT, tries = 0; tries < 20; p++, tries++) {
    if (!(await harnessAt(p))) { PORT = p; break; }
    if (await oursAt(p)) { PORT = p; return `http://localhost:${p}`; }
  }
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OH_DESKTOP: '1', AGENT_PORT: String(PORT), ...(HOME ? { OH_HOME: HOME } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // The harness's output: past 50 MB it starts afresh, the older part kept as server.1.log.
  const logPath = path.join(app.getPath('userData'), 'server.log');
  try { if (fs.statSync(logPath).size > 50e6) fs.renameSync(logPath, path.join(app.getPath('userData'), 'server.1.log')); } catch { /* none yet */ }
  const logFile = fs.createWriteStream(logPath, { flags: 'a' });
  return new Promise((resolve, reject) => {
    let done = false;
    const onData = (d) => {
      logFile.write(d);
      const m = !done && String(d).match(/→\s*(http:\/\/localhost:\d+)/);
      if (m) { done = true; resolve(m[1]); }
    };
    server.stdout.on('data', onData); server.stderr.on('data', (d) => logFile.write(d));
    server.on('exit', (code) => { server = null; if (!done) reject(new Error(`the server stopped (code ${code}); see ${path.join(app.getPath('userData'), 'server.log')}`)); });
    setTimeout(() => { if (!done) reject(new Error('the server did not start within 30 s')); }, 30e3);
  });
}

const iconImage = (size = 32) => nativeImage.createFromBuffer(pngIcon(size));

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 760, minHeight: 520, show: false, backgroundColor: '#070908', title: DEV ? 'QuorX · DEV' : 'QuorX', icon: iconImage(64), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  // The zoom you left QuorX at; Ctrl+wheel on the app goes through the same steps (the page handles the keys).
  win.webContents.on('did-finish-load', () => { const z = Number(readConfig().zoom); if (z >= 0.5 && z <= 2) win.webContents.setZoomFactor(z); });
  // Zoom keys and Ctrl+wheel in the app go to the page, which knows what you're on: an artifact or a page preview
  // (inside a frame, which the page never hears keys from), the terminal, or QuorX itself (it calls back 'zoom').
  win.webContents.on('before-input-event', (e, input) => { const dir = zoomKey(input); if (dir) { e.preventDefault(); send({ type: 'zoom-key', dir }); } });
  win.webContents.on('zoom-changed', (_e, dir) => send({ type: 'zoom-wheel', dir }));
  // Through localhost first: the page there hands this window's saved settings over and opens QuorX at its own name.
  win.loadURL(`${origin}/?k=${encodeURIComponent(appKey())}`);
  // The app window only shows the app (and the move page on the way); links elsewhere open in your browser.
  // Same origin exactly (not just the same prefix), and only web and mail links go to the system: other schemes
  // (file:, protocol handlers) are dropped.
  win.webContents.on('will-navigate', (e, url) => {
    let same = false; try { same = [origin, appOrigin()].includes(new URL(url).origin); } catch { /* not a URL */ }
    if (same) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(offAppHost(url));
  });
  // Ctrl+click (Cmd+click on a Mac) on a web link inside a frame of the app (an artifact, a page preview) opens it in the
  // pane's Browser tab. Links in QuorX's own content are handled by the page and never get here.
  // Anything else that opens a new window (↗, sign-in) goes to your default browser.
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'background-tab' && /^https?:\/\//i.test(url)) { send({ type: 'open-link', url: offAppHost(url) }); return { action: 'deny' }; }
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(offAppHost(url));
    return { action: 'deny' };
  });
  // ✕ keeps the harness running in the tray (scheduled tasks still run), or quits, as you chose in the notice
  // or in ⚙ Settings → About. Attached to a harness someone else runs, ✕ just closes the window.
  win.on('close', (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    const act = closeAction();
    if (act !== 'quit' && STORE && update.state === 'store-available' && update.version !== skippedUpdate) return askUpdateOnClose(act);
    if (act === 'quit') quitApp(); else if (act === 'tray') win.hide(); else askOnClose();
  });
  win.on('closed', () => { win = null; tabs.clear(); });
}
// What ✕ does: 'ask' (the notice, until you tick "Don't show this again"), 'tray' or 'quit'.
const closeAction = () => (['tray', 'quit'].includes(readConfig().onClose) ? readConfig().onClose : 'ask');
function setCloseAction(v) { writeConfig({ ...readConfig(), onClose: ['tray', 'quit'].includes(v) ? v : 'ask' }); return closeAction(); }
function quitApp() { quitting = true; app.quit(); }
let asking = false;
async function askOnClose() {
  if (asking || !win) return;
  asking = true;
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'info', title: 'QuorX', message: 'QuorX keeps running in the tray so scheduled tasks can run',
    detail: 'Quit it any time from the QuorX icon in the tray (right-click → Quit QuorX), or here. You can change what ✕ does in ⚙ Settings → About.',
    buttons: ['Keep running', 'Quit QuorX'], defaultId: 0, cancelId: 0, noLink: true,
    checkboxLabel: "Don't show this again", checkboxChecked: false,
  }).finally(() => { asking = false; });
  if (checkboxChecked) setCloseAction(response === 1 ? 'quit' : 'tray');
  if (response === 1) quitApp(); else win?.hide();
}
// The Store copy with a newer version out: ✕ would only hide QuorX in the tray, and the Store can't install over a running
// copy (0x80073D02). So ✕ asks first: quit and open the Store page, or keep running as usual (asked once per version).
let skippedUpdate = null;
async function askUpdateOnClose(act) {
  if (asking || !win) return;
  asking = true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', title: 'QuorX', message: `QuorX ${update.version} is out`,
    detail: `You have ${app.getVersion()}. The Microsoft Store can only install the update once QuorX has quit. Quit now and open QuorX in the Store, then press Update there.`,
    buttons: ['Quit and update', 'Not now'], defaultId: 0, cancelId: 1, noLink: true,
  }).finally(() => { asking = false; });
  if (response === 0) { shell.openExternal('ms-windows-store://pdp/?productid=9NBK5DMLMTFF'); return quitApp(); }
  skippedUpdate = update.version;
  if (act === 'tray') win?.hide(); else askOnClose();
}
// Start at login: off by default; when on, the app starts hidden in the tray.
const loginArgs = () => (app.isPackaged ? ['--hidden'] : [path.resolve(__dirname), '--hidden']);
const loginItem = () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
function setLoginItem(on) { app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: loginArgs() }); if (tray) createTrayMenu(); return loginItem(); }
function createTray() {
  tray = new Tray(iconImage(16));
  tray.setToolTip(trayTip());
  createTrayMenu();
  tray.on('click', showWindow);
}
// The copy run from the QuorX folder (npm run desktop) says DEV everywhere, so it is never mixed up with the installed one.
const trayTip = () => `QuorX${DEV ? ' DEV (from your folder)' : ''} is running · ${appOrigin()}${server ? ' · right-click to quit' : ''}`;
// Quit sits right under Open, so it is found without reading the whole menu.
function createTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open QuorX', click: showWindow },
    { label: server ? 'Quit QuorX (stops the harness)' : 'Quit QuorX', click: quitApp },
    { type: 'separator' },
    { label: `Address: ${appOrigin()}`, enabled: false },
    ...(HOME ? [{ label: 'Open the data folder', click: () => shell.openPath(HOME) }] : []),
    { label: 'Restart the harness', click: async () => { const r = await restartHarness(); if (r.ok) win?.webContents.reload(); else dialog.showErrorBox('Restart failed', r.error); } },
    { label: 'Start at login', type: 'checkbox', checked: loginItem(), click: (m) => setLoginItem(m.checked) },
  ]));
}

// ---------- real browser tabs (one WebContentsView each) ----------
// Your tabs share one persistent profile, so sign-ins last; they never get the app's bridge.
const tabs = new Map(); // sid → { view, shown }
const CHROME_UA = () => session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\s(quorx-desktop|QuorX)\/\S+/i, '');
let userSession = null;
function browseSession() {
  if (userSession) return userSession;
  userSession = session.fromPartition('persist:browse');
  userSession.setUserAgent(CHROME_UA());
  // Downloads go to your Downloads folder; the page shows them under the address bar.
  userSession.on('will-download', (_e, item, wc) => {
    const sid = [...tabs].find(([, t]) => t.view.webContents === wc)?.[0] || null;
    const file = uniquePath(path.join(app.getPath('downloads'), item.getFilename()));
    item.setSavePath(file);
    send({ sid, type: 'download', state: 'started', name: path.basename(file), file, total: item.getTotalBytes() });
    item.on('updated', () => send({ sid, type: 'download', state: 'progress', name: path.basename(file), received: item.getReceivedBytes(), total: item.getTotalBytes() }));
    item.once('done', (_ev, state) => send({ sid, type: 'download', state, name: path.basename(file), file }));
  });
  // Camera, microphone, location and the like: no for now (a prompt in the pane can come later); full screen and clipboard writes are fine.
  userSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(perm)));
  return userSession;
}
function uniquePath(p) { if (!fs.existsSync(p)) return p; const { dir, name, ext } = path.parse(p); for (let i = 1; ; i++) { const q = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(q)) return q; } }
function send(ev) { if (win && !win.isDestroyed()) win.webContents.send('oh-desktop', ev); }
function tabFor(sid) {
  let t = tabs.get(sid);
  if (t) return t;
  const view = new WebContentsView({ webPreferences: { session: browseSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  win.contentView.addChildView(view);
  t = { view, shown: false };
  tabs.set(sid, t);
  wireView(sid, view);
  return t;
}
function wireView(sid, view) {
  const wc = view.webContents;
  const info = () => send({ sid, type: 'state', url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, info);
  wc.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) send({ sid, type: 'error', url, message: desc }); });
  wc.on('page-favicon-updated', (_e, icons) => send({ sid, type: 'favicon', icon: icons[0] || null }));
  // Pop-ups open as new tabs in the pane.
  wc.setWindowOpenHandler(({ url }) => { send({ sid, type: 'popup', url }); return { action: 'deny' }; });
  // Ctrl + / − / 0 and Ctrl+wheel zoom the page in this tab only (QuorX itself keeps its size). Not the agent's
  // own tab: its page size is set for what the agent measures and screenshots.
  const zoomTab = (dir) => { const t = tabs.get(sid); if (!t || t.agent) return; wc.setZoomFactor(nextZoom(wc.getZoomFactor(), dir)); send({ sid, type: 'zoom', factor: wc.getZoomFactor() }); };
  wc.on('before-input-event', (e, input) => { const dir = zoomKey(input); if (dir) { e.preventDefault(); zoomTab(dir); } });
  wc.on('zoom-changed', (_e, dir) => zoomTab(dir));
}
// Zoom in Chrome's steps. zoomKey reads Ctrl + / − / 0 (with or without Shift, top row or keypad).
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
function nextZoom(f, dir) {
  if (dir === 'reset') return 1;
  const i = ZOOMS.findIndex((z) => Math.abs(z - f) < 0.01);
  if (i < 0) return dir === 'in' ? ZOOMS.find((z) => z > f) || 2 : [...ZOOMS].reverse().find((z) => z < f) || 0.5;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (dir === 'in' ? 1 : -1)))];
}
function zoomKey(input) {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  if (['=', '+', 'Add'].includes(input.key) || input.code === 'Equal' || input.code === 'NumpadAdd') return 'in';
  if (['-', '_', 'Subtract'].includes(input.key) || input.code === 'Minus' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}
// Only the app's own page may drive tabs.
const fromApp = (e) => { try { return new URL(e.senderFrame.url).origin === appOrigin(); } catch { return false; } };
function handle(name, fn) { ipcMain.handle(`oh:${name}`, (e, ...a) => { if (!fromApp(e)) throw new Error('not allowed'); return fn(...a); }); }
handle('open', (sid, url) => { if (!/^https?:\/\//i.test(String(url))) throw new Error('only http and https addresses'); tabFor(sid).view.webContents.loadURL(url).catch(() => {}); return true; });
handle('bounds', (sid, r) => {
  const t = tabs.get(sid); if (!t) return false;
  // The page measures in its own pixels, which zooming QuorX scales; views are placed in the window's.
  const z = win?.webContents.getZoomFactor() || 1;
  const b = { x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(0, Math.round(r.width * z)), height: Math.max(0, Math.round(r.height * z)) };
  // The same place again (the page asks often): nothing to do, so the page isn't laid out again.
  if (t.bounds && t.bounds.x === b.x && t.bounds.y === b.y && t.bounds.width === b.width && t.bounds.height === b.height) { vlog('bounds skip', sid); return true; }
  vlog('bounds', sid, JSON.stringify(b));
  t.bounds = b;
  if (t.cover) t.cover.setBounds(b);
  // With a page size set, the page is rescaled first and the view placed once that is done (applyEmu).
  if (t.emu) applyEmu(t); else placeView(t);
  return true;
});
// What happens to the real tabs, with times: kept in <userData>/view-events.log (the last ~2000 lines), so a flicker
// or a resize loop can be read back afterwards. Repeats that change nothing are logged as "skip".
const VLOG = [];
let vlogTimer = null;
function vlog(...parts) {
  VLOG.push(`${new Date().toISOString().slice(11, 23)} ${parts.join(' ')}`);
  if (VLOG.length > 2000) VLOG.splice(0, VLOG.length - 2000);
  if (!vlogTimer) vlogTimer = setTimeout(() => { vlogTimer = null; try { fs.writeFileSync(path.join(app.getPath('userData'), 'view-events.log'), VLOG.join('\n') + '\n'); } catch { /* best effort */ } }, 1000);
}
// The agent's page keeps the width it asked for (1280 for a desktop), scaled to the pane's width, and is made as
// tall as the pane, so it fills the whole view (never shorter than the height it asked for). Its reports measure the
// real screen, so the agent always knows how much it sees. Your own tabs fill the pane as they are.
function fitEmu(t) {
  const e = t.emu, b = t.bounds;
  if (!e?.width || !e?.height) return null;
  if (!b?.width || !b?.height) return { ...e, scale: 1 };
  const scale = Math.min(1, b.width / e.width);
  return { ...e, height: Math.max(e.height, Math.round(b.height / scale)), scale };
}
function placeView(t) {
  const b = t.bounds; if (!b) return;
  const f = fitEmu(t);
  let r = b;
  if (f) {
    const w = Math.max(1, Math.round(f.width * f.scale)), h = Math.max(1, Math.min(b.height, Math.round(f.height * f.scale)));
    r = { x: b.x + Math.round((b.width - w) / 2), y: b.y, width: w, height: h };
  }
  const key = `${r.x},${r.y},${r.width},${r.height}`;
  if (t.viewRect === key) return; // already there
  vlog('setBounds', key);
  t.viewRect = key;
  t.view.setBounds(r);
}
// Show one tab (or none): every other tab is hidden, so dialogs and other tabs are never covered by a stale one.
// Only views whose visibility changes are touched (setting it again on a shown view can make it flash).
handle('show', (sid) => { for (const [k, t] of tabs) { const on = k === sid; if (t.shown === on) continue; vlog(on ? 'show' : 'hide', k); t.shown = on; t.view.setVisible(on); t.cover?.setVisible(on); } return true; });
handle('hideAll', () => { for (const [k, t] of tabs) { if (t.shown) vlog('hide (all)', k); t.shown = false; t.view.setVisible(false); t.cover?.setVisible(false); } return true; });
handle('nav', (sid, op) => {
  const t = tabs.get(sid); if (!t) return false;
  const wc = t.view.webContents, h = wc.navigationHistory;
  if (op === 'back' && h.canGoBack()) h.goBack(); else if (op === 'forward' && h.canGoForward()) h.goForward(); else if (op === 'reload') wc.reload(); else if (op === 'stop') wc.stop();
  else if (op === 'devtools') wc.openDevTools({ mode: 'detach' });
  return true;
});
handle('close', (sid) => closeTab(sid));
function closeTab(sid) {
  const t = tabs.get(sid); if (!t) return false;
  try { if (t.view.webContents.debugger.isAttached()) t.view.webContents.debugger.detach(); } catch { /* gone */ }
  if (win && !win.isDestroyed()) { win.contentView.removeChildView(t.view); if (t.cover) win.contentView.removeChildView(t.cover); }
  t.view.webContents.close(); t.cover?.webContents.close();
  tabs.delete(sid);
  return true;
}
handle('snapshot', async (sid) => { const t = tabs.get(sid); if (!t || !t.shown) return null; return (await t.view.webContents.capturePage()).toDataURL(); });
// ---------- updates: the app checks a feed, you press Update, it downloads, Restart installs ----------
// The feed is any web address holding what a build makes (latest.yml, the installer, its .blockmap),
// e.g. a GitHub release (https://github.com/<you>/<repo>/releases/latest/download). It comes from
// package.json ("quorx.updateUrl") and can be changed in Settings. Works without code signing.
let updater = null, update = { state: 'idle' };
// A saved feed that isn't https (an older setting) is ignored for the built-in one.
const updateUrl = () => { const saved = String(readConfig().updateUrl ?? '').trim(); return (/^https:\/\//i.test(saved) ? saved : saved === '' && readConfig().updateUrl === '' ? '' : PKG.quorx?.updateUrl ?? '').trim(); };
function setUpdate(patch) { update = { ...update, ...patch }; send({ type: 'update', ...update }); }
// The Microsoft Store copy is updated by the Store itself, so it never downloads or installs updates on its own.
const STORE = !!process.windowsStore;
function getUpdater() {
  if (updater || !app.isPackaged || STORE) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false; // only when you press Update
  updater.autoInstallOnAppQuit = true; // a downloaded update also installs the next time you quit
  updater.on('checking-for-update', () => setUpdate({ state: 'checking', error: null }));
  updater.on('update-available', (i) => setUpdate({ state: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.slice(0, 2000) : '', size: i.files?.[0]?.size || null }));
  updater.on('update-not-available', () => setUpdate({ state: 'current', checked: Date.now() }));
  updater.on('download-progress', (pr) => setUpdate({ state: 'downloading', percent: Math.round(pr.percent), speed: pr.bytesPerSecond }));
  updater.on('update-downloaded', (i) => setUpdate({ state: 'ready', version: i.version }));
  updater.on('error', (e) => setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 300) }));
  return updater;
}
// The Store copy can't update itself, but it can still say whether a newer QuorX is out: it asks GitHub for the
// latest release. The Store may get a release a day after GitHub does.
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkStore() {
  setUpdate({ state: 'checking', error: null });
  try {
    const r = await fetch('https://api.github.com/repos/mims1234/QuorX/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const latest = String((await r.json()).tag_name || '').replace(/^v/, '');
    return setUpdate(newer(latest, app.getVersion()) ? { state: 'store-available', version: latest, current: app.getVersion(), checked: Date.now() } : { state: 'store-current', current: app.getVersion(), checked: Date.now() });
  } catch (e) { return setUpdate({ state: 'store', error: String(e?.message || e).slice(0, 200) }); }
}
async function checkUpdates() {
  const u = getUpdater(), url = updateUrl();
  if (STORE) return checkStore();
  if (!u) return setUpdate({ state: 'dev' });
  if (!url) return setUpdate({ state: 'no-feed' });
  if (['downloading', 'ready'].includes(update.state)) return update;
  u.setFeedURL({ provider: 'generic', url });
  try { await u.checkForUpdates(); } catch (e) { setUpdate({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 300) }); }
  return update;
}
handle('update', async (op, arg) => {
  if (op === 'state') return { ...update, ...(STORE && update.state === 'idle' ? { state: 'store' } : {}), current: app.getVersion(), url: updateUrl(), packaged: app.isPackaged };
  if (op === 'check') return checkUpdates();
  // The Store copy: open QuorX's page in the Microsoft Store, where a new version shows as Update.
  if (op === 'store') { shell.openExternal('ms-windows-store://pdp/?productid=9NBK5DMLMTFF'); return update; }
  if (op === 'download') { if (update.state !== 'available') return update; setUpdate({ state: 'downloading', percent: 0 }); getUpdater().downloadUpdate().catch((e) => setUpdate({ state: 'error', error: String(e?.message || e).slice(0, 300) })); return update; }
  if (op === 'install') { if (update.state !== 'ready') return update; quitting = true; setImmediate(() => getUpdater().quitAndInstall(false, true)); return update; }
  if (op === 'setUrl') { const url = String(arg || '').trim(); // https only: an update replaces the app, so its feed must not be readable or changeable on the way.
      if (url && !/^https:\/\//i.test(url)) throw new Error('the feed must be an https address');
      if (url) { const ok = await dialog.showMessageBox(win, { type: 'warning', title: 'QuorX', message: 'Change where QuorX gets its updates?', detail: `New feed: ${url}\n\nUpdates from it replace the app. Only use a feed you trust.`, buttons: ['Change it', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }); if (ok.response !== 0) return update; } writeConfig({ ...readConfig(), updateUrl: url }); update = { state: 'idle' }; return checkUpdates(); }
  throw new Error(`unknown update step ${op}`);
});
// ⟳ Restart the harness. One this app runs: stop it and start it again. One it is attached to: ask it
// to stop, then start our own, so from now on restarts (and the tray) are in this app's hands.
let restarting = false;
const waitFor = async (test, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await test()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
async function restartHarness() {
  if (restarting) return { ok: false, error: 'already restarting' };
  restarting = true;
  try {
    if (server) {
      const old = server; server = null;
      await new Promise((r) => { old.once('exit', r); try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(old.pid), '/T', '/F'], { windowsHide: true }); else old.kill(); } catch { r(); } setTimeout(r, 8000); });
    } else {
      await fetch(`${origin}/api/harness/stop`, { method: 'POST', headers: keyed() }).catch(() => {});
    }
    if (!(await waitFor(async () => !(await harnessAt(PORT)), 15000))) throw new Error(`the harness on port ${PORT} did not stop`);
    origin = await startServer();
    if (tray) { tray.setToolTip(trayTip()); createTrayMenu(); }
    return { ok: true, origin, owns: !!server };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { restarting = false; }
}
handle('restartHarness', () => restartHarness());
// ⚙ Settings → Storage: the app's own caches, the old OpenHarness folder and installed update downloads (desktop/storage.js).
let storage = null;
const getStorage = () => (storage ||= createStorage({
  userData: app.getPath('userData'), appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA || app.getPath('appData'),
  resourcesPath: process.resourcesPath, version: app.getVersion(), ownUserData: !process.env.OH_USER_DATA,
  sessions: { app: session.defaultSession, agent: agentSess(), tabs: session.fromPartition('persist:browse') },
  trashItem: (p) => shell.trashItem(p), readConfig, writeConfig, updateBusy: () => ['downloading', 'ready'].includes(update.state),
}));
handle('storage', async (op, arg) => {
  if (op === 'measure') return getStorage().measure();
  if (op === 'clear') return getStorage().clear(Array.isArray(arg) ? arg : []);
  // The two rules that are the app's own, kept in its config so they work before the harness has started.
  if (op === 'rules') { const r = arg || {}; writeConfig({ ...readConfig(), storage: { updateCleanup: r.updateCleanup !== false, agentCacheOnStart: !!r.agentCacheOnStart } }); return readConfig().storage; }
  throw new Error(`unknown storage step ${op}`);
});
handle('loginItem', (on) => (on === undefined ? loginItem() : setLoginItem(on)));
handle('closeAction', (v) => (v === undefined ? closeAction() : setCloseAction(v)));
handle('quit', () => { setImmediate(quitApp); return true; });
handle('info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dev: DEV, store: STORE, home: HOME || ROOT, origin, ownsServer: !!server }));
handle('openHome', () => { shell.openPath(HOME || ROOT); return true; });
// QuorX's own zoom (the page sends Ctrl + / − / 0 here unless they were for the terminal). Remembered between starts.
handle('zoom', (dir) => {
  if (!win) return 1;
  const f = dir === 'get' ? win.webContents.getZoomFactor() : nextZoom(win.webContents.getZoomFactor(), dir);
  if (dir !== 'get') { win.webContents.setZoomFactor(f); writeConfig({ ...readConfig(), zoom: f }); }
  return f;
});
handle('focusWindow', () => { showWindow(); return true; }); // a clicked notification brings the window back from the tray
// Notifications from the app itself (not the page's own), so they carry QuorX's name and logo. Clicking one brings
// the window back and opens that chat. Each is kept until it closes: one collected early loses its click.
const notes = new Set();
handle('notify', (n = {}) => showNote(n));
// Also sent by the harness itself over the link (scheduled chats), so it works while the window is hidden in the tray.
function showNote(n = {}) {
  if (!Notification.isSupported()) return false;
  const x = new Notification({ title: String(n.title || 'QuorX').slice(0, 90), body: String(n.body || '').slice(0, 240), icon: iconImage(256), silent: !!n.silent });
  notes.add(x);
  const drop = () => notes.delete(x);
  x.on('click', () => { drop(); showWindow(); send({ type: 'notify-click', chatId: n.chatId || null }); });
  x.on('close', drop); x.on('failed', drop);
  x.show();
  return true;
}
// Windows shows a notification under the name and icon registered for the app's ID. The installer's shortcut
// registers them; run from the repo there is none, and Windows showed "Electron". This registers both for this user
// (HKCU, the app's own ID only), once per start.
function registerToastName() {
  if (process.platform !== 'win32') return;
  try {
    const png = path.join(app.getPath('userData'), 'notify-icon.png');
    fs.writeFileSync(png, pngIcon(256));
    const key = String.raw`HKCU\Software\Classes\AppUserModelId\dev.quorx.desktop`;
    for (const [name, value] of [['DisplayName', 'QuorX'], ['IconUri', png]]) spawn('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } catch { /* the name stays Windows' default */ }
}
handle('openExternal', (url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(url); return true; });
handle('showFile', (file) => { if (file && file.startsWith(app.getPath('downloads'))) shell.showItemInFolder(file); return true; });

// ---------- the agent's tabs: real views driven by the harness (server/desktop.js, server/browser.js) ----------
// The harness sends DevTools commands for the agent's tab; this process runs them on a real view in
// the pane and sends back the page events the agent listens for. While the agent works, a see-through
// cover stops your clicks and its (usually wider) page is scaled to fit; when it is done, the cover
// lifts and the page takes the pane's size, ready for you.
let agentSession = null;
const agentSess = () => (agentSession ||= (() => { const s = session.fromPartition('persist:agent'); s.setUserAgent(CHROME_UA()); s.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen')); return s; })());
const FORWARD = new Set(['Page.loadEventFired', 'Page.frameNavigated', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
// A page's data requests (XHR, fetch) go to QuorX with only their id, method, address, status, type and size:
// never headers, cookies or bodies (a body is read only when the agent asks for one request).
const DATA_REQ = new Set(['XHR', 'Fetch', 'EventSource']);
function slimNet(method, p) {
  if (method === 'Network.requestWillBeSent') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, method: p.request && p.request.method, url: String((p.request && p.request.url) || '').slice(0, 2000) } : null;
  if (method === 'Network.responseReceived') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, status: p.response && p.response.status, mimeType: p.response && p.response.mimeType } : null;
  if (method === 'Network.loadingFinished') return { requestId: p.requestId, encodedDataLength: p.encodedDataLength };
  if (method === 'Network.loadingFailed') return { requestId: p.requestId, errorText: p.errorText };
  return undefined;
}
// What passes on: the page events as they are, network events slimmed (or dropped: a picture, a script).
const passOn = (method, params) => (FORWARD.has(method) ? params : method.startsWith('Network.') ? slimNet(method, params) : undefined);
let linkToken = null, eventQueue = [], eventTimer = null;
function postReply(body) { if (!origin || !linkToken) return; fetch(`${origin}/api/desktop/reply`, { method: 'POST', headers: keyed({ 'Content-Type': 'application/json' }), body: JSON.stringify({ token: linkToken, ...body }) }).catch(() => {}); }
function queueEvent(e) { eventQueue.push(e); if (!eventTimer) eventTimer = setTimeout(() => { eventTimer = null; const events = eventQueue; eventQueue = []; postReply({ events }); }, 40); }
// The agent's page is laid out at its own size; in a narrower pane it is shown scaled down to fit.
function applyEmu(t) {
  const f = fitEmu(t); if (!f) { placeView(t); return; }
  const key = JSON.stringify(f);
  if (t.sentEmu === key) { vlog('emu skip (pane)'); placeView(t); return; } // the same size again would make the page lay itself out (and flash) for nothing
  vlog('emu (pane)', key);
  t.sentEmu = key;
  t.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', f).then(() => placeView(t), () => { t.sentEmu = null; placeView(t); });
  // A page with no background of its own still looks white to the agent (its checks judge what it sees).
  t.view.webContents.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } }).catch(() => {});
}
const COVER = `data:text/html,${encodeURIComponent('<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;background:transparent;cursor:not-allowed;font:600 12px system-ui;user-select:none"><div style="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:rgba(167,139,250,.18);border:1px solid rgba(167,139,250,.6);color:#c4b5fd;backdrop-filter:blur(6px);white-space:nowrap">🤖 The agent is using this page · watch only until its reply ends</div></body>')}`;
// A promise that gives up after `ms`, so one stuck step can't hold up the agent's whole turn.
const within = (p, ms, what) => { let timer; return Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`${what} took over ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer)); };
const CAPTURE_HIDDEN = { stayHidden: true, stayAwake: true };
// The agent's screenshot. Every browser step ends with one, so a stalled picture failed the whole step. While you
// were on another tab its view was hidden, and a hidden view makes a new frame only now and then: every other
// capture waited for one (back in ~4 s, then ~27 s, past the harness's limit). Asking for a frame first doesn't help;
// capturing the view while the screenshot waits does, as each such capture paints the page (answers in ~0.1 s).
// The picture still gets only a few seconds, and after that the view's own picture is sent instead.
async function captureTab(t, params) {
  const wc = t.view.webContents, dbg = wc.debugger;
  // Where the page is scrolled to, and how much of it the view shows (in page pixels; scaled down in a narrow pane).
  const m = await within(dbg.sendCommand('Page.getLayoutMetrics'), 2000, 'reading the page size').catch(() => null);
  const v = m?.cssVisualViewport || m?.visualViewport || {};
  const vb = t.view.getBounds(), k = (t.emu && fitEmu(t)?.scale) || 1;
  const seen = { x: v.pageX || 0, y: v.pageY || 0, width: vb.width ? vb.width / k : v.clientWidth || 0, height: vb.height ? vb.height / k : v.clientHeight || 0 };
  // Screenshots at the page's own size, even while it is shown scaled down in the pane. A clip is in page
  // coordinates, so it starts where the page is scrolled to: one at 0,0 on a scrolled page was blank background.
  const p = t.emu ? { ...params, clip: { x: seen.x, y: seen.y, width: t.emu.width, height: t.emu.height, scale: 1 } } : params;
  // A picture of what shows can also be cut from the view's own picture; a bigger one (the whole page, for an
  // export) can't, and gets longer, as it can rightly take a while.
  const fits = !!t.emu || !p.clip || (p.clip.x >= seen.x - 1 && p.clip.y >= seen.y - 1 && p.clip.x + p.clip.width <= seen.x + seen.width + 1 && p.clip.y + p.clip.height <= seen.y + seen.height + 1);
  const shot = dbg.sendCommand('Page.captureScreenshot', p);
  let done = false; // stops the painting below once the screenshot has come back or been given up on
  if (!t.shown || !win?.isVisible() || win.isMinimized()) (async () => { while (!done) { await wc.capturePage(undefined, CAPTURE_HIDDEN).catch(() => {}); await new Promise((r) => setTimeout(r, 50)); } })();
  try { return await within(shot, fits ? 6000 : 20000, 'the screenshot'); } catch (e) {
    done = true;
    if (!fits) throw e;
    vlog('capture fallback', t.shown ? 'shown' : 'hidden', e.message);
    const data = await viewPicture(t, p, seen).catch((e2) => { vlog('capture fallback failed', e2.message); return null; });
    if (data) return { data };
    throw new Error(`no picture of the page (${e.message}, and the view itself could not be captured either)`);
  } finally { done = true; }
}
// The view's own picture, turned into what the screenshot would have been: page pixels, cut to the clip.
async function viewPicture(t, p, seen) {
  let img = await within(t.view.webContents.capturePage(undefined, CAPTURE_HIDDEN), 4000, 'capturing the view');
  if (img.isEmpty()) throw new Error('the view has no picture');
  // The picture is in screen pixels, and while the page has its own size it can come out bigger than the view, with
  // the view's part in its top-left corner (the rest black): that part first.
  let dpr = 1;
  try { dpr = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1; } catch { /* no window: one to one */ }
  const vb = t.view.getBounds(), is = img.getSize();
  const vw = Math.min(is.width, Math.round(vb.width * dpr)), vh = Math.min(is.height, Math.round(vb.height * dpr));
  if (vw > 0 && vh > 0 && (vw < is.width || vh < is.height)) img = img.crop({ x: 0, y: 0, width: vw, height: vh });
  // The view shows the visible part of the page, scaled down when the pane is narrower: back to page pixels.
  const width = Math.round(seen.width);
  if (width > 0 && img.getSize().width !== width) img = img.resize({ width, quality: 'good' });
  const s = img.getSize();
  const c = p.clip ? { x: p.clip.x - seen.x, y: p.clip.y - seen.y, width: p.clip.width, height: p.clip.height } : { x: 0, y: 0, width: s.width, height: s.height };
  const x = Math.max(0, Math.round(c.x)), y = Math.max(0, Math.round(c.y));
  const r = { x, y, width: Math.min(s.width - x, Math.round(c.width)), height: Math.min(s.height - y, Math.round(c.height)) };
  if (r.width < 1 || r.height < 1) throw new Error('the clip is outside the view');
  if (r.x || r.y || r.width !== s.width || r.height !== s.height) img = img.crop(r);
  return (p.format === 'png' ? img.toPNG() : img.toJPEG(p.quality || 80)).toString('base64');
}
const COMMANDS = {
  async 'app.notify'(n) { return showNote(n); },
  // Sign-in with OpenRouter finished in the user's browser: back to QuorX.
  async 'app.focus'() { showWindow(); return true; },
  // The Chrome extension's "Open in QuorX": the window comes forward on that chat.
  async 'app.openChat'({ chatId }) { showWindow(); if (chatId) send({ type: 'notify-click', chatId }); return true; },
  async 'tab.create'({ chatId }) {
    const sid = `agent-${String(chatId).replace(/[^\w-]/g, '').slice(0, 40)}`;
    if (tabs.has(sid)) closeTab(sid);
    const view = new WebContentsView({ webPreferences: { session: agentSess(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    // Dark around the agent's page when it is scaled down to fit a narrower pane (the page itself keeps a white default).
    view.setBackgroundColor('#070908');
    view.setVisible(false);
    win.contentView.addChildView(view);
    tabs.set(sid, { view, shown: false, agent: true, chatId, locked: false, emu: null, cover: null, bounds: null });
    wireView(sid, view);
    // A new page can come up in a fresh renderer that has lost the page size and scale (the agent's pages and the
    // sites it runs are on other addresses). Sent again once per page, or the page showed unscaled and cut off,
    // offset in its shrunk view, until something re-sent the size (clicking the Browser tab did).
    view.webContents.on('did-navigate', () => { const t = tabs.get(sid); if (t?.emu) { vlog('emu again (new page)', sid); t.sentEmu = null; applyEmu(t); } });
    // A view has no page until something loads; its debugger would wait forever on the first command.
    await view.webContents.loadURL('about:blank').catch(() => {});
    const dbg = view.webContents.debugger;
    dbg.attach('1.3');
    dbg.on('message', (_e, method, params) => { const p = passOn(method, params); if (p) queueEvent({ tab: sid, method, params: p }); });
    send({ sid, type: 'agent-tab', chatId });
    return sid;
  },
  async 'tab.cdp'({ tab, method, params = {} }) {
    const t = tabs.get(tab); if (!t) throw new Error('that tab is gone');
    if (method === 'Emulation.setDeviceMetricsOverride') {
      t.emu = { ...params }; delete t.emu.scale;
      // The agent sets its page size on every page it opens; the same size again changes nothing.
      const f = fitEmu(t), key = JSON.stringify(f);
      if (t.sentEmu === key) { vlog('emu skip (agent)', tab); placeView(t); return {}; }
      vlog('emu (agent)', tab, key);
      t.sentEmu = key;
      // The page takes its new size and scale first, then the view moves to fit it: the other way round, the view
      // showed the page unscaled (cut off and offset) until the scale arrived.
      const r = await t.view.webContents.debugger.sendCommand(method, f).catch((e) => { t.sentEmu = null; throw e; });
      placeView(t);
      return r;
    }
    if (method === 'Emulation.clearDeviceMetricsOverride') { vlog('emu clear', tab); t.emu = null; t.sentEmu = null; placeView(t); }
    if (method === 'Page.captureScreenshot' || method === 'Page.navigate') vlog(method, tab);
    // The agent works in the page's own pixels (screenshots, element boxes), but its view may be shown shrunk to
    // fit the pane, and mouse and touch input land in the view's pixels. Without this, clicks missed by 1/scale (~1.5×).
    const f = t.emu && fitEmu(t);
    if (f && f.scale !== 1 && (method === 'Input.dispatchMouseEvent' || method === 'Input.synthesizeTapGesture')) return t.view.webContents.debugger.sendCommand(method, { ...params, x: params.x * f.scale, y: params.y * f.scale });
    if (f && f.scale !== 1 && method === 'Input.dispatchTouchEvent') return t.view.webContents.debugger.sendCommand(method, { ...params, touchPoints: (params.touchPoints || []).map((p) => ({ ...p, x: p.x * f.scale, y: p.y * f.scale })) });
    if (method === 'Page.captureScreenshot') return captureTab(t, params);
    return t.view.webContents.debugger.sendCommand(method, params);
  },
  async 'tab.lock'({ tab, locked }) {
    const t = tabs.get(tab); if (!t) return false;
    t.locked = !!locked;
    if (locked && !t.cover) {
      t.cover = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      t.cover.setBackgroundColor('#00000000');
      t.cover.webContents.loadURL(COVER);
      win.contentView.addChildView(t.cover); // added after the page, so it sits on top
      if (t.bounds) t.cover.setBounds(t.bounds);
      t.cover.setVisible(t.shown);
    } else if (!locked && t.cover) { win.contentView.removeChildView(t.cover); t.cover.webContents.close(); t.cover = null; }
    send({ sid: tab, type: 'agent-lock', locked: !!locked });
    return true;
  },
  async 'tab.close'({ tab }) { return closeTab(tab); },
  // 🤖 Give to agent: one of your tabs, lent to a chat. Its debugger forwards page events like the agent's own tab's;
  // detaching lets go of it (the tab and your sign-in stay as they are).
  async 'tab.attach'({ tab }) {
    const t = tabs.get(tab); if (!t || t.agent) throw new Error('that tab is gone');
    const dbg = t.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (!t.onDbg) { t.onDbg = (_e, method, params) => { const p = passOn(method, params); if (p) queueEvent({ tab, method, params: p }); }; dbg.on('message', t.onDbg); }
    return tab;
  },
  async 'tab.detach'({ tab }) {
    const t = tabs.get(tab); if (!t || t.agent) return false;
    const dbg = t.view.webContents.debugger;
    if (t.onDbg) { dbg.removeListener('message', t.onDbg); t.onDbg = null; }
    try { if (dbg.isAttached()) dbg.detach(); } catch { /* gone */ }
    return true;
  },
};
// Linked to the harness: commands come down an event stream; answers and page events go back by POST.
// It reconnects when the harness restarts; an older harness without the link just keeps headless tabs.
async function linkLoop() {
  for (;;) {
    try {
      linkToken = crypto.randomBytes(18).toString('hex');
      const r = await fetch(`${origin}/api/desktop/link?token=${linkToken}`, { headers: keyed() });
      if (r.ok) {
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); buf = buf.slice(i + 2);
            if (!line) continue;
            const { id, cmd, args } = JSON.parse(line.slice(6));
            Promise.resolve().then(() => { if (!COMMANDS[cmd]) throw new Error(`unknown command ${cmd}`); if (!win) throw new Error('the window is closed'); return COMMANDS[cmd](args || {}); })
              .then((result) => postReply({ id, result }), (e) => postReply({ id, error: e.message }));
          }
        }
      }
    } catch { /* the harness is restarting */ }
    await new Promise((res) => setTimeout(res, 3000));
  }
}

// The (hidden) menu, without Electron's zoom shortcuts: Ctrl + / − / 0 are QuorX's own (the app, each browser tab,
// the terminal), and the menu's would zoom the app a second time.
function appMenu() {
  const t = process.platform === 'darwin' ? [{ role: 'appMenu' }] : [];
  t.push({ role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' });
  return Menu.buildFromTemplate(t);
}
app.whenReady().then(async () => {
  Menu.setApplicationMenu(appMenu());
  HOME = await chooseHome();
  if (HOME === false) { quitting = true; return app.quit(); }
  PORT = Number(process.env.AGENT_PORT || readEnvPort(HOME || ROOT) || 5188);
  try { origin = await startServer(); }
  catch (e) { dialog.showErrorBox('QuorX could not start', e.message); quitting = true; return app.quit(); }
  createWindow();
  createTray();
  linkLoop();
  // Installed update downloads go a little after start (⚙ Settings → Storage → Automatic cleanup).
  if (readConfig().storage?.updateCleanup !== false) setTimeout(() => getStorage().clear([{ id: 'desk:updates' }]).catch(() => {}), 30000);
  // Check for updates a little after start, then every 6 hours.
  setTimeout(checkUpdates, 15000);
  setInterval(checkUpdates, 6 * 3600e3);
}).catch((e) => { console.error(e); app.quit(); });
// Closing the window keeps the harness in the tray; the app ends only with Quit.
app.on('window-all-closed', () => { if (!server) app.quit(); });
app.on('activate', () => (win ? showWindow() : createWindow()));
app.on('before-quit', () => { quitting = true; });
app.on('quit', () => { if (server) { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true }); else server.kill(); } catch { /* gone */ } } });
