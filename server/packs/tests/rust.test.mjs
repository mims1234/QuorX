// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Rust pack self-test: QuorX knows whether Rust can build here, cargo check catches errors, a build runs, the
// debugger finds the binary for a file and stops at a breakpoint.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { debugStart, debugBreak, debugMove, debugStop } from '../../debugger.js';
import { cargoProgram } from '../rust.js';
import { findCodeLldb } from '../_lldb.js';

const crate = (main) => ({ 'Cargo.toml': '[package]\nname = "qxpack"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n', 'src/main.rs': main });

test('rust: QuorX can tell whether Rust can build programs here', async (t) => {
  const skip = await skipUnless('rust'); if (skip) return t.skip(skip);
  const r = await tool('rust');
  assert.ok(r.version, 'a version was read');
  if (!r.works) assert.match(r.problem, /linker|rustc/i, 'a missing linker is named');
});

test('rust: cargo check catches an error in a changed file', async (t) => {
  const skip = await skipUnless('rust'); if (skip) return t.skip(skip);
  const dir = project('rust', crate('fn main() {\n    let n: u32 = "three";\n    println!("{n}");\n}\n'));
  const r = await languageChecks(dir, ['src/main.rs'], { have: ['rust'] });
  assert.equal(r.ran[0]?.lang, 'rust');
  assert.ok(r.problems.some((p) => /main\.rs/.test(p) && /mismatched|expected/i.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('rust: a program builds and runs', async (t) => {
  const skip = await skipUnless('rust', { works: true }); if (skip) return t.skip(skip);
  const dir = project('rust-run', crate('fn main() {\n    let words = std::env::args().skip(1).count();\n    println!("{words} words");\n}\n'));
  execFileSync('cargo', ['build', '--quiet'], { cwd: dir, shell: WIN, stdio: 'pipe', timeout: 300000 });
  const exe = path.join(dir, 'target', 'debug', WIN ? 'qxpack.exe' : 'qxpack');
  assert.ok(fs.existsSync(exe), 'the program was built');
  assert.match(execFileSync(exe, ['a', 'b', 'c'], { encoding: 'utf8' }), /3 words/);
});

test('rust: the debugger (lldb-dap or CodeLLDB) stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('rust', { works: true }); if (skip) return t.skip(skip);
  const lldb = await tool('lldb');
  if (!findCodeLldb() && !(lldb.found && lldb.works)) return t.skip(lldb.found ? `lldb-dap is installed but ${lldb.problem}` : 'neither lldb-dap (LLVM 18 or later) nor CodeLLDB is installed');
  const dir = project('rust-dbg', crate('fn total(prices: &[u32]) -> u32 {\n    let mut s = 0;\n    for p in prices {\n        s += p;\n    }\n    s\n}\n\nfn main() {\n    println!("{}", total(&[2, 3, 4]));\n}\n'));
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'src/main.rs' }); // QuorX builds it with cargo
  try {
    assert.match(await debugBreak(s.id, 'src/main.rs', 4), /breakpoint at main\.rs:4/);
    let st = await debugMove(s.id, 'continue', 30000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 4);
    assert.ok(st.locals.some((l) => /^s = 0$/.test(l)), `locals: ${st.locals.join(', ')}`);
    st = await debugMove(s.id, 'continue', 15000);
    assert.ok(st.locals.some((l) => /^s = 2$/.test(l)), `locals: ${st.locals.join(', ')}`);
  } finally { await debugStop(s.id).catch(() => {}); }
});

// On Windows without a linker, Rust's GNU toolchain (when rustup has it) still builds: it brings its own.
const gnu = () => { try { return WIN && /stable-x86_64-pc-windows-gnu/.test(execFileSync('rustup', ['toolchain', 'list'], { encoding: 'utf8', shell: true })); } catch { return false; } };

test('rust: the debugger finds the binary cargo builds for a file', async (t) => {
  const skip = await skipUnless('rust', { works: true }), useGnu = !!skip && !(await skipUnless('rust')) && gnu();
  if (skip && !useGnu) return t.skip(skip);
  const dir = project('rust-bins', { ...crate('mod parse;\nfn main() {}\n'), 'src/parse.rs': 'pub fn p() {}\n', 'src/bin/tool.rs': 'fn main() {}\n',
    ...(useGnu ? { 'rust-toolchain.toml': '[toolchain]\nchannel = "stable-x86_64-pc-windows-gnu"\n' } : {}) });
  const exe = (n) => path.join(dir, 'target', 'debug', WIN ? `${n}.exe` : n);
  assert.equal((await cargoProgram(dir, 'src/parse.rs')).program, exe('qxpack'));
  assert.equal((await cargoProgram(dir, 'src/bin/tool.rs')).program, exe('tool'));
  fs.writeFileSync(path.join(dir, 'src', 'parse.rs'), 'pub fn p() -> u32 { "x" }\n');
  await assert.rejects(cargoProgram(dir, 'src/parse.rs'), /cargo build failed: .*mismatched types/);
});
