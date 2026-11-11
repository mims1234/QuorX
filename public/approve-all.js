// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Approve all / Deny all. In 🔒 Strict set to ask before every tool, one step of the agent can read several files at
// once, and each read waits on its own card: three taps for one step. When two or more cards of the same kind (the
// same tool, the same mode) wait in one reply, a bar above them answers them together.
//
// Never swept in: a card marked risky (a red or amber warning: it reads your keys, acts in your own account, reaches
// past the project), one with no "Allow always" (QuorX found it too risky to allow wholesale), one that takes only its
// own buttons, and one already answered. Those keep their warning colours and need their own click.
// Allow all is "once" for each card: it never saves a rule. No page code here (app.js draws and wires the bar).

/**
 * cards: [{ id, tool, mode, risk, noAlways, buttonsOnly, answered, est }] in page order.
 * → { groups: [{ key, tool, mode, ids, est }] (only kinds with 2+ cards that can be answered together, in the order
 *   their first card appears), alone: how many waiting cards need their own answer }
 */
export function bulkGroups(cards) {
  const open = (cards || []).filter((c) => c && c.id && !c.answered);
  const can = (c) => !c.risk && !c.noAlways && !c.buttonsOnly && !!c.tool;
  const byKey = new Map();
  for (const c of open.filter(can)) {
    const key = `${c.tool}|${c.mode || ''}`;
    if (!byKey.has(key)) byKey.set(key, { key, tool: c.tool, mode: c.mode || '', ids: [], est: 0 });
    const g = byKey.get(key);
    g.ids.push(c.id);
    g.est += Number(c.est) || 0;
  }
  const groups = [...byKey.values()].filter((g) => g.ids.length >= 2);
  const inGroup = new Set(groups.flatMap((g) => g.ids));
  return { groups, alone: open.filter((c) => !inGroup.has(c.id)).length };
}

/** The bar's words for one group: "3 waiting · Read a file", and the buttons "Allow all 3" / "Deny all 3". */
export function bulkWords(g, name, money = (v) => `$${v.toFixed(3)}`) {
  const n = g.ids.length;
  return {
    what: `${n} waiting · ${name}`,
    yes: g.est > 0 ? `Approve all ${n} · ${money(g.est)}` : `Allow all ${n}`,
    no: `Deny all ${n}`,
  };
}
