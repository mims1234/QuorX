// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Source control pane (server/gitview.js): a folder's branch, ahead/behind and changed files; its history with
// parents (for the graph), branch/tag/remote labels and search; one commit's files; one file's diff in a commit,
// staged, not staged or new; and the /api/git route on a chat's folder. Everything runs on temp repositories.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.OH_HOME;
// Hooks off (-c core.hooksPath): a hooks folder set in your own git config would run on every commit and checkout.
const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'core.hooksPath=' + NO_HOOKS, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-10T10:00:00', GIT_COMMITTER_DATE: '2026-11-10T10:00:00' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

const NO_HOOKS = tempDir('qx-gv-hooks-');
const G = await import('../server/gitview.js');

// main: First commit (tag v0.1) → Add sound → merge of side (Side work) → Rename sounds; origin/main one behind HEAD.
function demoRepo() {
  const r = tempDir('qx-gv-');
  git(r, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ann@example.com'], ['user.name', 'Ann'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(r, 'config', k, v);
  write(r, 'game.js', 'let speed = 4;\nmove(speed);\n'); write(r, 'README.md', '# Game\n');
  git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'First commit'); git(r, 'tag', 'v0.1');
  git(r, 'checkout', '-q', '-b', 'side'); write(r, 'README.md', '# Game\nLevels.\n'); git(r, 'commit', '-q', '-am', 'Side work');
  git(r, 'checkout', '-q', 'main'); write(r, 'sounds.js', 'export const play = 1;\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'Add sound', '-m', 'Beeps when eating.');
  git(r, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  git(r, 'mv', 'sounds.js', 'audio.js'); git(r, 'commit', '-q', '-m', 'Rename sounds');
  git(r, 'remote', 'add', 'origin', 'https://github.com/o/game.git');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  git(r, 'config', 'branch.main.remote', 'origin'); git(r, 'config', 'branch.main.merge', 'refs/heads/main');
  return r;
}

test('gitview: status reads the branch, ahead/behind and staged, not staged and new files with line counts', async () => {
  const r = demoRepo();
  write(r, 'game.js', 'let speed = 5;\nmove(speed);\n'); git(r, 'add', 'game.js');
  write(r, 'README.md', '# Game\nLevels.\nPause with P.\n');
  write(r, 'notes dir/to do.txt', 'scores\n');
  const st = await G.gitStatus(r);
  assert.equal(st.git, true); assert.equal(st.branch, 'main'); assert.equal(st.upstream, 'origin/main');
  assert.equal(st.ahead, 1); assert.equal(st.behind, 0); assert.equal(st.empty, false);
  assert.deepEqual(st.staged, [{ path: 'game.js', status: 'modified', added: 1, removed: 1 }]);
  assert.deepEqual(st.unstaged, [{ path: 'README.md', status: 'modified', added: 1, removed: 0 }]);
  assert.deepEqual(st.untracked, [{ path: 'notes dir/to do.txt', status: 'new' }], 'a path with spaces stays whole');
  const plain = tempDir('qx-gv-plain-');
  const no = await G.gitStatus(plain);
  assert.equal(no.git, false); assert.match(no.why, /not a git repository/);
  const empty = tempDir('qx-gv-empty-'); git(empty, 'init', '-q', '-b', 'main');
  const e = await G.gitStatus(empty);
  assert.equal(e.git, true); assert.equal(e.empty, true); assert.equal(e.branch, 'main');
  assert.deepEqual((await G.gitLog(empty)).commits, [], 'no commits yet is not an error');
});

test('gitview: history has parents for the graph, labels for branches, tags, remotes and HEAD, paging and search', async () => {
  const r = demoRepo();
  const all = await G.gitLog(r, { scope: 'all' });
  assert.deepEqual(all.commits.map((c) => c.subject).sort(), ['Add sound', 'First commit', "Merge branch 'side'", 'Rename sounds', 'Side work']);
  assert.equal(all.commits[0].subject, 'Rename sounds', 'newest first');
  const by = Object.fromEntries(all.commits.map((c) => [c.subject, c]));
  assert.deepEqual(by['Rename sounds'].refs, [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }]);
  assert.deepEqual(by['Merge branch \'side\''].refs, [{ name: 'origin/main', kind: 'remote' }]);
  assert.deepEqual(by['Side work'].refs, [{ name: 'side', kind: 'branch' }]);
  assert.deepEqual(by['First commit'].refs, [{ name: 'v0.1', kind: 'tag' }]);
  assert.equal(by['Merge branch \'side\''].parents.length, 2); assert.equal(by['First commit'].parents.length, 0);
  assert.equal(by['Add sound'].author, 'Ann'); assert.ok(by['Add sound'].at > 0);
  const page = await G.gitLog(r, { limit: 2 });
  assert.equal(page.commits.length, 2); assert.equal(page.more, true);
  const rest = await G.gitLog(r, { limit: 2, skip: 4 });
  assert.equal(rest.commits.length, 1); assert.equal(rest.more, false);
  // Search: message, author, hash and label, every word must match.
  assert.deepEqual((await G.gitLog(r, { q: 'side' })).commits.map((c) => c.subject).sort(), ['Merge branch \'side\'', 'Side work']);
  assert.deepEqual((await G.gitLog(r, { q: 'ann sound' })).commits.map((c) => c.subject).sort(), ['Add sound', 'Rename sounds']);
  assert.deepEqual((await G.gitLog(r, { q: by['Add sound'].sha.slice(0, 8) })).commits.map((c) => c.subject), ['Add sound']);
  assert.deepEqual((await G.gitLog(r, { q: 'v0.1' })).commits.map((c) => c.subject), ['First commit']);
});

test('gitview: a commit lists its files (renames too) and each file\'s diff reads as hunks', async () => {
  const r = demoRepo();
  const log = (await G.gitLog(r)).commits, sha = (s) => log.find((c) => c.subject === s).sha;
  const ren = await G.gitCommit(r, sha('Rename sounds'));
  assert.deepEqual(ren.files, [{ path: 'audio.js', orig: 'sounds.js', status: 'renamed', added: 0, removed: 0 }]);
  const add = await G.gitCommit(r, sha('Add sound'));
  assert.equal(add.message, 'Add sound\n\nBeeps when eating.'); assert.equal(add.merge, false);
  assert.deepEqual(add.files, [{ path: 'sounds.js', status: 'added', added: 1, removed: 0 }]);
  const merge = await G.gitCommit(r, sha('Merge branch \'side\''));
  assert.equal(merge.merge, true); assert.deepEqual(merge.files.map((f) => f.path), ['README.md'], 'against its first parent');
  const first = await G.gitCommit(r, sha('First commit'));
  assert.deepEqual(first.files.map((f) => f.path).sort(), ['README.md', 'game.js'], 'the first commit against nothing');
  assert.deepEqual(first.refs, [{ name: 'v0.1', kind: 'tag' }]);
  const d = await G.gitDiff(r, { where: 'commit', sha: sha('Side work'), path: 'README.md' });
  assert.deepEqual(d.hunks[0].lines, [[' ', 1, 1, '# Game'], ['+', null, 2, 'Levels.']]);
  const fd = await G.gitDiff(r, { where: 'commit', sha: sha('First commit'), path: 'game.js' });
  assert.deepEqual(fd.hunks[0].lines.map((l) => l[0]), ['+', '+']);
  assert.match((await G.gitCommit(r, 'zz')).error, /bad commit id/);
  assert.match((await G.gitDiff(r, { where: 'commit', sha: '--output=x', path: 'a' })).error, /bad commit id/, 'nothing that looks like an option reaches git');
});

test('gitview: staged, not staged and new files diff; binary files say so; a long diff stops', async () => {
  const r = demoRepo();
  write(r, 'game.js', 'let speed = 5;\nmove(speed);\n'); git(r, 'add', 'game.js');
  write(r, 'game.js', 'let speed = 6;\nmove(speed);\n');
  write(r, 'new.txt', 'one\ntwo\n');
  fs.writeFileSync(path.join(r, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255])); git(r, 'add', 'pic.bin');
  const s = await G.gitDiff(r, { where: 'staged', path: 'game.js' });
  assert.deepEqual(s.hunks[0].lines.slice(0, 2), [['-', 1, null, 'let speed = 4;'], ['+', null, 1, 'let speed = 5;']]);
  const u = await G.gitDiff(r, { where: 'unstaged', path: 'game.js' });
  assert.deepEqual(u.hunks[0].lines.slice(0, 2), [['-', 1, null, 'let speed = 5;'], ['+', null, 1, 'let speed = 6;']]);
  const n = await G.gitDiff(r, { where: 'new', path: 'new.txt' });
  assert.deepEqual(n.hunks[0].lines, [['+', null, 1, 'one'], ['+', null, 2, 'two']]);
  assert.equal((await G.gitDiff(r, { where: 'staged', path: 'pic.bin' })).binary, true);
  assert.match((await G.gitDiff(r, { where: 'elsewhere', path: 'a' })).error, /bad diff kind/);
  const long = G.parseUnified(`@@ -1,0 +1,3000 @@\n${Array.from({ length: 3000 }, (_, i) => `+${i}`).join('\n')}\n`);
  assert.equal(long.cut, true); assert.equal(long.hunks[0].lines.length, 1500);
});

test('gitview: /api/git reads the chat\'s worktree, else the project folder; projects say which are git folders', async () => {
  const repo = demoRepo();
  const plain = tempDir('qx-gv-p-');
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'projects.json'), JSON.stringify([{ id: 'scratch', name: 'Scratch', path: tempDir('qx-gv-s-'), created: 1 }, { id: 'p01', name: 'Game', path: repo, created: 1 }, { id: 'p02', name: 'Plain', path: plain, created: 1 }]));
  fs.writeFileSync(path.join(HOME, 'data', 'schedules-project-made'), '');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: HOME, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', QX_NO_JOBHOST: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const key = fs.readFileSync(path.join(HOME, 'data', 'app-key'), 'utf8').trim();
  const call = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-quorx-key': key }, body: body ? JSON.stringify(body) : undefined })).json();
  try {
    const projects = await call('/api/projects');
    assert.equal(projects.find((p) => p.id === 'p01').git, true); assert.equal(projects.find((p) => p.id === 'p02').git, undefined);
    const st = await call('/api/git?project=p01&what=status');
    assert.equal(st.branch, 'main'); assert.equal(st.ahead, 1);
    const w = await call('/api/worktrees', { projectId: 'p01', chatId: 'cmenu1', title: 'menu' });
    assert.equal(w.branch, 'qx/menu', w.error);
    write(w.path, 'menu.js', 'export const menu = [];\n');
    const wst = await call('/api/git?project=p01&chat=cmenu1&what=status');
    assert.equal(wst.branch, 'qx/menu'); assert.deepEqual(wst.untracked.map((f) => f.path), ['menu.js'], 'the chat\'s own worktree');
    assert.deepEqual((await call('/api/git?project=p01&chat=cother1&what=status')).untracked, [], 'another chat: the project folder');
    const log = await call('/api/git?project=p01&what=log&scope=all');
    assert.ok(log.commits.some((c) => c.refs.some((x) => x.name === 'qx/menu')), 'all branches include the worktree\'s');
    const c = await call(`/api/git?project=p01&what=commit&sha=${log.commits[0].sha}`);
    assert.ok(c.files.length);
    const d = await call(`/api/git?project=p01&chat=cmenu1&what=diff&where=new&path=menu.js`);
    assert.deepEqual(d.hunks[0].lines, [['+', null, 1, 'export const menu = [];']]);
    assert.equal((await call('/api/git?project=p02&what=status')).git, false);
    assert.match((await call('/api/git?project=nope&what=status')).error, /unknown project/);
  } finally { await new Promise((r) => { child.once('exit', r); child.kill(); }); }
});
