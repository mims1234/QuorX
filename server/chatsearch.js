// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ---------- search inside chats: your messages and the agent's replies, across every project ----------
// Ctrl+K's Messages group and the Search chats window (Ctrl+Shift+F) ask here. A chat file holds every step of every
// reply (tool output, pages read, files written), so reading the files on each search would read hundreds of MB.
// Instead each chat's message text alone (what you wrote and what the agent answered, never tool output) is kept in
// memory once read, with the chat file's size:mtime stamp from the chat index, and read again only when that changes.
// A search walks the chats in the sidebar's order (pinned projects first, then newest) and stops as soon as it has the
// page it was asked for. Chats in the trash are never searched (they live in data/trash, outside the chat index), and
// archived projects only when asked.
// Measured on 2,500 generated chats (3 GB of files): with every chat's text held (8M characters, ~16 MB) a search
// that matches nothing takes ~10 ms; reading the files for it took ~10 s. So the texts are saved to
// data/index/search.json (a restart starts warm), the chats not read yet are read in the background after the first
// search, and a search that would read files for longer than its time budget answers with what it found so far
// (partial: true; the page asks again for the rest).
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';
import { listChats, listProjects, chatFileKey, agentsOf, CHATS_DIR } from './store.js';
import { renameSoon } from './fsretry.js';

const TEXT = new Map(); // chat id → { key, msgs: [[index, 'u' | 'a', at, text]], size }
const LOADING = new Map(); // chat id → a read in progress
const CAP = 48e6; // characters kept in memory before the least recently searched chats are let go (~100 MB)
const MAX_MSG = 200e3; // characters of one message that are searched
const SAVED = path.join(HOME, 'data', 'index', 'search.json');
const SAVED_V = 1;
let held = 0, loaded = false, dirty = false, saveTimer = null, warming = null;

/** The words of a message as they are searched and shown: whitespace runs as one space, code fences and bold marks gone. */
export const cleanText = (s) => String(s || '').replace(/```[\w+-]*|\*\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG);

/** What a chat says, message by message: [index in the chat's messages, 'u' (you) or 'a' (the agent), time, text]. */
export function chatTexts(doc) {
  const msgs = agentsOf(doc || {})[0]?.messages || [], out = [];
  msgs.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return;
    const text = cleanText(m.content);
    if (text) out.push([i, m.role === 'user' ? 'u' : 'a', Number(m.role === 'user' ? m.at : m.doneAt || m.at) || 0, text]);
  });
  return out;
}

const sizeOf = (msgs) => msgs.reduce((n, m) => n + m[3].length, 0) + 64;
function keep(id, entry) {
  const old = TEXT.get(id);
  if (old) { held -= old.size; TEXT.delete(id); }
  TEXT.set(id, entry); held += entry.size;
  for (const [k, e] of TEXT) { if (held <= CAP) break; if (k === id) continue; TEXT.delete(k); held -= e.size; }
}
// ---- the saved copy: read once on the first search, written a while after chats were read, and when QuorX exits ----
function loadSaved() {
  loaded = true;
  try {
    const s = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
    if (s?.v !== SAVED_V || !s.entries) return;
    for (const [id, [key, msgs]] of Object.entries(s.entries)) if (typeof key === 'string' && Array.isArray(msgs)) keep(id, { key, msgs, size: sizeOf(msgs) });
  } catch { /* none yet, or unreadable: chats are read again as searches need them */ }
}
function save({ now = false } = {}) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty) return;
  dirty = false;
  const entries = {};
  for (const [id, e] of TEXT) if (chatFileKey(id)) entries[id] = [e.key, e.msgs]; // a chat deleted since is left out
  const text = JSON.stringify({ v: SAVED_V, at: Date.now(), entries });
  try {
    fs.mkdirSync(path.dirname(SAVED), { recursive: true });
    if (now) { fs.writeFileSync(SAVED + '.tmp', text); renameSoon(SAVED + '.tmp', SAVED); return; }
  } catch { return; }
  fs.promises.writeFile(SAVED + '.tmp2', text).then(() => fs.promises.rename(SAVED + '.tmp2', SAVED)).catch(() => { dirty = true; });
}
const changed = () => { dirty = true; if (!saveTimer) saveTimer = setTimeout(save, 20e3); saveTimer.unref?.(); };
process.on('exit', () => { if (dirty) save({ now: true }); });
// After the first search, the chats it did not need are read too, a few at a time with pauses between, so the next
// search for a rare word doesn't wait for files.
function warm() {
  warming ??= (async () => {
    try {
      const ids = listChats().filter((c) => c.messages > 0).map((c) => c.id);
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map((id) => textsOf(id)));
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally { warming = null; }
  })();
  return warming;
}
// One chat's texts, read from its file when there is no copy yet or the file changed since. null: unreadable now
// (being written; the next search tries again) or not a chat the index knows.
function textsOf(id) {
  const key = chatFileKey(id);
  if (!key) return null;
  const hit = TEXT.get(id);
  if (hit?.key === key) { TEXT.delete(id); TEXT.set(id, hit); return hit.msgs; } // most recently used last
  const busy = LOADING.get(id);
  if (busy?.key === key) return busy.p;
  const p = fs.promises.readFile(path.join(CHATS_DIR, `${id}.json`), 'utf8').then((raw) => {
    const msgs = chatTexts(JSON.parse(raw));
    keep(id, { key, msgs, size: sizeOf(msgs) }); changed();
    return msgs;
  }, () => null).catch(() => null).finally(() => { if (LOADING.get(id)?.p === p) LOADING.delete(id); });
  LOADING.set(id, { key, p });
  return p;
}

// Each word as a case-insensitive pattern, matched as written: dots, brackets and slashes are only themselves.
const pattern = (w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'giu');
const wordsOf = (q) => [...new Set(String(q || '').trim().split(/\s+/).filter(Boolean))].slice(0, 12);

/**
 * A short piece of `text` around its first match, with where each word is in it: { snippet, marks: [[start, end]] }.
 * `width` characters at most (plus … at a cut end), cut at spaces where it can, never inside a character.
 */
export function snippetOf(text, res, width = 160) {
  let at = -1, len = 0;
  for (const r of res) { r.lastIndex = 0; const m = r.exec(text); if (m && (at < 0 || m.index < at)) { at = m.index; len = m[0].length; } }
  if (at < 0) at = 0;
  let s = Math.max(0, at - Math.round(width / 3));
  if (s > 0) { const sp = text.indexOf(' ', s); if (sp >= 0 && sp < at) s = sp + 1; }
  let e = Math.min(text.length, s + width);
  if (e < text.length) { const sp = text.lastIndexOf(' ', e); if (sp > at + len) e = sp; }
  const low = (i) => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  if (s > 0 && low(s)) s++;
  if (e < text.length && low(e)) e--;
  const lead = s > 0 ? '…' : '', piece = text.slice(s, e);
  const marks = [];
  for (const r of res) { r.lastIndex = 0; let m; while ((m = r.exec(piece))) { if (!m[0].length) { r.lastIndex++; continue; } marks.push([m.index + lead.length, m.index + lead.length + m[0].length]); } }
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const m of marks) { const last = merged[merged.length - 1]; if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]); }
  return { snippet: lead + piece + (e < text.length ? '…' : ''), marks: merged };
}

/**
 * Search saved chats.
 * q: 2+ characters; every word must be in one message (any case, any order). project: one project's chats (an archived
 * one too), else every project but the archived ones (archived: true adds them). role: 'user' or 'agent'. from / to:
 * message times in ms (to is inclusive). A page is `limit` chats from `offset`, each with up to `perChat` matching
 * messages and how many it has in all. titles (on the first page): chats whose title has every word.
 * → { q, offset, limit, more, chats: [{ id, title, projectId, project, lastAt, count, hits: [{ i, role, at, snippet,
 *   marks }] }], titles: [{ id, title, projectId, project, lastAt }] }
 */
export async function searchChats({ q = '', project = '', role = '', from = 0, to = 0, archived = false, offset = 0, limit = 20, perChat = 3, budget = 1500 } = {}) {
  const t0 = performance.now();
  if (!loaded) loadSaved();
  q = String(q || '').trim();
  offset = Math.max(0, Math.min(1e4, Math.floor(Number(offset)) || 0));
  limit = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 20));
  perChat = Math.max(1, Math.min(20, Math.floor(Number(perChat)) || 3));
  from = Number(from) || 0; to = Number(to) || 0;
  const out = { q, offset, limit, more: false, chats: [], titles: [] };
  if (q.length < 2) return out;
  const words = wordsOf(q), res = words.map(pattern), lower = words.map((w) => w.toLowerCase());
  const projects = listProjects(), byId = new Map(projects.map((p) => [p.id, p]));
  const pinRank = (pid) => byId.get(pid)?.pinned || Infinity;
  const list = listChats().filter((c) => {
    const pid = c.projectId || 'scratch';
    return c.messages > 0 && (project ? pid === project : archived || !byId.get(pid)?.archived);
  }).sort((a, b) => pinRank(a.projectId || 'scratch') - pinRank(b.projectId || 'scratch')); // stable: newest first within
  const card = (c) => ({ id: c.id, title: c.title, projectId: c.projectId || 'scratch', project: byId.get(c.projectId || 'scratch')?.name || c.projectId || 'Scratch', lastAt: c.lastAt || 0 });
  const inTime = (t) => (!from || t >= from) && (!to || t <= to);
  if (!offset) out.titles = list.filter((c) => inTime(c.lastAt || 0) && lower.every((w) => c.title.toLowerCase().includes(w))).slice(0, 20).map(card);
  const want = role === 'user' ? 'u' : role === 'agent' ? 'a' : '';
  const AHEAD = 16; // files read at once ahead of the one being searched
  let found = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (from && (c.lastAt || 0) < from) continue; // nothing in it is that recent
    for (let j = k + 1; j < Math.min(list.length, k + AHEAD); j++) if (!from || (list[j].lastAt || 0) >= from) textsOf(list[j].id);
    const got = textsOf(c.id), read = typeof got?.then === 'function', msgs = await got;
    if (!msgs) continue;
    const hits = [];
    let count = 0;
    for (const [i, r, at, text] of msgs) {
      if ((want && r !== want) || !inTime(at || c.lastAt || 0)) continue;
      if (!res.every((x) => { x.lastIndex = 0; return x.test(text); })) continue;
      count++;
      if (hits.length < perChat) hits.push({ i, role: r === 'u' ? 'user' : 'agent', at: at || null, ...snippetOf(text, res) });
    }
    if (count && found++ >= offset) {
      if (out.chats.length === limit) { out.more = true; break; }
      out.chats.push({ ...card(c), count, hits });
    }
    // Out of time after reading a file (only the first searches after a start, or after many chats changed): what was
    // found so far, and the page asks for the rest from offset + chats.length. Chats already read are walked again
    // quickly, so each ask gets further.
    if (read && performance.now() - t0 > budget && k < list.length - 1) { out.more = true; out.partial = true; break; }
  }
  warm();
  return out;
}

/** How much chat text is held for search (for tests and Settings → Storage later). */
export const searchCacheStats = () => ({ chats: TEXT.size, chars: held });
/** Forgets every chat's copy, and with { reload: true } reads the saved copy again on the next search, as after a restart (tests). */
export const clearSearchCache = ({ reload = false } = {}) => { TEXT.clear(); LOADING.clear(); held = 0; loaded = !reload; dirty = false; };
/** Saves the texts now (tests; otherwise 20 s after chats were read, and when QuorX exits). */
export const flushSearchIndex = () => save({ now: true });
/** Resolves once the background reading after a search is done (tests). */
export const searchWarmed = () => warming || Promise.resolve();
