// The tripwire: while an agent command runs, watch the places a runaway delete would hurt most (your profile
// outside AppData, the folders around the project, the project's .git) and stop the command if many files vanish
// there in a short time. The rule engine can't see deletes made by the project's own code (a build script, a bug in
// the agent's program); this catches the big ones after a few files instead of after hundreds of gigabytes.
// Best effort by design: it only sees what Windows' change notifications report, and it reacts after the fact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);
const under = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

/**
 * Starts watching. `onTrip({ count, sample })` is called once, when `files` removals happen within `seconds`.
 * Returns stop(). Folders that can't be watched are skipped silently.
 */
export function startTripwire({ root, files = 25, seconds = 3, onTrip, extraDirs = [] }) {
  const home = os.homedir();
  const project = path.resolve(root);
  // Where to look, and what to ignore inside it (busy folders that delete files all the time on their own).
  // The project's parent is skipped when it is the system Temp folder (other programs delete files there all the
  // time) or a drive root (watching a whole drive is too much); your profile is still watched.
  const parent = path.dirname(project);
  const busyParent = norm(path.resolve(parent)) === norm(path.resolve(os.tmpdir())) || path.dirname(parent) === parent;
  const watchList = [
    { dir: home, skip: [path.join(home, 'AppData'), project] },
    ...(busyParent ? [] : [{ dir: parent, skip: [project] }]),
    { dir: path.join(project, '.git'), skip: [] },
    ...extraDirs.map((dir) => ({ dir, skip: [project] })),
  ];
  const seen = new Set();
  const hits = [];
  let tripped = false;
  const watchers = [];
  for (const w of watchList) {
    const key = norm(w.dir);
    if (seen.has(key) || !fs.existsSync(w.dir)) continue;
    // A folder inside another one already watched (e.g. the project's parent inside your profile) is covered.
    if (watchList.some((o) => o !== w && seen.has(norm(o.dir)) && under(w.dir, o.dir) && !o.skip.some((s) => under(w.dir, s)))) continue;
    seen.add(key);
    try {
      const watcher = fs.watch(w.dir, { recursive: true, persistent: false }, (event, name) => {
        if (tripped || event !== 'rename' || !name) return;
        const full = path.join(w.dir, String(name));
        if (w.skip.some((s) => under(full, s)) && !under(full, path.join(project, '.git'))) return;
        if (fs.existsSync(full)) return; // created or renamed into place, not removed
        const now = Date.now();
        hits.push({ at: now, path: full });
        while (hits.length && now - hits[0].at > seconds * 1000) hits.shift();
        if (hits.length >= files) { tripped = true; onTrip?.({ count: hits.length, sample: hits.slice(-8).map((h) => h.path) }); }
      });
      watcher.on('error', () => { /* the folder went away */ });
      watchers.push(watcher);
    } catch { /* can't watch it (permissions): skip */ }
  }
  return () => { for (const w of watchers) { try { w.close(); } catch { /* closed */ } } };
}
