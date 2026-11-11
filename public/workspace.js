// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The workspace layout: a tree of splits and groups, and the kinds of tab a group can hold.
//
// A split is { t: 's', dir: 'row' | 'col', kids: [...], w } and lays its children out side by side (row) or stacked
// (col); a group is { t: 'g', id, tabs: [tabId…], active, w } and shows one tab at a time. w is a node's share of its
// parent's space. A layout is { root, focus, next }: focus is the group you used last, next numbers new groups.
// At most MAX_GROUPS groups: it keeps the window readable and stops real browser tabs from multiplying.
//
// Every function here is pure: it takes a layout and returns a new one (or a read-only answer), so the page can keep
// the last good layout, compare, save and undo. Nothing here touches the page; app.js draws a layout.

export const MAX_GROUPS = 4;
const ZONES = new Set(['center', 'left', 'right', 'top', 'bottom']);
const copy = (x) => structuredClone(x);
const w3 = (n) => Math.round((Number(n) > 0 ? Number(n) : 1) * 1000) / 1000;

// ---------- building and reading ----------
export const group = (id, tabs = [], active = tabs[0] ?? null, w = 1) => ({ t: 'g', id, tabs: [...tabs], active: tabs.includes(active) ? active : (tabs[0] ?? null), w: w3(w) });
export const split = (dir, kids, w = 1) => ({ t: 's', dir: dir === 'col' ? 'col' : 'row', kids, w: w3(w) });
export function createLayout(root = null, focus = null) {
  const lay = { root, focus, next: 1 };
  const gs = groups(lay);
  lay.next = Math.max(1, ...gs.map((g) => Number(String(g.id).replace(/^\D+/, '')) + 1 || 1));
  if (!gs.some((g) => g.id === focus)) lay.focus = gs[0]?.id ?? null;
  return lay;
}
const rootOf = (x) => (x && 'root' in x ? x.root : x);
/** Every group, in reading order (left to right, top to bottom). */
export function groups(x, out = []) {
  const n = rootOf(x);
  if (!n) return out;
  if (n.t === 'g') out.push(n); else for (const k of n.kids) groups(k, out);
  return out;
}
export const findGroup = (x, id) => groups(x).find((g) => g.id === id) || null;
export const groupOf = (x, tabId) => groups(x).find((g) => g.tabs.includes(tabId)) || null;
export const allTabs = (x) => groups(x).flatMap((g) => g.tabs);
/** The split a node sits in (null for the root). */
export function parentOf(x, target, p = null) {
  const n = rootOf(x);
  if (!n) return null;
  if (n === target) return p;
  if (n.t === 's') for (const k of n.kids) { const r = parentOf(k, target, n); if (r) return r; }
  return null;
}
const parentOfId = (root, id) => parentOf(root, findGroup(root, id));

// ---------- normalising ----------
/**
 * Tidies a tree: empty groups go, a split with one child becomes that child (keeping the split's share), and a split
 * inside a split of the same direction is flattened into it. Groups past MAX_GROUPS are dropped (their tabs merged into
 * the last group kept), so a hand-edited or old save can't break the cap.
 */
export function norm(n, keepEmpty = null) {
  if (!n) return null;
  if (n.t === 'g') return n.tabs.length || n.id === keepEmpty ? n : null;
  let kids = n.kids.map((k) => norm(k, keepEmpty)).filter(Boolean);
  // A flattened child's share is its share of the inner split, times the inner split's share.
  kids = kids.flatMap((k) => {
    if (k.t !== 's' || k.dir !== n.dir) return [k];
    const sum = k.kids.reduce((s, kk) => s + kk.w, 0) || 1;
    return k.kids.map((kk) => ({ ...kk, w: w3((kk.w / sum) * k.w) }));
  });
  if (!kids.length) return null;
  if (kids.length === 1) return { ...kids[0], w: n.w };
  return { ...n, kids };
}
function capGroups(root) {
  const gs = groups(root);
  if (gs.length <= MAX_GROUPS) return root;
  const keep = gs.slice(0, MAX_GROUPS), last = keep.at(-1), drop = new Set(gs.slice(MAX_GROUPS).map((g) => g.id));
  for (const g of gs.slice(MAX_GROUPS)) for (const t of g.tabs) if (!last.tabs.includes(t)) last.tabs.push(t);
  const cut = (n) => (n.t === 'g' ? (drop.has(n.id) ? null : n) : { ...n, kids: n.kids.map(cut).filter(Boolean) });
  return norm(cut(root));
}
function finish(lay, root, focus = lay.focus, keepEmpty = null) {
  const r = capGroups(norm(root, keepEmpty));
  const out = { root: r, focus, next: lay.next };
  if (!findGroup(r, out.focus)) out.focus = groups(r)[0]?.id ?? null;
  return out;
}

// ---------- changing ----------
/**
 * Adds a new group next to `targetId` on one side (left / right / top / bottom), holding `tabs`. The target keeps its
 * place: the new group is put beside it, never by moving the others (a moved frame reloads, a terminal loses its screen).
 * The two share the target's old space. Refused past MAX_GROUPS: { ok: false, reason: 'max' }.
 */
export function addGroup(lay, targetId, zone, tabs, { active, id } = {}) {
  const root = copy(lay.root), target = findGroup(root, targetId);
  if (!target || !ZONES.has(zone) || zone === 'center') return { ok: false, reason: 'target', layout: lay };
  if (groups(root).length >= MAX_GROUPS) return { ok: false, reason: 'max', layout: lay };
  const gid = id || `g${lay.next}`;
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col', before = zone === 'left' || zone === 'top';
  const p = parentOf(root, target);
  let next;
  if (p && p.dir === dir) {
    const half = w3(target.w / 2), ng = group(gid, tabs, active, half);
    target.w = half;
    const i = p.kids.indexOf(target); p.kids.splice(before ? i : i + 1, 0, ng);
    next = root;
  } else {
    const ng = group(gid, tabs, active, 1), sp = split(dir, before ? [ng, target] : [target, ng], target.w);
    target.w = 1;
    if (!p) next = sp; else { p.kids[p.kids.indexOf(target)] = sp; next = root; }
  }
  const out = finish({ ...lay, next: lay.next + 1 }, next, gid);
  return { ok: true, layout: out, groupId: gid };
}
/** Takes a tab out of its group. The group goes when it is empty, unless it is the last one. */
export function removeTab(lay, tabId) {
  const root = copy(lay.root), g = groupOf(root, tabId);
  if (!g) return lay;
  const i = g.tabs.indexOf(tabId);
  g.tabs.splice(i, 1);
  if (g.active === tabId) g.active = g.tabs[Math.max(0, i - 1)] ?? null;
  const last = groups(root).length === 1;
  return finish(lay, root, lay.focus, last ? g.id : null);
}
/** Takes a whole group away; its space goes to its neighbours. The last group can't go. */
export function removeGroup(lay, groupId) {
  if (groups(lay).length < 2) return lay;
  const root = copy(lay.root), g = findGroup(root, groupId);
  if (!g) return lay;
  const p = parentOf(root, g);
  const i = p.kids.indexOf(g), n = p.kids[i ? i - 1 : 1];
  n.w = w3(n.w + g.w);
  p.kids.splice(i, 1);
  return finish(lay, root, lay.focus === groupId ? (groups(n)[0]?.id ?? null) : lay.focus);
}
/**
 * Moves (or puts) a tab into a group: in the middle (zone 'center') it joins the group's tabs and is shown; on an edge it
 * gets a new group beside the target. Refused past MAX_GROUPS unless moving the tab empties its own group.
 */
export function placeTab(lay, tabId, targetId, zone = 'center', { id } = {}) {
  if (!findGroup(lay, targetId) || !ZONES.has(zone)) return { ok: false, reason: 'target', layout: lay };
  const src = groupOf(lay, tabId);
  if (zone === 'center') {
    let l = src && src.id !== targetId ? removeTab(lay, tabId) : lay;
    if (!findGroup(l, targetId)) return { ok: false, reason: 'target', layout: lay };
    const root = copy(l.root), t = findGroup(root, targetId);
    if (!t.tabs.includes(tabId)) t.tabs.push(tabId);
    t.active = tabId;
    return { ok: true, layout: finish(l, root, targetId), groupId: targetId };
  }
  if (src && src.id === targetId && src.tabs.length === 1) return { ok: false, reason: 'same', layout: lay };
  const frees = src && src.tabs.length === 1;
  if (groups(lay).length >= MAX_GROUPS && !frees) return { ok: false, reason: 'max', layout: lay };
  // Out of its old group first (that may free a slot), then beside the target.
  const l = src ? removeTab(lay, tabId) : lay;
  if (!findGroup(l, targetId)) return { ok: false, reason: 'target', layout: lay };
  return addGroup(l, targetId, zone, [tabId], { id });
}
export function setActive(lay, groupId, tabId) {
  const root = copy(lay.root), g = findGroup(root, groupId);
  if (!g || !g.tabs.includes(tabId)) return lay;
  g.active = tabId;
  return finish(lay, root, groupId);
}
export function setFocus(lay, groupId) { return findGroup(lay, groupId) ? { ...lay, focus: groupId } : lay; }
/** Sets the shares of a split's children (or of one group's siblings): weights by group id, any positive numbers. */
export function setWeights(lay, weights) {
  const root = copy(lay.root);
  for (const g of groups(root)) if (g.id in weights) g.w = w3(weights[g.id]);
  return { ...lay, root };
}

// ---------- saving ----------
/**
 * The layout as plain JSON for localStorage, version 1. `tabs` is the state each tab saves ({ [tabId]: { kind, ... } }),
 * kept only for tabs in the tree.
 */
export function serialise(lay, tabs = {}, closed = []) {
  const live = new Set(allTabs(lay));
  return JSON.stringify({ v: 1, root: lay.root, focus: lay.focus, tabs: Object.fromEntries(Object.entries(tabs).filter(([id]) => live.has(id))), ...(closed?.length ? { closed: cleanClosed(closed) } : {}) });
}
/** Reads a saved layout back, checking its shape. Anything it can't use gives null (the caller starts from its default). */
export function parse(text) {
  let s = text;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return null; } }
  if (!s || s.v !== 1 || !s.root) return null;
  const seen = new Set(), ids = new Set();
  const check = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 8) return null;
    if (n.t === 'g') {
      if (typeof n.id !== 'string' || ids.has(n.id)) return null;
      ids.add(n.id);
      const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter((t) => typeof t === 'string' && !seen.has(t) && seen.add(t));
      return group(n.id, tabs, n.active, n.w);
    }
    if (n.t === 's' && Array.isArray(n.kids)) return split(n.dir, n.kids.map((k) => check(k, depth + 1)).filter(Boolean), n.w);
    return null;
  };
  const root = capGroups(norm(check(s.root, 0)));
  if (!root) return null;
  const lay = createLayout(root, s.focus);
  const live = new Set(allTabs(lay));
  const tabs = s.tabs && typeof s.tabs === 'object' ? Object.fromEntries(Object.entries(s.tabs).filter(([id, v]) => live.has(id) && v && typeof v === 'object')) : {};
  return { layout: lay, tabs, closed: cleanClosed(s.closed) };
}

// ---------- open chats, and the tabs you closed ----------
// The chat group's tabs are the chats open as tabs along the top, in their order; its active tab is the chat on
// screen. Closing a tab (a chat, a pane area, a file, a page in the Browser) puts what it takes to bring it back on a
// per-project stack of the last CLOSED_CAP, newest last; Ctrl+Shift+T takes the newest off.
export const CLOSED_CAP = 50;
const CLOSED_KINDS = new Set(['chat', 'area', 'file', 'page']);
/** Only well-formed entries ({ kind, … } of a known kind, plain JSON), the newest CLOSED_CAP. */
export function cleanClosed(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === 'object' && CLOSED_KINDS.has(e.kind)).map((e) => JSON.parse(JSON.stringify(e))).slice(-CLOSED_CAP);
}
/** Same thing closed again: one entry, moved to the top. */
const closedKey = (e) => (e.kind === 'chat' ? `chat:${e.id}` : e.kind === 'file' ? `file:${e.chat}:${e.f?.id}` : e.kind === 'page' ? `page:${e.url}` : null);
export function pushClosed(list, e) {
  const k = closedKey(e);
  return cleanClosed([...(list || []).filter((x) => !k || closedKey(x) !== k), e]);
}
/** The newest entry (or the newest that ok accepts), and the stack without it. */
export function popClosed(list, ok) {
  const l = cleanClosed(list);
  for (let i = l.length - 1; i >= 0; i--) if (!ok || ok(l[i])) return { entry: l[i], list: [...l.slice(0, i), ...l.slice(i + 1)] };
  return { entry: null, list: l };
}
/** The chat ids open as tabs, in order. */
export const chatTabIds = (lay) => (findGroup(lay, CHAT_GROUP)?.tabs || []).filter((t) => kindOf(t) === 'chat' && t !== 'chat:main').map((t) => t.slice(5));
/** The layout with these chats as its chat tabs (active: the one on screen). Never mutates. */
export function withChatTabs(lay, ids, active = null) {
  if (!findGroup(lay, CHAT_GROUP)) return lay;
  const tabs = [...new Set(ids.map(String))].map((id) => tabId('chat', id)), root = copy(lay.root);
  const g = findGroup(root, CHAT_GROUP);
  g.tabs = tabs.length ? tabs : [tabId('chat', 'main')];
  g.active = active != null && tabs.includes(tabId('chat', active)) ? tabId('chat', active) : g.tabs[0];
  return { ...lay, root };
}
/** Where a chat opened from outside the strip goes: right after the one on screen (the end if none). */
export function insertTab(ids, id, after = null) {
  if (ids.includes(id)) return [...ids];
  const i = after != null ? ids.indexOf(after) : -1;
  return i < 0 ? [...ids, id] : [...ids.slice(0, i + 1), id, ...ids.slice(i + 1)];
}
/** Moves a tab to sit before `before` (the end when null). */
export function moveTab(ids, id, before = null) {
  if (!ids.includes(id) || id === before) return [...ids];
  const rest = ids.filter((x) => x !== id), i = before == null ? -1 : rest.indexOf(before);
  return i < 0 ? [...rest, id] : [...rest.slice(0, i), id, ...rest.slice(i)];
}
/** Ctrl+Tab: the next (dir 1) or previous (-1) tab, round the end. */
export function cycleTab(ids, cur, dir = 1) {
  if (!ids.length) return null;
  const i = ids.indexOf(cur);
  return ids[(((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir) % ids.length + ids.length) % ids.length];
}
/** Which tab comes to the front when the one on screen closes: the one to its right, else its left. */
export function afterClose(ids, id) {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

// ---------- tab kinds ----------
// Each kind says what it is (name, icon), who owns it ('chat': it follows a chat; 'project': the project's own, like
// the browser tabs and the terminal; null: the whole app), which per-tab values it keeps (keys: the values the page
// used to keep per pane area), how they save (save/load: plain JSON, only what should survive a reload), and its
// pane name today (pane: the side pane's tab it is drawn as). app.js adds how each draws into a box (render) with
// defineTabKind. One Browser tab holds its own page tabs, address bar and back / forward: that stays the browser's own.
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));
export const TAB_KINDS = {
  chat: { name: 'Chat', icon: '💬', owner: 'chat', pane: null, keys: [], save: () => ({}), load: () => ({}) },
  artifact: { name: 'Artifact', icon: '📄', owner: 'chat', pane: 'art', keys: ['watch', 'cardTimer'], save: (st) => pick(st, ['art']), load: (j) => pick(j, ['art']) },
  browser: { name: 'Browser', icon: '🌐', owner: 'project', pane: 'browser', keys: ['bActive', 'dsk'], save: (st) => (st.bActive ? { b: st.bActive } : {}), load: (j) => (typeof j?.b === 'string' ? { bActive: j.b } : {}) },
  steps: { name: 'Steps', icon: '🧭', owner: 'chat', pane: 'trace', keys: ['traceRun', 'traceShown', 'traceAt', 'traceTimer'], save: () => ({}), load: () => ({}) },
  terminal: { name: 'Terminal', icon: '⌨', owner: 'project', pane: 'term', keys: ['termTf', 'termLay'],
    save: (st) => (st.termLay?.panes ? { tf: st.termLay.panes.map((p) => p.filter) } : st.termTf ? { tf: st.termTf } : {}),
    load: (j) => (Array.isArray(j?.tf) ? { termTf: j.tf.map(String).slice(0, 6) } : {}) },
  files: { name: 'Files', icon: '📁', owner: 'project', pane: 'files', keys: [], save: () => ({}), load: () => ({}) },
  viewer: { name: 'File', icon: '🖼', owner: 'chat', pane: 'art', keys: [], save: (st) => pick(st, ['src', 'name', 'kind']), load: (j) => pick(j, ['src', 'name', 'kind']) },
  page: { name: 'Page', icon: '📃', owner: 'chat', pane: 'art', keys: [], save: (st) => pick(st, ['url']), load: (j) => pick(j, ['url']) },
  running: { name: 'Running', icon: '▶', owner: null, pane: 'run', keys: [], save: () => ({}), load: () => ({}) },
  servers: { name: 'Servers', icon: '🖥', owner: 'project', pane: null, keys: [], save: () => ({}), load: () => ({}) },
};
/** app.js fills in how a kind draws: defineTabKind('browser', { render(tab, box) {…} }). */
export function defineTabKind(kind, impl) {
  if (!TAB_KINDS[kind]) throw new Error(`unknown tab kind: ${kind}`);
  Object.assign(TAB_KINDS[kind], impl);
  return TAB_KINDS[kind];
}
export const tabKind = (kind) => TAB_KINDS[kind] || null;
// The side pane's five tabs today, in strip order, by their pane name.
export const PANE_KINDS = { art: 'artifact', browser: 'browser', trace: 'steps', term: 'terminal', files: 'files' };
export const KIND_PANE = Object.fromEntries(Object.entries(PANE_KINDS).map(([p, k]) => [k, p]));
/** A tab's id: its kind, then what makes it one of a kind (a group for pane tabs, a chat id for a chat). */
export const tabId = (kind, of) => `${kind}:${of}`;
export const kindOf = (id) => String(id).split(':')[0];
/** The five pane tabs one group holds today. */
export const paneTabs = (gid) => Object.values(PANE_KINDS).map((k) => tabId(k, gid));

// ---------- today's screen: the chat on the left, the side pane's areas stacked on the right ----------
export const CHAT_GROUP = 'chat';
/** The default: a chat group and one side group showing `pane` (Artifact unless told). */
export function defaultLayout(pane = 'art') {
  return createLayout(split('row', [group(CHAT_GROUP, [tabId('chat', 'main')]), group('g1', paneTabs('g1'), tabId(PANE_KINDS[pane] || 'artifact', 'g1'))]), 'g1');
}
/** The side pane's groups, top to bottom: every group but the chat's, in reading order. */
export const sideGroups = (lay) => groups(lay).filter((g) => g.id !== CHAT_GROUP);
/** Which pane tab a group shows ('art', 'browser', …). */
export const groupPane = (g) => KIND_PANE[kindOf(g?.active)] || 'art';

/**
 * The per-chat save of the side pane's areas (before layouts were per project: { areas: [{ tab, grow, art, b, tf }],
 * f }) as a layout and its tab state.
 */
export function fromAreas(saved) {
  const areas = Array.isArray(saved?.areas) ? saved.areas.slice(0, MAX_GROUPS - 1) : [];
  if (!areas.length) return null;
  const tabs = {}, side = areas.map((a, i) => {
    const gid = `g${i + 1}`, pane = PANE_KINDS[a?.tab] ? a.tab : 'art';
    if (a?.art) tabs[tabId('artifact', gid)] = { kind: 'artifact', art: String(a.art) };
    if (a?.b) tabs[tabId('browser', gid)] = { kind: 'browser', b: String(a.b) };
    if (Array.isArray(a?.tf)) tabs[tabId('terminal', gid)] = { kind: 'terminal', tf: a.tf.map(String).slice(0, 6) };
    return group(gid, paneTabs(gid), tabId(PANE_KINDS[pane], gid), Number(a?.grow) || 1);
  });
  const f = Math.min(Math.max(0, Number(saved.f) || 0), side.length - 1);
  const root = split('row', [group(CHAT_GROUP, [tabId('chat', 'main')]), side.length > 1 ? split('col', side) : side[0]]);
  return { layout: createLayout(root, side[f].id), tabs };
}
/** The other way, written next to the new save for one release, so going back to an older QuorX keeps the split. */
export function toAreas(lay, tabs = {}) {
  const side = sideGroups(lay);
  if (side.length < 2) return null;
  const areas = side.map((g) => {
    const t = (k) => tabs[tabId(k, g.id)] || {};
    return { tab: groupPane(g), grow: w3(g.w), art: t('artifact').art || null, b: t('browser').b || null, ...(t('terminal').tf ? { tf: t('terminal').tf } : {}) };
  });
  return { areas, f: Math.max(0, side.findIndex((g) => g.id === lay.focus)) };
}
/**
 * First start with per-project layouts: each chat's saved split moves to its project, the most recently used chat's
 * winning. old: [{ chatId, value }] (the raw saves); chats: [{ id, projectId, updated }]. Gives { [projectId]: text }.
 * Projects that already have a layout (have) are left alone.
 */
export function migrateAreas(old, chats, have = new Set()) {
  const byId = new Map(chats.map((c) => [c.id, c])), best = new Map();
  for (const { chatId, value } of old) {
    const c = byId.get(chatId); if (!c) continue;
    const pid = c.projectId || 'scratch';
    if (have.has(pid)) continue;
    let s = null; try { s = typeof value === 'string' ? JSON.parse(value) : value; } catch { continue; }
    const r = fromAreas(s); if (!r) continue;
    const at = Number(c.updated) || 0;
    if (!best.has(pid) || best.get(pid).at < at) best.set(pid, { at, text: serialise(r.layout, r.tabs) });
  }
  return Object.fromEntries([...best].map(([pid, { text }]) => [pid, text]));
}
