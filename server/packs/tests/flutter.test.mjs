// Flutter and Dart pack self-test. Run everywhere: the flutter doctor and flutter test parsers, and Dart debugging
// through the stdio bridge with a stand-in adapter (so the bridge, the debugger and Stop are tested without Dart).
// With Dart: a real breakpoint. With Flutter: flutter analyze catches an error; on Windows, a new app is built, its
// window read through UI Automation and its button pressed (several minutes the first time).
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseDoctor, doctorSummary, parseTestOutput, testSummary, isFlutterProject, ANALYZE_ERRORS, DESKTOP } from '../flutter.js';
import { outputSummary, debugAdapters } from '../index.js';
import { languageChecks } from '../../langchecks.js';
import { debugStart, debugBreak, debugMove, debugEval, debugStop, debugGateLine } from '../../debugger.js';
import { getBackground } from '../../bgjobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLUTTER_PUBSPEC = 'name: qx_app\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter:\n    sdk: flutter\n';
const DART_PUBSPEC = 'name: qx_dbg\nenvironment:\n  sdk: ^3.0.0\n';

// ---------- flutter doctor ----------
const DOCTOR_WIN = `Doctor summary (to see all details, run flutter doctor -v):
[√] Flutter (Channel stable, 3.24.3, on Microsoft Windows [Version 10.0.26100.2033], locale en-US)
[√] Windows Version (Installed version of Windows is version 10 or higher)
[X] Android toolchain - develop for Android devices
    X Unable to locate Android SDK.
      Install Android Studio from: https://developer.android.com/studio/index.html
[√] Chrome - develop for the web
[!] Visual Studio - develop Windows apps (Visual Studio Build Tools 2022 17.11.5)
    X Visual Studio is missing necessary components. Please re-run the Visual Studio installer for the "Desktop development with C++" workload, and include these components:
        MSVC v142 - VS 2019 C++ x64/x86 build tools
[!] Android Studio (not installed)
[√] Connected device (3 available)
[√] Network resources

! Doctor found issues in 3 categories.`;
const DOCTOR_MAC = `[✓] Flutter (Channel stable, 3.24.3, on macOS 15.0 24A335 darwin-arm64, locale en-GB)
[!] Android toolchain - develop for Android devices (Android SDK version 35.0.0)
    ✗ cmdline-tools component is missing
    ! Some Android licenses not accepted. To resolve this, run: flutter doctor --android-licenses
[✓] Xcode - develop for iOS and macOS (Xcode 16.0)
[✓] Connected device (2 available)`;

test('flutter: flutter doctor output says what is ready and what is missing', () => {
  const w = parseDoctor(DOCTOR_WIN);
  assert.deepEqual(w.map((i) => [i.name, i.status]), [['Flutter', 'ok'], ['Windows Version', 'ok'], ['Android toolchain', 'missing'], ['Chrome', 'ok'], ['Visual Studio', 'partial'], ['Android Studio', 'partial'], ['Connected device', 'ok'], ['Network resources', 'ok']]);
  assert.deepEqual(w[2].problems, ['Unable to locate Android SDK.']);
  const s = doctorSummary(DOCTOR_WIN);
  assert.match(s, /^flutter doctor: ready: Flutter, Windows Version, Chrome, Connected device, Network resources\./);
  assert.match(s, /- Missing: Android toolchain \(Unable to locate Android SDK\.\): building for Android needs the Android SDK/);
  assert.match(s, /- Needs work: Visual Studio \(Visual Studio is missing necessary components.*C\+\+ workload/);
  const m = parseDoctor(DOCTOR_MAC);
  assert.equal(m[0].status, 'ok'); assert.equal(m[1].status, 'partial');
  assert.deepEqual(m[1].problems, ['cmdline-tools component is missing', 'Some Android licenses not accepted. To resolve this, run: flutter doctor --android-licenses']);
  assert.match(doctorSummary(DOCTOR_MAC), /the user runs flutter doctor --android-licenses/, 'licences are the user\'s to accept');
  assert.match(doctorSummary('[√] Flutter (Channel stable, 3.24.3)\n[√] Connected device (1 available)'), /everything is ready/);
  assert.equal(doctorSummary('flutter: command not found'), null);
  assert.match(outputSummary('flutter doctor', DOCTOR_WIN), /^flutter doctor: ready/);
});

// ---------- flutter test ----------
const TEST_FLUTTER = `00:00 +0: loading C:/qx/app/test/widget_test.dart
00:02 +0: Counter increments smoke test
══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞════════════════════════════════════════════════════
The following TestFailure was thrown running a test:
Expected: exactly one matching candidate
  Actual: _TextWidgetFinder:<Found 0 widgets with text "1": []>
   Which: means none were found but one was expected

When the exception was thrown, this was the stack:
#4      main.<anonymous closure> (file:///C:/qx/app/test/widget_test.dart:28:5)
<asynchronous suspension>
#5      testWidgets.<anonymous closure>.<anonymous closure> (package:flutter_test/src/widget_tester.dart:189:15)
<asynchronous suspension>

This was caught by the test expectation on the following line:
  file:///C:/qx/app/test/widget_test.dart line 28
The test description was:
  Counter increments smoke test
════════════════════════════════════════════════════════════════════════════════════════════════════
00:02 +0 -1: Counter increments smoke test [E]
  Test failed. See exception logs above.
  The test description was: Counter increments smoke test

00:03 +1 -1: title shows
00:03 +2 -1: Some tests failed.`;
const TEST_DART = `00:00 +0: test/cart_test.dart: total adds prices
00:00 +0 -1: test/cart_test.dart: total adds prices [E]
  Expected: <16>
    Actual: <11>

  package:matcher                expect
  test/cart_test.dart 9:5        main.<fn>

00:00 +0 -1: test/cart_test.dart: empty cart is zero
00:00 +1 ~1 -1: Some tests failed.`;
const TEST_COMPILE = `00:00 +0: loading test/widget_test.dart
00:01 +0 -1: loading test/widget_test.dart [E]
  Failed to load "test/widget_test.dart":
  test/widget_test.dart:14:5: Error: The method 'pumpWidgt' isn't defined for the class 'WidgetTester'.
00:01 +0 -1: Some tests failed.`;

test('flutter: flutter test output says which tests failed, why and where', () => {
  const f = parseTestOutput(TEST_FLUTTER);
  assert.deepEqual([f.passed, f.failed, f.skipped, f.done], [2, 1, 0, 'failed']);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].test, 'Counter increments smoke test');
  assert.deepEqual(f.failures[0].why.slice(0, 3), ['Expected: exactly one matching candidate', 'Actual: _TextWidgetFinder:<Found 0 widgets with text "1": []>', 'Which: means none were found but one was expected']);
  assert.equal(f.failures[0].where, 'test/widget_test.dart:28:5');
  const d = parseTestOutput(TEST_DART);
  assert.deepEqual([d.passed, d.failed, d.skipped], [1, 1, 1]);
  assert.equal(d.failures[0].test, 'test/cart_test.dart: total adds prices');
  assert.deepEqual(d.failures[0].why.slice(0, 2), ['Expected: <16>', 'Actual: <11>']);
  const c = parseTestOutput(TEST_COMPILE);
  assert.equal(c.failures[0].test, 'loading test/widget_test.dart (it did not compile)');
  assert.deepEqual(c.failures[0].why, ["test/widget_test.dart:14:5: Error: The method 'pumpWidgt' isn't defined for the class 'WidgetTester'."]);
  assert.deepEqual(parseTestOutput('00:01 +0: loading x\n00:04 +6: All tests passed!').done, 'passed');
  const s = testSummary(TEST_FLUTTER);
  assert.match(s, /^Tests: 2 passed, 1 failed\.\n- Counter increments smoke test \(test\/widget_test\.dart:28:5\): Expected: exactly one/);
  assert.match(outputSummary('flutter test test/widget_test.dart', TEST_FLUTTER), /^Tests: 2 passed, 1 failed/);
  assert.match(outputSummary('dart test', TEST_DART), /1 skipped/);
  assert.equal(testSummary('Running "flutter pub get" in app...'), null);
});

test('flutter: analyze errors count, warnings and infos do not', () => {
  assert.ok(ANALYZE_ERRORS.test("error • Undefined name 'cout' • lib/main.dart:12:5 • undefined_identifier"));
  assert.ok(ANALYZE_ERRORS.test("error - lib/main.dart:12:5 - Undefined name 'cout'. - undefined_identifier"));
  assert.ok(!ANALYZE_ERRORS.test("warning • Unused import: 'dart:io' • lib/main.dart:1:8 • unused_import"));
  assert.ok(!ANALYZE_ERRORS.test("info • Don't use 'BuildContext's across async gaps • lib/main.dart:40:7 • use_build_context_synchronously"));
  assert.ok(isFlutterProject(project('flpub', { 'pubspec.yaml': FLUTTER_PUBSPEC })));
  assert.ok(!isFlutterProject(project('dartpub', { 'pubspec.yaml': DART_PUBSPEC })));
});

// ---------- Dart debugging through the stdio bridge ----------
test('flutter: the stdio bridge carries a Dart debug session, and Stop ends the adapter', async () => {
  const pidFile = path.join(os.tmpdir(), `qx-fake-dap-${process.pid}.pid`);
  const before = { dart: process.env.QX_DART, pid: process.env.QX_FAKE_DAP_PID };
  process.env.QX_DART = `"${process.execPath}" "${path.join(HERE, '_fake-dap.cjs')}"`;
  process.env.QX_FAKE_DAP_PID = pidFile;
  const dir = project('dartbridge', { 'pubspec.yaml': DART_PUBSPEC, 'bin/main.dart': 'void main() {\n  var total = 42;\n  print(total);\n}\n' });
  assert.ok(debugAdapters().some((a) => a.exts.includes('.dart')));
  assert.equal(debugGateLine('bin/main.dart'), 'dart run bin/main.dart', 'the rules and the approval card see dart run');
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'bin/main.dart', logTo: path.join(dir, 'debug.log') });
  try {
    assert.equal(s.kind, 'flutter');
    assert.match(await debugBreak(s.id, 'bin/main.dart', 3), /breakpoint at main\.dart:3/);
    const st = await debugMove(s.id, 'continue', 10000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 3);
    assert.ok(st.locals.includes('total = 42'), st.locals.join(', '));
    assert.equal(await debugEval(s.id, 'total * 2'), '84');
  } finally {
    const r = await debugStop(s.id);
    assert.ok(!r.already, 'the job was still running until Stop');
    if (before.dart == null) delete process.env.QX_DART; else process.env.QX_DART = before.dart;
    if (before.pid == null) delete process.env.QX_FAKE_DAP_PID; else process.env.QX_FAKE_DAP_PID = before.pid;
  }
  assert.notEqual(getBackground(s.job).status, 'running', 'Stop ended the debug job');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), 'the adapter behind the bridge has ended too');
  fs.rmSync(pidFile, { force: true });
  assert.match(fs.readFileSync(path.join(dir, 'debug.log'), 'utf8'), /dapbridge: .*debug_adapter on 127\.0\.0\.1:\d+/);
});

test('flutter: a Flutter file is debugged with flutter run on this computer\'s desktop', () => {
  const dir = project('flgate', { 'pubspec.yaml': FLUTTER_PUBSPEC, 'lib/main.dart': 'void main() {}\n' });
  const a = debugAdapters().find((x) => x.exts.includes('.dart'));
  assert.equal(a.gate({ file: 'lib/main.dart', args: [], cwd: dir }), `flutter run -d ${DESKTOP} -t lib/main.dart`);
  assert.equal(a.gate({ file: 'lib/main.dart', args: ['-d', 'emulator-5554'], cwd: dir }), 'flutter run -d emulator-5554 -t lib/main.dart');
  const plan = a.start({ file: 'lib/main.dart', args: [], cwd: dir });
  assert.equal(plan.stdio, true); assert.match(plan.line, /flutter debug_adapter$/);
  assert.deepEqual(plan.args.toolArgs, ['-d', DESKTOP]);
  assert.equal(plan.args.program, path.join(dir, 'lib', 'main.dart'));
});

// ---------- with Dart or Flutter installed ----------
const DBG = 'int total(List<List<int>> items) {\n  var sum = 0;\n  for (final item in items) {\n    sum += item[0] * item[1];\n  }\n  return sum;\n}\n\nvoid main() {\n  print(total([[2, 3], [5, 2]]));\n}\n';
test('flutter: the Dart debugger stops at a breakpoint and reads a variable', { timeout: 3 * 60e3 }, async (t) => {
  const skip = await skipUnless('dart'); if (skip) return t.skip(skip);
  const dir = project('dartdbg', { 'pubspec.yaml': DART_PUBSPEC, 'bin/main.dart': DBG });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'bin/main.dart', logTo: path.join(dir, 'debug.log') });
  try {
    assert.match(await debugBreak(s.id, 'bin/main.dart', 4), /breakpoint at main\.dart:4/);
    let st = await debugMove(s.id, 'continue', 60000);
    assert.equal(st.state, 'paused', `it stopped (log: ${fs.readFileSync(path.join(dir, 'debug.log'), 'utf8').slice(-800)})`);
    assert.equal(st.frames[0].line, 4);
    assert.ok(st.locals.some((l) => /^sum = 0$/.test(l)), st.locals.join(', '));
    st = await debugMove(s.id, 'continue', 30000); // the second item
    assert.equal(await debugEval(s.id, 'item[0] * item[1]'), '10');
  } finally { await debugStop(s.id).catch(() => {}); }
});

test('flutter: flutter analyze catches an error in the changed file', { timeout: 5 * 60e3 }, async (t) => {
  const skip = await skipUnless('flutter'); if (skip) return t.skip(skip);
  const dir = project('flanalyze', { 'pubspec.yaml': FLUTTER_PUBSPEC, 'lib/main.dart': "import 'package:flutter/widgets.dart';\n\nvoid main() {\n  runApp(const Text('hi', textDirection: TextDirection.ltr));\n  cout << 1;\n}\n" });
  const r = await languageChecks(dir, ['lib/main.dart'], { have: ['flutter'], timeout: 240e3 });
  assert.equal(r.ran[0]?.lang, 'flutter');
  assert.ok(r.problems.some((p) => /main\.dart/.test(p) && /cout/.test(p)), r.problems.join('\n') || 'no problems reported');
});

test('flutter: a new app builds for Windows, and its window is read and its button pressed', { timeout: 20 * 60e3 }, async (t) => {
  if (!WIN) return t.skip('the window test is for Windows');
  const skip = await skipUnless('flutter'); if (skip) return t.skip(skip);
  const { desktopAvailable, appWindows, readWindow, clickControl } = await import('../../uia.js');
  const { startBackground, stopBackground } = await import('../../bgjobs.js');
  if (!(await desktopAvailable())) return t.skip('the desktop tool (UI Automation) is not available here');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-flwin-'));
  const sh = { cwd: base, encoding: 'utf8', shell: true, timeout: 15 * 60e3 };
  try { execFileSync('flutter', ['create', '--platforms', 'windows', '--project-name', 'qx_app', 'app'], sh); } catch (e) { return t.skip(`flutter create failed: ${String(e.stdout || e.message).slice(-300)}`); }
  const app = path.join(base, 'app');
  try { execFileSync('flutter', ['build', 'windows', '--debug'], { ...sh, cwd: app }); } catch (e) { return t.skip(`flutter build windows failed (flutter doctor says what is missing; usually Visual Studio's C++ workload): ${String(e.stdout || e.message).slice(-400)}`); }
  const exe = path.join(app, 'build', 'windows', 'x64', 'runner', 'Debug', 'qx_app.exe');
  const job = startBackground({ projectId: 'pack-test', cwd: app, line: `"${exe}"`, shell: 'direct', label: 'qx_app', logTo: path.join(app, 'run.log') });
  try {
    const w = await appWindows(job.id, 30000);
    assert.ok(w.length, 'the app opened a window');
    let r = await readWindow(job.id);
    const ref = /\[(\d+)\][^\n]*Increment/.exec(r.text)?.[1];
    assert.ok(ref, `the Increment button can be read:\n${r.text}`);
    await clickControl(job.id, undefined, ref);
    await new Promise((x) => setTimeout(x, 800));
    r = await readWindow(job.id);
    assert.match(r.text, /"1"|\b1\b/, `the counter shows 1:\n${r.text}`);
  } finally { await stopBackground(job.id).catch(() => {}); }
});
