// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ⚙ Settings → Storage → Automatic cleanup: the rules live in data/storage.json (not in the page), so they apply while
// no window is open, and the desktop app reads the two that are its own. Log files that only ever grow call rotateLog
// before they append: past the limit the file becomes <name>.1.<ext> (replacing an older one), so each log takes at
// most twice the limit.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';

const FILE = () => path.join(HOME, 'data', 'storage.json');
export const RULE_DEFAULTS = {
  autoClean: true, // trash retention runs when QuorX starts, then once a day
  trashDays: 30, // deleted chats and skills, and each project's agent trash, go to the Recycle Bin after this many days
  logMaxMB: 50, // each log file
  shotKeep: 300, // check screenshots in logs/check-shots
  updateCleanup: true, // desktop: remove a downloaded installer once that version (or a newer one) runs
  agentCacheOnStart: false, // desktop: clear the browser agent's cache each time QuorX starts
};
const LIMITS = { trashDays: [1, 3650], logMaxMB: [1, 10000], shotKeep: [0, 100000] };

let cache = null, cacheAt = 0;
export function storageRules() {
  if (cache && Date.now() - cacheAt < 5e3) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; } catch { /* defaults */ }
  cache = cleanRules(saved); cacheAt = Date.now();
  return cache;
}
export function cleanRules(r = {}) {
  const out = { ...RULE_DEFAULTS };
  for (const k of Object.keys(RULE_DEFAULTS)) {
    if (!(k in r)) continue;
    if (typeof RULE_DEFAULTS[k] === 'boolean') out[k] = !!r[k];
    else { const n = Number(r[k]); if (Number.isFinite(n)) out[k] = Math.round(Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], n))); }
  }
  return out;
}
export function saveStorageRules(r) {
  const next = cleanRules({ ...storageRules(), ...r });
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(next, null, 2));
  cache = next; cacheAt = Date.now();
  return next;
}

// A stat per append would be wasteful for logs written many times a second: each file is checked at most every 30 s.
const checked = new Map();
/** Moves `file` to <name>.1<ext> when it is past the log limit. Best effort: a locked file is tried again later. */
export function rotateLog(file, maxBytes = storageRules().logMaxMB * 1e6) {
  const now = Date.now();
  if (now - (checked.get(file) || 0) < 30e3) return false;
  checked.set(file, now);
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    const ext = path.extname(file);
    fs.renameSync(file, `${file.slice(0, file.length - ext.length)}.1${ext}`);
    return true;
  } catch { return false; }
}
