// The rule engine: decides, before a command runs, whether it runs, asks, or is blocked (docs/shell-safety-plan.md §1–2).
//   1. Split the line into commands. PowerShell lines go through PowerShell's own parser (jobhost.ps1 "parse");
//      cmd and bash lines through small, conservative tokenizers. Anything they can't read is "opaque".
//   2. Give each command a class (read, write, build, install, external, opaque, delete, discard, never, unknown).
//   3. Resolve every path a delete or write touches to its real target (~, $env:X, %X%, junctions, 8.3 names).
//      Drive roots, your profile and its folders, system folders, folders above the project, the project folder
//      itself, .git and QuorX's own files are blocked outright.
//   4. Apply the rules: deny > ask > allow. A rule can always make a class stricter; it can only relax opaque,
//      external and discard if you typed it yourself, and never relaxes "never" or a blocked path.
//   5. The strictest command decides the whole line.
// Nothing here runs the command. decide() is the whole interface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePowerShell } from './jobhost.js';
import { realish } from './workspace.js';
import { HOME } from './openrouter.js';
import { SECRET_FILES } from './keys.js';

const WIN = process.platform === 'win32';
const low = (s) => String(s ?? '').toLowerCase();
const progName = (s) => low(path.basename(String(s || '').replace(/^["']|["']$/g, ''))).replace(/\.(exe|cmd|bat|com|ps1)$/, '');

// ---------- what each program does ----------
const READ = new Set(['get-childitem', 'dir', 'ls', 'get-content', 'cat', 'type', 'more', 'where', 'which', 'get-command', 'echo', 'write-output',
  'write-host', 'pwd', 'get-location', 'test-path', 'select-string', 'findstr', 'grep', 'rg', 'measure-object', 'sort-object', 'select-object',
  'format-table', 'format-list', 'format-wide', 'out-string', 'out-host', 'get-date', 'get-process', 'tasklist', 'tree', 'get-item', 'resolve-path',
  'get-filehash', 'convertfrom-json', 'convertto-json', 'where-object', 'foreach-object', 'get-member', 'head', 'tail', 'wc', 'sort', 'uniq',
  'cd', 'chdir', 'set-location', 'push-location', 'pop-location', 'get-alias', 'get-help', 'hostname', 'whoami', 'ver', 'get-variable',
  'split-path', 'join-path', 'get-itemproperty', 'test-json', 'compare-object', 'group-object', 'get-unique', 'select-xml', 'get-psdrive',
  'get-host', 'get-culture', 'get-random', 'start-sleep', 'sleep', 'timeout', 'true', 'false', 'exit', 'basename', 'dirname', 'diff', 'fc', 'comp',
  'out-null', 'write-error', 'write-warning', 'write-verbose', 'write-information']);
const WRITE = new Set(['new-item', 'ni', 'mkdir', 'md', 'set-content', 'add-content', 'out-file', 'copy-item', 'cp', 'copy', 'xcopy', 'touch',
  'tee-object', 'expand-archive', 'compress-archive', 'rename-item', 'ren', 'rename', 'move-item', 'mv', 'move', 'robocopy', 'tar', 'unzip', 'zip', '7z']);
const DELETE = new Set(['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'rimraf', 'del-cli', 'clear-content', 'clear-item', 'trash']);
const MOVES = new Set(['move-item', 'mv', 'move', 'rename-item', 'ren', 'rename']);
const BUILD = new Set(['cargo', 'rustc', 'dotnet', 'go', 'cmake', 'ctest', 'make', 'nmake', 'ninja', 'msbuild', 'cl', 'gcc', 'g++', 'clang', 'clang++',
  'javac', 'java', 'gradle', 'gradlew', 'mvn', 'mvnw', 'kotlinc', 'kotlin', 'swift', 'swiftc', 'zig', 'tsc', 'vite', 'webpack', 'esbuild', 'rollup',
  'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest', 'ruff', 'mypy', 'black', 'flake8', 'pylint', 'pyinstaller', 'electron', 'electron-builder',
  'flutter', 'dart', 'node', 'python', 'python3', 'py', 'deno', 'bun', 'npm', 'pnpm', 'yarn', 'uv', 'uvx', 'poetry', 'pipenv', 'pip', 'pip3', 'npx',
  'ruby', 'php', 'perl', 'lua', 'R', 'rscript', 'adb', 'emulator', 'tauri', 'wails', 'ts-node', 'tsx', 'nodemon', 'next', 'nuxt', 'astro', 'git',
  'sqlite3', 'docker', 'docker-compose', 'podman', 'ldd', 'objdump', 'dumpbin', 'gdb', 'lldb', 'valgrind', 'gofmt', 'rustfmt', 'clang-format',
  'cargo-watch', 'trunk', 'wasm-pack', 'maturin', 'conan', 'vcpkg', 'meson', 'bazel', 'sbt', 'lein', 'mix', 'elixir', 'erl', 'ghc', 'stack', 'cabal']);
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'powershell', 'pwsh', 'cmd', 'bash', 'sh',
  'zsh', 'wsl', 'lua', 'rscript', 'osascript', 'npx', 'uvx']);
const OPAQUE = new Set(['invoke-expression', 'iex', 'invoke-command', 'icm', 'start-process', 'saps', 'start', 'start-job', 'add-type', 'mshta',
  'rundll32', 'regsvr32', 'wscript', 'cscript', 'certutil', 'wsl', 'eval', 'source', 'xargs', 'exec', 'invoke-item', 'ii', 'set-alias', 'new-alias',
  'call', 'forfiles', 'powershell_ise', 'explorer']);
const NEVER = new Set(['format', 'format-volume', 'diskpart', 'bcdedit', 'vssadmin', 'cipher', 'set-executionpolicy', 'net', 'net1', 'netsh',
  'schtasks', 'shutdown', 'stop-computer', 'restart-computer', 'takeown', 'wmic', 'bootrec', 'manage-bde', 'fsutil', 'mountvol', 'disable-computerrestore',
  'set-mppreference', 'add-mppreference', 'remove-mppreference', 'new-service', 'set-service', 'remove-service', 'register-scheduledtask',
  'unregister-scheduledtask', 'set-netfirewallrule', 'new-netfirewallrule', 'remove-netfirewallrule', 'new-localuser', 'set-localuser',
  'add-localgroupmember', 'enable-psremoting', 'sudo', 'runas', 'clear-recyclebin', 'clear-disk', 'initialize-disk', 'remove-partition',
  'set-partition', 'reg', 'regedit', 'bcdboot', 'sfc', 'dism', 'secedit', 'auditpol', 'gpupdate', 'mkfs', 'dd', 'icacls',
  'set-acl', 'remove-computer', 'add-computer', 'rename-computer', 'set-timezone', 'set-date', 'logoff']);
// Programs that end other processes: they could close your own programs, so they ask you.
const KILLERS = new Set(['taskkill', 'tskill', 'stop-process', 'spps', 'kill', 'pkill', 'killall']);
const EXTERNAL = new Set(['gh', 'glab', 'vercel', 'netlify', 'fly', 'flyctl', 'firebase', 'heroku', 'wrangler', 'az', 'aws', 'gcloud', 'kubectl',
  'helm', 'terraform', 'pulumi', 'ansible', 'ansible-playbook', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'curl', 'wget', 'invoke-webrequest', 'iwr',
  'invoke-restmethod', 'irm', 'start-bitstransfer', 'bitsadmin', 'nslookup', 'dig', 'resolve-dnsname', 'tracert', 'traceroute', 'test-netconnection',
  'tnc', 'telnet', 'nc', 'ncat', 'netcat', 'psql', 'mysql', 'sqlcmd', 'mongo', 'mongosh', 'redis-cli', 'send-mailmessage', 'twine', 'ping',
  'test-connection', 'new-pssession', 'enter-pssession']);
const GLOBAL_INSTALL = new Set(['winget', 'choco', 'scoop', 'rustup', 'install-module', 'install-package', 'install-script', 'brew', 'apt', 'apt-get',
  'msiexec', 'add-appxpackage']);

// Value-taking parameters whose value is not a path.
const VALUE_PARAMS = new Set(['-value', '-itemtype', '-type', '-encoding', '-filter', '-include', '-exclude', '-name', '-newname', '-depth', '-erroraction',
  '-ea', '-warningaction', '-wa', '-pattern', '-delimiter', '-inputobject', '-stream', '-credential', '-format']);
const DEST_PARAMS = new Set(['-destination', '-dest', '-destinationpath', '-path', '-literalpath', '-lp', '-filepath', '-outfile', '-target']);

// ---------- splitting a command line ----------
// A segment: { text, program, rawProgram, args: [{ text, static, param?, value? }], redirects: [text], dynamicProgram, opaque?: why }
function segOf(tokens, redirects = [], text = '') {
  const toks = tokens.filter((t) => t.text !== '' || t.quoted);
  if (!toks.length) return null;
  const [p, ...rest] = toks;
  return { text: text || toks.map((t) => t.text).join(' '), rawProgram: p.text, program: progName(p.text), dynamicProgram: !p.static,
    args: rest.map((t) => ({ text: t.text, static: t.static !== false, param: /^-{1,2}[a-z]|^\/[a-z?]{1,3}$/i.test(t.text) && !t.quoted })), redirects };
}

// cmd.exe: & && || | separate commands; ( ) group; ^ escapes and %VAR% expansions are not trusted.
function splitCmd(line) {
  const segs = []; let toks = [], tok = null, redirects = [], opaque = null, quoted = false;
  const push = () => { if (tok) toks.push(tok); tok = null; };
  const end = () => { push(); const s = segOf(toks, redirects); if (s) segs.push(s); toks = []; redirects = []; };
  const add = (c) => { tok ??= { text: '', static: true, quoted: false }; tok.text += c; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quoted = !quoted; tok ??= { text: '', static: true, quoted: true }; tok.quoted = true; continue; }
    if (quoted) { add(c); continue; }
    if (c === '^') { opaque = 'it uses ^ escapes'; add(line[++i] || ''); continue; }
    if (c === '&' || c === '|') { end(); if (line[i + 1] === c) i++; continue; }
    if (c === '(' || c === ')') { push(); continue; }
    if (c === '>' || c === '<') {
      if (tok && /^\d$/.test(tok.text)) tok = null; else push();
      if (line[i + 1] === '>') i++;
      if (line[i + 1] === '&') { i += 2; continue; }
      let j = i + 1; while (line[j] === ' ') j++;
      let target = ''; let q = false;
      for (; j < line.length; j++) { const d = line[j]; if (d === '"') { q = !q; continue; } if (!q && /[\s&|<>()]/.test(d)) break; target += d; }
      if (c === '>') redirects.push(target);
      i = j - 1; continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    add(c);
  }
  if (quoted) opaque = 'it has unbalanced quotes';
  end();
  for (const s of segs) {
    const p = s.rawProgram;
    if (/%[^%\s]+%|![^!\s]+!/.test(p)) { s.dynamicProgram = true; }
    for (const a of s.args) if (/%[^%\s]+%|![^!\s]+!/.test(a.text)) a.static = false;
    if (s.program === 'for') s.opaque = 'cmd loops (for /f) can run anything';
  }
  return { segs, opaque };
}

// bash: ; && || | & and newlines separate; $( ) ` ` <( ) can't be checked; $VAR makes an argument dynamic.
function splitBash(line) {
  const segs = []; let toks = [], tok = null, redirects = [], opaque = null;
  const push = () => { if (tok) toks.push(tok); tok = null; };
  const end = () => { push(); while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0].text)) toks.shift(); const s = segOf(toks, redirects); if (s) segs.push(s); toks = []; redirects = []; };
  const add = (c, dyn = false) => { tok ??= { text: '', static: true, quoted: false }; tok.text += c; if (dyn) tok.static = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) { opaque = 'it has unbalanced quotes'; break; } tok ??= { text: '', static: true, quoted: true }; tok.text += line.slice(i + 1, j); tok.quoted = true; i = j; continue; }
    if (c === '"') {
      tok ??= { text: '', static: true, quoted: true }; tok.quoted = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\') { tok.text += line[++j] || ''; continue; }
        if (line[j] === '`' || (line[j] === '$' && line[j + 1] === '(')) opaque = 'it runs a command inside another';
        if (line[j] === '$') tok.static = false;
        tok.text += line[j];
      }
      if (j >= line.length) opaque = 'it has unbalanced quotes';
      i = j; continue;
    }
    if (c === '\\') { add(line[++i] || ''); continue; }
    if (c === '`' || (c === '$' && line[i + 1] === '(') || ((c === '<' || c === '>') && line[i + 1] === '(')) { opaque = 'it runs a command inside another'; add(c, true); continue; }
    if (c === '$') { add(c, true); continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && line[i + 1] === '>') { /* &> file */ } else { end(); if ((c === '&' || c === '|') && line[i + 1] === c) i++; continue; }
    }
    if (c === '>' || c === '<' || (c === '&' && line[i + 1] === '>')) {
      if (tok && /^\d$/.test(tok.text)) tok = null; else push();
      if (c === '&') i++;
      if (line[i + 1] === '>') i++;
      if (line[i + 1] === '&') { i += 2; continue; }
      let j = i + 1; while (line[j] === ' ') j++;
      let target = '';
      for (; j < line.length && !/[\s;&|<>]/.test(line[j]); j++) target += line[j];
      if (c !== '<') redirects.push(target);
      i = j - 1; continue;
    }
    if (c === '{' || c === '}') { if (/[,.]/.test(line.slice(i, line.indexOf('}', i)))) opaque = 'it uses brace expansion'; }
    if (/\s/.test(c)) { push(); continue; }
    add(c);
  }
  end();
  for (const s of segs) if (['eval', 'source', '.', 'exec', 'xargs'].includes(s.program)) s.opaque = `${s.program} runs text as a command`;
  return { segs, opaque };
}

async function splitPowerShell(line) {
  let r;
  try { r = await parsePowerShell(line); } catch (e) { return { segs: [], opaque: `PowerShell's parser isn't available (${e.message})` }; }
  if (r.errors.length) return { segs: [], opaque: `PowerShell can't parse it: ${r.errors[0]}` };
  const segs = r.commands.map((c) => {
    const resolved = c.resolved || c.name;
    const args = [];
    for (const a of c.args) {
      if (a.t === 'param') { args.push({ text: a.text, static: true, param: true }); if (a.value != null) args.push({ text: String(a.value).replace(/^["']|["']$/g, ''), static: !!a.static }); }
      else args.push({ text: a.text, static: !!a.static, kind: a.kind });
    }
    const s = { text: c.text, rawProgram: c.name, program: progName(resolved), dynamicProgram: !c.nameStatic, args, redirects: c.redirects };
    if (c.invocation && c.invocation !== 'Unknown' && !c.nameStatic) s.dynamicProgram = true;
    return s;
  });
  return { segs, opaque: r.members.length ? `it calls .NET directly (${r.members[0].slice(0, 60)})` : null };
}

// ---------- paths ----------
function expandVars(text, env) {
  let unresolved = false;
  let s = String(text).replace(/^["']|["']$/g, '');
  s = s.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_()]*)\}?/gi, (m, k) => { const v = envGet(env, k); if (v == null) unresolved = true; return v ?? ''; });
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, k) => { const v = envGet(env, k); if (v == null) unresolved = true; return v ?? ''; });
  s = s.replace(/\$HOME\b|\$\{HOME\}/g, () => os.homedir());
  if (/^~(?=$|[\\/])/.test(s)) s = os.homedir() + s.slice(1);
  if (/\$[A-Za-z_{(]/.test(s) || s.includes('$_') || s.includes('`')) unresolved = true;
  return { path: s, unresolved };
}
const envGet = (env, k) => { const hit = Object.keys(env).find((x) => x.toLowerCase() === String(k).toLowerCase()); return hit ? env[hit] : null; };
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (p, dir) => (WIN ? p.toLowerCase().startsWith(dir.toLowerCase() + path.sep) : p.startsWith(dir + path.sep));

/** Where an absolute path is: { zone: 'blocked' | 'protected' | 'inside' | 'outside', why }. */
export function zoneOf(abs, root) {
  const p = realish(path.resolve(abs));
  const proj = realish(path.resolve(root));
  if (/^[a-z]:\\?$/i.test(p) || p === '/' || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p)) return { zone: 'blocked', why: 'a drive root' };
  const home = realish(os.homedir());
  if (same(p, home)) return { zone: 'blocked', why: 'your profile folder' };
  if (same(path.dirname(p), home) && !inside(proj, p) && !same(proj, p)) return { zone: 'blocked', why: `a folder in your profile (${path.basename(p)})` };
  for (const sys of [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter(Boolean)) {
    if (same(p, sys) || inside(p, sys)) return { zone: 'blocked', why: `a system folder (${sys})` };
  }
  const data = path.join(HOME, 'data');
  if (same(p, data) || inside(p, data) || SECRET_FILES.some((f) => same(p, realish(f)))) return { zone: 'blocked', why: 'QuorX’s own data' };
  if (same(p, proj)) return { zone: 'blocked', why: 'the project folder itself' };
  if (inside(proj, p)) return { zone: 'blocked', why: 'a folder above your project' };
  if (inside(p, proj)) {
    const rel = path.relative(proj, p).split(path.sep).map(low);
    if (rel.includes('.git')) return { zone: 'protected', why: 'git’s own folder (.git)' };
    if (rel[0] === '.quorx' && rel[1] !== 'scratch') return { zone: 'protected', why: 'QuorX’s own files (.quorx)' };
    return { zone: 'inside', why: '' };
  }
  return { zone: 'outside', why: '' };
}

/** The agent's file tools may not write here (the harness's own config, git internals, other tools' config). */
export function agentWriteBlocked(rel) {
  const r = low(String(rel).replaceAll('\\', '/').replace(/^\.?\/+/, ''));
  if (/^\.quorx(\/|$)/.test(r) && !/^\.quorx\/scratch(\/|$)/.test(r)) return 'QuorX’s own files (.quorx) are off limits, except .quorx/scratch';
  if (/(^|\/)\.git(\/|$)/.test(r)) return 'git’s own folder (.git) is off limits (its hooks run code)';
  if (/^\.claude(\/|$)/.test(r)) return 'the .claude folder holds another tool’s settings and is off limits';
  if (/^\.vscode\/(tasks|launch)\.json$/.test(r)) return `.vscode/${r.split('/').pop()} runs commands in VS Code and is off limits`;
  return '';
}

function countMatches(abs) {
  try {
    const dir = path.dirname(abs), base = path.basename(abs);
    if (!/[*?]/.test(base)) {
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return 1;
      let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (++n > 1000) return; if (e.isDirectory()) walk(path.join(d, e.name)); } }; walk(abs);
      return n;
    }
    const rx = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return fs.readdirSync(dir).filter((f) => rx.test(f)).length;
  } catch { return 0; }
}

// ---------- classes ----------
const sub = (s, i = 0) => low(s.args.filter((a) => !a.param)[i]?.text);
const hasArg = (s, ...xs) => s.args.some((a) => xs.includes(low(a.text)));

function classify(s, shell) {
  const p = s.program, a1 = sub(s), words = s.args.map((a) => low(a.text));
  if (s.opaque) return { cls: 'opaque', why: s.opaque };
  if (p === 'sc' && shell !== 'powershell' && shell !== 'pwsh') return { cls: 'never', why: 'sc changes Windows services' };
  if (KILLERS.has(p)) return { cls: 'opaque', why: `${s.rawProgram} can end your other programs` };
  if (s.dynamicProgram) return { cls: 'opaque', why: 'the program name comes from a variable' };
  if (s.args.some((a) => /^\\\\/.test(a.text)) || /^\\\\/.test(s.rawProgram)) return { cls: 'opaque', why: 'it uses a network (UNC) path' };
  if (hasArg(s, '-verb') && words.includes('runas')) return { cls: 'never', why: 'it asks for administrator rights' };
  if (s.args.some((a) => /^(hklm|hkey_local_machine|hkcr|hku)\b/i.test(a.text)) || (/itemproperty$/.test(p) && s.args.some((a) => /^hk/i.test(a.text)))) return { cls: 'never', why: 'it changes the Windows registry' };
  if (p === 'reg' && ['query', 'compare'].includes(a1)) return { cls: 'read', why: '' };
  if (p === 'net' && ['view', 'statistics'].includes(a1)) return { cls: 'read', why: '' };
  if (NEVER.has(p)) return { cls: 'never', why: `${s.rawProgram} changes your system` };
  if (GLOBAL_INSTALL.has(p)) return { cls: 'install', global: true, why: `${s.rawProgram} installs for the whole computer` };
  // Interpreters and shells running inline code
  if (INTERPRETERS.has(p)) {
    const inline = { python: ['-c'], python3: ['-c'], py: ['-c'], node: ['-e', '-p', '--eval', '--print'], deno: ['eval'], bun: ['-e', '--eval'],
      ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], lua: ['-e'], powershell: ['-c', '-command', '-encodedcommand', '-enc', '-ec', '-e'],
      pwsh: ['-c', '-command', '-encodedcommand', '-enc', '-ec', '-e'], cmd: ['/c', '/k', '/r'], bash: ['-c', '-lc'], sh: ['-c'], zsh: ['-c'] }[p] || [];
    if (words.some((w) => inline.includes(w)) || (['cmd', 'bash', 'sh', 'zsh', 'powershell', 'pwsh'].includes(p) && !s.args.length)) return { cls: 'opaque', why: `${s.rawProgram} would run code QuorX can't read first` };
    if (['powershell', 'pwsh'].includes(p) && !hasArg(s, '-file', '-f')) return { cls: 'opaque', why: `${s.rawProgram} would run code QuorX can't read first` };
    if (['powershell', 'pwsh'].includes(p)) return { cls: 'build', script: true, why: '' }; // -File: a script file, like python app.py
    if (['cmd', 'bash', 'sh', 'zsh', 'wsl'].includes(p)) return { cls: 'opaque', why: `${s.rawProgram} runs another shell` };
    // An interpreter with no script is a prompt: in the agent's terminal, whatever it types next runs unchecked.
    if (!s.args.some((a) => !a.param) && !words.some((w) => ['--version', '-v', '-V', '--help', '-h'].includes(w))) return { cls: 'opaque', why: `${s.rawProgram} with no script opens a prompt where anything typed runs unchecked` };
  }
  if (OPAQUE.has(p)) return { cls: 'opaque', why: `${s.rawProgram} runs other commands QuorX can't read first` };
  if (p === 'new-object' && hasArg(s, '-comobject')) return { cls: 'opaque', why: 'it starts a COM object' };
  if (p === 'find' && hasArg(s, '-delete', '-exec', '-execdir', '-ok')) return { cls: 'opaque', why: 'find -delete/-exec runs on files it finds' };
  // Version and help checks read only
  if (s.args.length && s.args.length <= 2 && s.args.every((a) => /^(--?version|-v|-V|version|--help|-h|\/\?|--info|-\?)$/i.test(a.text))) return { cls: 'read', why: '' };
  if (READ.has(p)) return { cls: 'read', why: '' };
  if (p === 'ping' || p === 'test-connection') { const host = low(s.args.find((a) => !a.param && !/^\d+$/.test(a.text))?.text); if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) return { cls: 'read', why: '' }; }
  // git
  if (p === 'git') {
    if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog', 'grep', 'whatchanged', 'ls-tree', 'cat-file'].includes(a1)) return { cls: 'read', why: '' };
    if (a1 === 'branch' && !hasArg(s, '-d', '-D', '--delete', '-m', '-M')) return { cls: 'read', why: '' };
    if (a1 === 'remote' && (s.args.length === 1 || hasArg(s, '-v', 'show', 'get-url'))) return { cls: 'read', why: '' };
    if (a1 === 'config' && hasArg(s, '--get', '--list', '-l', '--get-all')) return { cls: 'read', why: '' };
    if (a1 === 'stash' && hasArg(s, 'list', 'show')) return { cls: 'read', why: '' };
    if (['push', 'send-email', 'request-pull'].includes(a1)) return { cls: 'external', why: 'git push changes a remote repository' };
    if (a1 === 'clean' || (a1 === 'reset' && hasArg(s, '--hard')) || (a1 === 'checkout' && words.includes('--')) || (a1 === 'restore' && !hasArg(s, '--staged', '-S')) || (a1 === 'stash' && hasArg(s, 'drop', 'clear')) || (a1 === 'branch' && hasArg(s, '-D'))) return { cls: 'discard', why: `git ${a1} throws away work that isn't committed` };
    if (['pull', 'fetch', 'clone', 'submodule'].includes(a1)) return { cls: 'install', why: `git ${a1} downloads code` };
    if (a1 === 'config' && hasArg(s, '--global', '--system')) return { cls: 'unknown', why: 'it changes git settings for every repository' };
    return { cls: 'build', why: '' };
  }
  // package managers
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(p)) {
    if (['publish', 'login', 'adduser', 'logout', 'unpublish', 'deprecate', 'owner', 'dist-tag', 'token', 'access', 'team'].includes(a1)) return { cls: 'external', why: `${p} ${a1} changes the package registry` };
    if (hasArg(s, '-g', '--global', '--location=global')) return { cls: 'install', global: true, why: `${p} ${a1 || ''} -g installs for the whole computer`.replace('  ', ' ') };
    if (['install', 'i', 'add', 'in', 'isntall', 'update', 'up', 'upgrade'].includes(a1) && s.args.filter((a) => !a.param).length > 1) return { cls: 'install', why: `${p} ${a1} adds packages` };
    if (['list', 'ls', 'view', 'info', 'outdated', 'why', 'explain', 'config', 'bin', 'root', 'prefix', 'audit', 'search', 'help'].includes(a1)) return { cls: 'read', why: '' };
    return { cls: 'build', why: '' };
  }
  if (['pip', 'pip3', 'uv', 'poetry', 'pipenv'].includes(p) || ((p === 'python' || p === 'python3' || p === 'py') && words[0] === '-m' && ['pip', 'uv'].includes(words[1]))) {
    const w = p.startsWith('py') && words[0] === '-m' ? low(s.args.filter((a) => !a.param)[1]?.text) : a1;
    if (['list', 'show', 'freeze', 'check', 'tree', 'help'].includes(w)) return { cls: 'read', why: '' };
    if (['publish', 'upload'].includes(w)) return { cls: 'external', why: 'it publishes a package' };
    if (['install', 'add', 'sync', 'lock', 'update', 'download'].includes(w) || (p === 'uv' && w === 'pip')) return { cls: 'install', global: hasArg(s, '--user', '--system', '--global'), why: 'it installs packages' };
    if (w === 'uninstall' || w === 'remove') return { cls: 'write', why: '' };
    return { cls: 'build', why: '' };
  }
  if (p === 'cargo') {
    if (['publish', 'login', 'yank', 'owner', 'logout'].includes(a1)) return { cls: 'external', why: 'it changes crates.io' };
    if (a1 === 'install') return { cls: 'install', global: true, why: 'cargo install installs for the whole computer' };
    if (['add', 'update', 'fetch'].includes(a1)) return { cls: 'install', why: 'it adds or updates crates' };
    return { cls: 'build', why: '' };
  }
  if (p === 'dotnet') {
    if (a1 === 'nuget' && hasArg(s, 'push', 'delete')) return { cls: 'external', why: 'it changes a NuGet feed' };
    if (a1 === 'tool' && hasArg(s, '-g', '--global')) return { cls: 'install', global: true, why: 'it installs a tool for the whole computer' };
    if (a1 === 'add' || a1 === 'tool' || a1 === 'workload') return { cls: 'install', why: 'it adds packages' };
    if (['--info', '--list-sdks', '--list-runtimes', 'list', 'sln'].includes(a1) && !hasArg(s, 'add', 'remove')) return { cls: 'read', why: '' };
    return { cls: 'build', why: '' };
  }
  if (p === 'go') {
    if (a1 === 'install') return { cls: 'install', global: true, why: 'go install puts a program in your Go bin folder' };
    if (a1 === 'get' || (a1 === 'mod' && hasArg(s, 'download', 'tidy'))) return { cls: 'install', why: 'it downloads modules' };
    if (['env', 'version', 'list', 'doc'].includes(a1)) return { cls: 'read', why: '' };
    return { cls: 'build', why: '' };
  }
  if (['docker', 'podman'].includes(p) && ['push', 'login', 'logout'].includes(a1)) return { cls: 'external', why: `${p} ${a1} talks to a registry` };
  if (['docker', 'podman'].includes(p) && ['ps', 'images', 'version', 'info', 'logs', 'inspect'].includes(a1)) return { cls: 'read', why: '' };
  if (['docker', 'podman', 'docker-compose'].includes(p)) return { cls: 'unknown', why: `${p} can reach outside the project` };
  if (p === 'flutter' || p === 'dart') { if (a1 === 'pub' && hasArg(s, 'publish')) return { cls: 'external', why: 'it publishes a package' }; if (a1 === 'pub') return { cls: 'install', why: 'it fetches packages' }; return { cls: 'build', why: '' }; }
  if (EXTERNAL.has(p)) {
    if (['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(p)) {
      const local = s.args.some((a) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(a.text));
      if (local) return { cls: 'read', why: '' };
    }
    return { cls: 'external', why: `${s.rawProgram} reaches outside this computer` };
  }
  if (DELETE.has(p)) return { cls: 'delete', why: '' };
  if (WRITE.has(p)) return { cls: 'write', why: '' };
  if (BUILD.has(p)) return { cls: 'build', why: '' };
  // A script or program inside the project runs project code
  if (/[\\/]/.test(s.rawProgram) || /\.(ps1|bat|cmd|exe|sh|py|js)$/i.test(s.rawProgram)) return { cls: 'build', script: true, why: '' };
  return { cls: 'unknown', why: '' };
}

// The paths a command touches, with their zones. Deletes and writes look at their arguments; every command's
// redirections (> file) are writes.
function pathsOf(s, c, ctx) {
  const out = [];
  const add = (text, kind, redirect = false) => {
    if (!text || text === '-' || /^(nul|\$null|\/dev\/null|con)$/i.test(text)) return;
    const e = expandVars(text, ctx.env);
    if (e.unresolved || !e.path) { out.push({ raw: text, resolved: null, zone: 'unknown', kind, redirect, why: 'it can’t be resolved before running' }); return; }
    if (!path.isAbsolute(e.path) && ctx.cwdUnknown) { out.push({ raw: text, resolved: null, zone: 'unknown', kind, redirect, why: 'it is relative to a folder QuorX can’t work out' }); return; }
    const abs = path.isAbsolute(e.path) ? e.path : path.resolve(ctx.cwd, e.path);
    if (/[*?]/.test(path.dirname(abs))) { out.push({ raw: text, resolved: abs, zone: 'unknown', kind, redirect, why: 'a wildcard in a folder name can match anything' }); return; }
    let z;
    if (/[*?]/.test(path.basename(abs))) {
      // A wildcard: what matters is the folder it matches in. Everything in a blocked folder is blocked too
      // (C:\*, ~\*); in the project folder itself, the matches are inside the project.
      const zd = zoneOf(path.dirname(abs), ctx.root);
      z = zd.zone === 'blocked' && zd.why !== 'the project folder itself' ? zd : zoneOf(path.join(path.dirname(abs), 'qx-wildcard-match'), ctx.root);
    } else z = zoneOf(abs, ctx.root);
    out.push({ raw: text, resolved: abs, zone: z.zone, why: z.why, kind, redirect, wildcard: /[*?]/.test(path.basename(abs)) });
  };
  for (const r of s.redirects || []) add(r, 'write', true);
  if (c.cls === 'delete' || c.cls === 'write') {
    let skip = false, plain = 0;
    for (const a of s.args) {
      if (skip) { skip = false; continue; }
      if (a.param) { if (VALUE_PARAMS.has(low(a.text))) skip = true; continue; }
      if (a.kind === 'ScriptBlockExpressionAst') continue;
      plain++;
      // Set-Content/Add-Content/Out-File take content after the path; only the first plain argument is the path.
      if (['set-content', 'add-content', 'out-file', 'tee-object'].includes(s.program) && plain > 1) continue;
      // A move deletes its source (the first argument) and writes its destination.
      add(a.text, c.cls === 'delete' || (MOVES.has(s.program) && plain === 1) ? 'delete' : 'write');
    }
  }
  return out;
}

// ---------- rules ----------
export const ruleText = (s) => [s.program, ...s.args.map((a) => a.text)].join(' ').replace(/\s+/g, ' ').trim();
const ruleRx = (m) => new RegExp(`^${String(m).trim().replace(/\s+/g, ' ').replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const RUNNER = /^(python3?|py|node|npx|uv(\s+run)?|uvx|powershell|pwsh|cmd|bash|sh|deno|bun|ruby|perl|php)\s*\*?$/i;
/** Rules that are ignored while YOLO is on: wildcards on interpreters and package runners each allow any code. */
export const yoloIgnored = (rule) => RUNNER.test(String(rule.match || '').replace(/\*\s*$/, '').trim()) && /\*\s*$/.test(String(rule.match || ''));

function matchRules(text, rules, mode) {
  const hits = { deny: null, ask: null, allow: null };
  for (const r of rules || []) {
    if (!r || !r.match || !['allow', 'ask', 'deny'].includes(r.effect)) continue;
    if (mode === 'yolo' && r.effect === 'allow' && yoloIgnored(r)) continue;
    if (!hits[r.effect] && ruleRx(r.match).test(text)) hits[r.effect] = r;
  }
  return hits;
}

// Suggested rules for "Always allow…": this exact command, commands starting like it, or any use of the program.
function suggestions(s) {
  const plain = s.args.filter((a) => !a.param).map((a) => a.text);
  const exact = ruleText(s);
  const prefix = plain.length ? `${s.program} ${plain[0]}*` : `${s.program}*`;
  return { exact, prefix, program: `${s.program}*` };
}

// ---------- the decision ----------
const RANK = { allow: 0, ask: 1, deny: 2 };

/**
 * Decides what happens to a command line before it runs.
 * ctx: { shell: 'powershell'|'pwsh'|'cmd'|'bash'|'direct', root, cwd?, env?, rules: [{effect, match, by, scope}], mode: 'strict'|'yolo',
 *        yolo: { external, opaque, outside } (what the deciders may approve) }
 * Returns { verdict: 'allow'|'ask'|'deny', who: 'user'|'deciders'|null, why, decidedBy, segments: [...], hint? }.
 */
export async function decide(line, ctx) {
  const shell = ctx.shell || 'powershell';
  const root = path.resolve(ctx.root);
  const c = { root, cwd: path.resolve(ctx.cwd || root), env: ctx.env || process.env };
  const text = String(line || '').trim();
  if (!text) return { verdict: 'deny', who: null, why: 'empty command', decidedBy: 'code', segments: [] };
  const split = shell === 'powershell' || shell === 'pwsh' ? await splitPowerShell(text) : shell === 'bash' ? splitBash(text) : splitCmd(text);
  const segments = [];
  if (split.opaque || !split.segs.length) {
    const why = split.opaque || 'QuorX could not find a command in it';
    segments.push({ text, program: '', cls: 'opaque', why, verdict: 'ask', who: 'user', decidedBy: 'class:opaque', paths: [] });
  }
  for (const s of split.segs) {
    const k = classify(s, shell);
    const paths = pathsOf(s, k, c);
    const seg = { text: s.text, program: s.program, cls: k.cls, why: k.why, global: !!k.global, paths, rule: null, suggest: suggestions(s) };
    // cd with a static target moves the folder later commands' relative paths start from.
    if (['cd', 'chdir', 'set-location', 'push-location'].includes(s.program)) {
      const t = s.args.find((a) => !a.param);
      const e = t ? expandVars(t.text, c.env) : null;
      if (e && !e.unresolved && !c.cwdUnknown) c.cwd = path.resolve(c.cwd, e.path); else if (t) c.cwdUnknown = true;
    }
    if (s.program === 'pop-location') c.cwdUnknown = true;
    let v = 'allow', who = null, by = `class:${k.cls}`, why = k.why;
    const blocked = paths.find((p) => p.zone === 'blocked' || p.zone === 'protected');
    const unknownPath = paths.find((p) => p.zone === 'unknown');
    const outside = paths.find((p) => p.zone === 'outside');
    if (k.cls === 'never') { v = 'deny'; why = k.why || 'this command is never allowed'; }
    else if (blocked) { v = 'deny'; by = 'path'; why = `it would ${blocked.kind === 'write' ? 'write to' : 'delete or move'} ${blocked.why}`; }
    else if (k.cls === 'delete' && !unknownPath && !outside) {
      const recursive = s.args.some((a) => /^(-recurse|-r|-rf|-fr|\/s|--recursive)$/i.test(a.text)) || s.program === 'rimraf' || s.program === 'del-cli';
      const many = paths.reduce((n, p) => n + (p.resolved ? countMatches(p.resolved) : 0), 0);
      if (recursive || many > 20) { v = 'deny'; by = 'code'; why = `it deletes ${recursive ? 'a whole folder' : `${many} files`}`; seg.hint = 'Use delete_file instead: it moves files and folders to .quorx/trash, so the user can get them back.'; }
    }
    else if (unknownPath) { v = 'ask'; who = 'user'; by = 'path'; why = `a path it touches (${unknownPath.raw}) ${unknownPath.why}`; }
    else if (outside) { v = 'ask'; who = ctx.yolo?.outside ? 'deciders' : 'user'; by = 'path'; why = `it ${outside.kind === 'write' ? 'writes' : 'deletes or moves'} outside the project (${outside.resolved})`; }
    else if (k.cls === 'opaque') { v = 'ask'; who = ctx.yolo?.opaque ? 'deciders' : 'user'; why = k.why || 'QuorX can’t check it'; }
    else if (k.cls === 'external') { v = 'ask'; who = ctx.yolo?.external ? 'deciders' : 'user'; }
    else if (k.cls === 'discard') { v = 'ask'; who = 'user'; }
    else if (k.cls === 'install' && k.global) { v = 'ask'; who = 'user'; }
    else if (['build', 'install', 'unknown'].includes(k.cls)) { v = 'ask'; who = 'deciders'; why = why || (k.cls === 'unknown' ? 'no rule covers this command' : `no rule allows ${seg.suggest.prefix.replace(/\*$/, '')} yet`); }
    // Rules
    if (v !== 'deny' || (by !== 'path' && k.cls !== 'never' && by !== 'code')) {
      const hits = matchRules(ruleText(s), ctx.rules, ctx.mode);
      if (hits.deny) { v = 'deny'; who = null; by = `rule:${hits.deny.scope || 'project'}`; why = `your rule denies “${hits.deny.match}”`; seg.rule = hits.deny; }
      else if (hits.ask && v === 'allow') { v = 'ask'; who = 'user'; by = `rule:${hits.ask.scope || 'project'}`; why = `your rule asks for “${hits.ask.match}”`; seg.rule = hits.ask; }
      else if (hits.ask) { who = 'user'; seg.rule = hits.ask; }
      else if (hits.allow && v === 'ask') {
        const liftable = ['build', 'install', 'unknown', 'read', 'write'].includes(k.cls) && !k.global && !unknownPath && !outside;
        const userOnly = ['opaque', 'external', 'discard'].includes(k.cls) || k.global || outside;
        if (liftable || (userOnly && hits.allow.by === 'user' && !unknownPath)) { v = 'allow'; who = null; by = `rule:${hits.allow.scope || 'project'}`; why = `your rule allows “${hits.allow.match}”`; seg.rule = hits.allow; }
      }
    }
    if (ctx.mode !== 'yolo' && v === 'ask') who = 'user';
    Object.assign(seg, { verdict: v, who, decidedBy: by, why });
    segments.push(seg);
  }
  // The strictest command decides; one that needs you makes the whole line need you.
  let top = segments[0];
  for (const s of segments) if (RANK[s.verdict] > RANK[top.verdict] || (s.verdict === top.verdict && s.who === 'user' && top.who !== 'user')) top = s;
  return { verdict: top.verdict, who: top.verdict === 'ask' ? (segments.some((s) => s.verdict === 'ask' && s.who === 'user') ? 'user' : 'deciders') : null,
    why: top.why, decidedBy: top.decidedBy, hint: segments.find((s) => s.hint)?.hint, segments, shell };
}

// ---------- rule storage ----------
// Rules live in data/permissions.json (everywhere) and <project>/.quorx/permissions.json (one project). The agent
// can't write either: .quorx is off limits to its file tools, and data/ is blocked for commands.
const globalFile = () => path.join(HOME, 'data', 'permissions.json');
const projectFile = (root) => path.join(root, '.quorx', 'permissions.json');
const readRules = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j.rules) ? j.rules : []; } catch { return []; } };
const cleanRule = (r) => ({ effect: ['allow', 'ask', 'deny'].includes(r.effect) ? r.effect : 'ask', match: String(r.match || '').trim().replace(/\s+/g, ' ').slice(0, 300),
  by: r.by === 'button' ? 'button' : 'user', note: String(r.note || '').slice(0, 200), at: r.at || Date.now() });

/** Every rule that applies in a project: the project's first, then everywhere's. Each carries its scope. */
export function loadRules(root) {
  return [...(root ? readRules(projectFile(root)).map((r) => ({ ...r, scope: 'project' })) : []), ...readRules(globalFile()).map((r) => ({ ...r, scope: 'everywhere' }))];
}
/** Replaces the rules of one scope ('project' needs root). */
export function saveRules(scope, rules, root) {
  const f = scope === 'project' ? projectFile(root) : globalFile();
  const list = (Array.isArray(rules) ? rules : []).map(cleanRule).filter((r) => r.match);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: 1, rules: list }, null, 2));
  return list;
}
/** Adds one rule (from "Always allow…" or the panel). */
export function addRule(scope, rule, root) {
  const cur = scope === 'project' ? readRules(projectFile(root)) : readRules(globalFile());
  const r = cleanRule(rule);
  if (!r.match) throw new Error('a rule needs a pattern');
  const next = [...cur.filter((x) => !(x.match === r.match && x.effect === r.effect)), r];
  return saveRules(scope, next, root);
}

// ---------- suggested rules from the toolchains a project uses ----------
const MARKERS = [
  ['Cargo.toml', ['cargo build*', 'cargo check*', 'cargo test*', 'cargo run*', 'cargo fmt*', 'cargo clippy*']],
  [/\.(csproj|fsproj|sln|slnx)$/i, ['dotnet build*', 'dotnet test*', 'dotnet run*', 'dotnet restore*', 'dotnet format*']],
  ['go.mod', ['go build*', 'go test*', 'go vet*', 'go run*', 'gofmt*']],
  ['CMakeLists.txt', ['cmake*', 'ctest*']],
  [/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/, ['gradle build*', 'gradle test*', '.\\gradlew build*', '.\\gradlew test*']],
  ['pom.xml', ['mvn compile*', 'mvn test*', 'mvn package*']],
  ['package.json', ['npm run *', 'npm test*', 'npm ci*', 'npx tsc*']],
  [/^(pyproject\.toml|requirements\.txt|setup\.py)$/, ['pytest*', 'python -m pytest*', 'ruff*', 'mypy*']],
  ['pubspec.yaml', ['flutter build*', 'flutter test*', 'dart test*']],
];
/** Build rules a project's files suggest, minus ones already present. [{ match, why }] */
export function suggestedRules(root, existing = []) {
  let files = [];
  try { files = fs.readdirSync(root); } catch { return []; }
  const have = new Set(existing.map((r) => low(r.match)));
  const out = [];
  for (const [m, rules] of MARKERS) {
    const hit = files.find((f) => (typeof m === 'string' ? f === m : m.test(f)));
    if (hit) for (const r of rules) if (!have.has(low(r))) out.push({ match: r, why: `found ${hit}` });
  }
  return out;
}
