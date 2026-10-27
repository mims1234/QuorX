// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What agents learned about an app on the user's computer or a website, kept across chats and projects
// (data/app-notes/<kind>-<name>.md): where things are, how to do a task there, what didn't work. The next agent that
// opens the app gets them, marked as possibly outdated, and checks them against what it sees now.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';

const DIR = path.join(HOME, 'data', 'app-notes');
const MAX = 4000; // per app: the newest notes are kept
const slug = (s) => String(s || '').toLowerCase().replace(/\s+\d[\d.]*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const fileOf = (kind, name) => { const s = slug(name); return s ? path.join(DIR, `${kind === 'site' ? 'site' : 'app'}-${s}.md`) : ''; };

/** The notes kept for an app ('app', its name) or a website ('site', its host), or ''. */
export function readNotes(kind, name) {
  const f = fileOf(kind, name);
  try { return f ? fs.readFileSync(f, 'utf8').trim() : ''; } catch { return ''; }
}

/** Adds what was learned, one line per point; a point already there isn't added again. Returns the kept text. */
export function addNotes(kind, name, text) {
  const f = fileOf(kind, name);
  if (!f) throw new Error('no app or site name');
  const have = readNotes(kind, name).split('\n').filter(Boolean);
  const key = (l) => l.replace(/^[-*]\s*/, '').trim().toLowerCase();
  const seen = new Set(have.map(key));
  const add = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => (/^[-*] /.test(l) ? l : `- ${l}`)).filter((l) => !seen.has(key(l)) && seen.add(key(l)));
  if (!add.length) return have.join('\n');
  let lines = [...have, ...add];
  while (lines.join('\n').length > MAX && lines.length > 1) lines = lines.slice(1);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  return lines.join('\n');
}
