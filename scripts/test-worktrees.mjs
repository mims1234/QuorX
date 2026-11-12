// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A chat's own git worktree (server/worktrees.js): making one, a command and undo inside it, a server on a port of its
// own next to the project folder's, refusing to remove a tree with changes, and the stale list for ⚙ Storage. All on
// a throwaway git repo and a throwaway QuorX home.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.OH_HOME;
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const gitOk = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).status === 0;

// A repo with one commit and a tiny server that listens on the port it is given.
function makeRepo() {
  const dir = tempDir('qx-wt-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  fs.writeFileSync(path.join(dir, 'srv.js'), "require('http').createServer((q, s) => s.end(process.cwd())).listen(Number(process.argv[2] || process.env.PORT), '127.0.0.1');\n");
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
function setProjects(list) {
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'projects.json'), JSON.stringify([{ id: 'scratch', name: 'Scratch', path: tempDir('qx-wt-scratch-'), created: 1 }, ...list]));
}
const freePortNow = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const repo = makeRepo(), plain = tempDir('qx-wt-plain-');
setProjects([{ id: 'p01', name: 'Game', path: repo, created: 1 }, { id: 'p02', name: 'Notes', path: plain, created: 1 }]);
const W = await import('../server/worktrees.js');
const WS = await import('../server/workspace.js');
const { knownFolder, saveChat } = await import('../server/store.js');

test('worktrees: a chat gets its own worktree on qx/<chat>, from the current branch, inside QuorX\'s own folder', () => {
  assert.equal(W.gitInfo(repo).git, true);
  assert.equal(W.gitInfo(repo).branch, 'main');
  assert.equal(W.gitInfo(plain).git, false, 'a folder that is not a repo');
  assert.throws(() => W.createWorktree({ projectId: 'p02', chatId: 'cplain1', title: 'x' }), /not a git repository/);
  const w = W.createWorktree({ projectId: 'p01', chatId: 'csnake1', title: 'Snake game!' });
  assert.equal(w.branch, 'qx/snake-game');
  assert.equal(w.base, 'main');
  assert.ok(W.insideWorktrees(w.path), 'lives in <home>/worktrees');
  assert.ok(!path.resolve(w.path).toLowerCase().startsWith(path.resolve(repo).toLowerCase()), 'never inside the project');
  assert.ok(fs.existsSync(path.join(w.path, 'index.html')));
  assert.equal(git(w.path, 'symbolic-ref', '--short', 'HEAD'), 'qx/snake-game');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the project folder stays on its branch');
  // The space id names the folder wherever a project id does.
  assert.ok(knownFolder(w.space));
  assert.equal(WS.workspaceDir(w.space), w.path);
  assert.equal(W.folderIdFor('p01', 'csnake1'), w.space);
  assert.equal(W.folderIdFor('p01', 'cother1'), 'p01', 'a chat without one uses the project folder');
  // Asking again gives the same one; a second chat with the same title gets a name of its own.
  assert.equal(W.createWorktree({ projectId: 'p01', chatId: 'csnake1', title: 'other' }).path, w.path);
  const w2 = W.createWorktree({ projectId: 'p01', chatId: 'csnake2', title: 'Snake game' });
  assert.equal(w2.branch, 'qx/snake-game-2');
});

test('worktrees: a command, undo and the agent\'s own folder all stay inside the chat\'s worktree', async () => {
  const w = W.createWorktree({ projectId: 'p01', chatId: 'ccmd1', title: 'cmd' });
  const root = WS.workspaceDir(w.space);
  WS.writeFile(root, 'make.js', "require('fs').writeFileSync('made.txt', 'from the worktree')\n");
  const r = await WS.runLine(root, 'node make.js', { timeout: 30e3 });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(w.path, 'made.txt'), 'utf8'), 'from the worktree');
  assert.ok(!fs.existsSync(path.join(repo, 'made.txt')), 'the project folder is untouched');
  // Undo: a checkpoint before a change, then restore, all in the worktree.
  WS.ensureAgentDir(root);
  WS.checkpoint(root, 'r1', 'index.html');
  WS.writeFile(root, 'index.html', '<h1>changed</h1>\n');
  assert.match(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), /hi/, 'the project copy keeps its own');
  WS.restoreCheckpoint(root, 'r1');
  assert.match(fs.readFileSync(path.join(w.path, 'index.html'), 'utf8'), /hi/);
  assert.ok(fs.existsSync(path.join(w.path, '.quorx', 'checkpoints')), 'undo history in the worktree\'s own .quorx');
  assert.ok(!fs.existsSync(path.join(repo, '.quorx', 'checkpoints', 'r1')));
  // .quorx is ignored by git, so it never makes the tree look changed.
  fs.rmSync(path.join(w.path, 'make.js')); fs.rmSync(path.join(w.path, 'made.txt'));
  assert.deepEqual(W.treeChanges(w.path), []);
});

test('worktrees: a server runs on a free port of its own next to the project folder\'s, sharing the launch config', async () => {
  const w = W.createWorktree({ projectId: 'p01', chatId: 'cport1', title: 'port' });
  const fixed = await freePortNow();
  const a = await WS.startServer({ projectId: 'p01', name: 'web', cmd: 'node', args: ['srv.js', '{PORT}'], port: fixed });
  const b = await WS.startServer({ projectId: w.space, name: 'web', cmd: 'node', args: ['srv.js', '{PORT}'], port: fixed });
  try {
    assert.equal(a.status, 'running', a.log); assert.equal(b.status, 'running', b.log);
    assert.equal(a.port, fixed);
    assert.notEqual(b.port, fixed, 'the worktree never takes the fixed port');
    assert.equal(b.branch, w.branch);
    const said = await fetch(b.url).then((x) => x.text());
    assert.equal(path.resolve(said).toLowerCase(), path.resolve(w.path).toLowerCase(), 'it runs in the worktree');
    // One launch file, the project's; the worktree's start left the fixed port in it.
    const cfg = WS.launchConfigs(w.space).find((x) => x.name === 'web');
    assert.equal(cfg.port, fixed);
    assert.deepEqual(WS.launchConfigs(w.space), WS.launchConfigs('p01'));
    assert.equal(WS.listServers(w.space).length, 1); assert.equal(WS.listServers('p01').length, 1);
  } finally { await WS.forgetServer('p01', 'web'); await WS.forgetServer(w.space, 'web'); }
});

test('worktrees: removing refuses while the tree has changes, unless discard; the branch stays', async () => {
  const w = W.createWorktree({ projectId: 'p01', chatId: 'cdirty1', title: 'dirty' });
  fs.writeFileSync(path.join(w.path, 'new-file.txt'), 'untracked');
  const no = await W.removeWorktree(w.space);
  assert.equal(no.ok, false); assert.equal(no.dirty, true);
  assert.ok(no.changes.some((l) => l.includes('new-file.txt')));
  assert.ok(fs.existsSync(path.join(w.path, 'new-file.txt')), 'nothing was deleted');
  // A tracked edit counts too.
  fs.rmSync(path.join(w.path, 'new-file.txt'));
  fs.appendFileSync(path.join(w.path, 'index.html'), 'more\n');
  assert.equal((await W.removeWorktree(w.space)).dirty, true);
  let stopped = null;
  const yes = await W.removeWorktree(w.space, { discard: true, beforeRemove: (sp) => { stopped = sp; } });
  assert.equal(yes.ok, true, yes.error);
  assert.equal(stopped, w.space, 'servers and terminals in it end first');
  assert.ok(!fs.existsSync(w.path));
  assert.ok(gitOk(repo, 'show-ref', '--verify', '-q', 'refs/heads/qx/dirty'), 'the branch is kept');
  assert.equal(W.worktreeOf('cdirty1'), null);
  // A clean one goes without asking.
  const c = W.createWorktree({ projectId: 'p01', chatId: 'cclean1', title: 'clean' });
  assert.equal((await W.removeWorktree(c.space)).ok, true);
});

test('worktrees: never deletes outside QuorX\'s worktree folder', async () => {
  const outside = tempDir('qx-wt-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
  const file = path.join(HOME, 'data', 'worktrees.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.list.push({ space: 'qxwt-forged1', chatId: 'cforged1', projectId: 'p01', path: outside, repo, branch: 'qx/forged', base: 'main' });
  fs.writeFileSync(file, JSON.stringify(j));
  const r = await W.removeWorktree('qxwt-forged1', { discard: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /only removes worktrees inside/);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
});

test('worktrees: Storage lists worktrees whose chat is gone, and folders nothing names', async () => {
  const live = W.createWorktree({ projectId: 'p01', chatId: 'clive1', title: 'live' });
  saveChat('clive1', { id: 'clive1', title: 'live', projectId: 'p01', agent: { messages: [] } });
  const gone = W.createWorktree({ projectId: 'p01', chatId: 'cgone1', title: 'gone' });
  fs.writeFileSync(path.join(gone.path, 'wip.txt'), 'x');
  const orphan = path.join(W.WT_HOME(), 'p01', 'left-behind');
  fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'a.txt'), 'x');
  const list = W.staleWorktrees();
  assert.ok(!list.some((x) => x.space === live.space), 'a chat that exists keeps its worktree off the list');
  const g = list.find((x) => x.space === gone.space);
  assert.ok(g, 'the deleted chat\'s worktree is listed');
  assert.equal(g.clean, false); assert.equal(g.count, 1); assert.equal(g.project, 'Game'); assert.equal(g.branch, 'qx/gone');
  const o = list.find((x) => x.orphan);
  assert.ok(o && path.resolve(o.path) === path.resolve(orphan));
  assert.equal((await W.removeWorktree(o.space, { discard: true })).ok, true);
  assert.ok(!fs.existsSync(orphan));
  assert.equal((await W.removeWorktree(gone.space)).dirty, true);
});

// Through the API, as the page uses it.
async function quorx() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: HOME, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_API_KEY_BOT: '', QX_NO_JOBHOST: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
  });
  const appKey = fs.readFileSync(path.join(HOME, 'data', 'app-key'), 'utf8').trim();
  const call = async (p, body, method) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'x-quorx-key': appKey }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  return { call, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

test('worktrees: the API makes one, serves its files, refuses a dirty removal and lists stale ones', async () => {
  const q = await quorx();
  try {
    assert.deepEqual(await q.call('/api/worktrees?project=p01'), { git: true, branch: 'main', why: null });
    assert.equal((await q.call('/api/worktrees?project=p02')).git, false);
    const w = await q.call('/api/worktrees', { projectId: 'p01', chatId: 'capi1', title: 'Api chat' });
    assert.equal(w.branch, 'qx/api-chat', w.error);
    fs.writeFileSync(path.join(w.path, 'only-here.txt'), 'x');
    const files = await q.call(`/api/files?project=${w.space}`);
    assert.ok(files.some((f) => f.path === 'only-here.txt'), 'the Files list reads the worktree');
    assert.ok(!(await q.call('/api/files?project=p01')).some((f) => f.path === 'only-here.txt'));
    const st = await q.call('/api/worktrees?chat=capi1');
    assert.equal(st.clean, false); assert.equal(st.branch, 'qx/api-chat');
    const no = await q.call('/api/worktrees?chat=capi1', null, 'DELETE');
    assert.equal(no.dirty, true);
    assert.ok((await q.call('/api/worktrees/stale')).list.some((x) => x.space === w.space), 'no chat file: stale');
    const yes = await q.call('/api/worktrees?chat=capi1&discard=1', null, 'DELETE');
    assert.equal(yes.ok, true, yes.error);
    assert.ok(!fs.existsSync(w.path));
  } finally { await q.stop(); }
});
