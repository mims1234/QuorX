// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Files shown inline in a chat: pictures, videos, sounds, PDFs and Markdown that a reply wrote or named, and files you
// attached. GET /api/media serves one, only from the chat's project folder (attachments in .quorx/uploads and the
// agent's .quorx/scratch included) or a folder the chat added, through the same checks as the agent's own file tools.
// Other dot folders (.git, .env and the like) and every other kind of file are refused.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safePath, fullLocalPath, chatFolder, folderIndex } from './workspace.js';
import { sendFile } from './blobs.js';

export const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
};
export const mediaKind = (name) => {
  const ext = String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
  return !MEDIA_TYPES[ext] ? '' : /^image\//.test(MEDIA_TYPES[ext]) ? 'image' : /^video\//.test(MEDIA_TYPES[ext]) ? 'video' : /^audio\//.test(MEDIA_TYPES[ext]) ? 'audio' : ext === 'pdf' ? 'pdf' : 'md';
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

/**
 * The file a page's media address points at: /api/media?project&chat&path or /ws/<project>/<path>, through mediaFile's
 * checks. `known(id)` says the project is one of yours, `dirOf(id)` is its folder, `chatOk(id)` checks a chat id.
 */
export function mediaFromSrc(src, { known, dirOf, chatOk }) {
  let u; try { u = new URL(String(src || ''), 'http://x'); } catch { return null; }
  if (u.pathname === '/api/media') {
    const pid = u.searchParams.get('project') || '', cid = u.searchParams.get('chat') || '';
    return known(pid) ? mediaFile(dirOf(pid), chatOk(cid) ? cid : '', u.searchParams.get('path')) : null;
  }
  const m = u.pathname.match(/^\/ws\/([^/]+)\/(.+)$/);
  if (!m) return null;
  let pid, rel; try { pid = decodeURIComponent(m[1]); rel = m[2].split('/').map(decodeURIComponent).join('/'); } catch { return null; }
  return known(pid) ? mediaFile(dirOf(pid), '', rel) : null;
}

/**
 * Puts the file itself on Windows' clipboard (as File Explorer's Copy does), so it pastes into a folder or an app that
 * takes files. The path goes to PowerShell in an environment variable, never in the command text.
 */
export function copyFileToClipboard(file, run = spawn) {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('Copying a file is only on Windows for now.'), { status: 501 }));
  return new Promise((resolve, reject) => {
    const p = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Set-Clipboard -LiteralPath $env:QX_CLIP_FILE'], { env: { ...process.env, QX_CLIP_FILE: file }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n')[0] || `PowerShell ended with ${code}`))));
  });
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
