// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Android: apps built with Gradle, run on an emulator and driven through adb (the android tool, server/android.js).
// This file finds the SDK (adb, the emulator, sdkmanager and avdmanager are often not on the PATH), lists the
// virtual devices (AVDs), compiles the project before the final reply, and turns a logcat crash into a short summary:
// the exception, its "Caused by" and the first line of the app's own code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, MAC, run, hasFile } from './_lib.js';

// ---------- where the SDK is ----------
/** The SDK folder: ANDROID_HOME, ANDROID_SDK_ROOT, or where Android Studio puts it. null when there is none. */
export function sdkRoot(env = process.env) {
  const home = os.homedir();
  const tries = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    WIN && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    MAC ? path.join(home, 'Library', 'Android', 'sdk') : path.join(home, 'Android', 'Sdk')].filter(Boolean);
  return tries.find((d) => ['platform-tools', 'cmdline-tools', 'emulator', 'platforms'].some((s) => fs.existsSync(path.join(d, s)))) || null;
}

const EXE = WIN ? '.exe' : '', BAT = WIN ? '.bat' : '';
/** The full path of an SDK program (adb, emulator, sdkmanager, avdmanager), or null when the SDK doesn't have it. */
export function sdkTool(name, root = sdkRoot()) {
  if (!root) return null;
  const inCmdline = () => {
    const base = path.join(root, 'cmdline-tools');
    let vers = [];
    try { vers = fs.readdirSync(base).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a, undefined, { numeric: true }))); } catch { /* none */ }
    return [...vers.map((v) => path.join(base, v, 'bin')), path.join(root, 'tools', 'bin')];
  };
  const dirs = { adb: [path.join(root, 'platform-tools')], emulator: [path.join(root, 'emulator')], sdkmanager: inCmdline(), avdmanager: inCmdline() }[name] || [];
  const file = `${name}${name === 'adb' || name === 'emulator' ? EXE : BAT}`;
  return dirs.map((d) => path.join(d, file)).find((f) => fs.existsSync(f)) || null;
}
const q = (p) => (/\s/.test(p) ? `"${p}"` : p);

/** What the SDK has installed: { platforms: ['android-35'], buildTools: ['35.0.0'], images: ['system-images;android-35;google_apis;x86_64'] }. */
export function sdkContents(root = sdkRoot()) {
  const ls = (...p) => { try { return fs.readdirSync(path.join(root, ...p)); } catch { return []; } };
  const images = ls('system-images').flatMap((api) => ls('system-images', api).flatMap((tag) => ls('system-images', api, tag).map((abi) => `system-images;${api};${tag};${abi}`)));
  const num = (a, b) => b.localeCompare(a, undefined, { numeric: true });
  return { platforms: ls('platforms').filter((x) => /^android-/.test(x)).sort(num), buildTools: ls('build-tools').sort(num), images };
}

// Android Studio brings its own JDK (jbr), which Gradle can use when JAVA_HOME isn't set and no java is on the PATH.
export function studioJdk(env = process.env) {
  const tries = WIN ? [env.ProgramFiles && path.join(env.ProgramFiles, 'Android', 'Android Studio', 'jbr'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr')]
    : MAC ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home'] : ['/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr')];
  return tries.filter(Boolean).find((d) => fs.existsSync(path.join(d, 'bin', `java${EXE}`))) || null;
}

// ---------- virtual devices ----------
/**
 * The AVD names in `emulator -list-avds` output (one per line, with INFO lines from newer emulators mixed in) or in
 * `avdmanager list avd` output ("Name: Pixel_8_API_35" blocks).
 */
export function parseAvdList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const named = lines.map((l) => /^\s*Name:\s*(\S+)/.exec(l)?.[1]).filter(Boolean);
  if (named.length || lines.some((l) => /Available Android Virtual Devices/i.test(l))) return [...new Set(named)];
  return [...new Set(lines.map((l) => l.trim()).filter((l) => /^[\w.-]+$/.test(l)))];
}
const avdHome = (env = process.env) => env.ANDROID_AVD_HOME || path.join(env.ANDROID_USER_HOME || path.join(env.ANDROID_EMULATOR_HOME || os.homedir(), '.android'), 'avd');
/** The AVDs this computer has: what the emulator lists, or the .ini files in the AVD folder when it can't run. */
export async function listAvds() {
  const emu = sdkTool('emulator');
  if (emu) { const out = await run(emu, ['-list-avds'], { timeout: 15000 }); if (out != null) { const l = parseAvdList(out); if (l.length) return l; } }
  try { return fs.readdirSync(avdHome()).filter((f) => f.endsWith('.ini')).map((f) => f.slice(0, -4)); } catch { return []; }
}

// ---------- the project ----------
const MANIFEST = path.join('src', 'main', 'AndroidManifest.xml');
/** Whether `dir` is an Android project: it, or a module one folder down (app/), has src/main/AndroidManifest.xml. */
export function isAndroidProject(dir) {
  if (fs.existsSync(path.join(dir, MANIFEST))) return true;
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'build' && fs.existsSync(path.join(dir, e.name, MANIFEST))); } catch { return false; }
}

// Gradle needs the SDK (ANDROID_HOME or local.properties) and a JDK; when this computer has them in the usual places
// but the variables aren't set, the check sets them for its own command only.
function gradleEnv() {
  const env = {};
  if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && sdkRoot()) env.ANDROID_HOME = sdkRoot();
  if (!process.env.JAVA_HOME && studioJdk()) env.JAVA_HOME = studioJdk();
  return env;
}
const withEnv = (env, line) => `${Object.entries(env).map(([k, v]) => (WIN ? `set "${k}=${v}" && ` : `${k}='${v}' `)).join('')}${line}`;
// compileDebugSources compiles the Java and Kotlin code and links the resources (so broken layout XML fails too),
// without dexing and packaging the APK: the same errors as assembleDebug, in less of the check's time limit.
// .\ so cmd runs the project's own wrapper even where NoDefaultCurrentDirectoryInExePath is set.
export const GRADLE_CHECK = `${WIN ? '.\\gradlew.bat' : './gradlew'} compileDebugSources -q --console=plain`;
// Kotlin reports "e: file:///…/MainActivity.kt:12:5 …", javac "…\Main.java:12: error: …", aapt2 "…xml:5: AAPT: error: …".
export const GRADLE_ERRORS = /^e: |\berror\b|^ERROR:/i;
/** An error line as "app/src/…/MainActivity.kt:12:5: message", the path relative to the project when it is inside it. */
export function tidyGradleLine(l, dir) {
  const m = /^(?:e: |ERROR: )?(?:file:\/\/)?(.+?\.(?:kts?|java|xml))(?::(\d+)(?::(\d+))?(?:-\d+)?|: \((\d+), (\d+)\)):?\s*(?:AAPT: )?(?:error: )?(.*)$/.exec(String(l).trim());
  if (!m) return l;
  const abs = decodeURIComponent(m[1]).replace(/^\/([A-Za-z]:)/, '$1');
  const rel = path.relative(dir, abs);
  const file = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs;
  const line = m[2] || m[4], col = m[3] || m[5];
  return `${file}:${line}${col ? `:${col}` : ''}: ${m[6]}`;
}

// ---------- crashes in logcat ----------
// `-v brief` (E/AndroidRuntime( 1234): …) and `-v threadtime` (10-20 12:34:56.789  1234  1234 E AndroidRuntime: …).
const BRIEF = /^([VDIWEFA])\/(.+?)\(\s*(\d+)\):\s?(.*)$/;
const THREADTIME = /^(?:\d{4}-)?\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+(?:\S+\s+)?(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/;
/** Logcat text as entries: [{ level, tag, pid, msg }]. Lines in neither format are left out. */
export function parseLogcat(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, '');
    let m = BRIEF.exec(l);
    if (m) { out.push({ level: m[1], tag: m[2].trim(), pid: Number(m[3]), msg: m[4] }); continue; }
    m = THREADTIME.exec(l);
    if (m) out.push({ level: m[3], tag: m[4].trim(), pid: Number(m[1]), msg: m[5] });
  }
  return out;
}
// Frames from Android itself and the libraries every app uses: the first frame that isn't one is the app's code.
const FRAMEWORK = /^(android|androidx|java|javax|kotlin|kotlinx|dalvik|libcore|sun|jdk|com\.android|com\.google\.android|org\.json|okhttp3|retrofit2|io\.flutter)\./;

/**
 * The newest crash in logcat text, or null. `pkg`: the app's package, when known (otherwise the crashed process).
 * { kind: 'java' | 'native' | 'anr' | 'flutter', process, pid, thread?, exception, causes: [], root, frame, lines }
 */
export function findCrash(text, pkg = '') {
  const e = parseLogcat(text);
  const found = [];
  for (let i = 0; i < e.length; i++) {
    const x = e[i];
    if (x.tag === 'AndroidRuntime' && /^FATAL EXCEPTION/.test(x.msg)) {
      const lines = [];
      for (let j = i + 1; j < e.length; j++) {
        if (e[j].tag !== 'AndroidRuntime' || e[j].pid !== x.pid) continue;
        if (/^FATAL EXCEPTION/.test(e[j].msg)) break;
        lines.push(e[j].msg);
      }
      const proc = lines.map((l) => /^Process: ([\w.:]+), PID: (\d+)/.exec(l)).find(Boolean);
      const body = lines.filter((l) => !/^Process: /.test(l));
      const exception = body.find((l) => !/^\s*(at |\.\.\.|Caused by: |Suppressed: )/.test(l) && l.trim()) || '';
      const causes = body.filter((l) => /^\s*Caused by: /.test(l)).map((l) => l.trim().replace(/^Caused by: /, ''));
      const app = (pkg || proc?.[1] || '').replace(/:.*$/, '');
      const rootAt = causes.length ? body.findLastIndex((l) => /^\s*Caused by: /.test(l)) : body.indexOf(exception);
      const frames = (from) => body.slice(from).map((l) => /^\s*at (.+)$/.exec(l)?.[1]).filter(Boolean);
      const mine = (f) => (app ? f.startsWith(`${app}.`) : !FRAMEWORK.test(f));
      const frame = frames(Math.max(0, rootAt)).find(mine) || frames(0).find(mine) || frames(0)[0] || '';
      found.push({ at: i, kind: 'java', process: proc?.[1] || '', pid: Number(proc?.[2] || x.pid), thread: x.msg.replace(/^FATAL EXCEPTION:\s*/, ''), exception: exception.trim(), causes, root: causes.at(-1) || exception.trim(), frame, lines: lines.slice(0, 60) });
    } else if (x.tag === 'libc' && /Fatal signal \d+/.test(x.msg)) {
      const sig = /Fatal signal (\d+) \((\w+)\)/.exec(x.msg), addr = /fault addr (\S+?),?(?:\s|$)/.exec(x.msg)?.[1], who = /in tid \d+ \(([^)]*)\), pid (\d+) \(([^)]*)\)/.exec(x.msg);
      const m = [null, sig?.[1], sig?.[2], addr, who?.[1], who?.[2], who?.[3]];
      const dbg = e.slice(i + 1, i + 400).filter((y) => y.tag === 'DEBUG' || y.tag === 'crash_dump64' || y.tag === 'crash_dump32');
      const bt = dbg.map((y) => /#\d+ pc [0-9a-f]+\s+(.+)$/.exec(y.msg)?.[1]).filter(Boolean);
      const abort = dbg.map((y) => /Abort message: '?(.+?)'?$/.exec(y.msg)?.[1]).find(Boolean);
      found.push({ at: i, kind: 'native', process: m?.[6] || '', pid: Number(m?.[5] || x.pid), thread: m?.[4] || '', exception: `${m?.[2] || 'signal'} (signal ${m?.[1] || '?'})${m?.[3] ? ` at ${m[3]}` : ''}`, causes: abort ? [abort] : [],
        root: abort || `${m?.[2] || 'native crash'}`, frame: bt.find((f) => /\/data\/app\//.test(f)) || bt[0] || '', lines: [x.msg, ...dbg.slice(0, 40).map((y) => y.msg)] });
    } else if (x.tag === 'ActivityManager' && /^ANR in /.test(x.msg)) {
      const reason = e.slice(i + 1, i + 12).find((y) => y.tag === 'ActivityManager' && /^Reason: /.test(y.msg))?.msg.replace(/^Reason: /, '') || '';
      const proc = /^ANR in ([\w.:]+)/.exec(x.msg)?.[1] || '';
      found.push({ at: i, kind: 'anr', process: proc, pid: x.pid, exception: 'App Not Responding (the main thread was blocked)', causes: reason ? [reason] : [], root: reason || 'the main thread did not respond', frame: '', lines: [x.msg, reason].filter(Boolean) });
    } else if (x.tag === 'flutter' && /Unhandled Exception: /.test(x.msg)) {
      const rest = [];
      for (let j = i + 1; j < e.length && rest.length < 40 && e[j].tag === 'flutter'; j++) rest.push(e[j].msg);
      const frame = rest.map((l) => /^#\d+\s+(.+)$/.exec(l)?.[1]).filter(Boolean).find((f) => !/\((dart:|package:flutter\/)/.test(f)) || '';
      const msg = x.msg.replace(/^.*?Unhandled Exception: /, '');
      found.push({ at: i, kind: 'flutter', process: pkg, pid: x.pid, exception: `Unhandled Dart exception: ${msg}`, causes: [], root: msg, frame, lines: [x.msg, ...rest] });
    }
  }
  const mine = pkg ? found.filter((c) => !c.process || c.process.replace(/:.*$/, '') === pkg) : found;
  return (mine.length ? mine : found).at(-1) || null;
}

/** A crash as a few lines for the agent. */
export function crashText(c) {
  if (!c) return '';
  const head = { java: `FATAL EXCEPTION in ${c.process || 'the app'}${c.thread ? ` (thread ${c.thread})` : ''}`, native: `Native crash in ${c.process || 'the app'}${c.thread ? ` (thread ${c.thread})` : ''}`, anr: `ANR in ${c.process || 'the app'}`, flutter: 'Flutter app crashed' }[c.kind];
  return [`Crash: ${head}`, `  ${c.exception}`, ...c.causes.map((x) => `  ${c.kind === 'java' ? 'Caused by: ' : c.kind === 'anr' ? 'Reason: ' : 'Abort: '}${x}`),
    c.frame ? `  First line in the app's code: ${c.frame}` : (c.kind === 'java' ? '  (no frame from the app\'s own code: the cause is in how it calls Android)' : '')].filter(Boolean).join('\n');
}

// Gradle's failure, in short: the compiler errors and "What went wrong", with the usual fixes for a missing SDK or JDK.
export function gradleSummary(out) {
  const text = String(out || '');
  if (!/FAILURE: Build failed|BUILD FAILED/.test(text)) return null;
  const errors = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^e: |: error:|AAPT: error|^ERROR:/i.test(l)))].slice(0, 10);
  const wrong = /\* What went wrong:\r?\n([\s\S]*?)(?:\r?\n\s*\r?\n|\r?\n\* Try:)/.exec(text)?.[1].trim().split(/\r?\n/).slice(0, 6).join(' ').replace(/\s+/g, ' ') || '';
  const hint = /SDK location not found|ANDROID_HOME/i.test(text) ? `The build can't find the Android SDK: write sdk.dir=${(sdkRoot() || '<the SDK folder>').replace(/\\/g, '\\\\').replace(/:/g, '\\:')} to local.properties (it is not committed).`
    : /JAVA_HOME|no java command|Unable to locate a Java Runtime/i.test(text) ? `The build can't find a JDK${studioJdk() ? `: Android Studio's own is at ${studioJdk()} (set JAVA_HOME to it for the command)` : ': install one (the user decides), or point JAVA_HOME at one'}.`
      : /licen[cs]es? .*not (been )?accepted/i.test(text) ? 'SDK licences are not accepted: the user accepts them (sdkmanager --licenses asks them to read and agree); don\'t accept them for the user.' : '';
  return [`Gradle build failed.${wrong ? ` What went wrong: ${wrong.slice(0, 400)}` : ''}`, ...errors.map((l) => `  ${l.slice(0, 300)}`), hint].filter(Boolean).join('\n');
}

const sdkVersion = async () => {
  const root = sdkRoot();
  if (!root) return null;
  const c = sdkContents(root);
  return c.platforms[0] ? `API ${c.platforms[0].replace('android-', '')}` : 'found';
};

export default {
  id: 'android',
  label: 'Android',
  summary: 'Apps built with Gradle, run on an emulator, tapped and read like a person would',
  toolchains: [
    { id: 'android-sdk', label: 'Android SDK', for: 'Building Android apps (with a JDK; Android Studio brings both)', detect: sdkVersion,
      works: async () => { const c = sdkContents(); return c.platforms.length && c.buildTools.length ? { ok: true, why: '' } : { ok: false, why: `the SDK has no ${c.platforms.length ? 'build-tools' : 'Android platform'} installed` }; },
      brokenHint: () => `Offer to run ${q(sdkTool('sdkmanager') || 'sdkmanager')} "platforms;android-35" "build-tools;35.0.0" for them (it downloads about 100 MB; ask first), or they add them in Android Studio → SDK Manager.`,
      winget: 'Google.AndroidStudio', url: 'https://developer.android.com/studio' },
    { id: 'adb', label: 'Android platform tools (adb)', for: 'Installing, starting and driving Android apps on an emulator',
      detect: async () => { const o = await run(sdkTool('adb') || 'adb', ['version']); return /version (\d+\.\d+\.\d+)/.exec(o || '')?.[1] || null; },
      winget: 'Google.PlatformTools', brew: 'android-platform-tools', apt: 'adb' },
    { id: 'android-emulator', label: 'Android emulator', for: 'Running Android apps on a virtual phone',
      detect: async () => { const e = sdkTool('emulator'); if (!e) return null; const o = await run(e, ['-version'], { timeout: 15000 }); return /emulator version (\d+\.\d+\.\d+)/i.exec(o || '')?.[1] || (o != null ? 'found' : null); },
      works: async () => ((await listAvds()).length ? { ok: true, why: '' } : { ok: false, why: 'it has no virtual device (AVD) to start yet' }),
      brokenHint: () => `Offer to make one (it downloads a system image of about 1.5 GB, so ask first, and run it as a background job): ${q(sdkTool('sdkmanager') || 'sdkmanager')} "system-images;android-35;google_apis;x86_64", then ${q(sdkTool('avdmanager') || 'avdmanager')} create avd -n qx_api35 -k "system-images;android-35;google_apis;x86_64" -d pixel_6. Or they make one in Android Studio → Device Manager.`,
      url: 'https://developer.android.com/studio/run/emulator' },
  ],
  // The manifest sits two or three folders down (app/src/main), deeper than a marker scan looks.
  detect: isAndroidProject,
  checks: [{ id: 'android', tool: 'android-sdk', ext: /\.(java|kt|kts|xml)$/i, marker: (d) => hasFile(d, /^gradlew(\.bat)?$/) && isAndroidProject(d),
    // Gradle's first run in a project starts its daemon and can take minutes, so it gets a longer limit.
    cmd: () => withEnv(gradleEnv(), GRADLE_CHECK), timeout: 300e3, errors: GRADLE_ERRORS, tidy: tidyGradleLine }],
  // Gradle's and logcat's long output, cut to what matters, after the agent runs them with the shell tool.
  summaries: [
    { cmd: /\bgradlew(\.bat)?\b|\bgradle\b/i, summarize: gradleSummary },
    { cmd: /\badb\b.*\blogcat\b/i, summarize: (out) => crashText(findCrash(out)) || null },
  ],
  notes: (have) => {
    const sdk = sdkRoot(), jdk = studioJdk();
    return [
      `build with ${WIN ? '.\\gradlew.bat' : './gradlew'} assembleDebug (the APK lands in app/build/outputs/apk/debug/); the first build downloads Gradle and takes minutes, so run it as a background job and wait on it.`,
      sdk ? `The SDK is at ${sdk}${process.env.ANDROID_HOME ? '' : ' (ANDROID_HOME is not set: a new project needs local.properties with sdk.dir)'}.` : 'No Android SDK was found: building needs Android Studio or the command-line tools (the user installs them; ⚙ Settings → Setup check has Android Studio).',
      !process.env.JAVA_HOME && jdk ? `Gradle needs a JDK: JAVA_HOME is not set, Android Studio's own is at ${jdk}.` : '',
      `To run it: android avds lists the virtual devices, android start {avd} boots one as a background job (Stop ends it) and waits until it is ready; then android install {apk}, launch {package}, read, tap, type, key.${have.has('android-emulator') ? '' : ' There may be no emulator or AVD yet: tell the user before you plan on one.'} An emulator that won't start on Windows usually needs Windows Hypervisor Platform turned on (the user does that, in Windows Features).`,
      'For a crash, android log {package} starts with a summary: the exception, its "Caused by" and the first line of the app\'s own code; read that file and line first. Check with read after each tap that the screen changed as expected.',
      'Debugging is logcat first: add Log.d("QX", …) lines, reinstall, and read android log. A debugger only if that fails twice: adb shell am set-debug-app -w <package>, launch it, adb jdwp for its pid, adb forward tcp:8700 jdwp:<pid>, then jdb -connect com.sun.jdi.SocketAttach:hostname=localhost,port=8700 in the terminal tool (jdb comes with a JDK).',
    ].filter(Boolean).join(' ');
  },
  // The parser tests run on every computer; the emulator test skips itself without the SDK and an AVD.
  test: { needs: [] },
};
