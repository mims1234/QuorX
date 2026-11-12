// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The window frame's model: the menu bar's menus as data, the open project tabs (row 2) and moving through a menu
// with the keys. Nothing here touches the page, so it is tested on its own; app.js ("the window frame") draws it and
// runs each item.
//
// A menu item is { label, act, key?, sub?, only? }:
// - act names the action app.js runs (its FRAME_ACTS table); every act here must be there, so no item is dead.
// - key is the id of a row in the shortcuts table (public/keymap.js). The key shown is read from that table, so a
//   menu and Settings → Shortcuts never disagree, and a key you change shows changed in the menu too.
// - sub names a list app.js builds when the menu opens (themes, layouts, open chat tabs…).
// - only: 'desk' for items that need the desktop app (full screen, quit, keep awake); hidden in a browser.
// '-' is a divider.

export const MENUS = [
  { name: 'QuorX', items: [
    { label: 'About QuorX', act: 'about' },
    { label: 'Check for updates', act: 'updates', only: 'desk' }, '-',
    { label: 'Settings', act: 'settings' },
    { label: 'Providers & keys', act: 'providers' },
    { label: 'Keyboard shortcuts', act: 'shortcuts' }, '-',
    { label: 'Theme', sub: 'theme' },
    { label: 'Restart the harness', act: 'restart' }, '-',
    { label: 'Report a problem…', act: 'report' }, '-',
    { label: 'Quit QuorX', act: 'quit', only: 'desk' },
  ] },
  { name: 'File', items: [
    { label: 'New chat', act: 'newChat' },
    { label: 'New project…', act: 'newProject' },
    { label: 'Open project folder…', act: 'openFolder' }, '-',
    { label: 'Attach file…', act: 'attach' },
    { label: 'Reopen closed tab', act: 'reopenTab', key: 'tab.reopen' }, '-',
    { label: 'Project settings…', act: 'projectSettings' },
    { label: 'Save layout as…', act: 'saveLayout' }, '-',
    { label: 'Close tab', act: 'closeTab', key: 'tab.close' },
    { label: 'Close project tab', act: 'closeProject' },
  ] },
  { name: 'Edit', items: [
    { label: 'Undo', act: 'undo', key: 'edit.undo' },
    { label: 'Redo', act: 'redo', key: 'edit.redo' }, '-',
    { label: 'Cut', act: 'cut', key: 'edit.cut' },
    { label: 'Copy', act: 'copy', key: 'edit.copy' },
    { label: 'Paste', act: 'paste', key: 'edit.paste' },
    { label: 'Select all', act: 'selectAll', key: 'edit.all' }, '-',
    { label: 'Find', act: 'find', key: 'find' },
    { label: 'Search inside chats', act: 'searchChats', key: 'chatsearch' },
  ] },
  { name: 'View', items: [
    { label: 'Go to or run…', act: 'palette', key: 'palette' }, '-',
    { label: 'Sidebar', act: 'toggleSidebar', key: 'view.sidebar' },
    { label: 'Places', sub: 'places' }, '-',
    { label: 'Layout', sub: 'layouts' },
    { label: 'Maximise group', act: 'maximise' }, '-',
    { label: 'Zoom in', act: 'zoomIn', key: 'zoom.in', only: 'desk' },
    { label: 'Zoom out', act: 'zoomOut', key: 'zoom.out', only: 'desk' },
    { label: 'Reset zoom', act: 'zoomReset', key: 'zoom.reset', only: 'desk' },
    { label: 'Full screen', act: 'fullscreen', key: 'view.fullscreen' },
  ] },
  { name: 'Chat', items: [
    { label: 'Send', act: 'send', key: 'send' },
    { label: 'Stop', act: 'stop' },
    { label: 'Continue', act: 'continue' }, '-',
    { label: 'Side question (/btw)…', act: 'btw' },
    { label: 'Show steps', act: 'showSteps' },
    { label: 'Undo the last reply\'s file changes', act: 'undoReply' }, '-',
    { label: 'Compact conversation', act: 'compact' },
    { label: 'Budget…', act: 'budget' },
    { label: 'Cost of this chat (/usage)', act: 'usage' }, '-',
    { label: 'Approval mode', sub: 'approval' },
    { label: 'Model…', act: 'model' }, '-',
    { label: 'Dictate', act: 'dictate', key: 'mic' },
    { label: 'New chat from a brief of this one…', act: 'fresh' },
  ] },
  { name: 'Agent', items: [
    { label: 'Let through in YOLO…', act: 'letThrough' }, '-',
    { label: 'What QuorX may use on this PC…', act: 'perms' }, '-',
    { label: 'MCP servers…', act: 'mcp' },
    { label: 'Skills…', act: 'skills' },
    { label: 'Permissions…', act: 'permissions' },
    { label: 'Hooks & design system (project settings)…', act: 'projectSettings' }, '-',
    { label: 'Approvals & safety…', act: 'safety' },
    { label: 'Deciders…', act: 'deciders' },
    { label: 'Memory…', act: 'memory' },
  ] },
  { name: 'Run', items: [
    { label: 'Servers & pages', act: 'servers' },
    { label: 'Running everywhere', act: 'running' },
    { label: 'Terminal', act: 'terminal' },
    { label: 'Files', act: 'files' }, '-',
    { label: 'Review changes (/review)', act: 'review' }, '-',
    { label: 'Schedules…', act: 'schedules' },
    { label: 'Spending…', act: 'spending' },
  ] },
  { name: 'Window', items: [
    { label: 'Split right', act: 'splitRight' },
    { label: 'Split down', act: 'splitDown' },
    { label: 'Pop out to its own window', act: 'popOut' },
    { label: 'This group follows the agent', act: 'follow' }, '-',
    { label: 'Next chat tab', act: 'nextTab', key: 'tab.next' },
    { label: 'Previous chat tab', act: 'prevTab', key: 'tab.prev' },
    { label: 'Chat tabs', sub: 'chatTabs' }, '-',
    { label: 'Back', act: 'back', key: 'nav.back' },
    { label: 'Forward', act: 'forward', key: 'nav.forward' }, '-',
    { label: 'Keep the PC awake', act: 'keepAwake', only: 'desk' },
    { label: 'Summon key…', act: 'summonKey', only: 'desk' },
  ] },
  { name: 'Help', items: [
    { label: 'What\'s new', act: 'whatsNew' },
    { label: 'Keyboard shortcuts', act: 'shortcuts' },
    { label: 'Setup check', act: 'setupCheck' }, '-',
    { label: 'QuorX on GitHub', act: 'github' },
    { label: 'Report a problem…', act: 'report' }, '-',
    { label: 'About QuorX', act: 'about' },
  ] },
];

/** Every action id and shortcut id the menus use: tests check each one is real. */
export function menuRefs(menus = MENUS) {
  const acts = new Set(), keys = new Set(), subs = new Set();
  for (const m of menus) for (const it of m.items) {
    if (it === '-') continue;
    if (it.act) acts.add(it.act);
    if (it.key) keys.add(it.key);
    if (it.sub) subs.add(it.sub);
  }
  return { acts, keys, subs };
}

/**
 * The items a menu shows here: desktop-only ones go in a browser, and no divider is left at either end or twice in a
 * row once items are gone.
 */
export function visibleItems(items, { desk = false } = {}) {
  const out = [];
  for (const it of items) {
    if (it === '-') { if (out.length && out.at(-1) !== '-') out.push('-'); continue; }
    if (it.only === 'desk' && !desk) continue;
    out.push(it);
  }
  while (out.at(-1) === '-') out.pop();
  return out;
}

/** The next item the arrow keys land on from index i (dir 1 down, -1 up), stepping over dividers and disabled ones. */
export function stepItem(items, i, dir) {
  const n = items.length;
  if (!n) return -1;
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    const it = items[j];
    if (it && it !== '-' && !it.disabled) return j;
  }
  return -1;
}

/** Alt+letter and typing a letter in an open menu: the next item whose label starts with it, after index i. */
export function itemByLetter(items, letter, i = -1) {
  const l = String(letter || '').toLowerCase();
  if (!l) return -1;
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n, it = items[j];
    if (it && it !== '-' && !it.disabled && String(it.label).trim().toLowerCase().startsWith(l)) return j;
  }
  return -1;
}

// ---------- the open project tabs (row 2) ----------
// One tab per open project, in your order, saved in the browser. A project opens as a tab when you bring one of its
// chats to the front (or pick it under ＋); × takes it off the row. Its chats, tabs and layout are kept as they were and
// come back when it opens again. Archived and deleted projects drop off.

/** The row as it should be now: known, not archived, each once, and the project on screen always on it. */
export function openTabs(list, { known = [], current = null } = {}) {
  const ok = new Set(known.filter((p) => p && !p.archived).map((p) => p.id));
  const out = [];
  for (const id of Array.isArray(list) ? list : []) if (ok.has(id) && !out.includes(id)) out.push(id);
  if (current && ok.has(current) && !out.includes(current)) out.push(current);
  return out;
}

/** A first row for someone with no saved one: the projects with open chat tabs, most recently used first, then the one on screen. */
export function firstTabs({ known = [], withTabs = new Set(), lastUsed = () => 0, current = null, max = 6 } = {}) {
  const ids = known.filter((p) => p && !p.archived && withTabs.has(p.id)).sort((a, b) => lastUsed(b.id) - lastUsed(a.id)).map((p) => p.id).slice(0, max);
  return openTabs(ids, { known, current });
}

/**
 * × on a project tab: the row without it, and the project to show next when it was the one on screen (its right-hand
 * neighbour, else its left, else none: Home).
 */
export function closeTab(list, id, current) {
  const i = list.indexOf(id);
  if (i < 0) return { list, next: undefined };
  const rest = list.filter((x) => x !== id);
  if (id !== current) return { list: rest, next: undefined };
  return { list: rest, next: rest[i] ?? rest[i - 1] ?? null };
}

/** Dragging a tab onto another: it goes before that one (after it, when dropped past its middle). */
export function moveTab(list, id, target, after = false) {
  if (id === target || !list.includes(id) || !list.includes(target)) return list;
  const rest = list.filter((x) => x !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
