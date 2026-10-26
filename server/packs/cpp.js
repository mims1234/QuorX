// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// C and C++: CMake projects with the Microsoft compiler, GCC or Clang. Changed files are checked by building the
// project's existing CMake build folder; debugging goes through lldb-dap (LLVM), which launches the program CMake
// built for the file (found through CMake's file API) or the `program` the agent names.
import fs from 'node:fs';
import path from 'node:path';
import { WIN, run, VS_BUILD_TOOLS } from './_lib.js';
import { lldbDapVersion, lldbDapWorks, lldbPlan } from './_lldb.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/') || '.';

// Visual Studio's compiler is not on PATH; vswhere says whether one with the C++ tools is installed.
async function msvc() {
  if (!WIN) return null;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const o = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion']);
  return o && /^\d+\.\d+/.test(o) ? o.split(/\r?\n/)[0] : null;
}

/**
 * The project's configured CMake build folder (one with a CMakeCache.txt): build/, cmake-build-*, out/build/<preset>
 * (Visual Studio) or build/<preset>, a debug one first. null when the project was never configured.
 */
export function cmakeBuildDir(dir) {
  const has = (d) => fs.existsSync(path.join(d, 'CMakeCache.txt'));
  const kids = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
  const found = [path.join(dir, 'build'), ...kids(dir).filter((d) => /^(cmake-build-|_?build)/i.test(path.basename(d))), ...kids(path.join(dir, 'out', 'build')), ...kids(path.join(dir, 'build'))].filter(has);
  return [...new Set(found)].sort((a, b) => Number(/debug/i.test(path.basename(b))) - Number(/debug/i.test(path.basename(a))))[0] || null;
}

/** The top CMake project at or above `file` (inside root): the highest folder with a CMakeLists.txt. */
export function cmakeTop(root, file) {
  let d = path.dirname(path.resolve(root, file)), top = null;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, 'CMakeLists.txt'))) top = d;
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  return top;
}

/** What CMakeCache.txt says about the build: { type, multi } (multi: Visual Studio and Ninja Multi-Config). */
export function cmakeCache(buildDir) {
  let t = '';
  try { t = fs.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8'); } catch { /* none */ }
  return { type: /^CMAKE_BUILD_TYPE:\w+=(.*)$/m.exec(t)?.[1]?.trim() || '', multi: /^CMAKE_CONFIGURATION_TYPES:\w+=./m.test(t) };
}

// CMake's file API: a query file in the build folder makes the next configure write a reply that lists every target,
// its sources and the program it builds. https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html
export const askCmake = (buildDir) => { const q = path.join(buildDir, '.cmake', 'api', 'v1', 'query', 'codemodel-v2'); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, ''); };
/** The executables in a file-API reply: [{ name, program, sources: [absolute paths] }], for `config` (or the first). */
export function cmakeExecutables(buildDir, config = 'Debug') {
  const reply = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(reply, f), 'utf8'));
  let index;
  try { index = fs.readdirSync(reply).filter((f) => /^index-.*\.json$/.test(f)).sort().at(-1); } catch { return []; }
  if (!index) return [];
  const cm = read(index).objects?.find((o) => o.kind === 'codemodel');
  if (!cm) return [];
  const model = read(cm.jsonFile);
  const conf = model.configurations.find((c) => c.name === config) || model.configurations[0];
  const src = model.paths.source, bld = model.paths.build;
  return (conf?.targets || []).map((t) => read(t.jsonFile)).filter((t) => t.type === 'EXECUTABLE' && t.artifacts?.length).map((t) => ({
    name: t.name,
    program: path.resolve(bld, t.artifacts.find((a) => /\.exe$/i.test(a.path))?.path || t.artifacts[0].path),
    sources: (t.sources || []).map((s) => path.resolve(src, s.path)),
  }));
}

/** The program to debug for `file`: the executable built from it, else the only one. { program } or { error }. */
export function pickExecutable(exes, file) {
  const f = path.resolve(file).toLowerCase();
  const own = exes.filter((e) => e.sources.some((s) => s.toLowerCase() === f));
  if (own.length === 1) return { program: own[0].program };
  const pool = own.length ? own : exes;
  if (pool.length === 1) return { program: pool[0].program };
  if (!pool.length) return { error: 'CMake builds no program here (only libraries?): pass program, the built program to run' };
  return { error: `${pool.length} programs could run ${path.basename(file)}: pass program, one of ${pool.map((e) => e.program).join(', ')}` };
}

const failed = (what, r) => {
  const errs = String(r.out || '').split(/\r?\n/).filter((l) => /\berror\b/i.test(l)).slice(0, 6).map((l) => l.trim());
  return new Error(`${what} failed${r.timedOut ? ' (it ran out of time)' : ''}: ${errs.join(' | ') || String(r.out || '').trim().split(/\r?\n/).slice(-4).join(' | ')}`);
};

/**
 * Builds the CMake project `file` belongs to (configuring a Debug build folder first when it has none) and finds the
 * program built from that file. { program, note }; throws when the build fails or no program is found.
 */
export async function cmakeProgram(root, file, { timeout = 600e3 } = {}) {
  const { runLine } = await import('../workspace.js'); // builds run as jobs, like every other command
  const top = cmakeTop(root, file);
  if (!top) throw new Error('this file is not in a CMake project: build the program with debug info (-g for GCC and Clang, /Zi for MSVC) and pass its path as program');
  let b = cmakeBuildDir(top), note = '';
  if (!b) {
    b = path.join(top, 'build');
    askCmake(b);
    const r = await runLine(top, 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug', { shell: 'direct', timeout });
    if (r.code !== 0) throw failed('cmake -S . -B build', r);
  } else {
    askCmake(b);
    const r = await runLine(top, `cmake ${quote(rel(top, b))}`, { shell: 'direct', timeout }); // writes the file-API reply
    if (r.code !== 0) throw failed(`cmake ${rel(top, b)}`, r);
  }
  const { type, multi } = cmakeCache(b);
  const r = await runLine(top, `cmake --build ${quote(rel(top, b))}${multi ? ' --config Debug' : ''}`, { shell: 'direct', timeout });
  if (r.code !== 0) throw failed('cmake --build', r);
  if (!multi && !/^(Debug|RelWithDebInfo)$/i.test(type)) note = `${rel(top, b)} is configured as ${type || 'no build type'}, so it may have no debug info and breakpoints may not bind: configure a debug build (cmake -S . -B build-debug -DCMAKE_BUILD_TYPE=Debug) if they don't.`;
  const pick = pickExecutable(cmakeExecutables(b, multi ? 'Debug' : type), path.resolve(root, file));
  if (pick.error) throw new Error(pick.error);
  return { program: pick.program, note };
}

// On Windows, a program built by MSVC (or clang-cl) has its debug info in a .pdb file, which LLDB reads less fully
// than GCC's and Clang's DWARF.
const pdbNote = (program) => (WIN && fs.existsSync(program.replace(/\.exe$/i, '.pdb'))
  ? 'This is an MSVC build: LLDB reads its .pdb, so breakpoints and the stack work, but some variables (STL containers) show raw fields.' : '');

export default {
  id: 'cpp',
  label: 'C and C++',
  summary: 'Native programs and libraries with CMake',
  toolchains: [
    { id: 'cmake', label: 'CMake', for: 'C and C++ projects', probe: ['cmake', ['--version']], re: /cmake version (\d+\.\d+\.\d+)/, winget: 'Kitware.CMake', brew: 'cmake', apt: 'cmake' },
    { id: 'msvc', label: 'Visual Studio C++ (MSVC)', for: 'C/C++ on Windows, and the linker Rust needs (CMake finds it by itself)', detect: msvc, ...VS_BUILD_TOOLS,
      note: 'MSVC (cl.exe) is not on PATH: build C/C++ through CMake, which finds Visual Studio by itself.' },
    { id: 'gcc', label: 'GCC', for: 'C/C++ (MinGW or MSYS2)', probe: ['gcc', ['--version']], re: /(\d+\.\d+\.\d+)/, apt: 'build-essential' },
    { id: 'clang', label: 'Clang', for: 'C/C++', probe: ['clang', ['--version']], re: /clang version (\d+\.\d+\.\d+)/, winget: 'LLVM.LLVM', brew: 'llvm', apt: 'clang' },
    { id: 'lldb', label: 'LLDB (lldb-dap)', for: 'debugging C, C++ and Rust programs', detect: lldbDapVersion, works: lldbDapWorks,
      winget: 'LLVM.LLVM', brew: 'llvm', apt: 'lldb', url: 'https://github.com/llvm/llvm-project/releases' },
  ],
  markers: [/^CMakeLists\.txt$/, /\.vcxproj$/i, /^meson\.build$/],
  // Only a project that is already configured is built: configuring a new one is the agent's call, not the check's.
  checks: [{
    id: 'cmake', tool: 'cmake', ext: /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp)$/i,
    marker: (d) => fs.existsSync(path.join(d, 'CMakeLists.txt')) && !!cmakeBuildDir(d),
    cmd: (d) => { const b = cmakeBuildDir(d); return `cmake --build ${quote(rel(d, b))}${cmakeCache(b).multi ? ' --config Debug' : ''}`; },
  }],
  debug: {
    exts: ['.c', '.cc', '.cpp', '.cxx'], tool: 'lldb', label: 'C and C++ (lldb-dap)',
    gate: ({ file, args = [], cwd = '.', program }) => {
      if (program) return [quote(program), ...args.map(quote)].join(' ');
      const top = cmakeTop(cwd, file) || path.resolve(cwd), b = cmakeBuildDir(top);
      if (b) return `cmake --build ${quote(rel(cwd, b))}`;
      const nb = quote(rel(cwd, path.join(top, 'build')));
      return `cmake -S ${quote(rel(cwd, top))} -B ${nb} -DCMAKE_BUILD_TYPE=Debug && cmake --build ${nb}`;
    },
    start: async ({ file, args = [], cwd, port, program }) => {
      const built = program ? { program: path.resolve(cwd, program), note: '' } : await cmakeProgram(cwd, file);
      if (!fs.existsSync(built.program)) throw new Error(`${built.program} does not exist: build it first`);
      const plan = await lldbPlan({ program: built.program, args, cwd, port });
      return { ...plan, note: [built.note, pdbNote(built.program)].filter(Boolean).join(' ') };
    },
  },
  notes: (have) => `configure and build with cmake -S . -B build, then cmake --build build; run the program from build/ (build/Debug/ with Visual Studio). Tests: ctest --test-dir build --output-on-failure. For a crash, build with debug info (the default Debug configuration) and read the first frame in your own code. The debug tool builds the CMake target a .c/.cpp file belongs to and runs it under lldb-dap; with no breakpoints it stops where the program crashes, with the stack and variables.${WIN ? ' Windows can also keep a crash dump: the LocalDumps key under HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting (DumpFolder, DumpType 2) is a setting for the whole computer, so ask the user first; open the .dmp with lldb <program> -c <dump>.' : ''}${have.has('lldb') ? '' : ' lldb-dap is not installed: it comes with LLVM 18 or later; installing it is for the whole computer, so ask the user.'}`,
  test: { needs: ['cmake'] },
};
