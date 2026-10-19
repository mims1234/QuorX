// Java pack self-test: the JDK runs a one-file program (Java 11+ runs a .java file directly).
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('jvm: the JDK runs a program', async (t) => {
  const skip = await skipUnless('java'); if (skip) return t.skip(skip);
  const dir = project('jvm', { 'Words.java': 'public class Words { public static void main(String[] a) { System.out.println(a.length + " words"); } }\n' });
  assert.match(execFileSync('java', ['Words.java', 'a', 'b', 'c'], { cwd: dir, encoding: 'utf8', shell: WIN, timeout: 120000 }), /3 words/);
});
