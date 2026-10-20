// The gate every agent command and server starts through. It waits for one line on stdin (QuorX sends it once
// this process is inside its Windows job, so nothing the command starts can escape the job), then runs the
// command with stdin closed and forwards its output and exit code.
//   node jobgate.cjs <shell> <command line>      shell: cmd | powershell | pwsh | bash | zsh | direct
// "direct" runs the command line with Node's default shell (cmd on Windows, /bin/sh elsewhere).
// On macOS and Linux the gate leads its own process group (QuorX starts it detached), and that group is the job.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const [shell = 'direct', line = ''] = process.argv.slice(2);
const WIN = process.platform === 'win32';
// The desktop app runs QuorX (and this gate) as Node through its own Electron binary, with ELECTRON_RUN_AS_NODE=1.
// The agent's program must not inherit that: an Electron app it starts would run as plain Node instead.
delete process.env.ELECTRON_RUN_AS_NODE;

function launch() {
  const opts = { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, env: process.env };
  if (shell === 'powershell' || shell === 'pwsh') {
    const exe = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
    // -ExecutionPolicy Bypass applies to this one process only, so npm.ps1-style shims and project scripts run.
    return spawn(WIN ? exe : 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', line], opts);
  }
  if (shell === 'bash' || shell === 'zsh') return spawn(shell, ['-c', line], opts);
  return spawn(line, { ...opts, shell: true });
}

// There is no job that closes with QuorX on macOS and Linux: if QuorX goes away (killed, crashed), this gate is
// handed to another parent, and it ends its whole group, which holds everything the command started.
if (!WIN) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid === parent) return;
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader (basic mode) */ }
    process.exit(1);
  }, 1000).unref();
}

// In a terminal (agentterm.js) stdin is the keyboard, so the go signal is a file instead, and the program keeps the
// terminal for its input and output.
if (process.env.QX_GO_FILE) {
  const file = process.env.QX_GO_FILE;
  const t0 = Date.now();
  const wait = setInterval(() => {
    if (!fs.existsSync(file) && Date.now() - t0 < 15000) return;
    clearInterval(wait);
    try { fs.rmSync(file, { force: true }); } catch { /* agentterm.js removes it when the program ends */ }
    const env = { ...process.env };
    delete env.QX_GO_FILE;
    const opts = { stdio: 'inherit', windowsHide: false, env };
    const child = shell === 'powershell' || shell === 'pwsh'
      ? spawn(WIN ? `${shell}.exe` : 'pwsh', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line], opts)
      : shell === 'bash' || shell === 'zsh' ? spawn(shell, ['-c', line], opts) : spawn(line, { ...opts, shell: true });
    child.on('error', (e) => { process.stderr.write(`could not start: ${e.message}\n`); process.exit(127); });
    child.on('close', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  }, 10);
  return;
}

let started = false;
const go = () => {
  if (started) return;
  started = true;
  process.stdin.removeAllListeners();
  process.stdin.destroy();
  const child = launch();
  child.on('error', (e) => { process.stderr.write(`could not start: ${e.message}\n`); process.exit(127); });
  child.on('close', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
};
process.stdin.on('data', go);
process.stdin.on('end', go); // QuorX closed stdin without the line: run anyway (no job host)
process.stdin.on('error', go);
