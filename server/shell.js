// Your own terminals: a real shell for each terminal tab in the pane (PowerShell on Windows, your login shell on
// macOS and Linux), started in the project folder. Only your own windows reach it (the harness refuses requests
// from other sites, and pages the agent writes are served sandboxed); the agent never gets it: its run_command keeps
// the allow-list. It is a plain process, not a terminal emulator: commands, pipes, scripts, git and dev servers work;
// full-screen programs (vim, htop, arrow-key menus) need a real terminal app.
// Output goes to the project's terminal feed like any other job, so the Terminal tab shows it as it happens.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { termEvent, lineSplitter, newJob, endJob } from './terminal.js';
import { userEnv } from './userenv.js';

const WIN = process.platform === 'win32';
const SHELLS = new Map(); // `${projectId}:${tab}` → { proc, cwd, job, t0, mark, tab, projectId }
const LAST_CWD = new Map(); // the folder a stopped tab's shell was in, for the next one
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-B]/g;

let picked = null;
// Which shell: PowerShell 7 (pwsh) when installed, else Windows PowerShell; elsewhere $SHELL (bash, zsh…) or sh.
export function shellInfo() {
  if (picked) return picked;
  if (WIN) {
    const pwsh = spawnSync('where', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
    const exe = pwsh.status === 0 && pwsh.stdout.trim() ? pwsh.stdout.trim().split(/\r?\n/)[0] : 'powershell.exe';
    picked = { exe, name: /pwsh/i.test(exe) ? 'PowerShell 7' : 'Windows PowerShell', kind: 'ps', args: ['-NoLogo', '-NoExit', '-Command', '-'] };
  } else {
    const exe = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
    const base = path.basename(exe);
    picked = { exe, name: base, kind: 'sh', args: /^(bash|zsh)$/.test(base) ? ['-l', '-s'] : ['-s'] };
  }
  return picked;
}

// After each command the shell prints a marker line with the exit code and its folder; it never shows.
const markerCmd = (sh, mark) => (sh.kind === 'ps'
  ? `$__s=$?; $__c=$LASTEXITCODE; Write-Output "${mark}|$(if ($__s) {0} elseif ($__c) {$__c} else {1})|$((Get-Location).Path)"`
  : `printf '%s|%s|%s\\n' '${mark}' "$?" "$PWD"`);

function start(projectId, tab, cwd) {
  const sh = shellInfo(), key = `${projectId}:${tab}`;
  const proc = spawn(sh.exe, sh.args, { cwd, env: userEnv(), windowsHide: true, detached: !WIN });
  const s = { proc, cwd, job: null, t0: 0, mark: `@@OH${crypto.randomBytes(6).toString('hex')}`, tab, projectId, sh };
  const onLine = (raw, stream) => {
    const text = raw.replace(ANSI, '').replace(/\r$/, '');
    const at = text.indexOf(s.mark);
    if (at >= 0) {
      if (at > 0) out(s, text.slice(0, at), stream);
      const [, code, dir] = text.slice(at).split('|');
      if (dir) s.cwd = dir.trim();
      finish(s, Number(code) || 0);
      return;
    }
    out(s, text, stream);
  };
  const so = lineSplitter((l) => onLine(l, 'out')), se = lineSplitter((l) => onLine(l, 'err'));
  proc.stdout.on('data', (d) => so.push(d, 'out'));
  proc.stderr.on('data', (d) => se.push(d, 'err'));
  proc.on('error', (e) => { out(s, `Could not start ${sh.name}: ${e.message}`, 'err'); finish(s, 1, e.message); SHELLS.delete(key); });
  proc.on('close', (code) => { so.flush('out'); se.flush('err'); if (s.job) finish(s, code ?? 0, s.stopped ? 'stopped' : 'the shell exited'); if (SHELLS.get(key) === s) SHELLS.delete(key); });
  if (sh.kind === 'ps') proc.stdin.write("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::InputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n");
  SHELLS.set(key, s);
  return s;
}
function out(s, text, stream) {
  if (!s.job) return; // what a shell prints between commands (a profile banner) isn't anyone's output
  termEvent(s.projectId, { kind: 'out', job: s.job, text, stream, source: 'you', tab: s.tab });
}
function finish(s, code, error) {
  if (!s.job) return;
  termEvent(s.projectId, { kind: 'end', job: s.job, code, ms: Date.now() - s.t0, error, cwd: s.cwd, tab: s.tab });
  endJob(s.job); s.job = null;
}

/**
 * Run a line in a tab's shell (started on first use in `cwd`). While a command still runs, the line goes to it as
 * input instead (answers to prompts). Returns { ok, job } or { ok, input: true }.
 */
export function shellRun(projectId, tab, line, cwd) {
  const key = `${projectId}:${tab}`;
  let s = SHELLS.get(key);
  if (s && s.job) { s.proc.stdin.write(`${line}\n`); return { ok: true, input: true, job: s.job }; }
  if (!s) s = start(projectId, tab, LAST_CWD.get(key) || cwd);
  s.t0 = Date.now();
  s.job = newJob(projectId, line, 'you', () => shellStop(projectId, tab));
  termEvent(projectId, { kind: 'start', job: s.job, source: 'you', tab, label: line, cwd: s.cwd, shell: s.sh.name });
  const reset = s.sh.kind === 'ps' ? '$global:LASTEXITCODE=0\n' : '';
  // Windows PowerShell reads piped input in the old code page, so a line with characters outside ASCII is sent
  // encoded and unpacked by PowerShell itself (it still runs in the shell's own scope: cd and variables stay).
  const cmd = s.sh.kind === 'ps' && /[^\x00-\x7f]/.test(line) ? `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(line, 'utf8').toString('base64')}')))` : line;
  s.proc.stdin.write(`${reset}${cmd}\n${markerCmd(s.sh, s.mark)}\n`);
  return { ok: true, job: s.job };
}

// ■ Stop: there is no Ctrl+C without a terminal, so the shell and everything it started are ended. The next
// command starts a fresh shell in the same folder.
export function shellStop(projectId, tab) {
  const key = `${projectId}:${tab}`, s = SHELLS.get(key);
  if (!s) return false;
  s.stopped = true;
  SHELLS.delete(key);
  const keep = s.cwd;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-s.proc.pid, 'SIGKILL');
  } catch { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } }
  // Remember the folder for the next shell in this tab.
  LAST_CWD.set(key, keep);
  return true;
}

// A closed terminal tab ends its shell.
export function shellClose(projectId, tab) { const had = shellStop(projectId, tab); LAST_CWD.delete(`${projectId}:${tab}`); return had; }

// The harness stopping ends every shell it started.
process.once('exit', () => {
  for (const [k, s] of SHELLS) {
    try { if (WIN) spawnSync('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-s.proc.pid, 'SIGKILL'); } catch { /* gone */ }
    SHELLS.delete(k);
  }
});
