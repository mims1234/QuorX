// The rule engine: decides, before a command runs, whether it runs, asks, or is blocked (docs/shell-safety-plan.md §1–2).
//   1. Split the line into commands. PowerShell lines go through PowerShell's own parser (jobhost.ps1 "parse");
//      cmd, bash and zsh lines through small, conservative tokenizers. Anything they can't read is "opaque".
//   2. Give each command a class (read, write, build, install, external, opaque, delete, discard, never, unknown).
//      A script it runs from the project is read first: one that runs other programs is opaque (see "scripts").
//   3. Resolve every path a delete or write touches to its real target (~, $env:X, %X%, junctions, 8.3 names).
//      Drive roots, your profile and its folders, system folders (Windows, macOS and Linux ones), other people's
//      profiles, folders above the project, the project folder itself, .git and QuorX's own files are blocked outright.
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
// Windows and macOS file names ignore case (macOS's usual APFS volumes do), so the path checks do too.
const FOLD = WIN || process.platform === 'darwin';
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
  'out-null', 'write-error', 'write-warning', 'write-verbose', 'write-information',
  // macOS and Linux
  ':', 'printf', 'env', 'printenv', 'uname', 'id', 'ps', 'top', 'df', 'du', 'file', 'stat', 'less', 'realpath', 'readlink', 'type', 'test', '[',
  'cut', 'tr', 'column', 'nl', 'od', 'hexdump', 'strings', 'cmp', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'jq', 'lsof',
  'sw_vers', 'system_profiler', 'mdfind', 'mdls', 'otool', 'nm', 'lipo', 'pgrep', 'journalctl', 'lsb_release', 'nproc', 'free', 'uptime', 'apt-cache']);
const WRITE = new Set(['new-item', 'ni', 'mkdir', 'md', 'set-content', 'add-content', 'out-file', 'copy-item', 'cp', 'copy', 'xcopy', 'touch',
  'tee-object', 'expand-archive', 'compress-archive', 'rename-item', 'ren', 'rename', 'move-item', 'mv', 'move', 'robocopy', 'tar', 'unzip', 'zip', '7z',
  'tee', 'ln', 'chmod', 'chown', 'chgrp', 'ditto', 'xattr', 'chflags', 'truncate']);
const DELETE = new Set(['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'rimraf', 'del-cli', 'clear-content', 'clear-item', 'trash', 'unlink', 'shred', 'srm']);
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
  'call', 'forfiles', 'powershell_ise', 'explorer', 'open', 'xdg-open', 'gio', 'watch', 'parallel', 'flock', 'script', 'busybox', 'awk', 'gawk',
  'nawk', 'expect', 'nsenter', 'chroot', 'unshare', 'trap']);
const NEVER = new Set(['format', 'format-volume', 'diskpart', 'bcdedit', 'vssadmin', 'cipher', 'set-executionpolicy', 'net', 'net1', 'netsh',
  'schtasks', 'shutdown', 'stop-computer', 'restart-computer', 'takeown', 'wmic', 'bootrec', 'manage-bde', 'fsutil', 'mountvol', 'disable-computerrestore',
  'set-mppreference', 'add-mppreference', 'remove-mppreference', 'new-service', 'set-service', 'remove-service', 'register-scheduledtask',
  'unregister-scheduledtask', 'set-netfirewallrule', 'new-netfirewallrule', 'remove-netfirewallrule', 'new-localuser', 'set-localuser',
  'add-localgroupmember', 'enable-psremoting', 'sudo', 'runas', 'clear-recyclebin', 'clear-disk', 'initialize-disk', 'remove-partition',
  'set-partition', 'reg', 'regedit', 'bcdboot', 'sfc', 'dism', 'secedit', 'auditpol', 'gpupdate', 'mkfs', 'dd', 'icacls',
  'set-acl', 'remove-computer', 'add-computer', 'rename-computer', 'set-timezone', 'set-date', 'logoff',
  // macOS and Linux: services, scheduled jobs, users, disks, firewalls, boot, privacy and security settings
  'launchctl', 'systemctl', 'crontab', 'at', 'csrutil', 'spctl', 'tccutil', 'nvram', 'pmset', 'scutil', 'networksetup', 'systemsetup', 'dscl',
  'sysadminctl', 'kextload', 'kextunload', 'kmutil', 'bless', 'fdesetup', 'mount', 'umount', 'useradd', 'userdel', 'usermod', 'groupadd', 'passwd',
  'chpasswd', 'visudo', 'su', 'doas', 'pkexec', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'modprobe', 'insmod', 'rmmod', 'sysctl',
  'update-grub', 'grub-install', 'efibootmgr', 'reboot', 'halt', 'poweroff', 'telinit', 'chsh', 'fdisk', 'parted', 'sfdisk', 'wipefs',
  'mkswap', 'swapon', 'swapoff', 'cryptsetup', 'setenforce', 'chattr', 'diskutil', 'asr']);
// Read-only uses of programs that are otherwise never allowed.
const NEVER_READ = { systemctl: ['status', 'is-active', 'is-enabled', 'list-units', 'show', 'cat'], launchctl: ['list', 'print', 'blame'], crontab: ['-l'],
  diskutil: ['list', 'info'], spctl: ['--assess', '-a', '--status'], sysctl: ['-n', '-a', 'hw.ncpu', 'hw.memsize'], csrutil: ['status'] };
// Programs that end other processes: they could close your own programs, so they ask you.
const KILLERS = new Set(['taskkill', 'tskill', 'stop-process', 'spps', 'kill', 'pkill', 'killall']);
const EXTERNAL = new Set(['gh', 'glab', 'vercel', 'netlify', 'fly', 'flyctl', 'firebase', 'heroku', 'wrangler', 'az', 'aws', 'gcloud', 'kubectl',
  'helm', 'terraform', 'pulumi', 'ansible', 'ansible-playbook', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'curl', 'wget', 'invoke-webrequest', 'iwr',
  'invoke-restmethod', 'irm', 'start-bitstransfer', 'bitsadmin', 'nslookup', 'dig', 'resolve-dnsname', 'tracert', 'traceroute', 'test-netconnection',
  'tnc', 'telnet', 'nc', 'ncat', 'netcat', 'psql', 'mysql', 'sqlcmd', 'mongo', 'mongosh', 'redis-cli', 'send-mailmessage', 'twine', 'ping',
  'test-connection', 'new-pssession', 'enter-pssession']);
const GLOBAL_INSTALL = new Set(['winget', 'choco', 'scoop', 'rustup', 'install-module', 'install-package', 'install-script', 'brew', 'apt', 'apt-get',
  'msiexec', 'add-appxpackage', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'emerge', 'snap', 'flatpak', 'port', 'nix-env', 'mas', 'softwareupdate',
  'installer', 'dpkg', 'rpm', 'gem', 'pipx', 'xcode-select', 'xcodes', 'pyenv', 'rbenv', 'nvm', 'asdf', 'mise', 'sdk']);
// What these install tools can do without installing: listing and searching read only.
const INSTALL_READ = { brew: ['list', 'ls', 'info', 'search', '--prefix', '--cellar', '--repository', 'config', 'doctor', 'deps', 'uses', 'leaves', 'outdated', 'desc', 'shellenv'],
  apt: ['list', 'show', 'search', 'policy', 'depends', 'rdepends'], dnf: ['list', 'info', 'search', 'repolist', 'provides'], yum: ['list', 'info', 'search', 'repolist', 'provides'],
  zypper: ['search', 'se', 'info', 'if', 'list-updates', 'lu'], apk: ['info', 'search', 'list'], snap: ['list', 'info', 'find', 'version'], flatpak: ['list', 'info', 'search'],
  port: ['installed', 'info', 'search', 'list', 'contents', 'deps', 'outdated'], mas: ['list', 'search', 'info', 'outdated'], softwareupdate: ['-l', '--list', '--history'],
  dpkg: ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '--print-architecture'], gem: ['list', 'search', 'info', 'env', 'which', 'contents'],
  pipx: ['list', 'environment'], 'xcode-select': ['-p', '--print-path'], xcodes: ['list', 'installed', 'runtimes'], pyenv: ['versions', 'version', 'which', 'root'],
  rbenv: ['versions', 'version', 'which', 'root'], nvm: ['ls', 'list', 'current', 'which', 'ls-remote'], asdf: ['list', 'current', 'where', 'which'], mise: ['ls', 'list', 'current', 'where', 'which'],
  sdk: ['list', 'current', 'version'], 'nix-env': ['-q', '--query'], pacman: ['-Q', '-Qi', '-Ql', '-Qs', '-Ss', '-Si', '-Qe', '-Qdt'], rpm: ['-q', '-qa', '-qi', '-ql', '-qf'] };
// Programs that run the rest of their arguments as a command: what matters is that command. vals: options that
// take a value; skip: plain words before the command (timeout's duration); stop: options after which the program
// itself is the command (xcrun --find); bad: options that turn text into a command.
const WRAPPERS = { env: { vals: ['-u', '--unset', '-C', '--chdir'], bad: ['-S', '--split-string'], assigns: true }, nohup: {}, time: { vals: ['-f', '-o'] },
  command: { stop: ['-v', '-V'] }, builtin: {}, nice: { vals: ['-n', '--adjustment'] }, ionice: { vals: ['-c', '-n', '--class', '--classdata'] }, setsid: {},
  stdbuf: { vals: ['-i', '-o', '-e'] }, caffeinate: { vals: ['-t', '-w'] }, timeout: { vals: ['-s', '--signal', '-k', '--kill-after'], skip: 1 },
  gtimeout: { vals: ['-s', '--signal', '-k', '--kill-after'], skip: 1 }, unbuffer: {}, arch: {}, noglob: {}, nocorrect: {}, chronic: {},
  xcrun: { vals: ['--sdk', '-sdk', '--toolchain', '-toolchain'], stop: ['-f', '--find', '--show-sdk-path', '--show-sdk-version', '--show-sdk-build-version', '--show-sdk-platform-path', '--show-sdk-platform-version', '--show-toolchain-path'] } };

// Value-taking parameters whose value is not a path.
const VALUE_PARAMS = new Set(['-value', '-itemtype', '-type', '-encoding', '-filter', '-include', '-exclude', '-name', '-newname', '-depth', '-erroraction',
  '-ea', '-warningaction', '-wa', '-pattern', '-delimiter', '-inputobject', '-stream', '-credential', '-format']);
const DEST_PARAMS = new Set(['-destination', '-dest', '-destinationpath', '-path', '-literalpath', '-lp', '-filepath', '-outfile', '-target']);

// ---------- splitting a command line ----------
// A segment: { text, program, rawProgram, args: [{ text, static, param?, value? }], redirects: [text], dynamicProgram, opaque?: why }
function segOf(tokens, redirects = [], text = '') {
  const toks = tokens.filter((t) => t.text !== '' || t.quoted);
  // A redirection on its own (`> file`) still writes, so it is a command of its own: a no-op with that write.
  if (!toks.length) return redirects.length ? { text: text || `> ${redirects.join(' ')}`, rawProgram: ':', program: ':', dynamicProgram: false, args: [], redirects } : null;
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

// Strips wrapper programs (env, timeout, nohup, xcrun …) off the front of a command's words, so the command they
// run is the one judged. Words are { text, static }. Returns { words, why } (why: the wrapper turns text into a command).
function unwrapWords(words) {
  for (let n = 0; n < 8 && words.length && words[0].static !== false; n++) {
    const p = progName(words[0].text), w = WRAPPERS[p];
    if (!w) break;
    let i = 1;
    for (; i < words.length; i++) {
      const t = words[i].text;
      if (w.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      if (t === '--') { i++; break; }
      if (!/^-/.test(t) || words[i].quoted) break;
      if (w.bad?.includes(t.split('=')[0])) return { words, why: `${p} ${t} runs text as a command` };
      if (w.stop?.includes(t)) return { words };
      if (w.vals?.includes(t)) i++;
    }
    i += w.skip || 0;
    if (i >= words.length) break; // the wrapper alone (env prints the environment)
    words = words.slice(i);
  }
  return { words };
}

// Shell words that start or close a block (if … then, { …; }, ! cmd): the command after them is what runs.
const BLOCK_WORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done', 'esac', '[[', ']]']);
// Loops and definitions run their body with values QuorX can't know beforehand.
const BLOCK_OPAQUE = new Set(['for', 'case', 'select', 'function', 'coproc', 'repeat', 'foreach']);

// bash and zsh: ; && || | & and newlines separate; ( ) and { } group; $( ) ` ` <( ) can't be checked; $VAR makes an
// argument dynamic. zsh also expands =name to a program's path, and its glob qualifiers *(e:…:) run code.
function splitBash(line, zsh = false) {
  const segs = []; let toks = [], tok = null, redirects = [], opaque = null;
  const push = () => { if (tok) toks.push(tok); tok = null; };
  const end = () => {
    push();
    const text = toks.map((t) => t.text).join(' ');
    for (;;) {
      if (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0].text)) { toks.shift(); continue; }
      if (toks.length && !toks[0].quoted && BLOCK_WORDS.has(toks[0].text)) { toks.shift(); continue; }
      break;
    }
    while (toks.length && !toks[toks.length - 1].quoted && ['}', ']]'].includes(toks[toks.length - 1].text)) toks.pop();
    const u = unwrapWords(toks);
    const s = segOf(u.words, redirects, text);
    if (s && u.why) s.opaque = u.why;
    if (s && !u.why && toks[0] && !toks[0].quoted && BLOCK_OPAQUE.has(toks[0].text)) s.opaque = `a ${toks[0].text} block runs commands with values QuorX can't know beforehand`;
    if (s) segs.push(s);
    toks = []; redirects = [];
  };
  const add = (c, dyn = false) => { tok ??= { text: '', static: !(zsh && c === '='), quoted: false }; tok.text += c; if (dyn) tok.static = false; };
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
      if (line[i + 1] === '>' || (c === '>' && line[i + 1] === '|')) i++; // >> and >| (writes even with noclobber)
      // >&2 and >&- copy or close a stream; >& file writes to the file, like &>.
      if (line[i + 1] === '&') { if (/[\d-]/.test(line[i + 2] || '')) { i += 2; continue; } i++; }
      let j = i + 1; while (line[j] === ' ') j++;
      let target = '';
      for (; j < line.length && !/[\s;&|<>()]/.test(line[j]); j++) target += line[j];
      if (c !== '<') redirects.push(target);
      i = j - 1; continue;
    }
    // ( ) groups commands (a subshell); right after a word it defines a function or is a glob pattern (zsh's
    // qualifiers can run code), which QuorX can't read.
    if (c === '(' && tok && tok.text) { opaque = 'it defines a function or uses a pattern QuorX can\'t read'; add(c, true); continue; }
    if (c === '(' || c === ')') { end(); continue; }
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
  return { segs, opaque: r.members.length ? `it calls .NET directly (${r.members[0].slice(0, 60)})` : null, members: r.members };
}

// ---------- paths ----------
function expandVars(text, env) {
  let unresolved = false;
  let s = String(text).replace(/^["']|["']$/g, '');
  s = s.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_()]*)\}?/gi, (m, k) => { const v = envGet(env, k); if (v == null) unresolved = true; return v ?? ''; });
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, k) => { const v = envGet(env, k); if (v == null) unresolved = true; return v ?? ''; });
  s = s.replace(/\$HOME\b|\$\{HOME\}/g, () => os.homedir());
  if (/^~(?=$|[\\/])/.test(s)) s = os.homedir() + s.slice(1);
  else if (/^~./.test(s)) unresolved = true; // ~user, ~+ and ~- are other folders
  if (/\$[A-Za-z_{(]/.test(s) || s.includes('$_') || s.includes('`')) unresolved = true;
  return { path: s, unresolved };
}
const envGet = (env, k) => { const hit = Object.keys(env).find((x) => x.toLowerCase() === String(k).toLowerCase()); return hit ? env[hit] : null; };
const same = (a, b) => (FOLD ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (p, dir) => (FOLD ? p.toLowerCase().startsWith(dir.toLowerCase() + path.sep) : p.startsWith(dir + path.sep));

// macOS and Linux: the system's own folders, other people's profiles, and the parts of yours that hold keys,
// settings and programs that run at login. (Your profile and the folders directly in it are blocked by zoneOf.)
const POSIX_SYSTEM = {
  darwin: ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/private/var/db', '/private/var/root', '/opt', '/cores', '/nix'],
  linux: ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/sys', '/proc', '/dev', '/run', '/opt', '/srv', '/root', '/snap', '/nix', '/var'],
};
const HOME_KEEP = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/autostart', '.config/systemd', '.local/bin', 'Library'];
// Inside those, places a developer clears on purpose: they only ask.
const HOME_ASK = ['Library/Developer/Xcode/DerivedData', 'Library/Developer/CoreSimulator/Caches', 'Library/Caches'];
/**
 * Whether an absolute macOS or Linux path is off limits: { zone: 'blocked', why } or null. Pure (POSIX paths and
 * the platform passed in), so it is tested on any computer.
 */
export function posixSystemZone(p, { platform = process.platform, home = os.homedir() } = {}) {
  const P = path.posix, fold = platform === 'darwin';
  const eq = (a, b) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  const under = (a, d) => (fold ? a.toLowerCase().startsWith(`${d.toLowerCase()}/`) : a.startsWith(`${d}/`));
  const at = (a, d) => eq(a, d) || under(a, d);
  p = P.normalize(p).replace(/(.)\/+$/, '$1');
  home = P.normalize(home).replace(/(.)\/+$/, '$1');
  for (const k of HOME_ASK) if (at(p, P.join(home, k))) return null;
  for (const k of HOME_KEEP) if (at(p, P.join(home, k))) return { zone: 'blocked', why: k === 'Library' ? 'your Library folder (app data, keychains and settings)' : `your ${k} folder` };
  if (at(p, home)) return null;
  if (platform === 'linux' && (at(p, '/var/tmp'))) return null;
  for (const d of POSIX_SYSTEM[platform] || []) if (at(p, d)) return { zone: 'blocked', why: `a system folder (${d})` };
  // Every profile lives in /Users (macOS) or /home (Linux): the folder itself and other people's are off limits.
  const users = platform === 'darwin' ? '/Users' : '/home';
  if (eq(p, users)) return { zone: 'blocked', why: `the folder of every profile (${users})` };
  if (under(p, users) && !at(p, `${users}/Shared`)) return { zone: 'blocked', why: 'another person’s profile' };
  // Drives: /Volumes/<drive> on macOS, /mnt/<drive> and /media/<you>/<drive> on Linux (the drive itself, not inside it).
  const parts = p.split('/').filter(Boolean);
  if ((platform === 'darwin' && parts[0] === 'Volumes' && parts.length <= 2) || (platform === 'linux' && ((parts[0] === 'mnt' && parts.length <= 2) || (parts[0] === 'media' && parts.length <= 3)))) return { zone: 'blocked', why: 'a drive' };
  return null;
}

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
  if (!WIN && !same(p, proj) && !inside(p, proj)) { const z = posixSystemZone(p, { home }); if (z) return z; }
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

// The command sudo would run: its words after sudo's own options (-u user, -E …).
function sudoInner(s) {
  const a = s.args;
  let i = 0;
  for (; i < a.length && /^-/.test(a[i].text); i++) {
    if (a[i].text === '--') { i++; break; }
    if (/^-[ughpCDrtUT]$/.test(a[i].text)) i++;
  }
  return i < a.length ? segOf(unwrapWords(a.slice(i)).words, s.redirects, s.text) : null;
}
// Programs that are never allowed, used only to read (systemctl status, crontab -l, diskutil list).
function neverButRead(p, words) {
  if (p === 'sysctl') return !words.some((w) => w === '-w' || w.includes('='));
  if (p === 'crontab') return words.length === 1 && words[0] === '-l';
  return NEVER_READ[p].includes(words[0]);
}

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
  // sudo: an install for the whole computer asks you (it needs your password, which an agent command can't type);
  // anything else as administrator is never allowed.
  if (p === 'sudo') {
    const inner = sudoInner(s);
    const k = inner && !inner.dynamicProgram ? classify(inner, shell) : null;
    if (k?.cls === 'install' && k.global) return { cls: 'install', global: true, why: `sudo ${inner.rawProgram} installs for the whole computer as administrator. It needs your password, which an agent command can't type: run it yourself in a terminal tab` };
    return { cls: 'never', why: 'sudo runs it as administrator' };
  }
  if (NEVER_READ[p] && neverButRead(p, words)) return { cls: 'read', why: '' };
  if (NEVER.has(p) || /^mkfs(\.|$)/.test(p)) return { cls: 'never', why: `${s.rawProgram} changes your system` };
  if (p === 'security') {
    // The keychain holds your passwords. Listing code-signing identities and reading a provisioning profile are fine.
    if (a1 === 'find-identity' || (a1 === 'cms' && hasArg(s, '-d'))) return { cls: 'read', why: '' };
    return { cls: 'never', why: 'security reads and changes your keychain' };
  }
  if (p === 'defaults') {
    if (['read', 'read-type', 'export', 'domains', 'find'].includes(a1)) return { cls: 'read', why: '' };
    if (s.args.some((a) => /^(-g|-globalDomain|NSGlobalDomain|com\.apple\.)/i.test(a.text))) return { cls: 'never', why: 'it changes macOS settings' };
    return { cls: 'unknown', why: 'defaults changes an app\'s settings' };
  }
  if (GLOBAL_INSTALL.has(p)) {
    // Tools whose first option is the action (pacman -Qi, dpkg -L) are read as typed: case matters there.
    const action = ['pacman', 'rpm', 'dpkg', 'softwareupdate', 'xcode-select', 'nix-env'].includes(p) ? s.args[0]?.text : a1;
    if (INSTALL_READ[p]?.includes(action)) return { cls: 'read', why: '' };
    return { cls: 'install', global: true, why: `${s.rawProgram} installs for the whole computer` };
  }
  // command -v and xcrun --find only find a program; with a command after them, that command is judged.
  if (p === 'command' || p === 'xcrun') {
    const u = unwrapWords([{ text: s.rawProgram, static: true }, ...s.args]);
    if (u.words.length === s.args.length + 1) return { cls: 'read', why: '' };
    return classify(segOf(u.words, s.redirects, s.text), shell);
  }
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
  // Apple's tools (most arrive through xcrun, which is unwrapped).
  if (p === 'simctl') {
    const plain = s.args.filter((a) => !a.param).map((a) => low(a.text));
    if (['list', 'help', 'getenv', 'listapps', 'appinfo', 'get_app_container', 'pbpaste', 'pbinfo', 'bootstatus'].includes(a1)) return { cls: 'read', why: '' };
    if (['erase', 'delete', 'unpair'].includes(a1)) return { cls: 'discard', why: `simctl ${a1} deletes a simulator or its data` };
    if (a1 === 'runtime') return plain[1] === 'list' ? { cls: 'read', why: '' } : { cls: 'install', global: true, why: 'it adds or removes a simulator runtime for the whole computer' };
    // spawn runs a program of this Mac inside the simulator's setting: only its log reader is known.
    if (a1 === 'spawn') return plain[2] === 'log' ? { cls: 'read', why: '' } : { cls: 'opaque', why: 'simctl spawn runs another program' };
    if (a1 === 'io') return { cls: 'write', why: '' }; // a screenshot or video: where it is written is checked
    return { cls: 'build', why: '' };
  }
  if (p === 'xcodebuild') {
    if (hasArg(s, '-downloadplatform', '-downloadallplatforms', '-importplatform', '-runfirstlaunch', '-license')) return { cls: 'install', global: true, why: 'it changes Xcode for the whole computer' };
    if (hasArg(s, '-resolvepackagedependencies')) return { cls: 'install', why: 'it downloads Swift packages' };
    const acts = ['build', 'test', 'archive', 'clean', 'analyze', 'install', 'build-for-testing', 'test-without-building', 'docbuild'];
    if (hasArg(s, '-list', '-version', '-showsdks', '-showbuildsettings', '-showdestinations', '-checkfirstlaunchstatus', '-showtestplans') && !words.some((w) => acts.includes(w))) return { cls: 'read', why: '' };
    return { cls: 'build', why: '' };
  }
  if (p === 'swift' && a1 === 'package') {
    const w = low(s.args.filter((a) => !a.param)[1]?.text);
    if (['resolve', 'update', 'add-dependency'].includes(w)) return { cls: 'install', why: 'it downloads Swift packages' };
    if (w === 'publish') return { cls: 'external', why: 'it publishes a package' };
    if (['describe', 'dump-package', 'show-dependencies', 'compute-checksum'].includes(w)) return { cls: 'read', why: '' };
  }
  if (p === 'swift' && a1 === 'sdk' && hasArg(s, 'install', 'remove')) return { cls: 'install', global: true, why: 'it installs a Swift SDK for the whole computer' };
  if (p === 'plutil') return hasArg(s, '-p', '-lint', '-help', '-type') ? { cls: 'read', why: '' } : { cls: 'write', why: '' };
  if (p === 'log') return ['show', 'stream', 'help'].includes(a1) ? { cls: 'read', why: '' } : { cls: 'never', why: 'it changes or erases the system log' };
  if (['notarytool', 'altool'].includes(p)) return { cls: 'external', why: `${p} sends the app to Apple` };
  if (p === 'devicectl') return a1 === 'list' ? { cls: 'read', why: '' } : { cls: 'external', why: 'devicectl works on a real iPhone, iPad or watch connected to this Mac' };
  if (['pod', 'carthage'].includes(p)) {
    if (p === 'pod' && a1 === 'trunk') return { cls: 'external', why: 'it publishes a pod' };
    if (['install', 'update', 'bootstrap', 'repo'].includes(a1)) return { cls: 'install', why: `${p} ${a1} downloads dependencies` };
    return { cls: 'build', why: '' };
  }
  if (['xcresulttool', 'dwarfdump', 'atos', 'symbols'].includes(p)) return { cls: 'read', why: '' };
  if (['codesign', 'stapler', 'agvtool', 'xctrace', 'instruments', 'ibtool', 'actool', 'idb', 'lldb-dap', 'swift-format', 'swiftlint', 'xcbeautify'].includes(p)) return { cls: 'build', why: '' };
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

// ---------- scripts that run other programs ----------
// A script hides what it runs: "node run.mjs rustup toolchain install …" looks like "node runs a project script".
// So before a script inside the project runs, QuorX reads it (and the local files it loads). One that launches
// programs (child_process, subprocess, Start-Process, & $x, cmd /c…) or builds code while running is opaque, and when
// it reads its own arguments, those arguments are judged as a command of their own. PowerShell, batch and shell
// scripts are split into their commands: the ones that change the system, install for the whole computer, reach
// outside, throw work away or touch blocked paths become commands of the line.
const SCRIPT_MAX = 1024 * 1024;
const langOf = (f) => { const e = low(path.extname(String(f))); return /^\.(m?js|cjs|m?ts|cts)$/.test(e) ? 'js' : /^\.pyw?$/.test(e) ? 'py' : /^\.psm?1$/.test(e) ? 'ps' : /^\.(sh|bash)$/.test(e) ? 'sh' : /^\.(bat|cmd)$/.test(e) ? 'bat' : null; };
const RUNNERS = { node: 'js', bun: 'js', deno: 'js', tsx: 'js', 'ts-node': 'js', python: 'py', python3: 'py', py: 'py', pythonw: 'py', bash: 'sh', sh: 'sh', zsh: 'sh', powershell: 'ps', pwsh: 'ps', cmd: 'bat' };
const RUNNER_VALUED = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions', '--title', '-W', '-X']);
const SHELL_OF = { ps: 'powershell', sh: 'bash', bat: 'cmd' };
const LAUNCH = {
  js: {
    programs: /['"`](?:node:)?(?:child_process|execa|cross-spawn|shelljs|zx(?:\/globals)?|node-pty|tinyexec|nano-spawn|sudo-prompt|@vscode\/sudo-prompt)['"`]|\bBun\s*\.\s*(?:spawn|spawnSync|\$)|\bDeno\s*\.\s*(?:Command|run)\b|\bprocess\s*\.\s*_?(?:linkedB|b)inding\s*\(\s*['"`](?:spawn_sync|process_wrap)/,
    code: /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|['"`](?:node:)?vm['"`]/,
    argv: /\bprocess\s*\.\s*argv\b|\bDeno\s*\.\s*args\b|\bBun\s*\.\s*argv\b/,
  },
  py: {
    programs: /\b(?:subprocess|pexpect|plumbum|ctypes|win32api|win32process|win32com|pywinauto)\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|startfile|fork\w*)\s*\(|\bfrom\s+os\s+import\s+[^\n]*\b(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|startfile)\b|\bcreate_subprocess_(?:exec|shell)\b|\bpty\s*\.\s*spawn\b|^\s*(?:import|from)\s+sh\b/m,
    code: /(?<![\w.])(?:exec|eval|compile|__import__)\s*\(|\bimportlib\b|\brunpy\b/,
    argv: /\bsys\s*\.\s*argv\b|\bfrom\s+sys\s+import\s+[^\n]*\bargv\b/,
  },
  ps: { argv: /\$args\b|\bparam\s*\(/i },
  sh: { argv: /\$\{?[@*1-9]/ },
  bat: { argv: /%~?[1-9*]/ },
};
// Commands that run whatever they are given: inside a script, each one makes the script opaque.
const LAUNCHERS = new Set(['start-process', 'saps', 'start', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-job', 'start-threadjob',
  'invoke-item', 'ii', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32', 'eval', 'exec', 'source',
  '.', 'xargs', 'forfiles', 'for', 'invoke-wmimethod', 'invoke-cimmethod', 'set-alias', 'new-alias', 'sal', 'nal', 'runas', 'explorer', 'cross-env-shell']);
// How deep QuorX follows scripts that run scripts; deeper than this, the script counts as one it can't read.
const SCRIPT_DEPTH = 4;
// .NET calls that start a program or run text as code.
const LAUNCH_MEMBERS = /Diagnostics\.Process\]\s*::\s*Start|ProcessStartInfo|\[scriptblock\]\s*::\s*Create|\.(?:ShellExecute|InvokeScript|AddScript)\s*\(|InvokeCommand\s*\.\s*(?:InvokeScript|NewScriptBlock)/i;
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** The script a command runs, if it runs one: { file: arg, rest: [args after it], lang }. */
function scriptOf(s) {
  const raw = String(s.rawProgram || '').replace(/^["']|["']$/g, '');
  if (!s.dynamicProgram && langOf(raw)) return { file: { text: raw, static: true }, rest: s.args, lang: langOf(raw) };
  const a = s.args, lang = RUNNERS[s.program];
  if (!lang) return null;
  const at = (i) => (a[i] ? { file: a[i], rest: a.slice(i + 1), lang: langOf(a[i].text) || lang } : null);
  if (s.program === 'powershell' || s.program === 'pwsh') { const i = a.findIndex((x) => /^-f(ile)?$/i.test(x.text)); return i >= 0 ? at(i + 1) : null; }
  if (s.program === 'cmd') { const i = a.findIndex((x) => /^\/[ck]$/i.test(x.text)); return i >= 0 && langOf(a[i + 1]?.text) === 'bat' ? at(i + 1) : null; }
  for (let i = 0; i < a.length; i++) {
    const t = a[i].text;
    if (RUNNER_VALUED.has(t)) { i++; continue; }
    if (/^-/.test(t)) { if (['-m', '-c', '-e', '-p', '--eval', '--print', '-lc'].includes(low(t))) return null; continue; }
    if ((s.program === 'deno' || s.program === 'bun') && ['run', 'test'].includes(low(t))) continue;
    return at(i);
  }
  return null;
}

// Shell keywords in front of a command (then cargo build), and batch's if/call prefixes, are not the program.
function unwrap(s, lang) {
  for (let n = 0; s && n < 8; n++) {
    let a = null;
    if (lang === 'sh' && ['then', 'else', 'do', 'if', 'elif', 'while', 'until', '!', '{', 'time', 'nohup'].includes(s.program)) a = s.args;
    else if (lang === 'bat' && s.program === 'else') a = s.args;
    else if (s.program === 'cross-env') { a = s.args.slice(); while (a.length && /^[A-Za-z_]\w*=/.test(a[0].text)) a.shift(); }
    else if (s.program === 'npx') { a = s.args.slice(); while (a.length && /^-/.test(a[0].text)) a.shift(); }
    else if (lang === 'bat' && s.program === 'call') { if (/^:/.test(s.args[0]?.text || '')) return null; a = s.args; }
    else if (lang === 'bat' && s.program === 'if') {
      a = s.args.slice();
      if (low(a[0]?.text) === '/i') a.shift();
      if (low(a[0]?.text) === 'not') a.shift();
      if (['exist', 'defined', 'errorlevel', 'cmdextversion'].includes(low(a[0]?.text))) a = a.slice(2);
      else if (['equ', 'neq', 'lss', 'leq', 'gtr', 'geq'].includes(low(a[1]?.text))) a = a.slice(3);
      else a = a.slice(1);
    } else return s;
    if (!a.length) return null;
    const [p, ...rest] = a;
    s = { ...s, rawProgram: p.text, program: progName(p.text), dynamicProgram: !p.static, args: rest };
  }
  return s;
}

// The commands of a PowerShell, shell or batch script: { segs, members, why } (why: it can't be read).
async function scriptCommands(text, lang) {
  if (lang === 'ps') { const sp = await splitPowerShell(text); return sp.members ? { segs: sp.segs, members: sp.members } : { segs: [], members: [], why: sp.opaque }; }
  if (lang === 'sh') { const sp = splitBash(text.replace(/^\s*#.*$/gm, '')); return { segs: sp.segs.map((s) => unwrap(s, lang)).filter(Boolean), members: [], why: sp.opaque }; }
  const segs = []; let why = null;
  for (const l of text.split(/\r?\n/).map((x) => x.trim().replace(/^@/, ''))) {
    if (!l || /^(rem\b|::|:)/i.test(l) || /^echo\s+(off|on)\s*$/i.test(l)) continue;
    const sp = splitCmd(l); why ||= sp.opaque;
    for (const s0 of sp.segs) {
      const s = unwrap(s0, lang);
      if (!s) continue;
      if (/%~?[\d*]/.test(s.rawProgram)) s.dynamicProgram = true;
      for (const a of s.args) if (/%~?[\d*]/.test(a.text)) a.static = false;
      segs.push(s);
    }
  }
  return { segs, members: [], why };
}

// Local modules a JS or Python script loads: a launcher moved into a helper file is still found.
function localModules(text, abs, lang) {
  const dir = path.dirname(abs), out = [];
  if (lang === 'js') {
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g)) {
      const p = path.resolve(dir, m[1]);
      const hit = [p, ...['.js', '.mjs', '.cjs', '.ts', '.mts'].map((x) => p + x), path.join(p, 'index.js')].find(isFile);
      if (hit) out.push(hit);
    }
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*(?:from\s+\.?([A-Za-z_]\w*)[\w.]*\s+import\b|import\s+([A-Za-z_][\w., ]*))/gm)) {
      for (const name of m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/[\s.]/)[0])) {
        const hit = [path.join(dir, `${name}.py`), path.join(dir, name, '__init__.py')].find(isFile);
        if (hit) out.push(hit);
      }
    }
  }
  return out.slice(0, 20);
}

// Reads one script: { launch: why it is opaque, or null; argv: it reads its own arguments; extra: commands to judge }.
// null when there is no such file.
async function readScript(abs, lang, c, depth, seen) {
  const out = { launch: null, argv: false, extra: [] };
  if (seen.has(low(abs)) || seen.size > 20) return out;
  seen.add(low(abs));
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (st.isDirectory()) { const main = { js: 'index.js', py: '__main__.py' }[lang]; return main ? readScript(path.join(abs, main), lang, c, depth, seen) : null; }
  const rel = path.relative(c.root, abs).replaceAll('\\', '/');
  if (st.size > SCRIPT_MAX) return { ...out, launch: `this script (${rel}) is too big for QuorX to read first` };
  const text = fs.readFileSync(abs, 'utf8');
  const runs = `this script (${rel}) runs other programs, so QuorX can’t check what it runs`;
  out.argv = LAUNCH[lang].argv.test(text);
  if (lang === 'js' || lang === 'py') {
    if (LAUNCH[lang].programs.test(text)) out.launch = runs;
    else if (LAUNCH[lang].code.test(text)) out.launch = `this script (${rel}) runs code it builds while running, so QuorX can’t check what it runs`;
    for (const f of localModules(text, abs, lang)) {
      const r = await readScript(f, lang, c, depth, seen);
      if (r) { out.launch ||= r.launch; out.argv ||= r.argv; }
    }
    return out;
  }
  const sc = await scriptCommands(text, lang);
  if (sc.why) return { ...out, launch: `QuorX can’t read this script (${rel}): ${sc.why}` };
  if (sc.members.some((m) => LAUNCH_MEMBERS.test(m))) out.launch = runs;
  await judgeCommands(sc.segs, lang, { ...c }, rel, depth, out);
  return out;
}

// The commands of a script (or a package.json script), one by one: a launcher makes it opaque, a script it runs is
// read in turn, and the risky ones go to out.extra to be judged with the line.
async function judgeCommands(segs, lang, ic, rel, depth, out) {
  const runs = `this script (${rel}) runs other programs, so QuorX can’t check what it runs`;
  for (const s of segs) {
    trackCd(s, ic);
    // concurrently "tsc -w" "npm:serve" and run-s / run-p / npm-run-all a b: each argument is a command or a script name.
    if (['concurrently', 'run-s', 'run-p', 'npm-run-all'].includes(s.program)) {
      const parts = [];
      for (const a of s.args.filter((x) => !x.param && !/^-/.test(x.text))) {
        const npmName = s.program === 'concurrently' ? a.text.match(/^(?:npm|yarn|pnpm|bun):(.+)$/)?.[1] : a.text;
        if (npmName != null && /[*?{]/.test(npmName)) { out.launch ||= runs; continue; }
        if (npmName != null) parts.push({ text: `npm run ${npmName}`, rawProgram: 'npm', program: 'npm', dynamicProgram: !a.static, args: [{ text: 'run', static: true }, { text: npmName, static: a.static }], redirects: [] });
        else { const sc = await scriptCommands(a.text, lang); if (sc.why || !a.static) out.launch ||= runs; else parts.push(...sc.segs); }
      }
      await judgeCommands(parts, lang, ic, rel, depth, out);
      continue;
    }
    if (scriptOf(s) || pkgRunOf(s)) {
      // A script this one runs is read too, a few levels down; deeper than that it can't be checked.
      if (depth + 1 >= SCRIPT_DEPTH) { out.launch ||= `${rel} runs scripts nested too deeply for QuorX to read them all`; continue; }
      const r = await inspectRun({ ...s, depth: depth + 1 }, ic, []);
      if (r) { out.launch ||= r.opaque; out.extra.push(...r.extra); }
      continue;
    }
    if (s.dynamicProgram || s.opaque || LAUNCHERS.has(s.program) || (s.program === 'new-object' && hasArg(s, '-comobject'))) { out.launch ||= runs; continue; }
    const k = classify(s, SHELL_OF[lang]);
    const paths = pathsOf(s, k, ic);
    if (k.cls === 'never' || (k.cls === 'install' && k.global) || ['external', 'discard'].includes(k.cls) || KILLERS.has(s.program) || paths.some((p) => p.zone === 'blocked' || p.zone === 'protected')) {
      out.extra.push({ ...s, ctx: { ...ic }, shell: SHELL_OF[lang], via: rel, viaWhy: `inside ${rel}`, depth: depth + 1 });
    }
  }
}

// ---------- package.json scripts ----------
// npm run x, npm test, yarn x, pnpm x, bun run x run a command line from package.json "scripts" (with its pre and post
// hooks); a bare npm install or npm ci runs the install and prepare hooks. Those lines are read like a script's.
const PKG_BUILTIN = {
  yarn: new Set(['add', 'install', 'remove', 'upgrade', 'up', 'info', 'why', 'list', 'init', 'config', 'cache', 'global', 'link', 'unlink', 'publish', 'login',
    'logout', 'version', 'versions', 'dlx', 'exec', 'workspaces', 'workspace', 'node', 'set', 'plugin', 'constraints', 'npm', 'pack', 'dedupe', 'explain',
    'rebuild', 'bin', 'audit', 'outdated', 'owner', 'tag', 'team', 'policies', 'licenses', 'import', 'check', 'autoclean', 'create', 'help', 'upgrade-interactive']),
  pnpm: new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'list', 'ls', 'outdated', 'why', 'link', 'unlink', 'publish', 'pack',
    'exec', 'dlx', 'create', 'init', 'store', 'config', 'env', 'setup', 'audit', 'licenses', 'import', 'rebuild', 'prune', 'fetch', 'deploy', 'patch',
    'patch-commit', 'root', 'bin', 'server', 'doctor', 'help', 'dedupe', 'install-test', 'it', 'add-test', 'self-update']),
  bun: new Set(['test', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'x', 'build', 'create', 'init', 'upgrade', 'pm', 'link', 'unlink', 'publish',
    'outdated', 'patch', 'repl', 'exec', 'audit', 'info', 'why']),
};
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];
const PKG_DIR = new Set(['--prefix', '-C', '--dir', '--cwd']);
const PKG_MULTI = new Set(['-w', '--workspace', '--filter', '-F', '--workspaces', '-ws', '-r', '--recursive', '--include-workspace-root']);
const PKG_VALUED = new Set(['-w', '--workspace', '--filter', '-F', '--loglevel', '--registry', '--script-shell']);

/** The package.json script a command runs: { pm, kind: 'run'|'install', name, extra: [args after the name], dir, multi } */
function pkgRunOf(s) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(s.program) || s.dynamicProgram) return null;
  const pm = s.program, pos = []; let dir = null, multi = false, shell = false;
  for (let i = 0; i < s.args.length; i++) {
    const t = s.args[i].text, [flag, val] = t.split(/=(.*)/s);
    if (/^-/.test(t) && pos.length) break; // flags after the script name belong to the script
    if (PKG_DIR.has(flag)) { dir = val ?? s.args[++i]; continue; }
    if (PKG_MULTI.has(flag)) multi = true;
    if (flag === '--script-shell') shell = true;
    if (PKG_VALUED.has(flag) && val == null) { i++; continue; }
    if (/^-/.test(t)) continue;
    pos.push({ text: t, i });
  }
  const w = pos.map((p) => low(p.text));
  const at = (k, name) => ({ pm, kind: 'run', name, extra: s.args.slice(pos[k].i + 1).filter((a, j) => j || a.text !== '--'), dir, multi, shell });
  const install = { pm, kind: 'install', name: 'install', extra: [], dir, multi, shell };
  if (['run', 'run-script', 'rum', 'urn'].includes(w[0]) && w[1]) return { ...at(1, pos[1].text), ifScript: pm !== 'npm' }; // bun run x.ts runs a file
  if (pm === 'npm' && ['test', 't', 'tst', 'start', 'stop', 'restart'].includes(w[0])) return at(0, { t: 'test', tst: 'test' }[w[0]] || w[0]);
  if (pm === 'npm' && ['install', 'i', 'in', 'isntall', 'ci', 'clean-install'].includes(w[0]) && w.length === 1) return install;
  if ((pm === 'yarn' && (!w.length || (w[0] === 'install' && w.length === 1))) || (pm === 'pnpm' && ['install', 'i'].includes(w[0]) && w.length === 1)) return install;
  if (pm !== 'npm' && pm !== 'bun' && ['test', 't', 'start'].includes(w[0])) return at(0, w[0] === 't' ? 'test' : w[0]);
  if (pm !== 'npm' && w[0] && !PKG_BUILTIN[pm].has(w[0])) return { ...at(0, pos[0].text), ifScript: true };
  return null;
}

// The lines a package.json script run executes, from its scripts: [[key, line]].
function pkgLines(run, scripts, pkgDir) {
  const has = (k) => typeof scripts[k] === 'string';
  const hooks = (n) => [`pre${n}`, n, `post${n}`].filter(has).map((k) => [k, scripts[k]]);
  if (run.kind === 'install') return LIFECYCLE.filter(has).map((k) => [k, scripts[k]]);
  if (run.name === 'restart' && !has('restart')) return [...hooks('stop'), ...hooks('start')];
  if (run.name === 'start' && !has('start') && isFile(path.join(pkgDir, 'server.js'))) return [['start', 'node server.js']];
  if (!has(run.name)) return [];
  const extra = run.extra.map((a) => a.text).join(' ');
  return hooks(run.name).map(([k, l]) => [k, k === run.name && extra ? `${l} ${extra}` : l]);
}

async function inspectPkg(s, run, c, written) {
  if (run.multi || run.shell) return { opaque: 'it runs package scripts QuorX can’t find before it runs (other workspaces or another shell)', extra: [] };
  let dir = c.cwd;
  if (run.dir) {
    const e = expandVars(typeof run.dir === 'string' ? run.dir : run.dir.text, c.env);
    if (e.unresolved || (typeof run.dir !== 'string' && run.dir.static === false) || (!path.isAbsolute(e.path) && c.cwdUnknown)) return { opaque: 'QuorX can’t tell which package.json it runs, so it can’t read it first', extra: [] };
    dir = path.resolve(c.cwd, e.path);
  } else if (c.cwdUnknown) return { opaque: 'QuorX can’t tell which package.json it runs, so it can’t read it first', extra: [] };
  // The nearest package.json at or above the folder, inside the project.
  let pkg = null;
  for (let d = dir; same(d, c.root) || inside(d, c.root); d = path.dirname(d)) {
    const f = path.join(d, 'package.json');
    if (written.some((w) => same(w, f))) return { opaque: `this command writes ${path.relative(c.root, f).replaceAll('\\', '/')} and then runs its scripts, so QuorX can’t read them first`, extra: [] };
    if (isFile(f)) { pkg = f; break; }
    if (same(d, c.root)) break;
  }
  if (!pkg) return null;
  let scripts;
  try { if (fs.statSync(pkg).size > SCRIPT_MAX) throw new Error('too big'); scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts || {}; } catch { return null; }
  if (run.ifScript && typeof scripts[run.name] !== 'string') return null;
  const rel = path.relative(c.root, pkg).replaceAll('\\', '/');
  const lang = WIN ? 'bat' : 'sh', depth = s.depth || 0, out = { launch: null, argv: false, extra: [] };
  for (const [key, line] of pkgLines(run, scripts, path.dirname(pkg))) {
    const where = `${rel} scripts.${key}`;
    const sc = await scriptCommands(line, lang);
    if (sc.why) { out.launch ||= `QuorX can’t read ${where}: ${sc.why}`; continue; }
    await judgeCommands(sc.segs, lang, { ...c, cwd: path.dirname(pkg), cwdUnknown: false }, where, depth, out);
  }
  return { opaque: out.launch, extra: out.extra };
}

/**
 * Reads the script a command runs, if it is in the project. Returns null, or { opaque: why, extra: [segments] }:
 * the commands to judge alongside it (what it passes its arguments on to, and what its own lines do).
 * written: files earlier commands of the same line write.
 */
async function inspectRun(s, c, written) {
  const pk = pkgRunOf(s);
  if (pk) { const r = await inspectPkg(s, pk, c, written); if (r) return r; }
  const run = scriptOf(s);
  if (!run) return null;
  const unclear = { opaque: 'QuorX can’t tell which script it runs, so it can’t read it first', extra: [] };
  if (!run.file.static) return unclear;
  const e = expandVars(run.file.text, c.env);
  if (e.unresolved || (!path.isAbsolute(e.path) && c.cwdUnknown)) return unclear;
  let abs = path.resolve(c.cwd, e.path);
  if (run.lang === 'js' && !path.extname(abs)) abs = ['.js', '.mjs', '.cjs'].map((x) => abs + x).find(isFile) || abs;
  if (zoneOf(abs, c.root).zone !== 'inside') return null;
  const rel = path.relative(c.root, abs).replaceAll('\\', '/');
  if (written.some((w) => same(w, abs))) return { opaque: `this command writes ${rel} and then runs it, so QuorX can’t read it first`, extra: [] };
  const depth = s.depth || 0;
  const r = await readScript(abs, run.lang, c, depth, new Set());
  if (!r) return null;
  const extra = [...r.extra];
  // It runs programs and reads its arguments: what it was given is judged as the command it will run.
  const [p, ...rest] = run.rest;
  if (r.launch && r.argv && p && !/^-/.test(p.text)) {
    extra.unshift({ text: run.rest.map((a) => a.text).join(' '), rawProgram: p.text, program: progName(p.text), dynamicProgram: p.static === false,
      args: rest.map((a) => ({ ...a, param: a.param ?? /^-{1,2}[a-z]/i.test(a.text) })), redirects: [], via: rel, viaWhy: `${rel} passes it on as a command`, depth: depth + 1 });
  }
  return { opaque: r.launch, extra };
}

// cd with a static target moves the folder later commands' relative paths start from.
function trackCd(s, c) {
  if (['cd', 'chdir', 'set-location', 'push-location'].includes(s.program)) {
    const t = s.args.find((a) => !a.param);
    const e = t ? expandVars(t.text, c.env) : null;
    if (e && !e.unresolved && !c.cwdUnknown) c.cwd = path.resolve(c.cwd, e.path); else if (t) c.cwdUnknown = true;
  }
  if (s.program === 'pop-location') c.cwdUnknown = true;
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
 * ctx: { shell: 'powershell'|'pwsh'|'cmd'|'bash'|'zsh'|'direct', root, cwd?, env?, rules: [{effect, match, by, scope}], mode: 'strict'|'yolo',
 *        yolo: { external, opaque, outside } (what the deciders may approve) }
 * Returns { verdict: 'allow'|'ask'|'deny', who: 'user'|'deciders'|null, why, decidedBy, segments: [...], hint? }.
 */
export async function decide(line, ctx) {
  let shell = ctx.shell || (WIN ? 'powershell' : 'bash');
  // Off Windows there is no cmd, and Node's default shell (run_command's "direct") is /bin/sh: both are read as bash.
  if (!WIN && (shell === 'cmd' || shell === 'direct')) shell = 'bash';
  const root = path.resolve(ctx.root);
  const c = { root, cwd: path.resolve(ctx.cwd || root), env: ctx.env || process.env };
  const text = String(line || '').trim();
  if (!text) return { verdict: 'deny', who: null, why: 'empty command', decidedBy: 'code', segments: [] };
  const split = shell === 'powershell' || shell === 'pwsh' ? await splitPowerShell(text) : shell === 'bash' || shell === 'zsh' ? splitBash(text, shell === 'zsh') : splitCmd(text);
  const segments = [];
  if (split.opaque || !split.segs.length) {
    const why = split.opaque || 'QuorX could not find a command in it';
    segments.push({ text, program: '', cls: 'opaque', why, verdict: 'ask', who: 'user', decidedBy: 'class:opaque', paths: [] });
  }
  // Commands a script runs (see "scripts") join the queue just before the command that runs the script.
  const queue = [...split.segs], written = [];
  while (queue.length) {
    const s = queue.shift();
    if (!s.inspected && (s.depth || 0) <= SCRIPT_DEPTH) {
      s.inspected = true;
      const r = await inspectRun(s, s.ctx || c, written);
      if (r?.opaque) s.opaque ||= r.opaque;
      if (r?.extra.length) { queue.unshift(...r.extra, s); continue; }
    }
    const k = classify(s, s.shell || shell);
    const paths = pathsOf(s, k, s.ctx || c);
    written.push(...paths.filter((p) => p.kind === 'write' && p.resolved).map((p) => p.resolved));
    const seg = { text: s.text, program: s.program, cls: k.cls, why: k.why, global: !!k.global, paths, rule: null, suggest: suggestions(s), ...(s.via ? { via: s.via } : {}) };
    if (!s.ctx) trackCd(s, c);
    let v = 'allow', who = null, by = `class:${k.cls}`, why = k.why;
    const blocked = paths.find((p) => p.zone === 'blocked' || p.zone === 'protected');
    const unknownPath = paths.find((p) => p.zone === 'unknown');
    const outside = paths.find((p) => p.zone === 'outside');
    if (k.cls === 'never') { v = 'deny'; why = k.why || 'this command is never allowed'; }
    else if (blocked) { v = 'deny'; by = 'path'; why = `it would ${blocked.kind === 'write' ? 'write to' : 'delete or move'} ${blocked.why}`; }
    else if (k.cls === 'delete' && !unknownPath && !outside) {
      const recursive = s.args.some((a) => /^(-recurse|-r|-rf|-fr|\/s|--recursive)$/i.test(a.text) || (s.program === 'rm' && /^-[a-z]*r/i.test(a.text))) || s.program === 'rimraf' || s.program === 'del-cli';
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
    if (s.viaWhy) why = why ? `${why} (${s.viaWhy})` : s.viaWhy;
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
  [/\.(xcodeproj|xcworkspace)$/,['xcodebuild*', 'simctl boot*', 'simctl install*', 'simctl launch*', 'simctl terminate*']],
  ['Package.swift', ['swift build*', 'swift test*', 'swift run*']],
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
