// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// .NET pack self-test. Without the SDK: the SDK list, build errors, test results and the built dll are read correctly.
// With the .NET SDK: dotnet build catches C# and XAML errors in changed files, a console program runs, a WinForms app is
// built and driven through UI Automation, dotnet test failures are summed up, and (with netcoredbg) the debugger stops
// at a breakpoint and reads a variable.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { outputSummary } from '../index.js';
import pack, { parseSdks, tfmOf, parseBuildErrors, tidyBuildLine, parseTestOutput, testSummary, findTargetDll, projectOf } from '../dotnet.js';

// Target the SDK that is installed, so the test needs nothing else.
const tfm = async () => tfmOf((await tool('dotnet')).version);
const csproj = (framework, extra = '') => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>${framework}</TargetFramework>\n    <Nullable>enable</Nullable>\n${extra}  </PropertyGroup>\n</Project>\n`;
const dotnet = (args, cwd) => spawnSync('dotnet', args, { cwd, encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', MSBUILDDISABLENODEREUSE: '1' } });

// ---------- no SDK needed ----------
test('dotnet: the newest SDK is read from dotnet --list-sdks', () => {
  const sdks = parseSdks('6.0.428 [C:\\Program Files\\dotnet\\sdk]\r\n8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n10.0.100-rc.2.25502.107 [C:\\Program Files\\dotnet\\sdk]\r\n8.0.110 [C:\\Program Files\\dotnet\\sdk]\r\n');
  assert.deepEqual(sdks.map((s) => s.version), ['10.0.100-rc.2.25502.107', '8.0.404', '8.0.110', '6.0.428']);
  assert.equal(parseSdks('9.0.100 [/usr/share/dotnet/sdk]\n9.0.100-preview.7 [/usr/share/dotnet/sdk]')[0].version, '9.0.100', 'a release is newer than its previews');
  assert.deepEqual(parseSdks(''), [], 'a runtime without an SDK lists nothing');
  assert.equal(tfmOf('8.0.404'), 'net8.0');
  assert.equal(tfmOf('10.0.100-rc.2.25502.107'), 'net10.0');
  const nc = pack.toolchains.find((t) => t.id === 'netcoredbg');
  assert.equal('NET Core debugger 3.1.3-1062 (5e0ad1b, Release)\n\nCopyright (c) 2020 Samsung Electronics Co., LTD'.match(nc.re)[1], '3.1.3-1062');
});

test('dotnet: C# and XAML build errors are read with their file and line, once each', () => {
  const out = [
    'C:\\src\\Shop\\Program.cs(3,9): error CS0029: Cannot implicitly convert type \'string\' to \'int\' [C:\\src\\Shop\\Shop.csproj]',
    'C:\\src\\Shop\\Views\\MainWindow.xaml(12,37): error MC3072: The property \'Colour\' does not exist in XML namespace \'http://schemas.microsoft.com/winfx/2006/xaml/presentation\'. Line 12 Position 37. [C:\\src\\Shop\\Shop_abc123_wpftmp.csproj]',
    'C:\\src\\Shop\\Views\\MainWindow.xaml(12,37): error MC3072: The property \'Colour\' does not exist in XML namespace \'http://schemas.microsoft.com/winfx/2006/xaml/presentation\'. Line 12 Position 37. [C:\\src\\Shop\\Shop.csproj]',
    'C:\\src\\Shop\\Views\\MainWindow.xaml(20,51): error CS1061: \'MainWindow\' does not contain a definition for \'Save_Click\' [C:\\src\\Shop\\Shop.csproj]',
    'C:\\src\\Shop\\Program.cs(8,13): warning CS0168: The variable \'e\' is declared but never used [C:\\src\\Shop\\Shop.csproj]',
    'C:\\Program Files (x86)\\Lib\\x.cs(1,1): error CS1002: ; expected [C:\\src\\Shop\\Shop.csproj]',
  ].join('\r\n');
  const errs = parseBuildErrors(out);
  assert.deepEqual(errs.map((e) => `${path.basename(e.file.replace(/\\/g, '/'))}:${e.line}:${e.code}`), ['Program.cs:3:CS0029', 'MainWindow.xaml:12:MC3072', 'MainWindow.xaml:20:CS1061', 'x.cs:1:CS1002']);
  const dir = WIN ? 'C:\\src\\Shop' : '/src/Shop';
  const line = WIN ? out.split('\r\n')[1] : out.split('\r\n')[1].replace(/C:\\src\\Shop\\Views\\/, '/src/Shop/Views/');
  assert.match(tidyBuildLine(line, dir), /^Views\/MainWindow\.xaml:12:37: error MC3072: The property 'Colour' does not exist .*Position 37\.$/);
  assert.equal(tidyBuildLine('Build FAILED.', dir), 'Build FAILED.', 'other lines are left alone');
  assert.ok(pack.checks[0].ext.test('Views/MainWindow.xaml') && pack.checks[0].ext.test('Pages/Index.cshtml'));
});

const VSTEST = `  Determining projects to restore...
  Calc -> C:\\src\\Calc.Tests\\bin\\Debug\\net8.0\\Calc.Tests.dll
Test run for C:\\src\\Calc.Tests\\bin\\Debug\\net8.0\\Calc.Tests.dll (.NETCoreApp,Version=v8.0)
Starting test execution, please wait...
A total of 1 test files matched the specified pattern.
[xUnit.net 00:00:00.35]     Calc.Tests.AddTests.Adds_two_numbers [FAIL]
  Failed Calc.Tests.AddTests.Adds_two_numbers [5 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 4
Actual:   5
  Stack Trace:
     at Calc.Tests.AddTests.Adds_two_numbers() in C:\\src\\Calc.Tests\\AddTests.cs:line 9
   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)
  Failed Calc.Tests.AddTests.Divides [1 ms]
  Error Message:
   System.DivideByZeroException : Attempted to divide by zero.
  Stack Trace:
     at Calc.Calculator.Divide(Int32 a, Int32 b) in C:\\src\\Calc\\Calculator.cs:line 6
   at Calc.Tests.AddTests.Divides() in C:\\src\\Calc.Tests\\AddTests.cs:line 15

Failed!  - Failed:     2, Passed:     5, Skipped:     1, Total:     8, Duration: 41 ms - Calc.Tests.dll (net8.0)
Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 4 ms - Other.Tests.dll (net8.0)
`;
const MTP = `Running tests from C:\\src\\Calc.Tests\\bin\\Debug\\net10.0\\Calc.Tests.dll (net10.0|x64)
failed Adds_two_numbers (12ms)
  Assert.AreEqual failed. Expected:<4>. Actual:<5>.
    at Calc.Tests.AddTests.Adds_two_numbers() in C:\\src\\Calc.Tests\\AddTests.cs:9

Test run summary: Failed! - C:\\src\\Calc.Tests\\bin\\Debug\\net10.0\\Calc.Tests.dll (net10.0|x64)
  total: 4
  failed: 1
  succeeded: 3
  skipped: 0
  duration: 210ms
`;

test('dotnet: dotnet test results are summed up, with each failure, its message and its line', () => {
  const r = parseTestOutput(VSTEST);
  assert.deepEqual([r.total, r.passed, r.failed, r.skipped], [11, 8, 2, 1]);
  assert.deepEqual(r.failures.map((f) => [f.name, f.at]), [['Calc.Tests.AddTests.Adds_two_numbers', 'AddTests.cs:9'], ['Calc.Tests.AddTests.Divides', 'Calculator.cs:6']]);
  assert.equal(r.failures[0].message, 'Assert.Equal() Failure: Values differ · Expected: 4 · Actual: 5');
  const m = parseTestOutput(MTP);
  assert.deepEqual([m.total, m.passed, m.failed, m.skipped], [4, 3, 1, 0]);
  assert.equal(m.failures[0].at, 'AddTests.cs:9');
  assert.match(m.failures[0].message, /Expected:<4>\. Actual:<5>/);
  const crash = parseTestOutput('Test Run Aborted.\nThe active test run was aborted. Reason: Test host process crashed : Stack overflow.\n');
  assert.match(crash.aborted, /Test host process crashed/);
  assert.equal(parseTestOutput('Build succeeded.\n'), null, 'no summary when no tests ran');
  const text = testSummary(VSTEST);
  assert.match(text, /^dotnet test: 2 failed, 8 passed, 1 skipped \(11 in all\)\./);
  assert.match(text, /- Calc\.Tests\.AddTests\.Divides \(Calculator\.cs:6\): System\.DivideByZeroException : Attempted to divide by zero\./);
  assert.equal(outputSummary('dotnet test --nologo', VSTEST), text, 'QuorX puts it above dotnet test\'s output');
  assert.equal(outputSummary('dotnet build', VSTEST), '', 'and only there');
});

test('dotnet: the debugger finds the project of a .cs file and its Debug dll', () => {
  const dir = project('dotnet-dll', {
    'src/Counter/Counter.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net8.0-windows;net48</TargetFrameworks><AssemblyName>QxCounter</AssemblyName></PropertyGroup></Project>',
    'src/Counter/Views/MainForm.cs': '', 'src/Counter/bin/Debug/net8.0-windows/QxCounter.dll': 'x', 'src/Counter/bin/Debug/net48/QxCounter.dll': 'x', 'src/Counter/bin/Debug/net8.0-windows/Other.dll': 'x',
  });
  const proj = projectOf(dir, 'src/Counter/Views/MainForm.cs');
  assert.equal(proj, path.join(dir, 'src', 'Counter'));
  assert.equal(findTargetDll(proj), path.join(proj, 'bin', 'Debug', 'net8.0-windows', 'QxCounter.dll'), '.NET Framework builds are left out');
  assert.equal(projectOf(dir, 'loose.cs'), null);
  assert.equal(pack.debug.gate({ file: 'Program.cs', args: ['in put.txt'] }), 'dotnet run -- "in put.txt"');
});

// ---------- with the .NET SDK ----------
test('dotnet: QuorX finds the SDK and it builds here', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const d = await tool('dotnet');
  assert.match(d.version, /^\d+\.\d+\.\d+/);
  assert.ok(d.works, `the SDK builds a console app: ${d.problem}`);
});

test('dotnet: dotnet build catches an error in a changed file', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const dir = project('dotnet', { 'qxpack.csproj': csproj(await tfm()), 'Program.cs': 'int n = "three";\nSystem.Console.WriteLine(n);\n' });
  const r = await languageChecks(dir, ['Program.cs'], { have: ['dotnet'] });
  assert.equal(r.ran[0]?.lang, 'dotnet');
  assert.ok(r.problems.some((p) => /^dotnet: Program\.cs:1:\d+: error CS0029/.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('dotnet: a XAML mistake in a WPF window is caught with its file and line', { skip: !WIN && 'WPF is Windows only' }, async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const dir = project('dotnet-wpf', {
    'QxWpf.csproj': `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>WinExe</OutputType>\n    <TargetFramework>${await tfm()}-windows</TargetFramework>\n    <UseWPF>true</UseWPF>\n  </PropertyGroup>\n</Project>\n`,
    'App.xaml': '<Application x:Class="QxWpf.App" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" StartupUri="MainWindow.xaml"/>\n',
    'App.xaml.cs': 'namespace QxWpf;\npublic partial class App : System.Windows.Application { }\n',
    'MainWindow.xaml': '<Window x:Class="QxWpf.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="QX WPF">\n  <StackPanel>\n    <Button Content="Save" Colour="Red"/>\n  </StackPanel>\n</Window>\n',
    'MainWindow.xaml.cs': 'namespace QxWpf;\npublic partial class MainWindow : System.Windows.Window { public MainWindow() { InitializeComponent(); } }\n',
  });
  const r = await languageChecks(dir, ['MainWindow.xaml'], { have: ['dotnet'] });
  assert.ok(r.problems.some((p) => /^dotnet: MainWindow\.xaml:4:\d+: error MC\d+: .*Colour/.test(p)), `problems: ${r.problems.join(' | ')}`);
  assert.equal(r.problems.length, new Set(r.problems).size, 'each error once');
});

test('dotnet: a console program builds and runs', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const dir = project('dotnet-run', { 'qxpack.csproj': csproj(await tfm()), 'Program.cs': 'System.Console.WriteLine($"{args.Length} words");\n' });
  const out = execFileSync('dotnet', ['run', '--', 'a', 'b', 'c'], { cwd: dir, encoding: 'utf8', shell: WIN, timeout: 300000 });
  assert.match(out, /3 words/);
  assert.ok(findTargetDll(dir), 'it built into bin/Debug');
});

const FORM = `using System;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "QX Pack Form" };
        var label = new Label { Text = "Count: 0", Top = 10, Left = 10 };
        var button = new Button { Text = "Add one", Top = 40, Left = 10 };
        int n = 0;
        button.Click += (s, e) => label.Text = $"Count: {++n}";
        form.Controls.Add(label);
        form.Controls.Add(button);
        Application.Run(form);
    }
}
`;

test('dotnet: a WinForms app runs as a background job and the desktop tool presses its button', { skip: !WIN && 'WinForms and UI Automation are Windows only' }, async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const { jobsAvailable } = await import('../../jobhost.js');
  if (!(await jobsAvailable())) return t.skip('the job host is not running, so desktop apps cannot be reached');
  const { startBackground, stopBackground } = await import('../../bgjobs.js');
  const { appWindows, readWindow, clickControl } = await import('../../uia.js');
  const dir = project('dotnet-winforms', {
    'QxForm.csproj': `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>WinExe</OutputType>\n    <TargetFramework>${await tfm()}-windows</TargetFramework>\n    <UseWindowsForms>true</UseWindowsForms>\n  </PropertyGroup>\n</Project>\n`,
    'Program.cs': FORM,
  });
  const b = dotnet(['build', '--nologo', '-v', 'q'], dir);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  // As the notes tell the agent: build first, then dotnet run --no-build in the background.
  const job = startBackground({ projectId: 'pack-test', cwd: dir, line: 'dotnet run --no-build', shell: 'direct', label: 'winforms', logTo: path.join(dir, 'run.log') });
  try {
    const w = await appWindows(job.id, 30000);
    assert.ok(w.some((x) => x.title === 'QX Pack Form'), `windows: ${JSON.stringify(w)}`);
    const before = (await readWindow(job.id)).text;
    assert.match(before, /Count: 0/);
    const ref = before.match(/\[(\d+)\] Button "Add one"/)?.[1];
    assert.ok(ref, before);
    await clickControl(job.id, undefined, ref);
    await new Promise((r) => setTimeout(r, 500));
    assert.match((await readWindow(job.id)).text, /Count: 1/);
  } finally { await stopBackground(job.id).catch(() => {}); }
});

test('dotnet: dotnet test failures are summed up with their file and line', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const dir = project('dotnet-test', {
    'Calc.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>${await tfm()}</TargetFramework>\n    <IsPackable>false</IsPackable>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n    <PackageReference Include="xunit" Version="2.9.2" />\n    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />\n  </ItemGroup>\n</Project>\n`,
    'CalcTests.cs': 'using Xunit;\n\npublic class CalcTests\n{\n    [Fact] public void Adds() => Assert.Equal(4, 2 + 2);\n\n    [Fact]\n    public void AddsWrong()\n    {\n        int sum = 2 + 3;\n        Assert.Equal(4, sum);\n    }\n}\n',
  });
  const r = dotnet(['test', '--nologo'], dir);
  const out = `${r.stdout}${r.stderr}`;
  if (/NU1101|NU1301|Unable to load the service index/.test(out)) return t.skip('the xUnit packages could not be downloaded from NuGet');
  const sum = outputSummary('dotnet test --nologo', out);
  assert.match(sum, /^dotnet test: 1 failed, 1 passed, 0 skipped/, out);
  assert.match(sum, /AddsWrong \(CalcTests\.cs:11\): .*Expected: 4/);
});

test('dotnet: netcoredbg stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  if (!(await tool('netcoredbg')).found) return t.skip(`netcoredbg is not installed (${WIN ? 'winget install Samsung.NetCoreDbg' : 'https://github.com/Samsung/netcoredbg/releases'})`);
  const { debugStart, debugBreak, debugMove, debugEval, debugStop, stateText } = await import('../../debugger.js');
  const dir = project('dotnet-dbg', {
    'qxpack.csproj': csproj(await tfm()),
    'Program.cs': 'var items = new[] { (2, 3), (5, 2) };\nint total = 0;\nforeach (var (price, qty) in items)\n{\n    total += price * qty;\n}\nSystem.Console.WriteLine($"total {total}");\n',
  });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'Program.cs' });
  try {
    assert.match(await debugBreak(s.id, 'Program.cs', 5), /breakpoint at Program\.cs:5/);
    let st = await debugMove(s.id, 'continue', 60000);
    assert.equal(st.state, 'paused', stateText(st));
    assert.equal(st.frames[0].line, 5);
    st = await debugMove(s.id, 'continue', 30000); // the second item
    assert.equal(st.state, 'paused', stateText(st));
    assert.equal(await debugEval(s.id, 'price'), '5');
    assert.equal(await debugEval(s.id, 'total'), '6');
    st = await debugMove(s.id, 'continue', 30000); // two items: it runs to the end
    assert.equal(st.state, 'ended', stateText(st));
    assert.match(st.output || '', /total 16/, 'the program\'s output reaches the agent');
  } finally { await debugStop(s.id).catch(() => {}); }
});
