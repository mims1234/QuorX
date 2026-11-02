// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The edit guard: you, another chat or another program can change a file while the agent works. A file the agent read
// or wrote in this reply is stamped (size and time); when it changes on disk by anyone but the agent, the agent must
// read it again before it writes, edits or appends to it, so it never overwrites a change it hasn't seen.
// The agent's own commands count as the agent: after each one, every stamp is taken again.
import fs from 'node:fs';

const key = (rel) => String(rel || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
const stampOf = (abs) => { try { const s = fs.statSync(abs); return s.isFile() ? `${s.size}:${Math.round(s.mtimeMs)}` : null; } catch { return null; } };

export function editGuard() {
  const seen = new Map(); // key → { abs, rel, stamp }
  return {
    /** The agent has the file's current text (it read or wrote it). */
    saw(rel, abs) { const st = stampOf(abs); if (st) seen.set(key(rel), { abs, rel: String(rel), stamp: st }); else seen.delete(key(rel)); },
    /** Its own command ran: whatever changed since, it changed. */
    restamp() { for (const [k, v] of seen) { const st = stampOf(v.abs); if (st) v.stamp = st; else seen.delete(k); } },
    /** Why a change must wait ('' when it may go ahead): the file changed since the agent last saw it. */
    stale(rel, abs) {
      const v = seen.get(key(rel));
      if (!v) return '';
      const now = stampOf(abs);
      if (now === v.stamp) return '';
      return now ? 'changed on disk since you last read or wrote it (the user, another chat or another program)' : 'was deleted or moved since you last read it';
    },
    get size() { return seen.size; },
  };
}
