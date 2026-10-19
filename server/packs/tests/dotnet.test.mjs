// .NET pack self-test: dotnet build catches an error in a changed C# file, and a fixed program runs.
import { project, tool, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';

// Target the SDK that is installed, so the test needs nothing else.
const csproj = (major) => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net${major}.0</TargetFramework>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n`;

test('dotnet: dotnet build catches an error in a changed file', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const major = String((await tool('dotnet')).version).split('.')[0];
  const dir = project('dotnet', { 'qxpack.csproj': csproj(major), 'Program.cs': 'int n = "three";\nSystem.Console.WriteLine(n);\n' });
  const r = await languageChecks(dir, ['Program.cs'], { have: ['dotnet'] });
  assert.equal(r.ran[0]?.lang, 'dotnet');
  assert.ok(r.problems.some((p) => /Program\.cs/.test(p) && /CS0029|convert/i.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('dotnet: a console program builds and runs', async (t) => {
  const skip = await skipUnless('dotnet'); if (skip) return t.skip(skip);
  const major = String((await tool('dotnet')).version).split('.')[0];
  const dir = project('dotnet-run', { 'qxpack.csproj': csproj(major), 'Program.cs': 'System.Console.WriteLine($"{args.Length} words");\n' });
  const out = execFileSync('dotnet', ['run', '--', 'a', 'b', 'c'], { cwd: dir, encoding: 'utf8', shell: WIN, timeout: 300000 });
  assert.match(out, /3 words/);
  assert.ok(fs.existsSync(path.join(dir, 'bin')), 'it built into bin/');
});
