// The tripwire: while an agent command runs, watch the places a runaway delete would hurt most (your profile
// outside AppData, the folders around the project, the project's .git) and stop the command if many files vanish
// there in a short time. The rule engine can't see deletes made by the project's own code (a build script, a bug in
// the agent's program); this catches the big ones after a few files instead of after hundreds of gigabytes.
// Best effort by design: it only sees what the system's change notifications report, and it reacts after the fact.
// On Linux each folder needs its own watch (inotify), so a whole profile would mean thousands of watches for every
// command: there your profile and the folders directly in it are watched one level deep, which still sees a mass
// delete as it empties them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';
const norm = (p) => (WIN || process.platform === 'darwin' ? p.toLowerCase() : p);
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
  // Busy folders in the profile: AppData on Windows, Library on macOS, caches on Linux.
  const busy = [path.join(home, 'AppData'), path.join(home, 'Library'), path.join(home, '.cache'), path.join(home, '.local', 'share', 'Trash')];
  const shallow = (dir, skip) => {
    let subs = [];
    try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name)); } catch { /* unreadable */ }
    return [{ dir, skip, deep: false }, ...subs.filter((d) => !skip.some((x) => under(d, x))).map((d) => ({ dir: d, skip, deep: false }))];
  };
  const watchList = [
    ...(LINUX ? shallow(home, [...busy, project]) : [{ dir: home, skip: [...busy, project], deep: true }]),
    ...(busyParent ? [] : [{ dir: parent, skip: [project], deep: !LINUX }]),
    { dir: path.join(project, '.git'), skip: [], deep: true },
    ...extraDirs.map((dir) => ({ dir, skip: [project], deep: !LINUX })),
  ];
  const seen = new Set();
  const hits = [];
  let tripped = false;
  const watchers = [];
  // What the command made itself: installers and compilers unpack into temp folders and delete them again (rustup
  // in ~/.rustup, for one), which is not a runaway delete. Only things born after the watch started count, so moving
  // one of your folders and then deleting it is still seen (a move keeps the folder's creation time).
  const startedAt = Date.now() - 100;
  const made = new Set();
  const ours = (full) => { const p = norm(full); for (let d = p; ; d = path.dirname(d)) { if (made.has(d)) return true; if (path.dirname(d) === d) return false; } };
  for (const w of watchList) {
    const key = norm(w.dir);
    if (seen.has(key) || !fs.existsSync(w.dir)) continue;
    // A folder inside another one already watched (e.g. the project's parent inside your profile) is covered.
    if (watchList.some((o) => o !== w && o.deep && seen.has(norm(o.dir)) && under(w.dir, o.dir) && !o.skip.some((s) => under(w.dir, s)))) continue;
    seen.add(key);
    try {
      const watcher = fs.watch(w.dir, { recursive: w.deep, persistent: false }, (event, name) => {
        if (tripped || event !== 'rename' || !name) return;
        const full = path.join(w.dir, String(name));
        if (w.skip.some((s) => under(full, s)) && !under(full, path.join(project, '.git'))) return;
        let st = null; try { st = fs.statSync(full); } catch { /* gone */ }
        // Created or renamed into place, not removed. (Some Linux file systems keep no birth time: the change time then.)
        if (st) { if ((st.birthtimeMs || st.ctimeMs) >= startedAt) made.add(norm(full)); return; }
        if (ours(full)) return;
        // A file made and removed before either notice was handled shows up twice as missing; a real delete of
        // something that was already there shows up once. The second notice cancels the first.
        const twice = hits.findIndex((h) => norm(h.path) === norm(full));
        if (twice >= 0) { hits.splice(twice, 1); made.add(norm(full)); return; }
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
