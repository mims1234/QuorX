// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Source control pane: a project folder's git state, read through git itself. Read only: nothing here stages,
// commits, checks out or pushes. Four answers:
//   status: the branch, how far it is ahead of / behind its upstream, and the changed files (staged, not staged, new)
//   log:    commits, newest first, with parents (the page draws the graph), branch/tag labels and search
//   commit: one commit's message and changed files
//   diff:   one file's diff (in a commit, staged, not staged or new) as hunks of [sign, old line, new line, text]
import { spawn } from 'node:child_process';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_LINES = 1500;
const SEARCH_SCAN = 5000;

// git with these arguments → { ok, out, err, code }. Pathspecs are literal (no :(magic)), nothing prompts.
export function git(cwd, args, { timeout = 20e3, max = 16e6 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn('git', ['--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' } });
    } catch (e) { return finish({ ok: false, out: '', err: e.message, code: -1 }); }
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish({ ok: false, out, err: 'git took too long to answer', code: -1 }); }, timeout);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; if (out.length > max) { out = out.slice(0, max); try { p.kill(); } catch { /* gone */ } } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); finish({ ok: false, out: '', err: e.code === 'ENOENT' ? 'Git is not installed (or not on PATH).' : e.message, code: -1 }); });
    p.on('close', (code) => { clearTimeout(t); finish({ ok: code === 0, out, err: err.trim(), code }); });
  });
}

const SHA = /^[0-9a-f]{4,64}$/i;
const okSha = (s) => SHA.test(String(s || ''));
const okPath = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0');

// ---------- status ----------
const XY = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict' };
// git status --porcelain=v2 -z → { branch, head, upstream, ahead, behind, staged, unstaged, untracked, conflicts }.
export function parseStatus(text) {
  const r = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
  const parts = String(text || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (!l) continue;
    if (l.startsWith('# ')) {
      const [, k, ...v] = l.split(' ');
      if (k === 'branch.oid') r.head = v[0] === '(initial)' ? null : v[0];
      else if (k === 'branch.head') r.branch = v[0] === '(detached)' ? null : v.join(' ');
      else if (k === 'branch.upstream') r.upstream = v.join(' ');
      else if (k === 'branch.ab') { r.ahead = Math.abs(Number(v[0]) || 0); r.behind = Math.abs(Number(v[1]) || 0); }
      continue;
    }
    const kind = l[0];
    if (kind === '?') { r.untracked.push({ path: l.slice(2), status: 'new' }); continue; }
    if (kind === '1' || kind === '2') {
      const f = l.split(' '), xy = f[1], path = f.slice(kind === '1' ? 8 : 9).join(' ');
      const orig = kind === '2' ? parts[++i] : null;
      if (xy[0] !== '.') r.staged.push({ path, status: XY[xy[0]] || 'modified', ...(orig ? { orig } : {}) });
      if (xy[1] !== '.') r.unstaged.push({ path, status: XY[xy[1]] || 'modified', ...(orig && xy[0] === '.' ? { orig } : {}) });
      continue;
    }
    if (kind === 'u') { const f = l.split(' '); r.unstaged.push({ path: f.slice(10).join(' '), status: 'conflict' }); }
  }
  return r;
}
// git diff --numstat -z → Map path → { added, removed, binary }.
export function parseNumstat(text) {
  const m = new Map(), parts = String(text || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i]; if (!l) continue;
    const mm = l.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s); if (!mm) continue;
    let p = mm[3];
    if (p === '') { i += 2; p = parts[i]; } // a rename: "a\tb\t" then old path, new path
    m.set(p, mm[1] === '-' ? { binary: true, added: 0, removed: 0 } : { added: Number(mm[1]), removed: Number(mm[2]) });
  }
  return m;
}
/** The folder's git state, or { git: false, why }. */
export async function gitStatus(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { git: false, why: /not installed/.test(top.err) ? top.err : 'This project folder is not a git repository, so there is no history to show.' };
  const st = await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (!st.ok) return { git: true, top: top.out.trim(), error: st.err || 'git status failed' };
  const r = parseStatus(st.out);
  if (r.head) {
    const [a, b] = await Promise.all([git(dir, ['diff', '--cached', '--numstat', '-z', '-M']), git(dir, ['diff', '--numstat', '-z'])]);
    const na = parseNumstat(a.out), nb = parseNumstat(b.out);
    for (const f of r.staged) Object.assign(f, na.get(f.path) || {});
    for (const f of r.unstaged) Object.assign(f, nb.get(f.path) || {});
  }
  return { git: true, top: top.out.trim(), ...r, empty: !r.head };
}

// ---------- log ----------
const FS = '\x1f', RS = '\x1e';
const LOG_FMT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join('%x1f') + '%x1e';
// One "%D" ref list → labels: { name, kind: head | branch | remote | tag }.
export function refsOf(d, remotes = new Set()) {
  const out = [];
  for (let x of String(d || '').split(', ').map((s) => s.trim()).filter(Boolean)) {
    if (x === 'HEAD') { out.push({ name: 'HEAD', kind: 'head' }); continue; }
    if (x.startsWith('HEAD -> ')) { out.push({ name: 'HEAD', kind: 'head' }); x = x.slice(8); }
    if (x.startsWith('tag: ')) out.push({ name: x.slice(5), kind: 'tag' });
    else if (/\/HEAD$/.test(x)) continue; // origin/HEAD says nothing new
    else if (x.includes('/') && remotes.has(x.split('/')[0])) out.push({ name: x, kind: 'remote' });
    else out.push({ name: x, kind: 'branch' });
  }
  return out;
}
// remotes: the names `git remote` gives, so "origin/main" reads as a remote branch and "qx/x" as a local one.
export function parseLog(text, remotes = new Set()) {
  return String(text || '').split(RS).map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((r) => {
    const [sha, parents, author, email, at, subject, refs] = r.split(FS);
    return { sha, parents: parents ? parents.split(' ') : [], author, email, at: Number(at) * 1000, subject: subject || '', refs: refsOf(refs, remotes) };
  });
}
async function remotesOf(dir) {
  const r = await git(dir, ['remote']);
  return new Set(r.ok ? r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []);
}
/** Commits, newest first: { commits, more }. scope 'all' = every branch and tag; q searches message, author and hash. */
export async function gitLog(dir, { scope = 'branch', skip = 0, limit = 50, q = '' } = {}) {
  skip = Math.max(0, Number(skip) || 0); limit = Math.min(200, Math.max(1, Number(limit) || 50));
  const remotes = await remotesOf(dir);
  const base = ['log', '--date-order', `--format=${LOG_FMT}`, '--decorate=short', ...(scope === 'all' ? ['--branches', '--tags', '--remotes', 'HEAD'] : ['HEAD'])];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const r = await git(dir, [...base, `--skip=${skip}`, `--max-count=${limit + 1}`]);
    if (!r.ok) return { commits: [], more: false, error: /does not have any commits|unknown revision/.test(r.err) ? null : r.err };
    const commits = parseLog(r.out, remotes);
    return { commits: commits.slice(0, limit), more: commits.length > limit };
  }
  // Search: the newest commits read once and matched here (git's own --grep and --author only match both at once).
  const r = await git(dir, [...base, `--max-count=${SEARCH_SCAN}`]);
  if (!r.ok) return { commits: [], more: false, error: r.err };
  const all = parseLog(r.out, remotes);
  const hits = all.filter((c) => { const t = `${c.subject} ${c.author} ${c.email} ${c.sha} ${c.refs.map((x) => x.name).join(' ')}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  return { commits: hits.slice(skip, skip + limit), more: hits.length > skip + limit, searched: all.length, capped: all.length >= SEARCH_SCAN };
}

// ---------- one commit ----------
const NS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
// git diff-tree --name-status -z → [{ path, status, orig }].
export function parseNameStatus(text) {
  const out = [], parts = String(text || '').split('\0').filter((s, i, a) => s !== '' || i < a.length - 1);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]; if (!s) continue;
    const k = s[0];
    if (k === 'R' || k === 'C') { const orig = parts[++i], p = parts[++i]; out.push({ path: p, orig, status: NS[k] }); }
    else if (NS[k]) out.push({ path: parts[++i], status: NS[k] });
  }
  return out;
}
/** One commit: full message, author, date, parents, labels and changed files (against its first parent). */
export async function gitCommit(dir, sha) {
  if (!okSha(sha)) return { error: 'bad commit id' };
  const remotes = await remotesOf(dir);
  const m = await git(dir, ['show', '-s', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%B%x1f%D`, '--decorate=short', sha]);
  if (!m.ok) return { error: m.err || 'no such commit' };
  const [full, parents, author, email, at, committer, body, refs] = m.out.split(FS);
  const ps = parents ? parents.split(' ') : [];
  const from = ps[0] || EMPTY_TREE;
  const [ns, nu] = await Promise.all([git(dir, ['diff-tree', '-r', '-M', '-z', '--name-status', from, full]), git(dir, ['diff-tree', '-r', '-M', '-z', '--numstat', from, full])]);
  const counts = parseNumstat(nu.out);
  const files = parseNameStatus(ns.out).map((f) => ({ ...f, ...(counts.get(f.path) || {}) }));
  return { sha: full, parents: ps, author, email, at: Number(at) * 1000, committer, message: String(body || '').trim(), refs: refsOf(refs, remotes), files, merge: ps.length > 1 };
}

// ---------- one file's diff ----------
/** A unified diff → { hunks: [{ head, lines: [[sign, old, new, text]] }], binary, cut }. */
export function parseUnified(text, limit = MAX_DIFF_LINES) {
  const hunks = []; let cur = null, o = 0, n = 0, shown = 0, binary = false, cut = false;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (/^Binary files .* differ$/.test(l) || l === 'GIT binary patch') { binary = true; continue; }
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { o = Number(h[1]); n = Number(h[2]); cur = { head: h[3].trim(), lines: [] }; hunks.push(cur); continue; }
    if (!cur || l.startsWith('\\')) continue;
    if (shown >= limit) { cut = true; break; }
    const t = l[0], s = l.slice(1, 2001);
    if (t === '+') cur.lines.push(['+', null, n++, s]);
    else if (t === '-') cur.lines.push(['-', o++, null, s]);
    else if (t === ' ') cur.lines.push([' ', o++, n++, s]); // git starts even an empty context line with a space
    else continue;
    shown++;
  }
  return { hunks, binary, cut };
}
/** One file's diff. where: commit (with sha), staged, unstaged or new (an untracked file). */
export async function gitDiff(dir, { where, sha, path: p, orig }) {
  if (!okPath(p) || (orig != null && orig !== '' && !okPath(orig))) return { error: 'bad path' };
  const paths = orig && orig !== p ? [orig, p] : [p];
  const common = ['--no-color', '--no-ext-diff', '-U3', '-M'];
  let r;
  if (where === 'commit') {
    if (!okSha(sha)) return { error: 'bad commit id' };
    const ps = await git(dir, ['rev-list', '--parents', '-n', '1', sha]);
    if (!ps.ok) return { error: ps.err || 'no such commit' };
    const [full, parent] = ps.out.trim().split(' ');
    r = await git(dir, ['diff', ...common, parent || EMPTY_TREE, full, '--', ...paths]);
  } else if (where === 'staged') r = await git(dir, ['diff', '--cached', ...common, '--', ...paths]);
  else if (where === 'unstaged') r = await git(dir, ['diff', ...common, '--', ...paths]);
  else if (where === 'new') {
    r = await git(dir, ['diff', '--no-index', ...common, '--', '/dev/null', p]);
    if (r.code === 1) r.ok = true; // --no-index exits 1 when the files differ
  } else return { error: 'bad diff kind' };
  if (!r.ok) return { error: r.err || 'git diff failed' };
  return { path: p, ...parseUnified(r.out) };
}
