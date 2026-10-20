// Builds the data files of News's reports (news/reports/<slug>/*.json) from sources anyone can reproduce, and the
// parts of each report that depend on whether that data exists. No personal data: no chats, prompts, keys, file
// paths or project names, only benchmark results, test results, the pack registry and the git history.
//
//   node scripts/news-data.mjs                         benchmark results from logs/ in this checkout (if any)
//   node scripts/news-data.mjs --bench <file> ...      or from these files (bench-build-*.json or bench-*.jsonl)
//
// Sources:
//   models      the build benchmark (scripts/bench.mjs --set build → logs/bench-build-<time>.json) and the known-answer
//               benchmark (scripts/bench.mjs → logs/bench-<time>.jsonl): numbers per model and per setup only
//   tests       test counts at each commit of this branch's first-parent history (test(…) calls in the files npm test
//               runs, and in the packs' self-tests), and the last results this checkout kept (logs/test-results.json,
//               written by npm test, npm run test:packs and npm run test:ui)
//   platforms   the pack registry (server/packs/index.js), with each pack's level and the evidence for it (below)
//
// The script rewrites these sections of the reports, from their heading to the next "## " heading:
//   news/reports/models/index.md     ## Leaderboard, ## The decider experiment: the numbers
//   news/reports/tests/index.md      ## Pack self-tests, ## UI test
// Everything else in the reports is written by hand. Run npm run news:check afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'news', 'reports');
const LOGS = path.join(ROOT, 'logs');
const args = process.argv.slice(2);
const benchFiles = [];
for (let i = args.indexOf('--bench') + 1; i > 0 && i < args.length && !args[i].startsWith('--'); i++) benchFiles.push(args[i]);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
const short = (m) => String(m).split('/').pop();
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n, d = 2) => +Number(n).toFixed(d);
const today = new Date().toISOString().slice(0, 10);
const say = (...a) => console.log(...a);

const writeJson = (slug, name, data) => {
  const file = path.join(REPORTS, slug, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  say(`  wrote news/reports/${slug}/${name}`);
};
const block = (name, body) => `\`\`\`${name}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\``;
/** Replaces the section under `## heading` (up to the next "## " heading) of a report with `body`. */
function setSection(slug, heading, body) {
  const file = path.join(REPORTS, slug, 'index.md');
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`news/reports/${slug}/index.md has no "## ${heading}" section`);
  const from = start + heading.length + 5;
  const next = text.indexOf('\n## ', from);
  const out = `${text.slice(0, from)}\n${body.trim()}\n${next < 0 ? '' : `${text.slice(next)}`}`;
  fs.writeFileSync(file, out.endsWith('\n') ? out : `${out}\n`);
}

// ======================= models: the benchmarks =======================
say('Models: benchmark results');
const found = benchFiles.length ? benchFiles.map((f) => path.resolve(f))
  : fs.existsSync(LOGS) ? fs.readdirSync(LOGS).filter((f) => /^bench-build-[\dT-]+\.json$/.test(f) || /^bench-[\dT-]+\.jsonl$/.test(f)).map((f) => path.join(LOGS, f)) : [];
const buildRuns = [], qaRuns = [], sources = [];
for (const file of found) {
  let runs = [];
  try {
    runs = file.endsWith('.jsonl') ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : JSON.parse(fs.readFileSync(file, 'utf8')).results || [];
  } catch (e) { say(`  skipped ${path.basename(file)}: ${e.message}`); continue; }
  runs = runs.filter((r) => r && !r.skipped);
  const build = runs.filter((r) => r.set === 'build'), qa = runs.filter((r) => r.set !== 'build' && r.setup && 'correct' in r);
  buildRuns.push(...build); qaRuns.push(...qa);
  if (build.length || qa.length) sources.push({ file: path.basename(file), runs: build.length + qa.length, from: runs.map((r) => r.ts).filter(Boolean).sort()[0]?.slice(0, 10) || null });
}

// Build benchmark: one row per builder model (full harness only; "direct" runs are a plain chat call, shown apart).
function buildBoard(runs) {
  const by = new Map();
  for (const r of runs) { const k = `${r.builder}|${r.mode || 'harness'}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.entries()].map(([k, rs]) => {
    const [model, mode] = k.split('|');
    const passed = rs.filter((r) => r.pass).length, cost = rs.reduce((a, r) => a + (r.cost || 0), 0);
    return { model, mode, runs: rs.length, passed, passRate: round(passed / rs.length), costPerRun: round(cost / rs.length, 4), costPerWorkingBuild: passed ? round(cost / passed, 4) : null,
      avgSteps: round(avg(rs.map((r) => r.steps || 0)), 1), minutesPerRun: round(avg(rs.map((r) => (r.ms || 0) / 60000)), 1), avgScore: round(avg(rs.filter((r) => r.scores).map((r) => r.total)), 1), errors: rs.filter((r) => r.error).length };
  }).sort((a, b) => b.passRate - a.passRate || (a.costPerRun - b.costPerRun));
}
// The decider experiment in the build benchmark: the same builder with the deciders off and on.
function buildDecide(runs) {
  const by = new Map();
  for (const r of runs.filter((x) => (x.mode || 'harness') === 'harness' && x.decide)) { const k = `${r.builder}|${r.decide}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const rows = [...by.entries()].map(([k, rs]) => { const [model, decide] = k.split('|'); return { model, decide, runs: rs.length, passRate: round(rs.filter((r) => r.pass).length / rs.length), costPerRun: round(avg(rs.map((r) => r.cost || 0)), 4) }; });
  return rows.filter((r) => rows.some((o) => o.model === r.model && o.decide !== r.decide));
}
// Known-answer benchmark: one row per setup (A small alone, C small asking the deciders, D drafts, E frontier alone).
function qaBoard(runs) {
  const by = new Map();
  for (const r of runs) { if (!by.has(r.setup)) by.set(r.setup, []); by.get(r.setup).push(r); }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([setup, rs]) => {
    const asked = rs.reduce((a, r) => { for (const k of ['questions', 'confirmed', 'flipped', 'theater', 'unclear']) a[k] += r.decide?.[k] || 0; return a; }, { questions: 0, confirmed: 0, flipped: 0, theater: 0, unclear: 0 });
    return { setup, model: rs[0].model, runs: rs.length, correct: rs.filter((r) => r.correct).length, accuracy: round(rs.filter((r) => r.correct).length / rs.length), costPerTask: round(avg(rs.map((r) => r.cost || 0)), 5), avgSeconds: round(avg(rs.map((r) => (r.ms || 0) / 1000)), 1), asked };
  });
}

const HOW = [{ cmd: 'node scripts/bench.mjs --set build --builder deepseek/deepseek-v4.1-flash,anthropic/claude-haiku-5.5 --limit 3 --cap 2' }, { out: 'Spends real money on OpenRouter: --cap stops it at that many dollars.' }, { cmd: 'node scripts/news-data.mjs' }, { cmd: 'npm run news:check' }];
const build = buildBoard(buildRuns.filter((r) => (r.mode || 'harness') === 'harness'));
const direct = buildBoard(buildRuns.filter((r) => r.mode === 'direct'));
const decide = buildDecide(buildRuns);
const qa = qaBoard(qaRuns);
const bench = { generated: today, sources, build, direct, decide, qa };
if (build.length) {
  const byCost = [...build].sort((a, b) => a.costPerRun - b.costPerRun);
  bench.passChart = { type: 'bar', title: 'Builds that passed the judge, cheapest model first', unit: '%', x: byCost.map((r) => short(r.model)), series: [{ name: 'Pass rate', values: byCost.map((r) => Math.round(r.passRate * 100)) }] };
  const working = byCost.filter((r) => r.costPerWorkingBuild != null);
  if (working.length) bench.costChart = { type: 'bar', title: 'Cost per working build (US cents)', unit: '¢', x: working.map((r) => short(r.model)), series: [{ name: 'Cents per build that passed', values: working.map((r) => round(r.costPerWorkingBuild * 100, 1)) }] };
}
if (qa.length) bench.qaChart = { type: 'bar', title: 'Known-answer tasks answered correctly, by setup', unit: '%', x: qa.map((r) => `${r.setup} · ${short(r.model)}`), series: [{ name: 'Correct', values: qa.map((r) => Math.round(r.accuracy * 100)) }] };
writeJson('models', 'bench.json', bench);

const money = (n) => (n == null ? '–' : n < 0.01 ? `${round(n * 100, 2)}¢` : `US$${n.toFixed(3)}`);
if (build.length) {
  setSection('models', 'Leaderboard', [
    `From ${buildRuns.length} build runs (${sources.filter((s) => s.file.startsWith('bench-build')).map((s) => `\`${s.file}\``).join(', ')}). Each run is one task from \`bench/tasks-build.json\`, built by the full QuorX agent in a throwaway folder; a judge model then plays the build and scores it. A build passes when function, craft, design and originality all reach the bar.`,
    '',
    '| Model | Runs | Passed | Cost per run | Cost per working build | Steps | Minutes |',
    '|---|---|---|---|---|---|---|',
    ...build.map((r) => `| ${r.model} | ${r.runs} | ${Math.round(r.passRate * 100)}% | ${money(r.costPerRun)} | ${money(r.costPerWorkingBuild)} | ${r.avgSteps} | ${r.minutesPerRun} |`),
    '',
    block('chart', { src: 'bench.json', path: 'passChart' }),
    ...(bench.costChart ? ['', block('chart', { src: 'bench.json', path: 'costChart' })] : []),
    ...(direct.length ? ['', `The same tasks as one plain call to the model (no tools, no checks): ${direct.map((r) => `${short(r.model)} ${Math.round(r.passRate * 100)}%`).join(', ')}.`] : []),
  ].join('\n'));
} else {
  setSection('models', 'Leaderboard', [
    block('callout', { tone: 'info', title: 'No benchmark run yet', text: 'This report fills in from the build benchmark. Nobody has published a run of it here yet, so there are no numbers to show: none are made up. Running it costs real money on OpenRouter, so it only runs when someone chooses to.' }),
    '',
    'To run it and publish the results:',
    '',
    block('terminal', { title: 'Run the build benchmark', lines: HOW }),
  ].join('\n'));
}
if (qa.length || decide.length) {
  const C = qa.find((r) => r.setup === 'C');
  setSection('models', 'The decider experiment: the numbers', [
    ...(qa.length ? [
      `From ${qaRuns.length} runs of the known-answer benchmark (\`bench/tasks.json\` and \`bench/tasks-hard.json\`).`, '',
      '| Setup | Model | Correct | Cost per task | Seconds |', '|---|---|---|---|---|',
      ...qa.map((r) => `| ${r.setup} | ${r.model} | ${r.correct} of ${r.runs} (${Math.round(r.accuracy * 100)}%) | ${money(r.costPerTask)} | ${r.avgSeconds} |`), '',
      block('chart', { src: 'bench.json', path: 'qaChart' }),
      ...(C?.asked.questions ? ['', `In setup C the small model asked ${C.asked.questions} questions: the deciders confirmed its guess ${C.asked.confirmed} times, changed it ${C.asked.flipped} times, were asked something it already knew ${C.asked.theater} times, and were unsure ${C.asked.unclear} times.`] : []),
    ] : []),
    ...(decide.length ? ['', 'Build benchmark, the same builder with the deciders off and on:', '', '| Model | Deciders | Runs | Passed | Cost per run |', '|---|---|---|---|---|',
      ...decide.map((r) => `| ${r.model} | ${r.decide} | ${r.runs} | ${Math.round(r.passRate * 100)}% | ${money(r.costPerRun)} |`)] : []),
  ].join('\n'));
} else {
  setSection('models', 'The decider experiment: the numbers', [
    'No run of the known-answer benchmark has been published here yet. It compares the same small model alone (setup A) with the small model asking the deciders (setup C), three drafts picked by the deciders (D), and a frontier model alone (E). It costs money too:',
    '',
    block('terminal', { title: 'Run the decider experiment', lines: [{ cmd: 'node scripts/bench.mjs --setups A,C,E --limit 10' }, { cmd: 'node scripts/news-data.mjs' }] }),
  ].join('\n'));
}
say(build.length || qa.length ? `  ${buildRuns.length} build runs, ${qaRuns.length} known-answer runs from ${sources.length} file(s)` : `  no benchmark results found (${benchFiles.length ? 'in the files given' : 'logs/bench-build-*.json, logs/bench-*.jsonl'}): the report says "no benchmark run yet"`);

// ======================= tests =======================
say('Tests: history and the last saved results');
const TEST_RE = /^\s*test(?:\.skip|\.only|\.todo)?\(/gm;
const countTests = (text) => (String(text).match(TEST_RE) || []).length;
const show = (ref, file) => { try { return git('show', `${ref}:${file}`); } catch { return ''; } };
const suiteFiles = (pkgText) => { try { return (JSON.parse(pkgText).scripts?.test || '').split(/\s+/).filter((x) => /\.m?js$/.test(x) && !x.startsWith('--')); } catch { return []; } };
const history = git('log', '--first-parent', '--reverse', '--format=%H %cs %s', 'HEAD').trim().split('\n').map((l) => {
  const [hash, date, ...rest] = l.split(' ');
  const subject = rest.join(' ');
  const pr = /Merge pull request #(\d+)/.exec(subject)?.[1];
  const ver = /^v(\d+\.\d+\.\d+)/.exec(subject)?.[1];
  const files = suiteFiles(show(hash, 'package.json'));
  const packTests = (() => { try { return git('ls-tree', '--name-only', `${hash}:server/packs/tests`).split('\n').filter((f) => f.endsWith('.test.mjs')); } catch { return []; } })();
  return { hash: hash.slice(0, 7), date, label: pr ? `#${pr}` : ver ? `v${ver}` : /first public version/i.test(subject) ? 'first' : null,
    npmTest: files.reduce((a, f) => a + countTests(show(hash, f)), 0), packs: packTests.reduce((a, f) => a + countTests(show(hash, `server/packs/tests/${f}`)), 0) };
}).filter((h, i, all) => i === all.length - 1 || h.label); // releases and merged pull requests; the newest commit always
history.at(-1).label ||= 'now';
// Suites now, from the working tree.
const pkgNow = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const suites = suiteFiles(pkgNow).map((f) => ({ file: f, tests: countTests(fs.readFileSync(path.join(ROOT, f), 'utf8')) }));
const packTestsNow = fs.readdirSync(path.join(ROOT, 'server', 'packs', 'tests')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => ({ pack: f.replace('.test.mjs', ''), tests: countTests(fs.readFileSync(path.join(ROOT, 'server', 'packs', 'tests', f), 'utf8')) }));
const uiScenarios = [...fs.readFileSync(path.join(ROOT, 'scripts', 'ui-test.mjs'), 'utf8').matchAll(/SCENARIO === '(\w+)'\) await/g)].map((m) => m[1]);
let saved = {};
try { saved = JSON.parse(fs.readFileSync(path.join(LOGS, 'test-results.json'), 'utf8')) || {}; } catch { /* none kept in this checkout */ }
// Uncommitted test changes in this checkout count as one more point.
const nowCount = { npmTest: suites.reduce((a, s) => a + s.tests, 0), packs: packTestsNow.reduce((a, s) => a + s.tests, 0) };
if (nowCount.npmTest !== history.at(-1).npmTest || nowCount.packs !== history.at(-1).packs) {
  if (history.at(-1).label === 'now') Object.assign(history.at(-1), nowCount); else history.push({ label: 'now', date: today, ...nowCount });
}
const first = history[0], last = history.at(-1);
const testsData = {
  generated: today,
  suites, packTests: packTestsNow, uiScenarios,
  stats: { items: [
    { label: `Tests npm test runs (${first.label} → now)`, from: first.npmTest, to: suites.reduce((a, s) => a + s.tests, 0) },
    { label: `Pack self-tests (${first.label} → now)`, from: first.packs, to: packTestsNow.reduce((a, s) => a + s.tests, 0) },
  ] },
  historyChart: { type: 'line', title: 'Tests written, at each change merged into main', x: history.map((h) => h.label), series: [{ name: 'npm test', values: history.map((h) => h.npmTest) }, { name: 'Pack self-tests', values: history.map((h) => h.packs) }] },
  suitesChart: { type: 'bar', title: 'Tests in each npm test file', x: suites.map((s) => path.basename(s.file, '.mjs').replace(/^test-/, '')), series: [{ name: 'Tests', values: suites.map((s) => s.tests) }] },
  packsChart: { type: 'bar', title: 'Self-tests per pack', x: packTestsNow.map((s) => s.pack), series: [{ name: 'Tests', values: packTestsNow.map((s) => s.tests) }] },
};
const P = saved.packs;
if (P?.rows?.length) {
  const lv = { passed: 'passed', failed: 'failed' };
  testsData.packRun = { at: P.at, version: P.version, platform: P.platform, toolchains: (P.toolchains || []).map((t) => `${t.label} ${t.version || ''}${t.works ? '' : ' (cannot build here)'}`.trim()) };
  testsData.packMatrix = {
    levels: [{ id: 'passed', label: 'Passed' }, { id: 'failed', label: 'Failed' }, { id: 'skipped', label: 'Not tested here' }],
    columns: ['Pack', 'Result', 'Passed', 'Skipped', 'Why some were skipped'],
    rows: P.rows.map((r) => ({ level: lv[r.status] || 'skipped', cells: [r.label, r.status, String(r.pass), String(r.skipped), r.why || (r.skipped ? 'its toolchain is not on this computer' : '')] })),
  };
}
if (saved.ui) testsData.uiRun = { at: saved.ui.at, version: saved.ui.version, scenario: saved.ui.scenario, passed: saved.ui.passed, total: saved.ui.total };
writeJson('tests', 'tests.json', testsData);

const when = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
setSection('tests', 'Pack self-tests', testsData.packMatrix ? [
  `The last \`npm run test:packs\` published here ran on ${when(P.at)} (QuorX ${P.version}, ${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[P.platform] || P.platform}). Toolchains it found: ${testsData.packRun.toolchains.join(', ') || 'none'}. A pack whose toolchain is missing skips the tests that need it; its logic (parsers, rules, notes) is still tested. This is one computer's run: the Platforms report rates each pack by the best run on record, often on a computer set up with that toolchain.`,
  '',
  block('matrix', { src: 'tests.json', path: 'packMatrix' }),
  '',
  block('chart', { src: 'tests.json', path: 'packsChart' }),
].join('\n') : [
  block('callout', { tone: 'info', title: 'No pack test run published yet', text: 'Run npm run test:packs, then node scripts/news-data.mjs, to publish which packs passed on your computer.' }),
  '',
  block('chart', { src: 'tests.json', path: 'packsChart' }),
].join('\n'));
setSection('tests', 'UI test', testsData.uiRun ? [
  `The last UI test published here (\`npm run test:ui -- --scenario ${testsData.uiRun.scenario}\`) ran on ${when(testsData.uiRun.at)} (QuorX ${testsData.uiRun.version}): ${testsData.uiRun.passed} of ${testsData.uiRun.total} steps passed. It starts the QuorX desktop app with its own data folder and port, drives its window the way a person would, and saves a screenshot of every step. Scenarios: ${uiScenarios.map((s) => `\`${s}\``).join(', ')}.`,
].join('\n') : [
  `The UI test starts the QuorX desktop app with its own data folder and port, drives its window the way a person would, and saves a screenshot of every step with an HTML report. Scenarios: ${uiScenarios.map((s) => `\`${s}\``).join(', ')}. No run has been published here yet.`,
  '',
  block('terminal', { title: 'Run the UI test (settings needs no key)', lines: [{ cmd: 'npm run test:ui -- --scenario settings' }, { cmd: 'node scripts/news-data.mjs' }] }),
].join('\n'));
say(`  ${history.length} points of history (${first.label} → ${last.label}); last runs kept here: ${['test', 'packs', 'ui'].filter((k) => saved[k]).join(', ') || 'none'}`);

// ======================= platforms: the pack registry =======================
say('Platforms: the pack registry');
// Each pack's level and the evidence behind it (docs/platform-packs.md): proven = built and run in a real chat,
// tested = self-tests pass on a real machine with the toolchain, wired = the pack exists but nobody has tested it
// with its toolchain yet, next = not started. Raise a level only with the evidence (a pack test report, a PR).
const LEVELS = {
  core: { level: 'tested', check: '–', drive: 'Terminal, background jobs, the browser', explain: 'Git, and how QuorX works in any folder', evidence: 'Git is found on every test run' },
  node: { level: 'tested', check: 'tsc --noEmit for TypeScript', drive: 'Terminal and background servers; pages in the browser', debug: 'Node inspector (built in)', explain: 'npm scripts, TypeScript, servers', evidence: 'Self-test passes on Windows 11 (PR #3, #8)' },
  python: { level: 'tested', check: 'Syntax with the venv\'s own Python, plus ruff or pyflakes', drive: 'tkinter windows clicked; pytest summaries', explain: 'Project venvs, pytest, tkinter limits', evidence: 'Python 3.12 with tkinter, debugpy and pyflakes: a button clicked, a breakpoint in its handler (PR #14)' },
  electron: { level: 'tested', check: '–', drive: 'Windows read and clicked through the DevTools port', debug: 'Main process: Node inspector (debug attach)', explain: 'Starting with a DevTools port, main and renderer output', evidence: '8 of 8 self-tests with Electron 44 on Windows 11 (PR #8)' },
  jvm: { level: 'tested', check: 'Gradle or Maven compile through the wrapper', drive: 'JavaFX through UI Automation, Swing with keys; JUnit summaries', explain: 'Wrappers, JUnit reports, Swing and JavaFX', evidence: '14 of 14 with JDK 21 and Gradle 8.14: compile check, JUnit summary, a breakpoint hit (PR #11)' },
  godot: { level: 'tested', check: 'godot --check-only on each changed script', drive: 'Scenes run headless and print', explain: 'Imports, class_name, user:// logs', evidence: '8 of 8 with Godot 4.7.2: a script error caught, a breakpoint hit in the running game (PR #9)' },
  installers: { level: 'tested', check: 'wix build on changed .wxs files', drive: 'MSIX packed and signed with a test certificate', explain: 'WiX, MakeAppx, SignTool, test signing only', evidence: '6 of 6 with WiX and the Windows SDK: a schema error caught, an MSIX packed and test-signed (PR #9)' },
  dotnet: { level: 'wired', check: 'dotnet build', drive: 'WinForms and WPF windows read and clicked; dotnet test summaries', explain: 'SDKs, target frameworks, test runners', evidence: '4 logic tests pass; 7 need the .NET SDK and skip (PR #4)' },
  tauri: { level: 'wired', check: 'cargo check in src-tauri', drive: 'Window read and clicked through WebView2\'s DevTools port', debug: 'Rust side: lldb-dap (Rust pack)', explain: 'Tauri 1 and 2, capabilities, panics', evidence: 'The WebView2 drive path tested with a real WebView2 window; no real Tauri build yet (PR #6)' },
  rust: { level: 'wired', check: 'cargo check', drive: 'Terminal for programs', explain: 'Cargo, the MSVC linker, panics', evidence: 'cargo check catches errors for real (3 pass); builds and the debugger need the C++ Build Tools (PR #7)' },
  go: { level: 'wired', check: 'go vet', drive: 'Terminal for programs', explain: 'Modules, go test, Delve', evidence: 'Debugger tests pass with a stand-in adapter; needs Go and Delve (PR #7)' },
  cpp: { level: 'wired', check: 'cmake --build on the project\'s build folder', drive: 'Terminal for programs', explain: 'CMake, MSVC and MinGW, crash dumps', evidence: 'Debugger tests pass with a stand-in adapter; needs CMake and LLVM (PR #7)' },
  android: { level: 'wired', check: 'Gradle compileDebugSources', drive: 'Emulator booted, screen read and tapped; Logcat crash summaries', explain: 'SDK, emulator, Gradle, Logcat', evidence: '11 logic tests pass with a stand-in Gradle; no Android SDK tested yet (PR #10)' },
  flutter: { level: 'wired', check: 'flutter analyze, dart analyze', drive: 'Desktop builds driven like any window; test summaries', explain: 'Devices, flutter doctor, debug_adapter', evidence: 'The debugger bridge tested with a stand-in adapter; no Flutter or Dart tested yet (PR #10)' },
  unity: { level: 'wired', check: 'Unity batchmode compile', drive: 'EditMode tests summarised', debug: '– (logs only)', explain: 'Editor versions, license, first import, logs', evidence: 'Parsers and editor discovery tested on fixtures (4 pass); needs Unity with a license (PR #9)' },
  apple: { level: 'wired', check: 'xcodebuild, swift build', drive: 'iOS Simulator driven; crash reports read', explain: 'Xcode setup, simulators, crash reports', evidence: 'Needs a Mac; its logic is tested on Windows (8 pass, PR #13)' },
};
const NEXT = [
  { label: 'MinGW gdb debugging', covers: 'Debugging MinGW builds with gdb\'s own adapter (gdb -i dap)', evidence: 'Not started: lldb-dap debugs MinGW builds meanwhile' },
  { label: 'Unity\'s debugger', covers: 'Breakpoints in a running Unity game', evidence: 'Not started: Unity\'s debugger is not one the debug tool can drive' },
];
process.env.OH_HOME ||= fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'qx-news-data-')); // the registry never touches a real data folder
const { PACKS, allToolchains } = await import('../server/packs/index.js');
const missing = PACKS.filter((p) => !LEVELS[p.id]).map((p) => p.id);
if (missing.length) say(`  ⚠ no level for ${missing.join(', ')}: shown as "wired". Add them to LEVELS in scripts/news-data.mjs.`);
const levelLabel = { proven: 'Proven', tested: 'Tested', wired: 'Logic tested', next: 'Not yet' };
const packRows = PACKS.map((p) => {
  const L = LEVELS[p.id] || { level: 'wired', evidence: 'No evidence recorded yet' };
  return { id: p.id, label: p.label, summary: p.summary || '', level: L.level, hosts: p.hosts || null,
    detect: (p.toolchains || []).map((t) => t.label), check: L.check || ((p.checks || []).length ? 'yes' : '–'), drive: L.drive || '–',
    debug: L.debug || p.debug?.label || '–', explain: L.explain || (p.notes ? 'yes' : '–'), evidence: L.evidence };
});
const order = { proven: 0, tested: 1, wired: 2, next: 3 };
packRows.sort((a, b) => order[a.level] - order[b.level] || a.label.localeCompare(b.label));
const toolchains = allToolchains();
const checks = PACKS.flatMap((p) => p.checks || []);
const debuggers = PACKS.filter((p) => p.debug).length + 1; // + Node's inspector, built in
const count = (lvl) => packRows.filter((r) => r.level === lvl).length;
const platforms = {
  generated: today,
  packs: packRows,
  next: NEXT,
  totals: { packs: PACKS.length, toolchains: toolchains.length, checks: checks.length, debuggers, proven: count('proven'), tested: count('tested'), wired: count('wired'), next: NEXT.length },
  matrix: {
    levels: ['proven', 'tested', 'wired', 'next'].map((id) => ({ id, label: levelLabel[id] })),
    columns: ['Platform', 'Covers', 'Detect', 'Check', 'Run and drive', 'Debug', 'Explain', 'Evidence'],
    rows: [
      ...packRows.map((r) => ({ level: r.level, cells: [r.label + (r.hosts ? ` (${r.hosts.map((h) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[h] || h)).join(', ')} only)` : ''), r.summary || 'Every project', r.detect.join(', ') || '–', r.check, r.drive, r.debug, r.explain, r.evidence] })),
      ...NEXT.map((n) => ({ level: 'next', cells: [n.label, n.covers, '–', '–', '–', '–', '–', n.evidence] })),
    ],
  },
  levelChart: { type: 'bar', title: 'Packs by level of evidence', x: ['Proven', 'Tested', 'Logic tested', 'Not yet'], series: [{ name: 'Packs', values: [count('proven'), count('tested'), count('wired'), NEXT.length] }] },
};
// Before → after: the pack framework's first version (PR #3) and now, from the git history.
const prThree = git('log', '--first-parent', '--format=%H %s', 'HEAD').split('\n').find((l) => /Merge pull request #3 /.test(l))?.split(' ')[0];
if (prThree) {
  const lsAt = (dir) => { try { return git('ls-tree', '--name-only', `${prThree}:${dir}`).split('\n').filter(Boolean); } catch { return []; } };
  platforms.stats = { items: [
    { label: 'Platform packs (PR #3 → now)', from: lsAt('server/packs').filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_')).length, to: PACKS.length },
    { label: 'Pack self-test files (PR #3 → now)', from: lsAt('server/packs/tests').filter((f) => f.endsWith('.test.mjs')).length, to: packTestsNow.length },
  ] };
}
writeJson('platforms', 'packs.json', platforms);
say(`  ${PACKS.length} packs, ${toolchains.length} toolchains, ${checks.length} checks, ${debuggers} debuggers · ${count('tested')} tested, ${count('wired')} logic tested, ${count('proven')} proven`);
say('\nDone. Check with: npm run news:check');
process.exit(0);
