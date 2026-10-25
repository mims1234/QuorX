// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Snapshots of a project before a command runs, so Undo and Review changes cover what commands do (builds,
// scripts, `rm` in a shell), not only the agent's own file edits.
// Files are stored by content in <project>/.quorx/objects/<aa>/<sha1> and an index (.quorx/snapindex.json) keeps
// each file's size, mtime and hash, so a snapshot only reads files that changed since the last one. After the
// command, the files it added, changed or deleted get their before-state copied into the reply's normal
// checkpoint, in the same format the file tools use; everything downstream (Undo, Undo one file, conflict
// checks, pruning) works unchanged. Only the newest snapshot's objects are kept, plus those of any snapshot whose
// command hasn't finished yet (a background job, another chat in the same project).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

const DIR = '.quorx';
// Never snapshotted: dependencies, version control, build output and the harness's own folder.
export const SNAP_SKIP = ['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', 'dist', '.cache', '.quorx',
  'target', 'bin', 'obj', 'build', 'out', '.gradle', '.idea', '.vs', '.pytest_cache', '.mypy_cache', '.tox', 'coverage'];
const skipDir = (name, extra) => SNAP_SKIP.includes(name) || /^cmake-build-/i.test(name) || extra.includes(name);

const objDir = (root) => path.join(root, DIR, 'objects');
const objPath = (root, sha) => path.join(objDir(root), sha.slice(0, 2), sha);
const indexPath = (root) => path.join(root, DIR, 'snapindex.json');
const readIndex = (root) => { try { const j = JSON.parse(fs.readFileSync(indexPath(root), 'utf8')); return j?.v === 1 && j.files ? j.files : {}; } catch { return {}; } };

/**
 * Snapshots the project. Returns { files: { rel: [size, mtimeMs, sha1] }, count, bytes, ms, skippedBig: [rel], over }.
 * `maxBytes`: the most the project's snapshotted files may add up to; past it, nothing is stored and `over` is set.
 * `maxFile`: files bigger than this are left out (and listed in skippedBig).
 */
export function snapshot(root, { maxBytes = 1024 * 1024 * 1024, maxFile = 20 * 1024 * 1024, skip = [], maxFiles = 50000 } = {}) {
  const t0 = Date.now();
  const old = readIndex(root);
  const files = {}, skippedBig = [];
  let bytes = 0, count = 0, over = false;
  const walk = (dir) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (over) return;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // links (and junctions) can point outside the project
      if (e.isDirectory()) { if (!skipDir(e.name, skip)) walk(p); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const rel = path.relative(root, p).replaceAll('\\', '/');
      if (st.size > maxFile) { skippedBig.push(rel); continue; }
      if (++count > maxFiles || (bytes += st.size) > maxBytes) { over = true; return; }
      const prev = old[rel];
      if (prev && prev[0] === st.size && prev[1] === st.mtimeMs && fs.existsSync(objPath(root, prev[2]))) { files[rel] = prev; continue; }
      let buf; try { buf = fs.readFileSync(p); } catch { continue; }
      const sha = crypto.createHash('sha1').update(buf).digest('hex');
      const op = objPath(root, sha);
      if (!fs.existsSync(op)) { fs.mkdirSync(path.dirname(op), { recursive: true }); fs.writeFileSync(op, buf); }
      files[rel] = [st.size, st.mtimeMs, sha];
    }
  };
  walk(root);
  if (over) return { files: null, count, bytes, ms: Date.now() - t0, skippedBig, over: true };
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  fs.writeFileSync(indexPath(root), JSON.stringify({ v: 1, at: Date.now(), files }));
  return { files, count, bytes, ms: Date.now() - t0, skippedBig, over: false };
}

/** What changed since snapshot `before` (rescans, which is cheap). { added, modified, deleted, after }. */
export function changesSince(root, before, opts = {}) {
  const after = snapshot(root, { ...opts, maxBytes: Infinity, maxFiles: Infinity });
  const a = before.files || {}, b = after.files || {};
  const added = [], modified = [], deleted = [];
  for (const rel of Object.keys(b)) { if (!(rel in a)) added.push(rel); else if (a[rel][2] !== b[rel][2]) modified.push(rel); }
  for (const rel of Object.keys(a)) if (!(rel in b)) deleted.push(rel);
  return { added, modified, deleted, after };
}

/** The stored copy of a file as it was in `snap`, or null if it didn't exist then. */
export function objectFor(root, snap, rel) {
  const e = snap.files?.[rel];
  return e ? objPath(root, e[2]) : null;
}

/** Removes stored objects no longer named by the current index nor listed in `alsoKeep` (the hashes a snapshot
 *  still waiting for its command needs). Returns how many were removed. */
export function pruneObjects(root, alsoKeep = []) {
  const keep = new Set([...Object.values(readIndex(root)).map((e) => e[2]), ...alsoKeep]);
  let n = 0;
  let subs; try { subs = fs.readdirSync(objDir(root)); } catch { return 0; }
  for (const s of subs) {
    const d = path.join(objDir(root), s);
    let list; try { list = fs.readdirSync(d); } catch { continue; }
    for (const f of list) if (!keep.has(f)) { try { fs.rmSync(path.join(d, f)); n++; } catch { /* in use */ } }
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* not empty */ }
  }
  return n;
}

// ---------- off the main thread ----------
// The walk above is synchronous: in a project of tens of thousands of files it holds the event loop for seconds.
// The async versions run the very same functions in one long-lived worker (snapshot-worker.js), one job at a time,
// so results match the sync path exactly. Where a worker can't start (or dies mid-job) they run the sync function.
let worker = null, seq = 0;
const jobs = new Map();
function failAll(why) {
  worker = null;
  for (const [, j] of jobs) { try { j.resolve(j.sync()); } catch (e) { j.reject(e); } } // fall back for jobs in flight
  jobs.clear();
  if (why) console.warn(`snapshot worker stopped (${why}); snapshots run on the main thread`);
}
function getWorker() {
  if (worker) return worker;
  if (process.env.QX_SNAPSHOT_WORKER === '0') return null;
  let w;
  try { w = new Worker(new URL('./snapshot-worker.js', import.meta.url)); } catch { return null; }
  w.on('message', ({ id, ok, value, error }) => {
    const j = jobs.get(id);
    if (!j) return;
    jobs.delete(id);
    if (!jobs.size) w.unref(); // an idle worker never keeps the app (or a test run) alive
    ok ? j.resolve(value) : j.reject(new Error(error));
  });
  w.on('error', (e) => { if (worker === w) failAll(e.message); });
  w.on('exit', (code) => { if (worker === w) failAll(code ? `exit code ${code}` : ''); });
  w.unref();
  return (worker = w);
}
function run(op, args, sync) {
  const w = getWorker();
  if (!w) return new Promise((resolve) => resolve(sync()));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, sync });
    w.ref();
    try { w.postMessage({ id, op, args }); } catch { jobs.delete(id); try { resolve(sync()); } catch (e2) { reject(e2); } }
  });
}

/** snapshot() without blocking the event loop. Same result. */
export const snapshotAsync = (root, opts = {}) => run('snapshot', [root, opts], () => snapshot(root, opts));
/** changesSince() without blocking the event loop. Same result. */
export const changesSinceAsync = (root, before, opts = {}) => run('changesSince', [root, before, opts], () => changesSince(root, before, opts));
/** pruneObjects() without blocking the event loop. */
export const pruneObjectsAsync = (root, alsoKeep = []) => run('pruneObjects', [root, alsoKeep], () => pruneObjects(root, alsoKeep));
