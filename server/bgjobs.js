// Background jobs: commands that keep running after the agent's tool call returns. Long builds whose time limit
// ran out (only commands that read, write in the project or build: never installs, pushes or deletes), and
// programs started with background: true (a desktop app, a watcher, a test server). Each one is still a normal
// agent command: in its own Windows job, in the terminal feed with a stop button, with its full output in a log
// file. The agent reads new output with job_output and ends it with job_stop.
import fs from 'node:fs';
import { runLine, endProc, stopNote } from './workspace.js';

const JOBS = new Map(); // id → job
let seq = 0;

const view = (j) => ({ id: j.id, label: j.label, status: j.status, code: j.code ?? null, started: j.started, ended: j.ended || null, log: j.logRel, pids: j.pids || null });

/**
 * Starts a command in the background (or adopts one already running: pass `running: { promise, proc }`).
 * `onDone(job, result)` runs when it ends, however it ends.
 */
export function startBackground({ projectId, cwd, line, shell, label, logTo, logRel, term, memoryMB, onDone, running }) {
  const id = `bg${++seq}`;
  const job = { id, projectId, line, label: label || line, logTo, logRel, started: Date.now(), status: 'running', proc: running?.proc || null };
  const p = running?.promise || runLine(cwd, line, { shell, label, timeout: 24 * 3600e3, memoryMB, logTo, term, onStart: (pr) => { job.proc = pr; } });
  job.promise = p.then((r) => { job.status = r.stopped ? 'stopped' : 'ended'; job.code = r.code; job.ended = Date.now(); job.result = r; onDone?.(job, r); return r; },
    (e) => { job.status = 'failed'; job.error = e.message; job.ended = Date.now(); onDone?.(job, null); });
  JOBS.set(id, job);
  return job;
}

export const getBackground = (id) => JOBS.get(String(id));
export const listBackground = (projectId) => [...JOBS.values()].filter((j) => !projectId || j.projectId === projectId).map(view);

/**
 * Output since byte `since` (default: the last `max` characters). `wait` ms: wait for the job to end first, up to
 * that long (it returns as soon as the job ends). { job, text, next, more }.
 */
export async function jobOutput(id, { since = null, wait = 0, max = 6000 } = {}) {
  const j = JOBS.get(String(id));
  if (!j) throw new Error(`no background job ${id}`);
  const size = () => { try { return fs.statSync(j.logTo).size; } catch { return 0; } };
  const t0 = Date.now();
  while (wait > 0 && j.status === 'running' && Date.now() - t0 < wait) await new Promise((r) => setTimeout(r, 250));
  if (j.status !== 'running') await new Promise((r) => setTimeout(r, 100)); // the last lines reach the log
  const from = since == null ? Math.max(0, size() - max) : Math.max(0, Number(since) || 0);
  const end = size();
  let text = '';
  if (end > from) {
    const fd = fs.openSync(j.logTo, 'r');
    try { const len = Math.min(end - from, max); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, end - len); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  }
  return { job: view(j), text, next: end, more: end - from > max };
}

/** Stops a background job and everything it started. Resolves to the stop result. */
export async function stopBackground(id) {
  const j = JOBS.get(String(id));
  if (!j) throw new Error(`no background job ${id}`);
  if (j.status !== 'running') return { already: j.status };
  const r = await endProc(j.proc);
  await Promise.race([j.promise, new Promise((x) => setTimeout(x, 3000))]);
  return { ...r, note: stopNote(r) };
}
