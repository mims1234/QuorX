// Rust pack self-test: QuorX knows whether Rust can build here, cargo check catches errors, and a build runs.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';

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
