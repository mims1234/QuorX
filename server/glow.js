// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The sign that the agent is using your computer, and the kill switch (Windows): while a reply uses the desktop tool,
// the screen computer use works on (server/workscreen.js) gets a glowing QuorX edge and a banner at the top with the
// shortcut and a Stop button (glowhost.ps1). Neither shows in the agent's screen pictures, and the agent's clicks and
// keys pass through them; only your own click on Stop, or your own Ctrl+Alt+Backspace, stops it. Stop ends every reply
// using the desktop and the desktop helper itself, so a click or a long typing it is in the middle of stops as well.
import { psHost } from './jobhost.js';

const WIN = process.platform === 'win32';
const OFF = !WIN || process.env.QX_NO_GLOW === '1';
export const STOP_KEYS = 'Ctrl+Alt+Backspace';
const using = new Map(); // runId → { chatId, app }: the chat driving it and the app it uses (named on the banner)
let onStop = () => {};
let begin = () => null, end = () => {};
let on = false, chain = Promise.resolve(), screen = null, shown = '';
const H = psHost('./glowhost.ps1', { label: 'screen glow', readyMs: 30000, off: OFF, onEvent: (m) => { if (m.event === 'stop') stopNow(m.how); } });

// What the banner says: the apps in use, by name ("QuorX is using Paint"), or computer use while none is named yet.
function label() {
  const apps = [...new Set([...using.values()].map((u) => u.app).filter(Boolean))];
  return `QuorX is using ${apps.length ? apps.slice(0, 3).join(', ') : 'computer use'}`;
}
// Shows or hides the glow to match `using`, one change after another. Making room (begin) starts at once, so the
// agent's first action already waits for its screen; the glow shows on that screen, or on the main one if it can't be
// told. A helper that can't start (no PowerShell, a locked-down computer) leaves the agent working as before: the sign
// is a help, never a gate.
function sync() {
  const want = using.size > 0;
  // Already showing: only the app it names may have changed.
  if (want && on) {
    const t = label();
    if (t !== shown) { shown = t; chain = chain.then(() => (on ? H.call('show', { text: t, keys: `${STOP_KEYS} to stop`, ...(screen || {}) }, 15000).catch(() => {}) : null)); }
    return;
  }
  if (want === on) return;
  on = want;
  if (want) {
    let where; try { where = Promise.resolve(begin([...using.values()][0].chatId)).catch(() => null); } catch { where = Promise.resolve(null); }
    chain = chain.then(async () => {
      const s = await where;
      if (!on) return;
      screen = s?.w ? { x: s.x, y: s.y, w: s.w, h: s.h } : null; shown = label();
      await H.call('show', { text: shown, keys: `${STOP_KEYS} to stop`, ...(screen || {}) }, 15000).catch(() => {});
    });
  } else {
    screen = null; shown = '';
    try { end(); } catch { /* the server's own problem */ }
    chain = chain.then(() => H.call('hide', {}, 15000).catch(() => {}));
  }
}

/** Called when you stop: (how) → the runs stopped. Set once by the server. */
export function onGlowStop(fn) { onStop = fn; }
/** Set once by the server: start(chatId) → the screen to glow on ({ x, y, w, h } or a promise of it), and end(). */
export function onGlowScreen(start, stop) { begin = start; end = stop; }
/** A reply started using the desktop (once the user allowed it, and the app): the glow is on until it ends. A later
 *  call names the app it moved to. */
export function glowOn(runId, chatId = '', app = '') {
  if (!runId) return;
  const u = using.get(runId);
  if (u) { if (app && u.app !== String(app)) { u.app = String(app); sync(); } return; }
  using.set(runId, { chatId: String(chatId || ''), app: String(app || '') });
  sync();
}
/** A reply ended (or stopped). */
export function glowOff(runId) { if (!using.delete(runId)) return; sync(); }
/** What the banner says now. */
export const glowLabel = () => label();
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
