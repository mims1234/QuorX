// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Files shown inline in a chat: pictures, videos, PDFs and Markdown that a reply wrote or named, and files you
// attached. GET /api/media serves one, only from the chat's project folder (attachments in .quorx/uploads and the
// agent's .quorx/scratch included) or a folder the chat added, through the same checks as the agent's own file tools.
// Other dot folders (.git, .env and the like) and every other kind of file are refused.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, fullLocalPath, chatFolder, folderIndex } from './workspace.js';
import { sendFile } from './blobs.js';

export const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
};
export const mediaKind = (name) => {
  const ext = String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
  return !MEDIA_TYPES[ext] ? '' : /^image\//.test(MEDIA_TYPES[ext]) ? 'image' : /^video\//.test(MEDIA_TYPES[ext]) ? 'video' : ext === 'pdf' ? 'pdf' : 'md';
};
// Inside a dot folder only the attachments and the agent's scratch space are shown.
const DOT_OK = /^\.quorx\/(uploads|scratch)\/[^/]/i;
const hiddenPart = (rel) => /(^|\/)\./.test(rel) && !DOT_OK.test(rel);

/**
 * The file on disk for `p` as a reply or an attachment names it (relative to the project, or a full path inside the
 * project or one of the chat's added folders), or null when it isn't one to show. `root` is the project folder.
 */
export function mediaFile(root, chatId, p) {
  const s = String(p || '').trim();
  if (!s || s.length > 1000 || !mediaKind(s)) return null;
  let full;
  try { full = fullLocalPath(s); } catch { return null; }
  if (full === null) return null; // a network path: never looked up
  const tries = [];
  if (!full) tries.push([root, s.replace(/\\/g, '/').replace(/^\.\//, '')]);
  else {
    const rel = path.relative(root, full);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) tries.push([root, rel.replace(/\\/g, '/')]);
    const f = chatId ? folderIndex(chatId, full) : null;
    if (f) tries.push([chatFolder(chatId, f.i), f.rel]);
  }
  for (const [dir, rel] of tries) {
    if (!dir || !rel || hiddenPart(rel)) continue;
    try {
      const file = safePath(dir, rel);
      const st = fs.statSync(file);
      if (st.isFile()) return { file, size: st.size, kind: mediaKind(file), mtime: st.mtimeMs };
    } catch { /* outside, off limits or not there */ }
  }
  return null;
}

/** Sends a file found by mediaFile: its type, byte ranges (so a video can seek), and SVG as a sandboxed document. */
export function serveMedia(req, res, found) {
  const ext = path.extname(found.file).slice(1).toLowerCase(), type = MEDIA_TYPES[ext];
  const head = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin', ETag: `"${Math.round(found.mtime).toString(36)}-${found.size.toString(36)}"`,
    ...(ext === 'svg' ? { 'Content-Security-Policy': 'sandbox' } : {}) };
  if (req.headers['if-none-match'] === head.ETag) { res.writeHead(304, head); return res.end(); }
  const size = found.size, range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return sendFile(found.file, res, { start, end });
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  return sendFile(found.file, res);
}
