// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The sign that the agent is using your computer, and the kill switch (Windows): while a reply uses the desktop tool,
// every screen gets a glowing QuorX edge and a Stop button at the top (glowhost.ps1). Neither shows in the agent's
// screen pictures, and the agent's clicks and keys pass through them; only your own click on Stop, or your own
// Ctrl+Alt+Backspace, stops it. Stop ends every reply using the desktop and the desktop helper itself, so a click or
// a long typing it is in the middle of stops as well.
import { psHost } from './jobhost.js';

const WIN = process.platform === 'win32';
const OFF = !WIN || process.env.QX_NO_GLOW === '1';
const using = new Map(); // runId → what to show (the chat's title)
let onStop = () => {};
let shown = '';
const H = psHost('./glowhost.ps1', { label: 'screen glow', readyMs: 30000, off: OFF, onEvent: (m) => { if (m.event === 'stop') stopNow(m.how); } });

const line = () => {
  const titles = [...new Set(using.values())].filter(Boolean);
  const who = titles.length === 1 ? `“${titles[0].slice(0, 40)}”` : titles.length ? `${titles.length} chats` : 'QuorX';
  return `${who} is using your computer · Stop   (Ctrl+Alt+Backspace)`;
};
// Shows, changes or hides the glow to match `using`. A helper that can't start (no PowerShell, a locked-down
// computer) leaves the agent working as before: the sign is a help, never a gate.
async function sync() {
  const want = using.size ? line() : '';
  if (want === shown) return;
  shown = want;
  await H.call(want ? 'show' : 'hide', want ? { text: want } : {}, 15000).catch(() => { shown = ''; });
}

/** Called when you stop: (how) → the runs stopped. Set once by the server. */
export function onGlowStop(fn) { onStop = fn; }
/** A reply started using the desktop: the glow is on until it ends. */
export function glowOn(runId, title = '') { if (!runId || using.get(runId) === title) return; using.set(runId, String(title || '')); sync(); }
/** A reply ended (or stopped). */
export function glowOff(runId) { if (!using.delete(runId)) return; sync(); }
/** The replies the glow is on for. */
export const glowRuns = () => [...using.keys()];
/** Stop pressed (or the shortcut): every reply using the desktop ends now. */
export function stopNow(how = 'button') {
  const runs = [...using.keys()];
  try { onStop(runs, how); } catch { /* the server's own problem */ }
  for (const r of runs) using.delete(r);
  sync();
  return runs;
}
