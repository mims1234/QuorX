// Python pack self-test: a script runs, and the debugger (debugpy, over DAP) stops at a breakpoint and reads a value.
// Set QX_PYTHON to the interpreter to use (one with debugpy installed), e.g. QX_PYTHON="C:\venv\Scripts\python.exe".
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';

const PY = process.env.QX_PYTHON || (WIN ? 'py' : 'python3');
const PYARGS = process.env.QX_PYTHON ? [] : WIN ? ['-3'] : [];
const hasDebugpy = () => spawnSync(PY, [...PYARGS, '-c', 'import debugpy'], { shell: WIN && !process.env.QX_PYTHON, stdio: 'ignore' }).status === 0;

const APP = 'def total(items):\n    s = 0\n    for price, qty in items:\n        s += price * qty\n    return s\n\nprint(total([(2, 3), (5, "2")]))\n';

test('python: a script runs', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  const dir = project('py', { 'hello.py': 'import sys\nprint("hello", len(sys.argv) - 1)\n' });
  assert.match(execFileSync(PY, [...PYARGS, 'hello.py', 'x', 'y'], { cwd: dir, encoding: 'utf8', shell: WIN && !process.env.QX_PYTHON }), /hello 2/);
});

test('python: the debugger stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!hasDebugpy()) return t.skip('debugpy is not installed (pip install debugpy, or set QX_PYTHON to a Python that has it)');
  const dir = project('pydbg', { 'app.py': APP });
  const python = process.env.QX_PYTHON ? `"${process.env.QX_PYTHON}"` : WIN ? 'py -3' : 'python3';
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'app.py', python });
  try {
    assert.match(await debugBreak(s.id, 'app.py', 4), /breakpoint at app\.py:4/);
    let st = await debugMove(s.id, 'continue', 15000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 4);
    st = await debugMove(s.id, 'continue', 15000); // the second item: qty is a string
    assert.equal(await debugEval(s.id, 'type(qty).__name__'), "'str'");
  } finally { await debugStop(s.id).catch(() => {}); }
});
