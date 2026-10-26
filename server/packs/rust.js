// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Rust: command-line programs, libraries, and the Rust half of Tauri apps. Debugging builds the crate with cargo,
// finds the binary from cargo's own build messages, and runs it under CodeLLDB (when installed: it knows Rust's
// types) or lldb-dap with the Rust formatters that ship with the toolchain.
import fs from 'node:fs';
import path from 'node:path';
import { WIN, MAC, run, tempDir, rm, VS_LINE } from './_lib.js';
import { lldbPlan } from './_lldb.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

// Installed is not the same as working: Rust needs a C linker to make a program (on Windows, Visual Studio's C++
// Build Tools), and a PC can have cargo without one. So Rust is checked by building a tiny program. { ok, why }.
async function rustBuilds() {
  const dir = tempDir('rustcheck');
  try {
    fs.writeFileSync(path.join(dir, 'main.rs'), 'fn main() {}\n');
    const out = await run('rustc', ['main.rs', '-o', WIN ? 'main.exe' : 'main'], { cwd: dir, timeout: 60000 });
    if (fs.existsSync(path.join(dir, WIN ? 'main.exe' : 'main'))) return { ok: true, why: '' };
    const linker = /link(er|\.exe)|cc` not found|msvc/i.test(out || '');
    return { ok: false, why: linker ? `no C linker: Rust needs ${WIN ? 'the Visual Studio Build Tools with C++' : MAC ? 'the Xcode command line tools' : 'a C toolchain (build-essential)'} to make programs` : `rustc could not build a test program (${String(out || 'no output').split(/\r?\n/).find((l) => /error/i.test(l)) || 'unknown error'})` };
  } finally { rm(dir); }
}

/** The nearest Cargo.toml at or above `file` (inside root), or null. */
export function cargoManifest(root, file) {
  let d = path.dirname(path.resolve(root, file));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, 'Cargo.toml'))) return path.join(d, 'Cargo.toml');
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return null;
    d = path.dirname(d);
  }
  return null;
}

/** The programs in cargo's --message-format=json output: [{ name, kind, src, program, manifest }]. */
export function cargoExecutables(out) {
  const exes = [];
  for (const l of String(out || '').split(/\r?\n/)) {
    if (!l.startsWith('{')) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.reason === 'compiler-artifact' && m.executable && m.target?.kind?.some((k) => k === 'bin' || k === 'example')) {
      exes.push({ name: m.target.name, kind: m.target.kind[0], src: m.target.src_path, program: m.executable, manifest: m.manifest_path });
    }
  }
  return exes;
}

/**
 * The binary to debug for `file`: the one built from it (src/main.rs, src/bin/x.rs), else the package's only binary,
 * else its src/main.rs one. { program } or { error }.
 */
export function pickCargoExecutable(exes, file, manifest) {
  const same = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();
  const own = exes.find((e) => same(e.src, file));
  if (own) return { program: own.program };
  const pkg = exes.filter((e) => e.kind === 'bin' && (!manifest || same(e.manifest, manifest)));
  if (pkg.length === 1) return { program: pkg[0].program };
  const main = pkg.find((e) => same(e.src, path.join(path.dirname(e.manifest), 'src', 'main.rs')));
  if (main) return { program: main.program };
  if (!pkg.length) return { error: 'this crate builds no program (a library?): debug it through a binary or an example, or pass program' };
  return { error: `${pkg.length} programs could run ${path.basename(file)}: pass program, one of ${pkg.map((e) => e.program).join(', ')}` };
}

/** Builds the crate `file` belongs to with cargo build and finds its program. { program }; throws on a failed build. */
export async function cargoProgram(root, file, { timeout = 600e3 } = {}) {
  const { runLine } = await import('../workspace.js'); // builds run as jobs, like every other command
  const manifest = cargoManifest(root, file);
  if (!manifest) throw new Error(`${file} is not in a Cargo project: pass program, the built program to run`);
  const r = await runLine(path.dirname(manifest), 'cargo build --message-format=json-render-diagnostics', { shell: 'direct', timeout });
  if (r.code !== 0) {
    const errs = String(r.out || '').split(/\r?\n/).filter((l) => !l.startsWith('{') && /^(error|-->)/.test(l.trim())).slice(0, 8).map((l) => l.trim());
    throw new Error(`cargo build failed${r.timedOut ? ' (it ran out of time)' : ''}: ${errs.join(' | ') || 'see its output'}`);
  }
  const pick = pickCargoExecutable(cargoExecutables(r.out), path.resolve(root, file), manifest);
  if (pick.error) throw new Error(pick.error);
  return { program: pick.program };
}

// lldb-dap knows C++, not Rust: the toolchain ships Python formatters for String, Vec, Option and the rest (what
// rust-lldb loads). The GNU toolchain has the module but not its command list, so the catch-all is added by hand.
export async function rustFormatters(cwd) {
  const sysroot = String(await run('rustc', ['--print', 'sysroot'], { cwd }) || '').split(/\r?\n/)[0].trim();
  const etc = sysroot && path.join(sysroot, 'lib', 'rustlib', 'etc');
  if (!etc || !fs.existsSync(path.join(etc, 'lldb_lookup.py'))) return [];
  const cmds = path.join(etc, 'lldb_commands');
  return [`command script import "${path.join(etc, 'lldb_lookup.py')}"`, ...(fs.existsSync(cmds) ? [`command source -s 0 "${cmds}"`]
    : ['type synthetic add -l lldb_lookup.synthetic_lookup -x ".*" --category Rust', 'type category enable Rust'])];
}

/** The launch fields Rust adds: its formatters (lldb-dap only; CodeLLDB has its own), and a stop at every panic. */
export const rustLaunchExtra = (adapter, formatters = []) => ({
  ...(adapter === 'CodeLLDB' ? { sourceLanguages: ['rust'] } : formatters.length ? { initCommands: formatters } : {}),
  preRunCommands: ['breakpoint set -n rust_panic'], // std's no_mangle function every panic goes through
});

export default {
  id: 'rust',
  label: 'Rust',
  summary: 'Command-line programs, libraries and services',
  toolchains: [{
    id: 'rust', label: 'Rust (cargo)', for: 'Rust programs, CLIs and Tauri apps', probe: ['cargo', ['--version']], re: /cargo (\d+\.\d+\.\d+)/,
    works: rustBuilds, fixWith: 'msvc', winget: 'Rustlang.Rustup', brew: 'rustup-init', url: 'https://rustup.rs',
    brokenHint: () => (WIN
      ? `Offer, in this order: they install the Build Tools with C++ from ⚙ Settings → Setup check (the usual Windows setup, which Tauri and C/C++ need too); you run \`${VS_LINE}\` for them (it asks them first, shows Windows' admin prompt and takes 5–15 minutes; without the --override part it installs no linker); or, for a small program, the GNU toolchain for this folder only (rustup toolchain install stable-x86_64-pc-windows-gnu, then a rust-toolchain.toml); or you stop at a checked crate.`
      : MAC ? 'Offer to run xcode-select --install (the user confirms Apple\'s dialog), or stop at a checked crate.'
        : 'Offer to install build-essential (or the distribution\'s C toolchain), or stop at a checked crate.'),
    checkStillWorks: 'cargo check, tests that don\'t link',
  }],
  markers: [/^Cargo\.toml$/],
  checks: [{ id: 'rust', tool: 'rust', ext: /\.rs$/i, marker: (d) => fs.existsSync(path.join(d, 'Cargo.toml')), cmd: 'cargo check --quiet --message-format short' }],
  debug: {
    exts: ['.rs'], tool: 'lldb', label: 'Rust (lldb-dap or CodeLLDB)',
    gate: ({ file, args = [], cwd = '.', program }) => {
      if (program) return [quote(program), ...args.map(quote)].join(' ');
      const m = cargoManifest(cwd, file), at = m && path.dirname(m) !== path.resolve(cwd) ? ` --manifest-path ${quote(path.relative(cwd, m))}` : '';
      return [`cargo run${at}`, ...(args.length ? ['--', ...args.map(quote)] : [])].join(' ');
    },
    start: async ({ file, args = [], cwd, port, program }) => {
      const built = program ? { program: path.resolve(cwd, program) } : await cargoProgram(cwd, file);
      if (!fs.existsSync(built.program)) throw new Error(`${built.program} does not exist: build it first`);
      const plan = await lldbPlan({ program: built.program, args, cwd, port, prefer: 'codelldb',
        missing: 'Rust debugging needs lldb-dap (it comes with LLVM 18 or later: winget install LLVM.LLVM, brew install llvm, apt install lldb) or CodeLLDB (the VS Code extension vadimcn.vscode-lldb). Installing either is for the whole computer, so ask the user first.' });
      plan.args = { ...plan.args, ...rustLaunchExtra(plan.adapter, plan.adapter === 'lldb-dap' ? await rustFormatters(cwd) : []) };
      const msvc = WIN && fs.existsSync(built.program.replace(/\.exe$/i, '.pdb'));
      return { ...plan, note: msvc ? 'This is an MSVC build: LLDB reads its .pdb, so breakpoints and the stack work, but String, Vec and enums may show raw fields (the GNU toolchain, stable-x86_64-pc-windows-gnu, gives LLDB fuller debug info).' : '' };
    },
  },
  notes: () => 'build with cargo build (cargo build --release for a program to hand over), test with cargo test, run with cargo run -- <args>. Run commands directly with the shell tool, never through a wrapper script. For a panic, run it again with RUST_BACKTRACE=1 to see where. A program that reads a terminal (prompts, a TUI) goes in the terminal tool. The debug tool builds the crate a .rs file belongs to and runs its program under LLDB, which stops at a panic by itself.',
  test: { needs: ['rust'] },
};
