// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Node pack self-test: the debugger (V8's inspector) stops at a breakpoint and evaluates in the paused frame.
import { project, skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';

test('node: the debugger stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('node'); if (skip) return t.skip(skip);
  const dir = project('nodedbg', { 'app.js': 'function total(items) {\n  let sum = 0;\n  for (const it of items) {\n    sum += it.price * it.qty;\n  }\n  return sum;\n}\nconsole.log(total([{ price: 2, qty: 3 }, { price: 5, qty: \'2\' }]));\n' });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'app.js' });
  try {
    await debugBreak(s.id, 'app.js', 4);
    let st = await debugMove(s.id, 'continue');
    assert.equal(st.state, 'paused');
    st = await debugMove(s.id, 'continue');
    assert.match(await debugEval(s.id, 'typeof it.qty'), /^"?string"?$/);
  } finally { await debugStop(s.id).catch(() => {}); }
});
