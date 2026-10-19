// Electron pack self-test: a tiny app (a window with a button whose click goes to the main process) is started as a
// background job with its DevTools port, its button is clicked through that port and the page text read, and the main
// process is stopped at a breakpoint through its Node inspector (debug attach). The app tests need an Electron binary:
// set QX_ELECTRON to one (e.g. node_modules\electron\dist\electron.exe of any Electron project), or run
// npm run desktop:setup so QuorX's own desktop app has one. The pack's own logic is tested without it.
import { project, skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pack, { isElectron, electronBinary, packager } from '../electron.js';
import { packsIn, packNotes } from '../index.js';
import fs from 'node:fs';
import { startBackground, stopBackground, getBackground, jobOutput, listBackground } from '../../bgjobs.js';
import { openTab } from '../../browser.js';
import { debugAttach, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';
import { runAgent } from '../../agent.js';
import { saveProject, forgetProject } from '../../store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXE = process.env.QX_ELECTRON || electronBinary(path.join(REPO, 'desktop'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const needApp = async () => (await skipUnless('node')) || (!EXE ? 'no Electron binary (set QX_ELECTRON, or run npm run desktop:setup)' : false);

const PKG = JSON.stringify({ name: 'qx-electron-pack-test', main: 'main.js', devDependencies: { electron: '*' } });
const MAIN = [
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  "app.setPath('userData', require('node:path').join(__dirname, 'data'));",
  'let clicks = 0;',
  "ipcMain.handle('clicked', (e, label) => {",
  '  clicks += 1;',
  '  const reply = `${label} ${clicks}`;', // line 6: the breakpoint
  '  console.error(`main: ${reply}`);',
  '  return reply;',
  '});',
  'app.whenReady().then(() => {',
  // Shown off-screen: a hidden window stops answering screenshots once its main process has been paused.
  '  const win = new BrowserWindow({ x: -4000, y: -4000, width: 400, height: 300, skipTaskbar: true, focusable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });',
  "  win.loadFile('index.html');",
  '});',
  "app.on('window-all-closed', () => app.quit());",
  '',
].join('\n');
const HTML = `<!doctype html><title>Counter</title><button id="go">Count</button><p id="out">none</p>
<script>
const { ipcRenderer } = require('electron');
document.getElementById('go').onclick = async () => {
  const r = await ipcRenderer.invoke('clicked', 'clicked');
  document.getElementById('out').textContent = r;
  console.error('renderer: ' + r);
};
</script>`;
const app = () => project('electron', { 'package.json': PKG, 'main.js': MAIN, 'index.html': HTML });

// The app as the agent starts it: a background job through QuorX's gate. ELECTRON_RUN_AS_NODE is set here as it is
// when QuorX runs inside its desktop app; the gate must drop it, or Electron would run main.js as plain Node.
function startApp(dir, flags) {
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try { return startBackground({ projectId: 'pack-test', cwd: dir, line: `"${EXE}" . ${flags}`, shell: 'direct', logTo: path.join(dir, 'app.log') }); }
  finally { delete process.env.ELECTRON_RUN_AS_NODE; }
}
async function window(port) {
  for (let i = 0; ; i++) {
    try { return await openTab({ cdpPort: port }); } catch (e) { if (i > 40) throw e; await sleep(500); }
  }
}
async function textOf(tab, re) {
  for (let i = 0; i < 40; i++) { const t = (await tab.summary()).text; if (re.test(t)) return t; await sleep(250); }
  return (await tab.summary()).text;
}

test('electron: a project is found from its package.json, with its binary and packager', () => {
  const dir = project('electron-detect', { 'package.json': PKG, 'node_modules/electron/path.txt': 'electron.exe', 'node_modules/electron/dist/electron.exe': '' });
  assert.equal(isElectron(dir), true);
  assert.equal(electronBinary(dir), path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe'));
  assert.equal(packager(dir), null);
  assert.ok(packsIn(dir).some((p) => p.id === 'electron'));
  assert.ok(packsIn(dir).some((p) => p.id === 'node'), 'TypeScript and scripts stay with the Node pack');
  const plain = project('electron-plain', { 'package.json': JSON.stringify({ name: 'x', dependencies: { express: '4' } }) });
  assert.equal(isElectron(plain), false);
  assert.equal(electronBinary(plain), null);
  const forge = project('electron-forge', { 'package.json': JSON.stringify({ dependencies: { electron: '30' }, devDependencies: { '@electron-forge/cli': '7' } }) });
  assert.equal(packager(forge).cmd, 'npx electron-forge make');
  const builder = project('electron-builder', { 'package.json': JSON.stringify({ devDependencies: { electron: '30', 'electron-builder': '24' }, build: { appId: 'x' } }) });
  assert.equal(packager(builder).tool, 'electron-builder');
});

test('electron: the notes say how to start, drive, debug and package it', () => {
  const dir = project('electron-notes', { 'package.json': JSON.stringify({ main: 'src/main.js', devDependencies: { electron: '30', 'electron-builder': '24' } }) });
  const n = pack.notes(new Set(['node']), dir);
  for (const re of [/src\/main\.js/, /--remote-debugging-port=/, /cdp:<port>/, /job_output/, /ELECTRON_RUN_AS_NODE/, /--inspect=/, /debug attach/, /npx electron-builder/, /npm install/]) assert.match(n, re);
  assert.doesNotMatch(n, /\.(bat|cmd|ps1)\b/, 'commands run directly, never through wrapper scripts');
  assert.match(packNotes(dir, [{ id: 'node', found: true }]), /- Electron: /);
});

test('electron: attach only reaches inspectors of the agent\'s own jobs', async () => {
  await assert.rejects(debugAttach({ projectId: 'pack-test', cwd: '.', port: await freePort() }), /none of your running background jobs/);
  await assert.rejects(debugAttach({ projectId: 'pack-test', cwd: '.', port: 80 }), /inspector port/);
});

test('electron: the window is driven through its DevTools port, with renderer and main-process output', async (t) => {
  const skip = await needApp(); if (skip) return t.skip(skip);
  const dir = app();
  const port = await freePort();
  const job = startApp(dir, `--remote-debugging-port=${port}`);
  let tab;
  try {
    tab = await window(port);
    assert.match((await tab.summary()).text, /none/);
    assert.match(await tab.click({ selector: '#go' }), /clicked button "Count"/);
    assert.match(await textOf(tab, /clicked 1/), /clicked 1/);
    assert.ok(tab.console.some((l) => /renderer: clicked 1/.test(l)), `renderer console: ${tab.console.join(' | ')}`);
    let out = '';
    for (let i = 0; i < 20 && !/main: clicked 1/.test(out); i++) out += (await jobOutput(job.id, { wait: 500 })).text;
    assert.match(out, /main: clicked 1/);
  } finally { await tab?.close(); await stopBackground(job.id).catch(() => {}); }
});

test('electron: the main process stops at a breakpoint (debug attach to --inspect)', async (t) => {
  const skip = await needApp(); if (skip) return t.skip(skip);
  const dir = app();
  const port = await freePort(), inspect = await freePort();
  const job = startApp(dir, `--inspect=${inspect} --remote-debugging-port=${port}`);
  let tab, s;
  try {
    tab = await window(port);
    s = await debugAttach({ projectId: 'pack-test', cwd: dir, port: inspect });
    assert.equal(s.paused, false);
    assert.match(await debugBreak(s.id, 'main.js', 6), /breakpoint at main\.js:6$/);
    // The click stops the main process, and the window waits with it: the click finishes once the debugger lets go.
    const click = tab.click({ selector: '#go' });
    const st = await debugMove(s.id, 'continue', 15000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 6);
    assert.equal(path.basename(st.frames[0].file), 'main.js');
    assert.match(await debugEval(s.id, 'label'), /^"?clicked"?$/);
    assert.equal(await debugEval(s.id, 'clicks'), '1');
    assert.deepEqual(await debugStop(s.id), { detached: true, job: job.id }); s = null;
    await click;
    assert.equal(getBackground(job.id).status, 'running', 'stop only disconnects');
    assert.match(await textOf(tab, /clicked 1/), /clicked 1/, 'the app goes on once the debugger lets go');
  } finally { if (s) await debugStop(s.id).catch(() => {}); await tab?.close(); await stopBackground(job.id).catch(() => {}); }
});

test('electron: --inspect-brk waits on the main process\'s first line', async (t) => {
  const skip = await needApp(); if (skip) return t.skip(skip);
  const dir = app();
  const inspect = await freePort();
  const job = startApp(dir, `--inspect-brk=${inspect}`);
  let s;
  try {
    s = await debugAttach({ projectId: 'pack-test', cwd: dir, port: inspect });
    assert.equal(s.paused, true);
    await debugBreak(s.id, 'main.js', 11);
    const st = await debugMove(s.id, 'continue', 15000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 11);
    assert.match(await debugEval(s.id, 'typeof BrowserWindow'), /^"?function"?$/);
  } finally { if (s) await debugStop(s.id).catch(() => {}); await stopBackground(job.id).catch(() => {}); }
});

// The same, as the agent does it: its own tools with a scripted model (no key, no network).
let rn = 0;
const reply = (text, calls = []) => ({ text, toolCalls: calls.map(([name, args], i) => ({ id: `e${++rn}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })), usage: { cost: 0 }, ms: 1, firstMs: 1, finishReason: 'stop' });
const toolOut = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.content).at(-1);

test('electron: the agent starts the app, clicks through cdp:<port> and stops the main process at a breakpoint', async (t) => {
  const skip = await needApp(); if (skip) return t.skip(skip);
  // Started the way npx electron does it: Node runs electron's cli.js, which waits for the app. (From PowerShell,
  // electron.exe itself would return at once, being a window app, and the job would end without it.)
  const cli = path.join(path.dirname(EXE), '..', 'cli.js');
  if (!fs.existsSync(cli)) return t.skip(`no cli.js next to ${EXE}`);
  const dir = app();
  fs.mkdirSync(path.join(dir, '.quorx'));
  fs.writeFileSync(path.join(dir, '.quorx', 'permissions.json'), JSON.stringify({ rules: [{ effect: 'allow', match: 'node *', by: 'user' }] }));
  const id = `el${Date.now().toString(36)}`;
  saveProject({ id, name: 'electron test', path: dir });
  const port = await freePort(), inspect = await freePort();
  const outs = [];
  const steps = [
    ['shell', { command: `node "${cli}" . --inspect=${inspect} --remote-debugging-port=${port}`, background: true }],
    ['browser', { action: 'open', target: `cdp:${port + 1}` }],
    ['browser', { action: 'open', target: `cdp:${port}` }],
    ['browser', { action: 'click', selector: '#go' }],
    ['debug', { action: 'attach', port: inspect }],
    ['debug', { action: 'break', id: 'd?', file: 'main.js', line: 6 }],
    ['browser', { action: 'click', selector: '#go' }], // stops at the breakpoint: the window waits with it
    ['debug', { action: 'state', id: 'd?' }],
    ['debug', { action: 'stop', id: 'd?' }],
    ['browser', { action: 'scroll', dy: 10 }],
  ];
  let sid = null, calls = 0;
  const script = (body, i) => {
    if (i > 0) outs.push(toolOut(body));
    if (i === 5) sid = /session (d\d+)/.exec(outs[4])?.[1];
    const step = steps[i];
    if (!step) return reply('Done.');
    return reply('', [[step[0], JSON.parse(JSON.stringify(step[1]).replace('"d?"', JSON.stringify(sid)))]]);
  };
  try {
    await runAgent({ runId: id, projectId: id, text: 'debug my electron app', setup: { model: 'test/model' },
      settings: { approval: 'strict', debugger: 'always', mediaEnabled: false, verify: false, review: 'off', checks: { gap: false, shots: false, click: false }, tools: { browser: { on: true } } } },
    () => {}, new AbortController().signal, { chatStream: async (b) => script(b, calls++), catalogue: [{ id: 'test/model', maxOut: 4000 }], quiet: true });
  } finally {
    for (const j of listBackground(id)) if (j.status === 'running') await stopBackground(j.id).catch(() => {});
    forgetProject(id);
  }
  const at = (k) => outs[k] || '';
  assert.match(at(0), /job bg\d+/);
  assert.match(at(1), /none of your running background jobs was started with --remote-debugging-port/, 'only the ports of its own apps');
  assert.match(at(2), /Attached to the app's window[\s\S]*Count/);
  assert.match(at(3), /^clicked button "Count"[\s\S]*Console errors: error: renderer: clicked 1\nVisible text:\nCount\s+clicked 1/, 'the app\'s own window is not marked untrusted');
  assert.match(at(4), /attached to job bg\d+ on port \d+: it keeps running/);
  assert.match(at(5), /^breakpoint at main\.js:6\n/);
  assert.match(at(6), /did not answer[\s\S]*debug state/);
  assert.match(at(7), /Paused \(other\) at main\.js:6[\s\S]*clicks = 2/);
  assert.match(at(8), /Disconnected; job bg\d+ keeps running/);
  assert.match(at(9), /scrolled[\s\S]*clicked 2/);
});
