// Big pictures, recordings and videos are kept as files of their own (data/blobs/<sha256>.<ext>) instead of as
// base64 inside chat files and run logs. Every browser screenshot used to ride along in the chat: one chat reached
// 109 MB, and the page sent all of it back to the server on every save. Now events and saved chats carry a short
// /blob/<name> address, the page loads the picture from it, and the same picture is stored once however often it
// is used. Blobs nothing refers to any more (deleted chats, expired run logs) are removed after a while.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';

const DIR = path.join(HOME, 'data', 'blobs');
const MIN = 16 * 1024; // smaller data URLs stay where they are
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf' };
const EXT = { ...Object.fromEntries(Object.entries(TYPES).map(([e, t]) => [t, e])), 'image/jpg': 'jpg', 'audio/mp3': 'mp3', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm' };
const HEAD = /^data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+=[^;,]*)*);base64,/i;

/** A data URL as a blob address (/blob/<sha256>.<ext>), or null when it is not a kind kept as a blob. */
export function blobUrl(dataUrl) {
  const m = HEAD.exec(dataUrl.slice(0, 200));
  const ext = m && EXT[m[1].toLowerCase()];
  if (!ext) return null;
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (!buf.length) return null;
  const name = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`, file = path.join(DIR, name);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    } else fs.utimesSync(file, new Date(), new Date()); // still in use: the sweep keeps it
  } catch { return null; } // disk trouble: the data URL stays inline, as before
  return `/blob/${name}`;
}

/**
 * The same value with every big data URL in it replaced by its blob address. Parts that change are copied;
 * the rest is shared with the original, which is never modified.
 */
export function externalize(v, depth = 0) {
  if (typeof v === 'string') return v.length >= MIN && v.startsWith('data:') ? blobUrl(v) || v : v;
  if (!v || typeof v !== 'object' || depth > 40) return v;
  let out = null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const n = externalize(v[i], depth + 1); if (n !== v[i]) { out ??= v.slice(); out[i] = n; } }
  } else {
    for (const k of Object.keys(v)) { const n = externalize(v[k], depth + 1); if (n !== v[k]) { out ??= { ...v }; out[k] = n; } }
  }
  return out || v;
}

/** In a saved JSON text: the data URLs externalize would move out (⚙ Settings → Storage → Compact chats). → { bytes, count, decoded } */
export function inlinePictures(text) {
  let bytes = 0, count = 0, decoded = 0, i = 0;
  while ((i = text.indexOf('"data:', i)) !== -1) {
    const end = text.indexOf('"', i + 1);
    if (end < 0) break;
    const len = end - i - 1;
    if (len >= MIN) {
      const m = HEAD.exec(text.slice(i + 1, i + 201));
      if (m && EXT[m[1].toLowerCase()]) { bytes += len; count++; decoded += Math.floor((len - m[0].length) * 3 / 4); }
    }
    i = end + 1;
  }
  return { bytes, count, decoded };
}

const nameOf = (url) => String(url || '').match(/^\/blob\/([0-9a-f]{64}\.[a-z0-9]{2,5})$/)?.[1] || null;
/** A blob address back as a data URL (for model providers, which can't reach this computer), or null. */
export function blobData(url) {
  const name = nameOf(url), ext = name?.split('.').pop();
  if (!name || !TYPES[ext]) return null;
  try { return `data:${TYPES[ext]};base64,${fs.readFileSync(path.join(DIR, name)).toString('base64')}`; } catch { return null; }
}

/** GET /blob/<name>: cached for good (the name is the content), with byte ranges so audio and video can seek. */
export function serveBlob(req, res, name) {
  const ext = name.split('.').pop(), type = TYPES[ext], file = path.join(DIR, name);
  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!type || !st) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('This file is not kept any more.'); }
  const head = { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${name.slice(0, 16)}"`, 'Accept-Ranges': 'bytes',
    ...(ext === 'svg' ? { 'Content-Security-Policy': 'sandbox' } : {}), 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === head.ETag) { res.writeHead(304, head); return res.end(); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  return fs.createReadStream(file).pipe(res);
}

// ---------- the sweep: blobs nothing refers to any more ----------
// What can refer to a blob: saved chats, deleted chats (data/trash, so a restored chat keeps its pictures) and
// run logs (data/runs, kept 3 days). A blob is removed only when none of them names it and it is over 2 days old,
// so a picture made by a reply that is still running (and not saved yet) is never swept.
const KEEP_MS = 2 * 864e5;
async function sweep() {
  for (const b of await unusedBlobs()) { try { await fs.promises.rm(b.path, { force: true }); } catch { /* in use or gone */ } }
}
/** Blobs nothing names and older than `minAgeMs` (⚙ Settings → Storage clears these sooner than the sweep): [{ name, path, bytes }]. */
export async function unusedBlobs(minAgeMs = KEEP_MS) {
  let names;
  try { names = await fs.promises.readdir(DIR); } catch { return []; }
  if (!names.length) return [];
  const used = new Set();
  // Chats, deleted chats, run logs, and older replies' steps kept apart (data/traces, and in the trash with their chat).
  const look = async (dir, deep) => {
    let list = [];
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (deep) await look(p, deep - 1); continue; }
      if (!/\.(json|jsonl)$/.test(e.name)) continue;
      let text;
      try { text = await fs.promises.readFile(p, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/\/blob\/([0-9a-f]{64}\.[a-z0-9]{2,5})/g)) used.add(m[1]);
    }
  };
  for (const sub of ['chats', 'runs']) await look(path.join(HOME, 'data', sub), 0);
  await look(path.join(HOME, 'data', 'traces'), 1);
  await look(path.join(HOME, 'data', 'trash'), 2);
  const now = Date.now(), out = [];
  for (const n of names) {
    if (used.has(n)) continue;
    const p = path.join(DIR, n);
    try { const st = await fs.promises.stat(p); if (st.isFile() && now - st.mtimeMs > minAgeMs) out.push({ name: n, path: p, bytes: st.size }); } catch { /* gone */ }
  }
  return out;
}
// ---------- what deleting one chat frees (the delete question and the sidebar's 🗑 hover) ----------
// The pictures each saved chat (and deleted chat) names, remembered per file by its size and time, so asking again
// only reads the files that changed.
const NAMED = new Map(); // path → { mtime, size, names: Set }
async function namesIn(p) {
  let st; try { st = await fs.promises.stat(p); } catch { NAMED.delete(p); return null; }
  const hit = NAMED.get(p);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
  let text; try { text = await fs.promises.readFile(p, 'utf8'); } catch { return null; }
  const rec = { mtime: st.mtimeMs, size: st.size, names: new Set([...text.matchAll(/\/blob\/([0-9a-f]{64}\.[a-z0-9]{2,5})/g)].map((m) => m[1])) };
  NAMED.set(p, rec);
  return rec;
}
/**
 * → { chat: bytes of the chat file, pictures: bytes of pictures no other chat names, count } or null. `refs` and
 * `counts` come from the chat index (store.js chatPictureRefs, pictureRefCounts), so no chat file is read; only
 * QuorX's trash (deleted chats, usually few) is looked through. Run logs are left out: they go by themselves within 3 days.
 */
export async function chatFootprint(refs, counts) {
  if (!refs) return null;
  const inTrash = new Set(), dir = path.join(HOME, 'data', 'trash');
  let files = []; try { files = await fs.promises.readdir(dir); } catch { /* none */ }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const r = await namesIn(path.join(dir, f));
    if (r) for (const n of refs.blobs) if (r.names.has(n)) inTrash.add(n);
  }
  let pictures = 0, count = 0;
  for (const n of refs.blobs) {
    if ((counts.get(n) || 0) > 1 || inTrash.has(n)) continue;
    try { pictures += (await fs.promises.stat(path.join(DIR, n))).size; count++; } catch { /* gone */ }
  }
  return { chat: refs.size, pictures, count };
}
export function startSweeping() {
  setTimeout(() => sweep().catch(() => {}), 60e3).unref();
  setInterval(() => sweep().catch(() => {}), 6 * 3600e3).unref();
}
