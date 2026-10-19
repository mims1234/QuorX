// Java and Kotlin pack self-test. Without a JDK: the JUnit report summary (fixture reports), compiler error lines,
// the check's command line, and the whole compiler check through a stand-in gradlew. With a JDK: QuorX sees that it
// builds, a one-file program runs, the debugger stops at a breakpoint and reads variables; with Gradle or Maven too,
// the compiler check catches an error and a failing JUnit test is summarised.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { outputSummary } from '../index.js';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';
import { parseJUnitXml, junitSummary, readTestReports, summarizeTests, jvmProblem, checkLine, buildOf, mainClassOf, javaExe } from '../jvm.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jvm');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const has = (cmd, args) => spawnSync(cmd, args, { shell: WIN, stdio: 'ignore', timeout: 30000 }).status === 0;

// ---------- no JDK needed ----------
test('jvm: JUnit reports from Gradle and Maven are summarised', () => {
  const g = parseJUnitXml(fixture('TEST-com.example.CalcTest.xml'));
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].tests, g[0].failures, g[0].skipped], [3, 1, 1]);
  assert.equal(g[0].cases.find((c) => c.name === 'adds()').kind, 'failure');
  const m = parseJUnitXml(fixture('TEST-com.example.ParserTest.xml'));
  assert.equal(m[0].errors, 1);
  const s = junitSummary([...g, ...m]);
  assert.match(s, /^JUnit: 5 tests, 2 failed, 1 skipped \(2 reports\)\./);
  assert.match(s, /- CalcTest > adds\(\): expected: <4> but was: <5> \(CalcTest\.java:12\)/);
  assert.match(s, /- ParserTest > parsesEmpty: NullPointerException: Cannot invoke "String\.length\(\)" because "s" is null \(ParserTest\.java:15\)/);
  assert.equal(junitSummary(parseJUnitXml('<testsuite name="x" tests="2" failures="0" errors="0"><testcase name="a" classname="x"/><testcase name="b" classname="x"/></testsuite>')), 'JUnit: 2 tests, 0 failed (1 report).');
});

test('jvm: after a test run, only the reports it wrote are read', () => {
  const dir = project('jvm-reports', {
    'build.gradle': "plugins { id 'java' }\n",
    'build/test-results/test/TEST-com.example.CalcTest.xml': fixture('TEST-com.example.CalcTest.xml'),
    'lib/pom.xml': '<project/>',
    'lib/target/surefire-reports/TEST-com.example.ParserTest.xml': fixture('TEST-com.example.ParserTest.xml'),
  });
  const old = path.join(dir, 'lib/target/surefire-reports/TEST-com.example.ParserTest.xml');
  fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3)); // from an earlier run
  const since = Date.now() - 60e3;
  assert.match(readTestReports(dir, 0), /5 tests, 2 failed/);
  assert.match(readTestReports(dir, since), /^JUnit: 3 tests, 1 failed, 1 skipped \(1 report\)/);
  const ctx = { cwd: dir, since };
  assert.match(outputSummary(`${WIN ? 'gradlew.bat' : './gradlew'} test --tests CalcTest`, '', ctx), /CalcTest > adds\(\)/);
  assert.match(outputSummary('mvn -B verify', '', ctx), /JUnit/);
  assert.equal(outputSummary('gradlew testClasses', '', ctx), '', 'compiling is not a test run');
  assert.equal(outputSummary('git status', '', ctx), '');
  // Without the folder: the report folders the output names.
  const gradleOut = `FAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':test'.\n> There were failing tests. See the report at: ${pathToFileURL(path.join(dir, 'build', 'reports', 'tests', 'test', 'index.html')).href}`;
  assert.match(summarizeTests(gradleOut), /CalcTest > adds\(\)/);
  const mavenOut = `[ERROR] Please refer to ${path.join(dir, 'lib', 'target', 'surefire-reports')} for the individual test results.`;
  assert.equal(summarizeTests(mavenOut), '', 'an old report is not this run\'s');
  fs.utimesSync(old, new Date(), new Date());
  assert.match(summarizeTests(mavenOut), /ParserTest > parsesEmpty/);
});

test('jvm: compiler errors read as file:line: message', () => {
  const dir = WIN ? 'C:\\work\\app' : '/work/app';
  const abs = (rel) => path.join(dir, ...rel.split('/'));
  assert.equal(jvmProblem(`${abs('src/main/java/com/example/App.java')}:5: error: incompatible types: String cannot be converted to int`, dir),
    'src/main/java/com/example/App.java:5: incompatible types: String cannot be converted to int');
  const url = WIN ? 'file:///C:/work/app/src/main/kotlin/App.kt' : 'file:///work/app/src/main/kotlin/App.kt';
  assert.equal(jvmProblem(`e: ${url}:7:18 Type mismatch: inferred type is String but Int was expected`, dir), 'src/main/kotlin/App.kt:7:18: Type mismatch: inferred type is String but Int was expected');
  assert.equal(jvmProblem(`e: ${abs('src/main/kotlin/App.kt')}: (7, 18): Unresolved reference: foo`, dir), 'src/main/kotlin/App.kt:7:18: Unresolved reference: foo');
  const maven = WIN ? '/C:/work/app/src/main/java/com/example/App.java' : '/work/app/src/main/java/com/example/App.java';
  assert.equal(jvmProblem(`[ERROR] ${maven}:[5,18] incompatible types: java.lang.String cannot be converted to int`, dir), 'src/main/java/com/example/App.java:5:18: incompatible types: java.lang.String cannot be converted to int');
  assert.equal(jvmProblem('[ERROR] Failed to execute goal', dir), 'Failed to execute goal');
});

test('jvm: the check uses the project\'s own wrapper, found above a module', () => {
  const dir = project('jvm-wrap', { 'settings.gradle': "include 'app'\n", [WIN ? 'gradlew.bat' : 'gradlew']: '', 'app/build.gradle': "plugins { id 'application'; id 'org.jetbrains.kotlin.jvm' version '2.0.0' }\n" });
  const b = buildOf(path.join(dir, 'app'));
  assert.equal(b.kind, 'gradle');
  assert.equal(b.root, dir);
  assert.ok(b.kotlin, 'Kotlin is seen');
  assert.match(checkLine(path.join(dir, 'app')), /gradlew(\.bat)?"? testClasses -q --console=plain$/);
  const mvn = project('jvm-mvn', { 'pom.xml': '<project/>' });
  assert.equal(checkLine(mvn, { cached: () => true, has: () => true }), 'mvn -q -B -o test-compile');
  assert.equal(checkLine(mvn, { cached: () => false, has: () => true }), 'mvn -q -B test-compile');
  assert.equal(checkLine(mvn, { cached: () => true, has: () => false }), null, 'no Maven: no check');
  const android = project('jvm-android', { 'build.gradle': "plugins { id 'com.android.application' }\n" });
  assert.equal(checkLine(android, { has: () => true }), null, 'Android modules are the android pack\'s');
  assert.equal(mainClassOf('src/main/java/com/example/App.java', 'package com.example;\nclass App {}'), 'com.example.App');
  assert.equal(mainClassOf('src/main/kotlin/main.kt', 'package com.example\nfun main() {}'), 'com.example.MainKt');
  assert.equal(mainClassOf('Tool.kt', '@file:JvmName("ToolMain")\nfun main() {}'), 'ToolMain');
});

test('jvm: the compiler check reports errors in changed files only, through the wrapper', async () => {
  // A stand-in gradlew prints what javac prints (twice, as Maven does) and fails: no JDK needed to check the path
  // from the check's command line to the problems the agent gets back.
  const javacOut = (sep) => [`${['src', 'main', 'java', 'com', 'example', 'App.java'].join(sep)}:5: error: incompatible types: String cannot be converted to int`, `${['src', 'main', 'java', 'com', 'example', 'Old.java'].join(sep)}:9: error: cannot find symbol`];
  const files = { 'build.gradle': "plugins { id 'java' }\n", 'src/main/java/com/example/App.java': 'class App {}\n', 'src/main/java/com/example/Old.java': 'class Old {}\n' };
  if (WIN) files['gradlew.bat'] = `@echo off\r\n${[...javacOut('\\'), javacOut('\\')[0]].map((l) => `echo %CD%\\${l}`).join('\r\n')}\r\nexit /b 1\r\n`;
  else files.gradlew = `#!/bin/sh\n${[...javacOut('/'), javacOut('/')[0]].map((l) => `echo "$PWD/${l}"`).join('\n')}\nexit 1\n`;
  const dir = project('jvm-check', files);
  if (!WIN) fs.chmodSync(path.join(dir, 'gradlew'), 0o755);
  const r = await languageChecks(dir, ['src/main/java/com/example/App.java'], { have: ['java'] });
  assert.equal(r.ran[0]?.lang, 'jvm');
  assert.deepEqual(r.problems, ['jvm: src/main/java/com/example/App.java:5: incompatible types: String cannot be converted to int']);
});

// ---------- with a JDK ----------
test('jvm: QuorX sees whether the JDK builds here', async (t) => {
  const skip = await skipUnless('java'); if (skip) return t.skip(skip);
  const j = await tool('java');
  assert.ok(j.version, 'a version was read');
  assert.ok(j.works, `the JDK builds a program (${j.problem})`);
});

test('jvm: a one-file program runs', async (t) => {
  const skip = await skipUnless('java', { works: true }); if (skip) return t.skip(skip);
  const dir = project('jvm', { 'Words.java': 'public class Words { public static void main(String[] a) { System.out.println(a.length + " words"); } }\n' });
  assert.match(execFileSync(javaExe(), ['Words.java', 'a', 'b', 'c'], { cwd: dir, encoding: 'utf8', shell: WIN && javaExe() === 'java', timeout: 120000 }), /3 words/);
});

const CART = [
  'public class Cart {',
  '  static int total(int[][] items) {',
  '    int s = 0;',
  '    for (int[] it : items) {',
  '      s += it[0] * it[1];', // line 5
  '    }',
  '    return s;',
  '  }',
  '  public static void main(String[] args) {',
  '    String name = args.length > 0 ? args[0] : "none";',
  '    System.out.println(name + " " + total(new int[][] { { 2, 3 }, { 5, 2 } }));',
  '  }',
  '}',
  ''].join('\n');

test('jvm: the debugger stops at a breakpoint and reads variables', async (t) => {
  const skip = await skipUnless('java', { works: true }); if (skip) return t.skip(skip);
  const dir = project('jvmdbg', { 'Cart.java': CART });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'Cart.java', args: ['shop'] });
  try {
    assert.match(await debugBreak(s.id, 'Cart.java', 5), /breakpoint at Cart\.java:5/);
    let st = await debugMove(s.id, 'continue', 60000);
    assert.equal(st.state, 'paused', 'stopped at the breakpoint');
    assert.equal(st.frames[0].line, 5);
    assert.ok(st.frames.some((f) => /main/.test(f.fn)), 'main is on the stack');
    assert.ok(st.locals.some((l) => /^s = 0$/.test(l)), `locals: ${st.locals.join(', ')}`);
    assert.equal(await debugEval(s.id, 'it[1]'), '3');
    st = await debugMove(s.id, 'continue', 30000); // the second item
    assert.equal(await debugEval(s.id, 's'), '6');
    assert.equal(await debugEval(s.id, 'it.length == 2 && s > 5'), 'true');
    st = await debugMove(s.id, 'step', 30000);
    assert.equal(st.state, 'paused');
    assert.equal(await debugEval(s.id, 's'), '16', 'a step ran the line');
    st = await debugMove(s.id, 'out', 30000);
    assert.equal(await debugEval(s.id, 'name'), '"shop"', 'stepped out into main, which has its argument');
    assert.equal(await debugEval(s.id, 'name.length()'), '4');
  } finally { await debugStop(s.id).catch(() => {}); }
});

// A Swing window: UI Automation sees the window but not its controls (Java Access Bridge doesn't change that), so
// the agent drives it with keys. What UI Automation does see is written to the test's output, for the report.
const SWING = [
  'import javax.swing.*;',
  'public class Clicker {',
  '  public static void main(String[] a) {',
  '    SwingUtilities.invokeLater(() -> {',
  '      JFrame f = new JFrame("QX Swing");',
  '      JButton b = new JButton("Add one");',
  '      int[] n = { 0 };',
  '      b.addActionListener(e -> { n[0]++; System.out.println("clicked " + n[0]); System.out.flush(); });',
  '      f.add(b); f.setSize(240, 120); f.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE); f.setVisible(true);',
  '      b.requestFocusInWindow();',
  '      System.out.println("shown"); System.out.flush();',
  '    });',
  '  }',
  '}',
  ''].join('\n');

test('jvm: a Swing window is found and driven with keys (desktop tool)', { skip: !WIN && 'the desktop tool is Windows only' }, async (t) => {
  const skip = await skipUnless('java', { works: true }); if (skip) return t.skip(skip);
  const { startBackground, stopBackground, jobOutput } = await import('../../bgjobs.js');
  const { appWindows, readWindow, sendKeys } = await import('../../uia.js');
  const dir = project('jvm-swing', { 'Clicker.java': SWING });
  const java = /\s/.test(javaExe()) ? `"${javaExe()}"` : javaExe();
  const job = startBackground({ projectId: 'pack-test', cwd: dir, line: `${java} Clicker.java`, shell: 'direct', label: 'swing', logTo: path.join(dir, 'swing.log') });
  const output = async (re, ms) => { const t0 = Date.now(); for (;;) { const o = (await jobOutput(job.id)).text; if (re.test(o) || Date.now() - t0 > ms) return o; await new Promise((r) => setTimeout(r, 300)); } };
  try {
    assert.match(await output(/shown/, 60000), /shown/, 'the window opened');
    const w = (await appWindows(job.id, 20000)).find((x) => /QX Swing/.test(x.title));
    assert.ok(w, 'the desktop tool finds the window by its title');
    t.diagnostic(`UI Automation sees: ${(await readWindow(job.id, w.handle)).text.replace(/\s+/g, ' ').slice(0, 300)}`);
    await sendKeys(job.id, w.handle, ' '); // Space presses the focused button
    assert.match(await output(/clicked 1/, 15000), /clicked 1/, 'the key reached the button');
  } finally { await stopBackground(job.id).catch(() => {}); }
});

// A real build tool: Gradle on PATH, else Maven. Either runs the compiler check and a JUnit test.
async function buildTool() {
  if ((await tool('gradle')).found) return 'gradle';
  if ((await tool('maven')).found) return 'maven';
  return null;
}
const GRADLE = "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies { testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'; testRuntimeOnly 'org.junit.platform:junit-platform-launcher' }\ntest { useJUnitPlatform() }\n";
const POM = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>qx</groupId><artifactId>qxpack</artifactId><version>1</version>'
  + '<properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>'
  + '<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency></dependencies>'
  + '<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build></project>';
const CALC = 'package com.example;\n\npublic class Calc {\n  public static int add(int a, int b) { return a - b; }\n}\n';
const CALC_TEST = 'package com.example;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\nimport org.junit.jupiter.api.Test;\n\nclass CalcTest {\n  @Test void adds() {\n    assertEquals(4, Calc.add(2, 2));\n  }\n}\n';
const files = (kind, calc) => ({ ...(kind === 'gradle' ? { 'build.gradle': GRADLE, 'settings.gradle': "rootProject.name = 'qxpack'\n" } : { 'pom.xml': POM }),
  'src/main/java/com/example/Calc.java': calc, 'src/test/java/com/example/CalcTest.java': CALC_TEST });

test('jvm: the compiler check catches an error in a changed file (Gradle or Maven)', async (t) => {
  const skip = await skipUnless('java', { works: true }); if (skip) return t.skip(skip);
  const kind = await buildTool(); if (!kind) return t.skip('neither Gradle nor Maven is installed');
  const dir = project('jvm-build', files(kind, 'package com.example;\n\npublic class Calc {\n  public static int add(int a, int b) { int n = "three"; return a + b; }\n}\n'));
  const r = await languageChecks(dir, ['src/main/java/com/example/Calc.java'], { have: ['java'], timeout: 600e3 });
  assert.equal(r.ran[0]?.lang, 'jvm');
  assert.ok(r.problems.some((p) => /src\/main\/java\/com\/example\/Calc\.java:4/.test(p) && /incompatible types/i.test(p)), `problems: ${r.problems.join(' | ')} (ran: ${JSON.stringify(r.ran)})`);
});

test('jvm: a failing JUnit test is summarised (Gradle or Maven)', async (t) => {
  const skip = await skipUnless('java', { works: true }); if (skip) return t.skip(skip);
  const kind = await buildTool(); if (!kind) return t.skip('neither Gradle nor Maven is installed');
  if (!has(kind === 'gradle' ? 'gradle' : 'mvn', ['--version'])) return t.skip(`${kind} does not run`);
  const dir = project('jvm-junit', files(kind, CALC));
  const since = Date.now();
  const line = kind === 'gradle' ? 'gradle test -q --console=plain' : 'mvn -q -B test';
  spawnSync(line, { cwd: dir, shell: true, stdio: 'ignore', timeout: 600e3 }); // fails: the test fails
  const s = outputSummary(line, '', { cwd: dir, since });
  assert.match(s, /JUnit: 1 tests, 1 failed/, s);
  assert.match(s, /CalcTest > adds(\(\))?: expected: <4> but was: <0> \(CalcTest\.java:8\)/, s);
});
