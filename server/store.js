// Chat history and projects on disk: one JSON file per chat in data/chats, projects in
// data/projects.json. Deleting a chat moves it to data/trash; project folders are never deleted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { HOME, ROOT } from './openrouter.js';
import { externalize } from './blobs.js';

const DIR = path.join(HOME, 'data', 'chats');
const TRASH = path.join(HOME, 'data', 'trash');
export const WORKSPACES = path.join(HOME, 'workspaces');
fs.mkdirSync(DIR, { recursive: true });
// Nothing new goes into the harness's own folder: projects live in folders the user picks. (workspaces/ only holds
// projects from before that rule, until they get a folder.)
const DOCS = [path.join(os.homedir(), 'Documents'), os.homedir()].find((d) => fs.existsSync(d));
export const SCRATCH_HOME = path.join(DOCS, 'QuorX', 'Scratch');
// True for a folder inside the harness itself (the app's folder or its data folder): projects may not live there.
export const insideHarness = (d) => !!d && [HOME, ROOT].some((h) => { const a = path.resolve(d).toLowerCase(), b = path.resolve(h).toLowerCase(); return a === b || a.startsWith(b + path.sep); });

export const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/i.test(id);

// ---------- projects: a folder that many chats can work in ----------
// path = null means the default folder workspaces/<id>; otherwise any folder the user chose.
const PROJECTS = path.join(HOME, 'data', 'projects.json');
// Read once and kept until projects.json changes; whether each folder still exists is looked at again every 2 s.
// (Many requests ask for the list, some once per project: re-reading it each time made 200 projects take minutes.)
let PCACHE = null; // { key, at, list }
const writeProjects = (list) => { fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2)); PCACHE = null; };
export function listProjects() {
  let key = '';
  try { const st = fs.statSync(PROJECTS); key = `${st.size}:${st.mtimeMs}`; } catch { /* none yet */ }
  if (!PCACHE || PCACHE.key !== key || Date.now() - PCACHE.at > 2000) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(PROJECTS, 'utf8')); } catch (e) { if (e.code && e.code !== 'ENOENT') throw new Error(`QuorX can't read its project list (${e.code}). Your projects are safe; restart QuorX to repair the data folder.`); }
    if (!list.some((p) => p.id === 'scratch')) list.unshift({ id: 'scratch', name: 'Scratch', path: null, created: Date.now() });
    // A folder the user chose can be moved or deleted outside the app: say so instead of quietly making an empty one.
    // needsFolder: a project whose files sit inside the harness (no folder picked, or one inside the app): it must pick a folder.
    PCACHE = { key, at: Date.now(), list: list.map((p) => ({ ...p, dir: p.path || path.join(WORKSPACES, p.id), missing: !!p.path && !fs.existsSync(p.path), needsFolder: !p.path || insideHarness(p.path) })) };
  }
  return PCACHE.list.map((p) => ({ ...p }));
}
// Scratch moves out of the harness once: to Documents\QuorX\Scratch, with its old files copied over.
(function adoptScratch() {
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(PROJECTS, 'utf8')); } catch (e) { if (e.code && e.code !== 'ENOENT') throw new Error(`QuorX can't read its project list (${e.code}). Your projects are safe; restart QuorX to repair the data folder.`); }
    const sc = list.find((p) => p.id === 'scratch');
    if (sc?.path) return;
    fs.mkdirSync(SCRATCH_HOME, { recursive: true });
    const old = path.join(WORKSPACES, 'scratch');
    if (fs.existsSync(old)) fs.cpSync(old, SCRATCH_HOME, { recursive: true, force: false, errorOnExist: false });
    if (sc) sc.path = SCRATCH_HOME; else list.unshift({ id: 'scratch', name: 'Scratch', path: SCRATCH_HOME, created: Date.now() });
    fs.mkdirSync(path.dirname(PROJECTS), { recursive: true });
    writeProjects(list);
  } catch { /* Scratch stays where it is until next start */ }
})();
const rawProjects = () => listProjects().map(({ dir: _d, missing: _m, needsFolder: _n, ...p }) => p);
// A project is an existing folder on this computer, and its name is always that folder's name: it changes only
// when the project moves to another folder. (Scratch keeps its built-in name and folder.)
export function saveProject({ id, path: dir }) {
  if (!validId(id)) throw new Error('bad project id');
  const list = rawProjects();
  const i = list.findIndex((p) => p.id === id);
  if (dir) {
    if (!path.isAbsolute(dir)) throw new Error('the folder must be an absolute path, e.g. D:/Coding/my-app');
    const real = path.resolve(dir);
    if (real === path.parse(real).root) throw new Error('pick a project folder, not a whole drive');
    if (insideHarness(real)) throw new Error('that folder is inside QuorX itself: pick a folder of your own, outside the app');
    if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) throw new Error(`there is no folder at ${real}: pick one that exists`);
    dir = real;
  } else if (i < 0 && id !== 'scratch') throw new Error('pick a folder on this PC for the project');
  const name = dir ? path.basename(dir) : list[i]?.name || 'Scratch';
  const p = { ...(list[i] || { created: Date.now() }), id, name: name.slice(0, 80), path: dir === undefined || dir === null || dir === '' ? list[i]?.path ?? null : dir };
  // A project leaving the harness's folder: its files come along (copied, never overwriting; the old copy stays).
  const from = i >= 0 && p.path && (!list[i].path || insideHarness(list[i].path)) ? list[i].path || path.join(WORKSPACES, id) : null;
  if (from && fs.existsSync(from)) { try { fs.cpSync(from, p.path, { recursive: true, force: false, errorOnExist: false }); } catch { /* best effort */ } }
  if (i >= 0) list[i] = p; else list.push(p);
  writeProjects(list);
  return { ...p, dir: p.path || path.join(WORKSPACES, id) };
}
// Deleting a project forgets it and moves its chats to data/trash. Its folder is never touched.
export function forgetProject(id) {
  if (id === 'scratch' || !listProjects().some((p) => p.id === id)) return false;
  for (const c of listChats()) if (c.projectId === id) trashChat(c.id);
  const list = rawProjects().filter((p) => p.id !== id);
  writeProjects(list);
  return true;
}
export function projectDir(id) {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error(`no project ${id}`);
  if (p.missing) throw Object.assign(new Error(`the folder of project "${p.name}" is missing (${p.dir}); it may have been moved, renamed or deleted. Reselect it in the project settings.`), { code: 'FOLDER_MISSING', projectId: id });
  fs.mkdirSync(p.dir, { recursive: true });
  return p.dir;
}
const file = (id) => path.join(DIR, `${id}.json`);
// A chat holds one agent ({ setup, messages, artifacts }). Older saves had layouts of agent columns.
export const agentsOf = (c) => (c.agent ? [c.agent] : c.layouts?.[c.mode] || c.layouts?.chat || []);

// ---------- per-chat summaries, cached ----------
// Each chat file is parsed once; the summary is reused until the file changes (by size and mtime).
// The sidebar and the costs view both read these, so neither re-parses every chat on every request.
const SUMMARIES = new Map(); // file name → { key, s }
// What a reply cost: its totals, or for one that ended without them (an error, a dropped connection, a restart),
// the calls it made, from its steps. Those were paid for, so they count like any other.
function replySpend(m, prev = null) {
  if (m.stats) return { cost: ownCost(m.stats, prev?.stats), byModel: m.stats.byModel || {} };
  // A reply still running is counted by the budget ledger as it goes, not here. The page saves it with live: false
  // but runActive: true (a chat saved mid-reply, e.g. by /usage); counting its steps too doubled it while it ran.
  if (m.role !== 'assistant' || m.live || m.runActive || !Array.isArray(m.trace)) return null;
  let cost = 0, n = 0; const byModel = {};
  for (const e of m.trace) {
    if ((e?.t !== 'llm_done' && e?.t !== 'helper_done') || !(Number(e.cost) >= 0)) continue;
    const v = Number(e.cost) || 0, model = e.actual || e.model || '?';
    cost += v; n++; (byModel[model] ||= { cost: 0 }).cost += v;
  }
  return n ? { cost, byModel } : null;
}
/**
 * What a reply spent itself. Before 0.2.12, "Continue" after the step limit started the new reply's total from the
 * checkpoint, so it also held the reply before it (its per-model costs did not). Such a total, minus the earlier
 * reply's, is this reply's own. Everything else is its total as saved.
 */
export function ownCost(stats, prevStats) {
  const cost = Number(stats?.cost) || 0;
  if (!stats?.resumed || !prevStats) return cost;
  const models = Object.values(stats.byModel || {}).reduce((n, v) => n + (Number(v.cost) || 0), 0);
  const prev = Number(prevStats.cost) || 0;
  return prev > 0 && Math.abs(cost - prev - models) < 1e-6 ? cost - prev : cost;
}
function summarise(c) {
  const lay = agentsOf(c);
  const msgs = lay.flatMap((col) => col.messages || []);
  const all = c.agent ? msgs : Object.values(c.layouts || {}).flatMap((l) => l.flatMap((col) => col.messages || []));
  const lastBot = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
  // Spend over time (for today / 7 days) and per model, plus calls made outside a reply (mic).
  const spend = [], models = {};
  let prev = null;
  for (const m of msgs) {
    const r = replySpend(m, prev), cost = r?.cost || 0;
    if (m.role === 'assistant') prev = m;
    if (cost) spend.push([m.doneAt || m.at || 0, cost]);
    for (const [model, v] of Object.entries(r?.byModel || {})) models[model] = (models[model] || 0) + (v.cost || 0);
  }
  for (const x of c.agent?.extraUsage || []) { spend.push([x.at || 0, x.cost || 0]); models[x.model] = (models[x.model] || 0) + (x.cost || 0); }
  return {
    id: c.id, title: String(c.title || 'New chat'), mode: c.mode, projectId: c.projectId || 'scratch', created: c.created, updated: c.updated,
    lastAt: Math.max(0, ...all.map((m) => m.doneAt || m.at || 0)) || c.lastAt || c.created || c.updated,
    agents: lay.map((col) => col.name), model: lay[0]?.setup?.model || null, preview: String(lastBot?.content || '').replace(/\s+/g, ' ').slice(0, 90),
    messages: msgs.filter((m) => m.role === 'user').length, cost: spend.reduce((n, [, v]) => n + v, 0),
    artifacts: lay.reduce((n, col) => n + Object.keys(col.artifacts || {}).length, 0), spend, models,
    // Replies whose cost is saved in this file (the budget ledger counts the others itself).
    runIds: [...msgs.filter((m) => m.runId && replySpend(m)).map((m) => m.runId), ...(c.agent?.extraUsage || []).filter((x) => x.runId).map((x) => x.runId)],
  };
}
// ---------- the chat index ----------
// Every chat's summary stays in memory and is saved to data/index/chats.json, so the sidebar, budgets and costs never
// read every chat file again, and a restart doesn't either. A chat written or deleted here updates its entry at once.
// A change from outside (another QuorX on the same data folder, a restored backup) is seen by a folder watcher, and a
// background pass every minute catches anything the watcher missed, a few hundred files at a time, so it never holds
// the server up. Only the very first start, with no saved index yet, reads every chat before answering.
const INDEX = path.join(HOME, 'data', 'index', 'chats.json');
const INDEX_V = 2; // 2: each entry also names the pictures its chat uses
// The pictures a chat names (/blob/…), for what deleting it would free.
const blobsIn = (text) => [...new Set(String(text).match(/\/blob\/[0-9a-f]{64}\.[a-z0-9]{2,5}/g) || [])].map((x) => x.slice(6));
const keyOf = (st) => `${st.size}:${st.mtimeMs}`;
let indexReady = false, indexVersion = 0, indexSaved = 0, reconcileAt = 0, reconciling = false, saveTimer = null;
const dirty = new Set(); // file names the watcher saw change
const changed = () => { indexVersion++; LIST = null; ROLLUP = null; if (!saveTimer) saveTimer = setTimeout(saveIndex, 15e3).unref?.() ?? null; };
function readSummary(f) {
  try {
    const p = path.join(DIR, f), st = fs.statSync(p), key = keyOf(st), hit = SUMMARIES.get(f);
    if (hit?.key === key) return;
    const text = fs.readFileSync(p, 'utf8');
    SUMMARIES.set(f, { key, s: summarise(JSON.parse(text)), blobs: blobsIn(text) }); changed();
  } catch (e) { if (e.code === 'ENOENT' && SUMMARIES.delete(f)) changed(); /* else: being written right now, next time */ }
}
function loadIndex() {
  indexReady = true;
  try {
    const saved = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (saved?.v === INDEX_V && saved.entries) { for (const [f, e] of Object.entries(saved.entries)) SUMMARIES.set(f, e); changed(); indexSaved = indexVersion; reconcileAt = Date.now() - 57e3; return; } // catch up 3 s after start
  } catch { /* none yet, or unreadable: read every chat once */ }
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) readSummary(f);
  reconcileAt = Date.now();
  saveIndex({ now: true });
}
// Saved a while after a change, written in the background (and at once when QuorX exits).
let saving = null;
function saveIndex({ now = false } = {}) {
  clearTimeout(saveTimer); saveTimer = null;
  if (indexSaved === indexVersion || (saving && !now)) return saving;
  const v = indexVersion, text = JSON.stringify({ v: INDEX_V, at: Date.now(), entries: Object.fromEntries(SUMMARIES) });
  const done = () => { indexSaved = Math.max(indexSaved, v); saving = null; };
  try {
    fs.mkdirSync(path.dirname(INDEX), { recursive: true });
    if (now) { fs.writeFileSync(INDEX + '.tmp', text); fs.renameSync(INDEX + '.tmp', INDEX); done(); return null; }
  } catch { return null; }
  saving = fs.promises.writeFile(INDEX + '.tmp2', text).then(() => fs.promises.rename(INDEX + '.tmp2', INDEX)).then(done, () => { saving = null; });
  return saving;
}
// The background pass: files that appeared, went or changed since the index last looked.
async function reconcile() {
  if (reconciling) return;
  reconciling = true; reconcileAt = Date.now();
  try {
    const names = (await fs.promises.readdir(DIR)).filter((f) => f.endsWith('.json'));
    const seen = new Set(names);
    for (const f of [...SUMMARIES.keys()]) if (!seen.has(f)) { SUMMARIES.delete(f); changed(); }
    // Small batches with a pause between them: the file reads share a few threads with every request's own reads.
    for (let i = 0; i < names.length; i += 32) {
      await Promise.all(names.slice(i, i + 32).map(async (f) => {
        try {
          const p = path.join(DIR, f), st = await fs.promises.stat(p), key = keyOf(st);
          if (SUMMARIES.get(f)?.key === key) return;
          const text = await fs.promises.readFile(p, 'utf8');
          SUMMARIES.set(f, { key, s: summarise(JSON.parse(text)), blobs: blobsIn(text) }); changed();
        } catch { /* being written right now: next pass */ }
      }));
      await new Promise((r) => setTimeout(r, 4)); // let requests through between batches
    }
  } finally { reconciling = false; }
}
let watcher = null;
function watchChats() {
  if (watcher) return;
  try { watcher = fs.watch(DIR, (_, f) => { if (f && String(f).endsWith('.json')) dirty.add(String(f)); }); watcher.on('error', () => { watcher = null; }); watcher.unref?.(); } catch { /* the minute pass still catches up */ }
}
process.on('exit', () => { if (indexReady) saveIndex({ now: true }); });
/** Saves the chat index now (it otherwise saves 15 s after a change, and on exit). For tests. */
export const flushChatIndex = () => saveIndex({ now: true });
let LIST = null, ROLLUP = null;
function summaries() {
  if (!indexReady) { loadIndex(); watchChats(); }
  for (const f of dirty) readSummary(f);
  dirty.clear();
  if (!reconciling && Date.now() - reconcileAt > 60e3) reconcile().catch(() => {});
  return (LIST ??= [...SUMMARIES.values()].map((x) => x.s));
}
// A short summary per chat for the sidebar, without reading whole message histories into the page.
let SLIM = null, slimV = -1;
export function listChats() {
  const all = summaries();
  if (slimV !== indexVersion) { SLIM = all.map(({ spend: _s, models: _m, runIds: _r, ...c }) => c).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)); slimV = indexVersion; }
  return SLIM;
}
// Per project, worked out once per change: what its saved chats cost, which replies those costs come from, how many
// chats it has (and how many have messages), and when it was last used.
function rollups() {
  const all = summaries();
  if (ROLLUP) return ROLLUP;
  const m = new Map();
  for (const c of all) {
    const r = m.get(c.projectId) || m.set(c.projectId, { cost: 0, runIds: new Set(), chats: 0, active: 0, lastAt: 0 }).get(c.projectId);
    r.cost += c.cost; r.chats++; if (c.messages) r.active++; r.lastAt = Math.max(r.lastAt, c.lastAt || 0);
    for (const id of c.runIds) r.runIds.add(id);
  }
  return (ROLLUP = m);
}
// What a project's saved chats cost, and which replies those costs come from.
export function projectChatsSpend(projectId) {
  const r = rollups().get(projectId);
  return { cost: r?.cost || 0, runIds: r?.runIds || new Set() };
}
/** Per-project counts for the sidebar: { [projectId]: { chats, active, cost, lastAt } }. */
export function projectChatStats() {
  return Object.fromEntries([...rollups()].map(([id, r]) => [id, { chats: r.chats, active: r.active, cost: r.cost, lastAt: r.lastAt }]));
}
/**
 * The sidebar's chats: each project's newest `per` chats with messages, plus any chat asked for by id (open panes),
 * and every project's counts. A project's older chats, and search, come a page at a time (chatPage).
 */
export function sidebarChats({ per = 30, ids = [] } = {}) {
  const want = new Set(ids), n = new Map(), out = [];
  for (const c of listChats()) {
    const k = c.projectId || 'scratch', i = n.get(k) || 0;
    if (want.has(c.id) || (c.messages > 0 && i < per)) { out.push(c); if (c.messages > 0) n.set(k, i + 1); }
  }
  return { chats: out, stats: projectChatStats(), total: listChats().length };
}
/** One page of chats, newest first: in a project, or matching words in the title or preview across all projects. */
export function chatPage({ project = '', q = '', offset = 0, limit = 50 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const list = listChats().filter((c) => c.messages > 0 && (!project || (c.projectId || 'scratch') === project) && words.every((w) => `${c.title} ${c.preview || ''}`.toLowerCase().includes(w)));
  offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(200, Number(limit) || 50));
  return { total: list.length, offset, chats: list.slice(offset, offset + limit) };
}
// A chat written by this QuorX: its entry updated at once (the watcher would also see it, a moment later).
function indexWrite(id, doc, text) {
  const f = `${id}.json`;
  try { SUMMARIES.set(f, { key: keyOf(fs.statSync(path.join(DIR, f))), s: summarise(doc), blobs: blobsIn(text) }); changed(); } catch { dirty.add(f); }
}
/** For what deleting a chat frees: its file's size and the pictures it names, from the index (null: no such chat). */
export function chatPictureRefs(id) {
  summaries();
  const e = SUMMARIES.get(`${id}.json`);
  return e ? { size: Number(String(e.key).split(':')[0]) || 0, blobs: e.blobs || [] } : null;
}
// How many saved chats name each picture, worked out once per change.
let REFS = null, refsV = -1;
export function pictureRefCounts() {
  summaries();
  if (refsV !== indexVersion) { REFS = new Map(); for (const e of SUMMARIES.values()) for (const b of e.blobs || []) REFS.set(b, (REFS.get(b) || 0) + 1); refsV = indexVersion; }
  return REFS;
}
// The project's budget in dollars, or null for none. Checks (never below what is spent) are in budget.js.
export function setProjectBudget(id, budget) {
  const list = rawProjects();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('no such project');
  p.budget = budget;
  writeProjects(list);
  return p;
}

// The colour of the project's name ("#rrggbb"), or null for the automatic one picked from its name.
export function setProjectColor(id, color) {
  if (color != null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('colour must look like #a1b2c3');
  const list = rawProjects();
  let p = list.find((x) => x.id === id);
  if (!p && id === 'scratch') { p = listProjects().find((x) => x.id === 'scratch'); p = { id: p.id, name: p.name, path: p.path, created: p.created }; list.unshift(p); }
  if (!p) throw new Error('no such project');
  if (color) p.color = color.toLowerCase(); else delete p.color;
  writeProjects(list);
  return { id: p.id, color: p.color || null };
}

// Pinned (up to 3, kept at the top in the order they were pinned) and archived (out of the sidebar, the start screen
// and the main search; found again under Archived). Archiving a project unpins it.
export const MAX_PINNED = 3;
export function setProjectFlags(id, { pinned, archived } = {}) {
  const list = rawProjects();
  let p = list.find((x) => x.id === id);
  if (!p && id === 'scratch') { p = listProjects().find((x) => x.id === 'scratch'); p = { id: p.id, name: p.name, path: p.path, created: p.created }; list.unshift(p); }
  if (!p) throw new Error('no such project');
  if (archived === true) { p.archived = Date.now(); delete p.pinned; }
  else if (archived === false) delete p.archived;
  if (pinned === true && !p.pinned) {
    if (p.archived) throw new Error('unarchive the project to pin it');
    if (list.filter((x) => x.pinned && !x.archived).length >= MAX_PINNED) throw new Error(`up to ${MAX_PINNED} projects can be pinned: unpin one first`);
    p.pinned = Date.now();
  } else if (pinned === false) delete p.pinned;
  writeProjects(list);
  return { id: p.id, pinned: p.pinned || null, archived: p.archived || null };
}

export function getChat(id) {
  if (!validId(id) || !fs.existsSync(file(id))) return null;
  return JSON.parse(fs.readFileSync(file(id), 'utf8'));
}

// ---------- Steps of older replies, in files of their own ----------
// A long chat's file would hold every step of every reply and be read and written whole on each save. So a finished
// reply older than the newest TRACE_KEEP, with at least TRACE_MIN steps, keeps its steps in data/traces/<chat>/<run>.json
// and only a note in the chat ({ trace: [], traceRef: { n, bytes } }). The page loads them when that reply is shown
// (GET /api/chats/<id>/trace/<run>). New and running replies always stay in the chat file.
const TRACES = path.join(HOME, 'data', 'traces');
const TRACE_KEEP = 5, TRACE_MIN = 50;
const RUN_ID = /^[\w-]{1,80}$/;
const traceFile = (id, runId) => path.join(TRACES, id, `${runId}.json`);
function splitTraces(id, doc) {
  const msgs = doc?.agent?.messages;
  if (!Array.isArray(msgs)) return doc;
  const replies = msgs.map((m, i) => (m?.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  let out = null;
  for (const i of replies.slice(0, Math.max(0, replies.length - TRACE_KEEP))) {
    const m = msgs[i];
    if (!Array.isArray(m.trace) || m.trace.length < TRACE_MIN || !RUN_ID.test(String(m.runId || '')) || !m.stats || m.stats.partial || m.live || m.runActive) continue;
    const text = JSON.stringify(m.trace), f = traceFile(id, m.runId);
    try {
      if (!(fs.existsSync(f) && fs.statSync(f).size === Buffer.byteLength(text))) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); }
    } catch { continue; } // couldn't write it: it stays in the chat
    (out ??= msgs.slice())[i] = { ...m, trace: [], traceRef: { n: m.trace.length, bytes: text.length } };
  }
  return out ? { ...doc, agent: { ...doc.agent, messages: out } } : doc;
}
/** A chat for the page. A big one saved before steps were kept apart is split the first time it opens (its rev stays,
 * so a page that has it open goes on saving as before). */
export function getChatForPage(id) {
  const c = getChat(id);
  if (!c) return null;
  try { if (fs.statSync(file(id)).size > 2e6) { const s = splitTraces(id, c); if (s !== c) { writeChat(id, s); return s; } } } catch { /* as it is */ }
  return c;
}
/** One older reply's steps (null: none kept apart). */
export function getTrace(id, runId) {
  if (!validId(id) || !RUN_ID.test(String(runId))) return null;
  try { return JSON.parse(fs.readFileSync(traceFile(id, runId), 'utf8')); } catch { return null; }
}
/** The chat with every reply's steps back inside it (for a backup, which must hold whole chats). */
export function getWholeChat(id) {
  const c = getChat(id);
  for (const m of c?.agent?.messages || []) if (m?.traceRef && !m.trace?.length) { const t = getTrace(id, m.runId); if (t) { m.trace = t; delete m.traceRef; } }
  return c;
}

// ---------- saving: the whole chat, or only what changed ----------
// Every write stamps the chat with a new `rev`. The page then sends only the messages and artifacts that changed
// since the save it last heard back about (patchChat). If the file has moved on since (another tab, another
// copy of the harness on the same data, an older page that saves whole chats), the patch is refused and the
// page sends the whole chat again. The file stays one plain JSON chat either way.
let revs = 0;
const newRev = () => `${Date.now().toString(36)}-${(++revs).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// The last few chats written, so a patch needn't read and parse the file again while it is unchanged on disk.
const LAST = new Map(); // id → { key, doc }
const stamp = (id) => { try { const st = fs.statSync(file(id)); return `${st.size}:${st.mtimeMs}`; } catch { return null; } };
function writeChat(id, doc) {
  doc = splitTraces(id, doc);
  const text = JSON.stringify(doc);
  fs.writeFileSync(file(id) + '.tmp', text);
  fs.renameSync(file(id) + '.tmp', file(id));
  if (indexReady) indexWrite(id, doc, text);
  LAST.delete(id); LAST.set(id, { key: stamp(id), doc });
  if (LAST.size > 8) LAST.delete(LAST.keys().next().value);
  return { id, updated: doc.updated, rev: doc.rev };
}
/**
 * ⚙ Settings → Storage → Compact chats: pictures an older chat still keeps inside its file move to data/blobs, where
 * every picture is stored once. Nothing else changes (not its rev or time, so open pages go on saving as before).
 * Every picture it now names is checked on disk, by its content hash, before the file is replaced.
 * → { before, after, blobs (bytes of pictures newly written) } or null when there is no such chat.
 */
export function compactChat(id) {
  if (!validId(id) || !fs.existsSync(file(id))) return null;
  const was = stamp(id), before = fs.statSync(file(id)).size;
  const doc = getChat(id), out = externalize(doc);
  if (out === doc) return { before, after: before, blobs: 0 };
  const known = new Set(JSON.stringify(doc).match(/\/blob\/[0-9a-f]{64}\.[a-z0-9]{2,5}/g) || []);
  let blobs = 0;
  for (const ref of new Set(JSON.stringify(out).match(/\/blob\/[0-9a-f]{64}\.[a-z0-9]{2,5}/g) || [])) {
    if (known.has(ref)) continue;
    const name = ref.slice(6), buf = fs.readFileSync(path.join(HOME, 'data', 'blobs', name));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== name.split('.')[0]) throw new Error(`picture ${name} did not save correctly`);
    blobs += buf.length;
  }
  if (stamp(id) !== was) throw new Error('the chat changed while it was being compacted; try again');
  writeChat(id, out);
  return { before, after: fs.statSync(file(id)).size, blobs };
}
function currentChat(id) {
  const hit = LAST.get(id);
  return hit && hit.key && hit.key === stamp(id) ? hit.doc : getChat(id);
}

// A finished reply's result, once on disk, stays: a save from a page whose copy of that reply lacks it (a page that
// lost track of the run, or a stale copy) keeps the text, note and totals the run left.
const RESULT = ['content', 'note', 'stats', 'doneAt'];
function keepResults(old, messages) {
  if (!Array.isArray(old) || !Array.isArray(messages)) return messages;
  const done = new Map(old.filter((m) => m?.role === 'assistant' && m.runId && m.stats && !m.stats.partial).map((m) => [m.runId, m]));
  if (!done.size) return messages;
  return messages.map((m) => {
    const o = m?.role === 'assistant' && (!m.stats || m.stats.partial) ? done.get(m.runId) : null;
    if (!o) return m;
    const kept = { ...m, runActive: false };
    for (const k of RESULT) if (o[k] != null && (k !== 'content' || !m.content)) kept[k] = o[k];
    delete kept.error; delete kept.resumable;
    return kept;
  });
}

export function saveChat(id, chat) {
  if (!validId(id)) throw new Error('bad chat id');
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw new Error('a chat must be an object');
  let old = null; try { old = currentChat(id); } catch { /* unreadable: saved over */ }
  const created = Number(chat.created) || old?.created || Date.now();
  // Big pictures and media (older chats kept every screenshot inline) are stored once as blobs.
  const doc = { ...externalize(chat), id, created, updated: Date.now(), rev: newRev() };
  if (doc.agent?.messages) doc.agent = { ...doc.agent, messages: keepResults(old?.agent?.messages, doc.agent.messages) };
  return writeChat(id, doc);
}

// When a reply ends, its result goes into its chat from the server (server.js), so it is kept even when the page
// that started it was closed, reloaded or lost track of it. A page that already saved the result is left alone.
export function settleReply(chatId, runId, end) {
  if (!validId(chatId) || !end) return false;
  const chat = currentChat(chatId);
  const i = chat?.agent?.messages?.findIndex((m) => m.role === 'assistant' && m.runId === runId) ?? -1;
  if (i < 0) return false;
  const m = chat.agent.messages[i];
  if (end.t === 'done' ? m.stats && !m.stats.partial && m.content : m.error || m.stats) return false;
  const next = end.t === 'done'
    ? { ...m, content: m.content || String(end.reply || ''), note: end.historyNote, stats: end.stats, doneAt: m.doneAt || Date.now(), live: false, runActive: false }
    : { ...m, error: end.msg || 'The reply ended without an answer.', ...(end.stats ? { stats: { ...end.stats, partial: true } } : {}), live: false, runActive: false };
  if (end.t === 'done') { delete next.error; delete next.resumable; }
  const messages = chat.agent.messages.slice(); messages[i] = next;
  writeChat(chatId, { ...chat, updated: Date.now(), rev: newRev(), agent: { ...chat.agent, messages } });
  return true;
}

// A save of only what changed: { base: the rev it builds on, count: how many messages the chat has now,
// messages: { index: message } for new or changed ones, artifacts: { id: artifact, or null when removed },
// head: the rest of the chat (title, tools, the agent's setup...) only when that changed }.
// Returns { stale: true } when the chat on disk is not the one the patch builds on; the page then saves it whole.
export function patchChat(id, p) {
  if (!validId(id)) throw new Error('bad chat id');
  if (!p || typeof p !== 'object' || typeof p.base !== 'string' || !Number.isInteger(p.count) || p.count < 0) throw new Error('a patch needs base and count');
  const old = currentChat(id);
  if (!old || old.rev !== p.base || !old.agent) return { stale: true, rev: old?.rev || null };
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (p.head != null && !isObj(p.head)) throw new Error('head must be an object');
  // Only the parts sent go through the blob store; the rest is on disk already.
  const { messages: changed = {}, artifacts: arts = {}, head } = externalize({ messages: p.messages, artifacts: p.artifacts, head: p.head });
  const messages = (old.agent.messages || []).slice(0, p.count);
  for (const [k, m] of Object.entries(changed || {})) {
    const i = Number(k);
    if (!/^\d+$/.test(k) || i >= p.count || !isObj(m)) throw new Error(`bad message ${k}`);
    messages[i] = m;
  }
  // A gap means the page and the file disagree about the messages: save whole instead of guessing.
  // (Array.from, since some() skips the holes.)
  if (messages.length !== p.count || Array.from(messages).some((m) => !m)) return { stale: true, rev: old.rev };
  const artifacts = { ...(old.agent.artifacts || {}) };
  for (const [k, a] of Object.entries(arts || {})) {
    if (k === '__proto__') continue;
    if (a === null) delete artifacts[k]; else if (isObj(a)) artifacts[k] = a; else throw new Error(`bad artifact ${k}`);
  }
  const top = head || old;
  const created = Number(top.created) || old.created || Date.now();
  return writeChat(id, { ...top, id, created, updated: Date.now(), rev: newRev(), agent: { ...(head ? head.agent : old.agent), messages: keepResults(old.agent.messages, messages), artifacts } });
}

export function trashChat(id) {
  LAST.delete(id);
  if (!validId(id) || !fs.existsSync(file(id))) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(TRASH, { recursive: true });
  fs.renameSync(file(id), path.join(TRASH, `${id}-${stamp}.json`));
  // Its older replies' steps go with it (data/trash/traces/<chat>-<when>), to come back or be emptied together.
  try { if (fs.existsSync(path.join(TRACES, id))) { fs.mkdirSync(path.join(TRASH, 'traces'), { recursive: true }); fs.renameSync(path.join(TRACES, id), path.join(TRASH, 'traces', `${id}-${stamp}`)); } } catch { /* stays; the chat is gone either way */ }
  if (SUMMARIES.delete(`${id}.json`)) changed();
  return true; // the project folder is shared with other chats, so it stays
}

// ---------- costs: per chat and per project, with today / last 7 days / all time ----------
// The overview sends every project's totals but only its top `per` chats; the rest come a page at a time.
function costRows() {
  const now = Date.now(), dayStart = new Date(new Date().toDateString()).getTime(), weekAgo = now - 7 * 864e5;
  return summaries().filter((c) => c.messages).map((c) => {
    let today = 0, week = 0;
    for (const [t, v] of c.spend) { if (t >= dayStart) today += v; if (t >= weekAgo) week += v; }
    return { id: c.id, title: c.title, projectId: c.projectId, messages: c.messages, cost: c.cost, today, week, lastAt: c.lastAt, models: c.models };
  });
}
const SORT = { cost: (a, b) => b.cost - a.cost, today: (a, b) => b.today - a.today || b.cost - a.cost, messages: (a, b) => b.messages - a.messages, name: (a, b) => a.title.localeCompare(b.title), recent: (a, b) => (b.lastAt || 0) - (a.lastAt || 0) };
export function costSummary({ per = 5, sort = 'cost' } = {}) {
  const rows = costRows(), by = SORT[sort] || SORT.cost;
  const projects = Object.fromEntries(listProjects().map((p) => [p.id, { id: p.id, name: p.name, dir: p.dir, color: p.color || null, cost: 0, today: 0, week: 0, messages: 0, chatCount: 0, lastAt: 0, chats: [] }]));
  const total = { cost: 0, today: 0, week: 0, chats: rows.length };
  for (const r of rows) {
    const p = projects[r.projectId] || (projects[r.projectId] = { id: r.projectId, name: `${r.projectId} (removed)`, cost: 0, today: 0, week: 0, messages: 0, chatCount: 0, chats: [] });
    p.chats.push(r); p.chatCount++; p.lastAt = Math.max(p.lastAt || 0, r.lastAt || 0);
    for (const k of ['cost', 'today', 'week', 'messages']) p[k] += r[k];
    for (const k of ['cost', 'today', 'week']) total[k] += r[k];
  }
  for (const p of Object.values(projects)) p.chats = p.chats.sort(by).slice(0, Math.max(1, Math.min(50, per)));
  const PSORT = { cost: (a, b) => b.cost - a.cost, today: (a, b) => b.today - a.today || b.cost - a.cost, messages: (a, b) => b.messages - a.messages, name: (a, b) => a.name.localeCompare(b.name), recent: (a, b) => (b.lastAt || 0) - (a.lastAt || 0) };
  return { total, projects: Object.values(projects).filter((p) => p.chatCount).sort(PSORT[sort] || PSORT.cost) };
}
// One page of chats: in a project, or matching a search across all projects.
export function costChats({ project, q = '', sort = 'cost', offset = 0, limit = 20 } = {}) {
  q = String(q).trim().toLowerCase();
  const list = costRows().filter((r) => (!project || r.projectId === project) && (!q || r.title.toLowerCase().includes(q))).sort(SORT[sort] || SORT.cost);
  offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(100, Number(limit) || 20));
  return { total: list.length, offset, chats: list.slice(offset, offset + limit) };
}
