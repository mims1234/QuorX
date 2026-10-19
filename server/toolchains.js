// Which toolchains this computer has, so the agent doesn't guess (and the Setup check can offer to install one).
// Each probe runs a version command with a short limit; the result is cached for 10 minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const WIN = process.platform === 'win32';
const run = (cmd, args, { cwd, timeout = 6000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, windowsHide: true, encoding: 'utf8', shell: WIN && !/\.exe$/i.test(cmd) }, (err, out, errOut) => resolve(err && !out && !errOut ? null : `${out || ''}${errOut || ''}`.trim()));
});

// Installed is not the same as working: on Windows, Rust needs a C linker (Visual Studio's C++ Build Tools) to make a
// program, and a PC can have cargo without one. So Rust is checked by building a tiny program. { ok, why }.
async function rustBuilds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-rustcheck-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.rs'), 'fn main() {}\n');
    const out = await run('rustc', ['main.rs', '-o', WIN ? 'main.exe' : 'main'], { cwd: dir, timeout: 60000 });
    if (fs.existsSync(path.join(dir, WIN ? 'main.exe' : 'main'))) return { ok: true, why: '' };
    const linker = /link(er|\.exe)|cc` not found|msvc/i.test(out || '');
    return { ok: false, why: linker ? 'no C linker: Rust needs the Visual Studio Build Tools with C++ to make programs on Windows' : `rustc could not build a test program (${String(out || 'no output').split(/\r?\n/).find((l) => /error/i.test(l)) || 'unknown error'})` };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ } }
}
const ver = (re) => (o) => (o && re.test(o) ? o.match(re)[1] : null);

// id, what it's for, the probe, the version pattern, and a winget id for the Setup check's Install button.
export const TOOLCHAINS = [
  { id: 'rust', label: 'Rust (cargo)', for: 'Rust programs, CLIs and Tauri apps', probe: ['cargo', ['--version']], re: /cargo (\d+\.\d+\.\d+)/, winget: 'Rustlang.Rustup' },
  { id: 'dotnet', label: '.NET SDK', for: 'C#: console apps, WPF, WinForms, MAUI, ASP.NET', probe: ['dotnet', ['--version']], re: /^(\d+\.\d+\.\d+)/m, winget: 'Microsoft.DotNet.SDK.8' },
  { id: 'go', label: 'Go', for: 'Go programs and services', probe: ['go', ['version']], re: /go(\d+\.\d+(\.\d+)?)/, winget: 'GoLang.Go' },
  { id: 'cmake', label: 'CMake', for: 'C and C++ projects', probe: ['cmake', ['--version']], re: /cmake version (\d+\.\d+\.\d+)/, winget: 'Kitware.CMake' },
  // A plain Build Tools install has no compiler or linker: the C++ workload must be named, or link.exe never arrives.
  { id: 'msvc', label: 'Visual Studio C++ (MSVC)', for: 'C/C++ on Windows, and the linker Rust needs (CMake finds it by itself)', probe: null, winget: 'Microsoft.VisualStudio.2022.BuildTools',
    wingetArgs: '--override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' },
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

// An installer adds its folder to the PATH in the registry, but a program that is already running keeps the PATH it
// started with, so QuorX wouldn't see a toolchain installed while it runs. This adds the registry's new entries
// (never removes any); the agent's commands inherit them too.
const readRegPath = async (key) => {
  const o = await run('reg.exe', ['query', key, '/v', 'Path']);
  const m = o && o.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
  return m ? m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all) : '';
};
export async function refreshPath() {
  if (!WIN) return 0;
  const reg = [...(await readRegPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')).split(';'), ...(await readRegPath('HKCU\\Environment')).split(';')]
    .map((p) => p.trim()).filter(Boolean);
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const have = new Set(String(process.env[key] || '').split(';').map((p) => p.trim().replace(/\\$/, '').toLowerCase()));
  const add = [...new Set(reg)].filter((p) => !have.has(p.replace(/\\$/, '').toLowerCase()));
  if (add.length) process.env[key] = [process.env[key], ...add].filter(Boolean).join(';');
  return add.length;
}

async function probe(t) {
  const version = t.id === 'msvc' ? await msvc() : ver(t.re)(await run(...t.probe));
  const r = { id: t.id, label: t.label, for: t.for, found: !!version, version, works: !!version, problem: '', winget: t.winget || null };
  if (version && t.id === 'rust') { const b = await rustBuilds(); r.works = b.ok; r.problem = b.why; }
  return r;
}

let cache = null;
/**
 * [{ id, label, for, found, works, problem, version, winget }] — cached 10 minutes; `fresh` probes again. What was
 * missing or couldn't build is looked at again after a minute, so a toolchain the user installs mid-chat (from the
 * Setup check, or a winget the agent ran) counts on the next reply without restarting QuorX.
 */
export async function detectToolchains(fresh = false) {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < 600e3) {
    const gaps = cache.list.filter((t) => !t.found || !t.works);
    if (!gaps.length || now - cache.gapsAt < 60e3) return cache.list;
    await refreshPath();
    const again = await Promise.all(gaps.map((g) => probe(TOOLCHAINS.find((t) => t.id === g.id))));
    const list = cache.list.map((t) => again.find((a) => a.id === t.id) || t);
    cache = { ...cache, list, gapsAt: now };
    return list;
  }
  await refreshPath();
  const list = await Promise.all(TOOLCHAINS.map(probe));
  cache = { at: now, gapsAt: now, list };
  return list;
}

/** One line for the agent: what it can build with here. */
export function toolchainNote(list) {
  const have = list.filter((t) => t.found).map((t) => `${t.label} ${t.version}${t.works ? '' : ' (installed, but it can\'t build programs here)'}`);
  const missing = list.filter((t) => !t.found).map((t) => t.label);
  const broken = list.filter((t) => t.found && !t.works);
  const vs = TOOLCHAINS.find((t) => t.id === 'msvc');
  const vsLine = `winget install --id ${vs.winget} -e ${vs.wingetArgs}`;
  const after = 'Installing runs outside this chat and can take a while: say so, and ask the user to tell you when it is done; QuorX looks for toolchains again on each reply, so you carry on from there';
  return `Toolchains on this computer: ${have.join(', ') || 'none found'}.${missing.length ? ` Not installed: ${missing.join(', ')} (if the task needs one, tell the user; they can install it from ⚙ Settings → Setup check, or you can run its winget install if they allow it).` : ''}`
    + broken.map((t) => ` ${t.label}: ${t.problem}. Checking code still works (cargo check, tests that don't link), but building or running a program won't: before you try, tell the user. Offer, in this order: they install the Build Tools with C++ from ⚙ Settings → Setup check (the usual Windows setup, which Tauri and C/C++ need too); you run \`${vsLine}\` for them (it asks them first, shows Windows' admin prompt and takes 5–15 minutes; without the --override part it installs no linker); or you stop at a checked crate.`).join('')
    + (missing.length || broken.length ? ` ${after}.` : '')
    + (list.find((t) => t.id === 'msvc')?.found ? ' MSVC (cl.exe) is not on PATH: build C/C++ through CMake, which finds Visual Studio by itself.' : '');
}
