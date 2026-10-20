// A bridge for debug adapters that speak the Debug Adapter Protocol only over stdin and stdout (dart debug_adapter,
// flutter debug_adapter, lldb-dap): it starts the adapter, listens on a local port, and passes bytes both ways
// between the one connection it accepts (QuorX's debugger) and the adapter. It runs as the debug session's
// background job, so the adapter and the program it starts sit in the same Windows job and Stop ends them all.
//   node dapbridge.cjs <port> <adapter command line…>
const net = require('node:net');
const { spawn } = require('node:child_process');

const [port, ...cmd] = process.argv.slice(2);
// The desktop app runs this file as Node through its own Electron binary; the adapter must not inherit that.
delete process.env.ELECTRON_RUN_AS_NODE;
// The arguments are joined back into one line for a shell: cmd.exe on Windows, sh elsewhere, where single quotes keep
// $, quotes and spaces as they are.
const quote = process.platform === 'win32'
  ? (a) => (/\s/.test(a) ? `"${a}"` : a)
  : (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const line = cmd.map(quote).join(' ');
if (!Number(port) || !line) { process.stderr.write('usage: dapbridge.cjs <port> <adapter command>\n'); process.exit(2); }

// The adapter starts at once (Flutter's takes a few seconds); its output waits in the pipe until QuorX connects.
// A shell, so dart.bat and flutter.bat start on Windows.
const child = spawn(line, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let sock = null;
const server = net.createServer((s) => {
  if (sock) { s.destroy(); return; }
  sock = s;
  server.close();
  s.on('error', () => {});
  s.pipe(child.stdin);
  child.stdout.pipe(s);
  // QuorX hung up: the session is over. The job's Stop (or its end-of-job sweep) ends what the adapter started.
  s.on('close', () => { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => process.exit(0), 1500).unref(); });
});
server.on('error', (e) => { process.stderr.write(`dapbridge: cannot listen on ${port}: ${e.message}\n`); child.kill(); process.exit(1); });
server.listen(Number(port), '127.0.0.1', () => process.stderr.write(`dapbridge: ${line} on 127.0.0.1:${port}\n`));
child.stdin.on('error', () => {});
child.on('error', (e) => { process.stderr.write(`dapbridge: could not start ${line}: ${e.message}\n`); process.exit(127); });
child.on('exit', (code) => { if (sock) sock.end(); server.close(); setTimeout(() => process.exit(code ?? 1), 200); });
