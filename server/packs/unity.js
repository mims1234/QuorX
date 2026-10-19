// Unity: games and apps in C#. Editors are installed per version through Unity Hub, and a project names the version
// it needs in ProjectSettings/ProjectVersion.txt. The check is a batchmode compile with that editor; tests run with
// -runTests and write an NUnit XML file. Unity's debugger is its own (not DAP), so debugging here is logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, MAC } from './_lib.js';

const q = (p) => (/[\s&()]/.test(p) ? `"${p}"` : p);
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const byVersion = (a, b) => b.version.localeCompare(a.version, undefined, { numeric: true });

/** "m_EditorVersion: 2022.3.10f1" → "2022.3.10f1" (the text of ProjectSettings/ProjectVersion.txt). */
export const projectUnityVersion = (text) => /^m_EditorVersion:\s*(\S+)/m.exec(String(text || ''))?.[1] || null;

// The editor binary inside a version's folder, per system.
const editorIn = (dir) => (WIN ? path.join(dir, 'Editor', 'Unity.exe') : MAC ? path.join(dir, 'Unity.app', 'Contents', 'MacOS', 'Unity') : path.join(dir, 'Editor', 'Unity'));
const HUB = WIN ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity Hub', 'Unity Hub.exe') : MAC ? '/Applications/Unity Hub.app' : path.join(os.homedir(), 'Applications', 'Unity Hub.AppImage');
const hubData = () => (WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'UnityHub')
  : MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'UnityHub') : path.join(os.homedir(), '.config', 'UnityHub'));

/**
 * Every Unity editor Unity Hub knows: [{ version, exe }], newest first. Hub installs into one folder per version
 * (Program Files\Unity\Hub\Editor\<version>, or the folder chosen in Hub, kept in secondaryInstallPath.json), and
 * editors added by hand are listed in its editors*.json files.
 */
export function unityEditors({ hubDir = hubData(), roots } = {}) {
  const dirs = roots || [WIN ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity', 'Hub', 'Editor') : MAC ? '/Applications/Unity/Hub/Editor' : path.join(os.homedir(), 'Unity', 'Hub', 'Editor')];
  try { const s = JSON.parse(fs.readFileSync(path.join(hubDir, 'secondaryInstallPath.json'), 'utf8')); if (typeof s === 'string' && s) dirs.push(s); } catch { /* none chosen */ }
  const found = new Map();
  for (const d of dirs) {
    try { for (const v of fs.readdirSync(d)) { const exe = editorIn(path.join(d, v)); if (/^\d{4}\.\d+\.\d+\w+$/.test(v) && exists(exe)) found.set(v, exe); } } catch { /* no such folder */ }
  }
  try {
    for (const f of fs.readdirSync(hubDir).filter((x) => /^editors.*\.json$/i.test(x))) {
      const text = fs.readFileSync(path.join(hubDir, f), 'utf8');
      for (const m of text.matchAll(/"([^"]+?(?:Unity\.exe|Unity\.app|Editor[\\/]+Unity))"/g)) {
        const raw = JSON.parse(`"${m[1]}"`);
        const exe = /Unity\.app$/.test(raw) ? path.join(raw, 'Contents', 'MacOS', 'Unity') : raw;
        const v = /(\d{4}\.\d+\.\d+[abfp]\d+)/.exec(raw)?.[1];
        if (v && exists(exe) && !found.has(v)) found.set(v, exe);
      }
    }
  } catch { /* no Hub data */ }
  return [...found].map(([version, exe]) => ({ version, exe })).sort(byVersion);
}

let EDITORS = [];
const findEditors = async () => { EDITORS = unityEditors(); return EDITORS.length ? EDITORS.map((e) => e.version).join(', ') : null; };
const findHub = async () => (fs.existsSync(HUB) ? 'installed' : null);

// A license file in one of the places Unity keeps them (a missing one is only a hint: floating licenses live elsewhere).
const licensed = () => [WIN ? 'C:\\ProgramData\\Unity\\Unity_lic.ulf' : MAC ? '/Library/Application Support/Unity/Unity_lic.ulf' : path.join(os.homedir(), '.local', 'share', 'unity3d', 'Unity', 'Unity_lic.ulf'),
  path.join(WIN ? process.env.LOCALAPPDATA || '' : MAC ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'), 'Unity', 'licenses', 'UnityEntitlementLicense.xml')].some(exists);

/** The project's Unity version and the installed editor for it: { version, exe } (exe null when it isn't installed). */
export function editorFor(dir, editors = EDITORS) {
  let version = null;
  try { version = projectUnityVersion(fs.readFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')); } catch { /* not a Unity project */ }
  return { version, exe: editors.find((e) => e.version === version)?.exe || null };
}

// Unity locks Temp/UnityLockfile while the project is open in the editor, and a second Unity can't open it then.
const openInEditor = (dir) => {
  const f = path.join(dir, 'Temp', 'UnityLockfile');
  if (!fs.existsSync(f)) return false;
  try { fs.closeSync(fs.openSync(f, 'r+')); return false; } catch { return true; }
};

// The batchmode compile, when it can run: the project's editor version is installed, the project was imported once
// (Library/ exists: a first import can take many minutes, so it isn't done before a reply), and it isn't open.
function checkLine({ dir }) {
  const ed = editorFor(dir);
  if (!ed.exe || !fs.existsSync(path.join(dir, 'Library')) || openInEditor(dir)) return null;
  return `${q(ed.exe)} -batchmode -nographics -quit -projectPath ${q(dir)} -logFile -`;
}

/** Compiler errors from a Unity log, as 'Assets/Player.cs:12: error CS0103: …', each once. */
export function parseUnity(out) {
  const res = new Set();
  for (const m of String(out || '').matchAll(/^\s*(.+?\.cs)\((\d+),\d+\): error (CS\d{4}): (.+?)\s*$/gm)) res.add(`${m[1].replace(/\\/g, '/')}:${m[2]}: error ${m[3]}: ${m[4]}`);
  return [...res];
}

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
/**
 * The NUnit 3 XML that -runTests writes, in a few lines: the totals, then each failed test with its message and the
 * first line of its stack that is in the project (Assets/ or Packages/).
 */
export function summarizeTestResults(xml) {
  const run = /<test-run\b[^>]*>/.exec(xml)?.[0];
  if (!run) return 'No test results in this file (did the run finish? Look at the log for compile errors first).';
  const n = (k) => Number(attr(run, k) || 0);
  const lines = [`${n('total')} tests: ${n('passed')} passed, ${n('failed')} failed, ${n('skipped') + n('inconclusive')} skipped (${attr(run, 'result') || '?'}).`];
  for (const m of xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)) {
    if (attr(m[1], 'result') !== 'Failed' || !m[2]) continue;
    const msg = unxml(/<message>([\s\S]*?)<\/message>/.exec(m[2])?.[1]).split(/\r?\n/)[0];
    const where = unxml(/<stack-trace>([\s\S]*?)<\/stack-trace>/.exec(m[2])?.[1]).split(/\r?\n/).find((l) => /(Assets|Packages)[\\/].+:\d+/.test(l));
    lines.push(`✗ ${attr(m[1], 'fullname') || attr(m[1], 'name')}: ${msg}${where ? ` (${/((?:Assets|Packages)[\\/][^:)]+:\d+)/.exec(where)[1]})` : ''}`);
  }
  return lines.slice(0, 21).join('\n');
}

/** Where Unity writes its logs: the editor's, and a built game's Player.log for <company>/<product>. */
export function unityLogs(company = '<company>', product = '<product>') {
  const home = os.homedir();
  if (WIN) return { editor: path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Unity', 'Editor', 'Editor.log'), player: path.join(home, 'AppData', 'LocalLow', company, product, 'Player.log') };
  if (MAC) return { editor: path.join(home, 'Library', 'Logs', 'Unity', 'Editor.log'), player: path.join(home, 'Library', 'Logs', company, product, 'Player.log') };
  return { editor: path.join(home, '.config', 'unity3d', 'Editor.log'), player: path.join(home, '.config', 'unity3d', company, product, 'Player.log') };
}

const isProject = (d) => fs.existsSync(path.join(d, 'ProjectSettings', 'ProjectVersion.txt'));

export default {
  id: 'unity',
  label: 'Unity',
  summary: 'Games and apps made with Unity and C#',
  toolchains: [
    { id: 'unityhub', label: 'Unity Hub', for: 'Installing Unity editors and signing in for a license', detect: findHub, winget: 'Unity.UnityHub', url: 'https://unity.com/download' },
    { id: 'unity', label: 'Unity Editor', for: 'Unity projects (each needs the editor version in ProjectSettings/ProjectVersion.txt)', detect: findEditors, url: 'https://unity.com/releases/editor/archive',
      brokenHint: 'Editors are installed from Unity Hub (Installs → Install Editor), one per version; the user signs in there for a license.' },
  ],
  // ProjectSettings/ProjectVersion.txt, at the top or one folder down.
  detect: (root) => isProject(root) || (() => { try { return fs.readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && isProject(path.join(root, e.name))); } catch { return false; } })(),
  checks: [{ id: 'unity', tool: 'unity', ext: /\.cs$/i, marker: isProject, cmd: checkLine, parse: parseUnity, timeout: 420e3 }],
  notes: () => {
    const eds = EDITORS.map((e) => e.version).join(', ');
    const logs = unityLogs();
    return `editors installed: ${eds || 'none'}; a project needs the exact version in ProjectSettings/ProjectVersion.txt (another version means an upgrade: ask the user first). Each editor is <Hub's Editor folder>\\<version>\\Editor\\Unity.exe${EDITORS[0] ? ` (e.g. ${q(EDITORS[0].exe)})` : ''}. `
      + 'Batchmode needs a Unity license (the user signs in to Unity Hub; a Personal license is free)'
      + (licensed() ? '' : ': no license file was found here, so if the log says "No valid Unity Editor license", ask the user to activate one in Unity Hub') + '. '
      + 'The first open of a project imports every asset and can take 10+ minutes: run it as a background job (Unity.exe -batchmode -nographics -quit -projectPath . -logFile import.log) and wait for it. '
      + 'Before the final reply QuorX compiles changed .cs files with -batchmode -quit (only once Library/ exists and the project is not open in the editor: then the editor compiles it itself; read its Editor.log). Errors look like Assets/X.cs(12,5): error CS0103. '
      + 'Tests: Unity.exe -batchmode -nographics -projectPath . -runTests -testPlatform EditMode (or PlayMode) -testResults TestResults.xml -logFile - (no -quit); read the <test-run> totals and each test-case with result="Failed". '
      + 'Build a Windows player with -buildWindows64Player build/Game.exe (with -quit), then run it as a background job; Unity draws its own UI, so drive it with desktop screenshots, clicks at coordinates and keys. '
      + `Logs: the editor's is ${logs.editor}; a game's Player.log is under ${path.dirname(path.dirname(path.dirname(logs.player)))}\\<company>\\<product>. Debug with Debug.Log and those logs: Unity's debugger is not one QuorX's debug tool can drive.`;
  },
  test: { needs: [] }, // the parsers are tested anywhere; the parts that need Unity skip without it
};
