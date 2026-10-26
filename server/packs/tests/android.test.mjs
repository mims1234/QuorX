// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Android pack self-test. Run everywhere: the logcat crash parser, AVD list parsing, the Gradle check (with a
// stand-in gradlew, so no SDK is needed) and the Gradle failure summary. With the SDK, an emulator and an AVD: an
// emulator boots as a background job, an app is launched, its screen read and a control tapped.
// Set QX_ANDROID_AVD to pick the AVD (default: the first one).
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseLogcat, findCrash, crashText, parseAvdList, isAndroidProject, gradleSummary, GRADLE_ERRORS, tidyGradleLine, sdkRoot, sdkTool } from '../android.js';
import { outputSummary, packsIn } from '../index.js';
import { languageChecks } from '../../langchecks.js';

// ---------- logcat ----------
const JAVA_BRIEF = `--------- beginning of crash
I/ActivityManager(  612): Start proc 4321:com.qx.counter/u0a190 for pre-top-activity
D/AndroidRuntime( 4321): Shutting down VM
E/AndroidRuntime( 4321): FATAL EXCEPTION: main
E/AndroidRuntime( 4321): Process: com.qx.counter, PID: 4321
E/AndroidRuntime( 4321): java.lang.RuntimeException: Unable to start activity ComponentInfo{com.qx.counter/com.qx.counter.MainActivity}: java.lang.IllegalStateException: count view missing
E/AndroidRuntime( 4321): 	at android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3782)
E/AndroidRuntime( 4321): 	at android.app.ActivityThread.handleLaunchActivity(ActivityThread.java:3922)
W/Choreographer(  612): Frame time is 0.1 ms in the future!
E/AndroidRuntime( 4321): 	at android.os.Looper.loop(Looper.java:317)
E/AndroidRuntime( 4321): Caused by: java.lang.IllegalStateException: count view missing
E/AndroidRuntime( 4321): 	at com.qx.counter.CounterView.bind(CounterView.kt:41)
E/AndroidRuntime( 4321): 	at com.qx.counter.MainActivity.onCreate(MainActivity.kt:22)
E/AndroidRuntime( 4321): 	at android.app.Activity.performCreate(Activity.java:8960)
E/AndroidRuntime( 4321): 	... 12 more
E/AndroidRuntime( 4321): Caused by: java.lang.NullPointerException: Attempt to invoke virtual method 'void android.widget.TextView.setText(java.lang.CharSequence)' on a null object reference
E/AndroidRuntime( 4321): 	at androidx.core.view.ViewCompat.requireViewById(ViewCompat.java:120)
E/AndroidRuntime( 4321): 	at com.qx.counter.CounterView.find(CounterView.kt:58)
E/AndroidRuntime( 4321): 	... 14 more
I/Process ( 4321): Sending signal. PID: 4321 SIG: 9
`;
const JAVA_THREADTIME = `10-20 14:02:11.513  7001  7001 E AndroidRuntime: FATAL EXCEPTION: main
10-20 14:02:11.513  7001  7001 E AndroidRuntime: Process: com.example.shop, PID: 7001
10-20 14:02:11.513  7001  7001 E AndroidRuntime: java.lang.NumberFormatException: For input string: "2x"
10-20 14:02:11.513  7001  7001 E AndroidRuntime: 	at java.lang.Integer.parseInt(Integer.java:778)
10-20 14:02:11.513  7001  7001 E AndroidRuntime: 	at com.example.shop.cart.CartActivity.onAdd(CartActivity.java:88)
10-20 14:02:11.513  7001  7001 E AndroidRuntime: 	at android.view.View.performClick(View.java:7659)
`;
const NATIVE = `10-20 14:05:00.100  8100  8123 F libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 8123 (RenderThread), pid 8100 (com.qx.native)
10-20 14:05:00.300  8130  8130 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
10-20 14:05:00.300  8130  8130 F DEBUG   : pid: 8100, tid: 8123, name: RenderThread  >>> com.qx.native <<<
10-20 14:05:00.301  8130  8130 F DEBUG   :       #00 pc 000000000004b2a0  /apex/com.android.runtime/lib64/bionic/libc.so (memcpy+16)
10-20 14:05:00.301  8130  8130 F DEBUG   :       #01 pc 0000000000012f44  /data/app/~~x==/com.qx.native-1/lib/arm64/libqx.so (draw_frame+84)
`;
const ANR = `E/ActivityManager(  612): ANR in com.qx.slow (com.qx.slow/.MainActivity)
E/ActivityManager(  612): PID: 9001
E/ActivityManager(  612): Reason: Input dispatching timed out (Waiting to send key event because the focused window has not finished processing all of the input events)
`;
const FLUTTER = `E/flutter ( 5120): [ERROR:flutter/runtime/dart_vm_initializer.cc(41)] Unhandled Exception: RangeError (index): Invalid value: Not in inclusive range 0..2: 3
E/flutter ( 5120): #0      List.[] (dart:core-patch/growable_array.dart:264:36)
E/flutter ( 5120): #1      CartModel.itemAt (package:qx_shop/cart.dart:31:18)
E/flutter ( 5120): #2      _CartPageState.build.<anonymous closure> (package:qx_shop/main.dart:77:30)
`;

test('android: logcat lines in brief and threadtime formats become entries', () => {
  const e = parseLogcat(JAVA_BRIEF + JAVA_THREADTIME);
  assert.deepEqual(e[1], { level: 'D', tag: 'AndroidRuntime', pid: 4321, msg: 'Shutting down VM' });
  const t = e.find((x) => x.pid === 7001);
  assert.equal(t.tag, 'AndroidRuntime'); assert.equal(t.level, 'E'); assert.equal(t.msg, 'FATAL EXCEPTION: main');
  assert.ok(!e.some((x) => /beginning of crash/.test(x.msg)), 'the buffer header is not an entry');
});

test('android: a Java crash is summed up with its root cause and the app\'s first frame', () => {
  const c = findCrash(JAVA_BRIEF);
  assert.equal(c.kind, 'java'); assert.equal(c.process, 'com.qx.counter'); assert.equal(c.pid, 4321); assert.equal(c.thread, 'main');
  assert.match(c.exception, /^java\.lang\.RuntimeException: Unable to start activity/);
  assert.equal(c.causes.length, 2);
  assert.match(c.root, /^java\.lang\.NullPointerException: Attempt to invoke virtual method/);
  assert.equal(c.frame, 'com.qx.counter.CounterView.find(CounterView.kt:58)', 'the first app frame under the last "Caused by", not a framework frame');
  assert.ok(!c.lines.some((l) => /Choreographer|Frame time/.test(l)), 'lines from other processes are left out');
  const text = crashText(c);
  assert.match(text, /^Crash: FATAL EXCEPTION in com\.qx\.counter \(thread main\)/);
  assert.match(text, /Caused by: java\.lang\.NullPointerException/);
  assert.match(text, /First line in the app's code: com\.qx\.counter\.CounterView\.find\(CounterView\.kt:58\)/);
});

test('android: threadtime crashes, a named package, and crashes of other apps', () => {
  const c = findCrash(JAVA_THREADTIME);
  assert.equal(c.process, 'com.example.shop');
  assert.equal(c.root, 'java.lang.NumberFormatException: For input string: "2x"');
  assert.equal(c.frame, 'com.example.shop.cart.CartActivity.onAdd(CartActivity.java:88)');
  // Two crashes: the newest wins, unless a package is named.
  assert.equal(findCrash(JAVA_BRIEF + JAVA_THREADTIME).process, 'com.example.shop');
  assert.equal(findCrash(JAVA_BRIEF + JAVA_THREADTIME, 'com.qx.counter').process, 'com.qx.counter');
  assert.equal(findCrash('I/ActivityManager(  612): Displayed com.qx/.Main: +320ms\n'), null);
});

test('android: native crashes, ANRs and Flutter exceptions', () => {
  const n = findCrash(NATIVE);
  assert.equal(n.kind, 'native'); assert.equal(n.process, 'com.qx.native'); assert.equal(n.thread, 'RenderThread');
  assert.match(n.exception, /SIGSEGV \(signal 11\) at 0x0/);
  assert.match(n.frame, /libqx\.so \(draw_frame\+84\)/, 'the app\'s own library, not libc');
  const a = findCrash(ANR);
  assert.equal(a.kind, 'anr'); assert.equal(a.process, 'com.qx.slow'); assert.match(a.root, /^Input dispatching timed out/);
  assert.match(crashText(a), /^Crash: ANR in com\.qx\.slow\n.*\n  Reason: Input dispatching/);
  const f = findCrash(FLUTTER);
  assert.equal(f.kind, 'flutter'); assert.match(f.root, /^RangeError \(index\)/);
  assert.equal(f.frame, 'CartModel.itemAt (package:qx_shop/cart.dart:31:18)', 'the first frame outside dart: and package:flutter');
});

test('android: adb logcat run by the agent gets the crash summary', () => {
  assert.match(outputSummary('adb -s emulator-5554 logcat -d -t 500', JAVA_BRIEF), /^Crash: FATAL EXCEPTION in com\.qx\.counter/);
  assert.equal(outputSummary('adb devices', JAVA_BRIEF), '');
});

// ---------- AVDs ----------
test('android: AVD lists from the emulator and from avdmanager', () => {
  assert.deepEqual(parseAvdList('INFO    | Storing crashdata in: C:\\Users\\qx\\AppData\\Local\\Temp\\AndroidEmulator\\emu-crash-35.2.10.db\nMedium_Phone_API_35\nPixel_8_API_34\r\n\n'), ['Medium_Phone_API_35', 'Pixel_8_API_34']);
  assert.deepEqual(parseAvdList(`Available Android Virtual Devices:
    Name: Pixel_8_API_34
  Device: pixel_8 (Google)
    Path: C:\\Users\\qx\\.android\\avd\\Pixel_8_API_34.avd
  Target: Google APIs (Google Inc.)
          Based on: Android 14.0 ("UpsideDownCake") Tag/ABI: google_apis/x86_64
---------
    Name: qx_api35
    Path: C:\\Users\\qx\\.android\\avd\\qx_api35.avd
`), ['Pixel_8_API_34', 'qx_api35']);
  assert.deepEqual(parseAvdList('Available Android Virtual Devices:\n'), []);
  assert.deepEqual(parseAvdList(''), []);
});

// ---------- the Gradle check ----------
const MANIFEST = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n';
test('android: projects are found by their manifest, one module down', () => {
  const dir = project('andfind', { 'settings.gradle.kts': 'include(":app")\n', 'app/src/main/AndroidManifest.xml': MANIFEST });
  assert.ok(isAndroidProject(dir));
  assert.ok(packsIn(dir).some((p) => p.id === 'android'));
  assert.ok(!isAndroidProject(project('andnot', { 'build.gradle': '' })));
});

test('android: Kotlin, Java and resource errors count as errors', () => {
  for (const l of ["e: file:///C:/p/app/src/main/java/com/qx/MainActivity.kt:12:5 Unresolved reference 'cout'.",
    'C:\\p\\app\\src\\main\\java\\com\\qx\\Cart.java:7: error: cannot find symbol',
    'ERROR: C:\\p\\app\\src\\main\\res\\layout\\activity_main.xml:5: AAPT: error: attribute android:txt not found.']) assert.ok(GRADLE_ERRORS.test(l), l);
  assert.ok(!GRADLE_ERRORS.test('w: file:///C:/p/app/src/main/java/com/qx/MainActivity.kt:3:1 Parameter never used'));
});

test('android: error lines are tidied to the project-relative file, line and message', () => {
  const dir = WIN ? 'C:\\p' : '/p';
  const url = WIN ? 'file:///C:/p' : 'file:///p', abs = WIN ? 'C:\\p' : '/p';
  assert.equal(tidyGradleLine(`e: ${url}/app/src/main/java/com/qx/MainActivity.kt:12:5 Unresolved reference 'cout'.`, dir), "app/src/main/java/com/qx/MainActivity.kt:12:5: Unresolved reference 'cout'.");
  assert.equal(tidyGradleLine(`e: ${abs}${path.sep}app${path.sep}Main.kt: (7, 3): Expecting ')'`, dir), "app/Main.kt:7:3: Expecting ')'");
  assert.equal(tidyGradleLine(`${abs}${path.sep}app${path.sep}Cart.java:7: error: cannot find symbol`, dir), 'app/Cart.java:7: cannot find symbol');
  assert.equal(tidyGradleLine(`ERROR: ${abs}${path.sep}app${path.sep}res${path.sep}layout${path.sep}main.xml:5: AAPT: error: attribute android:txt not found.`, dir), 'app/res/layout/main.xml:5: attribute android:txt not found.');
  assert.match(tidyGradleLine(`e: ${url}/other/X.kt:1:1 bad`, WIN ? 'C:\\q' : '/q'), /X\.kt:1:1: bad$/, 'a file outside the project keeps its full path');
  assert.equal(tidyGradleLine('FAILURE: Build failed with an exception.', dir), 'FAILURE: Build failed with an exception.');
});

// A stand-in gradlew that fails like Gradle does on a Kotlin error, so the check runs without the SDK.
test('android: the check before the final reply reports an error in the changed Kotlin file', async () => {
  const kt = 'app/src/main/java/com/qx/MainActivity.kt';
  const err = `e: file:///C:/p/${kt}:5:9 Unresolved reference 'countt'.`;
  const other = "e: file:///C:/p/app/src/main/java/com/qx/Old.kt:1:1 Unresolved reference 'old'.";
  const dir = project('andcheck', {
    'settings.gradle.kts': 'include(":app")\n', 'app/src/main/AndroidManifest.xml': MANIFEST, [kt]: 'class MainActivity\n', 'app/src/main/java/com/qx/Old.kt': '',
    ...(WIN ? { 'gradlew.bat': `@echo off\r\necho ${err}\r\necho ${other}\r\necho FAILURE: Build failed with an exception.\r\nexit /b 1\r\n` }
      : { gradlew: `#!/bin/sh\necho "${err}"\necho "${other}"\necho "FAILURE: Build failed with an exception."\nexit 1\n` }),
  });
  if (!WIN) fs.chmodSync(path.join(dir, 'gradlew'), 0o755);
  const r = await languageChecks(dir, [kt], { have: ['android-sdk'] });
  assert.equal(r.ran.length, 1, 'one Gradle run for the project');
  assert.equal(r.ran[0].dir, '.', 'it runs where gradlew is, not in the module');
  assert.equal(r.problems.length, 1, 'only the changed file\'s error counts');
  assert.match(r.problems[0], /^android: .*MainActivity\.kt:5:9: Unresolved reference 'countt'\.$/);
  const none = await languageChecks(dir, [kt], { have: [] });
  assert.equal(none.ran.length, 0, 'no check without the SDK');
});

test('android: a failed Gradle build is summed up with its errors and the usual fix', () => {
  const out = `> Task :app:compileDebugKotlin FAILED
e: file:///C:/p/app/src/main/java/com/qx/MainActivity.kt:12:5 Unresolved reference 'cout'.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details

* Try:
> Run with --stacktrace option to get the stack trace.

BUILD FAILED in 14s`;
  const s = gradleSummary(out);
  assert.match(s, /^Gradle build failed\. What went wrong: Execution failed for task ':app:compileDebugKotlin'\./);
  assert.match(s, /\n  e: .*MainActivity\.kt:12:5/);
  assert.match(gradleSummary('FAILURE: Build failed with an exception.\n\n* What went wrong:\nSDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.\n\n'), /local\.properties/);
  assert.equal(gradleSummary('BUILD SUCCESSFUL in 3s'), null);
  assert.match(outputSummary('gradlew.bat assembleDebug', out), /^Gradle build failed/);
});

// ---------- with the SDK: boot, launch, read, tap ----------
test('android: the SDK is found where Android Studio puts it', async (t) => {
  if (!sdkRoot()) return t.skip('no Android SDK (ANDROID_HOME, or Android Studio\'s default folder)');
  assert.ok(sdkTool('adb'), 'platform-tools has adb');
});

test('android: an emulator boots, an app launches, its screen is read and a control tapped', { timeout: 6 * 60e3 }, async (t) => {
  for (const id of ['adb', 'android-emulator']) { const skip = await skipUnless(id, { works: true }); if (skip) return t.skip(skip); }
  const { devices, listAvds, startEmulator, launch, readScreen, tap, logcat } = await import('../../android.js');
  const { stopBackground } = await import('../../bgjobs.js');
  let serial = (await devices()).find((d) => d.emulator && d.state === 'device')?.serial, job = null;
  if (!serial) {
    const avd = process.env.QX_ANDROID_AVD || (await listAvds())[0];
    const logTo = path.join(os.tmpdir(), `qx-emulator-${Date.now()}.log`);
    const e = await startEmulator({ avd, projectId: 'pack-test', cwd: os.tmpdir(), logTo, wait: 300e3 });
    job = e.job;
    assert.ok(e.booted, `the emulator booted (${e.note})`);
    serial = e.serial;
  }
  try {
    assert.match(await launch(serial, 'com.android.settings'), /launched/);
    await new Promise((r) => setTimeout(r, 2500));
    const before = await readScreen(serial);
    const target = before.nodes.find((n) => n.ref && n.text);
    assert.ok(target, `Settings has a control with text to tap:\n${before.text}`);
    await tap(serial, { ref: target.ref });
    await new Promise((r) => setTimeout(r, 2000));
    const after = await readScreen(serial);
    assert.notEqual(after.text, before.text, 'the screen changed after the tap');
    assert.equal(typeof await logcat(serial, 'com.android.settings'), 'string');
  } finally { if (job) await stopBackground(job).catch(() => {}); }
});
