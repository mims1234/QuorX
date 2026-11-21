// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ✦ What lets the QuorX assistant know and reach all of QuorX (server/assistant.js):
//   - a map of QuorX's own HTTP API, read from server.js itself (every route, its methods and the comment above it),
//     so it stays complete as QuorX grows;
//   - reads of any route, with secrets taken out and long answers paged;
//   - actions on any route, only ever as a card the user clicks (assistant.js), never on their own;
//   - a chat read the way a person reads it: who said what, what each reply did, and a reply that is still working.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtime } from './openrouter.js';
import { appKey } from './access.js';
import { getChat } from './store.js';

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

// Routes the assistant never reads or calls: keys, secrets and sign-ins; the page's own handoff; the streams a reply
// writes to (they never end), and starting a reply by hand (start_chat does that properly).
const BLOCKED = /\/(keys?|secrets?|oauth|handoff|access|app-key|extension-key|credentials?|token)(\/|$)|\/events$|^\/api\/run$|^\/api\/transcribe$/i;
export const blockedPath = (p) => BLOCKED.test(String(p).split('?')[0]);
// Fields that could hold a secret are dropped from every answer; big inline data is shown as its size.
const SECRET_FIELD = /(api.?key|secret|passw(or)?d|credential|(access|auth|refresh|bearer|session|api|github|gh).?token|^token$|^key$|cookie|authorization)/i;
export function scrub(v, depth = 0) {
  if (depth > 12) return '[deep]';
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_FIELD.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 3000 && (/^data:/.test(v) || /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 400)))) return `[data, ${v.length} characters]`;
  return v;
}

// ---------- the map ----------
let MAP = null;
/** Every route in server.js: { path, methods, note }. A path with :id stands for a part the route matches. */
export function apiMap(src) {
  if (MAP && !src) return MAP;
  const lines = String(src ?? fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')).split('\n');
  const by = new Map();
  let note = [], i = -1;
  for (const raw of lines) {
    i++;
    const t = raw.trim();
    if (t.startsWith('//')) { note.push(t.replace(/^\/\/\s?/, '')); if (note.length > 4) note.shift(); continue; }
    if (!t) continue;
    const paths = [...t.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)].map((m) => m[1]);
    const rx = t.match(/url\.pathname\.match\(\/\^(.+?)\$?\/[a-z]*\);/);
    // /^\/api\/runs\/([\w-]+)(?:\/(events|stop))?$/ → /api/runs/:id[/events|stop]; (\/run)? → [/run]
    if (rx) paths.push(rx[1].replace(/\\\//g, '/').replace(/\(\?:\/\(([^)]*)\)\)\?/g, '[/$1]').replace(/\((\/[^()]*)\)\?/g, '[$1]').replace(/\([^)]*\)/g, ':id').replace(/\\/g, ''));
    if (paths.length) {
      const methods = [...new Set([...t.matchAll(/req\.method === '(\w+)'/g)].map((m) => m[1]))];
      for (const p of paths.filter((x) => x.startsWith('/api/'))) {
        const e = by.get(p) || { path: p, methods: [], note: '', lines: [] };
        e.lines.push(i);
        e.methods = [...new Set([...e.methods, ...methods])];
        if (!e.note && note.length) e.note = clip(note.join(' '), 300);
        by.set(p, e);
      }
    }
    note = [];
  }
  const out = [...by.values()].filter((e) => !blockedPath(e.path.replace(/:id/g, 'x')));
  if (!src) { MAP = out; SRC = lines; }
  return out;
}
let SRC = null;
/** How a route works: its own code in server.js (the methods it answers, the body and query it reads, what it returns). */
export function routeHow(p, src) {
  const lines = src ? String(src).split('\n') : (apiMap(), SRC);
  const want = String(p || '').split('?')[0].replace(/\/[a-z0-9_-]*\d[a-z0-9_-]*(?=\/|$)/gi, '/:id');
  const all = src ? apiMap(src) : apiMap();
  const e = all.find((x) => x.path === p) || all.find((x) => x.path === want) || all.find((x) => x.path.replace(/\[[^\]]*\]/g, '') === want) || all.find((x) => want.startsWith(x.path.replace(/\[.*$/, '').replace(/:id.*$/, '')) && x.path.includes(':id')) || all.find((x) => x.path.startsWith(want));
  if (!e) return { error: `no route like ${p}; find one with api_list` };
  const parts = e.lines.slice(0, 3).map((at) => lines.slice(at, at + 14).join('\n'));
  return { path: e.path, methods: e.methods, note: e.note, code: clip(parts.join('\n…\n'), 5000) };
}
/** Routes that match the words (in the path or the comment), best first. */
export function findRoutes(query = '', limit = 40) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const all = apiMap();
  if (!words.length) return all.slice(0, limit);
  return all.map((e) => [e, words.filter((w) => `${e.path} ${e.note}`.toLowerCase().includes(w)).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([e]) => e);
}

// ---------- reads and calls ----------
const PAGE = 8000;
async function call(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${runtime.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-QuorX-Key': appKey }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { text: clip(text, 20000) }; }
  return { status: r.status, body: scrub(j) };
}
function checkPath(p) {
  const s = String(p || '').trim();
  if (!s.startsWith('/api/')) throw new Error('a path that starts with /api/ (find one with api_list)');
  if (blockedPath(s)) throw new Error('that route holds keys, secrets or sign-ins, or is a stream: it is not for the assistant');
  return s;
}
/** GET any route: the answer as JSON text, a page at a time (offset continues it). */
export async function apiGet({ path: p, offset = 0 }) {
  const { status, body } = await call('GET', checkPath(p));
  const text = JSON.stringify(body);
  const at = Math.max(0, Number(offset) || 0);
  return { status, total: text.length, ...(at + PAGE < text.length ? { more: `call again with offset ${at + PAGE}` } : {}), page: text.slice(at, at + PAGE) };
}
/** POST, PUT or DELETE any route: only after the user clicked its card. */
export async function apiCall({ method = 'POST', path: p, body }) {
  const m = String(method).toUpperCase();
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(m)) throw new Error('method is POST, PUT, PATCH or DELETE');
  const { status, body: out } = await call(m, checkPath(p), body ?? {});
  return { status, result: clip(JSON.stringify(out), 3000) };
}

// ---------- a chat, read like a person reads it ----------
const toolCounts = (trace = []) => {
  const n = {};
  for (const e of trace) if (e?.t === 'tool' && !e.by && e.name) n[e.name] = (n[e.name] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(', ');
};
/** A chat's last messages (or from `offset`), what each reply did and cost, and how a reply that is working is doing. */
export async function readChat({ id, last = 10, offset, runLog } = {}) {
  const doc = getChat(String(id || ''));
  if (!doc) throw new Error(`no chat "${id}" (find it with chats)`);
  const msgs = (doc.agent?.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  const n = Math.max(1, Math.min(30, Number(last) || 10));
  const from = offset != null ? Math.max(0, Number(offset) || 0) : Math.max(0, msgs.length - n);
  const rows = msgs.slice(from, from + n).map((m, i) => {
    const row = { n: from + i, who: m.role === 'user' ? 'user' : 'agent', at: m.at ? new Date(m.at).toISOString().slice(0, 16) : undefined, text: clip(String(m.content || '').trim(), 1500) || undefined };
    if (m.role === 'assistant') {
      const done = (m.trace || []).findLast?.((e) => e?.t === 'done');
      if (!row.text && done?.reply) row.text = clip(done.reply, 1500);
      const tools = toolCounts(m.trace);
      if (tools) row.did = tools;
      if (m.stats?.cost != null || m.liveCost) row.cost = Number((m.stats?.cost ?? m.liveCost) || 0).toFixed(4);
      if (m.error) row.state = 'failed';
      else if (m.runActive) row.state = 'working or interrupted';
      const waiting = Object.values(m.approvals || {}).filter((a) => a && a.answered !== true && a.state !== 'done' && !a.done).length;
      if (m.runActive && waiting) row.waiting = `${waiting} approval card(s) may be waiting`;
      if (m.runId) row.run = m.runId;
    }
    return row;
  });
  // A reply still working: its own log knows better than the saved chat.
  const live = msgs.findLast((m) => m.role === 'assistant' && m.runActive && m.runId);
  let running = null;
  if (live) {
    try {
      const log = runLog ? await runLog(live.runId) : (await call('GET', `/api/runs/${encodeURIComponent(live.runId)}/log`)).body;
      const ev = log.events || [];
      const asked = ev.filter((e) => e.t === 'question'), answered = new Set(ev.filter((e) => e.t === 'answer').map((e) => e.id));
      const appr = ev.filter((e) => e.t === 'approval'), apprDone = new Set(ev.filter((e) => e.t === 'approval_done').map((e) => e.id));
      const done = ev.find((e) => e.t === 'done'), err = ev.findLast((e) => e.t === 'error');
      const waitQ = asked.find((q) => !answered.has(q.id) && !q.auto), waitA = appr.find((a) => !apprDone.has(a.id));
      running = { run: live.runId, status: done ? 'done' : err ? 'ended with an error' : log.status === 'running' ? (waitQ || waitA ? 'waiting for the user' : 'working') : log.status || 'not running (interrupted)',
        ...(waitQ ? { question: clip(waitQ.question, 300) } : {}), ...(waitA ? { approval: clip(waitA.what || waitA.tool, 300) } : {}),
        steps: ev.filter((e) => e.t === 'tool' && !e.by).slice(-8).map((e) => `${e.name}${e.args?.path ? ` ${e.args.path}` : ''}`),
        ...(done ? { answer: clip(done.reply, 1500) } : {}), ...(err && !done ? { error: clip(err.msg, 300) } : {}) };
    } catch (e) { running = { run: live.runId, status: `couldn't read its log (${e.message})` }; }
  }
  return { id: doc.id, title: doc.title, project: doc.projectId || 'scratch', model: doc.agent?.setup?.model, messages: msgs.length, showing: `${from}–${from + rows.length - 1}`, ...(from > 0 ? { earlier: `offset ${Math.max(0, from - n)} for earlier messages` } : {}), rows, ...(running ? { running } : {}) };
}
