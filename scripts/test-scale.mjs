// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The chat index (server/store.js): the sidebar's chats per project, pages and search, and an index that follows
// chats written here and by anyone else on the same data folder, and comes back after a restart.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
