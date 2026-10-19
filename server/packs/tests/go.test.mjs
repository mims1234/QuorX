// Go pack self-test: go vet catches a mistake in a changed file, and a program runs.
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';

test('go: go vet catches a mistake in a changed file', async (t) => {
  const skip = await skipUnless('go'); if (skip) return t.skip(skip);
  const dir = project('go', { 'go.mod': 'module qxpack\n\ngo 1.21\n', 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Printf("%d items\\n", "three")\n}\n' });
  const r = await languageChecks(dir, ['main.go'], { have: ['go'] });
  assert.equal(r.ran[0]?.lang, 'go');
  assert.ok(r.problems.some((p) => /main\.go/.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('go: a program runs', async (t) => {
  const skip = await skipUnless('go'); if (skip) return t.skip(skip);
  const dir = project('go-run', { 'go.mod': 'module qxpack\n\ngo 1.21\n', 'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Printf("%d words\\n", len(os.Args)-1)\n}\n' });
  assert.match(execFileSync('go', ['run', '.', 'a', 'b', 'c'], { cwd: dir, encoding: 'utf8', shell: WIN, timeout: 300000 }), /3 words/);
});
