// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Quitting while something works. Quitting QuorX stops the harness, and with it every reply, server and command it
// runs. So when you quit (✕ set to Quit, the tray's Quit, ⚙ Settings → Quit QuorX) and something is still working,
// QuorX first says what: "2 replies running: Snake game, Portfolio site · 1 server: dev", with Quit anyway,
// Keep running in the tray (where they carry on) and Cancel. With nothing running it quits as before, asking nothing.
// No window here: main.js shows the dialog this describes.

const NAMES = 3; // names shown per kind; the rest are counted

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function names(list) {
  const all = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
  return all.length > NAMES ? `${all.slice(0, NAMES).join(', ')} and ${all.length - NAMES} more` : all.join(', ');
}

/** busy: { replies, servers, commands } from the harness (or null) → how much works now. */
const busyCount = (b) => (b ? (b.replies?.length || 0) + (b.servers?.length || 0) + (b.commands?.length || 0) : 0);

/** One line naming what works: "2 replies running: Snake game, Portfolio site · 1 server: dev · 1 command: npm test". */
function busyLine(b) {
  if (!busyCount(b)) return '';
  const parts = [];
  const r = b.replies || [], s = b.servers || [], c = b.commands || [];
  if (r.length) { const n = names(r.map((x) => x.title)); parts.push(`${plural(r.length, 'reply', 'replies')} running${n ? `: ${n}` : ''}`); }
  if (s.length) { const n = names(s.map((x) => x.name)); parts.push(`${plural(s.length, 'server', 'servers')}${n ? `: ${n}` : ''}`); }
  if (c.length) { const n = names(c.map((x) => x.label)); parts.push(`${plural(c.length, 'command', 'commands')}${n ? `: ${n}` : ''}`); }
  return parts.join(' · ');
}

/**
 * The quit dialog for what works now, or null when nothing does (then quit without asking).
 * tray: QuorX can keep running in the tray (it runs the harness itself and has a tray icon).
 * → { message, detail, buttons, actions, defaultId, cancelId }: actions[i] is what buttons[i] does ('quit' · 'tray' · 'cancel').
 */
function quitDialog(b, { tray = true } = {}) {
  const n = busyCount(b);
  if (!n) return null;
  const actions = ['quit', ...(tray ? ['tray'] : []), 'cancel'];
  const label = { quit: 'Quit anyway', tray: 'Keep running in the tray', cancel: 'Cancel' };
  return {
    message: busyLine(b),
    detail: `Quitting QuorX stops ${n === 1 ? 'it' : 'all of them'}.${tray ? ` Kept running in the tray, ${n === 1 ? 'it carries' : 'they carry'} on, and you can open QuorX again from its icon.` : ''}`,
    buttons: actions.map((a) => label[a]),
    actions,
    defaultId: actions.indexOf(tray ? 'tray' : 'cancel'),
    cancelId: actions.indexOf('cancel'),
  };
}

module.exports = { busyCount, busyLine, quitDialog };
