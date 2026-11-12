// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Every QuorX keyboard shortcut in one table: what it does, its group, its default keys, and whether you can change
// it. The page's key handler, the Settings → Shortcuts list (search, change, reset) and the tips that name a key all
// read from here, so a key you change is changed everywhere. Keys are written the way the page reads them from a key
// press (keyCombo in app.js): modifiers Ctrl, Shift, Alt, Meta in that order, then the key ("Ctrl+Shift+T").

export const KEY_GROUPS = { tabs: 'Chat tabs', move: 'Moving around', view: 'Window', find: 'Search', typing: 'Typing', edit: 'Editing text', mic: 'Mic', settings: 'Settings', zoom: 'Zoom', layouts: 'Layouts' };

const tabJumps = Array.from({ length: 9 }, (_, i) => ({
  id: `tab.${i + 1}`, group: 'tabs', keys: `Ctrl+${i + 1}`,
  label: i === 8 ? 'Go to the last chat tab' : `Go to chat tab ${i + 1}`,
  help: i === 0 ? 'Counted from the left of the chat tabs strip.' : '',
}));
// The first nine layouts of Layout ▾, in its order (workspace.js LAYOUT_ORDER and LAYOUT_KEYS; a test keeps them in step).
const LAYOUT_NAMES = ['Single', 'Focus', 'Chat + preview', 'Preview first', 'Watch the build', 'Three columns', 'Stacked', 'Chat + page + terminal', 'Two chats'];
const layoutKeys = LAYOUT_NAMES.map((name, i) => ({
  id: `layout.${i + 1}`, group: 'layouts', keys: `Ctrl+Alt+${i + 1}`, label: `Layout: ${name}`,
  help: i === 0 ? 'Arranges the tabs this project already has; nothing opens or closes. Window → Layout lists them all.' : i === 1 ? 'Again, or Esc, brings back what Focus hid.' : '',
}));
/**
 * The table. fixed: shown in the list but not changeable (typing keys, keys the desktop app or a dialog handles).
 * setting: the one shortcut whose keys were a setting of their own before this table (the mic key, micKey).
 */
export const SHORTCUTS = [
  { id: 'palette', group: 'find', keys: 'Ctrl+K', label: 'Search chats, commands, settings and files' },
  { id: 'chatsearch', group: 'find', keys: 'Ctrl+Shift+F', label: 'Search inside chats', help: 'Your messages and the agent’s replies, with filters: the Search view (in a window of its own on a phone).' },
  { id: 'chatsearch.filters', group: 'find', keys: 'Alt+P · Alt+F · Alt+D', label: 'In Search inside chats: which projects, who wrote it, when', fixed: true },
  { id: 'find', group: 'find', keys: 'Ctrl+F', label: 'Find in the tab you are using', help: 'The chat you are typing in, or the group you used last. Inside a page of the Browser tab, Ctrl+F always finds in that page.' },
  { id: 'find.step', group: 'find', keys: 'Enter', label: 'Next match (Shift+Enter: the one before)', fixed: true, help: 'In the find bar. Esc closes it.' },
  { id: 'tab.next', group: 'tabs', keys: 'Ctrl+Tab', label: 'Next chat tab' },
  { id: 'tab.prev', group: 'tabs', keys: 'Ctrl+Shift+Tab', label: 'Previous chat tab' },
  ...tabJumps,
  ...layoutKeys,
  { id: 'tab.close', group: 'tabs', keys: 'Ctrl+W', label: 'Close the chat tab' },
  { id: 'tab.reopen', group: 'tabs', keys: 'Ctrl+Shift+T', label: 'Reopen the last closed tab', help: 'A chat, an area, a file or a page.' },
  { id: 'nav.back', group: 'move', keys: 'Alt+ArrowLeft', label: 'Back', help: 'To what was in front before. Inside a page of the Browser tab, Alt+← goes back in that page.' },
  { id: 'nav.forward', group: 'move', keys: 'Alt+ArrowRight', label: 'Forward' },
  { id: 'groups.resize', group: 'move', keys: '← → ↑ ↓', label: 'Resize groups', fixed: true, help: 'With the bar between two groups focused.' },
  { id: 'nav.mouse', group: 'move', keys: 'Mouse back / forward', label: 'Back and forward with the mouse\'s side buttons', fixed: true, help: 'Over a page of the Browser tab they go back in that page.' },
  { id: 'mic', group: 'mic', keys: 'Ctrl+,', label: 'Speak into the message box', setting: 'micKey', help: 'Starts while you are typing in a chat\'s message box. Toggle or hold: see How the key works below.' },
  { id: 'send', group: 'typing', keys: 'Enter', label: 'Send', fixed: true },
  { id: 'newline', group: 'typing', keys: 'Shift+Enter', label: 'New line', fixed: true },
  { id: 'mention', group: 'typing', keys: '@', label: 'Add files, chats or projects as context', fixed: true },
  { id: 'command', group: 'typing', keys: '/', label: 'Commands (/usage, /model, /strict, …)', fixed: true, help: 'At the start of the message box.' },
  { id: 'suggest', group: 'typing', keys: '↑ ↓ then Enter or Tab', label: 'Pick a suggestion', fixed: true },
  { id: 'escape', group: 'typing', keys: 'Escape', label: 'Close a dialog or suggestions', fixed: true },
  { id: 'settings.filter', group: 'settings', keys: 'Ctrl+F', label: 'Filter the open Settings list', fixed: true, where: 'settings', help: 'While Settings is open.' },
  { id: 'settings.search', group: 'settings', keys: '/', label: 'Search every setting', fixed: true, where: 'settings', help: 'While Settings is open and you are not typing.' },
  { id: 'zoom.in', group: 'zoom', keys: 'Ctrl+=', label: 'Zoom in', fixed: true, help: 'QuorX, the terminal\'s text or a page, whichever has the focus. Ctrl+wheel too.' },
  { id: 'zoom.out', group: 'zoom', keys: 'Ctrl+-', label: 'Zoom out', fixed: true },
  { id: 'zoom.reset', group: 'zoom', keys: 'Ctrl+0', label: 'Back to 100%', fixed: true },
  // The window: the menu bar's View and Edit menus read their keys from these rows, so the two never disagree.
  { id: 'view.sidebar', group: 'view', keys: 'Ctrl+B', label: 'Show or hide the sidebar' },
  // The activity bar's views (Search is chatsearch above). Pressed again while its view shows, a key hides the sidebar.
  { id: 'view.chats', group: 'view', keys: 'Ctrl+Shift+E', label: 'Chats view' },
  { id: 'view.running', group: 'view', keys: 'Ctrl+Shift+U', label: 'Running view', help: 'Everything running, in every project; what needs you on top.' },
  { id: 'view.servers', group: 'view', keys: '', label: 'Servers & pages view' },
  { id: 'view.source', group: 'view', keys: 'Ctrl+Shift+G', label: 'Source control view', help: 'This project\'s pull requests and this chat\'s branch.' },
  { id: 'view.extensions', group: 'view', keys: 'Ctrl+Shift+X', label: 'Extensions view', help: 'MCP servers, hooks and skills.' },
  { id: 'view.schedules', group: 'view', keys: '', label: 'Schedules view' },
  { id: 'view.spending', group: 'view', keys: '', label: 'Spending view' },
  { id: 'view.fullscreen', group: 'view', keys: 'F11', label: 'Full screen', fixed: true },
  { id: 'menu.focus', group: 'view', keys: 'Alt', label: 'Go to the menu bar', fixed: true, help: 'Press and let go of Alt, then ← → between menus and ↑ ↓ inside one.' },
  { id: 'edit.undo', group: 'edit', keys: 'Ctrl+Z', label: 'Undo typing', fixed: true },
  { id: 'edit.redo', group: 'edit', keys: 'Ctrl+Y', label: 'Redo typing', fixed: true },
  { id: 'edit.cut', group: 'edit', keys: 'Ctrl+X', label: 'Cut', fixed: true },
  { id: 'edit.copy', group: 'edit', keys: 'Ctrl+C', label: 'Copy', fixed: true },
  { id: 'edit.paste', group: 'edit', keys: 'Ctrl+V', label: 'Paste', fixed: true },
  { id: 'edit.all', group: 'edit', keys: 'Ctrl+A', label: 'Select all', fixed: true },
];
export const byId = new Map(SHORTCUTS.map((s) => [s.id, s]));

const ALIAS = { control: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta' };
const KEY_ALIAS = { esc: 'Escape', escape: 'Escape', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', del: 'Delete', return: 'Enter', space: 'Space', plus: '+' };
const MOD_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'];
/** "control+shift+t", "Shift+Ctrl+T", "ctrl+esc" → "Ctrl+Shift+T", "Ctrl+Escape"; '' for nothing. */
export function normCombo(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  const parts = raw.split('+');
  // "Ctrl++" is Ctrl and the plus key.
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+');
  const mods = new Set();
  let key = '';
  for (const p0 of parts) {
    const p = p0.trim(), m = ALIAS[p.toLowerCase()];
    if (m) mods.add(m);
    else key = KEY_ALIAS[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p);
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].filter(Boolean).join('+');
}
/** The keys each shortcut has now: the default, unless settings change it ('' = no key). Map id → combo. */
export function bindings(settings = {}) {
  const own = settings.keys || {}, out = new Map();
  for (const s of SHORTCUTS) {
    if (s.fixed) { out.set(s.id, s.keys); continue; }
    const v = s.setting ? settings[s.setting] : own[s.id];
    out.set(s.id, v == null ? s.keys : normCombo(v));
  }
  return out;
}
/** Which changeable shortcut a key press runs: the id, or null. */
export function actionFor(combo, map) {
  const c = normCombo(combo);
  if (!c) return null;
  for (const [id, k] of map) if (k === c && !byId.get(id)?.fixed) return id;
  return null;
}
// Keys that already mean something in Windows, a text box or the browser. They save, with a warning.
const SYSTEM = { 'Ctrl+C': 'copies', 'Ctrl+V': 'pastes', 'Ctrl+X': 'cuts', 'Ctrl+Z': 'undoes', 'Ctrl+Y': 'redoes', 'Ctrl+A': 'selects everything', 'Ctrl+S': 'saves', 'Ctrl+P': 'prints', 'Ctrl+R': 'reloads the page', F5: 'reloads the page', 'Ctrl+L': 'goes to the address bar', 'Alt+F4': 'closes the window', 'Ctrl+N': 'opens a new window', 'Ctrl+F': 'finds in the page', 'Ctrl+Shift+I': 'opens DevTools', F12: 'opens DevTools', 'Alt+Tab': 'switches windows' };
/**
 * Whether a key press can be a shortcut: { ok, error? , warn? }. It needs Ctrl or Alt (or is an F key), so typing
 * never runs one; a key Windows or the browser already uses saves with a warning.
 */
export function checkCombo(combo) {
  const c = normCombo(combo), parts = c.split('+'), key = parts.at(-1);
  if (!c || MOD_ORDER.includes(key)) return { ok: false, error: 'Press a key with it, not only Ctrl, Shift or Alt.' };
  const fkey = /^F([1-9]|1\d|2[0-4])$/.test(key);
  if (!fkey && !parts.some((p) => p === 'Ctrl' || p === 'Alt' || p === 'Meta')) return { ok: false, error: 'Use Ctrl or Alt with a key (or an F key), so typing never sets it off.' };
  return SYSTEM[c] ? { ok: true, warn: `${c} also ${SYSTEM[c]}: here it runs this shortcut instead.` } : { ok: true };
}
/**
 * Another shortcut that already has these keys (the clash that refuses a change): its entry, or null. Keys that only
 * work inside Settings (where: 'settings') don't clash with the app's, which are off while Settings is open.
 */
export function clashWith(id, combo, map) {
  const c = normCombo(combo);
  if (!c) return null;
  for (const [other, k] of map) if (other !== id && k === c && (byId.get(other)?.where || '') === (byId.get(id)?.where || '')) return byId.get(other);
  return null;
}
/** Shortcuts that share keys right now (e.g. from an older settings file): Map id → the other entries. */
export function conflicts(map) {
  const seen = new Map(), out = new Map();
  for (const [id, k] of map) { if (!k || byId.get(id)?.fixed) continue; (seen.get(k) || seen.set(k, []).get(k)).push(id); }
  for (const ids of seen.values()) if (ids.length > 1) for (const id of ids) out.set(id, ids.filter((x) => x !== id).map((x) => byId.get(x)));
  return out;
}
const SHOW = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Space: 'Space' };
/** For tips and keycaps: "Ctrl+Shift+T" → ['Ctrl', 'Shift', 'T'], "Alt+ArrowLeft" → ['Alt', '←']. */
export function comboParts(combo) {
  const c = String(combo || '');
  if (!c) return [];
  if (!/^[^+\s]+(\+[^+\s]+)*(\+\+)?$/.test(c) || c.includes(' ')) return [c]; // "↑ ↓ then Enter or Tab", "Mouse back / forward"
  const parts = c.endsWith('++') ? [...c.slice(0, -2).split('+'), '+'] : c.split('+');
  return parts.map((p) => SHOW[p] || p);
}
/** "Ctrl+Shift+T" for a tip; '' when the shortcut has no key. */
export const comboText = (combo) => comboParts(combo).join('+');
