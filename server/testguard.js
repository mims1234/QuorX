// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Gamed tests: an agent can make a failing build "pass" by deleting a test file or weakening its assertions.
// Before the final reply, every test file this reply changed is compared with its undo copy: fewer assertions,
// skipped tests, or a deleted test file are reported, so the agent must restore them or explain, and the user sees it.
import fs from 'node:fs';
import path from 'node:path';

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rs)$|Tests?\.(cs|java|kt)$/i;
// Lines that assert something, across the common test styles.
const ASSERT = /\b(assert\w*|expect|should|assertEquals|assertThat|Assert\.\w+|t\.(Error|Fatal|Fail)\w*|require\.\w+|EXPECT_\w+|ASSERT_\w+|check\w*!?|pytest\.raises|self\.assert\w+|verify)\s*[(!.]|^\s*assert\s/;
const SKIP = /\b(it|test|describe)\.(skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]|\[Ignore\]|@Disabled|t\.Skip\(|\.only\s*\(/;

const count = (text, re) => String(text || '').split(/\r?\n/).filter((l) => re.test(l) && !/^\s*(\/\/|#|\*)/.test(l)).length;

/**
 * root: project folder; changed: project-relative paths; before(rel): the file's text before this reply, or null if
 * it didn't exist. Returns [{ file, kind: 'deleted'|'fewer'|'skipped', before, after, note }].
 */
export function testChanges(root, changed, before) {
  const out = [];
  for (const rel of changed.filter((f) => TEST_FILE.test(f.replaceAll('\\', '/')))) {
    const was = before(rel);
    if (was == null) continue; // a new test file: nothing was weakened
    const nowPath = path.join(root, rel);
    const now = fs.existsSync(nowPath) ? fs.readFileSync(nowPath, 'utf8') : null;
    if (now == null) { out.push({ file: rel, kind: 'deleted', before: count(was, ASSERT), after: 0, note: `${rel} was deleted (it had ${count(was, ASSERT)} assertions)` }); continue; }
    const a = count(was, ASSERT), b = count(now, ASSERT);
    if (b < a) out.push({ file: rel, kind: 'fewer', before: a, after: b, note: `${rel} has ${a - b} fewer assertion${a - b > 1 ? 's' : ''} than before (${a} → ${b})` });
    const sa = count(was, SKIP), sb = count(now, SKIP);
    if (sb > sa) out.push({ file: rel, kind: 'skipped', before: sa, after: sb, note: `${rel} now skips or isolates ${sb - sa} more test${sb - sa > 1 ? 's' : ''}` });
  }
  return out;
}
