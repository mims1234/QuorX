// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ⚙ Settings → Storage: measuring and clearing through the API on a throwaway QuorX home, the automatic cleanup,
// log rotation, the desktop app's part with stand-in sessions, and the page's own sums. Nothing goes to the real
// Recycle Bin: QX_TRASH=delete makes "to the Recycle Bin" a plain delete here.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

process.env.QX_TRASH = 'delete';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DAY = 864e5;
const stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');
const write = (p, data = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const age = (p, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); return p; };
const BLOB_USED = `${'ab'.repeat(32)}.png`, BLOB_FREE = `${'cd'.repeat(32)}.png`;

// A home with one of everything: trash old and new, pictures used and not, run logs, logs, and a project whose .quorx
// has scratch, agent trash, three undo checkpoints, a snapshot store and an attached document. Scratch is pinned to a
// temp folder, so nothing here ever looks at the real Documents\QuorX\Scratch.
function makeHome() {
  const home = tempDir('qx-storage-home-'), data = path.join(home, 'data'), proj = tempDir('qx-storage-proj-'), scratch = tempDir('qx-storage-scratch-');
  fs.mkdirSync(path.join(data, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([
    { id: 'scratch', name: 'Scratch', path: scratch, created: 1 },
    { id: 'p01', name: 'App', path: proj, created: 1 },
    { id: 'p02', name: 'Gone', path: path.join(proj, 'no-such-folder'), created: 1 },
  ]));
  write(path.join(data, 'chats', 'c1.json'), JSON.stringify({ id: 'c1', title: 't', projectId: 'p01', agent: { messages: [{ role: 'user', content: `see /blob/${BLOB_USED}` }] } }));
  age(write(path.join(data, 'blobs', BLOB_USED), 'used'), 3 * 3600e3);
  age(write(path.join(data, 'blobs', BLOB_FREE), 'free'), 3 * 3600e3);
  write(path.join(data, 'trash', `old-${stamp(Date.now() - 40 * DAY)}.json`), '{}');
  write(path.join(data, 'trash', `new-${stamp(Date.now() - DAY)}.json`), '{}');
  write(path.join(data, 'trash', 'skills', `tidy-${Date.now() - 40 * DAY}`, 'SKILL.md'), '# tidy');
  age(write(path.join(data, 'runs', 'r-old.jsonl'), '{}\n'), 2 * DAY);
  write(path.join(data, 'runs', 'r-new.jsonl'), '{}\n');
  write(path.join(home, 'logs', 'check-shots', 'a.jpg'), 'jpg');
  write(path.join(home, 'logs', 'audit.jsonl'), '{}\n');
  write(path.join(home, 'logs', 'audit.1.jsonl'), '{}\n');
  write(path.join(home, 'logs', 'bench-1.jsonl'), '{}\n');
  const q = path.join(proj, '.quorx');
  write(path.join(q, 'scratch', 'big.bin'), Buffer.alloc(2e6));
  write(path.join(q, 'trash', stamp(Date.now() - 40 * DAY), 'gone.txt'), 'old');
  write(path.join(q, 'trash', stamp(Date.now()), 'kept.txt'), 'new');
  for (const [i, r] of ['r1', 'r2', 'r3'].entries()) age(write(path.join(q, 'checkpoints', r, 'manifest.json'), '{}'), (3 - i) * 3600e3);
  // The folders' own times tie, as they do when a fast machine makes them in the same moment: the manifest decides.
  for (const r of ['r1', 'r2', 'r3']) age(path.join(q, 'checkpoints', r), 0);
  write(path.join(q, 'objects', 'aa', 'bb'), 'obj');
  write(path.join(q, 'snapindex.json'), '{}');
  write(path.join(q, 'uploads', 'doc.pdf'), 'pdf');
  write(path.join(q, 'log.md'), '# notes');
  return { home, data, proj, q, scratch };
}

async function quorx(home) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: home, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_API_KEY_BOT: '', QX_NO_JOBHOST: '1', QX_TRASH: 'delete' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
  });
  const appKey = fs.readFileSync(path.join(home, 'data', 'app-key'), 'utf8').trim();
  const call = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-quorx-key': appKey }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

test('Storage: measures every part, clears QuorX\'s own, and never touches a project folder', async () => {
  const h = makeHome();
  const q = await quorx(h.home);
  try {
    const m = (await q.call('/api/storage?keep=1')).body;
    const by = Object.fromEntries(m.items.map((x) => [x.id, x]));
    assert.equal(by.blobs.files, 1, 'only the picture no chat names');
    assert.equal(by.runs.files, 1, 'only the finished run older than a day');
    assert.equal(by.oldlogs.files, 2, 'the rotated log and the benchmark');
    assert.equal(by.logs.how, null, 'current logs are only shown');
    assert.equal(by.trash.count, 3, 'two chats and one skill');
    assert.equal(by['proj:p01:checkpoints'].count, 2, 'all but the newest one kept');
    assert.ok(by['proj:p01:scratch'].bytes >= 2e6);
    assert.ok(m.items.filter((x) => x.group === 'projects').every((x) => x.how === null), 'project parts are only shown');
    assert.equal(by['proj:p02'].missing, true);
    assert.ok(m.items.every((x) => !x.project || x.project.id !== 'scratch' || x.bytes === 0), 'the pinned scratch folder is empty');

    // A part that grew since it was shown is left, with its new size.
    write(path.join(h.data, 'blobs', `${'ef'.repeat(32)}.png`), Buffer.alloc(3e6));
    age(path.join(h.data, 'blobs', `${'ef'.repeat(32)}.png`), 3 * 3600e3);
    const grew = (await q.call('/api/storage/clear', { items: [{ id: 'blobs', expect: by.blobs.bytes }], keep: 1 })).body.results[0];
    assert.equal(grew.changed, true);
    fs.rmSync(path.join(h.data, 'blobs', `${'ef'.repeat(32)}.png`));

    const ids = ['blobs', 'runs', 'shots', 'oldlogs', 'trash'];
    const r = (await q.call('/api/storage/clear', { items: ids.map((id) => ({ id, expect: by[id].bytes })), keep: 1 })).body;
    for (const x of r.results) assert.ok(!x.error && !x.changed && !x.skipped.length, `${x.id}: ${JSON.stringify(x)}`);
    assert.ok(!fs.existsSync(path.join(h.data, 'blobs', BLOB_FREE)));
    assert.ok(fs.existsSync(path.join(h.data, 'blobs', BLOB_USED)), 'a picture a chat names stays');
    assert.ok(!fs.existsSync(path.join(h.data, 'runs', 'r-old.jsonl')) && fs.existsSync(path.join(h.data, 'runs', 'r-new.jsonl')));
    assert.deepEqual(fs.readdirSync(path.join(h.home, 'logs')).sort(), ['audit.jsonl', 'check-shots', 'storage.jsonl']);
    assert.deepEqual(fs.readdirSync(path.join(h.data, 'trash', 'skills')), []);
    assert.ok(fs.existsSync(path.join(h.data, 'chats', 'c1.json')) && fs.existsSync(path.join(h.data, 'app-key')));

    // Nothing in a project folder can be cleared, by any name.
    const bad = (await q.call('/api/storage/clear', { items: ['logs', 'proj:p01:scratch', 'proj:p01:trash', 'proj:p01:checkpoints', 'proj:p01:objects', 'proj:p01:uploads', 'proj:p02:scratch', '../x'].map((id) => ({ id })) })).body.results;
    assert.ok(bad.every((x) => x.error), JSON.stringify(bad));
    assert.equal((await q.call('/api/storage/downloads')).status, 404, 'Downloads is never looked at');
    for (const keep of ['scratch/big.bin', 'checkpoints/r1', 'checkpoints/r2', 'checkpoints/r3', 'objects/aa/bb', 'snapindex.json', 'uploads/doc.pdf', 'log.md', 'trash']) assert.ok(fs.existsSync(path.join(h.q, keep)), `${keep} stays`);

    const log = (await q.call('/api/storage/log')).body;
    assert.ok(log.length >= ids.length && log.every((x) => !x.auto));

    // Another QuorX on this data folder holding the lease: clearing waits.
    fs.writeFileSync(path.join(h.data, 'storage.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const held = await q.call('/api/storage/clear', { items: [{ id: 'blobs' }] });
    assert.equal(held.status, 409);
    fs.rmSync(path.join(h.data, 'storage.lock'));

    // Rules: kept with the harness, numbers held within their limits.
    assert.equal((await q.call('/api/storage/rules')).body.trashDays, 30);
    const saved = (await q.call('/api/storage/rules', { trashDays: 0, logMaxMB: 5, autoClean: false, junk: 1 })).body;
    assert.equal(saved.trashDays, 1); assert.equal(saved.logMaxMB, 5); assert.equal(saved.autoClean, false); assert.ok(!('junk' in saved));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.data, 'storage.json'), 'utf8')).logMaxMB, 5);
  } finally { await q.stop(); }
});

test('🧹 in a chat header: shows what each part would free, clears only the ticked ones, never your own files', async () => {
  const h = makeHome();
  const q = await quorx(h.home);
  try {
    const pre = (await q.call('/api/agent-space/clear?project=p01&keep=1')).body;
    const by = Object.fromEntries(pre.parts.map((x) => [x.part, x]));
    assert.deepEqual(Object.keys(by).sort(), ['checkpoints', 'objects', 'scratch', 'trash'], 'only these four are offered');
    assert.ok(by.scratch.bytes >= 2e6);
    assert.equal(by.checkpoints.count, 2, 'all but the newest undo');
    assert.equal(pre.busy, false);
    assert.match((await q.call('/api/agent-space/clear', { projectId: 'p01', parts: ['uploads', 'index', '../x'] })).body.error, /nothing picked/);
    const r = (await q.call('/api/agent-space/clear', { projectId: 'p01', parts: ['scratch', 'checkpoints', 'uploads'], keep: 1 })).body;
    assert.deepEqual(r.results.map((x) => x.part), ['scratch', 'checkpoints']);
    assert.ok(r.results.every((x) => !x.skipped.length), JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(h.q, 'scratch', 'big.bin')));
    assert.deepEqual(fs.readdirSync(path.join(h.q, 'checkpoints')), ['r3'], 'the newest undo stays');
    for (const keep of ['trash', 'objects/aa/bb', 'snapindex.json', 'uploads/doc.pdf', 'log.md']) assert.ok(fs.existsSync(path.join(h.q, keep)), `${keep} stays (not ticked, or never offered)`);
    assert.match((await q.call('/api/agent-space/clear', { projectId: 'p02', parts: ['scratch'] })).body.error, /not on this computer/);
    assert.ok((await q.call('/api/storage/log')).body.some((x) => x.id === 'proj:p01:scratch' && !x.auto), 'logged as yours');
  } finally { await q.stop(); }
});

test('Compact chats moves pictures out of chat files', async () => {
  const h = makeHome();
  const png = `data:image/png;base64,${crypto.randomBytes(30000).toString('base64')}`;
  const chat = { id: 'old1', title: 'Pictures', projectId: 'p01', created: 5, updated: 7, rev: 'r-old', agent: { setup: {}, messages: [{ role: 'user', content: 'draw' }], artifacts: [{ id: 'a1', kind: 'image', title: 'one', url: png }, { id: 'a2', kind: 'image', title: 'same again', url: png }] } };
  fs.writeFileSync(path.join(h.data, 'chats', 'old1.json'), JSON.stringify(chat));
  const before = fs.statSync(path.join(h.data, 'chats', 'old1.json')).size;
  const q = await quorx(h.home);
  try {
    const by = Object.fromEntries((await q.call('/api/storage')).body.items.map((x) => [x.id, x]));
    assert.equal(by.compact.files, 2, 'two pictures');
    assert.equal(by.compact.count, 1, 'in one chat');
    assert.ok(by.compact.bytes >= 2 * 40000 && by.compact.saves > 0);
    assert.equal(by.chats.how, null, 'chats themselves are only shown');
    const r = (await q.call('/api/storage/clear', { items: [{ id: 'compact' }] })).body.results[0];
    assert.equal(r.wentTo, 'compacted'); assert.equal(r.files, 1); assert.ok(r.bytes > 30000, `saved ${r.bytes}`);
    const after = JSON.parse(fs.readFileSync(path.join(h.data, 'chats', 'old1.json'), 'utf8'));
    assert.ok(fs.statSync(path.join(h.data, 'chats', 'old1.json')).size < before / 10);
    assert.equal(after.rev, 'r-old'); assert.equal(after.updated, 7);
    const urls = after.agent.artifacts.map((a) => a.url);
    assert.match(urls[0], /^\/blob\/[0-9a-f]{64}\.png$/); assert.equal(urls[0], urls[1], 'the same picture is stored once');
    const blob = fs.readFileSync(path.join(h.data, 'blobs', urls[0].slice(6)));
    assert.equal(`data:image/png;base64,${blob.toString('base64')}`, png, 'the picture is exactly the one it was');
    assert.equal((await q.call('/api/storage')).body.items.find((x) => x.id === 'compact').how, null, 'nothing left to compact');
  } finally { await q.stop(); }
});

test('Automatic cleanup: QuorX\'s trash past its days goes; newer trash and every project folder stay', async () => {
  const h = makeHome();
  // In this process: OH_HOME is the throwaway home test-home.mjs made, so the fixtures go there.
  const home = process.env.OH_HOME;
  fs.cpSync(h.home, home, { recursive: true });
  const { runRetention, trashedAt } = await import('../server/storage.js');
  const r = await runRetention({ autoClean: true, trashDays: 30, shotKeep: 0, logMaxMB: 50 });
  assert.equal(r.trashed, 2, 'the old chat and the old skill');
  assert.deepEqual(fs.readdirSync(path.join(home, 'data', 'trash')).filter((n) => n.endsWith('.json')).map((n) => n.split('-')[0]), ['new']);
  assert.equal(fs.readdirSync(path.join(h.q, 'trash')).length, 2, 'a project\'s agent trash is never touched, however old');
  assert.ok(fs.existsSync(path.join(h.q, 'scratch', 'big.bin')), 'scratch is never cleared by itself');
  assert.equal(fs.readdirSync(path.join(home, 'logs', 'check-shots')).length, 0, 'screenshots past the number kept');
  assert.ok(!fs.existsSync(path.join(home, 'data', 'storage.lock')), 'the lease is given back');
  assert.equal(trashedAt('x-2026-10-18T17-12-43-761Z.json'), Date.parse('2026-10-18T17:12:43.761Z'));
  assert.equal(trashedAt(`tidy-${1760000000000}`), 1760000000000);
});

test('Logs start afresh past the limit, keeping one older part', async () => {
  const { rotateLog } = await import('../server/storagerules.js');
  const dir = tempDir('qx-rotate-'), f = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(f, 'x'.repeat(200));
  assert.equal(rotateLog(f, 100), true);
  assert.ok(!fs.existsSync(f) && fs.readFileSync(path.join(dir, 'decisions.1.jsonl'), 'utf8').length === 200);
  fs.writeFileSync(f, 'y'.repeat(200));
  assert.equal(rotateLog(f, 100), false, 'checked at most every 30 s per file');
});

test('Desktop: caches through the sessions, the old folder to the trash, only installed update downloads', async () => {
  const { createStorage, cleanAtStart, versionIn } = require('../desktop/storage.js');
  const base = tempDir('qx-desk-'), ud = path.join(base, 'QuorX'), legacy = path.join(base, 'OpenHarness'), upd = path.join(base, 'updater');
  write(path.join(ud, 'config.json'), '{}');
  write(path.join(ud, 'Cache', 'data_1'), Buffer.alloc(5000));
  write(path.join(ud, 'GPUCache', 'g'), Buffer.alloc(100));
  write(path.join(ud, 'Partitions', 'agent', 'Service Worker', 'sw'), Buffer.alloc(3000));
  write(path.join(ud, 'Partitions', 'browse', 'Cache', 'c'), Buffer.alloc(1000));
  write(path.join(ud, 'Partitions', 'browse', 'Cookies'), 'signed in');
  write(path.join(legacy, 'Cache', 'old'), Buffer.alloc(4000));
  write(path.join(upd, 'pending', 'QuorX-Setup-0.2.10.exe'), Buffer.alloc(700));
  write(path.join(upd, 'pending', 'QuorX-Setup-0.2.12.exe'), Buffer.alloc(900));
  write(path.join(upd, 'pending', 'update-info.json'), '{}');
  const calls = [];
  const fake = (name, dir) => ({
    clearCache: async () => { calls.push(`${name}.cache`); fs.rmSync(path.join(dir, 'Cache'), { recursive: true, force: true }); },
    clearCodeCaches: async () => { calls.push(`${name}.code`); },
    clearStorageData: async (o) => { calls.push(`${name}.data:${o.storages.join(',')}`); fs.rmSync(path.join(dir, 'Service Worker'), { recursive: true, force: true }); },
  });
  let cfg = {};
  const st = createStorage({ userData: ud, appData: base, localAppData: base, resourcesPath: base, version: '0.2.11', ownUserData: true, updaterDir: upd,
    sessions: { app: fake('app', ud), agent: fake('agent', path.join(ud, 'Partitions', 'agent')), tabs: fake('tabs', path.join(ud, 'Partitions', 'browse')) },
    trashItem: async (p) => { calls.push('trash'); fs.rmSync(p, { recursive: true, force: true }); }, readConfig: () => cfg, writeConfig: (c) => { cfg = c; } });
  const items = await st.measure();
  const by = Object.fromEntries(items.map((x) => [x.id, x]));
  assert.equal(by['desk:updates'].files, 1, 'the installed 0.2.10 only; 0.2.12 waits to install');
  assert.equal(by['desk:tabs'].offInBulk, true);
  assert.equal(by['desk:legacy'].how, 'recycle');
  const r = (await st.clear(items.map((x) => ({ id: x.id, expect: x.bytes })))).results;
  assert.ok(r.every((x) => !x.error), JSON.stringify(r));
  assert.ok(calls.includes('agent.data:serviceworkers,cachestorage,shadercache') && calls.includes('trash'));
  assert.ok(fs.existsSync(path.join(ud, 'Partitions', 'browse', 'Cookies')), 'your sign-ins stay');
  assert.ok(!fs.existsSync(legacy));
  assert.deepEqual(fs.readdirSync(path.join(upd, 'pending')).sort(), ['QuorX-Setup-0.2.12.exe', 'update-info.json']);
  assert.equal(cfg.clearGpuAtStart, true, 'GPU caches go at the next start');
  assert.equal(cleanAtStart(ud, cfg), true);
  assert.ok(!fs.existsSync(path.join(ud, 'GPUCache')));
  assert.deepEqual(versionIn('QuorX-Setup-1.20.3.exe'), [1, 20, 3]);
  // A copy on its own settings folder (OH_USER_DATA) never offers the old folder.
  write(path.join(legacy, 'x'), 'x');
  const other = createStorage({ userData: ud, appData: base, localAppData: base, resourcesPath: base, version: '0.2.11', ownUserData: false, updaterDir: upd, sessions: {}, readConfig: () => ({}), writeConfig: () => {} });
  assert.ok(!(await other.measure()).some((x) => x.id === 'desk:legacy'));
});

test('The page: what "Clear safe caches" offers and what the summary says', async () => {
  const { safeParts, summary, fmtBytes } = await import('../public/storage.js');
  const parts = safeParts([
    { id: 'blobs', safe: true, how: 'delete', bytes: 10 }, { id: 'desk:tabs', safe: true, how: 'delete', bytes: 5, offInBulk: true },
    { id: 'trash', safe: false, how: 'recycle', bytes: 9 }, { id: 'runs', safe: true, how: 'delete', bytes: 0 }, { id: 'x', safe: true, how: 'delete', bytes: 3, busy: true },
  ]);
  assert.deepEqual(parts.map((p) => [p.id, p.on]), [['blobs', true], ['desk:tabs', false]]);
  assert.equal(fmtBytes(1.5e9), '1.5 GB');
  const s = summary([{ id: 'a', bytes: 3e6, wentTo: 'recycle', skipped: [{}] }, { id: 'b', bytes: 2e6, wentTo: 'deleted', skipped: [] }, { id: 'c', changed: true, bytes: 9e9 }]);
  assert.match(s, /^Freed 5\.0 MB \(3\.0 MB of it moved to the Recycle Bin\)\. 1 item was in use/);
});
