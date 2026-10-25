// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Apple pack self-test. On any computer: the simulators' list, Xcode's error lines, crash reports, which scheme and
// platform a project builds, the notes and the rules for Apple's tools, all on fixtures. On a Mac with Xcode: Xcode and
// the simulators are found, the compiler check catches an error, a program builds and runs, a real crash report is
// read and summed up, and lldb-dap stops at a breakpoint.
import { project, tool, skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseSimctl, pickSimulator, parseDiag, buildErrors, tidyDiag, xcodeContainer, listSchemes, pickScheme, projectPlatform, projectBundleId,
  xcodeCheckLine, parseIps, crashText, newestCrash } from '../_apple.js';
import apple from '../apple.js';
import { decide } from '../../cmdpolicy.js';

const MAC = process.platform === 'darwin';
const onMac = (t) => (MAC ? false : t.skip('needs a Mac') || true);

// ---------- fixtures ----------
const SIMCTL = {
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', name: 'iOS 17.5', version: '17.5', platform: 'iOS', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', name: 'iOS 18.2', version: '18.2', platform: 'iOS', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2', name: 'watchOS 11.2', version: '11.2', platform: 'watchOS', isAvailable: true },
  ],
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'A1', name: 'iPhone 15', state: 'Shutdown', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{ udid: 'B1', name: 'iPad Air 11-inch (M2)', state: 'Shutdown', isAvailable: true },
      { udid: 'B2', name: 'iPhone 16', state: 'Shutdown', isAvailable: true }, { udid: 'B3', name: 'iPhone 16 Pro', state: 'Shutdown', isAvailable: false }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-2': [{ udid: 'C1', name: 'Apple Watch Series 10 (46mm)', state: 'Booted', isAvailable: true }],
  },
};
const BUILD_LOG = `Command SwiftCompile failed with a nonzero exit code
/Users/me/Counter/Counter/ContentView.swift:18:13: error: cannot find 'countt' in scope
            countt += 1
            ^~~~~~
/Users/me/Counter/Counter/ContentView.swift:4:8: warning: variable 'x' was never used
/Users/me/Counter/Counter/Model.m:9:5: error: use of undeclared identifier 'foo'
/Users/me/Counter/Counter/ContentView.swift:18:13: error: cannot find 'countt' in scope
xcodebuild: error: Unable to find a destination matching the provided destination specifier
** BUILD FAILED **`;

const header = (o) => JSON.stringify({ bug_type: '309', timestamp: '2026-10-20 10:12:03.00 +0200', ...o });
const IPS_SWIFT = `${header({ app_name: 'Counter', app_version: '1.0', bundleID: 'com.example.Counter', os_version: 'macOS 15.1 (24B83)', name: 'Counter' })}
${JSON.stringify({
  procName: 'Counter', procPath: '/Users/me/Counter/build/Build/Products/Debug/Counter.app/Contents/MacOS/Counter',
  bundleInfo: { CFBundleShortVersionString: '1.0', CFBundleIdentifier: 'com.example.Counter' },
  exception: { codes: '0x0000000000000001, 0x00000001a2b3c4d8', type: 'EXC_BREAKPOINT', signal: 'SIGTRAP' },
  termination: { flags: 0, code: 5, namespace: 'SIGNAL', indicator: 'Trace/BPT trap: 5', byProc: 'exc handler' },
  asi: { 'libswiftCore.dylib': ['Counter/ContentView.swift:18: Fatal error: Index out of range'] },
  faultingThread: 0,
  threads: [
    { triggered: true, id: 1, queue: 'com.apple.main-thread', frames: [
      { imageOffset: 1000, symbol: '_assertionFailure(_:_:file:line:flags:)', symbolLocation: 200, imageIndex: 1 },
      { imageOffset: 2000, symbol: 'Array.subscript.getter', symbolLocation: 40, imageIndex: 1 },
      { imageOffset: 3000, sourceLine: 18, sourceFile: 'ContentView.swift', symbol: 'ContentView.tap()', imageIndex: 0, symbolLocation: 60 },
      { imageOffset: 3200, sourceLine: 9, sourceFile: 'ContentView.swift', symbol: 'closure #1 in ContentView.body.getter', imageIndex: 0, symbolLocation: 20 },
      { imageOffset: 4000, symbol: 'ButtonAction.callAsFunction()', imageIndex: 2 }] },
    { id: 2, frames: [{ imageOffset: 1, symbol: '__workq_kernreturn', imageIndex: 3 }] }],
  usedImages: [
    { arch: 'arm64', path: '/Users/me/Counter/build/Build/Products/Debug/Counter.app/Contents/MacOS/Counter', name: 'Counter' },
    { arch: 'arm64', path: '/usr/lib/swift/libswiftCore.dylib', name: 'libswiftCore.dylib' },
    { arch: 'arm64', path: '/System/Library/Frameworks/SwiftUI.framework/Versions/A/SwiftUI', name: 'SwiftUI' },
    { arch: 'arm64', path: '/usr/lib/system/libsystem_kernel.dylib', name: 'libsystem_kernel.dylib' }],
}, null, 2)}`;
const IPS_OBJC = `${header({ app_name: 'Shop', app_version: '2.1', bundleID: 'com.example.Shop', os_version: 'macOS 15.1 (24B83)' })}
${JSON.stringify({
  procName: 'Shop', procPath: '/Users/me/Library/Developer/CoreSimulator/Devices/B2/data/Containers/Bundle/Application/X/Shop.app/Shop',
  exception: { type: 'EXC_CRASH', signal: 'SIGABRT' }, termination: { indicator: 'Abort trap: 6' },
  asi: { CoreFoundation: ['*** Terminating app due to uncaught exception \'NSRangeException\', reason: \'*** -[__NSArrayM objectAtIndex:]: index 3 beyond bounds [0 .. 2]\''] },
  lastExceptionBacktrace: [
    { imageOffset: 10, symbol: '__exceptionPreprocess', imageIndex: 1 },
    { imageOffset: 20, symbol: 'objc_exception_throw', imageIndex: 2 },
    { imageOffset: 30, sourceLine: 27, sourceFile: 'CartViewController.m', symbol: '-[CartViewController removeItemAt:]', imageIndex: 0 }],
  faultingThread: 0,
  threads: [{ triggered: true, queue: 'com.apple.main-thread', frames: [{ imageOffset: 1, symbol: '__pthread_kill', imageIndex: 3 }, { imageOffset: 2, symbol: 'abort', imageIndex: 3 }] }],
  usedImages: [{ path: '/Users/me/Library/Developer/CoreSimulator/Devices/B2/data/Containers/Bundle/Application/X/Shop.app/Shop', name: 'Shop' },
    { path: '/Library/Developer/CoreSimulator/Volumes/iOS_22C150/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.2.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', name: 'CoreFoundation' },
    { path: '/usr/lib/libobjc.A.dylib', name: 'libobjc.A.dylib' }, { path: '/usr/lib/system/libsystem_kernel.dylib', name: 'libsystem_kernel.dylib' }],
})}`;
const PBX_IOS = 'buildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.Counter;\n\t\t\t\tSDKROOT = iphoneos;\n\t\t\t};\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.CounterTests;\n';
const PBX_MULTI = 'SDKROOT = auto;\nSUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";\nPRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_NAME:rfc1034identifier)";\n';

// ---------- on any computer ----------
test('apple: the simulators’ list is read, and a booted or newest iPhone is picked', () => {
  const l = parseSimctl(JSON.stringify(SIMCTL));
  assert.deepEqual(l.runtimes.map((r) => r.name), ['iOS 18.2', 'iOS 17.5', 'watchOS 11.2']);
  assert.equal(l.devices.find((d) => d.udid === 'B2').runtimeName, 'iOS 18.2');
  assert.equal(pickSimulator(l).name, 'iPhone 16', 'newest runtime, an iPhone, available');
  assert.equal(pickSimulator(l, { platform: 'watchOS' }).udid, 'C1', 'a booted one first');
  assert.equal(pickSimulator(l, { kind: 'iPad' }).name, 'iPad Air 11-inch (M2)');
  assert.deepEqual(parseSimctl('not json'), { runtimes: [], devices: [] });
});

test('apple: Xcode’s and Swift’s errors are read with file and line, once each', () => {
  assert.deepEqual(parseDiag('/Users/me/A/ContentView.swift:18:13: error: cannot find \'countt\' in scope'), { file: '/Users/me/A/ContentView.swift', line: 18, col: 13, severity: 'error', msg: 'cannot find \'countt\' in scope' });
  const errs = buildErrors(BUILD_LOG);
  assert.deepEqual(errs.map((e) => `${e.file ? path.posix.basename(e.file) : '-'}:${e.line}`), ['ContentView.swift:18', 'Model.m:9', '-:null']);
  assert.match(errs[2].msg, /Unable to find a destination/);
  assert.equal(tidyDiag('/Users/me/Counter/Counter/ContentView.swift:18:13: error: cannot find \'countt\' in scope', '/Users/me/Counter'), 'Counter/ContentView.swift:18:13: error: cannot find \'countt\' in scope');
  assert.equal(parseDiag('ld: symbol(s) not found for architecture arm64'), null);
  // The checks' parse: errors with a file, once each, warnings left out; then tidy makes them relative.
  const xc = apple.checks.find((c) => c.id === 'xcode');
  const lines = xc.parse(BUILD_LOG, { dir: '/Users/me/Counter', files: ['Counter/ContentView.swift'] });
  assert.deepEqual(lines.map((l) => xc.tidy(l, '/Users/me/Counter')), ['Counter/ContentView.swift:18:13: error: cannot find \'countt\' in scope', 'Counter/Model.m:9:5: error: use of undeclared identifier \'foo\'']);
});

test('apple: a crash report says what happened and the first frame in the app', () => {
  const c = parseIps(IPS_SWIFT);
  assert.equal(c.app, 'Counter');
  assert.equal(c.type, 'EXC_BREAKPOINT');
  assert.equal(c.frames.find((f) => f.own).symbol, 'ContentView.tap()');
  const t = crashText(c);
  assert.match(t, /EXC_BREAKPOINT \(SIGTRAP\) · Trace\/BPT trap: 5/);
  assert.match(t, /Fatal error: Index out of range/);
  assert.match(t, /First frame in the app: ContentView\.swift:18 ContentView\.tap\(\) \(Counter\)/);
  assert.match(t, /▶ 2 ContentView\.swift:18/);
  const o = crashText(parseIps(IPS_OBJC));
  assert.match(o, /NSRangeException/);
  assert.match(o, /Where the exception was thrown:[\s\S]*▶ 2 CartViewController\.m:27 -\[CartViewController removeItemAt:\] \(Shop\)/);
  assert.match(o, /First frame in the app: CartViewController\.m:27/);
  assert.equal(parseIps('{"not":"a report"}\n{}'), null);
});

test('apple: reading a crash report or a crashed run puts the summary above the output', () => {
  const [ips, ran] = apple.summaries;
  assert.ok(ips.cmd.test('cat ~/Library/Logs/DiagnosticReports/Counter-2026-10-20-101203.ips'));
  assert.match(ips.summarize(`> cat Counter.ips\n${IPS_SWIFT}`), /^Crash report: Counter 1\.0 \(com\.example\.Counter\)/);
  for (const l of ['build/Build/Products/Debug/Counter.app/Contents/MacOS/Counter', 'swift run qxtool', 'xcrun simctl launch --console-pty booted com.x.y', 'xcodebuild -scheme A test']) assert.ok(ran.cmd.test(l), l);
  assert.equal(ran.summarize('all fine'), '', 'no crash, no summary');
});

test('apple: newestCrash finds the newest report for an app', () => {
  const dir = project('apple-crashes', { 'Counter-2026-10-20-100000.ips': 'old', 'Other-2026-10-20-110000.ips': 'other', 'Counter-2026-10-20-120000.ips': 'new' });
  const at = (f, s) => fs.utimesSync(path.join(dir, f), s, s);
  at('Counter-2026-10-20-100000.ips', 1000); at('Other-2026-10-20-110000.ips', 3000); at('Counter-2026-10-20-120000.ips', 2000);
  assert.match(newestCrash({ dirs: [dir], app: 'counter' }), /120000/);
  assert.match(newestCrash({ dirs: [dir] }), /Other/);
  assert.equal(newestCrash({ dirs: [dir], since: 5000e3 }), null);
});

test('apple: the check builds the project’s scheme for a simulator or the Mac, with signing off', () => {
  const ios = project('apple-ios', { 'Counter.xcodeproj/project.pbxproj': PBX_IOS, 'Counter.xcodeproj/xcshareddata/xcschemes/CounterTests.xcscheme': '', 'Counter.xcodeproj/xcshareddata/xcschemes/Counter.xcscheme': '' });
  assert.deepEqual(xcodeContainer(ios), { kind: 'project', name: 'Counter.xcodeproj', project: 'Counter.xcodeproj' });
  assert.deepEqual(listSchemes(ios).sort(), ['Counter', 'CounterTests']);
  assert.equal(xcodeCheckLine(ios), "xcodebuild -quiet -project Counter.xcodeproj -scheme Counter -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build");
  assert.equal(projectBundleId(PBX_IOS), 'com.example.Counter');
  const ws = project('apple-ws', { 'My App.xcworkspace/contents.xcworkspacedata': '', 'My App.xcodeproj/project.pbxproj': 'SDKROOT = macosx;', 'My App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/My App.xcscheme': '' });
  assert.equal(xcodeCheckLine(ws), "xcodebuild -quiet -workspace 'My App.xcworkspace' -scheme 'My App' -destination platform=macOS CODE_SIGNING_ALLOWED=NO build");
  assert.equal(xcodeCheckLine(project('apple-ws2', { 'W.xcworkspace/contents.xcworkspacedata': '' })), null, 'a workspace with no scheme is skipped');
  assert.equal(projectPlatform(PBX_MULTI), 'multi');
  assert.equal(projectPlatform('SDKROOT = xros;'), 'visionos');
  assert.equal(pickScheme(['AppTests', 'Widget'], null), 'Widget');
  assert.equal(apple.checks.find((c) => c.id === 'xcode').cmd(ios), xcodeCheckLine(ios));
});

test('apple: the notes say how to build, run in the simulator, read crashes and debug', () => {
  const ios = project('apple-notes', { 'Counter.xcodeproj/project.pbxproj': PBX_IOS, 'Counter.xcodeproj/xcshareddata/xcschemes/Counter.xcscheme': '' });
  const n = apple.notes(new Set(['xcode']), ios);
  assert.match(n, /scheme Counter, iPhone and iPad, bundle id com\.example\.Counter/);
  assert.match(n, /xcrun simctl install booted build\/Build\/Products\/Debug-iphonesimulator/);
  assert.match(n, /Simulator\.app\/Contents\/MacOS\/Simulator/);
  assert.match(n, /DiagnosticReports/);
  assert.match(n, /never through a wrapper script/);
  assert.match(apple.notes(new Set(), ios), /Xcode isn't installed here/);
  assert.match(apple.notes(new Set(['swift']), project('apple-pkg', { 'Package.swift': '// swift-tools-version:5.9' })), /swift build/);
  assert.equal(apple.notes(new Set(), project('apple-none', { 'a.txt': '' })), '');
});

test('apple: rules for Apple’s tools', async () => {
  const root = project('apple-rules', {});
  const v = async (line) => { const d = await decide(line, { shell: 'bash', root, rules: [], mode: 'strict' }); return d.verdict === 'ask' ? `ask:${d.who}` : d.verdict; };
  for (const l of ['xcrun simctl list devices available', 'xcodebuild -list', 'xcodebuild -showBuildSettings -scheme App', 'xcrun simctl spawn booted log stream --level debug',
    'log show --last 5m', 'plutil -p Info.plist', 'xcrun xcresulttool get --path x.xcresult', 'xcode-select -p', 'security find-identity -v -p codesigning']) assert.equal(await v(l), 'allow', l);
  for (const l of ['xcodebuild -scheme App build', 'xcrun simctl boot B2', 'xcrun simctl launch booted com.x.y', 'swift build']) assert.equal(await v(l), 'ask:user', `${l} asks until a rule allows it`);
  for (const l of ['xcrun simctl erase all', 'xcrun simctl spawn booted rm -rf x', 'xcodebuild -downloadPlatform iOS', 'xcrun notarytool submit App.zip', 'xcrun devicectl device install app x.app', 'swift package update'])
    assert.equal(await v(l), 'ask:user', l);
  assert.equal(await v('log erase --all'), 'deny');
  assert.equal(await v('sudo xcodebuild -license accept'), 'ask:user', 'Xcode for the whole computer, with your password: the card says to run it yourself');
  assert.equal(await v('xcrun simctl io booted screenshot ~/screen.png'), 'deny', 'a screenshot into your profile folder');
  assert.equal(await v('xcrun simctl io booted screenshot .quorx/scratch/screen.png'), 'allow');
});

// ---------- on a Mac ----------
test('apple: Xcode and the simulators are found', async (t) => {
  if (onMac(t)) return;
  const skip = await skipUnless('xcode'); if (skip) return t.skip(skip);
  const x = await tool('xcode');
  assert.match(x.version, /^\d+\.\d+/);
  if (!x.works) assert.match(x.problem, /Command Line Tools|license|first launch/);
  const s = await tool('simulator');
  if (s.found) {
    const l = parseSimctl(execFileSync('xcrun', ['simctl', 'list', '-j'], { encoding: 'utf8' }));
    assert.ok(l.runtimes.length && pickSimulator(l), 'a simulator to run apps on');
  }
});

const pkg = (main) => ({ 'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "qxtool", targets: [.executableTarget(name: "qxtool")])\n', 'Sources/qxtool/main.swift': main });

test('apple: swift build catches an error in a changed file', async (t) => {
  if (onMac(t)) return;
  const skip = await skipUnless('swift'); if (skip) return t.skip(skip);
  const { languageChecks } = await import('../../langchecks.js');
  const dir = project('apple-check', pkg('let n: Int = "three"\nprint(n)\n'));
  const r = await languageChecks(dir, ['Sources/qxtool/main.swift'], { have: ['swift'], timeout: 300e3 });
  assert.equal(r.ran[0]?.lang, 'swiftpm');
  assert.ok(r.problems.some((p) => /Sources\/qxtool\/main\.swift:1/.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('apple: a Swift program builds and runs, and its crash report is read', async (t) => {
  if (onMac(t)) return;
  const skip = await skipUnless('swift'); if (skip) return t.skip(skip);
  const dir = project('apple-run', pkg('let words = CommandLine.arguments.dropFirst()\nprint("\\(words.count) words")\nif words.first == "crash" { let a = [1, 2, 3]; print(a[words.count + 5]) }\n'));
  execFileSync('swift', ['build'], { cwd: dir, stdio: 'pipe', timeout: 600e3 });
  const bin = path.join(execFileSync('swift', ['build', '--show-bin-path'], { cwd: dir, encoding: 'utf8' }).trim(), 'qxtool');
  assert.match(execFileSync(bin, ['a', 'b', 'c'], { encoding: 'utf8' }), /3 words/);
  const t0 = Date.now() - 1000;
  const r = spawnSync(bin, ['crash'], { encoding: 'utf8' });
  assert.ok(r.signal || r.status, 'it crashed');
  let file = null;
  for (let i = 0; i < 60 && !file; i++) { file = newestCrash({ since: t0, app: 'qxtool' }); if (!file) await new Promise((x) => setTimeout(x, 500)); }
  if (!file) return t.skip('macOS wrote no crash report within 30 s (crash reporting may be off)');
  const text = crashText(parseIps(fs.readFileSync(file, 'utf8')));
  assert.match(text, /Index out of range/);
  assert.match(text, /First frame in the app: main\.swift:3/);
});

test('apple: lldb-dap stops a Swift program at a breakpoint and reads a variable', async (t) => {
  if (onMac(t)) return;
  const skip = (await skipUnless('swift')) || (await skipUnless('lldb')); if (skip) return t.skip(skip);
  const { debugStart, debugBreak, debugMove, debugStop } = await import('../../debugger.js');
  const dir = project('apple-dbg', pkg('var total = 0\nfor n in [3, 4, 5] {\n    total += n\n    print(total)\n}\n'));
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'Sources/qxtool/main.swift' });
  try {
    assert.match(await debugBreak(s.id, 'Sources/qxtool/main.swift', 4), /breakpoint at main\.swift:4/);
    const st = await debugMove(s.id, 'continue', 60000);
    assert.equal(st.state, 'paused', JSON.stringify(st));
    assert.ok(st.frames.some((f) => /main\.swift$/.test(f.file) && f.line === 4), JSON.stringify(st.frames));
    assert.ok(st.locals.some((l) => /^total = 3$/.test(l)) || st.locals.some((l) => /total/.test(l)), `locals: ${st.locals.join(', ')}`);
  } finally { await debugStop(s.id); }
});
