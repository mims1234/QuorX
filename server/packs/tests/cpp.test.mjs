// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// C/C++ pack self-test: CMake configures and builds a small program with whichever compiler it finds, and it runs;
// the CMake build check catches an error in a changed file; lldb-dap stops at a breakpoint and reads a variable.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';

const CMAKE = 'cmake_minimum_required(VERSION 3.16)\nproject(qxpack CXX)\nadd_executable(qxpack main.cpp)\n';
const TOTAL = '#include <cstdio>\nint total(const int* xs, int n) {\n  int s = 0;\n  for (int i = 0; i < n; i++) {\n    s += xs[i];\n  }\n  return s;\n}\nint main() {\n  int xs[] = {2, 3, 4};\n  std::printf("%d\\n", total(xs, 3));\n  return 0;\n}\n';
async function needCompiler(t) {
  const skip = await skipUnless('cmake'); if (skip) return t.skip(skip) || true;
  const compilers = await Promise.all(['msvc', 'gcc', 'clang'].map(tool));
  if (!compilers.some((c) => c.found)) return t.skip('no C++ compiler found (Visual Studio Build Tools, GCC or Clang)') || true;
  return false;
}
const configure = (dir) => execFileSync('cmake', ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Debug'], { cwd: dir, stdio: 'pipe', shell: WIN, timeout: 300000 });

test('cpp: CMake builds a program that runs', async (t) => {
  if (await needCompiler(t)) return;
  const dir = project('cpp', {
    'CMakeLists.txt': CMAKE,
    'main.cpp': '#include <iostream>\nint main(int argc, char**) { std::cout << (argc - 1) << " words\\n"; return 0; }\n',
  });
  configure(dir);
  execFileSync('cmake', ['--build', 'build'], { cwd: dir, stdio: 'pipe', shell: WIN, timeout: 300000 });
  // Visual Studio puts it in build/Debug; Makefiles and Ninja in build/.
  const exe = ['build/Debug/qxpack.exe', 'build/qxpack.exe', 'build/qxpack'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  assert.ok(exe, 'the program was built');
  assert.match(execFileSync(exe, ['a', 'b', 'c'], { encoding: 'utf8' }), /3 words/);
});

test('cpp: the CMake build check catches an error in a changed file', async (t) => {
  if (await needCompiler(t)) return;
  const dir = project('cpp-check', { 'CMakeLists.txt': CMAKE, 'main.cpp': TOTAL });
  assert.equal((await languageChecks(dir, ['main.cpp'], { have: ['cmake'] })).ran.length, 0, 'no build folder yet: nothing is configured for the user');
  configure(dir);
  fs.writeFileSync(path.join(dir, 'main.cpp'), TOTAL.replace('int s = 0;', 'int s = "zero";'));
  const r = await languageChecks(dir, ['main.cpp'], { have: ['cmake'] });
  assert.equal(r.ran[0]?.lang, 'cmake');
  assert.ok(r.problems.some((p) => /main\.cpp/.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('cpp: the debugger (lldb-dap) stops at a breakpoint and reads a variable', async (t) => {
  if (await needCompiler(t)) return;
  const lldb = await tool('lldb');
  if (!lldb.found) return t.skip('lldb-dap is not installed (it comes with LLVM 18 or later)');
  if (!lldb.works) return t.skip(`lldb-dap is installed but ${lldb.problem}`);
  const dir = project('cpp-dbg', { 'CMakeLists.txt': CMAKE, 'main.cpp': TOTAL });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'main.cpp' }); // QuorX configures and builds it
  try {
    assert.match(await debugBreak(s.id, 'main.cpp', 5), /breakpoint at main\.cpp:5/);
    let st = await debugMove(s.id, 'continue', 30000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 5);
    assert.ok(st.locals.some((l) => /^i = 0$/.test(l)), `locals: ${st.locals.join(', ')}`);
    st = await debugMove(s.id, 'continue', 15000);
    assert.equal(await debugEval(s.id, 'xs[i] * 10'), '30');
  } finally { await debugStop(s.id).catch(() => {}); }
});
