// LLDB's debug adapters, shared by the C/C++ and Rust packs: lldb-dap from LLVM (LLVM 18 and later; older builds
// name it lldb-vscode) and CodeLLDB's adapter (VS Code's Rust debugger, used when it is installed). Both speak the
// Debug Adapter Protocol and listen on a local port. (Files starting with "_" are not packs.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, MAC, run } from './_lib.js';

const exe = (n) => (WIN ? `${n}.exe` : n);
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
const newest = (names) => names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/** The first of `names` on PATH, as a full path, or null. */
export function onPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) { const f = path.join(d, exe(n)); if (fs.existsSync(f)) return f; }
  return null;
}

// Where LLVM puts lldb-dap when it is not on PATH: LLVM's Windows installer, Homebrew's llvm, Debian's llvm-NN.
function llvmDirs() {
  if (WIN) return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin')];
  let deb = [];
  try { deb = newest(fs.readdirSync('/usr/lib').filter((x) => /^llvm-\d+$/.test(x))).map((d) => `/usr/lib/${d}/bin`); } catch { /* none */ }
  return ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin', ...deb];
}

/** lldb-dap's full path (QX_LLDB_DAP, PATH, LLVM's own folders, then Xcode's), or null. */
export async function findLldbDap() {
  if (process.env.QX_LLDB_DAP && fs.existsSync(process.env.QX_LLDB_DAP)) return process.env.QX_LLDB_DAP;
  const found = onPath(['lldb-dap', 'lldb-vscode']) || llvmDirs().flatMap((d) => ['lldb-dap', 'lldb-vscode'].map((n) => path.join(d, exe(n)))).find((f) => fs.existsSync(f));
  if (found || !MAC) return found || null;
  const x = await run('xcrun', ['--find', 'lldb-dap']); // Xcode 16 and later
  return x && fs.existsSync(x.split(/\r?\n/)[0]) ? x.split(/\r?\n/)[0] : null;
}

/** CodeLLDB's adapter from a VS Code-style editor's extensions folder (QX_CODELLDB overrides), newest first, or null. */
export function findCodeLldb(home = os.homedir()) {
  if (process.env.QX_CODELLDB && fs.existsSync(process.env.QX_CODELLDB)) return process.env.QX_CODELLDB;
  for (const ed of ['.vscode', '.vscode-insiders', '.cursor', '.vscode-oss', '.windsurf']) {
    const dir = path.join(home, ed, 'extensions');
    let hits = [];
    try { hits = newest(fs.readdirSync(dir).filter((x) => /^vadimcn\.vscode-lldb-\d/.test(x))); } catch { continue; }
    for (const h of hits) { const f = path.join(dir, h, 'adapter', exe('codelldb')); if (fs.existsSync(f)) return f; }
  }
  return null;
}

/**
 * The version for the Setup check: from lldb next to lldb-dap ("lldb version 19.1.7", Apple's "lldb-1600.0.36.3"),
 * or "found" when only lldb-dap is there. null when there is no lldb-dap.
 */
export async function lldbDapVersion() {
  const dap = await findLldbDap();
  if (!dap) return null;
  const lldb = path.join(path.dirname(dap), exe('lldb'));
  const o = fs.existsSync(lldb) ? await run(lldb, ['--version']) : null;
  return (o && /lldb(?: version |-)(\d+\.\d+(\.\d+)?)/.exec(o)?.[1]) || 'found';
}

/** Whether lldb-dap starts at all: LLVM's Windows lldb needs the Python it was built with, or it won't start. */
export async function lldbDapWorks() {
  const dap = await findLldbDap();
  const o = dap ? await run(dap, ['--help']) : null;
  if (o && /usage|options|--port|--connection/i.test(o)) return { ok: true, why: '' };
  return { ok: false, why: `lldb-dap does not start${WIN ? ' (LLVM\'s lldb on Windows needs the Python version it was built with: running lldb-dap --help in a terminal names the missing python3xx.dll)' : ''}` };
}

/** How lldb-dap is told to listen: --connection on LLVM 20 and later, --port before (and in lldb-vscode). */
export const listenArgs = (help, port) => (/--connection/.test(help || '') ? ['--connection', `listen://127.0.0.1:${port}`] : ['--port', String(port)]);

/**
 * The DAP plan for one launch: which adapter (CodeLLDB when `prefer` is 'codelldb' and it is installed, else
 * lldb-dap), its command line, and the launch request. `extra` adds launch fields (initCommands, sourceLanguages).
 * Throws with an install hint when neither adapter is here.
 */
export async function lldbPlan({ program, args = [], cwd, port, prefer = 'lldb-dap', extra = {}, missing }) {
  const code = prefer === 'codelldb' ? findCodeLldb() : null;
  const dap = code ? null : await findLldbDap();
  if (!code && !dap) throw new Error(missing || 'lldb-dap is not installed: it comes with LLVM 18 or later (winget install LLVM.LLVM, brew install llvm, apt install lldb). Ask the user before installing it.');
  const listen = code ? ['--port', String(port)] : listenArgs(await run(dap, ['--help']), port);
  return {
    line: [quote(code || dap), ...listen].join(' '),
    adapterID: code ? 'lldb' : 'lldb-dap', request: 'launch',
    args: { program, args, cwd, stopOnEntry: false, ...extra },
    evalContext: 'watch', // 'repl' input is read as lldb commands; 'watch' is an expression in the program's language
    adapter: code ? 'CodeLLDB' : 'lldb-dap',
    missing: `${code ? 'CodeLLDB' : 'lldb-dap'} did not open its port`,
  };
}
