// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Two kinds of server (server/pages.js): project servers stay in .quorx/launch.json, previews and mockups are pages on
// QuorX's own pages address. The one-time move of older previews out of the launch file (with Undo), preview_site
// adding a page instead of a launch entry, "Keep as project server", and the /api/pages route on a throwaway QuorX.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reply, run, toolResults, of } from './agent-harness.mjs';
import { saveProject, forgetProject } from '../server/store.js';
import { migratePreviews, listPages, addPage, undoMove, dismissMove, keepAsServer, removePage, isPreviewEntry } from '../server/pages.js';
import { launchConfigs } from '../server/workspace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = '<!doctype html><title>Game</title><button>Start</button>';
const DEV = { name: 'web', command: 'npm', args: ['run', 'dev'] };
const PREV = (name, page) => ({ name, command: 'node', args: ['.quorx/serve.mjs', page] });
const launchOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'launch.json'), 'utf8'));
// A project with a dev server between two old previews, as older versions left it.
function mixed(dir, configurations = [PREV('site', 'index.html'), DEV, PREV('site-receipts', 'receipts/index.html')]) {
  fs.mkdirSync(path.join(dir, '.quorx'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.writeFileSync(path.join(dir, 'receipts', 'index.html'), PAGE);
  fs.writeFileSync(path.join(dir, '.quorx', 'launch.json'), JSON.stringify({ version: 1, configurations }, null, 2));
}
function project(prep) {
  const id = `pg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, dir = tempDir('quorx-pages-');
  saveProject({ id, name: 'pages test', path: dir });
  prep?.(dir);
  return { id, dir, done: () => forgetProject(id) };
}

test('the old previews move from the launch file to Pages once; real servers stay; Undo puts them back where they were', () => {
  const p = project(mixed);
  try {
    assert.ok(isPreviewEntry(PREV('x', 'a.html')) && !isPreviewEntry(DEV) && !isPreviewEntry({ command: 'node', args: ['server.js'] }));
    const r = listPages(p.id);
    assert.deepEqual(launchOf(p.dir).configurations, [DEV], 'only the dev server is left, untouched');
    assert.deepEqual(r.pages.map((x) => x.entry).sort(), ['index.html', 'receipts/index.html']);
    assert.ok(r.pages.every((x) => x.from === 'moved' && x.url.startsWith(`/ws/${p.id}/`)));
    assert.equal(r.notice.count, 2);
    assert.deepEqual(r.notice.names, ['site', 'site-receipts']);
    // Idempotent: a second look moves nothing, and a serve.mjs entry saved on purpose afterwards stays a project server.
    assert.equal(migratePreviews(p.dir), 0);
    keepAsServer(p.id, 'index.html');
    assert.equal(migratePreviews(p.dir), 0);
    assert.deepEqual(launchConfigs(p.id).map((c) => c.name), ['web', 'site']);
    assert.ok(fs.existsSync(path.join(p.dir, '.quorx', 'serve.mjs')), 'the kept site has its static server script');
    assert.deepEqual(listPages(p.id).pages.map((x) => x.entry), ['receipts/index.html'], 'the kept page left Pages');
    // Undo: the moved entries go back to their places, except a name that is taken again ("site" was kept above).
    assert.equal(undoMove(p.id), 1);
    assert.deepEqual(launchOf(p.dir).configurations.map((c) => c.name), ['web', 'site', 'site-receipts']);
    const after = listPages(p.id);
    assert.equal(after.notice, null, 'the notice goes with Undo');
    assert.deepEqual(after.pages, [], 'the moved pages left Pages');
    assert.equal(undoMove(p.id), 0, 'a second Undo does nothing');
    assert.deepEqual(launchOf(p.dir).configurations.map((c) => c.name), ['web', 'site', 'site-receipts'], 'and nothing moves again');
  } finally { p.done(); }
});

test('the move leaves an unreadable launch file alone, and works once it is fixed; ✕ keeps the move', () => {
  const p = project((d) => { fs.mkdirSync(path.join(d, '.quorx'), { recursive: true }); fs.writeFileSync(path.join(d, '.quorx', 'launch.json'), '{ "configurations": [ oops'); });
  try {
    const r = listPages(p.id);
    assert.deepEqual(r, { pages: [], notice: null });
    assert.equal(fs.readFileSync(path.join(p.dir, '.quorx', 'launch.json'), 'utf8'), '{ "configurations": [ oops', 'not touched');
    assert.ok(!fs.existsSync(path.join(p.dir, '.quorx', 'pages.json')), 'not marked as done either');
    fs.writeFileSync(path.join(p.dir, '.quorx', 'launch.json'), JSON.stringify({ configurations: 'not a list' }));
    assert.equal(migratePreviews(p.dir), 0);
    mixed(p.dir, [DEV, PREV('site', 'index.html')]);
    assert.equal(listPages(p.id).notice.count, 1);
    assert.ok(dismissMove(p.id));
    assert.equal(listPages(p.id).notice, null);
    assert.equal(undoMove(p.id), 0, 'no Undo after ✕');
    assert.deepEqual(launchOf(p.dir).configurations, [DEV]);
  } finally { p.done(); }
  const q = project(); // no launch file at all: nothing to move, and nothing is written there
  try {
    assert.deepEqual(listPages(q.id), { pages: [], notice: null });
    assert.ok(!fs.existsSync(path.join(q.dir, '.quorx')), 'a look at a folder QuorX never wrote to creates nothing there');
  } finally { q.done(); }
});

test('pages: added once per file (newest first), kept inside the project, removable; Keep as project server refuses a taken name', () => {
  const p = project((d) => { fs.writeFileSync(path.join(d, 'index.html'), PAGE); fs.writeFileSync(path.join(d, 'mock.html'), PAGE); });
  try {
    addPage(p.id, { entry: 'index.html', title: 'Home' });
    addPage(p.id, { entry: 'mock.html', title: 'Mockup' });
    addPage(p.id, { entry: './index.html', title: 'Home v2' });
    assert.deepEqual(listPages(p.id).pages.map((x) => [x.entry, x.title]), [['index.html', 'Home v2'], ['mock.html', 'Mockup']]);
    assert.throws(() => addPage(p.id, { entry: '../outside.html' }), /outside the project/);
    assert.throws(() => keepAsServer(p.id, '../../x.html'), /outside the project/);
    fs.writeFileSync(path.join(p.dir, '.quorx', 'launch.json'), JSON.stringify({ configurations: [{ name: 'site', command: 'npm', args: ['start'] }] }));
    assert.throws(() => keepAsServer(p.id, 'mock.html', 'site'), /already exists/);
    assert.equal(keepAsServer(p.id, 'mock.html').name, 'site-mock', 'its own name when "site" is taken');
    assert.ok(removePage(p.id, 'index.html'));
    assert.equal(removePage(p.id, 'index.html'), false);
    assert.deepEqual(listPages(p.id).pages, []);
  } finally { p.done(); }
});

test('preview_site shows the page from the pages server: no launch entry, no static server started, listed under Pages', async () => {
  let b = 0;
  const { events, bodies, dir, id } = await run(() => [
    reply('', [['write_file', { path: 'index.html', content: PAGE }]]),
    reply('', [['preview_site', { title: 'Game' }]]),
    reply('Done.'),
  ][b++]);
  const sv = of(events, 'server');
  assert.equal(sv.length, 1);
  assert.equal(sv[0].page, true);
  assert.equal(sv[0].path, `/ws/${id}/index.html`);
  assert.match(sv[0].url, new RegExp(`^http://localhost:\\d+/ws/${id}/index\\.html$`));
  assert.ok(!fs.existsSync(path.join(dir, '.quorx', 'launch.json')) || !launchOf(dir).configurations.length, 'nothing in the launch file');
  assert.ok(!fs.existsSync(path.join(dir, '.quorx', 'serve.mjs')), 'no static server script for a preview');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'pages.json'), 'utf8'));
  assert.deepEqual(saved.pages.map((x) => [x.entry, x.title, x.from]), [['index.html', 'Game', 'preview']]);
  const out = toolResults(bodies[2]).at(-1);
  assert.match(out, /pages server/);
  assert.match(out, /browser target site:index\.html/);
  assert.match(out, /if this static site is the project itself.*launch_config/, 'it says when to make it a project server');
  assert.equal(of(events, 'artifact').length, 0, 'no artifact for a page');
  // The models are told the difference in the tool list and the rules.
  const tool = bodies[0].tools.find((t) => t.function.name === 'preview_site').function;
  assert.match(tool.description, /never saved to the launch file/);
  assert.ok(!('name' in tool.parameters.properties), 'no launch entry name any more');
  assert.match(bodies[0].messages[0].content, /two kinds of server/i);
});

test('a reply moves the old previews before it reads the launch file, lists the pages, and a site saved on purpose stays a project server', async () => {
  let b = 0;
  const { bodies, dir } = await run(() => [
    reply('', [['launch_config', { action: 'save', name: 'shop', command: 'node', args: ['.quorx/serve.mjs', 'index.html'] }]]),
    reply('Done.'),
  ][b++], { prep: (d) => mixed(d) });
  const sys = bodies[0].messages[0].content;
  assert.match(sys, /Pages in this project .*index\.html \("site"\).*receipts\/index\.html/);
  assert.doesNotMatch(sys, /Saved launch configs[^\n]*serve\.mjs/, 'the old previews are not offered as servers');
  assert.deepEqual(launchOf(dir).configurations.map((c) => c.name), ['web', 'shop']);
  assert.ok(fs.existsSync(path.join(dir, '.quorx', 'serve.mjs')), 'the project server has its static server script');
});

test('/api/pages: the list with the move notice, Undo, Keep as project server; the pages address follows root links', async () => {
  const home = tempDir('qx-pages-home-'), data = path.join(home, 'data'), proj = tempDir('qx-pages-proj-');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([{ id: 'p01', name: 'App', path: proj, created: 1 }]));
  mixed(proj);
  fs.writeFileSync(path.join(proj, 'style.css'), 'body{color:red}');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: home, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_API_KEY_BOT: '', QX_NO_JOBHOST: '1', OH_NO_SCHEDULES: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
      child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', (d) => { out += d; });
      child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
    });
    const key = fs.readFileSync(path.join(data, 'app-key'), 'utf8').trim();
    const call = async (p, body, method) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'x-quorx-key': key }, body: body ? JSON.stringify(body) : undefined })).json();
    assert.equal((await call('/api/pages?project=..%2Fx')).error, 'bad project id');
    const list = await call('/api/pages?project=p01');
    assert.equal(list.notice.count, 2);
    assert.equal(list.pages.length, 2);
    const ov = await call('/api/servers/overview?project=p01');
    assert.deepEqual(ov.servers.map((s) => s.name), ['web'], 'the servers list has only the project server');
    assert.equal(ov.pagesNotice.count, 2);
    assert.equal(ov.pages.length, 2);
    // Undo, then the notice is gone and the entries are back.
    assert.equal((await call('/api/pages', { projectId: 'p01', action: 'undo' })).restored, 2);
    assert.deepEqual(launchOf(proj).configurations.map((c) => c.name), ['site', 'web', 'site-receipts']);
    assert.equal((await call('/api/pages?project=p01')).notice, null);
    // A page added and kept as a project server.
    assert.equal((await call('/api/pages', { projectId: 'p01', action: 'add', entry: 'receipts/index.html', title: 'Receipts' })).url, '/ws/p01/receipts/index.html');
    assert.match((await call('/api/pages', { projectId: 'p01', action: 'keep', entry: 'receipts/index.html', name: 'site' })).error, /already exists/);
    const kept = await call('/api/pages', { projectId: 'p01', action: 'keep', entry: 'receipts/index.html', name: 'receipts' });
    assert.deepEqual(kept.config.args, ['.quorx/serve.mjs', 'receipts/index.html']);
    assert.equal((await call('/api/pages?project=p01')).pages.length, 0);
    assert.equal((await call('/api/pages', { projectId: 'p01', action: 'fly' })).error, 'action must be undo, dismiss, keep or add');
    // The pages address: a page's root link (/style.css) goes to the same file in its own project.
    await new Promise((r) => setTimeout(r, 500));
    const { pagePort } = await call('/api/pages?project=p01');
    assert.ok(pagePort > 0);
    const page = `http://localhost:${pagePort}/ws/p01/index.html`;
    const r = await fetch(`http://127.0.0.1:${pagePort}/style.css`, { headers: { Referer: page }, redirect: 'manual' });
    assert.equal(r.status, 307);
    assert.equal(r.headers.get('location'), '/ws/p01/style.css');
    assert.equal((await fetch(`http://127.0.0.1:${pagePort}/style.css`, { redirect: 'manual' })).status, 404, 'without a page of a project, nothing');
    assert.equal((await fetch(`http://127.0.0.1:${pagePort}/api/config`, { headers: { Referer: page }, redirect: 'manual' })).status, 404, 'never the app\'s own routes');
  } finally { await new Promise((r) => { child.once('exit', r); child.kill(); }); }
});
