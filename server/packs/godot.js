// Godot 4: games and apps in GDScript (C# Godot projects are also .NET projects: the dotnet pack checks those).
// The check parses each changed script headless with --check-only; debugging goes through the Debug Adapter Protocol
// server inside the Godot editor, which runs headless too (--editor --headless --dap-port) and starts the game itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, MAC, run, tempDir, rm } from './_lib.js';

const q = (p) => (/[\s&()]/.test(p) ? `"${p}"` : p);
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const newest = (files) => files.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

// On Windows the editor is a GUI program; the _console.exe beside it is the same engine with a console, whose output
// a pipe always gets, so it is the one checks and jobs run.
const consoleOf = (exe) => { const c = exe.replace(/(\.exe)$/i, '_console$1'); return WIN && !/_console\.exe$/i.test(exe) && exists(c) ? c : exe; };

/** Where Godot might be, most specific first: QX_GODOT or GODOT, then PATH, then winget's, Scoop's and Steam's folders. */
export function godotCandidates(env = process.env) {
  const out = [env.QX_GODOT, env.GODOT_BIN, env.GODOT].filter(Boolean);
  const names = WIN ? ['godot.exe', 'godot4.exe', 'godot_console.exe'] : ['godot', 'godot4'];
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const n of names) out.push(path.join(d, n));
  if (WIN) {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    // winget installs Godot as a portable zip: the exe sits in its package folder, and a link is made only with admin.
    const pk = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter((x) => /^GodotEngine\.GodotEngine/i.test(x))) {
        const found = [];
        const walk = (dir, depth) => { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() && depth < 2) walk(path.join(dir, e.name), depth + 1); else if (/^Godot_v4.*\.exe$/i.test(e.name)) found.push(path.join(dir, e.name)); } } catch { /* unreadable */ } };
        walk(path.join(pk, d), 0);
        if (found.length) out.push(newest(found.filter((f) => !/_console\.exe$/i.test(f))) || newest(found));
      }
    } catch { /* no winget packages */ }
    out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'godot.exe'));
    out.push(path.join(os.homedir(), 'scoop', 'apps', 'godot', 'current', 'godot.exe'));
    const steam = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Godot Engine');
    try { const g = fs.readdirSync(steam).filter((f) => /^godot.*\.exe$/i.test(f) && !/console/i.test(f)); if (g.length) out.push(path.join(steam, newest(g))); } catch { /* no Steam copy */ }
  }
  if (MAC) out.push('/Applications/Godot.app/Contents/MacOS/Godot', path.join(os.homedir(), 'Applications', 'Godot.app', 'Contents', 'MacOS', 'Godot'));
  return [...new Set(out)];
}

/** "4.7.2.stable.official.ed1daf0bf" → "4.7.2"; Godot 4.3 says "4.3.stable…" → "4.3". */
export const godotVersion = (out) => /^(\d+\.\d+(?:\.\d+)?)\.\w+/m.exec(String(out || '').replace(/\x1b\[[0-9;]*m/g, ''))?.[1] || null;

let GODOT = null; // the editor QuorX found, for the check and the debugger
/** The Godot editor QuorX found (after detection), or null. */
export const godotExe = () => GODOT;
async function findGodot() {
  for (const c of godotCandidates()) {
    if (!exists(c)) continue;
    const exe = consoleOf(c);
    const v = godotVersion(await run(exe, ['--version'], { timeout: 15000 }));
    if (v) { GODOT = exe; return v; }
  }
  GODOT = null;
  return null;
}

// Found is not enough: the engine must start and parse a script here (a Godot 3 editor, or one that can't start, fails).
async function godotWorks() {
  if (!/^4\./.test((await run(GODOT, ['--version'], { timeout: 15000 })) || '')) return { ok: false, why: 'this is not Godot 4 (QuorX supports Godot 4 projects)' };
  const dir = tempDir('godotcheck');
  try {
    fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
    fs.writeFileSync(path.join(dir, 'ok.gd'), 'extends SceneTree\n\nfunc _init():\n\tquit()\n');
    const out = await run(GODOT, ['--headless', '--no-header', '--path', dir, '--check-only', '--script', 'res://ok.gd'], { timeout: 60000 });
    return out == null || /SCRIPT ERROR|ERROR:/.test(out) ? { ok: false, why: `Godot did not parse a test script (${String(out || 'it did not start').split(/\r?\n/)[0]})` } : { ok: true, why: '' };
  } finally { rm(dir); }
}

/**
 * Godot's errors in, 'file:line: message' out. A script error is two lines: "SCRIPT ERROR: Parse Error: …" and then
 * "   at: GDScript::reload (res://player.gd:12)". Engine errors whose place is in Godot's own source are left out.
 */
export function parseGodot(out) {
  const lines = String(out || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const seen = new Set(), res = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(SCRIPT ERROR|ERROR|USER ERROR|USER SCRIPT ERROR):\s*(.+)$/.exec(lines[i]);
    if (!m) continue;
    const at = /^\s*at:\s.*?\(res:\/\/([^)]+?):(\d+)\)\s*$/.exec(lines[i + 1] || '');
    if (!at) continue;
    const line = `${at[1]}:${at[2]}: ${m[2].trim()}`;
    if (!seen.has(line)) { seen.add(line); res.push(line); }
  }
  return res;
}

// Each changed script is parsed on its own (Godot reports the first error in each). A script can use another one's
// class_name only through the project's class list in .godot/, which `--import` writes: so the project is imported
// first when it never was, or when this reply added or renamed a class_name.
function checkLines(dir, { files }) {
  if (!GODOT) return null;
  const gd = files.filter((f) => /\.gd$/i.test(f)).slice(0, 20);
  if (!gd.length) return null;
  const g = q(GODOT);
  const declares = gd.some((f) => { try { return /^\s*class_name\s/m.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; } });
  const lines = !fs.existsSync(path.join(dir, '.godot')) || declares ? [`${g} --headless --no-header --path . --import`] : [];
  return [...lines, ...gd.map((f) => `${g} --headless --no-header --path . --check-only --script ${q(`res://${f.split(path.sep).join('/')}`)}`)];
}

/**
 * Where the game's log file is: user://logs/godot.log, which on Windows is %APPDATA%\Godot\app_userdata\<name>\logs
 * (or %APPDATA%\<name>\logs when the project uses its own user folder). `projectText`: project.godot's contents.
 */
export function godotLogDir(projectText, env = process.env) {
  const val = (k) => new RegExp(`^${k.replace(/\//g, '\\/')}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm').exec(projectText || '')?.[1];
  const name = val('config/name') || '[unnamed project]';
  const own = /^true$/i.test(val('config/use_custom_user_dir') || '');
  const custom = val('config/custom_user_dir_name') || name;
  const base = WIN ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : MAC ? path.join(os.homedir(), 'Library', 'Application Support') : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return own ? path.join(base, custom, 'logs') : path.join(base, WIN || MAC ? 'Godot' : 'godot', 'app_userdata', name, 'logs');
}

const resPath = (cwd, file) => `res://${path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/')}`;

export default {
  id: 'godot',
  label: 'Godot',
  summary: 'Games and apps made with Godot 4 and GDScript',
  toolchains: [{
    id: 'godot', label: 'Godot 4', for: 'Godot games and apps (GDScript)', detect: findGodot, works: godotWorks,
    winget: 'GodotEngine.GodotEngine', brew: 'godot', url: 'https://godotengine.org/download',
    brokenHint: 'Offer to install Godot 4 (winget install --id GodotEngine.GodotEngine -e, which asks them first), or set QX_GODOT to the Godot 4 editor they use.',
  }],
  markers: [/^project\.godot$/],
  checks: [{ id: 'godot', tool: 'godot', ext: /\.gd$/i, marker: (d) => fs.existsSync(path.join(d, 'project.godot')), cmd: checkLines, parse: parseGodot, timeout: 300e3 }],
  debug: {
    exts: ['.gd', '.tscn'], tool: 'godot', label: 'Godot (GDScript)',
    gate: () => `${q(GODOT || 'godot')} --editor --headless --path .`,
    // The editor runs headless with its DAP server on `port`, and launches the game (a .tscn file: that scene; a .gd
    // file: the main scene) when QuorX sends configurationDone, after the breakpoints are in.
    start: ({ file, cwd, port }) => ({
      line: `${q(GODOT || 'godot')} --editor --headless --path ${q(cwd)} --dap-port ${port}`,
      adapterID: 'godot', request: 'launch',
      args: { project: path.resolve(cwd).split(path.sep).join('/'), scene: /\.tscn$/i.test(file) ? resPath(cwd, file) : 'main' },
      missing: GODOT ? 'the Godot editor did not open its debugger port (is project.godot in this folder?)' : 'Godot 4 was not found: install it or set QX_GODOT',
    }),
  },
  notes: (have, root) => {
    const g = GODOT ? q(GODOT) : 'godot';
    let logs = '%APPDATA%\\Godot\\app_userdata\\<project name>\\logs';
    try { logs = godotLogDir(fs.readFileSync(path.join(root, 'project.godot'), 'utf8')); } catch { /* the project is deeper, or there's no root */ }
    return `the Godot editor is ${GODOT ? `at ${g}` : 'not installed here'}. Before the final reply QuorX parses each changed .gd file (${g} --headless --path . --check-only --script res://<file>.gd; a script that uses another one's class_name needs \`--import\` first). `
      + `Run the game as a background job (shell, background: true): ${g} --path . (or a scene: ${g} --path . res://level.tscn); its window draws its own buttons, so the desktop tool sees only the window: drive it with screenshots, clicks at coordinates and keys. `
      + `Errors print to the job's output; the same log is user://logs/godot.log, here ${logs}. A SCRIPT ERROR's "at:" line names the res:// file and line. `
      + `Tests: GUT runs with ${g} --headless --path . -s res://addons/gut/gut_cmdln.gd -gdir=res://test -gexit; GdUnit4 with its res://addons/gdUnit4/bin/GdUnitCmdTool.gd -a res://test. `
      + `Export needs the export templates (Editor → Manage Export Templates, a large download: ask first), then ${g} --headless --path . --export-release "<preset in export_presets.cfg>" build/game.exe. `
      + 'The debug tool works on a .gd file (it runs the main scene) or a .tscn scene: the editor runs headless and starts the game with breakpoints set.';
  },
  test: { needs: [] }, // the parsers are tested anywhere; the Godot parts skip without Godot 4
};
