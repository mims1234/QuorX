// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The terminal feed: what runs in each project folder, as it happens. Commands the agent or the user
// runs and the output of dev servers are pushed here line by line; the page follows them over
// Server-Sent Events (/api/term/stream), so you can watch the agent work like a real terminal.
const FEEDS = new Map(); // projectId → { seq, events: [], subs: Set }
const KEEP = 3000;       // events kept per project

function feed(projectId) {
  let f = FEEDS.get(projectId);
  if (!f) { f = { seq: 0, events: [], subs: new Set() }; FEEDS.set(projectId, f); }
  return f;
}

/**
 * One event. `kind`: "start" (a command or server began), "out" (a line of output), "end" (it finished).
 * `job` ties them together; `source` is "agent" or "you"; servers use `server` = their name.
 */
export function termEvent(projectId, e) {
  if (!projectId) return;
  const f = feed(projectId);
  const ev = { seq: ++f.seq, at: Date.now(), ...e };
  f.events.push(ev);
  // A running job keeps its last few lines, for the Running tab.
  if (e.kind === 'out' && e.job && JOBS.has(e.job) && String(e.text || '').trim()) { const t = JOBS.get(e.job).tail; t.push(String(e.text).slice(0, 300)); if (t.length > 4) t.shift(); }
  if (f.events.length > KEEP) f.events.splice(0, f.events.length - KEEP);
  for (const cb of f.subs) cb(ev);
}

// Output arrives in chunks; split into lines, keeping a partial line until it ends (or passes `max` characters).
export function lineSplitter(onLine, max = 4000) {
  let rest = '';
  return {
    push(chunk, stream) {
      const s = rest + chunk.toString();
      const parts = s.split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) onLine(line, stream);
      if (rest.length > max) { onLine(rest, stream); rest = ''; }
    },
    flush(stream) { if (rest) onLine(rest, stream); rest = ''; },
  };
}

/** Everything after `from`, then each new event live. Returns an unsubscribe function. */
export function followTerm(projectId, from, cb) {
  const f = feed(projectId);
  for (const e of f.events) if (e.seq > from) cb(e);
  f.subs.add(cb);
  return () => f.subs.delete(cb);
}

// Jobs that are still running, so the page can show a busy dot and a stop button.
// `chatId`: the chat whose agent ran it; `bg`: the background job it became (set by markJob).
const JOBS = new Map(); // job → { projectId, abort, label, source, at, chatId, tab, bg, tail }
let jobN = 0;
export function newJob(projectId, label, source, abort, { chatId = null, tab = null } = {}) {
  const job = `j${Date.now().toString(36)}${(++jobN).toString(36)}`;
  JOBS.set(job, { projectId, label, source, abort, at: Date.now(), chatId, tab, bg: null, tail: [] });
  return job;
}
export const endJob = (job) => JOBS.delete(job);
export const markJob = (job, patch) => { const j = JOBS.get(job); if (j) Object.assign(j, patch); };
/** Stops a running job. Resolves to how it went ({ left, names, mode } for agent commands), or null if it isn't running. */
export const stopJob = async (job) => { const j = JOBS.get(job); if (!j) return null; return (await j.abort?.()) || {}; };
export const runningJobs = (projectId) => [...JOBS.entries()].filter(([, j]) => !projectId || j.projectId === projectId)
  .map(([job, j]) => ({ job, projectId: j.projectId, label: j.label, source: j.source, at: j.at, chatId: j.chatId, tab: j.tab, bg: j.bg, tail: [...j.tail] }));
