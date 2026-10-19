// Flutter and Dart: one Dart codebase for Windows, macOS, Linux and Android (and plain Dart programs).
// flutter analyze (dart analyze) is the check before the final reply; flutter test and flutter doctor get a short
// summary; Dart debugging goes through `dart debug_adapter` / `flutter debug_adapter`, which speak DAP over stdio,
// behind QuorX's small stdio bridge (server/dapbridge.cjs).
import fs from 'node:fs';
import path from 'node:path';
import { WIN, MAC, run, VS_LINE } from './_lib.js';

/** Whether the pubspec.yaml in `dir` is a Flutter app or package (it depends on the flutter SDK). */
export function isFlutterProject(dir) {
  try { return /^\s+sdk:\s*flutter\b/m.test(fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8')); } catch { return false; }
}
const isDartProject = (dir) => fs.existsSync(path.join(dir, 'pubspec.yaml')) && !isFlutterProject(dir);
// The folder with the pubspec.yaml that `file` belongs to (or cwd).
function projectOf(cwd, file) {
  let d = path.dirname(path.resolve(cwd, file));
  for (let i = 0; i < 12; i++) { if (fs.existsSync(path.join(d, 'pubspec.yaml'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return cwd;
}
/** The device Flutter runs on here when none is named: this computer's desktop. */
export const DESKTOP = WIN ? 'windows' : MAC ? 'macos' : 'linux';
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

// ---------- flutter analyze / dart analyze ----------
// "  error • Undefined name 'foo' • lib/main.dart:12:5 • undefined_identifier" (flutter analyze) and
// "  error - lib/main.dart:12:5 - Undefined name 'foo'. - undefined_identifier" (dart analyze). Warnings and infos
// don't fail the check: only errors send a reply back.
export const ANALYZE_ERRORS = /^error\s*[•-]/i;

// ---------- flutter test (and dart test): which tests failed, and why ----------
const PROGRESS = /^(\d+:\d\d) \+(\d+)(?: ~(\d+))?(?: -(\d+))?: (.*)$/;
const NOISE = /^(═|The following \w+ was thrown|When the exception was thrown|This was caught by|The test description was|Test failed\. See exception|<asynchronous suspension>|#\d+\s|file:\/\/|package:|To run this test again|dart:)/;
/**
 * flutter test / dart test output (the default reporter): { passed, skipped, failed, done: 'passed'|'failed'|null,
 * failures: [{ test, why: [lines], where }] }.
 */
export function parseTestOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const res = { passed: 0, skipped: 0, failed: 0, done: null, failures: [] };
  const marks = [];
  lines.forEach((l, i) => { const m = PROGRESS.exec(l); if (m) marks.push({ i, pass: +m[2], skip: +(m[3] || 0), fail: +(m[4] || 0), text: m[5] }); });
  for (const [k, m] of marks.entries()) {
    res.passed = m.pass; res.skipped = m.skip; res.failed = m.fail;
    if (/^All tests passed!?$/.test(m.text)) res.done = 'passed';
    if (/^Some tests failed\.?$/.test(m.text)) res.done = 'failed';
    if (!/\[E\]$/.test(m.text)) continue;
    // Flutter prints the exception before the [E] line, plain dart test after it.
    const before = lines.slice(k ? marks[k - 1].i + 1 : 0, m.i), after = lines.slice(m.i + 1, marks[k + 1]?.i ?? lines.length);
    const block = [...before, ...after];
    const errors = block.map((l) => l.trim()).filter((l) => /: Error: /.test(l));
    const why = (errors.length ? errors : block.map((l) => l.trim()).filter((l) => l && !NOISE.test(l))).slice(0, 5);
    const at = block.map((l) => /\((?:file:\/\/\/?)?([^()]*?\b(?:test|lib)[\\/][^():]+\.dart):(\d+)(?::(\d+))?\)/.exec(l) || /^\s*file:\/\/\/?(\S*?\b(?:test|lib)\/\S+\.dart) line (\d+)/.exec(l)).find(Boolean);
    const where = at ? `${at[1].replace(/\\/g, '/').replace(/^.*?\b((?:test|lib)\/)/, '$1')}:${at[2]}${at[3] ? `:${at[3]}` : ''}` : '';
    res.failures.push({ test: m.text.replace(/\s*\[E\]$/, '').replace(/^loading (.+)$/, 'loading $1 (it did not compile)'), why, where });
  }
  return res;
}
export function testSummary(out) {
  const r = parseTestOutput(out);
  if (!r.failures.length && !r.done) return null;
  return [`Tests: ${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ''}.`,
    ...r.failures.slice(0, 8).map((f) => `- ${f.test}${f.where ? ` (${f.where})` : ''}: ${f.why.join(' / ').slice(0, 300) || 'see the output'}`)].join('\n');
}

// ---------- flutter doctor: what is missing ----------
const MARK = { '√': 'ok', '✓': 'ok', '!': 'partial', X: 'missing', '✗': 'missing', '☠': 'missing', x: 'missing' };
/** flutter doctor output: [{ name, status: 'ok'|'partial'|'missing', detail, problems: [lines] }]. */
export function parseDoctor(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const top = /^\[(.)\]\s+(.+)$/.exec(l);
    if (top) { const name = top[2].split(/ - | \(/)[0]; out.push({ name: name.trim(), status: MARK[top[1]] || 'partial', detail: top[2].trim(), problems: [] }); continue; }
    const sub = /^\s{2,}([X✗!☠])\s+(.+)$/.exec(l);
    if (sub && out.length) out.at(-1).problems.push(sub[2].trim());
  }
  return out;
}
// What to do about the usual gaps (installs for the whole computer ask the user first).
function doctorHint(item) {
  const all = `${item.name} ${item.problems.join(' ')}`;
  if (/Visual Studio/i.test(item.name)) return `Windows apps need Visual Studio's C++ workload: the Build Tools with C++ from ⚙ Settings → Setup check, or ${VS_LINE} (it asks the user first).`;
  if (/licen[cs]e/i.test(all)) return 'the Android licences are not accepted: the user runs flutter doctor --android-licenses and reads and accepts them; never accept them for the user.';
  if (/cmdline-tools/i.test(all)) return 'the Android SDK has no command-line tools: Android Studio → SDK Manager → SDK Tools → Android SDK Command-line Tools, or sdkmanager "cmdline-tools;latest".';
  if (/Android toolchain/i.test(item.name)) return 'building for Android needs the Android SDK (Android Studio installs it; the user decides).';
  if (/Android Studio/i.test(item.name)) return 'only needed for Android builds and its device manager.';
  if (/Chrome|Xcode|CocoaPods/i.test(item.name)) return 'only needed for that target.';
  return '';
}
export function doctorSummary(out) {
  const items = parseDoctor(out);
  if (!items.length) return null;
  const bad = items.filter((i) => i.status !== 'ok');
  if (!bad.length) return `flutter doctor: everything is ready (${items.map((i) => i.name).join(', ')}).`;
  return [`flutter doctor: ready: ${items.filter((i) => i.status === 'ok').map((i) => i.name).join(', ') || 'nothing'}.`,
    ...bad.map((i) => `- ${i.status === 'missing' ? 'Missing' : 'Needs work'}: ${i.name}${i.problems.length ? ` (${i.problems.slice(0, 2).join('; ').slice(0, 240)})` : ''}${doctorHint(i) ? `: ${doctorHint(i)}` : ''}`)].join('\n');
}

// flutter --version can take a while the first time (it unpacks the Dart SDK), longer than the usual probe limit.
const flutterVersion = async () => /Flutter (\d+\.\d+\.\d+)/.exec((await run('flutter', ['--version'], { timeout: 20000 })) || '')?.[1] || null;

// The adapters' programs; QX_DART and QX_FLUTTER point the self-test at a stand-in adapter.
const dartCmd = () => process.env.QX_DART || 'dart';
const flutterCmd = () => process.env.QX_FLUTTER || 'flutter';

export default {
  id: 'flutter',
  label: 'Flutter and Dart',
  summary: 'Windows, macOS, Linux and Android apps from one Dart codebase',
  toolchains: [
    { id: 'flutter', label: 'Flutter', for: 'Flutter apps (desktop and Android)', detect: flutterVersion, url: 'https://docs.flutter.dev/get-started/install' },
    { id: 'dart', label: 'Dart SDK', for: 'Dart programs (Flutter brings its own)', probe: ['dart', ['--version']], re: /Dart SDK version: (\d+\.\d+\.\d+)/, brew: 'dart-sdk', url: 'https://dart.dev/get-dart' },
  ],
  markers: [/^pubspec\.yaml$/],
  checks: [
    { id: 'flutter', tool: 'flutter', ext: /\.dart$/i, marker: isFlutterProject, cmd: 'flutter analyze --no-fatal-infos --no-fatal-warnings', errors: ANALYZE_ERRORS },
    { id: 'dart', tool: 'dart', ext: /\.dart$/i, marker: isDartProject, cmd: 'dart analyze --no-fatal-warnings', errors: ANALYZE_ERRORS },
  ],
  summaries: [
    { when: /\b(flutter|dart)(\.bat)?\s+test\b/i, summarize: testSummary },
    { when: /\bflutter(\.bat)?\s+doctor\b/i, summarize: doctorSummary },
  ],
  debug: {
    exts: ['.dart'], label: 'Dart and Flutter (debug_adapter)',
    // In a Flutter project the args are flutter run's own (-d emulator-5554); the default is this computer's desktop.
    // Without the folder (older callers pass none), a file in lib/ counts as a Flutter app's.
    gate: ({ file, args = [], cwd }) => ((cwd ? isFlutterProject(projectOf(cwd, file)) : /^(\.[\\/])?lib[\\/]/.test(file))
      ? ['flutter', 'run', ...(args.length ? args : ['-d', DESKTOP]), '-t', file].map(quote).join(' ')
      : ['dart', 'run', file, ...args].map(quote).join(' ')),
    start: ({ file, args = [], cwd }) => {
      const dir = projectOf(cwd, file), flutter = isFlutterProject(dir), program = path.resolve(cwd, file);
      return {
        stdio: true, line: `${flutter ? flutterCmd() : dartCmd()} debug_adapter`,
        adapterID: 'dart', request: 'launch',
        args: flutter ? { program, cwd: dir, toolArgs: args.length ? args : ['-d', DESKTOP] } : { program, cwd: dir, args },
        missing: `${flutter ? 'flutter' : 'dart'} debug_adapter did not answer (is ${flutter ? 'Flutter' : 'the Dart SDK'} installed and on the PATH?)`,
      };
    },
  },
  notes: (have) => [
    'check with flutter analyze (dart analyze for plain Dart), test with flutter test (dart test); a failed run gets a short summary of which tests failed and where.',
    `Run it on this computer with flutter run -d ${DESKTOP} as a background job; the window can then be driven with the desktop tool (Flutter's controls show up through its accessibility tree; if read finds none, use screenshot and click_at). For hot reload, run flutter run in the terminal tool instead and send r (reload), R (restart) or q (quit).`,
    'On Android: boot an emulator with the android tool (avds, start), then flutter run -d emulator-5554 as a background job, and read and tap it with the android tool. A crash on Android shows in android log as "Unhandled Exception".',
    WIN ? 'Windows builds need Visual Studio\'s C++ workload; flutter doctor says what is missing (it gets a short summary).' : 'flutter doctor says what is missing (it gets a short summary).',
    'The debug tool runs a .dart file under the Dart debugger (flutter run for a Flutter app; pass flutter run\'s device flags as args, e.g. ["-d", "emulator-5554"]).',
    have.has('flutter') || have.has('dart') ? '' : 'Neither Flutter nor Dart was found: tell the user before you plan on them (installing Flutter is the user\'s decision).',
  ].filter(Boolean).join(' '),
  // The parser and bridge tests run on every computer; the analyze, run and breakpoint tests skip without Flutter.
  test: { needs: [] },
};
