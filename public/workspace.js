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
/**
 * Moves a whole group beside another (zone left / right / top / bottom), keeping its id, tabs and shown tab: the chat
 * moves this way. It never adds a group, so the cap doesn't stop it. Refused onto itself or with nothing else to sit by.
 */
export function moveGroup(lay, groupId, targetId, zone) {
  const g = findGroup(lay, groupId);
  if (!g || groupId === targetId || !findGroup(lay, targetId) || !ZONES.has(zone) || zone === 'center') return { ok: false, reason: 'target', layout: lay };
  const l = removeGroup(lay, groupId);
  if (l === lay) return { ok: false, reason: 'target', layout: lay };
  const r = addGroup({ ...l, next: lay.next - 1 }, targetId, zone, g.tabs, { active: g.active, id: g.id });
  return r.ok ? { ok: true, layout: { ...r.layout, next: lay.next, focus: lay.focus }, groupId } : { ok: false, reason: r.reason, layout: lay };
}
/** Moves a whole group to one side of everything (the chat on the right of the window, say). */
export function moveGroupToEdge(lay, groupId, zone) {
  const g = findGroup(lay, groupId);
  if (!g || !ZONES.has(zone) || zone === 'center' || groups(lay).length < 2) return { ok: false, reason: 'target', layout: lay };
  const l = removeGroup(lay, groupId), rest = { ...copy(l.root), w: 1 };
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col', before = zone === 'left' || zone === 'top';
  // The moved group keeps a share like the one it had of its old split (about half the window, at most).
  const share = Math.min(1, Math.max(0.25, g.w)), ng = group(g.id, g.tabs, g.active, share);
  const root = split(dir, before ? [ng, rest] : [rest, ng]);
  return { ok: true, layout: finish(l, root, lay.focus), groupId };
}
/** A tab swapped for another in place (a preview tab reused by the next file): same group, same spot. */
export function replaceTab(lay, oldId, newId) {
  const root = copy(lay.root), g = groupOf(root, oldId);
  if (!g || groupOf(root, newId)) return lay;
  g.tabs[g.tabs.indexOf(oldId)] = newId;
  if (g.active === oldId) g.active = newId;
  return { ...lay, root };
}

// ---------- placing the groups on screen ----------
// Every group is placed by a rectangle worked out from the tree, so the page can position each one absolutely and never
// move a group's box in the page: a moved frame reloads, and a terminal loses its screen. Between the children of a
// split sits a bar `gap` wide that resizes the two either side of it.
/** The node a path of child indexes leads to (the root for []). */
export function nodeAt(x, path) {
  let n = rootOf(x);
  for (const i of path || []) { if (!n || n.t !== 's') return null; n = n.kids[i]; }
  return n || null;
}
/**
 * Rectangles for every group in box { x, y, w, h }: { groups: { [id]: { x, y, w, h } }, bars: [{ path, i, dir, x, y, w, h }] }.
 * A bar sits between kids i and i+1 of the split at path; dir is that split's direction ('row': a bar you drag sideways).
 */
export function rects(x, box, gap = 6) {
  const out = { groups: {}, bars: [] };
  const walk = (n, b, path) => {
    if (!n) return;
    if (n.t === 'g') { out.groups[n.id] = { ...b }; return; }
    const row = n.dir === 'row', size = row ? b.w : b.h, free = Math.max(0, size - gap * (n.kids.length - 1));
    const sum = n.kids.reduce((s, k) => s + k.w, 0) || 1;
    let at = row ? b.x : b.y;
    n.kids.forEach((k, i) => {
      const len = i === n.kids.length - 1 ? (row ? b.x + b.w : b.y + b.h) - at : Math.round((free * k.w) / sum);
      walk(k, row ? { x: at, y: b.y, w: len, h: b.h } : { x: b.x, y: at, w: b.w, h: len }, [...path, i]);
      at += len;
      if (i < n.kids.length - 1) { out.bars.push({ path, i, dir: n.dir, ...(row ? { x: at, y: b.y, w: gap, h: b.h } : { x: b.x, y: at, w: b.w, h: gap }) }); at += gap; }
    });
  };
  walk(rootOf(x), { x: box.x || 0, y: box.y || 0, w: box.w, h: box.h }, []);
  return out;
}
/** The shares of two neighbours in the split at path, as their sizes a and b (pixels, any unit): the rest keep theirs. */
export function resizePair(lay, path, i, a, b) {
  const root = copy(lay.root), n = nodeAt(root, path);
  if (!n || n.t !== 's' || !n.kids[i + 1] || a <= 0 || b <= 0) return lay;
  const both = n.kids[i].w + n.kids[i + 1].w;
  n.kids[i].w = w3((both * a) / (a + b)); n.kids[i + 1].w = w3(both - n.kids[i].w);
  return { ...lay, root };
}
/** Every child of the split at path gets the same share (a double-click on its bar). */
export function evenShares(lay, path) {
  const root = copy(lay.root), n = nodeAt(root, path);
  if (!n || n.t !== 's') return lay;
  for (const k of n.kids) k.w = 1;
  return { ...lay, root };
}
/** Which side of a box a point is on, for dropping a tab: the outer quarter on each side is an edge, the rest the middle. */
export function zoneAt(r, px, py, edge = 0.25) {
  const fx = (px - r.x) / (r.w || 1), fy = (py - r.y) / (r.h || 1);
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const [side, v] = Object.entries(d).sort((p, q) => p[1] - q[1])[0];
  return v < edge ? side : 'center';
}
/**
 * Where a file opens: the group `from` when it isn't the chat's, else the group nearest it (by the centres of their
 * rectangles) that isn't. null when every group shows a chat (the caller adds one).
 */
export function nearestGroup(lay, from, rs, skip = (g) => isChatGroup(g.id)) {
  const all = groups(lay), f = findGroup(lay, from);
  if (f && !skip(f)) return f.id;
  const ok = all.filter((g) => !skip(g));
  if (!ok.length) return null;
  const c = (r) => (r ? [r.x + r.w / 2, r.y + r.h / 2] : [0, 0]), [fx, fy] = c(rs?.[from]);
  return ok.map((g) => { const [x, y] = c(rs?.[g.id]); return [g.id, Math.hypot(x - fx, y - fy)]; }).sort((a, b) => a[1] - b[1])[0][0];
}
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
export function serialise(lay, tabs = {}, closed = [], extra = {}) {
  const live = new Set(allTabs(lay)), has = (id) => typeof id === 'string' && !!findGroup(lay, id);
  // extra: the group marked to follow the agent, the maximised one, and groups pinned to a chat ({ gid: chatId }).
  const pins = extra.pins && typeof extra.pins === 'object' ? Object.fromEntries(Object.entries(extra.pins).filter(([g, c]) => has(g) && typeof c === 'string' && c)) : {};
  return JSON.stringify({ v: 1, root: lay.root, focus: lay.focus, tabs: Object.fromEntries(Object.entries(tabs).filter(([id]) => live.has(id))), ...(closed?.length ? { closed: cleanClosed(closed) } : {}),
    ...(has(extra.follow) ? { follow: extra.follow } : {}), ...(has(extra.max) ? { max: extra.max } : {}), ...(Object.keys(pins).length ? { pins } : {}),
    ...(typeof extra.preset === 'string' && extra.preset ? { preset: extra.preset.slice(0, 80) } : {}),
    ...(Object.keys(cleanHosts(lay, extra.hosts)).length ? { hosts: cleanHosts(lay, extra.hosts) } : {}) });
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
  const gid = (v) => (typeof v === 'string' && findGroup(lay, v) ? v : null);
  const pins = s.pins && typeof s.pins === 'object' ? Object.fromEntries(Object.entries(s.pins).filter(([g, c]) => gid(g) && typeof c === 'string' && c)) : {};
  return { layout: lay, tabs, closed: cleanClosed(s.closed), follow: gid(s.follow), max: gid(s.max), pins, preset: typeof s.preset === 'string' ? s.preset.slice(0, 80) : null, hosts: cleanHosts(lay, s.hosts) };
}

// ---------- a chat shown inside another group ----------
// A chat group can be hosted by a pane group: the chat shows in that group (its strip gets a tab for it) and its own
// slot gives its space to the others. hosts = { chatGroupId: paneGroupId }, each pane group hosting one chat at most.
/** Only hosts that still make sense in this layout. */
export function cleanHosts(lay, hosts) {
  const out = {}, used = new Set();
  if (!hosts || typeof hosts !== 'object') return out;
  for (const [cg, pg] of Object.entries(hosts)) {
    if (!isChatGroup(cg) || typeof pg !== 'string' || isChatGroup(pg) || used.has(pg) || !findGroup(lay, cg) || !findGroup(lay, pg)) continue;
    out[cg] = pg; used.add(pg);
  }
  return out;
}
/**
 * Sizes changed on a layout with some groups taken out (keepGroups): the same sizes, written into the full layout.
 * Each node of the smaller tree is matched to the node of the full tree holding the same shown groups.
 */
export function writeBack(full, part) {
  const shown = new Set(groups(part).map((g) => g.id));
  const key = (n) => groups(n).map((g) => g.id).filter((id) => shown.has(id)).sort().join('|');
  const want = new Map();
  const walk = (n) => { want.set(key(n), n.w); if (n.t === 's') n.kids.forEach(walk); };
  walk(part.root);
  const put = (n) => { const k = key(n), w = want.get(k); const m = { ...n, ...(w != null && k ? { w } : {}) }; if (n.t === 's') m.kids = n.kids.map(put); return m; };
  return { ...full, root: put(copy(full.root)) };
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
  // A file, picture, video, PDF or document open as a tab of its own (f: what the viewer needs; chat: the chat it came
  // from; preview: the next file opened replaces it, until it is kept).
  viewer: { name: 'File', icon: '🖼', owner: 'chat', pane: 'art', keys: [],
    save: (st) => (st.f && typeof st.f === 'object' ? { f: JSON.parse(JSON.stringify(st.f)), ...(st.chat ? { chat: String(st.chat) } : {}), ...(st.preview ? { preview: true } : {}) } : {}),
    load: (j) => (j?.f && typeof j.f === 'object' && (j.f.src || j.f.kind) ? { f: j.f, chat: j.chat ? String(j.chat) : null, preview: !!j.preview } : {}) },
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
// A second chat on screen sits in a group of its own (at most two chats show at once).
export const CHAT2_GROUP = 'chat2';
export const MAX_CHATS = 2;
export const isChatGroup = (id) => id === CHAT_GROUP || id === CHAT2_GROUP;
/** The chat groups in screen order: [main, second?]. */
export const chatGroups = (lay) => [CHAT_GROUP, CHAT2_GROUP].map((id) => findGroup(lay, id)).filter(Boolean);
/**
 * The second chat beside a group (zone left / right / top / bottom), or swapped into the second chat group when it is
 * there already. Refused past MAX_GROUPS like any new group.
 */
export function placeChat2(lay, chatId, targetId = CHAT_GROUP, zone = 'right') {
  const t = tabId('chat', chatId), g2 = findGroup(lay, CHAT2_GROUP);
  if (g2) { const root = copy(lay.root), g = findGroup(root, CHAT2_GROUP); g.tabs = [t]; g.active = t; return { ok: true, layout: { ...lay, root }, groupId: CHAT2_GROUP }; }
  return addGroup(lay, targetId, zone, [t], { id: CHAT2_GROUP, active: t });
}
/** The chat shown in the second chat group (null when there is none). */
export const chat2Id = (lay) => { const a = findGroup(lay, CHAT2_GROUP)?.active; return a && kindOf(a) === 'chat' ? a.slice(5) : null; };
/** Only these groups, the rest gone (their space to their neighbours): what shows when some are hidden. */
export function keepGroups(lay, ids) {
  const keep = new Set(ids);
  const cut = (n) => (n.t === 'g' ? (keep.has(n.id) ? n : null) : { ...n, kids: n.kids.map(cut).filter(Boolean) });
  const root = lay.root ? norm(cut(copy(lay.root))) : null;
  return { ...lay, root, focus: findGroup(root, lay.focus) ? lay.focus : (groups(root)[0]?.id ?? null) };
}
/** The default: a chat group and one side group showing `pane` (Artifact unless told). */
export function defaultLayout(pane = 'art') {
  return createLayout(split('row', [group(CHAT_GROUP, [tabId('chat', 'main')]), group('g1', paneTabs('g1'), tabId(PANE_KINDS[pane] || 'artifact', 'g1'))]), 'g1');
}
/** The side pane's groups, top to bottom: every group but the chat's, in reading order. */
export const sideGroups = (lay) => groups(lay).filter((g) => !isChatGroup(g.id));
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

// ---------- layouts: the presets, and your own ----------
// A layout is a shape: a tree like a layout's, whose chat groups are 'chat' / 'chat2' and whose pane groups are slots
// 's1', 's2'… each with the pane tab it shows (kind: art, browser, trace, term, files). It may name the slot that
// follows the agent (follow), slots pinned to the first or second chat (pins: { s1: 0 }), and hide the pane (focus).
// fitLayout puts a project's groups into a shape without closing anything: its pane groups keep their ids (so their
// boxes, frames and terminals stay), file tabs go to the nearest slot, and the chats keep their tabs.
//
// The presets are honest: a layout only arranges tabs the project has. A slot may list the pane tabs it prefers
// (prefer), and shows the first one that has something in it (pickKind); a side with nothing yet gets a short hint with
// what fills it (hintFor), never made-up content. A preset that needs what the project hasn't got (a second chat,
// changes to review) is greyed with the reason (layoutBlock). The first nine have Ctrl+Alt+1…9 (LAYOUT_KEYS, ids in
// the shortcuts table).
const slot = (id, kind, w = 1, prefer = null) => ({ t: 'g', id, kind, w: w3(w), ...(prefer ? { prefer } : {}) });
export const LAYOUTS = {
  // Single: every tab in one strip and one group; the chat and its pane share the space, the tab you pick in front.
  single: { name: 'Single', tip: 'Every tab in one row: the chat, its steps, pages, terminals and files; the one you pick fills the space', root: split('row', [slot(CHAT_GROUP, null, 1), slot('s1', 'art', 1)]), single: true },
  focus: { name: 'Focus', tip: 'The chat alone: the sidebar and the other groups hide. Esc or Focus again brings them back', root: split('row', [slot(CHAT_GROUP, null, 1.4), slot('s1', 'art')]), focus: true },
  preview: { name: 'Chat + preview', tip: 'The chat on the left; the agent\'s page, steps, plans and files on the right, following the agent', root: split('row', [slot(CHAT_GROUP, null, 0.45), slot('s1', 'browser', 0.55, ['browser', 'trace', 'art'])]), follow: 's1' },
  previewFirst: { name: 'Preview first', tip: 'The agent\'s page big on the left, the chat on the right: for games and visual work', root: split('row', [slot('s1', 'browser', 0.62), slot(CHAT_GROUP, null, 0.38)]), follow: 's1' },
  watch: { name: 'Watch the build', tip: 'The chat on the left; its steps over the agent\'s page on the right', root: split('row', [slot(CHAT_GROUP, null, 0.45), split('col', [slot('s1', 'trace', 0.45), slot('s2', 'browser', 0.55)], 0.55)]), follow: 's2' },
  three: { name: 'Three columns', tip: 'The chat, its steps and the page side by side: for wide screens', root: split('row', [slot(CHAT_GROUP, null, 0.38), slot('s1', 'trace', 0.27), slot('s2', 'browser', 0.35)]), follow: 's2' },
  stacked: { name: 'Stacked', tip: 'The chat on top, the page below: for tall or portrait screens', root: split('col', [slot(CHAT_GROUP, null, 0.5), slot('s1', 'browser', 0.5)]), follow: 's1' },
  pageTerm: { name: 'Chat + page + terminal', tip: 'The chat on the left; the page over the project\'s terminal and server output on the right', root: split('row', [slot(CHAT_GROUP, null, 0.45), split('col', [slot('s1', 'browser', 0.6), slot('s2', 'term', 0.4)], 0.55)]), follow: 's1' },
  twoChats: { name: 'Two chats', tip: 'Two chats side by side, each over its own steps, pages and files', root: split('row', [split('col', [slot(CHAT_GROUP, null, 1.6), slot('s1', 'trace')]), split('col', [slot(CHAT2_GROUP, null, 1.6), slot('s2', 'trace')])]), pins: { s1: 0, s2: 1 }, chats: 2 },
  twoPages: { name: 'Two chats + pages', tip: 'Two chats side by side, each over its own page', root: split('row', [split('col', [slot(CHAT_GROUP, null, 0.55), slot('s1', 'browser', 0.45)]), split('col', [slot(CHAT2_GROUP, null, 0.55), slot('s2', 'browser', 0.45)])]), follow: 's1', pins: { s1: 0, s2: 1 }, chats: 2 },
  review: { name: 'Review changes', tip: 'The chat on the left; the Changes of its replies on the right', root: split('row', [slot(CHAT_GROUP, null, 0.42), slot('s1', 'art', 0.58)]), needs: 'changes' },
};
/** Layout ▾ in groups, in this order; the first nine take Ctrl+Alt+1…9. */
export const LAYOUT_GROUPS = [['Basic', ['single', 'focus']], ['Build', ['preview', 'previewFirst', 'watch', 'three', 'stacked']], ['Debug', ['pageTerm']], ['Compare', ['twoChats', 'twoPages']], ['Review', ['review']]];
export const LAYOUT_ORDER = LAYOUT_GROUPS.flatMap((g) => g[1]);
/** layout key → its id in the shortcuts table ('layout.1'…'layout.9'). */
export const LAYOUT_KEYS = Object.fromEntries(LAYOUT_ORDER.slice(0, 9).map((k, i) => [k, `layout.${i + 1}`]));
// The keys a project saved before the presets were rethought: the nearest one now.
const OLD_KEYS = { build: 'pageTerm', debug: 'three', compare: 'twoPages' };
/** A saved preset key as it is now (an old one renamed); own layouts ('my:…') pass through. null for nothing. */
export const layoutKey = (k) => (typeof k === 'string' && k ? OLD_KEYS[k] || k : null);
/**
 * Why a preset can't be used right now ('' when it can). facts: { chats: open chats in the project, changes: files the
 * chat's replies changed (and not undone) }.
 */
export function layoutBlock(key, { chats = 1, changes = 0 } = {}) {
  const l = LAYOUTS[key];
  if (!l) return '';
  if (l.chats === 2 && chats < 2) return 'Open a second chat first';
  if (l.needs === 'changes' && !changes) return 'No changes in this chat yet';
  return '';
}
/** Which pane tab a slot shows: the first it prefers that has something (has: { browser: true, … }), else its own. */
export const pickKind = (s, has = {}) => (s?.prefer || []).find((k) => has[k]) || s?.kind || 'art';
/**
 * The hint a side with nothing yet shows: { note, acts } or null when it has what it is there for. acts are what fill
 * it: 'page' (open a page), 'server' (start the project's server), 'changes' (open the Changes tabs). kind: the pane tab
 * it shows; facts: { pages, steps, changes, changesOpen, servers, pinned (a chat of its own), layout (preset key) }.
 */
export function hintFor(kind, { pages = 0, steps = false, changes = 0, changesOpen = 0, servers = 0, pinned = false, layout = null } = {}) {
  if (kind === 'browser' && !pages) {
    const note = pinned ? 'This chat hasn\'t opened a page yet.' : layout === 'preview' && !steps ? 'The agent\'s page and steps appear here when it starts.' : 'The agent\'s page appears here when it starts.';
    return { note, acts: servers ? ['server', 'page'] : ['page'] };
  }
  if (kind === 'trace' && !steps) return { note: pinned ? 'This chat hasn\'t started a reply yet: its steps appear here.' : 'Steps appear here when the agent starts a reply.', acts: [] };
  if (kind === 'art' && layout === 'review' && changes && !changesOpen) return { note: `${changes} file${changes === 1 ? '' : 's'} changed in this chat. Their Changes aren't open yet.`, acts: ['changes'] };
  return null;
}
/**
 * A layout's little diagram: each group's box as fractions of the whole ({ id, kind, follow, x, y, w, h }), in reading
 * order. Works for presets and your own; kind is 'chat' for a chat group.
 */
export function layoutBoxes(shape) {
  if (!shape?.root) return [];
  const r = rects(shape.root, { x: 0, y: 0, w: 1000, h: 1000 }, 0).groups, f = (v) => Math.round(v) / 1000;
  return groups(shape.root).map((g) => ({ id: g.id, kind: isChatGroup(g.id) ? 'chat' : g.kind, follow: shape.follow === g.id, x: f(r[g.id].x), y: f(r[g.id].y), w: f(r[g.id].w), h: f(r[g.id].h) }));
}
const SLOT_KINDS = new Set(['art', 'browser', 'trace', 'term', 'files']);
/** A layout's shape, from what is on screen (Save layout as…). chats: the chat ids on screen, in order. */
export function shapeOf(lay, { follow = null, pins = {}, chats = [], focus = false } = {}) {
  const ids = {}; let n = 0;
  for (const g of groups(lay)) if (!isChatGroup(g.id)) ids[g.id] = `s${++n}`;
  const walk = (x) => (x.t === 'g' ? slot(isChatGroup(x.id) ? x.id : ids[x.id], isChatGroup(x.id) ? null : groupPane(x), x.w) : split(x.dir, x.kids.map(walk), x.w));
  const out = { root: walk(copy(lay.root)) };
  if (ids[follow]) out.follow = ids[follow];
  const pn = Object.fromEntries(Object.entries(pins || {}).filter(([g, c]) => ids[g] && chats.includes(c)).map(([g, c]) => [ids[g], chats.indexOf(c)]));
  if (Object.keys(pn).length) out.pins = pn;
  if (findGroup(lay, CHAT2_GROUP)) out.chats = 2;
  if (focus) out.focus = true;
  return out;
}
/** Checks a stored shape (your saved layouts); null when it can't be used. */
export function cleanShape(x) {
  if (!x || typeof x !== 'object' || !x.root) return null;
  const seen = new Set();
  const check = (n, d) => {
    if (!n || typeof n !== 'object' || d > 8) return null;
    if (n.t === 'g') {
      const id = String(n.id || '');
      if (seen.has(id) || !(isChatGroup(id) || (/^s\d+$/.test(id) && SLOT_KINDS.has(n.kind)))) return null;
      seen.add(id); return slot(id, isChatGroup(id) ? null : n.kind, n.w);
    }
    if (n.t === 's' && Array.isArray(n.kids)) { const kids = n.kids.map((k) => check(k, d + 1)).filter(Boolean); return kids.length ? split(n.dir, kids, n.w) : null; }
    return null;
  };
  const root = check(x.root, 0);
  const slots = groups(root).filter((g) => !isChatGroup(g.id));
  if (!root || !seen.has(CHAT_GROUP) || !slots.length || groups(root).length > MAX_GROUPS) return null;
  const has = (k) => slots.some((g) => g.id === k);
  return { root, ...(has(x.follow) ? { follow: x.follow } : {}), ...(x.pins && typeof x.pins === 'object' ? { pins: Object.fromEntries(Object.entries(x.pins).filter(([k, v]) => has(k) && (v === 0 || v === 1))) } : {}), ...(seen.has(CHAT2_GROUP) ? { chats: 2 } : {}), ...(x.focus ? { focus: true } : {}) };
}
const isPaneTab = (t, gid) => kindOf(t) in KIND_PANE && t === tabId(kindOf(t), gid);
/** A shape with the second chat beside the first, when it has none and the cap allows (two chats stay on screen). */
export function withChat2(shape) {
  if (groups(shape.root).some((g) => g.id === CHAT2_GROUP) || groups(shape.root).length >= MAX_GROUPS) return shape;
  const put = (n) => (n.t === 'g' ? (n.id === CHAT_GROUP ? split('row', [{ ...n, w: 1 }, slot(CHAT2_GROUP, null, 1)], n.w) : n) : { ...n, kids: n.kids.map(put) });
  return { ...shape, root: put(copy(shape.root)), chats: 2 };
}
/**
 * The project's layout in a shape. chat2: the chat for the second chat group (null drops it from the shape).
 * Gives { layout, follow, pins: { gid: chatIndex }, kinds: { gid: pane }, slots: { gid: { kind, prefer? } }, added: [gid],
 * removed: [gid] }.
 */
export function fitLayout(lay, shape, { chat2 = null, order = null, shows = null } = {}) {
  // order: which pane groups are kept first (the page's own first area holds the project's terminal, so it goes first).
  // shows: what each group shows now ({ gid: pane }): a slot takes the group already showing its tab, so a page or a
  // terminal keeps its own box (nothing reloads, nothing loses its screen); the first group in order is always kept.
  const side = sideGroups(lay), old = order ? [...order.map((id) => side.find((g) => g.id === id)).filter(Boolean), ...side.filter((g) => !order.includes(g.id))] : side, slots = groups(shape.root).filter((g) => !isChatGroup(g.id));
  let next = lay.next;
  const ids = {}, used = new Set(), take = (s, g) => { ids[s.id] = g.id; used.add(g.id); };
  if (shows) for (const s of slots) { const g = old.find((o) => !used.has(o.id) && shows[o.id] === s.kind); if (g) take(s, g); }
  if (old[0] && !used.has(old[0].id) && slots.length) {
    const s = slots.find((x) => !ids[x.id]) || [...slots].reverse().find((x) => ids[x.id] !== old[0].id);
    used.delete(ids[s.id]); take(s, old[0]);
  }
  for (const s of slots) if (!ids[s.id]) { const g = old.find((o) => !used.has(o.id)); if (g) take(s, g); else ids[s.id] = `g${next++}`; }
  // Tabs of the pane groups that aren't their five pane tabs (files): to the slot that keeps their group, else the slot
  // at the same place, else the last.
  const extra = slots.map(() => []);
  old.forEach((g, i) => { const at = slots.findIndex((s) => ids[s.id] === g.id); for (const t of g.tabs) if (!isPaneTab(t, g.id)) extra[at >= 0 ? at : Math.min(i, slots.length - 1)].push(t); });
  const curChat = findGroup(lay, CHAT_GROUP), cur2 = findGroup(lay, CHAT2_GROUP);
  const kinds = {}, slotOf = {};
  const build = (n) => {
    if (n.t === 'g') {
      if (n.id === CHAT_GROUP) return group(CHAT_GROUP, curChat?.tabs?.length ? curChat.tabs : [tabId('chat', 'main')], curChat?.active, n.w);
      if (n.id === CHAT2_GROUP) { const id = chat2 ?? (cur2 ? chat2Id(lay) : null); return id ? group(CHAT2_GROUP, [tabId('chat', id)], null, n.w) : null; }
      const gid = ids[n.id], i = slots.findIndex((x) => x.id === n.id); kinds[gid] = n.kind; slotOf[gid] = { kind: n.kind, ...(n.prefer ? { prefer: [...n.prefer] } : {}) };
      return group(gid, [...paneTabs(gid), ...extra[i]], tabId(PANE_KINDS[n.kind] || 'artifact', gid), n.w);
    }
    const kids = n.kids.map(build).filter(Boolean);
    return kids.length ? split(n.dir, kids, n.w) : null;
  };
  const root = norm(build(copy(shape.root)));
  const layout = { root, focus: ids[shape.follow] || ids.s1 || CHAT_GROUP, next };
  if (!findGroup(root, layout.focus)) layout.focus = groups(root)[0]?.id ?? null;
  const pins = Object.fromEntries(Object.entries(shape.pins || {}).filter(([k]) => ids[k]).map(([k, v]) => [ids[k], v]));
  const now = new Set(Object.values(ids));
  return { layout, follow: ids[shape.follow] || null, pins, kinds, slots: slotOf, added: Object.values(ids).filter((g) => !old.some((o) => o.id === g)), removed: old.map((g) => g.id).filter((g) => !now.has(g)) };
}

// ---------- where things open ----------
// One rule set for everything that opens in the workspace. Nothing ever opens in a chat group, so nothing replaces the
// chat you are typing in. kind: 'server' (a started project server): the group marked to follow the agent, else the
// group already showing the Browser; 'steps' (🧭 a reply's steps): the group showing Steps for that chat; 'file' /
// 'page': the nearest group to where you clicked that isn't a chat; 'side' / 'changes' (a side question, the Changes
// of a reply): beside its chat, the nearest group to that chat's group. Each falls back to the nearest group to its
// chat (or to from). ctx: { lay, rects, from, follow, shows: { gid: pane }, owner: { gid: chatId }, chat, chatGroup }.
// null when there is no pane group at all.
export function openTarget(kind, { lay, rects = {}, from = null, follow = null, shows = {}, owner = {}, chat = null, chatGroup = CHAT_GROUP } = {}) {
  const side = sideGroups(lay).map((g) => g.id), mine = (g) => !chat || !owner[g] || owner[g] === chat;
  if (!side.length) return null;
  const near = (start) => nearestGroup(lay, start && findGroup(lay, start) ? start : chatGroup, rects);
  if (kind === 'server') {
    if (follow && side.includes(follow)) return follow;
    return side.find((g) => shows[g] === 'browser' && mine(g)) || side.find((g) => shows[g] === 'browser') || near(from);
  }
  if (kind === 'steps') return side.find((g) => shows[g] === 'trace' && mine(g)) || nearestGroup(lay, chatGroup, rects, (g) => isChatGroup(g.id) || !mine(g.id)) || near(chatGroup);
  if (kind === 'side' || kind === 'changes') return near(chatGroup);
  return near(from);
}

// ---------- pop-out windows (desktop app) ----------
// A pane group, one tab or a chat can go to a window of its own. What goes there is a group record
// { gid, tabs, active, near, zone }: its tabs (a group always has the five pane tabs, plus any files), the tab it
// shows, and where it sat (beside group near, on side zone) so docking back puts it there again. Records are plain
// JSON, kept per project, so a main window that reloads can still dock them back.
const isFile = (t) => kindOf(t) === 'viewer';
/** Where a group sits, to come back to: the neighbour before it (it comes back after), else the one after. */
function spotOf(lay, gid) {
  const g = findGroup(lay, gid), p = g && parentOf(lay, g);
  if (!p) return { near: CHAT_GROUP, zone: 'right' };
  const i = p.kids.indexOf(g), row = p.dir === 'row';
  if (i > 0) return { near: groups(p.kids[i - 1]).at(-1).id, zone: row ? 'right' : 'bottom' };
  return { near: groups(p.kids[i + 1])[0].id, zone: row ? 'left' : 'top' };
}
/** A whole pane group out of the layout (the last pane group stays). */
export function popGroup(lay, gid) {
  const g = findGroup(lay, gid);
  if (!g || isChatGroup(gid)) return { ok: false, reason: 'target', layout: lay };
  if (sideGroups(lay).length < 2) return { ok: false, reason: 'last', layout: lay };
  const spot = spotOf(lay, gid);
  return { ok: true, layout: removeGroup(lay, gid), rec: { gid, tabs: [...g.tabs], active: g.active, ...spot } };
}
/**
 * One tab out, into a new group of its own (gid: its id). A file tab leaves its group; a pane tab (Browser, Terminal…)
 * stays in its group too, as every group has the five, and the window shows its own.
 */
export function popTab(lay, tab, gid) {
  const from = groupOf(lay, tab);
  if (!from || !gid || findGroup(lay, gid)) return { ok: false, reason: 'target', layout: lay };
  const kind = kindOf(tab), file = isFile(tab);
  const tabs = [...paneTabs(gid), ...(file ? [tab] : [])], active = file ? tab : tabId(kind, gid);
  return { ok: true, layout: file ? removeTab(lay, tab) : lay, rec: { gid, tabs, active, near: from.id, zone: 'right' } };
}
/**
 * A popped group back in: beside where it was (or the first pane group, or the chat) with its own id when that is free;
 * at the cap its files join the nearest group instead (pane tabs are in every group already). Gives { layout, gid,
 * merged }: gid is the group that holds them now.
 */
export function dockBack(lay, rec) {
  const id = findGroup(lay, rec.gid) ? `g${lay.next}` : rec.gid;
  const files = (rec.tabs || []).filter(isFile).filter((t) => !allTabs(lay).includes(t));
  const near = findGroup(lay, rec.near) ? rec.near : sideGroups(lay)[0]?.id || CHAT_GROUP;
  const zone = ZONES.has(rec.zone) && rec.zone !== 'center' ? rec.zone : 'right';
  if (groups(lay).length < MAX_GROUPS) {
    const pane = KIND_PANE[kindOf(rec.active)], active = isFile(rec.active) && files.includes(rec.active) ? rec.active : tabId(PANE_KINDS[pane] || 'artifact', id);
    const r = addGroup(lay, near, zone, [...paneTabs(id), ...files], { id, active });
    if (r.ok) return { layout: { ...r.layout, next: Math.max(r.layout.next, lay.next + (id === rec.gid ? 0 : 1)) }, gid: id, merged: false };
  }
  const into = isChatGroup(near) ? nearestGroup(lay, near, {}) : near;
  if (!into) return { layout: lay, gid: null, merged: true };
  let l = lay;
  for (const t of files) l = placeTab(l, t, into, 'center').layout;
  return { layout: { ...l, focus: lay.focus }, gid: into, merged: true };
}
/** Which remembered window box a record uses: per kind of thing (a chat, or the pane tab its group shows). */
export const popKey = (rec) => (rec?.chat && !rec.gid ? 'chat' : `group:${isFile(rec?.active) ? 'file' : KIND_PANE[kindOf(rec?.active)] || 'art'}`);
/** The boxes remembered for a project's windows: the newest per key, a few keys at most. */
export function rememberBox(boxes, key, box) {
  const ok = box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width >= 200 && box.height >= 150;
  const out = Object.fromEntries(Object.entries(boxes && typeof boxes === 'object' ? boxes : {}).filter(([k]) => k !== key).slice(-11));
  if (ok) out[key] = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  return out;
}
/** Only well-formed popped records (what a project keeps across a main window reload). */
export function cleanPopped(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x.id === 'string' && (typeof x.chat === 'string' || (x.rec && typeof x.rec.gid === 'string' && Array.isArray(x.rec.tabs)))).slice(-8).map((x) => JSON.parse(JSON.stringify(x)));
}
