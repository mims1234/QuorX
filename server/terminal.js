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
  if (f.events.length > KEEP) f.events.splice(0, f.events.length - KEEP);
  for (const cb of f.subs) cb(ev);
}

// Output arrives in chunks; split into lines, keeping a partial line until it ends.
export function lineSplitter(onLine) {
  let rest = '';
  return {
    push(chunk, stream) {
      const s = rest + chunk.toString();
      const parts = s.split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) onLine(line, stream);
      if (rest.length > 4000) { onLine(rest, stream); rest = ''; }
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
const JOBS = new Map(); // job → { projectId, abort, label, source, at }
let jobN = 0;
export function newJob(projectId, label, source, abort) {
  const job = `j${Date.now().toString(36)}${(++jobN).toString(36)}`;
  JOBS.set(job, { projectId, label, source, abort, at: Date.now() });
  return job;
}
export const endJob = (job) => JOBS.delete(job);
/** Stops a running job. Resolves to how it went ({ left, names, mode } for agent commands), or null if it isn't running. */
export const stopJob = async (job) => { const j = JOBS.get(job); if (!j) return null; return (await j.abort?.()) || {}; };
export const runningJobs = (projectId) => [...JOBS.entries()].filter(([, j]) => !projectId || j.projectId === projectId).map(([job, j]) => ({ job, label: j.label, source: j.source, at: j.at }));
