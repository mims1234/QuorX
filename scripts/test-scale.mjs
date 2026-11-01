// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The chat index (server/store.js): the sidebar's chats per project, pages and search, and an index that follows
// chats written here and by anyone else on the same data folder, and comes back after a restart.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(process.env.OH_HOME, 'data', 'chats');
const chat = (id, projectId, at, title = `chat ${id}`) => ({ id, title, projectId, created: at, updated: at, rev: 'x', agent: { setup: {}, messages: [{ role: 'user', content: 'hi', at }, { role: 'assistant', content: `about ${title}`, at: at + 1, runId: `r-${id}`, stats: { cost: 0.01 } }], artifacts: {} } });
const write = (c) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `${c.id}.json`), JSON.stringify(c)); };
const wait = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };

for (let i = 0; i < 5; i++) write(chat(`chata${i}0`, 'pja', 1000 + i));
for (let i = 0; i < 3; i++) write(chat(`chatb${i}0`, 'pjb', 2000 + i));
const store = await import('../server/store.js');

test('The sidebar gets each project’s newest chats, the open ones, and every project’s counts', () => {
  const r = store.sidebarChats({ per: 2, ids: ['chata00'] });
  const ids = r.chats.map((c) => c.id);
  assert.deepEqual(ids.filter((id) => id.startsWith('chata')).sort(), ['chata00', 'chata30', 'chata40'], 'the two newest, and the open one');
  assert.equal(ids.filter((id) => id.startsWith('chatb')).length, 2);
  assert.deepEqual([r.stats.pja.chats, r.stats.pjb.chats], [5, 3]);
  assert.ok(Math.abs(r.stats.pja.cost - 0.05) < 1e-9);
  assert.equal(r.total, 8);
});

test('Pages and search go past what the sidebar shows', () => {
  const p = store.chatPage({ project: 'pja', offset: 2, limit: 2 });
  assert.equal(p.total, 5);
  assert.deepEqual(p.chats.map((c) => c.id), ['chata20', 'chata10']);
  assert.deepEqual(store.chatPage({ q: 'chatb1' }).chats.map((c) => c.id), ['chatb10']);
});

test('The index follows chats saved here at once, and changes from outside through the watcher', async () => {
  store.saveChat('chatnew0', chat('chatnew0', 'pjb', 3000, 'saved here'));
  assert.ok(store.listChats().some((c) => c.id === 'chatnew0'), 'saved here: at once');
  assert.equal(store.projectChatsSpend('pjb').runIds.has('r-chatnew0'), true, 'its cost counts toward the project');
  write(chat('chatout0', 'pja', 4000, 'written outside'));
  assert.ok(await wait(() => store.listChats().some((c) => c.id === 'chatout0')), 'written by another QuorX: seen');
  fs.rmSync(path.join(DIR, 'chatout0.json'));
  assert.ok(await wait(() => !store.listChats().some((c) => c.id === 'chatout0')), 'removed outside: gone');
  store.trashChat('chatnew0');
  assert.ok(!store.listChats().some((c) => c.id === 'chatnew0'), 'deleted here: gone at once');
});

test('The saved index is used after a restart, and catches what changed meanwhile within seconds', () => {
  store.flushChatIndex();
  const index = path.join(process.env.OH_HOME, 'data', 'index', 'chats.json');
  assert.ok(fs.existsSync(index));
  // Meanwhile (QuorX closed): one chat changes on disk. A fresh process loads the index and reads only that one.
  write(chat('chata00', 'pja', 9000, 'renamed meanwhile'));
  const code = `const s = await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)}); s.listChats(); let t = ''; for (let i = 0; i < 60 && t !== 'renamed meanwhile'; i++) { await new Promise((r) => setTimeout(r, 100)); t = s.listChats().find((c) => c.id === 'chata00')?.title; } console.log(JSON.stringify(t)); process.exit(0);`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(out.stdout.trim().split('\n').pop(), '"renamed meanwhile"', out.stderr);
});

test('The Files pane reads one folder at a time: folders first, pages, and the same rules as before', async () => {
  const { listDir, listFiles } = await import('../server/workspace.js');
  const root = fs.mkdtempSync(path.join(process.env.OH_HOME, 'proj-'));
  for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(root, `file${i}.txt`), 'x'.repeat(i));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true }); fs.writeFileSync(path.join(root, 'src', 'deep', 'a.js'), 'a');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.quorx', 'scratch'), { recursive: true }); fs.writeFileSync(path.join(root, '.quorx', 'log.md'), 'notes');
  const top = await listDir(root, '', { limit: 5 });
  assert.equal(top.total, 15);
  assert.deepEqual(top.entries.map((e) => e.name), ['node_modules', 'src', '.quorx', 'file1.txt', 'file2.txt'], 'folders first, .quorx after the project’s own, numbers in order');
  assert.equal(top.entries[0].skipped, 'skipped');
  assert.equal(top.entries[1].count, 1);
  assert.deepEqual((await listDir(root, '', { offset: 13, limit: 5 })).entries.map((e) => e.name), ['file11.txt', 'file12.txt']);
  assert.deepEqual((await listDir(root, '.quorx')).entries.map((e) => e.name), ['scratch'], 'only what the agent works with');
  await assert.rejects(listDir(root, '../..'), /outside/);
  assert.deepEqual(listFiles(root, 50, { match: (p) => p.includes('deep') }).map((f) => f.path), ['src/deep/a.js'], 'search finds by path');
});

test('What deleting a chat frees comes from the index: pictures other chats use are not counted', async () => {
  const { chatFootprint } = await import('../server/blobs.js');
  const blobs = path.join(process.env.OH_HOME, 'data', 'blobs'); fs.mkdirSync(blobs, { recursive: true });
  const A = `${'a1'.repeat(32)}.png`, B = `${'b2'.repeat(32)}.png`;
  fs.writeFileSync(path.join(blobs, A), Buffer.alloc(1000)); fs.writeFileSync(path.join(blobs, B), Buffer.alloc(2000));
  const withPics = (id, names) => { const c = chat(id, 'pja', 5000); c.agent.artifacts = Object.fromEntries(names.map((n, i) => [`a${i}`, { id: `a${i}`, kind: 'image', url: `/blob/${n}` }])); return c; };
  store.saveChat('chatpic1', withPics('chatpic1', [A, B]));
  store.saveChat('chatpic2', withPics('chatpic2', [A]));
  const f = await chatFootprint(store.chatPictureRefs('chatpic1'), store.pictureRefCounts());
  assert.equal(f.count, 1); assert.equal(f.pictures, 2000, 'only B: A is also in chatpic2');
  assert.ok(f.chat > 0);
  assert.equal(await chatFootprint(store.chatPictureRefs('nochat0'), store.pictureRefCounts()), null);
});

test('Older replies keep their steps in files of their own; the chat stays small and nothing is lost', async () => {
  const steps = (n, tag) => Array.from({ length: n }, (_, i) => ({ t: i % 2 ? 'tool' : 'llm_done', at: i, note: `${tag}-${i}` }));
  const PIC = `${'c3'.repeat(32)}.png`;
  const c = chat('chatlong0', 'pja', 6000, 'long chat');
  c.agent.messages = [];
  for (let r = 0; r < 8; r++) c.agent.messages.push({ role: 'user', content: `ask ${r}`, at: r }, { role: 'assistant', content: `reply ${r}`, at: r, runId: `run-long-${r}`, stats: { cost: 0.01 }, trace: r === 0 ? [...steps(60, 'r0'), { t: 'screenshot', url: `/blob/${PIC}` }] : steps(r === 7 ? 10 : 60, `r${r}`) });
  store.saveChat('chatlong0', c);
  const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'chatlong0.json'), 'utf8')).agent.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(onDisk.map((m) => m.trace.length), [0, 0, 0, 60, 60, 60, 60, 10], 'the newest 5 stay; the 3 older go apart');
  assert.deepEqual(onDisk[0].traceRef.n, 61);
  assert.equal(store.getTrace('chatlong0', 'run-long-0').at(-1).url, `/blob/${PIC}`);
  // The page saves the note back (and a whole save with the steps back in splits them again): nothing changes.
  store.saveChat('chatlong0', JSON.parse(fs.readFileSync(path.join(DIR, 'chatlong0.json'), 'utf8')));
  assert.equal(store.getTrace('chatlong0', 'run-long-1').length, 60);
  assert.equal(store.getWholeChat('chatlong0').agent.messages[1].trace.length, 61, 'a backup gets the whole chat');
  // A picture only an older reply's steps show is not swept as unused.
  const { unusedBlobs } = await import('../server/blobs.js');
  const blobs = path.join(process.env.OH_HOME, 'data', 'blobs'); fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, PIC), 'png'); fs.utimesSync(path.join(blobs, PIC), new Date(0), new Date(0));
  assert.ok(!(await unusedBlobs(0)).some((b) => b.name === PIC), 'kept: an older reply shows it');
  // Deleting the chat takes its steps to the trash with it.
  store.trashChat('chatlong0');
  assert.equal(store.getTrace('chatlong0', 'run-long-0'), null);
  assert.ok(fs.readdirSync(path.join(process.env.OH_HOME, 'data', 'trash', 'traces')).some((n) => n.startsWith('chatlong0-')));
  assert.ok(!(await unusedBlobs(0)).some((b) => b.name === PIC), 'still kept while the chat is in the trash');
});

// A chat with its own rules, tools, apps and folders, as the Permissions window lists them.
const allowing = (id, projectId, at) => { const c = chat(id, projectId, at, `allows ${id}`); Object.assign(c.agent, { cmdRules: [{ id: 'r1', match: 'git *', effect: 'allow' }], allowed: ['web_search'], allowedMeta: { web_search: { at } }, apps: ['notepad'], folders: ['D:/work'] }); return c; };
const permsWant = (c) => ({ id: c.id, title: c.title, projectId: c.projectId, cmdRules: c.agent.cmdRules, allowed: c.agent.allowed, allowedMeta: c.agent.allowedMeta, apps: c.agent.apps, folders: c.agent.folders });

test('What each chat allows comes from the index: unchanged chat files are not read again', async () => {
  store.saveChat('chatperm1', allowing('chatperm1', 'pja', 7000));
  write(allowing('chatperm2', 'pjb', 7001));
  assert.ok(await wait(() => store.listChats().some((c) => c.id === 'chatperm2')), 'written outside: seen');
  const read = fs.readFileSync; let reads = 0;
  fs.readFileSync = (p, ...a) => { if (String(p).startsWith(DIR)) reads++; return read(p, ...a); };
  try {
    const all = store.listChats().map((c) => [c.id, store.chatPerms(c.id)]).filter(([, p]) => p);
    assert.deepEqual(all.map(([id]) => id).sort(), ['chatperm1', 'chatperm2']);
    assert.deepEqual(store.chatPerms('chatperm2'), { cmdRules: [{ id: 'r1', match: 'git *', effect: 'allow' }], allowed: ['web_search'], allowedMeta: { web_search: { at: 7001 } }, apps: ['notepad'], folders: ['D:/work'] });
    assert.equal(reads, 0, 'no chat file read');
  } finally { fs.readFileSync = read; }
  // Changed (here, or outside): the new lists at once, or once the watcher sees it.
  const c = allowing('chatperm1', 'pja', 7002); c.agent.apps = []; c.agent.folders = [];
  store.saveChat('chatperm1', c);
  assert.deepEqual(store.chatPerms('chatperm1').apps, []);
  const d = allowing('chatperm2', 'pjb', 7003); d.agent.cmdRules = []; d.agent.allowed = []; d.agent.apps = []; d.agent.folders = [];
  write(d);
  assert.ok(await wait(() => store.chatPerms('chatperm2') === null), 'allows nothing now');
});

test('GET /api/permissions/chats: the same lists as the chat files, from an older index too, and bad requests get 400', async () => {
  const home = tempDir('qx-perms-'), dir = path.join(home, 'data', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const chats = [allowing('chatpa1', 'pja', 100), allowing('chatpb1', 'pjb', 200), chat('chatpa2', 'pja', 300)];
  for (const c of chats) fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c));
  // An index saved before it kept each chat's lists: they are read once from the files.
  const entries = Object.fromEntries(chats.map((c) => { const st = fs.statSync(path.join(dir, `${c.id}.json`)); return [`${c.id}.json`, { key: `${st.size}:${st.mtimeMs}`, s: { id: c.id, title: c.title, projectId: c.projectId, messages: 1, lastAt: c.updated }, blobs: [] }]; }));
  fs.mkdirSync(path.join(home, 'data', 'index'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'index', 'chats.json'), JSON.stringify({ v: 4, at: Date.now(), entries }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: home, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_API_KEY_BOT: '', QX_NO_JOBHOST: '1', QX_TRASH: 'delete' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    let out = '';
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
      child.stdout.on('data', (b) => { out += b; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', (b) => { out += b; });
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`QuorX exited (${code}):\n${out}`)); });
    });
    const key = fs.readFileSync(path.join(home, 'data', 'app-key'), 'utf8').trim();
    const call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-quorx-key': key }, body }); return { status: r.status, body: await r.json() }; };
    const all = await call('/api/permissions/chats');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.chats.sort((a, b) => a.id.localeCompare(b.id)), [permsWant(chats[0]), permsWant(chats[1])]);
    assert.deepEqual((await call('/api/permissions/chats?project=pja')).body, { chats: [permsWant(chats[0])] });
    assert.equal((await call('/api/permissions/chats?project=..')).status, 400);
    assert.equal((await call('/api/running/control', 'POST', '')).status, 400, 'an empty body');
    assert.equal((await call('/api/running/control', 'POST', '{"op":"nope"}')).status, 400);
    assert.equal((await call('/api/quoriums/%E0%A4%A', 'DELETE')).status, 400, 'a malformed id');
    assert.equal((await call('/api/quoriums/none', 'DELETE')).status, 200);
  } finally { await new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); }); }
});
