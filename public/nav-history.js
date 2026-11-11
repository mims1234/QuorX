// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Back and forward for the whole workspace: what you brought to the front, in order (a chat, a tab, a file, a
// settings page), like a browser's history. push() when you bring something to the front; back() / forward() step
// through it and give the entry to show. Showing that entry must not push it again: call it with { from: 'history' }
// set by the caller, or check `stepping`. Kept to the last CAP entries.
//
// An entry is { kind, id, ...extra }; two entries are the same place when kind and id match.

export const HISTORY_CAP = 50;
const same = (a, b) => !!a && !!b && a.kind === b.kind && String(a.id) === String(b.id);

export function createHistory({ cap = HISTORY_CAP, entries = [], at } = {}) {
  let list = entries.filter((e) => e && e.kind && e.id != null).slice(-cap);
  let i = at == null ? list.length - 1 : Math.min(Math.max(-1, at), list.length - 1);
  const h = {
    stepping: false,
    /** You brought `e` to the front. The same place twice in a row counts once; anything forward of here goes. */
    push(e) {
      if (!e || !e.kind || e.id == null || h.stepping) return false;
      if (same(list[i], e)) { list[i] = { ...list[i], ...e }; return false; }
      list = list.slice(0, i + 1);
      list.push({ ...e });
      if (list.length > cap) list = list.slice(list.length - cap);
      i = list.length - 1;
      return true;
    },
    get canBack() { return i > 0; },
    get canForward() { return i < list.length - 1; },
    get current() { return list[i] || null; },
    get entries() { return list.map((e) => ({ ...e })); },
    get index() { return i; },
    // ok(entry), when given, says whether an entry can be shown now: one that can't (its tab is closed, or it is what
    // is already on screen) is stepped over but kept, so a tab reopened later is a stop again.
    back(ok) { const k = h.find(-1, ok); if (k < 0) return null; i = k; return { ...list[i] }; },
    forward(ok) { const k = h.find(1, ok); if (k < 0) return null; i = k; return { ...list[i] }; },
    canGo(dir, ok) { return h.find(dir < 0 ? -1 : 1, ok) >= 0; },
    /** The index of the next entry back (dir -1) or forward (1) that ok accepts, or -1. */
    find(dir, ok) { for (let k = i + dir; k >= 0 && k < list.length; k += dir) if (!ok || ok({ ...list[k] })) return k; return -1; },
    /** Something closed or deleted: its entries go (back / forward skip it from now on). */
    forget(pred) {
      const cur = list[i];
      const keep = list.filter((e) => !pred(e));
      // Collapse repeats that removing left side by side.
      list = keep.filter((e, k) => !same(e, keep[k - 1]));
      i = cur && !pred(cur) ? list.findIndex((e) => e === cur || same(e, cur)) : Math.min(i, list.length - 1);
      if (i < 0) i = list.length - 1;
    },
    /** Runs fn (which shows an entry) without it being pushed. */
    quietly(fn) { h.stepping = true; try { return fn(); } finally { h.stepping = false; } },
    toJSON() { return { entries: list, at: i }; },
  };
  return h;
}
