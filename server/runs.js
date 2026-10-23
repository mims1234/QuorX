// Runs live on the server, not in the browser tab that started them. Closing or reloading the page
// no longer stops a reply: the page reattaches and replays what it missed. Every event is also
// written to data/runs/<runId>.jsonl and the loop saves a checkpoint each step, so a reply cut off by
// a harness restart can be resumed from where it stopped.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';
import { externalize } from './blobs.js';
import { rotateLog } from './storagerules.js';

const DIR = path.join(HOME, 'data', 'runs');
fs.mkdirSync(DIR, { recursive: true });
const KEEP_MS = 30 * 60e3;           // finished runs stay in memory this long for late reattaches
const KEEP_FILES_MS = 3 * 864e5;     // run logs and checkpoints on disk: 3 days
export const validRunId = (id) => typeof id === 'string' && /^[\w-]{4,64}$/.test(id);
const logFile = (id) => path.join(DIR, `${id}.jsonl`);
const ckptFile = (id) => path.join(DIR, `${id}.ckpt.json`);

// Old files go on start.
try { for (const f of fs.readdirSync(DIR)) { const p = path.join(DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > KEEP_FILES_MS) fs.rmSync(p, { force: true }); } } catch { /* first run */ }

const runs = new Map(); // runId → { id, chatId, status, events, listeners, ac, started, ended }
const watchers = new Set(); // fn(run, event | null) for every run: null when it ends
/** Watches every run's events (the 🧩 Chrome status); returns a function that stops watching. */
export function onRunEvent(fn) { watchers.add(fn); return () => watchers.delete(fn); }

/**
 * Starts a run in the background. `work(emit, signal)` is the agent loop. Tokens stay in memory
 * (they are many and small); on disk, each step's tokens are written as one combined event.
 */
export function startRun({ runId, chatId, onEnd }, work) {
  const r = { id: runId, chatId: chatId || null, status: 'running', events: [], listeners: new Set(), ac: new AbortController(), started: Date.now(), ended: null };
  runs.set(runId, r);
  let pending = null; // tokens of the current step, not yet on disk
  const disk = (o) => { try { fs.appendFileSync(logFile(runId), JSON.stringify(o) + '\n'); } catch { /* disk full: memory still has it */ } };
  const flush = () => { if (pending) { disk(pending); pending = null; } };
  const emit = (o) => {
    // Screenshots and made media go to the page, the replay buffer and the log as /blob addresses, not base64.
    if (o.t !== 'token' && o.t !== 'think') o = externalize(o);
    r.events.push(o);
    for (const l of r.listeners) l(o);
    for (const w of watchers) { try { w(r, o); } catch { /* a watcher's problem stays its own */ } }
    if (o.t === 'token') { if (pending && pending.step === o.step) pending.text += o.text; else { flush(); pending = { ...o }; } }
    else { flush(); disk(o); }
  };
  // pid: which QuorX runs it, so another one on the same data folder can tell "running elsewhere" from "cut off".
  disk({ t: 'run', runId, chatId, pid: process.pid, at: 0 });
  Promise.resolve().then(() => work(emit, r.ac.signal))
    .catch((e) => {
      const spent = e?.stats ? { stats: e.stats } : {}; // what the reply had spent when it ended (server/agent.js)
      if (!r.ac.signal.aborted) { console.error(e); emit({ t: 'error', msg: e.message, ...spent }); } else emit({ t: 'error', msg: 'Stopped.', stopped: true, ...spent });
    })
    .finally(() => {
      flush();
      r.status = r.ac.signal.aborted ? 'stopped' : 'done';
      r.ended = Date.now();
      for (const l of r.listeners) l(null);
      r.listeners.clear();
      for (const w of watchers) { try { w(r, null); } catch { /* ignore */ } }
      // The result goes into the chat from here too, so it is kept even when no page was there to save it.
      if (onEnd) { try { onEnd(r.events.findLast((e) => e.t === 'done' || e.t === 'error') || null); } catch (e) { console.error(e); } }
      setTimeout(() => runs.delete(runId), KEEP_MS).unref?.();
    });
  return r;
}

export const getRun = (id) => runs.get(id);
export function stopRun(id) { const r = runs.get(id); if (!r || r.status !== 'running') return false; r.ac.abort(); return true; }
export const activeRuns = () => [...runs.values()].filter((r) => r.status === 'running').map((r) => ({ runId: r.id, chatId: r.chatId, started: r.started }));

/** Where a run stands: running here, finished, cut off by a restart (resumable if it left a checkpoint), or unknown. */
export function runStatus(id) {
  const r = runs.get(id);
  if (r) return { status: r.status, events: r.events.length };
  if (!validRunId(id) || !fs.existsSync(logFile(id))) return { status: 'unknown' };
  const events = readLog(id);
  const ended = events.some((e) => e.t === 'done' || e.t === 'error');
  // Not in this process but written to in the last 90 s: another QuorX on the same data folder (the desktop app and
  // a preview, or the MCP server's QuorX) is running it, so it isn't "interrupted" and must not be marked so.
  // A log that names its process settles it at once: that process is gone (a restart), so it was cut off.
  let fresh = false; try { fresh = !ended && Date.now() - fs.statSync(logFile(id)).mtimeMs < 90e3; } catch { /* gone */ }
  if (fresh) { const pid = ownerOf(id); if (pid && (pid === process.pid || !alive(pid))) fresh = false; }
  return { status: ended ? 'done' : fresh ? 'elsewhere' : 'interrupted', resumable: !ended && !fresh && fs.existsSync(ckptFile(id)), events: events.length };
}
// The process that started a run, from its log's first line (older logs don't say).
function ownerOf(id) {
  try {
    const fd = fs.openSync(logFile(id), 'r'), buf = Buffer.alloc(300);
    const n = fs.readSync(fd, buf, 0, 300, 0); fs.closeSync(fd);
    return Number(JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]).pid) || null;
  } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function readLog(id) {
  try { return fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.t !== 'run'); }
  catch { return []; }
}

/**
 * Streams a run to one listener: everything from `from` on, then live events until it ends.
 * Returns an unsubscribe function. `onEvent(null)` means the run is over.
 */
export function follow(id, from, onEvent) {
  const r = runs.get(id);
  if (!r) {
    const events = readLog(id);
    events.slice(from).forEach(onEvent);
    if (!events.some((e) => e.t === 'done' || e.t === 'error')) onEvent({ t: 'interrupted', resumable: fs.existsSync(ckptFile(id)) });
    onEvent(null);
    return () => {};
  }
  r.events.slice(from).forEach(onEvent);
  if (r.status !== 'running') { onEvent(null); return () => {}; }
  r.listeners.add(onEvent);
  return () => r.listeners.delete(onEvent);
}

// ---------- checkpoints for resume ----------
export function saveCheckpoint(id, data) {
  if (!validRunId(id)) return;
  const f = ckptFile(id);
  try { fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f); } catch { /* best effort */ }
}
export function loadCheckpoint(id) {
  if (!validRunId(id)) return null;
  try { return JSON.parse(fs.readFileSync(ckptFile(id), 'utf8')); } catch { return null; }
}
export function dropCheckpoint(id) { if (validRunId(id)) fs.rmSync(ckptFile(id), { force: true }); }

// ---------- scorecard and cost ledger: one row per reply ----------
// Every reply's cost is written here when it ends, however it ends (finished, stopped, failed), so a
// project's spend still counts replies whose chat was never saved with its cost or was deleted.
const SCORE = path.join(HOME, 'logs', 'runs.jsonl');
export const ledger = new Map(); // runId → { project, cost, at (ms, when it ended) }
try {
  for (const l of fs.readFileSync(SCORE, 'utf8').split('\n')) {
    try { const r = JSON.parse(l); if (r.runId && r.project) ledger.set(r.runId, { project: r.project, cost: Number(r.cost) || 0, at: Date.parse(r.ts) || 0 }); } catch { /* skip a bad line */ }
  }
} catch { /* no replies yet */ }
export function recordRun(row) {
  if (row.runId && row.project) ledger.set(row.runId, { project: row.project, cost: Number(row.cost) || 0, at: Date.parse(row.ts) || Date.now() });
  try { fs.mkdirSync(path.dirname(SCORE), { recursive: true }); rotateLog(SCORE); fs.appendFileSync(SCORE, JSON.stringify(row) + '\n'); } catch { /* best effort */ }
}
/** The rows of logs/runs.jsonl from the last `days`: every reply, and document reading (kind 'docs'). */
export function scoreRows(days = 14) {
  const since = Date.now() - days * 864e5;
  try { return fs.readFileSync(SCORE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && Date.parse(r.ts) >= since); } catch { return []; }
}
/** Per-model totals over the last `days`: replies, how they ended, checks passed, steps, cost and time. */
export function scorecard(days = 14) {
  const rows = scoreRows(days);
  const by = {};
  for (const r of rows) {
    if (r.kind) continue; // reading documents ('docs') and code reviews ('review'): in the ledger and budgets, not a reply
    const m = (by[r.model] ??= { model: r.model, replies: 0, stops: {}, checked: 0, passed: 0, steps: 0, tools: 0, cost: 0, ms: 0, retries: 0, trimmed: 0, changedFiles: 0, looksFirst: 0, started: 0 });
    m.replies++; m.stops[r.stop] = (m.stops[r.stop] || 0) + 1;
    if (r.verify) { m.checked++; if (r.verify.ok) m.passed++; }
    m.steps += r.steps || 0; m.tools += r.tools || 0; m.cost += r.cost || 0; m.ms += r.ms || 0; m.retries += r.retries || 0; m.trimmed += r.trimmed ? 1 : 0; m.changedFiles += r.changed || 0;
    // Replies that wrote something: how many steps only read or looked first (rows from before 0.2.7 have no count).
    if (r.firstWrite != null && r.looksFirst != null) { m.started++; m.looksFirst += r.looksFirst; }
  }
  return Object.values(by).map((m) => ({ ...m, avgSteps: +(m.steps / m.replies).toFixed(1), avgCost: +(m.cost / m.replies).toFixed(5), avgSecs: +(m.ms / m.replies / 1000).toFixed(1), passRate: m.checked ? +(m.passed / m.checked).toFixed(2) : null, avgLooksFirst: m.started ? +(m.looksFirst / m.started).toFixed(1) : null }))
    .sort((a, b) => b.replies - a.replies);
}
