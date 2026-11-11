// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A chat of its own in a git project: its own git worktree, on a branch qx/<chat>, made from the project's current
// branch. Two chats building at once no longer share one folder, so neither steps on the other's files, servers or
// undo history. Opt-in per chat (the start box, or Remix); projects that aren't git repos work as before.
//
// Each worktree is a "space": an id (qxwt-<chat>) that stands in for the project id wherever a folder is meant (files,
// commands, servers, the terminal, undo), and resolves to the worktree's folder. The chat itself still belongs to the
// project (its sidebar place, budget, memory and documents).
//
// Worktrees live in QuorX's own data folder (<data>/worktrees/<project>/<name>), never inside the project: build
// tools that scan the project would otherwise find a second copy of it. Removing one only ever deletes inside that
// folder, refuses while the tree has changes that aren't committed (unless the user ticked "discard changes"), and
// keeps the branch, so committed work is never lost.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME } from './openrouter.js';
import { listProjects, projectDir, getChat, validId, setSpaceResolver } from './store.js';

export const WT_HOME = () => path.join(HOME, 'worktrees');
const FILE = () => path.join(HOME, 'data', 'worktrees.json');
export const SPACE_PREFIX = 'qxwt-';
export const isSpaceId = (id) => typeof id === 'string' && id.startsWith(SPACE_PREFIX) && validId(id);

// ---------- git ----------
function git(cwd, args, { timeout = 30e3 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ENOENT' ? 'Git is not installed (or not on PATH).' : r.error.message };
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
/** { git: true, top, branch, head } for a folder inside a git repo (branch null when detached), else { git: false }. */
export function gitInfo(dir) {
  if (!dir || !fs.existsSync(dir)) return { git: false };
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { git: false, ...(/not installed/.test(top.err) ? { why: top.err } : {}) };
  const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return { git: false, why: 'The repository has no commits yet: commit once, then a chat can have its own worktree.' };
  const br = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return { git: true, top: path.resolve(top.out), branch: br.ok ? br.out : null, head: head.out };
}
/** Changes git sees in the tree: tracked edits and untracked files (each "XY path" as git prints it). */
export function treeChanges(dir) {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) throw new Error(r.err || 'git status failed');
  return r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}
const aheadOf = (dir, base) => { const r = base ? git(dir, ['rev-list', '--count', `${base}..HEAD`]) : { ok: false }; return r.ok ? Number(r.out) || 0 : null; };

// ---------- the list ----------
function readList() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j?.list) ? j.list.filter((x) => x && isSpaceId(x.space)) : []; } catch { return []; }
}
function writeList(list) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify({ version: 1, list }, null, 2));
  fs.renameSync(FILE() + '.tmp', FILE());
}
export const listWorktrees = () => readList();
/** The worktree a space id names, or null. */
export const spaceInfo = (space) => (isSpaceId(space) ? readList().find((x) => x.space === space) || null : null);
/** The chat's worktree (only while its folder exists), or null. */
export function worktreeOf(chatId) {
  if (!validId(String(chatId || ''))) return null;
  const w = readList().find((x) => x.chatId === String(chatId));
  return w && fs.existsSync(w.path) ? w : null;
}
/** The id that names the chat's folder: its worktree's space, else the project id. */
export const folderIdFor = (projectId, chatId) => { const w = worktreeOf(chatId); return w && w.projectId === projectId ? w.space : projectId; };
/** The project a folder id belongs to: itself, or the project a worktree space was made from. */
export const projectOfFolder = (id) => spaceInfo(id)?.projectId || id;

// store.js resolves a space id to its folder, so everything that takes a project id for a folder takes a space too.
setSpaceResolver((id) => {
  const w = spaceInfo(id);
  if (!w) return null;
  if (!fs.existsSync(w.path)) throw Object.assign(new Error(`the chat's worktree folder is missing (${w.path}); remove it in ⚙ Settings → Storage`), { code: 'FOLDER_MISSING' });
  return w.path;
});

// Inside QuorX's worktree folder, resolved through links: the only place removing may delete.
export function insideWorktrees(p) {
  const real = (q) => { try { return fs.realpathSync.native(q); } catch { return path.resolve(q); } };
  const base = real(WT_HOME()).toLowerCase(), a = real(p).toLowerCase();
  return a !== base && a.startsWith(base + path.sep);
}

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '') || 'chat';

/** Makes the chat's worktree: branch qx/<name> from the project's current branch (or from another worktree's HEAD,
 * for a remix of a chat that has one). Returns the record; a chat that already has one gets it back. */
export function createWorktree({ projectId, chatId, title = '', from = '' }) {
  if (!validId(String(chatId || ''))) throw new Error('bad chat id');
  const have = worktreeOf(chatId);
  if (have) return have;
  if (!listProjects().some((p) => p.id === projectId)) throw new Error('unknown project');
  const dir = projectDir(projectId), info = gitInfo(dir);
  if (!info.git) throw new Error(info.why || 'This project is not a git repository, so a chat can\'t have a worktree of its own here.');
  const src = from ? spaceInfo(from) : null;
  if (from && (!src || src.projectId !== projectId)) throw new Error('the chat to start from has no worktree in this project');
  const start = src ? (gitInfo(src.path).head || src.branch) : info.head;
  const base = src ? src.branch : (info.branch || info.head.slice(0, 12));
  // A free name: no branch and no folder by it yet.
  const stem = slugOf(title);
  let name = stem;
  for (let i = 2; git(info.top, ['show-ref', '--verify', '-q', `refs/heads/qx/${name}`]).ok || fs.existsSync(path.join(WT_HOME(), projectId, name)); i++) name = `${stem}-${i}`;
  const where = path.join(WT_HOME(), projectId, name), branch = `qx/${name}`;
  fs.mkdirSync(path.dirname(where), { recursive: true });
  const r = git(info.top, ['worktree', 'add', '-b', branch, where, start], { timeout: 120e3 });
  if (!r.ok) throw new Error(`git couldn't make the worktree: ${r.err || r.out}`);
  const rec = { space: `${SPACE_PREFIX}${String(chatId).toLowerCase()}`.slice(0, 64), chatId: String(chatId), projectId, path: where, repo: info.top, branch, base, created: Date.now() };
  writeList([...readList().filter((x) => x.chatId !== rec.chatId), rec]);
  return rec;
}

/** What the worktree holds now: { clean, changes: [lines], ahead (commits past its base), missing }. */
export function worktreeStatus(w) {
  if (!w || !fs.existsSync(w.path)) return { clean: true, changes: [], ahead: null, missing: true };
  try { const changes = treeChanges(w.path); return { clean: !changes.length, changes, ahead: aheadOf(w.path, w.base), missing: false }; }
  catch (e) { return { clean: false, changes: [], ahead: null, missing: false, error: e.message }; }
}

/** Removes a worktree QuorX made. Refuses ({ dirty: true, changes }) while it has changes, unless `discard`.
 * The branch stays. `beforeRemove(space)` lets the caller stop servers and terminals running in it first. */
export async function removeWorktree(space, { discard = false, beforeRemove } = {}) {
  const w = spaceInfo(space) || orphanOf(space);
  if (!w) return { ok: false, error: 'no such worktree' };
  if (!insideWorktrees(w.path)) return { ok: false, error: 'QuorX only removes worktrees inside its own worktree folder' };
  const st = worktreeStatus(w);
  if (!st.missing && !st.clean && !discard) return { ok: false, dirty: true, changes: st.changes.slice(0, 50), count: st.changes.length, error: st.error || 'The worktree has changes that are not committed.' };
  if (beforeRemove) await beforeRemove(w.space);
  if (!st.missing) {
    const repo = w.repo && fs.existsSync(w.repo) ? w.repo : null;
    const r = repo ? git(repo, ['worktree', 'remove', ...(discard ? ['--force'] : []), w.path], { timeout: 120e3 }) : { ok: false };
    // Not a worktree git knows (its repo moved, or git lost track): delete the folder itself, inside our space only.
    if (!r.ok && fs.existsSync(w.path)) {
      if (!discard && !repo) return { ok: false, error: 'The repository this worktree came from is gone; tick "discard changes" to delete the folder.' };
      try { fs.rmSync(w.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { return { ok: false, error: `couldn't delete the folder (a program may still have a file open in it): ${e.message}` }; }
    }
    if (repo) git(repo, ['worktree', 'prune']);
  }
  writeList(readList().filter((x) => x.space !== w.space));
  try { const up = path.dirname(w.path); if (insideWorktrees(up) && !fs.readdirSync(up).length) fs.rmdirSync(up); } catch { /* not empty */ }
  return { ok: true, branch: w.branch || null };
}

// Folders in the worktree space that no record names (a crash between the git call and the save, or a list from an
// older copy): listed as stale with an id of their own so Remove can reach them.
const ORPHAN = 'qxwt-orphan-';
function orphans() {
  const known = new Set(readList().map((x) => path.resolve(x.path).toLowerCase()));
  const out = [];
  let pids = []; try { pids = fs.readdirSync(WT_HOME()); } catch { return out; }
  for (const pid of pids) {
    let names = []; try { names = fs.readdirSync(path.join(WT_HOME(), pid)); } catch { continue; }
    for (const n of names) {
      const p = path.join(WT_HOME(), pid, n);
      try { if (!fs.lstatSync(p).isDirectory()) continue; } catch { continue; }
      if (known.has(path.resolve(p).toLowerCase())) continue;
      let repo = null;
      try { const g = fs.readFileSync(path.join(p, '.git'), 'utf8').match(/gitdir:\s*(.+)/); if (g) repo = path.resolve(g[1].trim(), '..', '..', '..'); } catch { /* not a worktree */ }
      out.push({ space: `${ORPHAN}${slugOf(`${pid}-${n}`)}`.slice(0, 64), chatId: null, projectId: pid, path: p, repo, branch: null, orphan: true });
    }
  }
  return out;
}
const orphanOf = (id) => (String(id || '').startsWith(ORPHAN) ? orphans().find((x) => x.space === id) || null : null);

/** Worktrees whose chat is gone (deleted, or never saved), and folders nothing names: what ⚙ Storage lists. */
export function staleWorktrees({ chatExists = (id) => !!getChat(id) } = {}) {
  const list = readList().filter((w) => !chatExists(w.chatId)).concat(orphans());
  return list.map((w) => {
    const st = worktreeStatus(w), p = listProjects().find((x) => x.id === w.projectId);
    return { space: w.space, chatId: w.chatId, projectId: w.projectId, project: p?.name || w.projectId, path: w.path, branch: w.branch, created: w.created || null, orphan: !!w.orphan, ...st, changes: st.changes.slice(0, 20), count: st.changes.length };
  });
}
