// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Unity pack self-test. The compile-log parser, the test-results summary and finding editors are tested anywhere on
// fixtures. With a Unity editor (and a license), a small project is imported, the check catches a C# error in a
// changed file, and EditMode tests run with their results summarised. The import takes a few minutes.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { parseUnity, summarizeTestResults, projectUnityVersion, unityEditors, editorFor } from '../unity.js';
import { packsIn } from '../index.js';

const LOG = `[Licensing::Client] Successfully resolved entitlements
Assets/Scripts/Player.cs(12,13): error CS0103: The name 'speeed' does not exist in the current context
Assets/Scripts/Player.cs(20,5): warning CS0168: The variable 'e' is declared but never used
Assets\\Scripts\\Enemy.cs(7,1): error CS1002: ; expected
Scripts have compiler errors.
Assets/Scripts/Player.cs(12,13): error CS0103: The name 'speeed' does not exist in the current context
Exiting without the bug reporter. Application will terminate with return code 1`;

const XML = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed(Child)" total="3" passed="1" failed="1" inconclusive="0" skipped="1" asserts="0" engine-version="3.5.0.0">
  <test-suite type="TestSuite" name="QxGame" fullname="QxGame">
    <test-case id="1001" name="AddsScore" fullname="Tests.ScoreTests.AddsScore" result="Passed" duration="0.01" />
    <test-case id="1002" name="LosesLife" fullname="Tests.ScoreTests.LosesLife" result="Failed" duration="0.02">
      <failure>
        <message><![CDATA[  Expected: 2
  But was:  3
]]></message>
        <stack-trace><![CDATA[at Tests.ScoreTests.LosesLife () [0x00001] in C:\\qx\\Assets\\Tests\\ScoreTests.cs:18
]]></stack-trace>
      </failure>
    </test-case>
    <test-case id="1003" name="Later" fullname="Tests.ScoreTests.Later" result="Skipped" />
  </test-suite>
</test-run>`;

test('unity: the compile-log parser reads C# errors with file and line, each once, and no warnings', () => {
  assert.deepEqual(parseUnity(LOG), [
    "Assets/Scripts/Player.cs:12: error CS0103: The name 'speeed' does not exist in the current context",
    'Assets/Scripts/Enemy.cs:7: error CS1002: ; expected',
  ]);
  assert.deepEqual(parseUnity('Exiting batchmode successfully now!'), []);
});

test('unity: test results are summarised with the failing test and where it failed', () => {
  const s = summarizeTestResults(XML);
  assert.match(s, /^3 tests: 1 passed, 1 failed, 1 skipped \(Failed\(Child\)\)\./);
  assert.match(s, /✗ Tests\.ScoreTests\.LosesLife: Expected: 2 \(Assets\\Tests\\ScoreTests\.cs:18\)/);
  assert.match(summarizeTestResults('<xml/>'), /No test results/);
});

test('unity: the project version is read, and the matching editor found among Hub\'s folders', () => {
  assert.equal(projectUnityVersion('m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: 2022.3.10f1 (ff3792e53c62)\n'), '2022.3.10f1');
  const root = project('unity-hub', {
    [`Editor/2022.3.10f1/${WIN ? 'Editor/Unity.exe' : process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : 'Editor/Unity'}`]: '',
    [`Editor/6000.0.23f1/${WIN ? 'Editor/Unity.exe' : process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : 'Editor/Unity'}`]: '',
    'Editor/not-a-version/readme.txt': '',
    'Other/2021.3.5f1/Editor/Unity.exe': '',
  });
  const hubDir = project('unity-hubdata', { 'editors-v2.json': JSON.stringify({ data: [{ location: [path.join(root, 'Other', '2021.3.5f1', 'Editor', 'Unity.exe')], version: '2021.3.5f1' }] }) });
  const eds = unityEditors({ hubDir, roots: [path.join(root, 'Editor')] });
  assert.deepEqual(eds.map((e) => e.version), ['6000.0.23f1', '2022.3.10f1', '2021.3.5f1']);
  const proj = project('unity-proj', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.10f1\n', 'Assets/.keep': '' });
  assert.equal(editorFor(proj, eds).exe, eds.find((e) => e.version === '2022.3.10f1').exe);
  assert.equal(editorFor(project('unity-proj2', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2019.4.1f1\n' }), eds).exe, null);
  assert.ok(packsIn(proj).some((p) => p.id === 'unity'), 'a Unity project is recognised');
});

// A small project for the newest installed editor, imported once (the slow part) and shared by the tests below.
let imported = null;
async function importedProject(t) {
  const skip = await skipUnless('unity'); if (skip) { t.skip(skip); return null; }
  if (imported) return imported;
  const ed = unityEditors()[0];
  const dir = project('unity-real', {
    'ProjectSettings/ProjectVersion.txt': `m_EditorVersion: ${ed.version}\n`,
    'Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.test-framework': '1.1.33' } }, null, 2),
    'Assets/Scripts/Score.cs': 'public static class Score {\n    public static int Add(int a, int b) => a + b;\n}\n',
    'Assets/Tests/Tests.asmdef': JSON.stringify({ name: 'Tests', references: ['UnityEngine.TestRunner', 'UnityEditor.TestRunner'], includePlatforms: ['Editor'], optionalUnityReferences: ['TestAssemblies'] }),
    'Assets/Tests/ScoreTests.cs': 'using NUnit.Framework;\npublic class ScoreTests {\n    [Test] public void Adds() { Assert.AreEqual(5, 2 + 3); }\n    [Test] public void Fails() { Assert.AreEqual(2, 3); }\n}\n',
  });
  let out = '';
  try { out = execFileSync(ed.exe, ['-batchmode', '-nographics', '-quit', '-projectPath', dir, '-logFile', '-'], { encoding: 'utf8', timeout: 12 * 60e3, stdio: 'pipe', maxBuffer: 256e6 }); } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  if (/No valid Unity Editor license|license is not active|activate your license/i.test(out)) { t.skip('Unity has no active license here (sign in to Unity Hub)'); return null; }
  assert.ok(fs.existsSync(path.join(dir, 'Library')), `the project was imported. Log tail: ${out.slice(-800)}`);
  return (imported = { dir, ed });
}

test('unity: QuorX finds the installed editors', async (t) => {
  const skip = await skipUnless('unity'); if (skip) return t.skip(skip);
  assert.match((await tool('unity')).version, /^\d{4}\.\d+\.\d+/);
});

test('unity: the batchmode check catches a C# error in a changed file', async (t) => {
  const p = await importedProject(t); if (!p) return;
  fs.writeFileSync(path.join(p.dir, 'Assets', 'Scripts', 'Player.cs'), 'public class Player {\n    public int Lives() => livez;\n}\n');
  try {
    const r = await languageChecks(p.dir, ['Assets/Scripts/Player.cs'], { have: ['unity'] });
    assert.equal(r.ran[0]?.lang, 'unity');
    assert.ok(r.problems.some((x) => /Player\.cs:2: error CS0103/.test(x)), `problems: ${r.problems.join(' | ')}`);
  } finally { fs.rmSync(path.join(p.dir, 'Assets', 'Scripts', 'Player.cs'), { force: true }); }
});

test('unity: EditMode tests run and the results are summarised', async (t) => {
  const p = await importedProject(t); if (!p) return;
  const xml = path.join(p.dir, 'TestResults.xml');
  let out = '';
  try { out = execFileSync(p.ed.exe, ['-batchmode', '-nographics', '-projectPath', p.dir, '-runTests', '-testPlatform', 'EditMode', '-testResults', xml, '-logFile', '-'], { encoding: 'utf8', timeout: 10 * 60e3, stdio: 'pipe', maxBuffer: 256e6 }); } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  assert.ok(fs.existsSync(xml), `a results file was written. Log tail: ${out.slice(-800)}`);
  const s = summarizeTestResults(fs.readFileSync(xml, 'utf8'));
  assert.match(s, /2 tests: 1 passed, 1 failed/);
  assert.match(s, /ScoreTests\.Fails/);
});

test('unity: a -runTests command gets the results summarised above its output, and notes name the project\'s editor', async () => {
  const { outputSummary, packNotes } = await import('../index.js');
  const dir = project('unity-results', { 'TestResults.xml': XML, 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2019.4.1f1\n' });
  const log = `Running tests for EditMode\nSaving results to: ${path.join(dir, 'TestResults.xml')}\nTest run completed. Exiting with code 2 (Failed).\n`;
  const s = outputSummary('"C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.23f1\\Editor\\Unity.exe" -batchmode -projectPath . -runTests -testPlatform EditMode -testResults TestResults.xml -logFile -', log);
  assert.match(s, /^Unity tests: 3 tests: 1 passed, 1 failed/);
  assert.equal(outputSummary('Unity.exe -batchmode -quit -projectPath .', log), '', 'only test runs are summarised');
  assert.match(packNotes(dir, []), /This project needs Unity 2019\.4\.1f1, which is not installed/);
});
