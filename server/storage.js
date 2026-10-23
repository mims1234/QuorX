// ⚙ Settings → Storage: what QuorX keeps on this computer, how much room each part takes, and clearing it.
// Every part is a list of entries (files or folders) that clearing removes. Caches and leftovers are deleted (they come
// back by themselves, or nothing refers to them); your own things (deleted chats, the agent's trash and scratch, older
// undo history) go to the Windows Recycle Bin, so they can still be brought back. Some parts are only shown: current
// logs, attached documents and their search index, keys and settings are never cleared from here.
// The desktop app's own caches (Electron) are measured and cleared by desktop/main.js; the page shows both together.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from './openrouter.js';
import { listProjects, getChat } from './store.js';
import { activeRuns } from './runs.js';
import { unusedBlobs } from './blobs.js';
import { SHOT_DIR, pruneShots } from './harness-checks.js';
import { storageRules } from './storagerules.js';
import { checkpointTime } from './workspace.js';

const DATA = path.join(HOME, 'data');
const LOGS = path.join(HOME, 'logs');
const AGENT_DIR = '.quorx';
const DAY = 864e5;

// ---------- sizes ----------
// Links and junctions are not followed (a project can link to anything); a walk that takes longer than its budget
// stops and says so, so a huge folder on a slow drive never holds the page up.
async function sizeOf(p, deadline = Date.now() + 10e3) {
  let bytes = 0, files = 0, partial = false;
  const walk = async (q) => {
    if (Date.now() > deadline) { partial = true; return; }
    let st; try { st = await fs.promises.lstat(q); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) { bytes += st.size; files++; return; }
    let list; try { list = await fs.promises.readdir(q); } catch { return; }
    for (const n of list) await walk(path.join(q, n));
  };
  await walk(p);
  return { bytes, files, partial };
}
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const isFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
const mtime = (p) => { try { return fs.lstatSync(p).mtimeMs; } catch { return 0; } };

// When something went to a trash: the stamp in its name (2026-10-18T17-12-43-761Z, or milliseconds at the end), else
// the time it last changed.
export function trashedAt(p) {
  const n = path.basename(p);
  const iso = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(n);
  if (iso) { const t = Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}.${iso[5]}Z`); if (t) return t; }
  const ms = /-(\d{13})(?:\.\w+)?$/.exec(n);
  if (ms) return Number(ms[1]);
  return mtime(p);
}
// The entries of a trash folder: data/trash holds chats as files and a folder per kind (skills/…) whose entries count one by one.
function trashEntries(dir) {
  const out = [];
  for (const n of names(dir)) {
    const p = path.join(dir, n);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory() && !/\d{4}-\d{2}-\d{2}T/.test(n)) for (const m of names(p)) out.push(path.join(p, m));
    else out.push(p);
  }
  return out;
}

// ---------- the parts ----------
// Each part: { id, group, label, help, how: 'delete' | 'recycle' | null (only shown), safe (in "Clear safe caches"),
// list(ctx) → paths }. Projects add one part per kind of thing in their .quorx folder.
const LOG_OLD = (n) => /\.1\.\w+$/.test(n) || /^bench-|^test-results/i.test(n) || n === 'harness.log';
const PARTS = [
  { id: 'blobs', group: 'cache', label: 'Unused pictures', how: 'delete', safe: true,
    help: 'Pictures and recordings no chat refers to any more. QuorX removes them by itself after 2 days; this does it now.',
    list: async () => (await unusedBlobs(3600e3)).map((b) => b.path) },
  { id: 'runs', group: 'cache', label: 'Finished reply logs', how: 'delete', safe: true,
    help: 'Step-by-step logs of replies that have ended, kept so an interrupted reply can carry on. They go by themselves after 3 days.',
    list: async () => {
      const live = new Set(activeRuns().map((r) => r.runId)), dir = path.join(DATA, 'runs');
      return names(dir).filter((n) => !live.has(n.split('.')[0]) && Date.now() - mtime(path.join(dir, n)) > DAY).map((n) => path.join(dir, n));
    } },
  { id: 'shots', group: 'logs', label: 'Check screenshots', how: 'delete', safe: true,
    help: 'Pictures the deciders looked at when checking pages. The newest ones are kept by themselves (Automatic cleanup).',
    list: async () => names(SHOT_DIR).map((n) => path.join(SHOT_DIR, n)) },
  { id: 'oldlogs', group: 'logs', label: 'Older logs', how: 'delete', safe: true,
    help: 'The earlier part of logs that grew past the limit, benchmark results and the restart log.',
    list: async () => names(LOGS).filter(LOG_OLD).map((n) => path.join(LOGS, n)).filter(isFile) },
  { id: 'logs', group: 'logs', label: 'Current logs', how: null,
    help: 'What QuorX records while you work: commands, approvals, decider checks, replies. Each one starts afresh past the size limit in Automatic cleanup.',
    list: async () => names(LOGS).filter((n) => !LOG_OLD(n)).map((n) => path.join(LOGS, n)).filter(isFile) },
  { id: 'trash', group: 'trash', label: 'Deleted chats and skills', how: 'recycle',
    help: 'Kept here so you can bring them back.',
    list: async () => trashEntries(path.join(DATA, 'trash')) },
];
// A project's .quorx folder, part by part. Older undo history keeps the newest `keep` replies' copies.
const PROJECT_PARTS = [
  { part: 'scratch', label: 'Research & scratch', how: 'recycle', help: 'The agent\'s research scripts, downloads, scrapes and test files.' },
  { part: 'trash', label: 'Agent trash', how: 'recycle', help: 'Files the agent deleted or replaced, kept so you can take them back.' },
  { part: 'checkpoints', label: 'Older undo history', how: 'recycle', help: 'Copies for ↶ Undo of replies older than the newest ones you keep.' },
  { part: 'objects', label: 'Command snapshots', how: 'delete', help: 'Copies for undoing the last command. The next command takes a fresh snapshot.' },
  { part: 'collected', label: 'Collected pages', how: 'recycle', help: 'Lists the agent collected from web pages.' },
  { part: 'edits', label: 'Picture edits', how: 'recycle', help: 'Working copies from editing pictures.' },
  { part: 'uploads', label: 'Attached documents', how: null, help: 'Documents you attached. Remove them from the chat\'s attachments.' },
  { part: 'index', label: 'Document search index', how: null, help: 'Made once per document; making it again costs money.' },
];
function projectList(root, part, keep) {
  const base = path.join(root, AGENT_DIR);
  if (part === 'objects') return [path.join(base, 'objects'), path.join(base, 'snapindex.json')].filter(exists);
  const dir = path.join(base, part);
  let list = names(dir).map((n) => path.join(dir, n));
  if (part === 'checkpoints') list = list.filter((p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } }).sort((a, b) => checkpointTime(b) - checkpointTime(a)).slice(keep);
  return list.filter((p) => { try { return !fs.lstatSync(p).isSymbolicLink(); } catch { return false; } });
}
// Projects with a reply running: nothing in their .quorx is cleared until it ends.
function busyProjects() {
  const out = new Set();
  for (const r of activeRuns()) { const c = r.chatId ? getChat(r.chatId) : null; if (c?.projectId) out.add(c.projectId); }
  return out;
}
const projectRoot = (p) => p.dir && !p.missing ? p.dir : null;

/** Every part, measured: { home, at, rules, items: [{ id, group, label, help, how, safe, bytes, files, partial?, project?, part?, busy?, missing? }] }. */
export async function measureStorage({ keep = 10 } = {}) {
  const items = [];
  await Promise.all(PARTS.map(async (d) => {
    const paths = await d.list().catch(() => []);
    const s = await sumOf(paths);
    items.push({ id: d.id, group: d.group, label: d.label, help: d.help, how: d.how, safe: !!d.safe, ...s });
  }));
  const busy = busyProjects();
  await Promise.all(listProjects().map(async (p) => {
    const project = { id: p.id, name: p.name, dir: p.dir };
    const root = projectRoot(p);
    if (!root) { items.push({ id: `proj:${p.id}`, group: 'projects', project, missing: true, label: p.name, bytes: 0, files: 0, how: null }); return; }
    for (const d of PROJECT_PARTS) {
      const s = await sumOf(projectList(root, d.part, keep));
      items.push({ id: `proj:${p.id}:${d.part}`, group: 'projects', project, part: d.part, label: d.label, help: d.help, how: d.how, safe: false, busy: busy.has(p.id), ...s });
    }
  }));
  const order = ['cache', 'logs', 'trash', 'projects'];
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  return { home: HOME, at: Date.now(), rules: storageRules(), items };
}
async function sumOf(paths) {
  let bytes = 0, files = 0, partial = false;
  const deadline = Date.now() + 10e3;
  for (const p of paths) { const s = await sizeOf(p, deadline); bytes += s.bytes; files += s.files; partial ||= s.partial; }
  return { bytes, files, ...(partial ? { partial } : {}), count: paths.length };
}

// ---------- clearing ----------
/** Finds a part by id and the paths clearing it would remove (or an error). */
async function findPart(id, keep) {
  const d = PARTS.find((x) => x.id === id);
  if (d) return { def: d, paths: await d.list() };
  const m = /^proj:([\w-]{1,64}):(\w+)$/.exec(String(id));
  const pd = m && PROJECT_PARTS.find((x) => x.part === m[2]);
  if (!pd) return { error: 'nothing to clear by that name' };
  const p = listProjects().find((x) => x.id === m[1]);
  if (!p) return { error: 'no such project' };
  const root = projectRoot(p);
  if (!root) return { error: 'the project\'s folder is not on this computer' };
  if (busyProjects().has(p.id)) return { error: 'a reply is running in this project: wait for it to end, or stop it', busy: true };
  return { def: { ...pd, id }, paths: projectList(root, pd.part, keep) };
}

/**
 * Clears parts the user picked. items: [{ id, expect }] where expect is the size the user was shown: when the part has
 * grown by more than a fifth (and 1 MB) since, it is left and the new size comes back for a new question.
 * → { results: [{ id, bytes, files, removed, wentTo, skipped: [{ path, error }], error?, changed? }] }
 */
export async function clearStorage(items, { keep = 10, auto = false } = {}) {
  if (!auto && !takeStorageLease()) return { error: 'another QuorX using this data folder is cleaning up right now; try again in a minute', busy: true };
  try { return await clearParts(items, { keep, auto }); } finally { if (!auto) dropStorageLease(); }
}
async function clearParts(items, { keep, auto }) {
  const results = [];
  for (const it of items || []) {
    const id = String(it?.id || '');
    const r = await findPart(id, keep);
    if (r.error) { results.push({ id, error: r.error, ...(r.busy ? { busy: true } : {}) }); continue; }
    if (!r.def.how) { results.push({ id, error: 'this part is only shown here' }); continue; }
    const s = await sumOf(r.paths);
    if (it.expect != null && s.bytes > Number(it.expect) * 1.2 + 1e6) { results.push({ id, changed: true, bytes: s.bytes, files: s.files }); continue; }
    const done = await removePaths(r.paths, r.def.how);
    const res = { id, bytes: s.bytes, files: s.files, removed: done.removed, wentTo: done.wentTo, skipped: done.skipped };
    if (done.skipped.length) { const left = await sumOf(done.skipped.map((x) => x.path)); res.bytes = Math.max(0, s.bytes - left.bytes); }
    results.push(res);
    logClear({ auto, id, bytes: res.bytes, files: s.files, wentTo: done.wentTo, skipped: done.skipped.length });
  }
  return { results };
}

// Deletes, or sends to the Recycle Bin, one path at a time; locked ones are left and listed.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
export async function removePaths(paths, how) {
  const skipped = [];
  let removed = 0;
  if (how === 'recycle' && process.platform === 'win32' && process.env.QX_TRASH !== 'delete') {
    const r = await recycle(paths);
    return { removed: r.done.length, skipped: r.failed, wentTo: 'recycle' };
  }
  for (const p of paths) {
    try { await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed++; }
    catch (e) { skipped.push({ path: p, error: LOCKED.has(e.code) ? 'in use' : e.message }); }
  }
  return { removed, skipped, wentTo: 'deleted' };
}

// The Windows Recycle Bin through the shell's own file operation: silent, no questions, except Windows' own warning
// when something can't go to the Recycle Bin (too big, or on a drive without one) and would be deleted for good.
const RECYCLE_PS = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class QxBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Op { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Op op);
  public static int Recycle(string p) {
    var op = new Op { wFunc = 3, pFrom = p + "\\0\\0", fFlags = 0x0040 | 0x0010 | 0x0400 | 0x0004 | 0x4000 };
    int r = SHFileOperation(ref op);
    return r != 0 ? r : (op.fAnyOperationsAborted ? -1 : 0);
  }
}
"@
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @(foreach ($p in $paths) { $r = [QxBin]::Recycle($p); @{ p = $p; r = $r; left = (Test-Path -LiteralPath $p) } })
ConvertTo-Json -InputObject $out -Compress`;
export function recycle(paths) {
  const list = paths.map((p) => path.resolve(p)).filter(exists);
  if (!list.length) return Promise.resolve({ done: [], failed: [] });
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(RECYCLE_PS, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => resolve({ done: [], failed: list.map((p) => ({ path: p, error: e.message })) }));
    ps.on('close', () => {
      let rows = [];
      try { rows = JSON.parse(out.trim() || '[]'); if (!Array.isArray(rows)) rows = [rows]; } catch { /* below */ }
      const byPath = new Map(rows.map((x) => [x.p, x]));
      const done = [], failed = [];
      for (const p of list) {
        const x = byPath.get(p);
        if (x && !x.left) done.push(p);
        else failed.push({ path: p, error: x ? (x.r === 32 ? 'in use' : x.r ? `not allowed (${x.r})` : 'still there') : (err.trim().split('\n')[0] || 'the Recycle Bin did not answer') });
      }
      resolve({ done, failed });
    });
    ps.stdin.end(JSON.stringify(list));
  });
}

function logClear(rec) {
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'storage.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`); } catch { /* best effort */ }
}
/** The newest clears (newest first), for "Recently cleared". */
export function recentClears(limit = 20) {
  try {
    return fs.readFileSync(path.join(LOGS, 'storage.jsonl'), 'utf8').trim().split('\n').slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---------- automatic cleanup ----------
// Two QuorX can share one data folder (the desktop app and `npm start`, or a preview): data/storage.lock names the one
// cleaning now, so they never clear the same files at once. A holder that hasn't renewed it for 2 minutes has gone.
const LEASE = () => path.join(DATA, 'storage.lock');
export function takeStorageLease(t = Date.now()) {
  try {
    const cur = JSON.parse(fs.readFileSync(LEASE(), 'utf8'));
    if (cur.pid !== process.pid && t - cur.at < 120e3) {
      let alive = true; try { process.kill(cur.pid, 0); } catch { alive = false; }
      if (alive) return false;
    }
  } catch { /* no lease yet */ }
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(LEASE(), JSON.stringify({ pid: process.pid, at: t })); } catch { return false; }
  return true;
}
export function dropStorageLease() {
  try { if (JSON.parse(fs.readFileSync(LEASE(), 'utf8')).pid === process.pid) fs.rmSync(LEASE(), { force: true }); } catch { /* not ours */ }
}

/** Trash past its days goes to the Recycle Bin (QuorX's trash and each project's agent trash); check screenshots past the
 * number kept are removed. → { trashed, shots, skipped } */
export async function runRetention(rules = storageRules(), now = Date.now()) {
  if (!takeStorageLease(now)) return { busy: true };
  try {
    const old = now - rules.trashDays * DAY, busy = busyProjects();
    const expired = trashEntries(path.join(DATA, 'trash')).filter((p) => trashedAt(p) < old);
    for (const p of listProjects()) {
      const root = projectRoot(p);
      if (!root || busy.has(p.id)) continue;
      const dir = path.join(root, AGENT_DIR, 'trash');
      for (const n of names(dir)) { const q = path.join(dir, n); if (trashedAt(q) < old) expired.push(q); }
    }
    let trashed = 0, skipped = 0;
    if (expired.length) {
      const s = await sumOf(expired);
      const r = await removePaths(expired, 'recycle');
      trashed = r.removed; skipped = r.skipped.length;
      logClear({ auto: true, id: 'trash-retention', bytes: s.bytes, files: s.files, wentTo: r.wentTo, skipped });
    }
    const shots = pruneShots(rules.shotKeep);
    return { trashed, shots, skipped };
  } finally { dropStorageLease(); }
}

/** Runs the automatic cleanup a little after start, then once a day, while it is turned on. */
export function startStorageRules() {
  const tick = () => { if (storageRules().autoClean) runRetention().catch(() => {}); };
  setTimeout(tick, 90e3).unref();
  setInterval(tick, DAY).unref();
}
