// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Java and Kotlin: Gradle and Maven builds, one-file programs, JUnit, and a debugger (Android builds use the android
// pack too). The compiler check and the debugger use the project's own wrapper (gradlew, mvnw) before a global
// Gradle or Maven. Debugging goes through jvm-debug/QxDebug.java: a small Debug Adapter Protocol server on the JDK's
// own debugger interface (JDI), so a JDK is all it needs; the JDK runs it straight from its source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN, run, tempDir, rm } from './_lib.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jvm-debug', 'QxDebug.java');
const q = (a) => (/[\s&()^]/.test(a) ? `"${a}"` : a);
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** The JDK's java: JAVA_HOME's when it is set (Gradle and Maven use that one too), else the one on PATH. */
export function javaExe() {
  const home = process.env.JAVA_HOME;
  const exe = home && path.join(home, 'bin', WIN ? 'java.exe' : 'java');
  return exe && exists(exe) ? exe : 'java';
}

/** Whether a program is on PATH (synchronous, for the check's command line). */
function onPath(name) {
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  return String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean).some((d) => exts.some((e) => exists(path.join(d, name + e))));
}

const GRADLE_FILE = /^build\.gradle(\.kts)?$/;
const isGradle = (d) => exists(path.join(d, 'build.gradle')) || exists(path.join(d, 'build.gradle.kts'));
const isMaven = (d) => exists(path.join(d, 'pom.xml'));

/**
 * The build that `dir` belongs to: { kind: 'gradle' | 'maven', dir, root, wrapper, kotlin, android }, or null. The
 * wrapper (gradlew, mvnw) usually sits at the top of a multi-project build, so it is looked for upwards.
 */
export function buildOf(dir) {
  const kind = isGradle(dir) ? 'gradle' : isMaven(dir) ? 'maven' : null;
  if (!kind) return null;
  const script = kind === 'gradle' ? read(path.join(dir, exists(path.join(dir, 'build.gradle.kts')) ? 'build.gradle.kts' : 'build.gradle')) : read(path.join(dir, 'pom.xml'));
  const names = kind === 'gradle' ? (WIN ? ['gradlew.bat'] : ['gradlew']) : (WIN ? ['mvnw.cmd'] : ['mvnw']);
  let root = dir, wrapper = null;
  for (let d = dir, i = 0; i < 8; i++) {
    const w = names.map((n) => path.join(d, n)).find(exists);
    if (w) { wrapper = w; root = d; break; }
    // Past the top of the build: Gradle's settings file, or a folder with no pom.xml above a Maven module.
    if (kind === 'gradle' && (exists(path.join(d, 'settings.gradle')) || exists(path.join(d, 'settings.gradle.kts')))) { root = d; break; }
    const up = path.dirname(d);
    if (up === d || (kind === 'maven' && !isMaven(up))) break;
    d = up;
  }
  // Android modules are the android pack's (its own Gradle check): an Android plugin, or a manifest where Android keeps it.
  const android = /com\.android\.|id\s*\(?\s*["']com\.android/.test(script) || exists(path.join(dir, 'src', 'main', 'AndroidManifest.xml'));
  return { kind, dir, root, wrapper, kotlin: /kotlin/i.test(script), android };
}

/**
 * Whether a Maven build can go offline (-o, no network checks): the project was built here before (target/classes),
 * so its libraries are in the local repository. Offline with a library missing, Maven fails without compiling,
 * and the check would see nothing.
 */
const mavenCached = (dir) => exists(path.join(dir, 'target', 'classes')) && exists(path.join(os.homedir(), '.m2', 'repository'));

/**
 * The compiler check's command line for the build `dir` belongs to, or null to skip it. testClasses (Gradle) and
 * test-compile (Maven) compile the main code and the tests, Java and Kotlin alike, without running anything.
 */
export function checkLine(dir, { cached = mavenCached, has = onPath } = {}) {
  const b = buildOf(dir);
  if (!b || b.android) return null; // Android modules are the android pack's
  if (b.kind === 'gradle') {
    const g = b.wrapper ? q(b.wrapper) : has('gradle') ? 'gradle' : null;
    return g && `${g} testClasses -q --console=plain`;
  }
  const m = b.wrapper ? q(b.wrapper) : has('mvn') ? 'mvn' : null;
  return m && `${m} -q -B ${cached(dir) ? '-o ' : ''}test-compile`;
}

// A compiler error line as "path:line:col: message", the path relative to the project folder. Handles javac
// ("App.java:5: error: …"), Kotlin ("e: file:///…/App.kt:5:18 …", older "e: …/App.kt: (5, 18): …") and Maven
// ("[ERROR] /C:/…/App.java:[5,18] …").
const fromUrl = (p) => { let s = p.replace(/^file:\/\//, ''); try { s = decodeURIComponent(s); } catch { /* as is */ } return /^\/[A-Za-z]:/.test(s) ? s.slice(1) : s; };
export function jvmProblem(line, dir) {
  const l = String(line).trim().replace(/^\[ERROR\]\s*/, '');
  const m = /^(.+?\.java):(\d+): error: (.*)$/.exec(l)
    || /^(?:e:\s*)?(.+?\.(?:java|kts?)):\[(\d+),(\d+)\]\s*(.*)$/.exec(l)
    || /^(?:e:\s*)?(.+?\.kts?):(\d+):(\d+):?\s+(.*)$/.exec(l)
    || /^(?:e:\s*)?(.+?\.kts?): \((\d+), (\d+)\):?\s*(.*)$/.exec(l);
  if (!m) return l;
  const [file, ln, col, msg] = m.length === 4 ? [m[1], m[2], null, m[3]] : m.slice(1);
  const abs = fromUrl(file);
  const rel = dir && path.isAbsolute(abs) && !path.relative(dir, abs).startsWith('..') ? path.relative(dir, abs) : abs;
  return `${rel.replaceAll('\\', '/')}:${ln}${col ? `:${col}` : ''}: ${msg.trim()}`;
}

// ---------- JUnit reports: build/test-results (Gradle) and target/surefire-reports (Maven) ----------
const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(\d+);/g, (a, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (a, n) => String.fromCharCode(parseInt(n, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = (s) => Object.fromEntries([...String(s).matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((m) => [m[1], unxml(m[3] ?? m[4])]));

/** One JUnit XML report: [{ name, tests, failures, errors, skipped, cases: [{ cls, name, kind, message, type, trace }] }]. */
export function parseJUnitXml(xml) {
  const suites = [];
  for (const m of String(xml).matchAll(/<testsuite\b([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g)) {
    const a = attrs(m[1]);
    const cases = [];
    for (const c of (m[3] || '').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const ca = attrs(c[1]);
      const f = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(c[3] || '');
      const skipped = /<skipped\b/.test(c[3] || '');
      const fa = f ? attrs(f[2]) : {};
      cases.push({ cls: ca.classname || a.name || '', name: ca.name || '', kind: f ? f[1] : skipped ? 'skipped' : 'passed', message: fa.message || '', type: fa.type || '', trace: f ? unxml(f[4] || '') : '' });
    }
    const n = (k) => Number(a[k] || 0);
    suites.push({ name: a.name || '', tests: n('tests') || cases.length, failures: n('failures'), errors: n('errors'), skipped: n('skipped') || cases.filter((x) => x.kind === 'skipped').length, cases });
  }
  return suites;
}

/** A short summary for the agent: the totals, then each failure with its message and the test's own line. */
export function junitSummary(suites, { max = 8 } = {}) {
  if (!suites.length) return '';
  const sum = (k) => suites.reduce((s, x) => s + x[k], 0);
  const bad = suites.flatMap((s) => s.cases.filter((c) => c.kind === 'failure' || c.kind === 'error'));
  const failed = sum('failures') + sum('errors');
  const head = `JUnit: ${sum('tests')} tests, ${failed} failed${sum('skipped') ? `, ${sum('skipped')} skipped` : ''} (${suites.length} report${suites.length > 1 ? 's' : ''}).`;
  if (!bad.length) return head;
  const lines = bad.slice(0, max).map((c) => {
    const simple = c.cls.split('.').pop().split('$')[0];
    // The first stack line in the test's own class says where it failed (Gradle writes "at app//com.example.…").
    const at = new RegExp(`at [\\w.$/]*\\b${simple}[\\w.$]*\\((${simple}\\.(?:java|kt):\\d+)\\)`).exec(c.trace)?.[1];
    // Gradle starts the message with the exception's type, Maven doesn't; assertion types are left out as noise.
    let msg = c.message || c.trace.split(/\r?\n/)[0] || '';
    if (c.type && msg.startsWith(`${c.type}: `)) msg = msg.slice(c.type.length + 2);
    const type = c.type && !/assert|comparisonfailure|opentest4j/i.test(c.type) ? c.type.split('.').pop() : '';
    const text = [type, msg.replace(/\s+/g, ' ').trim()].filter(Boolean).join(': ') || c.kind;
    return `- ${simple} > ${c.name}: ${text.slice(0, 240)}${at ? ` (${at})` : ''}`;
  });
  return `${head}\nFailed:\n${lines.join('\n')}${bad.length > max ? `\n… and ${bad.length - max} more` : ''}`;
}

const REPORT_DIRS = [['build', 'test-results'], ['target', 'surefire-reports'], ['target', 'failsafe-reports']];
const SKIP = /^(node_modules|\.git|\.gradle|\.idea|src|out|bin)$/;
/** The JUnit summary for reports written since `since` (ms) under `dir` and its modules (three levels down). */
export function readTestReports(dir, since = 0) {
  const files = [];
  const walk = (d, depth) => {
    for (const parts of REPORT_DIRS) {
      const r = path.join(d, ...parts);
      if (!exists(r)) continue;
      const scan = (x, n) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory() && n < 3) scan(p, n + 1); else if (/^TEST-.*\.xml$/i.test(e.name)) files.push(p); } };
      try { scan(r, 0); } catch { /* unreadable */ }
    }
    if (depth >= 3) return;
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.') && e.name !== 'build' && e.name !== 'target') walk(path.join(d, e.name), depth + 1); } catch { /* unreadable */ }
  };
  walk(dir, 0);
  const fresh = files.filter((f) => { try { return fs.statSync(f).mtimeMs >= since - 2000; } catch { return false; } }).slice(0, 400);
  return junitSummary(fresh.flatMap((f) => parseJUnitXml(read(f))));
}

/** A Gradle or Maven command that runs tests. */
export const TEST_RUN = /\b(gradlew?|mvnw?)(\.bat|\.cmd)?\b.*\b(test|check|build|verify|install|package)\b/i;

/**
 * The JUnit summary after a test run: from the reports under the folder it ran in, written since it started; or,
 * without those, from the report folders its output names (Gradle's "See the report at", Maven's "Please refer to").
 */
export function summarizeTests(out, { cwd, since } = {}) {
  const recent = since || Date.now() - 30 * 60e3;
  if (cwd) return readTestReports(cwd, recent);
  const dirs = new Set();
  for (const m of String(out).matchAll(/See the report at: (file:\S+?)[\\/]build[\\/]reports[\\/]/g)) dirs.add(fromUrl(m[1]));
  for (const m of String(out).matchAll(/refer to (.+?)[\\/]target[\\/](surefire|failsafe)-reports/g)) dirs.add(m[1].trim());
  return [...dirs].map((d) => readTestReports(d, recent)).filter(Boolean).join('\n');
}

// ---------- the debugger ----------
/** The JVM class with a file's main: its package plus the class (Java) or the file's facade class (Kotlin: AppKt). */
export function mainClassOf(file, text) {
  const pkg = /^\s*package\s+([\w.]+)/m.exec(text)?.[1];
  const stem = path.basename(file).replace(/\.(java|kt)$/i, '');
  const cls = /\.kt$/i.test(file) ? (/@file:JvmName\("([\w$]+)"\)/.exec(text)?.[1] || `${stem[0].toUpperCase()}${stem.slice(1)}Kt`) : stem;
  return pkg ? `${pkg}.${cls}` : cls;
}

// Installed is not the same as working: a Java runtime without the JDK has no javac. So the JDK compiles and runs a
// tiny program. { ok, why }.
async function jdkWorks() {
  const dir = tempDir('javacheck');
  try {
    fs.writeFileSync(path.join(dir, 'Hello.java'), 'public class Hello { public static void main(String[] a) { System.out.println("qx-java-ok"); } }\n');
    const javac = javaExe().replace(/java(\.exe)?$/i, (m, e) => `javac${e || ''}`);
    const out = await run(javac, ['-d', '.', 'Hello.java'], { cwd: dir, timeout: 60000 });
    if (!exists(path.join(dir, 'Hello.class'))) {
      const none = out === null || /not recognized|not found|no such file/i.test(out);
      return { ok: false, why: none ? 'this is a Java runtime without the JDK (no javac)' : `javac could not build a test program (${String(out).split(/\r?\n/).find((l) => /error/i.test(l)) || 'unknown error'})` };
    }
    const ran = await run(javaExe(), ['-cp', '.', 'Hello'], { cwd: dir, timeout: 30000 });
    return /qx-java-ok/.test(ran || '') ? { ok: true, why: '' } : { ok: false, why: `java could not run a test program (${String(ran || 'no output').split(/\r?\n/)[0]})` };
  } finally { rm(dir); }
}

export default {
  id: 'jvm',
  label: 'Java and Kotlin',
  summary: 'Programs, desktop apps (Swing, JavaFX), services and libraries on the JVM',
  toolchains: [
    { id: 'java', label: 'Java (JDK)', for: 'Java and Kotlin; Android builds', probe: [javaExe(), ['-version']], re: /version "?(\d+(\.\d+)*)/, works: jdkWorks,
      winget: 'Microsoft.OpenJDK.21', brew: 'openjdk@21', apt: 'openjdk-21-jdk', url: 'https://learn.microsoft.com/java/openjdk/download',
      brokenHint: 'Offer to install a JDK (Microsoft.OpenJDK.21 from ⚙ Settings → Setup check, or winget install --id Microsoft.OpenJDK.21 -e, which asks them first); a runtime alone can run programs but not build them.' },
    { id: 'gradle', label: 'Gradle', for: 'Java/Kotlin and Android builds (most projects bring gradlew)', probe: ['gradle', ['--version']], re: /Gradle (\d+\.\d+(\.\d+)?)/, brew: 'gradle', url: 'https://gradle.org/install/' },
    { id: 'maven', label: 'Maven', for: 'Java builds', probe: ['mvn', ['-v']], re: /Apache Maven (\d+\.\d+\.\d+)/, brew: 'maven', apt: 'maven', url: 'https://maven.apache.org/download.cgi' },
    { id: 'kotlin', label: 'Kotlin compiler', for: 'one-file Kotlin programs (Gradle projects bring their own Kotlin)', probe: ['kotlinc', ['-version']], re: /kotlinc-jvm (\d+\.\d+\.\d+)/, brew: 'kotlin', url: 'https://kotlinlang.org/docs/command-line.html' },
  ],
  markers: [GRADLE_FILE, /^settings\.gradle(\.kts)?$/, /^pom\.xml$/],

  // The build's own compiler, through the wrapper. Gradle's daemon makes repeat builds quick, but QuorX ends what a
  // command leaves running, so each check starts one (a few seconds); the very first build downloads Gradle itself.
  checks: [{
    // cmd gets the folder (or { dir, files }, the other shape packs use).
    id: 'jvm', tool: 'java', ext: /\.(java|kt|kts)$/i, marker: (d) => isGradle(d) || isMaven(d), cmd: (d) => checkLine(typeof d === 'string' ? d : d.dir),
    errors: /(^|\s)error:|^\[ERROR\]|^e: /i, tidy: jvmProblem,
    timeoutHint: 'a first Gradle or Maven build downloads the build tool and the libraries: run the build once with the shell tool (it moves to the background when it is slow), and the next check takes seconds',
  }],

  // After a test run (gradlew test, mvn test, …), the failures from the JUnit XML reports, so the agent doesn't
  // have to dig through the console.
  summaries: [{ cmd: TEST_RUN, summarize: summarizeTests }],

  // QxDebug.java speaks DAP on `port`: it builds the program (javac -g for one file, kotlinc, or the project's
  // Gradle or Maven build), starts it suspended, and waits for QuorX's breakpoints.
  debug: {
    exts: ['.java', '.kt'], tool: 'java', label: 'Java and Kotlin (JDK debugger)',
    gate: ({ file, args = [] }) => ['java', ...[file, ...args].map(q)].join(' '),
    start: ({ file, args = [], cwd, port }) => ({
      line: `${q(javaExe())} --add-modules jdk.jdi ${q(BRIDGE)} ${port}`,
      adapterID: 'java', request: 'launch', args: { file, args, cwd },
      missing: 'the Java debugger did not start: it needs a JDK 11 or newer (java on PATH or in JAVA_HOME, with its jdk.jdi module); the debug job\'s log says more',
    }),
  },

  notes: (have, root) => {
    const b = root ? [root, ...(() => { try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(root, e.name)); } catch { return []; } })()].map(buildOf).find(Boolean) : null;
    const rel = b?.wrapper && path.relative(root, b.wrapper);
    const tool = rel ? (path.dirname(rel) === '.' ? (WIN ? '.\\' : './') + rel : rel) : b?.kind === 'maven' ? 'mvn' : 'gradle';
    const build = b?.kind === 'maven' ? `${tool} -B compile, tests with ${tool} -B test (one class: -Dtest=CalcTest)` : `${tool} build, tests with ${tool} test (one class: --tests CalcTest), run with ${tool} run (application plugin)`;
    return [
      `${rel ? `Use the project's own wrapper, ${tool}, never a global gradle or mvn. ` : 'Use the project\'s wrapper (gradlew, mvnw) when it has one. '}Build with ${build}. A one-file program runs with java App.java.`,
      'After a test run QuorX adds a JUnit summary from the XML reports. For an exception, the last "Caused by:" is the real cause; its first "at" line in your own package is where to look.',
      `Kotlin comes from the Gradle plugin and builds like Java; its errors start with "e: ". A lone .kt file needs kotlinc${have?.has?.('kotlin') ? '' : ' (not installed here)'}.`,
      'A program that reads the keyboard goes in the terminal tool; Gradle\'s run task gets no keyboard input.',
      'Desktop apps: run them with background: true and use the desktop tool. JavaFX controls can be read and clicked; Swing and AWT windows show as one empty pane (jabswitch -enable doesn\'t help), so use keys (Tab, Space, Enter) and click_at.',
      'The debug tool runs a .java or .kt file with a main under the JDK\'s debugger. For tests or servers use jdb in the terminal tool: gradlew test --debug-jvm (or mvn -Dmaven.surefire.debug test) waits on port 5005, then jdb -connect com.sun.jdi.SocketAttach:hostname=127.0.0.1,port=5005; stop at com.example.CalcTest:12, cont, where, locals, print x, next.',
      'Run build and test commands directly with the shell tool, never through a script of your own.',
    ].join(' ');
  },

  test: { needs: [] }, // the report parser runs without a JDK; the rest skips itself when java is missing
};
