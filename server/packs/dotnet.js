// .NET (C#): console apps, WPF, WinForms, MAUI and ASP.NET.
import { hasFile } from './_lib.js';

export default {
  id: 'dotnet',
  label: '.NET (C#)',
  summary: 'Console, WPF, WinForms, MAUI and ASP.NET apps',
  toolchains: [{ id: 'dotnet', label: '.NET SDK', for: 'C#: console apps, WPF, WinForms, MAUI, ASP.NET', probe: ['dotnet', ['--version']], re: /^(\d+\.\d+\.\d+)/m, winget: 'Microsoft.DotNet.SDK.8', brew: 'dotnet-sdk', url: 'https://dot.net' }],
  markers: [/\.(csproj|sln|slnx|fsproj)$/i],
  checks: [{ id: 'dotnet', tool: 'dotnet', ext: /\.(cs|csproj|xaml|razor)$/i, marker: (d) => hasFile(d, /\.(csproj|sln|slnx)$/i), cmd: 'dotnet build --nologo -v q -clp:NoSummary' }],
  notes: () => 'build with dotnet build, run with dotnet run, test with dotnet test. A WPF or WinForms window keeps running: start it with shell (background: true) and drive it with the desktop tool. For an unhandled exception, the first frame in your own code is the place to look.',
  test: { needs: ['dotnet'] },
};
