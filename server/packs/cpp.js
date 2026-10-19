// C and C++: CMake projects with the Microsoft compiler, GCC or Clang.
import fs from 'node:fs';
import path from 'node:path';
import { WIN, run, VS_BUILD_TOOLS } from './_lib.js';

// Visual Studio's compiler is not on PATH; vswhere says whether one with the C++ tools is installed.
async function msvc() {
  if (!WIN) return null;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const o = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion']);
  return o && /^\d+\.\d+/.test(o) ? o.split(/\r?\n/)[0] : null;
}

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
  ],
  markers: [/^CMakeLists\.txt$/, /\.vcxproj$/i, /^meson\.build$/],
  notes: () => 'configure and build with cmake -S . -B build, then cmake --build build; run the program from build/. For a crash, build with debug info (the default Debug configuration) and read the first frame in your own code.',
  test: { needs: ['cmake'] },
};
