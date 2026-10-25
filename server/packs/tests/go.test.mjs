// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Go pack self-test: go vet catches a mistake in a changed file, a program runs, and Delve stops at a breakpoint.
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';
import { DLV_INSTALL } from '../go.js';

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

test('go: the debugger (Delve) stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('go'); if (skip) return t.skip(skip);
  if (await skipUnless('dlv')) return t.skip(`Delve is not installed (${DLV_INSTALL})`);
  const dir = project('go-dbg', { 'go.mod': 'module qxpack\n\ngo 1.21\n', 'main.go': 'package main\n\nimport "fmt"\n\nfunc total(prices []int) int {\n\ts := 0\n\tfor _, p := range prices {\n\t\ts += p\n\t}\n\treturn s\n}\n\nfunc main() {\n\tfmt.Println(total([]int{2, 3, 4}))\n}\n' });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'main.go' });
  try {
    assert.match(await debugBreak(s.id, 'main.go', 8), /breakpoint at main\.go:8/);
    let st = await debugMove(s.id, 'continue', 120000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 8);
    assert.ok(st.locals.includes('p = 2'), `locals: ${st.locals.join(', ')}`);
    st = await debugMove(s.id, 'continue', 15000);
    assert.equal(await debugEval(s.id, 'p * 10'), '30');
  } finally { await debugStop(s.id).catch(() => {}); }
});
