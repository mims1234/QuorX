// .NET (C#): console apps, WinForms, WPF, ASP.NET, and MAUI's Windows target.
// The SDK is found with `dotnet --list-sdks` (a runtime alone can run apps but not build them) and checked by building
// a tiny console app. Debugging goes through netcoredbg (Samsung's open-source .NET debugger) over DAP: QuorX builds the
// project, then asks netcoredbg to launch its dll.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WIN, run, hasFile, tempDir, rm } from './_lib.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
// No MSBuild nodes or compiler server left running after a build: QuorX ends what a command leaves behind anyway.
const BUILD = ['build', '--nologo', '-v', 'q', '-clp:NoSummary', '-p:UseSharedCompilation=false'];
const ENV = { MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

/** `dotnet --list-sdks` → [{ version, major, path }], newest first ("8.0.404 [C:\Program Files\dotnet\sdk]"). */
export function parseSdks(out) {
  const num = (v) => v.split(/[-+]/)[0].split('.').map(Number);
  const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return (a.includes('-') ? 1 : 0) - (b.includes('-') ? 1 : 0); };
  return [...String(out || '').matchAll(/^\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)\s+\[(.+)\]\s*$/gm)]
    .map((m) => ({ version: m[1], major: Number(m[1].split('.')[0]), path: m[2] })).sort((a, b) => newer(a.version, b.version));
}
/** The target framework an SDK makes by default: 8.0.404 → net8.0. */
export const tfmOf = (version) => (version ? `net${String(version).split('.').slice(0, 2).join('.')}` : 'net8.0');

let sdk = null; // the newest SDK found, for the notes
async function detectSdk() {
  sdk = parseSdks(await run('dotnet', ['--list-sdks'], { timeout: 15000 }))[0] || null;
  return sdk?.version || null;
}

/** dotnet with QuorX's build environment: { code, out }. */
const dotnet = (args, cwd, timeout = 300e3) => new Promise((resolve) => {
  execFile('dotnet', args, { cwd, timeout, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...ENV }, maxBuffer: 16 << 20 },
    (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${out || ''}${errOut || ''}`, missing: err?.code === 'ENOENT' }));
});

// Installed is not the same as working: a broken workload, a global.json pinning an SDK that isn't here, or a
// half-finished install all show up only when something is built. { ok, why }.
async function dotnetBuilds() {
  const dir = tempDir('dotnetcheck');
  try {
    fs.writeFileSync(path.join(dir, 'qxcheck.csproj'), `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>${tfmOf(sdk?.version)}</TargetFramework>\n  </PropertyGroup>\n</Project>\n`);
    fs.writeFileSync(path.join(dir, 'Program.cs'), 'System.Console.WriteLine("ok");\n');
    const r = await dotnet(BUILD, dir, 180e3);
    if (findTargetDll(dir)) return { ok: true, why: '' };
    const first = parseBuildErrors(r.out)[0];
    return { ok: false, why: `the .NET SDK could not build a test console app (${first ? `${first.code}: ${first.msg}` : r.out.split(/\r?\n/).find((l) => /error/i.test(l))?.trim() || 'no output'})` };
  } finally { rm(dir); }
}

// ---------- build errors ----------
// MSBuild: "C:\app\MainWindow.xaml(12,5): error MC3072: The property 'Txt' does not exist … [C:\app\app.csproj]".
// XAML markup errors (MC…), and C# errors in the code WPF generates from XAML, point at the .xaml file and its line.
const MSBUILD_LINE = /^\s*(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;
/** One MSBuild diagnostic line → { file, line, col, severity, code, msg, project }, or null. */
export function parseBuildLine(l) {
  const m = MSBUILD_LINE.exec(String(l));
  return m ? { file: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : null, severity: m[4], code: m[5], msg: m[6].trim(), project: m[7] || null } : null;
}
/** Every error in a build's output, once each (WPF builds a second, temporary project and repeats them). */
export function parseBuildErrors(out) {
  const seen = new Set();
  return String(out || '').split(/\r?\n/).map(parseBuildLine).filter((e) => e && e.severity === 'error')
    .filter((e) => { const k = `${e.file}|${e.line}|${e.code}`; return !seen.has(k) && seen.add(k); });
}
/** A build error as the agent reads it: "Views/MainWindow.xaml:12:5: error MC3072: …", relative to the project. */
export function tidyBuildLine(l, dir) { const e = parseBuildLine(l); return e ? errorText(e, dir) : l; }
function errorText(e, dir) {
  const rel = dir && path.isAbsolute(e.file) ? path.relative(dir, e.file) : e.file;
  const file = (rel && !rel.startsWith('..') ? rel : e.file).replace(/\\/g, '/');
  return `${file}:${e.line}${e.col ? `:${e.col}` : ''}: ${e.severity} ${e.code}: ${e.msg}`;
}

// ---------- dotnet test ----------
const short = (s, n = 220) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
// "at Calc.Tests.AddTests.Adds() in C:\src\AddTests.cs:line 9" (VSTest) or "…AddTests.cs:9" (Microsoft.Testing.Platform)
const FRAME = /\bat .+? in (.+?):(?:line )?(\d+)\s*$/;
/**
 * The results of `dotnet test`, for VSTest (xUnit, NUnit, MSTest) and Microsoft.Testing.Platform output:
 * { total, passed, failed, skipped, failures: [{ name, message, at }], aborted }, or null when no tests ran.
 */
export function parseTestOutput(out) {
  const lines = String(out || '').split(/\r?\n/);
  const r = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [], aborted: null };
  let counted = false;
  for (const l of lines) {
    // VSTest: "Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 12 ms - Calc.Tests.dll (net8.0)"
    const v = /(?:Passed|Failed)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/.exec(l);
    if (v) { counted = true; r.failed += +v[1]; r.passed += +v[2]; r.skipped += +v[3]; r.total += +v[4]; }
    if (/test run was aborted|Test host process crashed/i.test(l) && !r.aborted) r.aborted = short(l.trim(), 300);
  }
  // Microsoft.Testing.Platform: "Test run summary: Failed! …" then "  total: 3", "  failed: 1", "  succeeded: 2", "  skipped: 0".
  if (!counted) {
    for (let i = 0; i < lines.length; i++) {
      if (!/Test run summary:/i.test(lines[i])) continue;
      counted = true;
      for (const l of lines.slice(i + 1, i + 8)) {
        const m = /^\s*(total|failed|succeeded|skipped):\s*(\d+)/i.exec(l);
        if (m) r[{ total: 'total', failed: 'failed', succeeded: 'passed', skipped: 'skipped' }[m[1].toLowerCase()]] += +m[2];
      }
    }
  }
  // Each failure: VSTest's "  Failed Name [5 ms]" then "Error Message:" … "Stack Trace:"; MTP's "failed Name (5ms)".
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*Failed\s+(\S.*?)\s+\[[^\]]*\]\s*$/.exec(lines[i]) || /^\s*failed\s+(\S.*?)\s+\([\d.]+\s*m?s\)\s*$/.exec(lines[i]);
    if (!head) continue;
    const body = [];
    let at = null;
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      const l = lines[j];
      if (/^\s*(Failed|Passed|Skipped)\s+\S.*\[[^\]]*\]\s*$|^\s*(failed|passed|skipped)\s+\S.*\([\d.]+\s*m?s\)\s*$|^(Failed|Passed)!|Test run summary:/.test(l)) break;
      const f = FRAME.exec(l);
      if (f) { at ||= `${path.basename(f[1].trim())}:${f[2]}`; continue; }
      if (/^\s*at /.test(l) || /^\s*(Error Message|Stack Trace|Standard Output Messages?):\s*$/.test(l) || !l.trim()) continue;
      if (!at) body.push(l.trim());
    }
    r.failures.push({ name: head[1], message: short(body.join(' · ')), at });
  }
  if (!counted && !r.failures.length && !r.aborted) return null;
  if (!r.failed) r.failed = r.failures.length;
  return r;
}
/** The short summary QuorX puts above `dotnet test`'s output. */
export function testSummary(out) {
  const r = parseTestOutput(out);
  if (!r) return '';
  const head = `dotnet test: ${r.failed} failed, ${r.passed} passed, ${r.skipped} skipped (${r.total || r.failed + r.passed + r.skipped} in all).`;
  const fails = r.failures.slice(0, 10).map((f) => `- ${f.name}${f.at ? ` (${f.at})` : ''}${f.message ? `: ${f.message}` : ''}`);
  return [head, r.aborted ? `The test run was aborted: ${r.aborted}` : '', fails.length ? `Failed tests:\n${fails.join('\n')}${r.failures.length > 10 ? `\n… and ${r.failures.length - 10} more` : ''}` : ''].filter(Boolean).join('\n');
}

// ---------- the built program, for the debugger ----------
/** The nearest folder from `file`'s up to `root` that has a .csproj (or null). */
export function projectOf(root, file) {
  let d = path.dirname(path.resolve(root, file));
  for (let i = 0; i < 12; i++) {
    if (hasFile(d, /\.csproj$/i)) return d;
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return null;
    d = path.dirname(d);
  }
  return null;
}
/**
 * The dll a Debug build of the project in `dir` made: bin/Debug/<framework>[/<runtime>]/<AssemblyName>.dll, the
 * newest when there are several. .NET Framework builds (net4x) are left out: netcoredbg debugs .NET 5 and later.
 */
export function findTargetDll(dir) {
  const proj = (() => { try { return fs.readdirSync(dir).find((f) => /\.csproj$/i.test(f)); } catch { return null; } })();
  if (!proj) return null;
  let name = proj.replace(/\.csproj$/i, '');
  try { name = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(fs.readFileSync(path.join(dir, proj), 'utf8'))?.[1] || name; } catch { /* unreadable */ }
  const sub = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
  const bins = [path.join(dir, 'bin', 'Debug'), ...sub(path.join(dir, '..', 'artifacts', 'bin', proj.replace(/\.csproj$/i, ''))).filter((d) => /debug/i.test(path.basename(d)))];
  const dirs = bins.flatMap((b) => { const tfms = sub(b).filter((d) => !/^net4\d/i.test(path.basename(d))); return [b, ...tfms, ...tfms.flatMap(sub)]; });
  const dlls = dirs.map((d) => path.join(d, `${name}.dll`)).filter((f) => fs.existsSync(f));
  return dlls.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

const NETCOREDBG_INSTALL = WIN ? 'winget install --id Samsung.NetCoreDbg -e (it asks the user first)' : 'download it from https://github.com/Samsung/netcoredbg/releases and put the netcoredbg folder on the PATH';

export default {
  id: 'dotnet',
  label: '.NET (C#)',
  summary: 'Console, WinForms, WPF, ASP.NET and MAUI apps',
  toolchains: [
    { id: 'dotnet', label: '.NET SDK', for: 'C#: console apps, WinForms, WPF, ASP.NET, MAUI', detect: detectSdk, works: dotnetBuilds, winget: 'Microsoft.DotNet.SDK.8', brew: 'dotnet-sdk', url: 'https://dot.net',
      brokenHint: 'Run dotnet --info to see why: a global.json that pins an SDK version that isn\'t installed is the usual cause (change its version, or install that SDK); otherwise offer to repair the SDK from ⚙ Settings → Setup check.' },
    { id: 'netcoredbg', label: 'netcoredbg', for: 'debugging C# programs (breakpoints, variables)', probe: ['netcoredbg', ['--version']], re: /debugger\s+v?(\d+\.\d+\.\d+(?:-\d+)?)/i,
      winget: 'Samsung.NetCoreDbg', url: 'https://github.com/Samsung/netcoredbg/releases' },
  ],
  markers: [/\.(csproj|sln|slnx|fsproj)$/i],
  checks: [{ id: 'dotnet', tool: 'dotnet', ext: /\.(cs|csproj|xaml|axaml|razor|cshtml)$/i, marker: (d) => hasFile(d, /\.(csproj|sln|slnx)$/i),
    cmd: `dotnet ${BUILD.join(' ')}`, tidy: tidyBuildLine }],
  summaries: [{ cmd: /^\s*dotnet(?:\.exe)?\s+test\b/i, summarize: testSummary }],
  debug: {
    exts: ['.cs'], tool: 'dotnet', label: 'C# (netcoredbg)',
    gate: ({ args = [] }) => `dotnet run${args.length ? ` -- ${args.map(quote).join(' ')}` : ''}`,
    // netcoredbg launches the program itself (dotnet app.dll), after QuorX has set the breakpoints. A fresh Debug
    // build first, so the breakpoints match the code.
    start: async ({ file, args = [], cwd, port }) => {
      const dir = projectOf(cwd, file);
      if (!dir) throw new Error(`no .csproj in ${path.dirname(file) || '.'} or the folders above it`);
      const b = await dotnet(BUILD, dir);
      if (b.missing) throw new Error('the .NET SDK (dotnet) is not installed');
      if (b.code !== 0) throw new Error(`the project did not build:\n${parseBuildErrors(b.out).slice(0, 8).map((e) => errorText(e, dir)).join('\n') || short(b.out, 1500)}`);
      const program = findTargetDll(dir);
      if (!program) throw new Error(`the build made no dll under ${path.relative(cwd, path.join(dir, 'bin', 'Debug')) || 'bin/Debug'}`);
      return {
        line: `netcoredbg --interpreter=vscode --server=${port}`,
        adapterID: 'coreclr', request: 'launch', args: { program, args, cwd: dir, stopAtEntry: false, justMyCode: true },
        exceptions: ['user-unhandled'], // stop where an exception the program doesn't catch is thrown
        missing: `netcoredbg did not open its port (is it installed? ${NETCOREDBG_INSTALL})`,
      };
    },
  },
  notes: (have) => [
    `build with dotnet build, run with dotnet run, test with dotnet test (QuorX puts a summary of the failed tests on top; one test: dotnet test --filter "FullyQualifiedName~Name").${sdk ? ` The SDK here is ${sdk.version}: new projects target ${tfmOf(sdk.version)} (${tfmOf(sdk.version)}-windows for WinForms and WPF).` : ''}`,
    'A WinForms or WPF window keeps running: build first, then start it with shell `dotnet run --no-build` and background: true, and use the desktop tool on that job (read, click, type). Stop it (job_stop) before building again: a running app locks its exe.',
    'In WinForms an exception in an event handler shows a dialog instead of ending the app: read it with the desktop tool. A crash prints "Unhandled exception." and the stack to the job\'s output: the first "at … in <file>:line N" in your own code is the place to look. A XamlParseException\'s inner exception has the real cause and the XAML line.',
    'WPF binding mistakes never throw: they are "System.Windows.Data Error: 40 : BindingExpression path error" lines in the debug output (the debug tool shows them), or add PresentationTraceSources.DataBindingSource.Listeners.Add(new ConsoleTraceListener()) and Switch.Level = SourceLevels.Warning at startup to see them in job_output.',
    'ASP.NET: start dotnet run in the background, read the "Now listening on" URL from job_output, then open it with the browser tool. MAUI needs the maui workload (dotnet workload install maui; ask first, it is large); for its Windows target set <WindowsPackageType>None</WindowsPackageType> and run dotnet run -f <the -windows framework>, then use the desktop tool.',
    have.has('netcoredbg') ? 'The debug tool runs the project a .cs file belongs to under netcoredbg (it builds first) and stops where an unhandled exception is thrown.' : `The debug tool needs netcoredbg for C#: ${NETCOREDBG_INSTALL}.`,
  ].join(' '),
  test: { needs: ['dotnet'] },
};
