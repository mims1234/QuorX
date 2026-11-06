// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Files a chat shows inline: which names are pictures, videos, sounds, PDFs or Markdown, which of them a reply wrote,
// and the media its tools made (pictures, clips, voices, music, films).
// The page draws them (app.js, "files shown in the chat"); the server serves them (server/media.js, GET /api/media).

const KINDS = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', mp4: 'video', webm: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', pdf: 'pdf', md: 'md', markdown: 'md' };
/** 'image' | 'video' | 'audio' | 'pdf' | 'md' for a file name or path, '' for anything else. */
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

/** The media one tool_result says its call made, as the chat keys it: { key, path?, art?, kind, tool, name? }. A file
 *  in the project is keyed by its path, an artifact by "art:<id>". The reviewer's and helpers' calls are left out. */
export function stepMedia(e) {
  if (e?.t !== 'tool_result' || e.by || !Array.isArray(e.media)) return [];
  return e.media.filter((x) => x && (typeof x.path === 'string' && x.path || typeof x.art === 'string' && x.art)).map((x) => ({
    key: x.path ? String(x.path) : `art:${x.art}`, ...(x.path ? { path: String(x.path) } : { art: String(x.art) }),
    kind: ['image', 'video', 'audio'].includes(x.kind) ? x.kind : mediaKind(x.path) || 'file', tool: String(e.name || ''), ...(x.name ? { name: String(x.name) } : {}),
  }));
}
/** Every piece of media a reply's tools made, in order, each once (the last call that made it names it). */
export function madeMedia(trace) {
  const out = new Map();
  for (const e of trace || []) for (const x of stepMedia(e)) { out.delete(x.key); out.set(x.key, x); }
  return [...out.values()];
}
