// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Python: scripts, command-line tools, services and desktop apps (tkinter, PyQt, PySide).
// A project's own virtual environment (.venv, venv) is used for everything when it has one: the compiler check, the
// debugger, and the commands the notes give the agent. Debugging goes through debugpy, over the Debug Adapter Protocol.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WIN, hasFile } from './_lib.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
const SYSTEM = WIN ? 'py -3' : 'python3';
const VENV_PY = WIN ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'; // a new venv's interpreter
const CHECKER = fileURLToPath(new URL('./_pycheck.py', import.meta.url));

/** The project's virtual environment in `dir`: { name: '.venv', python: '.venv\\Scripts\\python.exe', version }, or null. */
export function venvOf(dir) {
  if (!dir) return null;
  for (const name of ['.venv', 'venv', 'env']) {
    const python = WIN ? path.join(name, 'Scripts', 'python.exe') : path.join(name, 'bin', 'python');
    let cfg;
    try { cfg = fs.readFileSync(path.join(dir, name, 'pyvenv.cfg'), 'utf8'); } catch { continue; }
    if (fs.existsSync(path.join(dir, python))) return { name, python, version: /^version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/m.exec(cfg)?.[1] || null };
  }
  return null;
}

/** The Python to run the project with: its venv's interpreter (relative to `dir`), or the system's. { line, venv }. */
export const interpreter = (dir) => { const v = venvOf(dir); return { line: v ? quote(v.python) : SYSTEM, venv: v }; };

// Which of these modules an interpreter can import, checked once a minute at most (the agent may install one mid-chat).
const MODULES = ['pytest', 'debugpy', 'pyflakes', 'tkinter', 'PyQt6', 'PySide6', 'PyQt5', 'PySide2'];
const seen = new Map();
export function modulesOf(dir) {
  const { line, venv } = interpreter(dir);
  const key = venv ? path.resolve(dir, venv.python) : line;
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.mods;
  const [exe, ...pre] = venv ? [key] : SYSTEM.split(' ');
  const r = spawnSync(exe, [...pre, '-I', '-c', `import importlib.util as u;print(",".join(m for m in ${JSON.stringify(MODULES)} if u.find_spec(m)))`], { encoding: 'utf8', timeout: 8000, windowsHide: true, cwd: dir || undefined });
  const mods = new Set(r.status === 0 ? r.stdout.trim().split(',').filter(Boolean) : []);
  seen.set(key, { at: Date.now(), mods });
  return mods;
}

/** What to tell the agent when debugpy is missing: the exact install, into the project's venv (never the whole computer). */
export function debugpyMissing(dir) {
  const { line, venv } = interpreter(dir);
  return venv
    ? `debugpy is not installed in this project's virtual environment (${venv.name}). Install it there with: ${line} -m pip install debugpy (a project install), then start the debugger again.`
    : `debugpy is not installed, and this project has no virtual environment. Make one and install it there: ${SYSTEM} -m venv .venv, then ${VENV_PY} -m pip install debugpy (plus the project's own packages); the debugger then uses .venv by itself. Don't install it into the system's Python.`;
}

// The folder the compiler check runs in: one with its own interpreter (a venv) or a linter set up. Syntax in loose
// files is already checked file by file as the agent writes them (checks.js), with the system's Python.
const hasRuffConfig = (d) => hasFile(d, /^\.?ruff\.toml$/) || (() => { try { return fs.readFileSync(path.join(d, 'pyproject.toml'), 'utf8').includes('[tool.ruff'); } catch { return false; } })();

/** pytest's output in a few lines: the counts, then each failure (test, error). '' when it isn't pytest's output. */
export function pytestSummary(out) {
  const text = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  const tail = [...text.matchAll(/^=*\s*((?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?|deselected|rerun)(?:, )?)+)(?: in ([\d.]+s))?.*?=*\s*$/gm)].at(-1);
  const none = /^=*\s*no tests ran( in [\d.]+s)?/m.test(text);
  if (!tail && !none) return '';
  const counts = tail ? tail[1].replace(/,\s*$/, '') : 'no tests ran';
  // Each failure's section ("____ test_name ____", "____ ERROR collecting path ____"): its first "E " line (the
  // error) and the last file:line in its traceback (where it was raised).
  const parts = text.split(/^_{3,} (.+?) _{3,}$/m), secs = [];
  for (let i = 1; i < parts.length; i += 2) {
    const e = /^E\s+(\S.*)$/m.exec(parts[i + 1])?.[1].trim() || '';
    const at = [...parts[i + 1].matchAll(/^(\S+\.pyw?):(\d+):/gm)].at(-1);
    secs.push({ name: parts[i].trim(), e, at: at ? `${at[1]}:${at[2]}` : '' });
  }
  const clip = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
  // The short test summary (-r, on by default for failures since pytest 6): "FAILED path::test - Error: message".
  let fails = [...text.matchAll(/^(FAILED|ERROR) (\S+)(?: - (.*))?$/gm)].map(([, kind, id, msg]) => {
    const sec = secs.find((s) => s.name === `ERROR collecting ${id}` || s.name.replace(/\./g, '::') === id.split('::').slice(1).join('::'));
    return `${kind} ${id}${kind === 'ERROR' && sec?.name.startsWith('ERROR collecting') ? ' (it could not be imported)' : ''}${msg || sec?.e ? ` - ${clip(msg || sec.e)}` : ''}`;
  });
  // No summary section (-rN, or an old pytest): the sections themselves.
  if (!fails.length) fails = secs.map((s) => `${s.name.startsWith('ERROR collecting') ? s.name : `FAILED ${s.name}`}${s.at ? ` (${s.at})` : ''}${s.e ? ` - ${clip(s.e)}` : ''}`);
  return [`pytest: ${counts}${tail?.[2] ? ` (${tail[2]})` : ''}`, ...fails.slice(0, 12), ...(fails.length > 12 ? [`… and ${fails.length - 12} more`] : [])].join('\n');
}

function notes(have, root) {
  const { line: py, venv } = interpreter(root);
  const mods = root ? modulesOf(root) : new Set();
  const gui = ['PyQt6', 'PySide6', 'PyQt5', 'PySide2'].filter((m) => mods.has(m));
  return [
    venv
      ? `The project has its own virtual environment (${venv.name}${venv.version ? `, Python ${venv.version}` : ''}): use its interpreter for everything (${py} app.py, ${py} -m pytest, ${py} -m pip install <package>, which installs into this project only). Call it directly; don't activate the venv or use the system's Python.`
      : `No virtual environment: run with ${SYSTEM} <file>. Before installing packages, make one (${SYSTEM} -m venv .venv) and use ${VENV_PY} from then on; pip into the system's Python changes it for the whole computer.`,
    `Tests: ${py} -m pytest -q --tb=short; its last lines name each failed test and its error${mods.has('pytest') || !root ? '' : ` (pytest is not installed: ${venv ? `${py} -m pip install pytest` : 'make a venv and install it there'})`}.`,
    'For a crash, read the traceback from the bottom: the last line is the error, the nearest "File" line in this project is where.',
    `A window app: start it with shell and background: true, then use the desktop tool on that job. PyQt and PySide controls read by name${gui.length ? ` (installed: ${gui.join(', ')})` : ''}. tkinter shows only the title and its tk buttons, check and radio buttons, unnamed, with their @x,y (labels, entries and ttk widgets are invisible): click buttons by ref in the order they sit, click_at a field then send keys to type, and check results with a screenshot plus decide, the title, or lines the app prints (job_output).`,
    `The debugger runs a .py file under debugpy with ${py}${mods.has('debugpy') || !root ? '' : ` (debugpy is not installed: ${venv ? `${py} -m pip install debugpy` : 'make a venv and install it there'})`}. For a window: break in the handler, continue (the window opens), and click its button with the desktop tool on the job debug start named; it tells you when the app stopped, then use state and eval, and continue to let it run on (a paused window can't be read or clicked).`,
  ].join(' ');
}

export default {
  id: 'python',
  label: 'Python',
  summary: 'Scripts, command-line tools, services and desktop apps (tkinter, PyQt, PySide)',
  toolchains: [{ id: 'python', label: 'Python 3', for: 'Python scripts and desktop apps (tkinter, PyQt)', probe: [WIN ? 'py' : 'python3', WIN ? ['-3', '--version'] : ['--version']], re: /Python (3\.\d+\.\d+)/, winget: 'Python.Python.3.12', brew: 'python', apt: 'python3' }],
  markers: [/^pyproject\.toml$/, /^requirements[\w.-]*\.txt$/, /^setup\.(py|cfg)$/, /^Pipfile$/, /^(uv|poetry)\.lock$/, /^\.?venv$/, /\.pyw?$/i],
  // Syntax as the project's own Python sees it, plus ruff or pyflakes when the project has them (_pycheck.py).
  checks: [{ id: 'python', tool: 'python', ext: /\.pyw?$/i, marker: (d) => !!venvOf(d) || hasRuffConfig(d), cmd: `${SYSTEM} -I ${quote(CHECKER)}`, errors: /\.pyw?:\d+: / }],
  debug: {
    exts: ['.py', '.pyw'], tool: 'python', label: 'Python (debugpy)',
    gate: ({ file, args = [], cwd, python }) => [python || interpreter(cwd).line, ...[file, ...args].map(quote)].join(' '),
    // debugpy waits for the debugger before running a line; QuorX attaches over DAP. `python` overrides (tests).
    start: ({ file, args = [], cwd, port, python }) => {
      if (!python && !modulesOf(cwd).has('debugpy')) throw new Error(debugpyMissing(cwd));
      return {
        line: `${python || interpreter(cwd).line} -m debugpy --listen 127.0.0.1:${port} --wait-for-client ${[file, ...args].map(quote).join(' ')}`,
        adapterID: 'python', request: 'attach', args: { justMyCode: true },
        missing: 'debugpy did not open its port: read the job\'s output for the error',
      };
    },
  },
  // pytest's result, put above a shell command's output (the summaries hook in server/packs/index.js).
  summaries: [{ cmd: /(^|[\s\\/])(pytest|py\.test)(\.exe)?(\s|$)|\s-m\s+pytest\b/i, summarize: pytestSummary }],
  notes,
  test: { needs: ['python'] },
};
