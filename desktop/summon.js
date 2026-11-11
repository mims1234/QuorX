// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The summon key (⚙ Settings → About → Desktop app): one system-wide shortcut that brings QuorX to the front with
// the message box ready, from any app. Off by default, since another app may already use the key; when Windows
// refuses it (taken), it stays off and the page says so. Unregistered when it changes, when it is turned off, and on
// quit (main.js unregisters everything).
const SUMMON_DEFAULT = 'Ctrl+Shift+Space';

// The page writes keys as "Ctrl+Shift+Space" (its keyCombo); Electron wants its own names for a few of them.
const KEY_NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Enter: 'Return', ' ': 'Space', '+': 'Plus' };
const MODS = { Ctrl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super', Win: 'Super', Super: 'Super' };
const MAIN = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|Esc|Plus|[`\-=[\];',./\\])$/;
/** "Ctrl+Shift+Space" → "Ctrl+Shift+Space" for Electron, or null when it can't be a global key (no Ctrl/Alt/Win, or no key). */
function toAccelerator(combo) {
  const parts = String(combo || '').split('+').map((s) => s.trim());
  // "Ctrl++" (the plus key) splits into an empty last part.
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+');
  if (parts.length < 2) return null;
  const key = parts.pop(), mods = [];
  for (const p of parts) { const m = MODS[p]; if (!m) return null; if (!mods.includes(m)) mods.push(m); }
  if (!mods.some((m) => m !== 'Shift')) return null; // Shift alone would steal a capital letter from every app
  const k = KEY_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key);
  if (!MAIN.test(k)) return null;
  const order = ['Ctrl', 'Alt', 'Shift', 'Super'];
  return [...mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)), k].join('+');
}
/**
 * Registers (or drops) the summon key. `state` is the last result ({ on, key, accel }) so the old key is let go first.
 * Returns { on, key, ok, error? }: ok false with on false when Windows refused the key or it isn't a valid one.
 */
function applySummon(gs, want, state, onFire) {
  const key = String(want?.key || SUMMON_DEFAULT);
  try { if (state?.accel && gs.isRegistered(state.accel)) gs.unregister(state.accel); } catch { /* already gone */ }
  if (!want?.on) return { on: false, key, ok: true };
  const accel = toAccelerator(key);
  if (!accel) return { on: false, key, ok: false, error: 'Use Ctrl, Alt or the Windows key with another key, e.g. Ctrl+Shift+Space.' };
  // QuorX's own: the stop key while computer use runs, and the one Windows keeps for itself.
  if (['Ctrl+Alt+Backspace', 'Ctrl+Alt+Delete'].includes(accel)) return { on: false, key, ok: false, error: `${key} is kept for stopping computer use (or by Windows). Pick another key.` };
  let ok = false;
  try { ok = gs.register(accel, onFire) && gs.isRegistered(accel); } catch { ok = false; }
  if (!ok) return { on: false, key, ok: false, error: `Another app already uses ${key}. Pick another key.` };
  return { on: true, key, ok: true, accel };
}

module.exports = { SUMMON_DEFAULT, toAccelerator, applySummon };
