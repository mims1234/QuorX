// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A script a command runs, read for you before you allow the command (GET /api/script-file): the file as it is on
// disk right now, read only, from the chat's project folder or a folder the chat added, through the same path checks
// as the agent's own file tools (safePath). Missing, too big, binary and outside files come back as a short reason.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, fullLocalPath } from './workspace.js';

export const SCRIPT_MAX = 2e6; // bytes shown at most

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
/**
 * The file on disk for `p` (relative to the project folder `root`, or a full path inside it or inside one of
 * `folders`, the chat's added folders), or throws { status, code, message }: 'missing' | 'outside' | 'notfile'.
 */
export function findScript(root, folders, p) {
  const s = String(p || '').trim();
  if (!s || s.length > 1000) throw fail(400, 'bad', 'no file named');
  let full;
  try { full = fullLocalPath(s); } catch { full = null; }
  if (full === null) throw fail(403, 'outside', 'that is a network path: QuorX only reads files on this computer');
  const tries = [];
  if (!full) { if (root) tries.push([root, s]); }
  else {
    for (const dir of [root, ...(folders || [])].filter(Boolean)) {
      const rel = path.relative(dir, full);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) tries.push([dir, rel || '.']);
    }
  }
  if (!tries.length) throw fail(403, 'outside', 'that file is outside the project and the folders this chat added');
  let why = null;
  for (const [dir, rel] of tries) {
    let file;
    try { file = safePath(dir, rel); } catch (e) { why = fail(403, 'outside', e.message); continue; }
    let st;
    try { st = fs.statSync(file); } catch { why ||= fail(404, 'missing', `no file at ${s} right now (it may not be written yet, or it was moved)`); continue; }
    if (!st.isFile()) { why = fail(400, 'notfile', `${s} is a folder, not a file`); continue; }
    return { file, size: st.size, mtime: st.mtimeMs };
  }
  throw why;
}

/** { text, file, size } for the file, or throws like findScript plus 'big' and 'binary'. */
export function readScript(root, folders, p, { max = SCRIPT_MAX } = {}) {
  const found = findScript(root, folders, p);
  if (found.size > max) throw fail(413, 'big', `${path.basename(found.file)} is ${(found.size / 1e6).toFixed(1)} MB, too big to show here (over ${Math.round(max / 1e6)} MB). Show it in its folder to open it elsewhere.`);
  const buf = fs.readFileSync(found.file);
  if (buf.subarray(0, 8000).includes(0)) throw fail(415, 'binary', `${path.basename(found.file)} is a binary file (a program or data, not text): there is nothing to read here.`);
  return { text: buf.toString('utf8').replace(/^﻿/, ''), file: found.file, size: found.size };
}
