// Which toolchains this computer has, so the agent doesn't guess (and the Setup check can offer to install one).
// Each probe runs a version command with a short limit; the result is cached for 10 minutes.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const WIN = process.platform === 'win32';
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 6000, windowsHide: true, encoding: 'utf8', shell: WIN && !/\.exe$/i.test(cmd) }, (err, out, errOut) => resolve(err && !out && !errOut ? null : `${out || ''}${errOut || ''}`.trim()));
});
const ver = (re) => (o) => (o && re.test(o) ? o.match(re)[1] : null);

// id, what it's for, the probe, the version pattern, and a winget id for the Setup check's Install button.
export const TOOLCHAINS = [
  { id: 'rust', label: 'Rust (cargo)', for: 'Rust programs, CLIs and Tauri apps', probe: ['cargo', ['--version']], re: /cargo (\d+\.\d+\.\d+)/, winget: 'Rustlang.Rustup' },
  { id: 'dotnet', label: '.NET SDK', for: 'C#: console apps, WPF, WinForms, MAUI, ASP.NET', probe: ['dotnet', ['--version']], re: /^(\d+\.\d+\.\d+)/m, winget: 'Microsoft.DotNet.SDK.8' },
  { id: 'go', label: 'Go', for: 'Go programs and services', probe: ['go', ['version']], re: /go(\d+\.\d+(\.\d+)?)/, winget: 'GoLang.Go' },
  { id: 'cmake', label: 'CMake', for: 'C and C++ projects', probe: ['cmake', ['--version']], re: /cmake version (\d+\.\d+\.\d+)/, winget: 'Kitware.CMake' },
  { id: 'msvc', label: 'Visual Studio C++ (MSVC)', for: 'C/C++ on Windows (CMake finds it by itself)', probe: null, winget: 'Microsoft.VisualStudio.2022.BuildTools' },
  { id: 'gcc', label: 'GCC', for: 'C/C++ (MinGW or MSYS2)', probe: ['gcc', ['--version']], re: /(\d+\.\d+\.\d+)/ },
  { id: 'clang', label: 'Clang', for: 'C/C++', probe: ['clang', ['--version']], re: /clang version (\d+\.\d+\.\d+)/, winget: 'LLVM.LLVM' },
  { id: 'java', label: 'Java (JDK)', for: 'Java and Kotlin; Android builds', probe: ['java', ['-version']], re: /version "?(\d+(\.\d+)*)/, winget: 'Microsoft.OpenJDK.21' },
  { id: 'gradle', label: 'Gradle', for: 'Java/Kotlin and Android builds (most projects bring gradlew)', probe: ['gradle', ['--version']], re: /Gradle (\d+\.\d+(\.\d+)?)/ },
  { id: 'maven', label: 'Maven', for: 'Java builds', probe: ['mvn', ['-v']], re: /Apache Maven (\d+\.\d+\.\d+)/ },
  { id: 'python', label: 'Python 3', for: 'Python scripts and desktop apps (tkinter, PyQt)', probe: [WIN ? 'py' : 'python3', WIN ? ['-3', '--version'] : ['--version']], re: /Python (3\.\d+\.\d+)/, winget: 'Python.Python.3.12' },
  { id: 'node', label: 'Node.js', for: 'JavaScript and TypeScript; Electron apps', probe: ['node', ['--version']], re: /v(\d+\.\d+\.\d+)/, winget: 'OpenJS.NodeJS.LTS' },
  { id: 'flutter', label: 'Flutter', for: 'Flutter apps (desktop and Android)', probe: ['flutter', ['--version']], re: /Flutter (\d+\.\d+\.\d+)/ },
  { id: 'adb', label: 'Android platform tools (adb)', for: 'Testing Android apps on an emulator or phone', probe: ['adb', ['version']], re: /version (\d+\.\d+\.\d+)/, winget: 'Google.PlatformTools' },
  { id: 'git', label: 'Git', for: 'Version control', probe: ['git', ['--version']], re: /(\d+\.\d+\.\d+)/, winget: 'Git.Git' },
];

async function msvc() {
  if (!WIN) return null;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const o = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion']);
  return o && /^\d+\.\d+/.test(o) ? o.split(/\r?\n/)[0] : null;
}

let cache = null;
/** [{ id, label, for, found, version, winget }] — cached 10 minutes; `fresh` probes again. */
export async function detectToolchains(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 600e3) return cache.list;
  const list = await Promise.all(TOOLCHAINS.map(async (t) => {
    const version = t.id === 'msvc' ? await msvc() : ver(t.re)(await run(...t.probe));
    return { id: t.id, label: t.label, for: t.for, found: !!version, version, winget: t.winget || null };
  }));
  cache = { at: Date.now(), list };
  return list;
}

/** One line for the agent: what it can build with here. */
export function toolchainNote(list) {
  const have = list.filter((t) => t.found).map((t) => `${t.label} ${t.version}`);
  const missing = list.filter((t) => !t.found).map((t) => t.label);
  return `Toolchains on this computer: ${have.join(', ') || 'none found'}.${missing.length ? ` Not installed: ${missing.join(', ')} (if the task needs one, tell the user; they can install it from ⚙ Settings → Setup check).` : ''}${list.find((t) => t.id === 'msvc')?.found ? ' MSVC (cl.exe) is not on PATH: build C/C++ through CMake, which finds Visual Studio by itself.' : ''}`;
}
