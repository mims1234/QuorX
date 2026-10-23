// The audit log: one line per thing that let the agent act, or stopped it. Every command (what ran, who let it
// run, its exit code, how many files it changed), every block, every rule added, every tripwire. Decider votes
// have their own log (logs/approvals.jsonl) with each voter's answer; this one answers "who let this happen?".
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';
import { rotateLog } from './storagerules.js';

const FILE = path.join(HOME, 'logs', 'audit.jsonl');

// Past the log limit (⚙ Settings → Storage, 50 MB) the log starts a new file; the old one is kept as audit.1.jsonl.
export function audit(rec) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    rotateLog(FILE);
    fs.appendFileSync(FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
  } catch { /* best effort: auditing never breaks a reply */ }
}

/** The newest rows (newest first), optionally for one project. Reads the end of the file only. */
export function readAudit({ project = null, limit = 200 } = {}) {
  let text = '';
  try {
    const st = fs.statSync(FILE), len = Math.min(st.size, 4 * 1024 * 1024);
    const fd = fs.openSync(FILE, 'r');
    try { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return []; }
  const rows = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if (!project || r.project === project) rows.push(r);
  }
  return rows;
}
