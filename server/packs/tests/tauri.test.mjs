// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tauri pack self-test: Tauri projects (1 and 2) are found with how they run, the start line opens a DevTools port
// QuorX lets the agent attach to, the Rust check runs in src-tauri, and (with the toolchain) a tiny app builds and its
// window is read and clicked through WebView2's DevTools port.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { tauriProject, cliVersion, webview2Version, devtoolsPort, devLine } from '../tauri.js';
import { packsIn, packNotes, allChecks } from '../index.js';
import { startedWithDevtoolsPort } from '../../browser.js';
import { decide } from '../../cmdpolicy.js';
import { languageChecks } from '../../langchecks.js';

const conf2 = (extra = {}) => JSON.stringify({ $schema: 'https://schema.tauri.app/config/2', productName: 'qxtauri', version: '0.1.0', identifier: 'app.quorx.packtest',
  build: { frontendDist: '../dist', ...extra }, app: { windows: [{ title: 'QuorX pack test', width: 480, height: 320 }], security: { csp: null } }, bundle: { active: false, icon: ['icons/icon.png', 'icons/icon.ico'] } }, null, 2);
const cargo = (deps = '') => `[package]\nname = "qxtauri"\nversion = "0.1.0"\nedition = "2021"\n\n${deps}`;

test('tauri: a Tauri 2 project is found, with its own CLI and the line that starts it', () => {
  const dir = project('tauri2', {
    'package.json': JSON.stringify({ scripts: { dev: 'vite', tauri: 'tauri' }, devDependencies: { '@tauri-apps/cli': '^2.1.0', vite: '^6.0.0' } }),
    'src-tauri/tauri.conf.json': conf2({ devUrl: 'http://localhost:1420', beforeDevCommand: 'npm run dev' }),
    'src-tauri/Cargo.toml': cargo('[dependencies]\ntauri = { version = "2", features = [] }\n'),
  });
  const p = tauriProject(dir);
  assert.deepEqual({ dir: p.dir, version: p.version, cli: p.cli, devUrl: p.devUrl, bin: p.bin }, { dir: 'src-tauri', version: 2, cli: 'npm run tauri', devUrl: 'http://localhost:1420', bin: 'qxtauri' });
  assert.deepEqual(packsIn(dir).map((x) => x.id).filter((id) => ['node', 'rust', 'tauri'].includes(id)).sort(), ['node', 'rust', 'tauri'], 'the Rust and node packs apply too');
  const n = packNotes(dir, [{ id: 'tauri', found: true }]);
  const port = devtoolsPort(dir);
  if (WIN) assert.ok(n.includes(devLine('npm run tauri', port)) && n.includes(`cdp:${port}`), 'the notes give the start line and the cdp target');
  assert.match(n, /capabilities/);
  assert.match(n, /target\/release\/bundle/);
  assert.ok(n.includes(`program src-tauri/target/debug/qxtauri${WIN ? '.exe' : ''}`), 'the built program for Rust debugging');
  assert.doesNotMatch(n, /no Tauri CLI here/, 'the project has its own CLI');
});

test('tauri: a Tauri 1 project is found, and a missing CLI is named', () => {
  const dir = project('tauri1', {
    'src-tauri/tauri.conf.json': JSON.stringify({ build: { devPath: 'http://localhost:5173', distDir: '../dist' }, package: { productName: 'old' }, tauri: { allowlist: { all: false } } }),
    'src-tauri/Cargo.toml': cargo('[dependencies]\ntauri = { version = "1.5", features = ["shell-open"] }\n'),
  });
  const p = tauriProject(dir);
  assert.deepEqual({ version: p.version, cli: p.cli, frontendDist: p.frontendDist }, { version: 1, cli: 'cargo tauri', frontendDist: '../dist' });
  const n = packNotes(dir, []);
  assert.match(n, /allowlist/);
  assert.match(n, /no Tauri CLI here/);
  assert.match(n, /@tauri-apps\/cli@\^1/);
});

test('tauri: other config forms are found; a plain Rust crate is not a Tauri app', () => {
  const json5 = project('tauri-json5', { 'src-tauri/tauri.conf.json5': '{ productName: "x" }', 'src-tauri/Cargo.toml': cargo('[dependencies]\ntauri = "2.0.0"\n') });
  assert.equal(tauriProject(json5).version, 2, 'the version comes from Cargo.toml');
  const toml = project('tauri-toml', { 'Tauri.toml': 'identifier = "app.quorx.t"\n', 'Cargo.toml': cargo(), 'node_modules/@tauri-apps/cli/package.json': '{}' });
  assert.deepEqual({ dir: tauriProject(toml).dir, cli: tauriProject(toml).cli }, { dir: '.', cli: 'npx tauri' });
  assert.ok(packsIn(toml).some((x) => x.id === 'tauri'));
  const plain = project('tauri-none', { 'Cargo.toml': cargo(), 'src/main.rs': 'fn main() {}\n' });
  assert.equal(tauriProject(plain), null);
  assert.ok(!packsIn(plain).some((x) => x.id === 'tauri'));
});

test('tauri: the CLI and WebView2 versions are read', () => {
  assert.equal(cliVersion('tauri-cli 2.1.0'), '2.1.0');
  assert.equal(cliVersion('error: no such command: `tauri`'), null);
  assert.equal(webview2Version('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\r\n    pv    REG_SZ    131.0.2903.70\r\n'), '131.0.2903.70');
  assert.equal(webview2Version('    pv    REG_SZ    0.0.0.0'), null, 'an uninstalled runtime');
  assert.equal(webview2Version('ERROR: The system was unable to find the specified registry key or value.'), null);
});

test('tauri: a DevTools port set through WebView2\'s variable counts as the agent\'s own app', async () => {
  const port = devtoolsPort('D:/work/app');
  assert.ok(port >= 9400 && port < 9500 && port === devtoolsPort('D:/work/app'), 'one stable port per folder');
  for (const shell of ['powershell', 'cmd', 'bash']) {
    const line = devLine('cargo tauri', port, shell);
    assert.ok(startedWithDevtoolsPort(line, port), `${shell}: ${line}`);
    assert.ok(!startedWithDevtoolsPort(line, port + 1) && !startedWithDevtoolsPort(line.replace(String(port), `${port}0`), port), 'only that port');
  }
  assert.ok(startedWithDevtoolsPort('npx electron . --remote-debugging-port=9333', 9333), 'Electron\'s flag still counts');
  // The rules engine judges the start line as the command it runs (cargo), not as something hidden behind a variable.
  const d = await decide(devLine('cargo tauri', port), { shell: 'powershell', root: project('tauri-rules'), rules: [], mode: 'strict' });
  assert.deepEqual(d.segments.map((s) => s.program), ['cargo']);
  assert.notEqual(d.verdict, 'deny');
});

test('tauri: the front end\'s TypeScript is covered by the node pack\'s check', () => {
  const dir = project('tauri-ts', { 'tsconfig.json': '{}', 'src/main.ts': 'export {};\n', [`node_modules/.bin/${WIN ? 'tsc.cmd' : 'tsc'}`]: '' });
  const ts = allChecks().find((c) => c.id === 'ts');
  assert.ok(ts.ext.test('src/main.ts') && ts.marker(dir), 'tsc --noEmit runs for src/main.ts');
});

test('tauri: cargo check runs in src-tauri and names the changed file', async (t) => {
  const skip = await skipUnless('rust'); if (skip) return t.skip(skip);
  // A plain crate where src-tauri would be: cargo check needs no linker for it, so this runs without Build Tools.
  const dir = project('tauri-check', { 'package.json': '{}', 'src-tauri/tauri.conf.json': conf2(), 'src-tauri/Cargo.toml': cargo('[dependencies]\n'),
    'src-tauri/src/main.rs': 'fn main() {\n    let n: u32 = "three";\n    println!("{n}");\n}\n' });
  const r = await languageChecks(dir, ['src-tauri/src/main.rs'], { have: ['rust'] });
  assert.deepEqual(r.ran.map((x) => [x.lang, x.dir]), [['rust', 'src-tauri']]);
  assert.ok(r.problems.some((p) => /main\.rs/.test(p) && /mismatched|expected/i.test(p)), `problems: ${r.problems.join(' | ')}`);
});

// A 32×32 PNG and an icon file: tauri-build needs an app icon to build at all.
function png() {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 32 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 4, Buffer.from([0x3b, 0x82, 0xf6, 0xff]))])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
// The icon file holds the same blue square as a 32-bit bitmap, the form every icon reader takes.
function ico() {
  const dib = Buffer.alloc(40 + 32 * 32 * 4 + 32 * 4);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(32, 4); dib.writeInt32LE(64, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  for (let i = 0; i < 32 * 32; i++) dib.set([0xf6, 0x82, 0x3b, 0xff], 40 + i * 4);
  const head = Buffer.alloc(22); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.set([32, 32, 0, 0], 6); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(dib.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, dib]);
}

test('tauri: a tiny app builds, and its window is read and clicked through its DevTools port', async (t) => {
  if (!WIN) return t.skip('the window is reached through WebView2, on Windows');
  const skip = await skipUnless('tauri', { works: true }) || await skipUnless('webview2'); if (skip) return t.skip(skip);
  const icon = png();
  const dir = project('tauri-app', {
    'dist/index.html': '<!doctype html><html><head><title>QuorX pack test</title></head><body><h1>QuorX pack test</h1><p id="n">Count: 0</p><button onclick="n.textContent = \'Count: \' + (++window.c || (window.c = 1))">Add one</button></body></html>\n',
    'src-tauri/tauri.conf.json': conf2(),
    'src-tauri/Cargo.toml': cargo('[build-dependencies]\ntauri-build = { version = "2", features = [] }\n\n[dependencies]\ntauri = { version = "2", features = [] }\n'),
    'src-tauri/build.rs': 'fn main() {\n    tauri_build::build()\n}\n',
    'src-tauri/src/main.rs': 'fn main() {\n    tauri::Builder::default()\n        .run(tauri::generate_context!())\n        .expect("error while running the app");\n}\n',
  });
  fs.mkdirSync(path.join(dir, 'src-tauri', 'icons'));
  fs.writeFileSync(path.join(dir, 'src-tauri', 'icons', 'icon.png'), icon);
  fs.writeFileSync(path.join(dir, 'src-tauri', 'icons', 'icon.ico'), ico());
  const port = devtoolsPort(dir);
  const proc = spawn('cargo', ['tauri', 'dev', '--no-watch'], { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  const { openTab } = await import('../../browser.js');
  let tab = null;
  try {
    // The first build compiles a few hundred crates.
    for (const end = Date.now() + 14 * 60e3; !tab && Date.now() < end && proc.exitCode === null;) {
      try { tab = await openTab({ cdpPort: port }); } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    assert.ok(tab, `the window never answered on DevTools port ${port}. Build output:\n${out.slice(-3000)}`);
    let s = await tab.summary();
    for (let i = 0; i < 20 && !/Count: 0/.test(s.text); i++) { await new Promise((r) => setTimeout(r, 500)); s = await tab.summary(); }
    assert.match(s.text, /Count: 0/);
    await tab.click({ text: 'Add one' });
    assert.match((await tab.summary()).text, /Count: 1/);
  } finally {
    await tab?.close().catch(() => {});
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});
