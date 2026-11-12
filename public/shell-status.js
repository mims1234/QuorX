// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The IDE shell's bottom edge, as data: what the status bar shows (each item only when it means something, each with
// the one place a click takes you), the bottom panel's tabs and its size per project, and the 🔔 notification list.
// No DOM here: app.js draws these and the tests read them.

/** The bottom panel's tabs: Terminal (your terminals and every command's and server's output), Checks, Debug. */
export const PANEL_TABS = [
  { id: 'terminal', label: 'Terminal', tip: 'Your terminals and the live output of every command and server in this project' },
  { id: 'checks', label: 'Checks', tip: 'What the checks, the reviewer and /review found in this chat\'s newest reply' },
  { id: 'debug', label: 'Debug', tip: 'What went wrong in this chat\'s newest reply: errors, warnings and the debugger, step by step' },
];
export const PANEL_MIN = 120;
export const PANEL_DEFAULT = 320;

/** A panel height that fits: at least PANEL_MIN, and leaves the groups above at least `keep` pixels. */
export function clampPanelH(h, total, keep = 160) {
  const max = Math.max(PANEL_MIN, (Number(total) || 0) - keep);
  const n = Number(h);
  return Math.round(Math.min(max, Math.max(PANEL_MIN, Number.isFinite(n) && n > 0 ? n : PANEL_DEFAULT)));
}

/** One project's panel: open or shut, its height, maximised or not, the tab in front. */
export function panelPrefs(all, pid) {
  const p = (all && typeof all === 'object' && all[pid]) || {};
  return {
    open: p.open === true,
    h: Number(p.h) > 0 ? Math.round(Number(p.h)) : PANEL_DEFAULT,
    max: p.max === true,
    tab: PANEL_TABS.some((t) => t.id === p.tab) ? p.tab : 'terminal',
  };
}
/** All projects' panels with one project's changed (the others untouched). */
export function setPanelPrefs(all, pid, patch) {
  const base = all && typeof all === 'object' ? all : {};
  return { ...base, [pid]: { ...panelPrefs(base, pid), ...patch } };
}

/**
 * What the status bar shows, left to right. s: plain facts about the window now.
 *   project { id, name } · branch · running (chats replying + processes) · need [{ title, kind }] · servers (up) ·
 *   check { ok, problems } | null · ctx { text, tone, title } | null · spend (this project's chats, in dollars) ·
 *   unread (🔔) · sidebar / panel (shown or not).
 * Each item: { id, side: 'left' | 'right', text, tone?, title, act } — act names where a click goes.
 * ⬆ Update, ⟳ Restart needed and 💲 the key's balance are the app's own buttons, moved in beside 🔔 (they keep their
 * own drawing and clicks).
 */
export function statusItems(s = {}) {
  const out = [];
  const add = (it) => out.push(it);
  add({ id: 'sidebar', side: 'left', kind: 'toggle', on: s.sidebar !== false, text: '', title: 'Sidebar', act: 'sidebar' });
  add({ id: 'panel', side: 'left', kind: 'toggle', on: !!s.panel, text: '', title: 'Bottom panel: terminal, checks, debug', act: 'panel' });
  if (s.project?.name) add({ id: 'project', side: 'left', text: s.project.name, branch: s.branch || '', title: `${s.project.name}${s.branch ? ` · on the branch ${s.branch}` : ''}. Click for its source control: branches and pull requests.`, act: 'source' });
  if (s.check) {
    const n = Number(s.check.problems) || 0;
    add(s.check.ok && !n
      ? { id: 'check', side: 'left', tone: 'green', text: 'Checked', title: 'The newest reply\'s checks found no problems. Click for the Checks panel.', act: 'checks' }
      : { id: 'check', side: 'left', tone: 'amber', text: `${n} problem${n === 1 ? '' : 's'}`, title: 'The newest reply\'s checks or reviewer found problems. Click for the Checks panel.', act: 'checks' });
  }
  if (s.servers > 0) add({ id: 'servers', side: 'left', text: `${s.servers} up`, title: `${s.servers} of this project's servers ${s.servers === 1 ? 'is' : 'are'} up. Click for Servers & pages.`, act: 'servers' });
  if (s.running > 0) add({ id: 'running', side: 'left', tone: 'violet', text: `${s.running} running`, title: 'Running now, in every project. Click for the Running view.', act: 'running' });
  const need = Array.isArray(s.need) ? s.need : [];
  if (need.length) add({ id: 'need', side: 'left', tone: 'amber', text: `${need.length} need${need.length === 1 ? 's' : ''} you`, title: `${need.map((x) => `${x.title}: ${x.kind === 'answer' ? 'a question' : x.kind === 'budget' ? 'its budget' : 'an approval'}`).join('\n')}\nClick to go to ${need.length > 1 ? 'each in turn' : 'it'}.`, act: 'need' });
  if (s.ctx) add({ id: 'ctx', side: 'right', tone: s.ctx.tone || '', text: s.ctx.text, title: s.ctx.title || 'Context in the chat on screen. Click to open Steps.', act: 'ctx' });
  if (Number(s.spend) > 0) add({ id: 'spend', side: 'right', kind: 'money', text: `$${Number(s.spend).toFixed(Number(s.spend) < 1 ? 4 : 2)}`, title: `What ${s.project?.name || 'this project'}'s chats have cost. Click for Spending.`, act: 'spending' });
  add({ id: 'bell', side: 'right', text: '', count: Math.max(0, Number(s.unread) || 0), title: s.unread ? `${s.unread} new notification${s.unread === 1 ? '' : 's'}` : 'Notifications', act: 'bell' });
  return out;
}

// ---- 🔔 notifications ----
// What happened while you looked elsewhere: replies that ended or stopped, schedules that ran, updates, warnings.
// Needs-you is not kept here: it is live (the Running view and the status bar's count), shown on top of the bell's
// list from the chats themselves. A notification with the same key replaces the older one (one per chat and kind).
export const NOTE_KINDS = { done: 'Done', error: 'Failed', warn: 'Warnings', info: 'News' };
export const NOTES_MAX = 60;

/** A list of notifications, newest first; `saved` is what toJSON gave last time. */
export function createNotes(saved = [], max = NOTES_MAX) {
  let list = (Array.isArray(saved) ? saved : []).filter((n) => n && n.title && NOTE_KINDS[n.kind]).slice(0, max);
  let seq = list.reduce((a, n) => Math.max(a, Number(String(n.id).replace(/\D/g, '')) || 0), 0);
  return {
    get list() { return list; },
    /** n: { kind, title, text?, chatId?, key?, at?, read? } → the stored notification (read: you saw it happen). */
    add(n) {
      if (!n?.title || !NOTE_KINDS[n.kind]) return null;
      const key = n.key || null;
      const it = { id: `n${++seq}`, kind: n.kind, title: String(n.title), text: String(n.text || ''), chatId: n.chatId || null, key, at: Number(n.at) || Date.now(), read: !!n.read };
      list = [it, ...list.filter((x) => !key || x.key !== key)].slice(0, max);
      return it;
    },
    unread() { return list.filter((n) => !n.read).length; },
    readAll() { list = list.map((n) => (n.read ? n : { ...n, read: true })); },
    remove(id) { list = list.filter((n) => n.id !== id); },
    /** Clears one kind, or everything. */
    clear(kind) { list = kind ? list.filter((n) => n.kind !== kind) : []; },
    /** Drops what is about a chat that no longer exists. */
    keepChats(has) { list = list.filter((n) => !n.chatId || has(n.chatId)); },
    toJSON() { return list; },
  };
}
/** The list in sections, in the bell's order: Failed, Warnings, Done, News (empty sections left out). */
export function noteGroups(list) {
  const order = ['error', 'warn', 'done', 'info'];
  return order.map((kind) => ({ kind, label: NOTE_KINDS[kind], items: list.filter((n) => n.kind === kind) })).filter((g) => g.items.length);
}
/** "now", "4m", "2h", "3d": how long ago, short. */
export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
