// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Files a chat shows inline: which names are pictures, videos, PDFs or Markdown, and which of them a reply wrote.
// The page draws them (app.js, "files shown in the chat"); the server serves them (server/media.js, GET /api/media).

const KINDS = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', mp4: 'video', webm: 'video', pdf: 'pdf', md: 'md', markdown: 'md' };
/** 'image' | 'video' | 'pdf' | 'md' for a file name or path, '' for anything else. */
export const mediaKind = (name) => KINDS[String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()] || '';

// Tools that leave a file at args.path once they succeed.
const WRITERS = new Set(['write_file', 'append_file', 'edit_file']);
/** Paths of pictures, videos, PDFs and Markdown a reply's tools wrote, in order, each once (failed calls left out). */
export function writtenMedia(trace) {
  const waiting = new Map(), out = [];
  for (const e of trace || []) {
    if (e?.by) continue; // the reviewer's and helpers' work stays in the steps
    if (e?.t === 'tool' && WRITERS.has(e.name)) { (waiting.get(e.name) || waiting.set(e.name, []).get(e.name)).push(String(e.args?.path || '')); continue; }
    if (e?.t === 'tool_result' && WRITERS.has(e.name)) {
      const p = waiting.get(e.name)?.shift();
      if (p && mediaKind(p) && !/^Error/.test(String(e.result ?? '')) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
