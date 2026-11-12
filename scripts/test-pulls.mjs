// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Pull requests tab (server/pulls.js): reading gh's answers into what the panel shows (checks, blockers, this
// chat's branch first), the end of a failing check's log, and "GitHub CLI not set up" without errors. gh is stood in
// for by QX_GH_FAKE, so nothing here talks to GitHub.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.OH_HOME;
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

const RUN = 'https://github.com/o/r/actions/runs/111/job/222';
const PRS = [
  { number: 42, title: 'Add sound effects', state: 'OPEN', isDraft: false, headRefName: 'qx/snake-remix', baseRefName: 'main', author: { login: 'dev' }, reviewDecision: 'REVIEW_REQUIRED', url: 'https://github.com/o/r/pull/42', comments: [{}, {}],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', workflowName: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/221' },
      { __typename: 'CheckRun', name: 'tsc --noEmit', workflowName: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN },
      { __typename: 'CheckRun', name: 'e2e', workflowName: 'ci', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/223' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'https://example.com' },
    ] },
  { number: 41, title: 'Faster snake', state: 'OPEN', isDraft: true, headRefName: 'faster', baseRefName: 'main', reviewDecision: 'APPROVED', url: 'https://github.com/o/r/pull/41', statusCheckRollup: [] },
  { number: 40, title: 'Old work', state: 'MERGED', headRefName: 'old', baseRefName: 'main', url: 'https://github.com/o/r/pull/40', statusCheckRollup: [] },
];
const LOG = ['build\tRun tsc\t2026-11-11T09:00:00.1234567Z \x1b[31msounds.ts(14,7): error TS2339: Property \'play\' does not exist\x1b[0m', 'build\tRun tsc\t2026-11-11T09:00:01.0000000Z Found 1 error.'].join('\n');
const fakeFile = (o) => { const f = path.join(tempDir('qx-gh-'), 'gh.json'); fs.writeFileSync(f, JSON.stringify(o)); return f; };

const P = await import('../server/pulls.js');

test('pulls: checks, review and blockers read from gh, failing first, this chat\'s branch first', async () => {
  process.env.QX_GH_FAKE = fakeFile({ installed: true, signedIn: true, prs: PRS, logs: { 222: LOG } });
  const r = await P.listPulls({ cwd: ROOT, repo: 'o/r', state: 'open', branch: 'qx/snake-remix' });
  assert.deepEqual(r.gh, { installed: true, signedIn: true, why: null });
  assert.deepEqual(r.prs.map((p) => p.number), [42, 41], 'open only, the chat\'s own first');
  const p = r.prs[0];
  assert.equal(p.mine, true);
  assert.deepEqual(p.sum, { total: 4, failing: 1, pending: 1, passed: 2, skipped: 0 });
  assert.equal(p.checks[0].state, 'failing'); assert.equal(p.checks[0].name, 'tsc --noEmit'); assert.equal(p.checks[0].workflow, 'build');
  assert.equal(p.checks[0].runId, '111'); assert.equal(p.checks[0].jobId, '222');
  assert.equal(p.checks[1].state, 'pending');
  assert.equal(p.review, 'review required'); assert.equal(p.comments, 2);
  assert.deepEqual(p.blockers, ['1 check failing', 'a review is required', '1 check still running']);
  assert.deepEqual(r.prs[1].blockers, ['it is a draft']);
  assert.equal((await P.listPulls({ cwd: ROOT, repo: 'o/r', state: 'all' })).prs.length, 3);
  assert.deepEqual((await P.listPulls({ cwd: ROOT, repo: 'o/r', state: 'merged' })).prs[0].blockers, [], 'a merged PR has nothing blocking');
  // The end of the failing job's log, without gh's columns, timestamps or colours.
  const lg = await P.checkLog({ cwd: ROOT, repo: 'o/r', runId: '111', jobId: '222' });
  assert.equal(lg.tail, "sounds.ts(14,7): error TS2339: Property 'play' does not exist\nFound 1 error.");
  assert.match((await P.checkLog({ cwd: ROOT, repo: 'o/r', runId: 'x', jobId: '' })).error, /no GitHub Actions log/);
});

test('pulls: without the GitHub CLI, or signed out, the panel gets a setup note and no error', async () => {
  process.env.QX_GH_FAKE = fakeFile({ installed: false });
  let r = await P.listPulls({ cwd: ROOT, repo: 'o/r' });
  assert.deepEqual(r, { gh: { installed: false, signedIn: false, why: null }, prs: [] });
  process.env.QX_GH_FAKE = fakeFile({ installed: true, signedIn: false });
  r = await P.listPulls({ cwd: ROOT, repo: 'o/r' });
  assert.equal(r.gh.installed, true); assert.equal(r.gh.signedIn, false); assert.equal(r.error, undefined);
});

test('pulls: the API marks the PR of the chat\'s worktree branch, and serves a failing check\'s log', async () => {
  const repo = tempDir('qx-pr-repo-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'a');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const plain = tempDir('qx-pr-plain-');
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'projects.json'), JSON.stringify([{ id: 'scratch', name: 'Scratch', path: tempDir('qx-pr-s-'), created: 1 }, { id: 'p01', name: 'Game', path: repo, created: 1 }, { id: 'p02', name: 'Plain', path: plain, created: 1 }]));
  const fake = fakeFile({ installed: true, signedIn: true, prs: PRS.map((p) => (p.number === 42 ? { ...p, headRefName: 'qx/sounds' } : p)), logs: { 222: LOG } });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: HOME, QX_GH_FAKE: fake, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', QX_NO_JOBHOST: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const key = fs.readFileSync(path.join(HOME, 'data', 'app-key'), 'utf8').trim();
  const call = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-quorx-key': key }, body: body ? JSON.stringify(body) : undefined })).json();
  try {
    const w = await call('/api/worktrees', { projectId: 'p01', chatId: 'csounds1', title: 'sounds' });
    assert.equal(w.branch, 'qx/sounds', w.error);
    const r = await call('/api/pulls?project=p01&chat=csounds1&state=open');
    assert.equal(r.repo, 'o/r'); assert.equal(r.branch, 'qx/sounds');
    assert.equal(r.prs[0].number, 42); assert.equal(r.prs[0].mine, true);
    const other = await call('/api/pulls?project=p01&chat=cother1');
    assert.equal(other.branch, 'main', 'a chat in the project folder: its current branch');
    assert.ok(!other.prs.some((p) => p.mine));
    const lg = await call('/api/pulls/log?project=p01&run=111&job=222');
    assert.match(lg.tail, /TS2339/);
    const none = await call('/api/pulls?project=p02');
    assert.equal(none.repo, null); assert.deepEqual(none.prs, []);
  } finally { await new Promise((r) => { child.once('exit', r); child.kill(); }); }
});
