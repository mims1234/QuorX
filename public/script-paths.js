// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The files a command line runs, so the page can make their names clickable: a script handed to an interpreter
// (node scripts/build.mjs, python tools/x.py, powershell -File setup.ps1, bash run.sh), a script run by its own name
// (./run.sh, .\setup.ps1, tools\make.bat), the package.json behind npm run <name>, and any other word that names a
// script file. Pure: it only reads the text. The server checks each path again when it is opened (GET /api/script-file).

/** File endings that hold code a command can run. */
export const SCRIPT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'py', 'pyw', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'fish',
  'bat', 'cmd', 'vbs', 'wsf', 'rb', 'pl', 'php', 'lua', 'r', 'jl', 'go', 'rs', 'java', 'kts', 'groovy', 'swift', 'dart', 'ex', 'exs', 'nu', 'awk', 'sql', 'mk']);

// Programs that run a script file they are handed. stop: options after which the code is inline (or a module name),
// so no file follows. value: options that take a value (a file named there is linked too). file: the option that
// names the script (powershell -File). sub: options after which the rest is a command line of its own (cmd /c).
const NODE = { stop: ['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help'], value: ['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--inspect-port', '--conditions', '-C', '--title', '--max-old-space-size'] };
const PY = { stop: ['-c', '-m', '-V', '--version', '-h', '--help'], value: ['-W', '-X', '--check-hash-based-pycs'] };
const PS = { stop: ['-command', '-c', '-encodedcommand', '-ec', '-e', '-version', '-help', '-?'], value: ['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-configurationname', '-workingdirectory', '-wd', '-inputformat', '-outputformat', '-psconsolefile', '-settingsfile'], file: ['-file', '-f'] };
const SH = { stop: ['-c', '--version', '--help'], value: ['-o', '+o', '--rcfile', '--init-file'] };
export const INTERPRETERS = {
  node: NODE, nodejs: NODE, bun: NODE, deno: { stop: ['eval', 'repl', '--version'], value: ['--config', '-c', '--import-map'], skip: ['run', 'test', 'bench', 'check'] },
  tsx: NODE, 'ts-node': NODE, 'ts-node-esm': NODE, esno: NODE, 'vite-node': NODE,
  python: PY, python3: PY, python2: PY, py: { ...PY, value: [...PY.value] }, pythonw: PY, pypy: PY, pypy3: PY, uv: { stop: ['pip', 'add', 'sync', 'lock', 'venv', 'init', '--version'], value: ['--with', '--python', '-p'], skip: ['run'] },
  powershell: PS, pwsh: PS,
  bash: SH, sh: SH, zsh: SH, dash: SH, ksh: SH, fish: SH,
  ruby: { stop: ['-e', '--version'], value: ['-r', '-I'] }, perl: { stop: ['-e', '-E', '-v'], value: ['-I', '-M', '-m'] }, php: { stop: ['-r', '-v', '-a'], value: ['-c', '-d'] },
  lua: { stop: ['-e', '-v'], value: ['-l'] }, rscript: { stop: ['-e', '--version'], value: [] }, julia: { stop: ['-e', '--eval', '-v'], value: ['--project', '-L'] },
  cscript: { stop: [], value: [] }, wscript: { stop: [], value: [] }, 'go': { stop: ['build', 'test', 'mod', 'get', 'install', 'version', 'vet', 'fmt'], value: [], skip: ['run'] },
  cmd: { stop: [], value: [], sub: ['/c', '/k', '/s/c'] },
};
// Words before the program that leave it the program (sudo node x.js, npx tsx x.ts, call x.bat).
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'npx', 'pnpx', 'bunx', 'exec', 'call', 'command', 'start-process', 'xargs']);
// Package managers whose run <name> runs a line from package.json.
const RUNNERS = { npm: ['run', 'run-script', 'test', 't', 'start', 'stop', 'restart'], pnpm: ['run', 'test', 'start'], yarn: ['run', 'test', 'start'], bun: ['run'] };
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);

const ext = (p) => String(p).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
const progOf = (w) => String(w).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
const isAbs = (p) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('/') || p.startsWith('\\');
const isUrl = (p) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
const hasSlash = (p) => /[\\/]/.test(p);
/** Whether a word reads as a path to a script file (not a URL, glob, option or variable). */
export function looksScript(w, { loose = false } = {}) {
  const s = String(w || '');
  if (!s || s.length > 400 || isUrl(s) || /[*?<>|$%`{}]/.test(s) || (/^-/.test(s) && !hasSlash(s)) || /^\/[a-z?]{1,3}$/i.test(s) || /^[a-z]:$/i.test(s)) return false;
  if (SCRIPT_EXT.has(ext(s))) return true;
  return loose && hasSlash(s) && !/[\\/]$/.test(s) && /[a-z0-9_]/i.test(s.replace(/^[a-z]:/i, ''));
}
/** A path made plain: forward slashes, no ./ or .\ in front, a/../b folded, and joined to `cwd` when relative. */
export function cleanPath(p, cwd = '') {
  let s = String(p).replace(/\\/g, '/');
  if (!isAbs(s) && cwd) s = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${s}`;
  const abs = isAbs(s), drive = s.match(/^[a-z]:/i)?.[0] || '';
  const out = [];
  for (const part of s.slice(drive.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length && out.at(-1) !== '..') out.pop(); else out.push(part);
  }
  const body = out.join('/');
  return drive ? `${drive}/${body}` : abs ? `/${body}` : body || '.';
}

// Words of a line with where each sits: { text (quotes taken off), start, end (of the text without its quotes) }, and
// the breaks between commands (&&, ||, ;, |, &, a line break) as { sep: true }.
function words(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') { out.push({ sep: true }); i += line[i + 1] === ch ? 2 : 1; continue; }
    if (ch === '(' || ch === ')') { out.push({ sep: true }); i++; continue; }
    // One word: runs of plain characters and quoted pieces, until a space or a break.
    let text = '', start = -1, end = -1;
    while (i < n && !/[\s;|&()]/.test(line[i])) {
      const q = line[i];
      if (q === '"' || q === "'") {
        const close = line.indexOf(q, i + 1);
        const stop = close < 0 ? n : close;
        if (start < 0) start = i + 1;
        text += line.slice(i + 1, stop); end = stop; i = close < 0 ? n : close + 1;
        continue;
      }
      if (start < 0) start = i;
      text += q; end = i + 1; i++;
    }
    if (start < 0) { i++; continue; }
    out.push({ text, start, end });
  }
  return out;
}

/**
 * The files `line` runs or names: [{ path, start, end, why, label? }], in order. `start`/`end` point at the name in
 * the line (to make it a link); `path` is the file relative to the folder the command runs in (or a full path), with a
 * `cd` earlier in the line (and `cwd`, the subfolder the command starts in) taken into account. why: 'interpreter' | 'direct' | 'package' | 'named'.
 */
export function scriptPaths(line, { cwd: from = '' } = {}) {
  const text = String(line || '');
  if (!text.trim() || text.length > 20000) return [];
  const all = words(text), found = [], taken = new Set();
  let cwd = from ? cleanPath(from) : '';
  const add = (w, why, path = cleanPath(w.text, cwd), label) => {
    if (taken.has(w.start)) return;
    taken.add(w.start);
    found.push({ path, start: w.start, end: w.end, why, ...(label ? { label } : {}) });
  };
  // Commands one at a time; each is the words between two breaks.
  const segs = [[]];
  for (const w of all) { if (w.sep) segs.push([]); else segs.at(-1).push(w); }
  const doSeg = (seg) => {
    let k = 0;
    while (k < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k].text) || WRAPPERS.has(progOf(seg[k].text)) || /^-/.test(seg[k].text) && k > 0 && WRAPPERS.has(progOf(seg[k - 1].text)))) k++;
    const w0 = seg[k];
    if (!w0) return;
    // A script named by its path is the script, even when its name is a program's (C:\x\go.cmd is not go; npm.cmd is npm).
    const prog = looksScript(w0.text) && (hasSlash(w0.text) || !/\.(cmd|bat)$/i.test(w0.text)) ? '' : progOf(w0.text);
    if (CD.has(prog)) { const d = seg.slice(k + 1).find((w) => !/^-/.test(w.text)); if (d && !/[$%~]/.test(d.text)) cwd = cleanPath(d.text, cwd); return; }
    const runner = RUNNERS[prog];
    if (runner) {
      const rest = seg.slice(k + 1).filter((w) => !/^-/.test(w.text));
      const verb = rest[0]?.text.toLowerCase();
      if (verb && runner.includes(verb)) {
        const name = ['run', 'run-script'].includes(verb) ? rest[1] : rest[0];
        if (prog === 'bun' && name && looksScript(name.text, { loose: true })) { add(name, 'interpreter'); return named(seg, seg.indexOf(name) + 1); }
        if (name) add(name, 'package', cleanPath('package.json', cwd), `the "${['run', 'run-script'].includes(verb) ? name.text : verb === 't' ? 'test' : verb}" line in package.json`);
        return;
      }
      if (prog !== 'bun') return;
    }
    const spec = INTERPRETERS[prog];
    if (spec) {
      let j = k + 1;
      const low = (w) => w.text.toLowerCase();
      if (spec.skip && seg[j] && spec.skip.includes(low(seg[j]))) j++;
      for (; j < seg.length; j++) {
        const w = seg[j], t = low(w);
        if (spec.sub?.includes(t)) return doSeg(seg.slice(j + 1));
        if (spec.stop.includes(t)) return;
        if (spec.file?.includes(t)) { if (seg[j + 1] && looksScript(seg[j + 1].text, { loose: true })) add(seg[j + 1], 'interpreter'); return named(seg, j + 2); }
        if (spec.value.includes(t)) { if (seg[j + 1] && looksScript(seg[j + 1].text)) add(seg[j + 1], 'named'); j++; continue; }
        if (/^--?[a-z0-9]/i.test(w.text) || /^\/[a-z]$/i.test(w.text) || /^[+-][a-z]+$/i.test(w.text)) continue;
        if (looksScript(w.text, { loose: true })) add(w, 'interpreter');
        return named(seg, j + 1);
      }
      return;
    }
    // A script run by its own name: ./run.sh, .\setup.ps1, tools\make.bat, C:\x\y.cmd.
    if (looksScript(w0.text) || (/^\.{1,2}[\\/]/.test(w0.text) && looksScript(w0.text, { loose: true }))) add(w0, 'direct');
    named(seg, k + 1);
  };
  // Any other word of the command that names a script file (cat x.py, Get-Content a.ps1, node a.js b.js).
  const named = (seg, from) => { for (const w of seg.slice(from)) if (looksScript(w.text) && !/^-/.test(w.text)) add(w, 'named'); };
  for (const seg of segs) doSeg(seg);
  return found.sort((a, b) => a.start - b.start);
}
