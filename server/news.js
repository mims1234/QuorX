// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// News (docs/news-format.md): What's new, articles and reports, their data files and pictures, and the user's own
// numbers. They come from the copy downloaded from the QuorX website (server/newsremote.js, data/news-cache/) or, as
// the fallback, the news/ folder that ships with QuorX; both are laid out the same way. Only files inside that folder
// are served and every name is checked strictly. The index is cached until a file in it changes. The last version
// the user read is kept in data/news.json, next to the user's other settings on this computer.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, HOME } from './openrouter.js';
import { parseFront, NEWS } from '../scripts/news-check.mjs';
import { activeNewsDir, newsCacheDir, remoteState, setRemote, syncNews } from './newsremote.js';

const KIND = ['articles', 'reports'];
const SLUG = /^_?[a-z0-9][a-z0-9-]{0,79}$/;          // drafts (a leading _) open by name but are never listed
const LISTED = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const VIEWS = ['models', 'deciders', 'costs', 'tests'];
// Data files and the pictures an article shows. SVG is served sandboxed, so opening one directly can't run script.
const FILES = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const FILE_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.(json|png|jpe?g|gif|webp|svg)$/i;

const stateFile = () => path.join(HOME, 'data', 'news.json');
const appVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; } };

/** -1, 0 or 1, comparing two versions like 0.2.0 part by part (a missing or bad version sorts first). */
export function cmpVersion(a, b) {
  const p = (v) => (VERSION.test(String(v || '')) ? String(v).split('.').map(Number) : [-1, -1, -1]);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The last version of What's new the user has read, or null. */
export function lastRead() {
  try { const v = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).lastRead; return VERSION.test(v) ? v : null; } catch { return null; }
}
/** Marks News read up to `version` (never backwards). Returns the version now stored. */
export function markRead(version) {
  if (!VERSION.test(String(version || ''))) throw new Error('version must look like 0.2.0');
  const cur = lastRead();
  if (cur && cmpVersion(cur, version) >= 0) return cur;
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ lastRead: version, at: new Date().toISOString() }, null, 2));
  return version;
}

// What a list card needs from front matter: tags as a list, order as a number.
function card(slug, front) {
  const tags = String(front.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const out = { slug, title: front.title || slug, date: front.date || '', summary: front.summary || '', tags };
  if (front.version) out.version = front.version;
  if (front.order != null && front.order !== '' && Number.isFinite(Number(front.order))) out.order = Number(front.order);
  return out;
}
function listKind(dir, kind) {
  const base = path.join(dir, kind);
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && LISTED.test(d.name)).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const slug of names) {
    try { out.push(card(slug, parseFront(fs.readFileSync(path.join(base, slug, 'index.md'), 'utf8')).front)); } catch { /* no index.md or no front matter: npm run news:check says why */ }
  }
  // Articles newest first; reports by their order, then newest first.
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title);
  return out.sort(kind === 'reports' ? (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || byDate(a, b) : byDate);
}
function readUpdates(dir) {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'updates.json'), 'utf8'));
    const versions = (Array.isArray(u.versions) ? u.versions : []).filter((v) => v && VERSION.test(v.version)).sort((a, b) => cmpVersion(b.version, a.version));
    return { versions };
  } catch { return { versions: [] }; }
}

// The index is rebuilt only when a listed file changed: the stamp is the modification times of updates.json, the
// two folders, and each index.md in them.
const CACHE = new Map(); // dir → { stamp, index }
function stampOf(dir) {
  const parts = [];
  const mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  parts.push(mt(path.join(dir, 'updates.json')));
  for (const kind of KIND) {
    const base = path.join(dir, kind);
    parts.push(mt(base));
    let names = []; try { names = fs.readdirSync(base); } catch { /* none yet */ }
    for (const n of names.sort()) parts.push(n, mt(path.join(base, n)), mt(path.join(base, n, 'index.md')));
  }
  return parts.join('|');
}
/** { updates, articles, reports } for news/ (cached). */
export function newsIndex(dir = NEWS) {
  const stamp = stampOf(dir), hit = CACHE.get(dir);
  if (hit && hit.stamp === stamp) return hit.index;
  const index = { updates: readUpdates(dir), articles: listKind(dir, 'articles'), reports: listKind(dir, 'reports') };
  CACHE.set(dir, { stamp, index });
  return index;
}

// A folder inside news/, or null when the kind or slug isn't one we serve. Symlinks out of news/ don't count.
function itemDir(dir, kind, slug) {
  if (!KIND.includes(kind) || typeof slug !== 'string' || !SLUG.test(slug)) return null;
  const full = path.join(dir, kind, slug);
  try {
    const real = fs.realpathSync(full), root = fs.realpathSync(dir);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isDirectory()) return null;
    return real;
  } catch { return null; }
}

/** One article or report: { front, body }, or null. */
export function newsItem(kind, slug, dir = NEWS) {
  const d = itemDir(dir, kind, slug);
  if (!d) return null;
  try { const { front, body } = parseFront(fs.readFileSync(path.join(d, 'index.md'), 'utf8')); return { front, body }; } catch { return null; }
}

/** A data file or picture in an article's or report's folder: { file, type } or null. */
export function newsFile(kind, slug, name, dir = NEWS) {
  const d = itemDir(dir, kind, slug);
  if (!d || typeof name !== 'string' || name.length > 120 || !FILE_NAME.test(name) || name.includes('..')) return null;
  const file = path.join(d, name);
  try {
    const real = fs.realpathSync(file);
    if (path.dirname(real) !== d || !fs.statSync(real).isFile()) return null;
    return { file: real, type: FILES[path.extname(real).toLowerCase()] };
  } catch { return null; }
}

/** Where the News being shown comes from: { from: 'website' | 'shipped', on, site, syncedAt?, checkedAt?, error? }. */
export function newsSource(dir) {
  const s = remoteState();
  return { from: path.resolve(dir) === path.resolve(newsCacheDir()) ? 'website' : 'shipped', ...s };
}

/** The user's own numbers for a local block. server/newslocal.js fills them when it is there; until then, empty. */
export async function newsLocal(view) {
  if (!VIEWS.includes(view)) return { error: `view is one of ${VIEWS.join(', ')}` };
  const file = path.join(ROOT, 'server', 'newslocal.js');
  if (!fs.existsSync(file)) return { empty: true };
  try {
    const m = await import(pathToFileURL(file).href);
    if (typeof m.localView !== 'function') return { empty: true };
    return (await m.localView(view)) ?? { empty: true };
  } catch (e) { return { empty: true, error: e.message }; }
}

/**
 * The /api/news routes. Takes { method, pathname, query (URLSearchParams), body (string) } and answers
 * { code, body } for JSON, or { code, file, type, headers } for a file; null when the path isn't a News route.
 */
export async function newsRoute({ method, pathname, query, body }, dir = activeNewsDir(NEWS)) {
  const q = query || new URLSearchParams();
  const no = (code, error) => ({ code, body: { error } });
  if (pathname === '/api/news' && method === 'GET') {
    const lr = lastRead();
    syncNews(); // a quiet check for new News when it's been a while; this answer uses the copy QuorX has now
    return { code: 200, body: { version: appVersion(), ...(lr ? { lastRead: lr } : {}), source: newsSource(dir), ...newsIndex(dir) } };
  }
  // Check the website for new News now, then answer like GET /api/news.
  if (pathname === '/api/news/sync' && method === 'POST') {
    await syncNews({ force: true });
    return newsRoute({ method: 'GET', pathname: '/api/news', query: q, body: '' });
  }
  // Downloads on or off: { "on": true | false }. Off goes back to the copy that shipped with QuorX.
  if (pathname === '/api/news/remote' && method === 'POST') {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { return no(400, 'the body is not JSON'); }
    try { setRemote(b.on); } catch (e) { return no(400, e.message); }
    if (b.on) await syncNews({ force: true });
    return { code: 200, body: { ok: true, source: newsSource(activeNewsDir(NEWS)) } };
  }
  if (pathname === '/api/news/item' && method === 'GET') {
    const it = newsItem(q.get('kind'), q.get('slug'), dir);
    return it ? { code: 200, body: it } : no(404, 'no such article or report');
  }
  if (pathname === '/api/news/file' && method === 'GET') {
    const f = newsFile(q.get('kind'), q.get('slug'), q.get('name'), dir);
    if (!f) return no(404, 'no such file');
    const headers = { 'X-Content-Type-Options': 'nosniff' };
    if (f.type === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    return { code: 200, file: f.file, type: f.type, headers };
  }
  if (pathname === '/api/news/local' && method === 'GET') {
    const r = await newsLocal(q.get('view'));
    return r.error && !r.empty ? no(400, r.error) : { code: 200, body: r };
  }
  if (pathname === '/api/news/read' && method === 'POST') {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { return no(400, 'the body is not JSON'); }
    try { return { code: 200, body: { ok: true, lastRead: markRead(b.version) } }; } catch (e) { return no(400, e.message); }
  }
  if (pathname.startsWith('/api/news/') || pathname === '/api/news') return no(404, 'not found');
  return null;
}
