// Project folders, commands and dev servers for the agent.
// A project is one folder shared by all its chats (workspaces/<project> or a folder the user chose).
// Paths can't leave it, commands
// are limited to a list of developer programs with no shell metacharacters, and child processes get
// an environment with API keys and tokens removed.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { projectDir, listProjects } from './store.js';
import { SECRET_FILES } from './keys.js';
import { projectEnv } from './projectsecrets.js';
import { termEvent, lineSplitter, newJob, endJob } from './terminal.js';
import { jobsAvailable, adoptPid, jobCount, killJob, closeJob, startDetached } from './jobhost.js';
import { snapshot, changesSince, objectFor, pruneObjects } from './snapshot.js';
import { freshPath } from './userenv.js';

// The usual programs a server or launch config starts with. Every start, these included, is judged by the command
// engine first (agent.js start_server); here it only has to be one plain program name or path.
export const ALLOWED = ['node', 'npm', 'npx', 'python', 'python3', 'py', 'pip', 'pip3', 'deno', 'bun', 'pnpm', 'yarn', 'uv'];
const PROGRAM = /^[\w.\-\\/:@+]+$/;
const BAD = /[&|<>^%`$;"'\r\n(){}!]/;
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', 'dist', '.cache', '.quorx', '.openharness']); // .openharness: the folder's old name, until it moves

// The project's folder. Its .openharness (or harness-made .agent) folder from before the rename becomes .quorx on first use.
const migrated = new Set();
export const workspaceDir = (projectId) => {
  const root = projectDir(projectId);
  if (!migrated.has(root)) {
    // A failed move must never lock the user out of the project: say why once, and use the folder as it is.
    try { if (migrateAgentDir(root) !== 'busy') migrated.add(root); } catch (e) { migrated.add(root); console.error(`QuorX couldn't move the old working folder in ${root}: ${e.message}`); }
  }
  return root;
};

// The real location of a path that may not exist yet: its deepest existing folder resolved through links (and
// Windows short names), plus the rest as written.
export function realish(p) {
  let head = p, tail = '';
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) break;
    tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
    head = up;
  }
  return p;
}
const SECRET_REAL = () => SECRET_FILES.map((f) => realish(f).toLowerCase());
export function safePath(root, rel) {
  const r = String(rel || '').replace(/^[/\\]+/, '');
  // Windows: "file.txt:stream" (an alternate data stream) or a device name would get around the checks below.
  // (An absolute path with its drive letter, inside the project, is fine.)
  if (process.platform === 'win32' && /:|(^|[/\\])(con|prn|aux|nul|com\d|lpt\d)(\.[^/\\]*)?$/i.test(r.replace(/^[a-z]:(?=[/\\])/i, ''))) throw new Error('that path is not allowed (no ":" or device names)');
  const p = path.resolve(root, r);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('that path is outside the project folder');
  // A link inside the project that points outside it is outside too.
  const realRoot = realish(root), real = realish(p);
  const within = (a, b) => (process.platform === 'win32' ? a.toLowerCase() : a) === (process.platform === 'win32' ? b.toLowerCase() : b) || (process.platform === 'win32' ? a.toLowerCase().startsWith(b.toLowerCase() + path.sep) : a.startsWith(b + path.sep));
  if (!within(real, realRoot)) throw new Error('that path leads outside the project folder (through a link)');
  // A project may point at any folder, even the harness itself: its secrets stay unreadable.
  if (SECRET_REAL().includes(real.toLowerCase()) || SECRET_FILES.some((f) => p.toLowerCase() === f.toLowerCase())) throw new Error('that file holds API keys and is off limits');
  return p;
}

// Inside .quorx only what the agent (and you) work with is listed; the harness's own records are not.
const AGENT_VISIBLE = new Set(['scratch', 'skills', 'launch.json', 'serve.mjs']);
// A folder inside this project that is a project of its own (it has a .quorx folder, or another project points
// at it) is listed once and not entered, so its files don't fill this project's prompts and searches.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
function otherProjectDirs(root) {
  try { return new Set(listProjects().map((p) => norm(p.dir)).filter((d) => d !== norm(root))); } catch { return new Set(); }
}
const isOtherProject = (dir, others) => others.has(norm(dir)) || fs.existsSync(path.join(dir, '.quorx')) || fs.existsSync(path.join(dir, '.openharness'));
export const SKIPPED = /\((another project, )?skipped\)$/;
// match (optional): only paths it says yes to (the pickers' search); until (optional): stop at this time, with what
// was found so far (a huge project never holds a search up).
export function listFiles(root, max = 300, { match = null, until = 0 } = {}) {
  const out = [];
  const others = otherProjectDirs(root);
  // .quorx is listed last, so a full scratch folder never pushes the project's own files out of the list.
  let agentDir = null;
  const add = (rel, size) => { if (!match || match(rel.toLowerCase())) out.push({ path: rel, size: size() }); };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max || (until && Date.now() > until)) return;
      if (e.name === '.quorx' && dir === root && e.isDirectory()) { agentDir = path.join(dir, e.name); continue; }
      if (e.isSymbolicLink()) continue; // a link can lead outside the project
      if (SKIP.has(e.name)) { if (!match) out.push({ path: path.relative(root, path.join(dir, e.name)).replaceAll('\\', '/') + '/ (skipped)', size: 0 }); continue; }
      const p = path.join(dir, e.name);
      if (e.isDirectory() && isOtherProject(p, others)) { if (!match) out.push({ path: path.relative(root, p).replaceAll('\\', '/') + '/ (another project, skipped)', size: 0 }); continue; }
      if (e.isDirectory()) walk(p);
      else add(path.relative(root, p).replaceAll('\\', '/'), () => fs.statSync(p).size);
    }
  };
  if (fs.existsSync(root)) walk(root);
  if (agentDir) {
    for (const k of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (out.length >= max) break;
      if (!AGENT_VISIBLE.has(k.name)) continue;
      const p = path.join(agentDir, k.name);
      if (k.isDirectory()) walk(p); else add(path.relative(root, p).replaceAll('\\', '/'), () => fs.statSync(p).size);
    }
  }
  return out;
}

/**
 * One folder of a project, for the Files pane (it reads a folder when you open it): folders first, then files, by
 * name; `limit` entries from `offset`. Same rules as listFiles: no links, node_modules and the like are listed but not
 * entered, a folder that is a project of its own is marked, and inside .quorx only what the agent works with shows.
 * → { path, total, offset, entries: [{ name, dir, size?, count?, skipped? }] }
 */
export async function listDir(root, rel = '', { offset = 0, limit = 500 } = {}) {
  const dir = rel ? safePath(root, rel) : root;
  const atRoot = path.resolve(dir) === path.resolve(root), inAgent = path.resolve(dir) === path.resolve(root, AGENT_DIR);
  const others = otherProjectDirs(root);
  let list = await fs.promises.readdir(dir, { withFileTypes: true });
  list = list.filter((e) => !e.isSymbolicLink() && (!inAgent || AGENT_VISIBLE.has(e.name)));
  // Folders first, then files; by name, numbers in order (file2 before file10). .quorx goes after the project's own folders.
  const rank = (e) => (e.isDirectory() ? (atRoot && e.name === AGENT_DIR ? 1 : 0) : 2);
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const page = list.slice(offset, offset + limit);
  const entries = await Promise.all(page.map(async (e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) && !(atRoot && e.name === AGENT_DIR)) return { name: e.name, dir: true, skipped: 'skipped' };
      if (isOtherProject(p, others)) return { name: e.name, dir: true, skipped: 'project' };
      // How many entries it holds, when that is quick to know (a huge folder just shows none).
      // (.quorx counts only what it lists: the agent's own files.)
      const agent = atRoot && e.name === AGENT_DIR;
      let count; try { const h = await fs.promises.opendir(p); let n = 0; for await (const k of h) { if (agent && !AGENT_VISIBLE.has(k.name)) continue; if (++n > 999) break; } count = n > 999 ? undefined : n; } catch { /* unreadable */ }
      return { name: e.name, dir: true, count };
    }
    let size = 0; try { size = (await fs.promises.stat(p)).size; } catch { /* gone */ }
    return { name: e.name, dir: false, size };
  }));
  return { path: rel, total: list.length, offset, entries };
}

export function writeFile(root, rel, content) {
  const p = safePath(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content ?? ''));
  return fs.statSync(p).size;
}

export function appendFile(root, rel, content) {
  const p = safePath(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, String(content ?? ''));
  return fs.statSync(p).size;
}

export function readFile(root, rel, max = 60000) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p)) throw new Error(`no file ${rel}`);
  const s = fs.readFileSync(p, 'utf8');
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

// The whole text of a file, for read_file's numbered windows (binary or huge files are refused).
export function readText(root, rel) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`no file ${rel}`);
  if (fs.statSync(p).size > 5e6) throw new Error(`${rel} is over 5 MB; search it with search_files instead`);
  const s = fs.readFileSync(p, 'utf8');
  if (s.includes('\u0000')) throw new Error(`${rel} is a binary file`);
  return s;
}

// Several exact replacements in one file, all or none: if any edit fails, the file is left as it was.
export function editFileMulti(root, rel, edits) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p)) throw new Error(`no file ${rel}`);
  let s = fs.readFileSync(p, 'utf8'), total = 0;
  for (const [i, e] of edits.slice(0, 20).entries()) {
    const find = String(e?.find ?? ''), replace = String(e?.replace ?? '');
    const count = find ? s.split(find).length - 1 : 0;
    const where = `edit ${i + 1} of ${edits.length}`;
    if (!count) throw new Error(`${where}: find text not found (no edits were applied); read the file to see its exact current contents`);
    if (count > 1 && !e.replace_all) throw new Error(`${where}: find text matches ${count} times (no edits were applied); add more surrounding text or set replace_all`);
    s = e.replace_all ? s.split(find).join(replace) : s.replace(find, () => replace);
    total += count;
  }
  fs.writeFileSync(p, s);
  return total;
}

export function editFile(root, rel, find, replace, all = false) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p)) throw new Error(`no file ${rel}`);
  const s = fs.readFileSync(p, 'utf8');
  const count = s.split(find).length - 1;
  if (!find || !count) throw new Error('find text not found; read the file to see its exact current contents');
  if (count > 1 && !all) throw new Error(`find text matches ${count} times; add more surrounding text or set replace_all`);
  fs.writeFileSync(p, all ? s.split(find).join(replace) : s.replace(find, () => replace));
  return count;
}

// ---------- commands ----------
// {PORT} in a server's arguments is the harness's own placeholder (replaced by the port before anything runs), so
// its braces are not "brackets" here.
export const preApproved = (cmd) => ALLOWED.includes(String(cmd || '').trim().toLowerCase().replace(/\.(exe|cmd|bat)$/, ''));
export function checkCommand(cmd, args) {
  const exe = String(cmd || '').trim().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  // A whole command line in `command` ("node hub/server.mjs"): the program is fine, the arguments belong in args.
  const [first, ...rest] = String(cmd || '').trim().split(/\s+/);
  if (rest.length && PROGRAM.test(first)) {
    throw new Error(`command must be the program alone: use command "${first}" with args ${JSON.stringify([...rest, ...args])}`);
  }
  if (!exe || !PROGRAM.test(exe)) throw new Error(`"${cmd}" is not allowed: command must be one program name or path, with its arguments in args`);
  for (const a of args) if (BAD.test(String(a).replaceAll('{PORT}', '0'))) throw new Error(`argument "${a}" contains characters that are not allowed (& | < > ^ % \` $ ; quotes, brackets, !)`);
  return exe;
}

// No pager, editor or terminal prompt for the agent's commands and terminals: a read-only command (git log, git diff,
// man) would otherwise open less or vim, and those take commands of their own from whatever is typed next. Output goes
// straight through (cat); git's editor is `true`, which git runs through its own sh on Windows too, so a merge, an
// amend or a rebase keeps the text git wrote and a commit without -m stops for want of a message; git never waits for
// a password at the terminal; and less, if it is started anyway, can't run commands (LESSSECURE). EDITOR and VISUAL
// are the same `true`: a program that opens one either finds nothing to open or carries on unchanged.
export const NO_PAGER_ENV = { PAGER: 'cat', GIT_PAGER: 'cat', MANPAGER: 'cat', SYSTEMD_PAGER: 'cat', LESSSECURE: '1',
  GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', EDITOR: 'true', VISUAL: 'true', GIT_TERMINAL_PROMPT: '0' };

// No secrets for code the agent wrote: drop anything that looks like a key, token or password. PATH is brought up to
// date (userenv.js), so a tool installed during the chat is found at once. NO_PAGER_ENV comes last, so a project's
// own variables can't bring a pager back.
export function childEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSW|PASSPHRASE|PWD_|OPENROUTER|CREDENTIAL|AUTH|COOKIE|SESSION_?(TOKEN|KEY|SECRET|ID$)|_PAT$|PRIVATE|DSN|DATABASE_URL|_URI$|CONNECTION_STRING|WEBHOOK|SSH_AUTH_SOCK|GPG_AGENT|CLIENT_ID|CLIENT_SECRET/i.test(k) || k === 'PWD' || k === 'OLDPWD'));
  return { ...freshPath(env), ...extra, FORCE_COLOR: '0', BROWSER: 'none', ...NO_PAGER_ENV };
}

// The command line for one program and its plain arguments.
export const lineOf = (cmd, args) => [checkCommand(cmd, args), ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');

// Every command and server starts through jobgate.cjs, is put in its own Windows job (jobhost.js; on macOS and
// Linux its own process group), and only then starts running, so nothing it starts can escape Stop. `shell`: direct (Node's default shell), powershell, pwsh,
// cmd or bash. Without the job host the process still runs, with proc.qxJob unset ("basic" Stop).
const GATE = fileURLToPath(new URL('./jobgate.cjs', import.meta.url));
async function launch(root, line, { shell = 'direct', env, memoryMB = 0, signal } = {}) {
  const proc = spawn(process.execPath, [GATE, shell, line], { cwd: root, env: childEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: startDetached });
  proc.stdin.on('error', () => { /* the gate is gone */ });
  if (proc.pid) {
    const job = `c${proc.pid}x${Date.now().toString(36)}`;
    try { if (await jobsAvailable()) { await adoptPid(job, proc.pid, memoryMB); proc.qxJob = job; } } catch { /* basic Stop */ }
  }
  // Stop pressed while the job was being set up: the gate is never told to go, so the command never starts
  // (runLine then ends the gate the usual way).
  if (!signal?.aborted) proc.stdin.end('go\n');
  return proc;
}

const exited = (proc, ms) => (proc.exitCode != null || proc.signalCode != null ? Promise.resolve() : new Promise((r) => { const t = setTimeout(r, ms); proc.once('exit', () => { clearTimeout(t); r(); }); }));
function taskkillTree(pid) {
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } return Promise.resolve(); }
  return new Promise((r) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));
}
/**
 * Ends a process and everything it started, then checks. Resolves to
 * { left: processes still alive, names: their names, mode: 'jobs' or 'groups' (confirmed by the Windows job or the
 * process group) or 'basic' (process tree only) }.
 */
export async function endProc(proc) {
  if (!proc) return { left: 0, names: [], mode: 'none' };
  if (proc.qxJob) {
    try {
      const r = await killJob(proc.qxJob);
      if (!r.left) { closeJob(proc.qxJob); proc.qxJob = null; }
      return { left: r.left, names: r.names, mode: r.mode };
    } catch { /* the job host went away: fall back to the tree */ }
  }
  if (proc.exitCode == null && proc.signalCode == null && proc.pid) await taskkillTree(proc.pid);
  await exited(proc, 2000);
  return { left: proc.exitCode == null && proc.signalCode == null ? 1 : 0, names: [], mode: 'basic' };
}
// After a command ends by itself: processes it left running (a detached child) are ended too, and named.
async function sweep(proc) {
  if (!proc.qxJob) return null;
  try {
    const c = await jobCount(proc.qxJob);
    if (!c.active) { closeJob(proc.qxJob); return null; }
    const k = await killJob(proc.qxJob);
    if (!k.left) closeJob(proc.qxJob);
    return { ended: c.names, left: k.left, names: k.names };
  } catch { return null; }
}
/** How a Stop went, in one line for the terminal and the agent. */
export function stopNote(r) {
  if (!r) return '';
  if (r.mode === 'basic') return r.left ? '⚠ stop sent, but the process may still be running (basic mode: no job host)' : '■ stopped (basic mode: detached processes may survive)';
  return r.left ? `⚠ ${r.left} process${r.left > 1 ? 'es' : ''} did not stop: ${r.names.join(', ')}` : '■ stopped · 0 processes left';
}

// Agent commands get no keyboard, so tools that would stop to ask are told not to: no prompts, no MSBuild
// processes left running (they make `dotnet build` look hung), no telemetry banners, no colour codes in logs. (No pager,
// editor or git prompt comes from childEnv, for the agent's terminal too.)
const NON_INTERACTIVE = { CI: '1', PIP_NO_INPUT: '1', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1', NO_COLOR: '1', CARGO_TERM_COLOR: 'never', npm_config_yes: 'true', POWERSHELL_TELEMETRY_OPTOUT: '1' };

// `term` ({ projectId, source, chatId }) sends the command and its output to the terminal feed as it runs.
export function runCommand(root, cmd, args = [], opts = {}) {
  let line;
  try { line = lineOf(cmd, (args || []).map(String)); } catch (e) { return Promise.reject(e); }
  return runLine(root, line, { ...opts, shell: 'direct', label: opts.label || [cmd, ...(args || [])].join(' ') });
}

/**
 * Runs one command line in `root` through `shell` and waits for it. Resolves to
 * { code, out (last 8,000 chars), ms, timedOut, stopped: endProc result | null, leftovers: sweep result | null, log }.
 * `logTo`: a file that gets the full output. `onStart(proc)`: called once it runs (for the tripwire).
 */
export function runLine(root, line, { shell = 'direct', timeout = 180e3, signal, term, label, memoryMB = 0, logTo, onStart, onJob, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    (async () => {
      // Stop already pressed (say while a before_command hook ran): nothing is started at all.
      if (signal?.aborted) return resolve({ code: null, out: '[stopped before it started]', ms: 0, timedOut: false, stopped: { left: 0, names: [], mode: 'none', why: 'stopped' }, leftovers: null, log: null });
      let proc;
      try { proc = await launch(root, line, { shell, memoryMB, signal, env: { ...env, ...NON_INTERACTIVE } }); } catch (e) { return reject(e); }
      onStart?.(proc);
      const t0 = Date.now();
      label = label || line;
      let stopping = null, timedOut = false;
      const stop = (why) => (stopping ??= endProc(proc).then((r) => ({ ...r, why })));
      const job = term ? newJob(term.projectId, label, term.source, () => stop('you'), { chatId: term.chatId, tab: term.tab }) : null;
      if (job) onJob?.(job);
      const split = lineSplitter((text, stream) => termEvent(term.projectId, { kind: 'out', job, text, stream }));
      if (job) termEvent(term.projectId, { kind: 'start', job, source: term.source, chatId: term.chatId, label, tab: term.tab, cwd: term.cwd });
      let log = null;
      if (logTo) { try { fs.mkdirSync(path.dirname(logTo), { recursive: true }); log = fs.createWriteStream(logTo); log.write(`> ${line}\n`); } catch { log = null; } }
      let out = '';
      const add = (stream) => (d) => { out += d.toString(); if (out.length > 40000) out = out.slice(-30000); log?.write(d); if (job) split.push(d, stream); };
      const note = (text) => { out += `\n${text}\n`; log?.write(`\n${text}\n`); if (job) termEvent(term.projectId, { kind: 'out', job, text, stream: 'note' }); };
      proc.stdout.on('data', add('out')); proc.stderr.on('data', add('err'));
      const timer = setTimeout(() => { timedOut = true; note(`[stopped after ${Math.round(timeout / 1000)}s]`); stop('timeout'); }, timeout);
      const onAbort = () => stop('stopped');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); // pressed during launch: the abort event has already fired
      let done = false;
      const finish = async (code, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const stopped = stopping ? await stopping : null;
        const leftovers = stopped ? null : await sweep(proc);
        // Output pipes close once nothing holds them any more (a detached child can hold them until it ends).
        await Promise.race([new Promise((r) => (proc.stdout.readableEnded ? r() : proc.stdout.once('close', r))), new Promise((r) => setTimeout(r, 1500))]);
        if (job) split.flush('out');
        if (stopped) note(stopNote(stopped));
        if (leftovers) note(`(${leftovers.ended.length} process${leftovers.ended.length > 1 ? 'es' : ''} it left running ${leftovers.left ? 'could not all be ended' : 'were ended'}: ${leftovers.ended.join(', ')})`);
        log?.end();
        if (job) { termEvent(term.projectId, { kind: 'end', job, code, ms: Date.now() - t0, error: err, stopped: stopped ? { left: stopped.left, names: stopped.names, mode: stopped.mode } : undefined }); endJob(job); }
        if (err != null && code == null) return reject(new Error(err));
        resolve({ code, out: out.slice(-8000), ms: Date.now() - t0, timedOut, stopped, leftovers, log: logTo || null });
      };
      proc.on('exit', (code) => finish(code));
      proc.on('error', (e) => finish(null, e.message));
    })();
  });
}

// ---------- dev servers ----------
const servers = new Map();
const portFree = (port) => new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(port, '127.0.0.1'); });
const portOpen = (port) => new Promise((r) => { const c = net.connect({ host: '127.0.0.1', port }); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
async function freePort() {
  const used = new Set([...servers.values()].map((s) => s.port));
  for (let p = 5300; p < 6000; p++) if (!used.has(p) && await portFree(p)) return p;
  throw new Error('no free port between 5300 and 5999');
}
const slug = (s) => String(s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'app';
const view = (s) => ({ key: s.key, projectId: s.projectId, name: s.name, command: [s.cmd, ...s.args].join(' '), port: s.port, url: `http://localhost:${s.port}/`, status: s.status, started: s.started, code: s.code ?? null });

/** Starts (or restarts) a named server in the agent's folder; it gets a free port as PORT and {PORT}
 * (or the fixed `port` a launch config asks for). Its command is saved to the project's launch file. */
export async function startServer({ projectId, name, cmd, args = [], port: fixed, source = 'agent', save = true }) {
  const root = workspaceDir(projectId);
  const key = `${projectId}/${slug(name)}`;
  if (servers.has(key)) await stopServerWait(key, source);
  checkCommand(cmd, args.map(String));
  let port;
  if (fixed) {
    port = Number(fixed);
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`bad port ${fixed}`);
    // A restart frees the port a moment after the old process is killed.
    for (let i = 0; i < 10 && !await portFree(port); i++) await new Promise((r) => setTimeout(r, 300));
    if (!await portFree(port)) throw new Error(`port ${port} is already in use (stop whatever is using it, or clear the fixed port in the launch config)`);
  } else port = await freePort();
  const real = args.map((a) => String(a).replaceAll('{PORT}', String(port)));
  if (save) saveLaunchConfig(projectId, { name, command: cmd, args: args.map(String), port: fixed || null });
  const s = { key, projectId, name: String(name || 'app'), cmd, args: args.map(String), fixed: fixed || null, port, status: 'starting', started: Date.now(), log: [], source };
  const job = `srv:${key}:${s.started}`;
  const split = lineSplitter((line, stream) => {
    if (line.trim()) { s.log.push(line); if (s.log.length > 400) s.log.splice(0, s.log.length - 400); }
    termEvent(projectId, { kind: 'out', job, server: s.name, text: line, stream });
  });
  termEvent(projectId, { kind: 'start', job, server: s.name, source, label: [cmd, ...real].join(' '), port });
  s.proc = await launch(root, lineOf(cmd, real), { env: { ...projectEnv(root), PORT: String(port) } });
  s.proc.stdout.on('data', (d) => split.push(d, 'out')); s.proc.stderr.on('data', (d) => split.push(d, 'err'));
  s.proc.on('exit', (code) => { split.flush('out'); s.status = 'stopped'; s.code = code; termEvent(projectId, { kind: 'end', job, server: s.name, code }); });
  servers.set(key, s);
  const t0 = Date.now();
  while (Date.now() - t0 < 45e3) {
    if (s.status === 'stopped') break;
    if (await portOpen(port)) { s.status = 'running'; termEvent(projectId, { kind: 'out', job, server: s.name, text: `● listening on http://localhost:${port}/`, stream: 'note' }); break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (s.status === 'starting') s.status = 'not listening';
  return { ...view(s), log: s.log.slice(-40).join('\n') };
}

/** Stops a server and everything it started; resolves to how it went ({ left, names, mode }), or null for no such server. */
export async function stopServerWait(key, by = 'agent') {
  const s = servers.get(key);
  if (!s) return null;
  const job = `srv:${key}:${s.started}`;
  const live = s.proc?.exitCode == null && s.status !== 'stopped';
  s.status = 'stopped';
  const r = await (s.stopping ??= endProc(s.proc));
  if (live) termEvent(s.projectId, { kind: 'out', job, server: s.name, text: `${stopNote(r)} (stopped by ${by === 'you' ? 'you' : 'the agent'})`, stream: 'note' });
  return r;
}
export function stopServer(key, by = 'agent') {
  if (!servers.has(key)) return false;
  stopServerWait(key, by);
  return true;
}
export const restartServer = (key, source = 'you') => { const s = servers.get(key); if (!s) throw new Error('unknown server'); return startServer({ projectId: s.projectId, name: s.name, cmd: s.cmd, args: s.args, port: s.fixed, source }); };
export const listServers = (projectId) => [...servers.values()].filter((s) => !projectId || s.projectId === projectId).map(view);
export const serverLog = (key) => servers.get(key)?.log.slice(-200).join('\n') ?? '';
export const serverFor = (projectId, name) => servers.get(`${projectId}/${slug(name)}`);

// ---------- launch configs: the project's saved run commands ----------
// Kept in <project>/.quorx/launch.json (written whenever a server starts, editable by the user). A
// A .claude/launch.json in the folder (the same format, from other tools) is read too, so existing repos work as they are.
const LAUNCH = '.quorx/launch.json';
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const cleanConfig = (c) => ({ name: String(c.name || 'app').trim().slice(0, 40) || 'app', command: String(c.command || '').trim(), args: (Array.isArray(c.args) ? c.args : []).map(String), port: Number(c.port) > 0 ? Number(c.port) : null });

export function launchConfigs(projectId) {
  const root = workspaceDir(projectId);
  const own = (readJson(path.join(root, LAUNCH))?.configurations || []).filter((c) => c?.command).map((c) => ({ ...cleanConfig(c), from: LAUNCH }));
  const claude = (readJson(path.join(root, '.claude', 'launch.json'))?.configurations || [])
    .filter((c) => c?.runtimeExecutable && PROGRAM.test(String(c.runtimeExecutable).trim()))
    .map((c) => ({ ...cleanConfig({ name: c.name, command: c.runtimeExecutable, args: c.runtimeArgs, port: c.port }), from: '.claude/launch.json' }))
    .filter((c) => !own.some((o) => slug(o.name) === slug(c.name)));
  return [...own, ...claude];
}
/** Adds or replaces one config (by name; `oldName` renames). */
export function saveLaunchConfig(projectId, cfg) {
  const c = cleanConfig(cfg);
  if (!c.command) throw new Error('a launch config needs a command');
  checkCommand(c.command, c.args);
  const file = path.join(workspaceDir(projectId), LAUNCH);
  const list = readJson(file)?.configurations || [];
  const at = list.findIndex((x) => slug(x.name) === slug(cfg.oldName || c.name));
  const rest = list.filter((x) => slug(x.name) !== slug(c.name) && slug(x.name) !== slug(cfg.oldName || c.name));
  rest.splice(at < 0 ? rest.length : Math.min(at, rest.length), 0, c);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, configurations: rest }, null, 2));
  return c;
}
export function removeLaunchConfig(projectId, name) {
  const file = path.join(workspaceDir(projectId), LAUNCH);
  const list = readJson(file)?.configurations;
  if (!list) return false;
  const left = list.filter((x) => slug(x.name) !== slug(name));
  fs.writeFileSync(file, JSON.stringify({ version: 1, configurations: left }, null, 2));
  return left.length < list.length;
}
// Saved configs and running servers together: what the server menu lists.
export function serverOverview(projectId) {
  const live = listServers(projectId);
  const rows = launchConfigs(projectId).map((c) => {
    const sv = live.find((x) => slug(x.name) === slug(c.name));
    return { ...c, saved: true, key: `${projectId}/${slug(c.name)}`, status: sv?.status || 'stopped', url: sv && sv.status !== 'stopped' ? sv.url : null, started: sv?.started || null, code: sv?.code ?? null };
  });
  for (const sv of live) {
    if (rows.some((r) => r.key === sv.key)) continue;
    const s = servers.get(sv.key);
    rows.push({ name: sv.name, command: s.cmd, args: s.args, port: s.fixed, saved: false, from: null, key: sv.key, status: sv.status, url: sv.status !== 'stopped' ? sv.url : null, started: sv.started, code: sv.code });
  }
  return rows;
}

// When the harness stops, stop every dev server it started (synchronously, so nothing is orphaned).
function killAll() {
  for (const s of servers.values()) {
    if (!s.proc || s.proc.exitCode != null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(-s.proc.pid, 'SIGTERM'); } catch { s.proc.kill('SIGTERM'); }
  }
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// ---------- search, trash, checkpoints, templates ----------
const AGENT_DIR = '.quorx'; // the harness's own notes inside a project: log, trash, checkpoints, skills, scratch
export const SCRATCH = `${AGENT_DIR}/scratch`; // the agent's own space for research scripts, scrapes, downloads, throwaway tests

// The agent's folder never ends up in the user's git repo: a .gitignore of "*" inside it makes git
// skip the whole folder (itself included), without touching the user's own .gitignore.
// Older projects keep their notes, undo history and skills. Before the name QuorX this folder was .openharness
// (always the harness's), and before that .agent (the harness's only if it holds the harness's own parts; a .agent
// folder from another tool is left exactly as it is). The launch file's paths move with it, so saved servers still start.
const LEGACY_DIRS = ['.openharness', '.agent'];
const HARNESS_PARTS = ['checkpoints', 'scratch', 'trash', 'launch.json', 'log.md', 'skills', 'uploads', 'plan.md'];
export function migrateAgentDir(root) {
  const neu = path.join(root, AGENT_DIR);
  try {
    if (fs.existsSync(neu)) return false;
    for (const name of LEGACY_DIRS) {
      const old = path.join(root, name);
      if (!fs.existsSync(old)) continue;
      if (name === '.agent') {
        const gi = path.join(old, '.gitignore');
        const ours = (fs.existsSync(gi) && /QuorX|OpenHarness/.test(fs.readFileSync(gi, 'utf8'))) || HARNESS_PARTS.filter((x) => fs.existsSync(path.join(old, x))).length >= 2;
        if (!ours) continue;
      }
      renameRetry(old, neu);
      const lj = path.join(neu, 'launch.json');
      if (fs.existsSync(lj)) fs.writeFileSync(lj, fs.readFileSync(lj, 'utf8').replace(/\.(openharness|agent)([\\/]+)/g, `${AGENT_DIR}$2`));
      return true;
    }
    return false;
  } catch (e) {
    // Still in use after the retries (e.g. a server running from the old folder): try again next time. Anything else is
    // a real error, not "busy".
    if (LOCKED.has(e.code)) return 'busy';
    throw e;
  }
}
// On Windows a folder can't be renamed while anything holds a file in it, and a virus scanner often does for a moment
// right after files are written. So a rename is tried a few times (about 0.75 s in all) before it counts as busy.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RENAME_WAITS = [50, 100, 200, 400];
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!LOCKED.has(e.code) || i >= RENAME_WAITS.length) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAITS[i]);
    }
  }
}
export function ensureAgentDir(root) {
  const dir = path.join(root, AGENT_DIR);
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# QuorX working files: never committed\n*\n');
  return dir;
}

function dirSize(p) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else try { bytes += fs.statSync(q).size; files++; } catch { /* gone */ }
    }
  };
  walk(p);
  return { bytes, files };
}
/** How much room the agent's folder takes, per part. */
export function agentSpace(root) {
  const dir = path.join(root, AGENT_DIR);
  const part = (name) => ({ name, ...dirSize(path.join(dir, name)) });
  const parts = [part('scratch'), part('checkpoints'), part('trash'), part('objects')];
  const total = dirSize(dir);
  parts.push({ name: 'other', bytes: Math.max(0, total.bytes - parts.reduce((a, x) => a + x.bytes, 0)), files: Math.max(0, total.files - parts.reduce((a, x) => a + x.files, 0)) });
  return { dir, total: total.bytes, files: total.files, parts };
}

// "*.js", "src/**/*.css": ** spans folders, * and ? stay within one name.
function globToRegExp(glob) {
  let out = '';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { out += '.*'; i++; }
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '.';
    else out += /[a-z0-9_\-/]/i.test(ch) ? ch : `\\${ch}`;
  }
  return new RegExp(`^${out}$`, 'i');
}

// Case-insensitive literal search across text files in the project.
export function searchFiles(root, query, glob = '', max = 80) {
  const q = String(query || '').toLowerCase();
  if (!q) throw new Error('query is empty');
  const rx = glob ? globToRegExp(glob) : null;
  const out = [];
  for (const f of listFiles(root, 2000)) {
    if (out.length >= max || SKIPPED.test(f.path) || f.size > 1e6) continue;
    if (rx && !rx.test(f.path) && !rx.test(path.basename(f.path))) continue;
    // Links can point outside the project (or at QuorX's own keys): skip them, and keep every read inside safePath.
    let text;
    try {
      const p = safePath(root, f.path);
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    text.split(/\r?\n/).forEach((line, i) => { if (out.length < max && line.toLowerCase().includes(q)) out.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 200) }); });
  }
  return out;
}

// Deleting never destroys: the file moves to .quorx/trash/<time>/<path>.
export function trashFile(root, rel) {
  const p = safePath(root, rel);
  if (!fs.existsSync(p)) throw new Error(`no file ${rel}`);
  const dest = path.join(root, AGENT_DIR, 'trash', new Date().toISOString().replace(/[:.]/g, '-'), rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(p, dest);
  return path.relative(root, dest).replaceAll('\\', '/');
}

/** When a reply's undo copy last changed: its manifest is rewritten each time the reply touches another file. A folder's
 *  own time only moves when an entry is added to it, so copies made in the same second would tie. */
export function checkpointTime(dir) {
  for (const p of [path.join(dir, 'manifest.json'), dir]) { try { return fs.statSync(p).mtimeMs; } catch { /* next */ } }
  return 0;
}

// Before a run first touches a file, keep its previous version (or note that it didn't exist),
// so the whole reply can be undone.
export function checkpoint(root, runId, rel) {
  if (!/^[\w-]+$/.test(String(runId))) return;
  const dir = path.join(root, AGENT_DIR, 'checkpoints', runId);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
  const key = String(rel).replaceAll('\\', '/');
  if (key in manifest.files) return;
  const p = safePath(root, rel);
  manifest.files[key] = fs.existsSync(p);
  if (manifest.files[key]) { const copy = path.join(dir, 'files', key); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(p, copy); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
// The same record, made after the fact: `before` is the file's copy from a snapshot (or null: it didn't exist).
function recordBefore(root, runId, rel, before) {
  if (!/^[\w-]+$/.test(String(runId))) return;
  const dir = path.join(root, AGENT_DIR, 'checkpoints', runId);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
  const key = String(rel).replaceAll('\\', '/');
  if (key in manifest.files) return;
  manifest.files[key] = !!before;
  if (before) { const copy = path.join(dir, 'files', key); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(before, copy); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

/**
 * Before a command: a snapshot of the project (null when snapshots are off or the project is over the size limit;
 * `why` then says so). After it: commandChanges() puts what the command changed into the reply's checkpoint.
 */
export function snapBefore(root, opts = {}) {
  try {
    const s = snapshot(root, opts);
    return s.over ? { snap: null, why: `the project is over the ${Math.round((opts.maxBytes ?? 1024 ** 3) / 1024 ** 2)} MB snapshot limit` } : { snap: s, why: '' };
  } catch (e) { return { snap: null, why: e.message }; }
}
export function commandChanges(root, runId, before) {
  const ch = changesSince(root, before);
  for (const rel of [...ch.added, ...ch.modified, ...ch.deleted]) {
    try { recordBefore(root, runId, rel, objectFor(root, before, rel)); } catch { /* best effort */ }
  }
  pruneObjects(root);
  return { added: ch.added, modified: ch.modified, deleted: ch.deleted };
}

export function changedFiles(root, runId) {
  const m = path.join(root, AGENT_DIR, 'checkpoints', String(runId), 'manifest.json');
  return fs.existsSync(m) ? Object.keys(JSON.parse(fs.readFileSync(m, 'utf8')).files) : [];
}
// Undo: put back every file a run changed; files it created move to the trash.
export function restoreCheckpoint(root, runId, { only } = {}) {
  if (!/^[\w-]+$/.test(String(runId))) throw new Error('bad run id');
  const dir = path.join(root, AGENT_DIR, 'checkpoints', runId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('nothing to undo for this reply');
  const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [];
  for (const [rel, existed] of Object.entries(files)) {
    if (only && !only.includes(rel)) { restored.push(`${rel} (kept: changed since)`); continue; }
    const p = safePath(root, rel);
    if (existed) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(dir, 'files', rel), p); restored.push(`${rel} (restored)`); }
    else if (fs.existsSync(p)) { trashFile(root, rel); restored.push(`${rel} (removed)`); }
  }
  fs.renameSync(dir, `${dir}-undone-${Date.now()}`);
  return restored;
}

// ---------- how long Undo lasts ----------
// When a reply ends, its checkpoint is sealed with what each file looked like then, so a later Undo can
// tell whether anything changed those files since (a later reply, or you). Only the newest replies keep
// their Undo (default 10 per project, at most 7 days); older checkpoints are removed.
const fileHash = (p) => { try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const ckptDir = (root) => path.join(root, AGENT_DIR, 'checkpoints');
function readManifest(root, runId) { try { return JSON.parse(fs.readFileSync(path.join(ckptDir(root), String(runId), 'manifest.json'), 'utf8')); } catch { return null; } }
export function sealCheckpoint(root, runId) {
  const m = readManifest(root, runId);
  if (!m) return;
  m.after = Object.fromEntries(Object.keys(m.files).map((rel) => [rel, fileHash(safePath(root, rel))]));
  m.doneAt = Date.now();
  fs.writeFileSync(path.join(ckptDir(root), String(runId), 'manifest.json'), JSON.stringify(m));
}
/** Replies in this project that can still be undone, newest first. */
export function listCheckpoints(root) {
  const dir = ckptDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.includes('-undone-')).map((e) => {
    const m = readManifest(root, e.name);
    const at = m?.doneAt || (() => { try { return fs.statSync(path.join(dir, e.name, 'manifest.json')).mtimeMs; } catch { return 0; } })();
    return { runId: e.name, at, files: m ? Object.keys(m.files).length : 0 };
  }).filter((x) => x.files).sort((a, b) => b.at - a.at);
}
/** Keeps the newest `keep` checkpoints that are at most `days` old; removes the rest and leftovers of undone ones. */
export function pruneCheckpoints(root, { keep = 10, days = 7 } = {}) {
  const dir = ckptDir(root);
  if (!fs.existsSync(dir)) return [];
  const oldest = Date.now() - Math.max(0.01, Number(days) || 7) * 864e5, removed = [];
  const live = listCheckpoints(root);
  const drop = new Set(live.filter((x, i) => i >= Math.max(1, Number(keep) || 10) || x.at < oldest).map((x) => x.runId));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (drop.has(e.name) || e.name.includes('-undone-') || !live.some((x) => x.runId === e.name)) { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); removed.push(e.name); }
  }
  return removed;
}
/** Files this reply changed that have changed again since it ended (by a later reply or by hand). */
export function undoConflicts(root, runId) {
  const m = readManifest(root, runId);
  if (!m) throw new Error('nothing to undo for this reply (its undo history was cleared)');
  const rels = Object.keys(m.files);
  if (m.after) return rels.filter((rel) => fileHash(safePath(root, rel)) !== m.after[rel]);
  // Older checkpoints have no seal: a later reply that touched the same file counts as a change.
  const mine = listCheckpoints(root).find((x) => x.runId === String(runId))?.at || 0;
  const later = listCheckpoints(root).filter((x) => x.at > mine).map((x) => readManifest(root, x.runId)).filter(Boolean);
  return rels.filter((rel) => later.some((l) => rel in l.files));
}

// ---------- Review changes: what a reply did to each file, a diff, and Undo for one file ----------
// "Before" is the reply's undo copy (or nothing, for a file it created); "now" is the file on disk, which may also
// hold later changes (changedSince says so). Files undone one by one leave the checkpoint, so the reply's own
// "Undo changes" then covers only the rest.
const REVIEW_MAX = 400e3; // bytes per side: bigger files get counts from their sizes only, no diff
const readOr = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const isBinary = (buf) => !!buf && buf.subarray(0, 8000).includes(0);
const linesOf = (buf) => { if (!buf) return []; const l = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n'); if (l.at(-1) === '') l.pop(); return l; };
// Line diff (Myers): common start and end trimmed, then the shortest edit script for what's left. Its cost grows
// with the number of edits, not the file size; past 2,500 edits it shows the middle as replaced.
function myers(A, B) {
  const n = A.length, m = B.length, max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  const at = (t, d, k) => t[k + d + 1];
  for (let d = 0; d <= Math.min(max, 2500); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const ops = []; let X = n, Y = m;
        for (let dd = d; dd >= 0; dd--) {
          const t = trace[dd], kk = X - Y;
          const pk = kk === -dd || (kk !== dd && at(t, dd, kk - 1) < at(t, dd, kk + 1)) ? kk + 1 : kk - 1;
          const px = at(t, dd, pk), py = px - pk;
          while (X > px && Y > py) { ops.push([' ', A[X - 1]]); X--; Y--; }
          if (dd > 0) { if (X === px) ops.push(['+', B[Y - 1]]); else ops.push(['-', A[X - 1]]); }
          X = px; Y = py;
        }
        return ops.reverse();
      }
    }
  }
  return null;
}
export function diffLines(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  const mid = myers(A, B) || [...A.map((l) => ['-', l]), ...B.map((l) => ['+', l])];
  return [...a.slice(0, s).map((l) => [' ', l]), ...mid, ...a.slice(a.length - e).map((l) => [' ', l])];
}
// Changed lines with 3 lines of context, as hunks with old/new line numbers; at most `limit` lines in all.
function hunksOf(ops, ctx = 3, limit = 1500) {
  const hunks = []; let ln = [1, 1], cur = null, shown = 0;
  const nums = ops.map(([t]) => { const r = [t === '+' ? null : ln[0], t === '-' ? null : ln[1]]; if (t !== '+') ln[0]++; if (t !== '-') ln[1]++; return r; });
  const change = ops.map(([t], i) => (t !== ' ' ? i : -1)).filter((i) => i >= 0);
  let k = 0;
  for (let i = 0; i < ops.length; i++) {
    while (k < change.length && change[k] < i - ctx) k++;
    const near = k < change.length && change[k] <= i + ctx;
    if (!near) { cur = null; continue; }
    if (!cur) { cur = { lines: [] }; hunks.push(cur); }
    if (shown >= limit) { cur.cut = true; break; }
    cur.lines.push([ops[i][0], nums[i][0], nums[i][1], ops[i][1].slice(0, 2000)]); shown++;
  }
  return { hunks, cut: shown >= limit };
}
function reviewEntry(root, runId, m, rel) {
  const dir = path.join(ckptDir(root), String(runId));
  const existed = m.files[rel];
  const before = existed ? readOr(path.join(dir, 'files', rel)) : null;
  const now = readOr(safePath(root, rel));
  const status = !existed ? (now ? 'added' : 'added then removed') : now ? 'modified' : 'deleted';
  const changedSince = !!m.after && (now ? crypto.createHash('sha1').update(now).digest('hex') : null) !== m.after[rel];
  const out = { path: rel, status, changedSince, binary: isBinary(before) || isBinary(now) };
  if (out.binary || (before?.length || 0) > REVIEW_MAX || (now?.length || 0) > REVIEW_MAX) { out.large = !out.binary; return { out, before, now }; }
  const ops = diffLines(linesOf(before), linesOf(now));
  out.added = ops.filter(([t]) => t === '+').length; out.removed = ops.filter(([t]) => t === '-').length;
  return { out, before, now, ops };
}
export function reviewFiles(root, runId) {
  if (!/^[\w-]+$/.test(String(runId))) throw new Error('bad run id');
  const m = readManifest(root, runId);
  if (!m) throw new Error('This reply\'s undo copy is no longer kept, so its changes can\'t be reviewed.');
  return { files: Object.keys(m.files).map((rel) => reviewEntry(root, runId, m, rel).out), undone: m.undoneFiles || [] };
}
export function reviewDiff(root, runId, rel) {
  if (!/^[\w-]+$/.test(String(runId))) throw new Error('bad run id');
  const m = readManifest(root, runId);
  if (!m || !(rel in m.files)) throw new Error('This file is not in the reply\'s undo copy any more.');
  const r = reviewEntry(root, runId, m, rel);
  return { ...r.out, ...(r.ops ? hunksOf(r.ops) : { hunks: [] }) };
}
// Undo one file. If it changed again after the reply ended, the caller must pass force.
export function undoFile(root, runId, rel, { force } = {}) {
  if (!/^[\w-]+$/.test(String(runId))) throw new Error('bad run id');
  const dir = path.join(ckptDir(root), String(runId)), mp = path.join(dir, 'manifest.json');
  const m = readManifest(root, runId);
  if (!m || !(rel in m.files)) throw new Error('This file is not in the reply\'s undo copy any more.');
  const p = safePath(root, rel);
  if (!force && m.after && fileHash(p) !== m.after[rel]) return { conflict: true };
  // The version being replaced goes to .quorx/trash first, so undoing one file can itself be taken back by hand.
  if (fs.existsSync(p)) trashFile(root, rel);
  if (m.files[rel]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(dir, 'files', rel), p); }
  const result = m.files[rel] ? 'restored' : 'removed';
  delete m.files[rel]; if (m.after) delete m.after[rel];
  (m.undoneFiles ||= []).push(rel);
  fs.writeFileSync(mp, JSON.stringify(m));
  const left = Object.keys(m.files).length;
  if (!left) fs.renameSync(dir, `${dir}-undone-${Date.now()}`);
  return { ok: true, result, left };
}

// Copy a starter template into the project without overwriting anything.
export function copyTemplate(root, templateDir) {
  const written = [], skipped = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      const rel = path.relative(templateDir, src);
      if (e.isDirectory()) { walk(src); continue; }
      if (rel === 'template.json') continue;
      const dest = safePath(root, rel);
      if (fs.existsSync(dest)) { skipped.push(rel.replaceAll('\\', '/')); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      written.push(rel.replaceAll('\\', '/'));
    }
  };
  walk(templateDir);
  return { written, skipped };
}
