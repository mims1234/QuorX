// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// News from the QuorX website. QuorX downloads the News feed (https://quorx.genxmims.org/news/feed.json) and keeps a
// copy in data/news-cache/, laid out like news/, so server/news.js reads it the same way. New articles, reports and
// What's new then reach QuorX without a new version. The news/ folder that ships with QuorX is the fallback: before
// the first download, with downloads turned off, and when the copy that shipped is newer (an update installed while
// offline).
//
// What leaves this computer: a request for the feed and for each file that changed, to the site's fixed address,
// with "QuorX/<version>" as the user agent. Nothing about the user, their chats or projects is sent.
//
// What comes back is treated as untrusted: only the feed's own files are fetched, each from an address built here
// (never one the feed gives), each must keep to the names and sizes News allows and match the SHA-256 the feed
// lists, and the whole copy must pass the same check as news/ (scripts/news-check.mjs) before it replaces the old
// one in a single rename. Anything wrong keeps the copy QuorX already has.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, ROOT } from './openrouter.js';
import { checkNews } from '../scripts/news-check.mjs';

// Tests point QUORX_NEWS_SITE at a local server; "off" turns downloads off for the whole process.
const site = () => process.env.QUORX_NEWS_SITE || 'https://quorx.genxmims.org';
const syncAllowed = () => site() !== 'off' && /^https?:\/\/[^\s/]+$/i.test(site());
const cacheDir = () => path.join(HOME, 'data', 'news-cache');
const stateFile = () => path.join(HOME, 'data', 'news-remote.json');
const KINDS = ['articles', 'reports'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE_NAME = /^(index\.md|[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.(json|png|jpe?g|gif|webp|svg))$/i;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const LIMITS = { feed: 2e6, file: 8e6, total: 60e6, files: 600, items: 400 };
const EVERY_MS = 3 * 3600e3;           // check a few times a day
const TIMEOUT_MS = 20e3;

const appVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };
function cmp(a, b) {
  const p = (v) => (VERSION.test(String(v || '')) ? String(v).split('.').map(Number) : [-1, -1, -1]);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
// The newest version in a folder's updates.json, or null.
function topVersion(dir) {
  try {
    const vs = JSON.parse(fs.readFileSync(path.join(dir, 'updates.json'), 'utf8')).versions || [];
    return vs.map((v) => v && v.version).filter((v) => VERSION.test(String(v))).sort((a, b) => cmp(b, a))[0] || null;
  } catch { return null; }
}

/** Whether downloads are on, and how the last one went: { on, site, syncedAt?, checkedAt?, generated?, files?, error? }. */
export function remoteState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { /* first run */ }
  return { on: s.on !== false, site: site(), ...(s.syncedAt ? { syncedAt: s.syncedAt } : {}), ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
    ...(s.generated ? { generated: s.generated } : {}), ...(Number.isFinite(s.files) ? { files: s.files } : {}), ...(s.error ? { error: s.error } : {}) };
}
function saveState(patch) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { /* first run */ }
  const next = { ...s, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2));
}

/** Turns downloads on or off. Off removes the downloaded copy, so News shows the one that shipped with QuorX. */
export function setRemote(on) {
  if (typeof on !== 'boolean') throw new Error('on must be true or false');
  saveState({ on, ...(on ? {} : { syncedAt: undefined, generated: undefined, files: undefined, error: undefined }) });
  if (!on) fs.rmSync(cacheDir(), { recursive: true, force: true });
  return remoteState();
}

/**
 * The folder News reads now: the downloaded copy when downloads are on and it's at least as new as the copy that
 * shipped (compared by the newest version in What's new), else the shipped folder.
 */
export function activeNewsDir(shipped) {
  const cache = cacheDir();
  if (!remoteState().on || !fs.existsSync(path.join(cache, 'updates.json'))) return shipped;
  return cmp(topVersion(cache), topVersion(shipped)) >= 0 ? cache : shipped;
}
export const newsCacheDir = cacheDir;

// GET with a time limit and a size limit, read as a Buffer. A request that fails before any answer (a dropped
// connection) is tried once more.
async function get(url, max) {
  try { return await getOnce(url, max); } catch (e) {
    if (e && e.message === 'fetch failed') { await new Promise((r) => setTimeout(r, 1500)); return getOnce(url, max); }
    throw e;
  }
}
async function getOnce(url, max) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'error', headers: { 'User-Agent': `QuorX/${appVersion()}`, Accept: '*/*' } });
    if (!r.ok) throw new Error(`${new URL(url).pathname} answered ${r.status}`);
    const len = Number(r.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) throw new Error(`${new URL(url).pathname} is too large`);
    const chunks = []; let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > max) { ctl.abort(); throw new Error(`${new URL(url).pathname} is too large`); }
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

// The feed, checked: { versions, items: [{ kind, slug, files: [{ name, size, sha256 }] }] }. Throws on anything off.
function readFeed(buf) {
  let f;
  try { f = JSON.parse(buf.toString('utf8')); } catch { throw new Error('the feed is not valid JSON'); }
  if (!f || f.format !== 1) throw new Error('the feed is in a format this QuorX doesn\'t read');
  const versions = f.updates && Array.isArray(f.updates.versions) ? f.updates.versions : null;
  if (!versions) throw new Error('the feed has no What\'s new');
  const items = []; let files = 0, total = 0;
  for (const kind of KINDS) {
    if (!Array.isArray(f[kind])) throw new Error(`the feed has no ${kind} list`);
    for (const it of f[kind]) {
      if (!it || !SLUG.test(String(it.slug))) throw new Error(`a ${kind} entry has a name News doesn't allow`);
      if (!Array.isArray(it.files) || !it.files.some((x) => x && x.name === 'index.md')) throw new Error(`${kind}/${it.slug} has no index.md`);
      const seen = new Set();
      const list = it.files.map((x) => {
        if (!x || !FILE_NAME.test(String(x.name)) || seen.has(x.name)) throw new Error(`${kind}/${it.slug} lists a file name News doesn't allow`);
        if (!Number.isInteger(x.size) || x.size < 0 || x.size > LIMITS.file) throw new Error(`${kind}/${it.slug}/${x.name} is too large`);
        if (!SHA.test(String(x.sha256))) throw new Error(`${kind}/${it.slug}/${x.name} has no SHA-256`);
        seen.add(x.name); files++; total += x.size;
        return { name: x.name, size: x.size, sha256: x.sha256 };
      });
      items.push({ kind, slug: it.slug, files: list });
    }
  }
  if (items.length > LIMITS.items || files > LIMITS.files || total > LIMITS.total) throw new Error('the feed lists more than QuorX keeps');
  return { versions, items, files, generated: typeof f.generated === 'string' ? f.generated.slice(0, 40) : undefined };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let running = null;

/**
 * Downloads the feed and whatever changed since the last time, then swaps the new copy in. Quietly does nothing when
 * downloads are off, or (unless force) when the last check was recent. Resolves to remoteState(); never throws.
 */
export function syncNews({ force = false } = {}) {
  if (running) return running;
  const st = remoteState();
  if (!st.on || !syncAllowed()) return Promise.resolve(st);
  const last = Date.parse(st.checkedAt || '');
  if (!force && Number.isFinite(last) && Date.now() - last < EVERY_MS) return Promise.resolve(st);
  running = (async () => {
    const cache = cacheDir(), next = `${cache}.next`, old = `${cache}.old`;
    try {
      const feed = readFeed(await get(`${site()}/news/feed.json`, LIMITS.feed));
      fs.rmSync(next, { recursive: true, force: true });
      for (const it of feed.items) {
        const dir = path.join(next, it.kind, it.slug);
        fs.mkdirSync(dir, { recursive: true });
        for (const f of it.files) {
          // Keep a file we already have when it's the same; fetch the rest from the site's fixed address.
          const have = path.join(cache, it.kind, it.slug, f.name);
          let buf = null;
          try { const b = fs.readFileSync(have); if (b.length === f.size && sha256(b) === f.sha256) buf = b; } catch { /* not yet */ }
          if (!buf) {
            buf = await get(`${site()}/news/content/${it.kind}/${it.slug}/${encodeURIComponent(f.name)}?v=${f.sha256.slice(0, 12)}`, LIMITS.file);
            if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error(`${it.kind}/${it.slug}/${f.name} didn't match the feed`);
          }
          fs.writeFileSync(path.join(dir, f.name), buf);
        }
      }
      fs.writeFileSync(path.join(next, 'updates.json'), JSON.stringify({ versions: feed.versions }, null, 2));
      const problems = checkNews(next);
      if (problems.length) throw new Error(`the downloaded News didn't pass the check: ${problems[0].where}: ${problems[0].problem}`);
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(cache)) fs.renameSync(cache, old);
      fs.renameSync(next, cache);
      try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* the new copy is in place; the old one goes next time */ }
      const now = new Date().toISOString();
      saveState({ syncedAt: now, checkedAt: now, generated: feed.generated, files: feed.files, error: undefined });
    } catch (e) {
      // The cleanup can fail too (antivirus holding a file, a full disk). Nothing here may throw: the callers don't
      // wait for this, and an error out of it would end QuorX and every running reply.
      try { fs.rmSync(next, { recursive: true, force: true }); } catch { /* removed on the next sync */ }
      try { saveState({ checkedAt: new Date().toISOString(), error: String(e && e.name === 'AbortError' ? 'the website didn\'t answer in time' : e?.message || e).slice(0, 300) }); } catch { /* the state stays as it was */ }
    } finally { running = null; }
    return remoteState();
  })();
  return running;
}

/** Checks for new News a little after QuorX starts, then a few times a day. */
export function startNewsSync() {
  if (!syncAllowed()) return;
  setTimeout(() => { syncNews(); }, 20e3).unref();
  setInterval(() => { syncNews(); }, EVERY_MS).unref();
}
