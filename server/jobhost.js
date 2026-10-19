// Windows Job Objects for everything the agent runs. One long-lived PowerShell (jobhost.ps1) holds the jobs;
// each command or server starts through jobgate.cjs, is put in a fresh job, and only then is told to go. So:
//   - Stop ends every process the command started, even one whose parent already exited;
//   - Stop can confirm "0 processes left", or name the ones that would not stop;
//   - if QuorX dies, the host's handles close and every job ends with it (KILL_ON_JOB_CLOSE).
// Without the host (not Windows, or PowerShell can't load the helper) commands still run, and Stop falls back to
// killing the process tree, which can miss detached processes. jobHostStatus() says which mode is on.
// The same host also parses PowerShell command lines for the rule engine (cmdpolicy.js).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineSplitter } from './terminal.js';

const WIN = process.platform === 'win32';

/**
 * A long-lived PowerShell helper that answers JSON lines (jobhost.ps1, uiahost.ps1). It starts on first use, never
 * keeps QuorX alive by itself, and reports why when it can't start.
 */
export function psHost(file, { label = 'helper', readyMs = 20000, off = false } = {}) {
  let host = null;
  let lastError = WIN ? '' : 'not Windows';
  let disabled = off;
  function start() {
    if (!WIN || disabled) return null;
    if (host) return host;
    const ps1 = fileURLToPath(new URL(file, import.meta.url));
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { lastError = e.message; disabled = true; return null; }
    const h = { proc, seq: 0, pending: new Map(), ok: false };
    let readyFn;
    h.ready = new Promise((r) => { readyFn = r; });
    const timer = setTimeout(() => { if (!h.ok) { lastError = `the ${label} did not start within ${readyMs / 1000} s`; disabled = true; readyFn(false); try { proc.kill(); } catch { /* gone */ } } }, readyMs);
    const lines = lineSplitter((line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.ready) { h.ok = true; clearTimeout(timer); readyFn(true); return; }
      const p = h.pending.get(m.id);
      if (!p) return;
      h.pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error || `${label} error`));
    });
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

const J = psHost('./jobhost.ps1', { label: 'job host', off: process.env.QX_NO_JOBHOST === '1' });

/** True once the job host is running (starts it on first use). */
export const jobsAvailable = J.available;
export const jobHostStatus = () => { const s = J.status(); return { mode: s.on ? 'jobs' : 'basic', error: s.error }; };

/** Puts a running process (and everything it starts from now on) in the job named `job`. */
export const adoptPid = (job, pid, memoryMB = 0) => J.call('adopt', { job, pid, memoryMB: Math.max(0, Number(memoryMB) || 0) });
/** How many processes in the job are still alive, with their pids and names. */
export async function jobCount(job) {
  const r = await J.call('count', { job });
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  return { active: r.active || 0, pids: arr(r.pids), names: arr(r.names) };
}
/** Ends every process in the job, then waits (up to `wait` ms) until none is left. Returns what is left. */
export async function killJob(job, wait = 5000) {
  await J.call('kill', { job });
  const t0 = Date.now();
  let c = await jobCount(job);
  while (c.active > 0 && Date.now() - t0 < wait) {
    await new Promise((r) => setTimeout(r, 100));
    c = await jobCount(job);
  }
  return { left: c.active, pids: c.pids, names: c.names };
}
/**
 * Splits a PowerShell command line with PowerShell's own parser: { errors, commands: [{ name, resolved, nameStatic,
 * invocation, args: [{ t: 'param'|'arg', text, static, value? }], redirects, text }], members: [.NET calls] }.
 * Throws when the host isn't running (the caller then treats the command as one it can't check).
 */
export async function parsePowerShell(line) {
  const r = await J.call('parse', { line: String(line) }, 8000);
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  return { errors: arr(r.errors), members: arr(r.members), commands: arr(r.commands).map((c) => ({ ...c, args: arr(c.args), redirects: arr(c.redirects) })) };
}
/** Forgets the job (closing it ends anything still inside). */
export const closeJob = (job) => J.call('close', { job }).catch(() => {});
