// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Stop on macOS and Linux: the same promise as the Windows job host (jobhost.js), kept with process groups.
// Every agent command and server starts through jobgate.cjs in a new session and process group of its own (Node's
// detached: true calls setsid), so the gate's pid is the group's id and everything the command starts joins it.
// Stop sends SIGTERM to the whole group, gives it a moment to close files, sends SIGKILL to what is left, and then
// looks again, so it can confirm "0 processes left" or name the ones that would not stop.
// A process can leave the group (setsid, setpgid: daemons do). QuorX follows those as well: a child of anything in
// the job is in the job, and every process seen in the job once stays in it (checked by name, so a reused pid is
// never touched). A program that daemonizes and leaves between two looks is the one thing this can miss.
// If QuorX itself is killed, the gate notices its parent is gone and ends its own group (see jobgate.cjs).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** One line of /proc/<pid>/stat → { pid, ppid, pgid, comm, zombie }. The name is in brackets and may hold spaces. */
export function parseProcStat(text) {
  const s = String(text || '');
  const open = s.indexOf('('), close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = s.slice(close + 2).trim().split(/\s+/); // state ppid pgrp session …
  const pid = Number(s.slice(0, open).trim()), ppid = Number(rest[1]), pgid = Number(rest[2]);
  if (!pid || Number.isNaN(ppid) || Number.isNaN(pgid)) return null;
  return { pid, ppid, pgid, comm: s.slice(open + 1, close), zombie: rest[0] === 'Z' || rest[0] === 'X' };
}

/** `ps -A -o pid= -o ppid= -o pgid= -o stat= -o comm=` → rows. macOS prints the program's full path as its name. */
export function parsePs(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: path.posix.basename(m[5].trim()) || m[5].trim(), zombie: /^[ZX]/.test(m[4]) });
  }
  return rows;
}

// Every process on the computer: /proc on Linux (no program to start), ps elsewhere.
function listProcs() {
  if (process.platform === 'linux' && fs.existsSync('/proc/self/stat')) {
    const rows = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const r = parseProcStat(fs.readFileSync(`/proc/${d}/stat`, 'utf8')); if (r) rows.push(r); } catch { /* it ended */ }
    }
    return Promise.resolve(rows);
  }
  return new Promise((resolve, reject) => execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    (err, out) => (err && !out ? reject(new Error(`ps did not run: ${err.message}`)) : resolve(parsePs(out)))));
}

/**
 * Process groups as jobs. Everything is injectable for tests: `list()` → rows of { pid, ppid, pgid, comm, zombie },
 * `kill(pid, signal)` (a negative pid is a whole group, as in process.kill), `self` (QuorX's own pid, never touched).
 */
export function processGroups({ list = listProcs, kill = (pid, sig) => process.kill(pid, sig), self = process.pid, graceMs = 1500, pollMs = 100 } = {}) {
  const jobs = new Map(); // job → { pgid, seen: Map<pid, name> }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The job's live processes: its group, every process seen in it before (same name), and all their children.
  function members(g, rows) {
    const live = rows.filter((r) => !r.zombie && r.pid !== self && r.pid > 1);
    const byPid = new Map(live.map((r) => [r.pid, r]));
    const set = new Set(live.filter((r) => r.pgid === g.pgid).map((r) => r.pid));
    for (const [pid, name] of g.seen) { const r = byPid.get(pid); if (r && (name == null || r.comm === name)) set.add(pid); }
    for (let grew = true; grew;) { grew = false; for (const r of live) if (!set.has(r.pid) && set.has(r.ppid)) { set.add(r.pid); grew = true; } }
    const out = [...set].map((pid) => byPid.get(pid));
    for (const r of out) g.seen.set(r.pid, r.comm);
    return out;
  }
  const look = async (g) => members(g, await list());
  const signal = (g, rows, sig) => {
    try { kill(-g.pgid, sig); } catch { /* the group is empty */ }
    for (const r of rows) { try { kill(r.pid, sig); } catch { /* already gone */ } }
  };
  const view = (rows) => ({ active: rows.length, pids: rows.map((r) => r.pid), names: rows.map((r) => r.comm) });

  return {
    /** Whether processes can be listed here (ps or /proc). */
    available: async () => { try { await list(); return true; } catch { return false; } },
    /** `pid` started a new group (it is the group's leader); the job is that group. Memory caps are Windows-only. */
    adopt(job, pid) { jobs.set(job, { pgid: Number(pid), seen: new Map([[Number(pid), null]]) }); },
    async count(job) {
      const g = jobs.get(job);
      return g ? view(await look(g)) : view([]);
    },
    /** SIGTERM to everything, SIGKILL to what is left after the grace time, then waits (up to `wait` ms) for none. */
    async kill(job, wait = 5000) {
      const g = jobs.get(job);
      if (!g) return { left: 0, pids: [], names: [] };
      const t0 = Date.now();
      let rows = await look(g);
      if (rows.length) signal(g, rows, 'SIGTERM');
      while (rows.length && Date.now() - t0 < graceMs) { await sleep(pollMs); rows = await look(g); }
      if (rows.length) signal(g, rows, 'SIGKILL');
      while (rows.length && Date.now() - t0 < graceMs + wait) { await sleep(pollMs); rows = await look(g); }
      const v = view(rows);
      return { left: v.active, pids: v.pids, names: v.names };
    },
    close(job) { jobs.delete(job); },
    /** QuorX is exiting: SIGKILL to every group, synchronously. (Pids seen outside a group can't be checked by name
     *  this late, so they are left; a gate whose parent is gone ends its own group too.) */
    killAllSync() {
      for (const g of jobs.values()) { try { kill(-g.pgid, 'SIGKILL'); } catch { /* empty */ } }
      jobs.clear();
    },
    jobs,
  };
}
