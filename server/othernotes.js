// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Other agent tools' notes: a repo made with another coding agent often has its guidance in AGENTS.md, CLAUDE.md and
// the like. QuorX reads them alongside its own AGENT.md (⚙ Settings → Agent loop → Read other agents' notes), so a
// project brings its rules with it. Only files in the project folder, only plain names from the list, never above it.
import fs from 'node:fs';
import path from 'node:path';

export const OTHER_NOTES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md'];
const SAFE = /^(?!.*\.\.)[\w.-]+(\/[\w.-]+)*$/;

/** The names a list may hold: relative, inside the project, no "..". */
export function cleanNoteFiles(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : String(list || '').split(',')) {
    const f = String(x).trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (f && SAFE.test(f) && !/^agent\.md$/i.test(f) && !out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
  }
  return out.slice(0, 12);
}

/** The notes found in `root`: [{ file, text, bytes, cut }], all of them together at most `kb` KB. */
export function readOtherNotes(root, files = OTHER_NOTES_FILES, kb = 8) {
  if (!root) return [];
  let left = Math.max(1, Math.min(64, Number(kb) || 8)) * 1024;
  const out = [];
  for (const f of cleanNoteFiles(files)) {
    if (left <= 0) break;
    const abs = path.join(root, f);
    let text;
    try { const st = fs.lstatSync(abs); if (!st.isFile() || st.size > 2e6) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    text = text.replace(/^﻿/, '').trim();
    if (!text) continue;
    const bytes = Buffer.byteLength(text);
    const cut = bytes > left;
    if (cut) text = `${Buffer.from(text).subarray(0, left).toString('utf8').replace(/�+$/, '')}\n… (cut at the size limit)`;
    left -= Math.min(bytes, left);
    out.push({ file: f, text, bytes, cut });
  }
  return out;
}

/** The block for the system prompt. */
export function otherNotesPrompt(notes) {
  if (!notes.length) return '';
  return `\n\n[Notes this project keeps for other agent tools: ${notes.map((n) => n.file).join(', ')}. The project's authors wrote them; follow them where they fit how you work here (QuorX's own rules and the user's messages come first). Keep your own notes in AGENT.md, not in these files.]\n${notes.map((n) => `--- ${n.file} ---\n${n.text}`).join('\n\n')}`;
}
