// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Which hidden browser tabs go to sleep. Every tab in the desktop app is a whole Chromium process (about 130 MB with
// a 3D page), kept running while hidden: eight chats with their apps open came to 1 GB of tabs alone. A sleeping tab
// is closed and remembered (address, zoom, scroll, a still picture); showing it again brings it back (main.js).
//
// A tab sleeps once it has been hidden for SLEEP_AFTER, or sooner when more than MAX_AWAKE hidden tabs are awake (the
// longest hidden first, but never one hidden for less than GRACE, so flicking between two tabs never reloads them).
// Never: a tab on screen, the agent's own tab, one playing sound, one with typing not yet sent, one a debugger is on.

const SLEEP_AFTER = 5 * 60e3, MAX_AWAKE = 2, GRACE = 20e3;

/**
 * tabs: [{ sid, agent, shown, hiddenAt, audible, dirty, debugged }] → the sids to put to sleep now, longest hidden first.
 * opts: { now, after, maxAwake, grace } (the defaults above).
 */
function pickSleepers(tabs, opts = {}) {
  const now = opts.now ?? Date.now(), after = opts.after ?? SLEEP_AFTER, maxAwake = opts.maxAwake ?? MAX_AWAKE, grace = opts.grace ?? GRACE;
  const can = tabs.filter((t) => !t.agent && !t.shown && t.hiddenAt != null && !t.audible && !t.dirty && !t.debugged)
    .sort((a, b) => a.hiddenAt - b.hiddenAt);
  const out = new Set(can.filter((t) => now - t.hiddenAt >= after).map((t) => t.sid));
  // Too many awake: the longest hidden of the rest, past their grace.
  const awake = tabs.filter((t) => !t.agent && !t.shown && !out.has(t.sid)).length;
  let extra = awake - maxAwake;
  for (const t of can) {
    if (extra <= 0) break;
    if (out.has(t.sid) || now - t.hiddenAt < grace) continue;
    out.add(t.sid); extra--;
  }
  return can.filter((t) => out.has(t.sid)).map((t) => t.sid);
}

/** Overrides for tests and for people who want it different: QX_TAB_SLEEP_MS, QX_TAB_AWAKE (numbers). */
function sleepOptions(env = process.env) {
  const n = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const after = n(env.QX_TAB_SLEEP_MS), maxAwake = n(env.QX_TAB_AWAKE);
  return { ...(after != null ? { after, grace: Math.min(GRACE, after) } : {}), ...(maxAwake != null ? { maxAwake } : {}) };
}

module.exports = { pickSleepers, sleepOptions, SLEEP_AFTER, MAX_AWAKE, GRACE };
