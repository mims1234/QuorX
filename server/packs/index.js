// Platform packs: everything QuorX knows about one kind of app, in one file. A pack says how to find its toolchain
// (and check that it really builds), how to install it, which compiler checks run before a reply ends, how to start
// its debugger, and what the agent should know to build, run, test and read crashes. Each file in this folder is one
// pack and is picked up by itself, so adding a platform means adding a file here (plus its self-test in tests/).
// See docs/platform-packs.md for the full shape and how to test a pack.
//
// A pack (every field but id and label is optional):
// {
//   id, label, summary,                 // 'dotnet', '.NET (C#)', 'Console, WPF, WinForms, MAUI and ASP.NET apps'
//   hosts: ['win32', 'darwin', 'linux'],// where it works (default: everywhere)
//   toolchains: [{ id, label, for, probe: [cmd, args], re, detect(), works(), brokenHint, fixWith,
//                  winget, wingetArgs, brew, apt, url }],
//   markers: [/\.csproj$/i],            // file names that mean "this folder is that kind of project"
//   detect(root),                       // or a function, for projects whose marker sits deeper (Android)
//   checks: [{ id, tool, ext, marker(dir), cmd, errors, tidy }], // compiler checks before the final reply (errors:
//                                       // a pattern for its error lines, when the usual "error" match misses them;
//                                       // tidy(line, dir): the line as the agent should read it; cmd may be a
//                                       // function of { dir, files } when the folder decides it, null to skip)
//   summaries: [{ cmd: /^dotnet test\b/, summarize(out) }], // a short summary put above a command's output
//   debug: { exts: ['.cs'], tool, label, gate({ file, args }), start({ file, args, cwd, port }) },
//   notes(have, root),                  // what the agent should know, when the project is this kind
//   test: { needs: ['dotnet'] },        // its self-test (tests/<id>.test.mjs) runs when these are installed
// }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function check(p, file) {
  if (!p || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.id)) throw new Error('needs an id (lower case, letters, digits and -)');
  if (!p.label) throw new Error('needs a label');
  for (const t of p.toolchains || []) if (!t.id || !t.label || !(t.probe || t.detect)) throw new Error(`toolchain ${t.id || '?'} needs an id, a label and a probe or detect()`);
  for (const c of p.checks || []) if (!c.id || !c.tool || !(c.ext instanceof RegExp) || typeof c.marker !== 'function' || !c.cmd) throw new Error(`check ${c.id || '?'} needs id, tool, ext, marker() and cmd`);
  if (p.debug && (!Array.isArray(p.debug.exts) || typeof p.debug.start !== 'function')) throw new Error('debug needs exts and start()');
  if (!file.startsWith(`${p.id}.`)) throw new Error(`the file should be named ${p.id}.js`);
}

/** Every pack, in file-name order. A pack that fails to load is left out and named in `PACK_ERRORS`. */
export const PACKS = [];
export const PACK_ERRORS = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js') && x !== 'index.js' && !x.startsWith('_')).sort()) {
  try {
    const p = (await import(pathToFileURL(path.join(DIR, f)).href)).default;
    check(p, f);
    if (PACKS.some((x) => x.id === p.id)) throw new Error(`a pack named ${p.id} is already loaded`);
    PACKS.push(p);
  } catch (e) { PACK_ERRORS.push({ file: f, error: e.message }); console.error(`QuorX: platform pack ${f} was not loaded: ${e.message}`); }
}

const here = (p) => !p.hosts || p.hosts.includes(process.platform);
export const packById = (id) => PACKS.find((p) => p.id === id);

/** Every toolchain, each tagged with its pack. A toolchain two packs list (Node for TypeScript and Electron) counts once. */
export function allToolchains() {
  const seen = new Map();
  // host: whether a pack that works on this computer lists it (Xcode is only looked for on a Mac).
  for (const p of PACKS) for (const t of p.toolchains || []) { if (!seen.has(t.id)) seen.set(t.id, { ...t, pack: p.id, host: here(p) }); else if (here(p)) seen.get(t.id).host = true; }
  return [...seen.values()];
}

/** The compiler checks of the packs that work on this computer. */
export const allChecks = () => PACKS.filter(here).flatMap((p) => (p.checks || []).map((c) => ({ ...c, pack: p.id })));

/** Whether a compiler check covers this file: a change to it is checked before the final reply. */
export const isCheckedFile = (rel) => allChecks().some((c) => c.ext.test(rel));

/** A pack's summary of what a command printed (failed tests, say), to put above its output; '' when none applies. */
export function outputSummary(line, out) {
  for (const p of PACKS.filter(here)) for (const s of p.summaries || []) {
    if (!s.cmd.test(String(line))) continue;
    try { const t = s.summarize(String(out || '')); if (t) return t; } catch { /* a summary is a convenience */ }
  }
  return '';
}

/** Debuggers by file extension (Node's own inspector is built in; packs add the rest). */
export const debugAdapters = () => PACKS.filter((p) => here(p) && p.debug).map((p) => ({ ...p.debug, pack: p.id, label: p.debug.label || p.label }));

// Folders a project scan skips: build output and downloaded packages, never the project's own files.
const SKIP = /^(node_modules|\.git|\.quorx|target|bin|obj|build|dist|out|\.gradle|\.dart_tool|Pods|DerivedData|venv|\.venv|__pycache__)$/i;
/** The packs whose project files are in `root` or one folder down. */
export function packsIn(root) {
  if (!root) return [];
  const names = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      names.push(e.name);
      if (e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.')) { try { names.push(...fs.readdirSync(path.join(root, e.name)).slice(0, 200)); } catch { /* unreadable */ } }
    }
  } catch { return []; }
  return PACKS.filter((p) => here(p) && ((p.markers || []).some((re) => names.some((n) => re.test(n))) || (typeof p.detect === 'function' && p.detect(root))));
}

/** What the agent should know about the kinds of project in `root`: each pack's notes, given what is installed. */
export function packNotes(root, toolchains = []) {
  const have = new Set(toolchains.filter((t) => t.found).map((t) => t.id));
  const notes = packsIn(root).map((p) => { const n = typeof p.notes === 'function' ? p.notes(have, root) : p.notes; return n ? `- ${p.label}: ${String(n).trim()}` : ''; }).filter(Boolean);
  return notes.length ? `What QuorX knows about the kinds of project in this folder:\n${notes.join('\n')}` : '';
}
