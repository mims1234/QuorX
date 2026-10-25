// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Windows Job Objects for everything the agent runs. One long-lived PowerShell (jobhost.ps1) holds the jobs;
// each command or server starts through jobgate.cjs, is put in a fresh job, and only then is told to go. So:
//   - Stop ends every process the command started, even one whose parent already exited;
//   - Stop can confirm "0 processes left", or name the ones that would not stop;
//   - if QuorX dies, the host's handles close and every job ends with it (KILL_ON_JOB_CLOSE).
// On macOS and Linux the same interface is kept with process groups (procgroup.js): mode 'groups'.
// Without either (PowerShell can't load the helper, or QX_NO_JOBHOST=1) commands still run, and Stop falls back to
// killing the process tree, which can miss detached processes. jobHostStatus() says which mode is on.
// The same host also parses PowerShell command lines for the rule engine (cmdpolicy.js).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineSplitter } from './terminal.js';
import { processGroups } from './procgroup.js';

const WIN = process.platform === 'win32';

/**
 * A long-lived helper that answers JSON lines: { ready: true } once, then { id, ok, … } per request. It starts on
 * first use, never keeps QuorX alive by itself, and reports why when it can't start. `launch()` returns the process
 * (or throws why it can't); `why` is the reason it won't run here at all (wrong system, missing program).
 */
export function lineHost(launch, { label = 'helper', readyMs = 20000, off = false, why = '' } = {}) {
  let host = null;
  let lastError = why;
  let disabled = off || !!why;
  function start() {
    if (disabled) return null;
    if (host) return host;
    let proc;
    try { proc = launch(); } catch (e) { lastError = e.message; disabled = true; return null; }
    const h = { proc, seq: 0, pending: new Map(), ok: false };
    let readyFn;
    h.ready = new Promise((r) => { readyFn = r; });
    const timer = setTimeout(() => { if (!h.ok) { lastError = `the ${label} did not start within ${readyMs / 1000} s`; disabled = true; readyFn(false); try { proc.kill(); } catch { /* gone */ } } }, readyMs);
    // Replies are whole JSON lines, however long (a window's picture is one line of base64).
    const lines = lineSplitter((line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.ready) { h.ok = true; clearTimeout(timer); readyFn(true); return; }
      const p = h.pending.get(m.id);
      if (!p) return;
      h.pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error || `${label} error`));
    }, Infinity);
    let err = '';
    proc.stdout.on('data', (d) => lines.push(d));
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.on('error', (e) => { lastError = e.message; });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (host === h) host = null;
      if (!h.ok) { disabled = true; lastError = lastError || err.trim().split(/\r?\n/).slice(-3).join(' ') || `the ${label} could not start`; }
      else lastError = `the ${label} stopped`;
      readyFn(false);
      for (const p of h.pending.values()) p.reject(new Error(`the ${label} stopped`));
      h.pending.clear();
    });
    proc.stdin.on('error', () => { /* host gone */ });
    // The host never keeps QuorX (or a test run) alive by itself; pending calls hold their own timers.
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.unref?.();
    host = h;
    return h;
  }
  async function call(op, args = {}, ms = 10000) {
    const h = start();
    if (!h || !(await h.ready) || host !== h) throw new Error(lastError || `no ${label}`);
    const id = ++h.seq;
    return new Promise((resolve, reject) => {
      h.pending.set(id, { resolve, reject });
      h.proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      setTimeout(() => { if (h.pending.delete(id)) reject(new Error(`${label}: ${op} timed out`)); }, ms);
    });
  }
  return {
    call,
    /** True once the host is running (starts it on first use). */
    available: async () => { const h = start(); return !!h && (await h.ready); },
    status: () => ({ on: !!host?.ok, error: host?.ok ? '' : lastError }),
  };
}

/** A PowerShell helper (jobhost.ps1, uiahost.ps1): Windows only. */
export function psHost(file, opts = {}) {
  const ps1 = fileURLToPath(new URL(file, import.meta.url));
  return lineHost(() => spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    { ...opts, why: WIN ? '' : 'not Windows' });
}

const OFF = process.env.QX_NO_JOBHOST === '1';
// It compiles its C# helper when it starts: under a second on a desktop, but 7-17 s on a busy CI machine. Missing the
// deadline turns Stop's job tracking off for the rest of the run, so the deadline leaves plenty of room.
const J = psHost('./jobhost.ps1', { label: 'job host', off: OFF, readyMs: 60000 });
// macOS and Linux: process groups. Commands start detached (their own session and group); see procgroup.js.
const G = WIN || OFF ? null : processGroups();
if (G) process.once('exit', () => G.killAllSync());
let groupsOk = null;

/** True once the job host is running (starts it on first use). */
export const jobsAvailable = G ? async () => (groupsOk ??= await G.available()) : J.available;
export const jobHostStatus = () => {
  if (G) return { mode: groupsOk === false ? 'basic' : 'groups', error: groupsOk === false ? 'ps could not list processes' : '' };
  const s = J.status(); return { mode: s.on ? 'jobs' : 'basic', error: s.error };
};
/** Whether commands should start in a new process group (spawn's `detached`): on macOS and Linux. */
export const startDetached = !!G;

/** Puts a running process (and everything it starts from now on) in the job named `job`. */
export const adoptPid = (job, pid, memoryMB = 0) => (G ? G.adopt(job, pid) : J.call('adopt', { job, pid, memoryMB: Math.max(0, Number(memoryMB) || 0) }));
/** How many processes in the job are still alive, with their pids and names. */
export async function jobCount(job) {
  if (G) return G.count(job);
  const r = await J.call('count', { job });
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  return { active: r.active || 0, pids: arr(r.pids), names: arr(r.names) };
}
/** Ends every process in the job, then waits (up to `wait` ms) until none is left. Returns what is left, and the
 *  mode that confirmed it ('jobs' on Windows, 'groups' elsewhere). */
export async function killJob(job, wait = 5000) {
  if (G) return { ...(await G.kill(job, wait)), mode: 'groups' };
  await J.call('kill', { job });
  const t0 = Date.now();
  let c = await jobCount(job);
  while (c.active > 0 && Date.now() - t0 < wait) {
    await new Promise((r) => setTimeout(r, 100));
    c = await jobCount(job);
  }
  return { left: c.active, pids: c.pids, names: c.names, mode: 'jobs' };
}
/**
 * Splits a PowerShell command line with PowerShell's own parser: { errors, commands: [{ name, resolved, nameStatic,
 * invocation, isFunction (a function the line defines itself), args: [{ t: 'param'|'arg', text, static, value? }], redirects, text }],
 * members: [.NET calls] }.
 * Throws when the host isn't running (the caller then treats the command as one it can't check).
 */
export async function parsePowerShell(line) {
  const r = await J.call('parse', { line: String(line) }, 8000);
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  return { errors: arr(r.errors), members: arr(r.members), commands: arr(r.commands).map((c) => ({ ...c, args: arr(c.args), redirects: arr(c.redirects) })) };
}
/** Forgets the job (closing it ends anything still inside). */
export const closeJob = (job) => (G ? Promise.resolve(G.close(job)) : J.call('close', { job }).catch(() => {}));
