// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Search inside chats (server/chatsearch.js): what matches, the snippet around it, the filters, paging, odd characters,
// the saved copy of the texts, and GET /api/search/chats.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.OH_HOME, DIR = path.join(HOME, 'data', 'chats');
const DAY = 864e5, T0 = Date.UTC(2026, 0, 1);
// A chat whose messages alternate you / agent, each `at` a day after the last; replies carry steps with tool output.
const chat = (id, projectId, day, texts, title = `chat ${id}`) => ({
  id, title, projectId, created: T0 + day * DAY, updated: T0 + day * DAY, rev: 'x',
  agent: { setup: {}, artifacts: {}, messages: texts.map((content, k) => (k % 2
    ? { role: 'assistant', content, at: T0 + (day + k) * DAY - 1000, doneAt: T0 + (day + k) * DAY, runId: `r-${id}-${k}`, trace: [{ type: 'tool', name: 'read_file', result: 'tool output: secretneedle in a file the agent read' }] }
    : { role: 'user', content, at: T0 + (day + k) * DAY })) },
});
const write = (c) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, `${c.id}.json`), JSON.stringify(c)); };
const projects = [
  { id: 'pja', name: 'Alpha', path: tempDir('qx-pja-'), created: 1 },
  { id: 'pjb', name: 'Beta', path: tempDir('qx-pjb-'), created: 2, pinned: 5 },
  { id: 'pjc', name: 'Old one', path: tempDir('qx-pjc-'), created: 3, archived: 9 },
];
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'data', 'projects.json'), JSON.stringify(projects));

write(chat('chata01', 'pja', 1, ['How do I fix the login page?', 'We fixed the Login redirect by clearing the cookie.', 'thanks', 'The login works now.']));
write(chat('chata02', 'pja', 5, ['Make a snake game', 'Here is the **snake** game:\n```js\nconst speed = 5;\n```\nIt   speeds up.']));
write(chat('chata03', 'pja', 9, ['Regex a.b*c[0] and C:\\path\\to (x) + 100%?', 'Matched a.b*c[0] literally.']));
write(chat('chata04', 'pja', 12, ['Café crème brûlée', 'ÇA VA: naïve résumé']));
write(chat('chata05', 'pja', 14, ['日本語のテストです', '絵文字 🚀🚀 ok']));
write(chat('chatb01', 'pjb', 2, ['Login form styling', 'Styled the login form.'], 'Login styling'));
write(chat('chatc01', 'pjc', 20, ['login in the archived project', 'ok']));
write(chat('chate01', 'pja', 3, [])); // no messages: never a result
for (let i = 0; i < 12; i++) write(chat(`chatp${String(i).padStart(2, '0')}`, 'pja', 30 + i, [`paging word number ${i}`, `reply ${i} with paging inside`, `again paging ${i}`]));
const long = 'lorem ipsum '.repeat(40) + 'NEEDLE in the middle ' + 'dolor sit '.repeat(40);
write(chat('chatl01', 'pja', 50, [long, 'ok']));
// In the trash: never searched.
fs.mkdirSync(path.join(HOME, 'data', 'trash'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'data', 'trash', 'chatt01-2026.json'), JSON.stringify(chat('chatt01', 'pja', 60, ['login from the trash', 'x'])));

const s = await import('../server/chatsearch.js');
const ids = (r) => r.chats.map((c) => c.id);
const marked = (h) => h.marks.map(([a, b]) => h.snippet.slice(a, b));

test('Your messages and the agent’s replies match in any case; tool output, the trash and empty chats never do', async () => {
  const r = await s.searchChats({ q: 'LOGIN' });
  assert.deepEqual(ids(r).sort(), ['chata01', 'chatb01'], 'the archived project and the trash are left out');
  const a = r.chats.find((c) => c.id === 'chata01');
  assert.equal(a.count, 3);
  assert.equal(a.project, 'Alpha');
  assert.deepEqual(a.hits.map((h) => [h.i, h.role]), [[0, 'user'], [1, 'agent'], [3, 'agent']]);
  assert.equal(a.hits[1].at, T0 + 2 * DAY, 'a reply’s time is when it ended');
  assert.deepEqual(marked(a.hits[1]), ['Login']);
  assert.deepEqual(ids(await s.searchChats({ q: 'secretneedle' })), [], 'steps and tool output are not searched');
  assert.deepEqual(ids(await s.searchChats({ q: 'x' })), [], 'one character is too short');
  assert.deepEqual((await s.searchChats({ q: ' ' })).chats, []);
});

test('Every word must be in the same message, in any order', async () => {
  assert.deepEqual(ids(await s.searchChats({ q: 'cookie login' })), ['chata01']);
  assert.deepEqual(ids(await s.searchChats({ q: 'cookie snake' })), [], 'words in different chats');
  const h = (await s.searchChats({ q: 'redirect login' })).chats[0].hits[0];
  assert.deepEqual(marked(h), ['Login', 'redirect']);
});

test('Snippets: whitespace and markdown marks tidied, a long message cut around the match with …', async () => {
  const h = (await s.searchChats({ q: 'speeds' })).chats[0].hits[0];
  assert.equal(h.snippet, 'Here is the snake game: const speed = 5; It speeds up.');
  const l = (await s.searchChats({ q: 'needle' })).chats[0].hits[0];
  assert.ok(l.snippet.startsWith('…') && l.snippet.endsWith('…'), l.snippet);
  assert.ok(l.snippet.length <= 170);
  assert.deepEqual(marked(l), ['NEEDLE']);
  assert.ok(!/^… ?\S*lore\b/.test(l.snippet) || l.snippet.startsWith('… lorem') || l.snippet.startsWith('…lorem'), 'cut at a space');
});

test('Odd characters match as written: regex symbols, backslashes, accents, other scripts and emoji', async () => {
  assert.deepEqual(ids(await s.searchChats({ q: 'a.b*c[0]' })), ['chata03']);
  assert.deepEqual(ids(await s.searchChats({ q: 'a.bxc' })), [], 'a dot is only a dot');
  assert.deepEqual(ids(await s.searchChats({ q: 'C:\\path\\to' })), ['chata03']);
  assert.deepEqual(ids(await s.searchChats({ q: '(x) 100%?' })), ['chata03']);
  assert.deepEqual(ids(await s.searchChats({ q: 'BRÛLÉE' })), ['chata04'], 'accented letters in any case');
  assert.deepEqual(ids(await s.searchChats({ q: 'ça va' })), ['chata04']);
  assert.deepEqual(ids(await s.searchChats({ q: 'テスト' })), ['chata05']);
  const e = (await s.searchChats({ q: '🚀🚀' })).chats[0].hits[0];
  assert.deepEqual(marked(e), ['🚀🚀']);
  assert.ok(!/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(e.snippet.replace(/…/g, '')), 'never cut inside a character');
});

test('Filters: one project (archived ones too), archived on request, you or the agent, and a date range', async () => {
  assert.deepEqual(ids(await s.searchChats({ q: 'login', project: 'pjb' })), ['chatb01']);
  assert.deepEqual(ids(await s.searchChats({ q: 'login', project: 'pjc' })), ['chatc01'], 'asked for by name, an archived project is searched');
  assert.deepEqual(ids(await s.searchChats({ q: 'login', archived: true })).sort(), ['chata01', 'chatb01', 'chatc01']);
  const you = (await s.searchChats({ q: 'login', role: 'user' })).chats.find((c) => c.id === 'chata01');
  assert.deepEqual(you.hits.map((h) => h.role), ['user']);
  const agent = (await s.searchChats({ q: 'login', role: 'agent', project: 'pja' })).chats[0];
  assert.deepEqual(agent.hits.map((h) => h.i), [1, 3]);
  // chata01's messages are days 1..4: from day 3 leaves the last reply (day 4); to day 2 the first two.
  assert.deepEqual((await s.searchChats({ q: 'login', project: 'pja', from: T0 + 3 * DAY })).chats[0].hits.map((h) => h.i), [3]);
  assert.deepEqual((await s.searchChats({ q: 'login', project: 'pja', to: T0 + 2 * DAY })).chats[0].hits.map((h) => h.i), [0, 1]);
  assert.deepEqual(ids(await s.searchChats({ q: 'login', from: T0 + 100 * DAY })), []);
});

test('Pinned projects come first, then the newest chats; titles match on the first page', async () => {
  const r = await s.searchChats({ q: 'login' });
  assert.deepEqual(ids(r), ['chatb01', 'chata01'], 'Beta is pinned');
  assert.deepEqual(r.titles.map((t) => t.id), ['chatb01']);
  assert.equal(r.titles[0].project, 'Beta');
  assert.deepEqual((await s.searchChats({ q: 'login', offset: 1 })).titles, [], 'titles only on the first page');
});

test('Paging: a page of chats at a time, each with a few matches and how many it has', async () => {
  const p1 = await s.searchChats({ q: 'paging', limit: 5, perChat: 2 });
  assert.equal(p1.chats.length, 5);
  assert.equal(p1.more, true);
  assert.deepEqual(ids(p1), ['chatp11', 'chatp10', 'chatp09', 'chatp08', 'chatp07'], 'newest first');
  assert.equal(p1.chats[0].count, 3);
  assert.equal(p1.chats[0].hits.length, 2);
  const p3 = await s.searchChats({ q: 'paging', limit: 5, offset: 10 });
  assert.deepEqual(ids(p3), ['chatp01', 'chatp00']);
  assert.equal(p3.more, false);
  const all = await s.searchChats({ q: 'paging', limit: 500, perChat: 99 });
  assert.equal(all.limit, 50, 'limits are capped');
  assert.equal(all.chats[0].hits.length, 3);
});

test('A changed chat is read again; a deleted one goes; the texts come back from the saved copy after a restart', async () => {
  const c = chat('chata02', 'pja', 5, ['Make a worm game instead', 'Done: worm game.']);
  c.updated += 1; write(c);
  const { listChats } = await import('../server/store.js');
  const end = Date.now() + 4000;
  while (!(await s.searchChats({ q: 'worm' })).chats.length && Date.now() < end) { listChats(); await new Promise((r) => setTimeout(r, 60)); }
  assert.deepEqual(ids(await s.searchChats({ q: 'worm' })), ['chata02']);
  assert.deepEqual(ids(await s.searchChats({ q: 'speeds' })), []);
  await s.searchWarmed();
  s.flushSearchIndex();
  assert.ok(fs.existsSync(path.join(HOME, 'data', 'index', 'search.json')));
  s.clearSearchCache({ reload: true });
  assert.deepEqual(ids(await s.searchChats({ q: 'worm', budget: 0 })), ['chata02'], 'answered from the saved copy');
  assert.ok(s.searchCacheStats().chats >= 18);
});

test('Out of time while reading files: what it found so far, and the rest from the next offset', async () => {
  await s.searchWarmed();
  s.clearSearchCache();
  const first = await s.searchChats({ q: 'paging', limit: 50, budget: 0 });
  assert.equal(first.partial, true);
  assert.equal(first.more, true);
  let got = ids(first), off = first.chats.length, r = first;
  for (let n = 0; r.more && n < 50; n++) { r = await s.searchChats({ q: 'paging', limit: 50, offset: off, budget: 0 }); got = got.concat(ids(r)); off += r.chats.length; }
  assert.equal(got.length, 12);
  assert.equal(new Set(got).size, 12, 'nothing twice');
});

test('GET /api/search/chats answers searches and turns bad ones away', async () => {
  const home = tempDir('qx-search-'), dir = path.join(home, 'data', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'projects.json'), JSON.stringify([{ id: 'pja', name: 'Alpha', path: tempDir('qx-rpa-'), created: 1 }]));
  for (const c of [chat('chatr01', 'pja', 1, ['Where is the login?', 'In login.js.']), chat('chatr02', 'pja', 2, ['other', 'thing'])]) fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c));
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
    const call = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-quorx-key': key } }); return { status: r.status, body: await r.json() }; };
    const ok = await call('/api/search/chats?q=LOGIN&role=agent&per=5');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.chats.map((c) => [c.id, c.project, c.count, c.hits[0].i, c.hits[0].role]), [['chatr01', 'Alpha', 1, 1, 'agent']]);
    assert.deepEqual(ok.body.chats[0].hits[0].marks, [[3, 8]]);
    assert.equal((await call('/api/search/chats?q=login&project=pja&limit=1')).body.chats.length, 1);
    assert.deepEqual((await call('/api/search/chats?q=l')).body.chats, [], 'too short: nothing');
    assert.equal((await call('/api/search/chats?q=login&project=..')).status, 400);
    assert.equal((await call('/api/search/chats?q=login&role=bot')).status, 400);
    assert.equal((await call(`/api/search/chats?q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await call('/api/search/chats?q=%5B(%2A')).status, 200, 'regex symbols are only text');
  } finally { await new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); }); }
});
