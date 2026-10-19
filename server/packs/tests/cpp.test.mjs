// C/C++ pack self-test: CMake configures and builds a small program with whichever compiler it finds, and it runs.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('cpp: CMake builds a program that runs', async (t) => {
  const skip = await skipUnless('cmake'); if (skip) return t.skip(skip);
  const compilers = await Promise.all(['msvc', 'gcc', 'clang'].map(tool));
  if (!compilers.some((c) => c.found)) return t.skip('no C++ compiler found (Visual Studio Build Tools, GCC or Clang)');
  const dir = project('cpp', {
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.16)\nproject(qxpack CXX)\nadd_executable(qxpack main.cpp)\n',
    'main.cpp': '#include <iostream>\nint main(int argc, char**) { std::cout << (argc - 1) << " words\\n"; return 0; }\n',
  });
  execFileSync('cmake', ['-S', '.', '-B', 'build'], { cwd: dir, stdio: 'pipe', shell: WIN, timeout: 300000 });
  execFileSync('cmake', ['--build', 'build'], { cwd: dir, stdio: 'pipe', shell: WIN, timeout: 300000 });
  // Visual Studio puts it in build/Debug; Makefiles and Ninja in build/.
  const exe = ['build/Debug/qxpack.exe', 'build/qxpack.exe', 'build/qxpack'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  assert.ok(exe, 'the program was built');
  assert.match(execFileSync(exe, ['a', 'b', 'c'], { encoding: 'utf8' }), /3 words/);
});
