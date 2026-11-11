// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Everything running in a project, in one list, for the pane's Running tab: dev servers, commands (yours and the
// agent's, including the ones that moved to the background), the agent's own terminals, and your terminal tabs.
// Each row can be stopped from there. The agent keeps working while things run; this is where you see them and
// end what you don't want.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { serverOverview, serverLog, stopServerWait, listServers, serverProc } from './workspace.js';
import { runningJobs, stopJob, jobProc } from './terminal.js';
import { jobUsage, forceKillJob } from './jobhost.js';
import { listBackground } from './bgjobs.js';
import { listTerms, termTail, termStop, termProc } from './agentterm.js';
import { ptyList, ptyClose } from './pty.js';

const tail = (text, n = 4) => String(text || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);

/**
 * { items: [{ id, kind, label, source, chatId, started, status, url?, bg?, tail }], elsewhere: [{ projectId, count }] }
 * kind: 'server' · 'background' (a command that went on running in the background) · 'command' · 'agent-term' · 'your-term'.
 */
export function runningIn(projectId) {
  const items = [];
  for (const s of serverOverview(projectId).filter((x) => x.status !== 'stopped')) {
    items.push({ id: `srv:${s.key}`, kind: 'server', label: s.name, detail: [s.command, ...(s.args || [])].filter(Boolean).join(' '), source: null, chatId: null,
      started: s.started, status: s.status, url: s.url || null, tail: tail(serverLog(s.key)) });
  }
  const bgs = listBackground(projectId);
  for (const j of runningJobs(projectId)) {
    const b = bgs.find((x) => (j.bg && x.id === j.bg) || (x.termJob && x.termJob === j.job));
    items.push({ id: `job:${j.job}`, kind: b ? 'background' : 'command', label: j.label, source: j.source, chatId: j.chatId || b?.chatId || null,
      started: b?.started || j.at, status: 'running', bg: b?.id || null, log: b?.log || null, tab: j.tab || null, tail: j.tail });
  }
  for (const t of listTerms(projectId).filter((x) => x.running)) {
    items.push({ id: `aterm:${t.id}`, kind: 'agent-term', label: t.label, source: 'agent', chatId: t.chatId, started: t.started, status: 'running', tail: termTail(t.id) });
  }
  for (const p of ptyList(projectId)) items.push({ id: `pty:${p.tab}`, kind: 'your-term', label: p.shell, tab: p.tab, source: 'you', chatId: null, started: p.started, status: 'open', tail: [] });
  // Other projects: just how much runs there, so nothing is forgotten.
  const counts = new Map();
  for (const j of runningJobs()) if (j.projectId !== projectId) counts.set(j.projectId, (counts.get(j.projectId) || 0) + 1);
  for (const t of listTerms().filter((x) => x.running && x.projectId !== projectId)) counts.set(t.projectId, (counts.get(t.projectId) || 0) + 1);
  for (const s of listServers().filter((x) => x.status !== 'stopped' && x.projectId !== projectId)) counts.set(s.projectId, (counts.get(s.projectId) || 0) + 1);
  return { items, elsewhere: [...counts].map(([pid, count]) => ({ projectId: pid, count })) };
}

/** Everything running in every project, for the sidebar's Running list: the rows of runningIn, each with its
 *  projectId. Only projects where something runs are asked (the others would read their launch files for nothing). */
export function runningAll(projectIds) {
  const busy = new Set([...runningJobs(), ...listTerms().filter((t) => t.running), ...listServers().filter((s) => s.status !== 'stopped')].map((x) => x.projectId));
  const items = [];
  for (const pid of projectIds) {
    if (!busy.has(pid) && !ptyList(pid).length) continue;
    try { for (const x of runningIn(pid).items) items.push({ ...x, projectId: pid }); } catch { /* that project's own problem */ }
  }
  return items;
}

/** Stops one row. Your terminal tabs close; everything else ends with all it started. */
export async function stopRunning(projectId, id) {
  const [kind, ...rest] = String(id || '').split(':'), key = rest.join(':');
  if (kind === 'srv') return (await stopServerWait(key, 'you')) || { already: true };
  if (kind === 'job') return (await stopJob(key)) || { already: true };
  if (kind === 'aterm') return termStop(key);
  if (kind === 'pty') return { closed: ptyClose(projectId, key) };
  throw new Error('unknown item');
}

/** Stops everything the agent or a server runs in the project (your own terminal tabs stay open). */
export async function stopAllIn(projectId) {
  const { items } = runningIn(projectId);
  const todo = items.filter((x) => x.kind !== 'your-term');
  const results = await Promise.all(todo.map((x) => stopRunning(projectId, x.id).catch((e) => ({ error: e.message }))));
  return { stopped: todo.length, left: results.reduce((n, r) => n + (r?.left || 0), 0) };
}

// ---------- what each row uses (CPU and memory), and Kill ----------
// The Running list and the pane's Running tab already ask for the list every 2-3 seconds; with ?usage=1 the same
// request also reads every row's Windows job in one call to the job host (processor time so far and the memory its
// processes hold). Two readings in a row give the CPU share, so a row's first reading shows memory only.
const LAST = new Map(); // Windows job → { cpu (100 ns units), at (ms) }: the reading before
const procFor = (id) => {
  const [kind, ...rest] = String(id || '').split(':'), key = rest.join(':');
  return kind === 'srv' ? serverProc(key) : kind === 'job' ? jobProc(key) : kind === 'aterm' ? termProc(key) : null;
};

/** The share of the whole computer's processors a job used between two readings (0-100, one decimal), or null. */
export function cpuShare(prev, cur, now, cores = os.cpus().length) {
  const dt = now - (prev?.at || 0), used = Number(cur?.cpu) - Number(prev?.cpu);
  if (!prev || !(dt > 0) || !(used >= 0) || !(cores > 0)) return null;
  return Math.round(Math.min(100, (used / 1e4 / dt / cores) * 100) * 10) / 10;
}

/** Adds `use: { cpu, mem, n }` to each row whose processes QuorX tracks in a Windows job (none elsewhere). */
export async function addUsage(items, { usage = jobUsage, now = Date.now(), cores = os.cpus().length } = {}) {
  const procs = items.map((x) => procFor(x.id));
  const u = await usage(procs.map((p) => p?.qxJob)).catch(() => ({}));
  const seen = new Set();
  items.forEach((x, i) => {
    const job = procs[i]?.qxJob, r = job && u[job];
    if (!r) return;
    seen.add(job);
    x.use = { cpu: cpuShare(LAST.get(job), r, now, cores), mem: Number(r.mem) || 0, n: Number(r.n) || 0 };
    LAST.set(job, { cpu: Number(r.cpu) || 0, at: now });
  });
  if (LAST.size > 200) for (const k of LAST.keys()) if (!seen.has(k)) LAST.delete(k);
  return items;
}

/**
 * Kill: for a row whose Stop left processes behind (or is taking too long). Every process still in its job is ended
 * by force, then the row's usual Stop runs so the list and the agent hear it ended. Your terminal tabs just close.
 */
export async function killRunning(projectId, id, { kill = forceKillJob } = {}) {
  if (String(id).startsWith('pty:')) return stopRunning(projectId, id);
  const p = procFor(id);
  if (!p) return { already: true };
  let r = { left: 0, names: [], mode: 'basic' };
  if (p.qxJob) r = await kill(p.qxJob);
  else if (p.pid) await new Promise((res) => (process.platform === 'win32' ? execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => res()) : (() => { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } res(); })()));
  stopRunning(projectId, id).catch(() => {});
  return { left: r.left || 0, names: r.names || [], mode: r.mode };
}
