// Rust: command-line programs, libraries, and the Rust half of Tauri apps.
import fs from 'node:fs';
import path from 'node:path';
import { WIN, MAC, run, tempDir, rm, VS_LINE } from './_lib.js';

// Installed is not the same as working: Rust needs a C linker to make a program (on Windows, Visual Studio's C++
// Build Tools), and a PC can have cargo without one. So Rust is checked by building a tiny program. { ok, why }.
async function rustBuilds() {
  const dir = tempDir('rustcheck');
  try {
    fs.writeFileSync(path.join(dir, 'main.rs'), 'fn main() {}\n');
    const out = await run('rustc', ['main.rs', '-o', WIN ? 'main.exe' : 'main'], { cwd: dir, timeout: 60000 });
    if (fs.existsSync(path.join(dir, WIN ? 'main.exe' : 'main'))) return { ok: true, why: '' };
    const linker = /link(er|\.exe)|cc` not found|msvc/i.test(out || '');
    return { ok: false, why: linker ? `no C linker: Rust needs ${WIN ? 'the Visual Studio Build Tools with C++' : MAC ? 'the Xcode command line tools' : 'a C toolchain (build-essential)'} to make programs` : `rustc could not build a test program (${String(out || 'no output').split(/\r?\n/).find((l) => /error/i.test(l)) || 'unknown error'})` };
  } finally { rm(dir); }
}

export default {
  id: 'rust',
  label: 'Rust',
  summary: 'Command-line programs, libraries and services',
  toolchains: [{
    id: 'rust', label: 'Rust (cargo)', for: 'Rust programs, CLIs and Tauri apps', probe: ['cargo', ['--version']], re: /cargo (\d+\.\d+\.\d+)/,
    works: rustBuilds, fixWith: 'msvc', winget: 'Rustlang.Rustup', brew: 'rustup-init', url: 'https://rustup.rs',
    brokenHint: () => (WIN
      ? `Offer, in this order: they install the Build Tools with C++ from ⚙ Settings → Setup check (the usual Windows setup, which Tauri and C/C++ need too); you run \`${VS_LINE}\` for them (it asks them first, shows Windows' admin prompt and takes 5–15 minutes; without the --override part it installs no linker); or, for a small program, the GNU toolchain for this folder only (rustup toolchain install stable-x86_64-pc-windows-gnu, then a rust-toolchain.toml); or you stop at a checked crate.`
      : MAC ? 'Offer to run xcode-select --install (the user confirms Apple\'s dialog), or stop at a checked crate.'
        : 'Offer to install build-essential (or the distribution\'s C toolchain), or stop at a checked crate.'),
    checkStillWorks: 'cargo check, tests that don\'t link',
  }],
  markers: [/^Cargo\.toml$/],
  checks: [{ id: 'rust', tool: 'rust', ext: /\.rs$/i, marker: (d) => fs.existsSync(path.join(d, 'Cargo.toml')), cmd: 'cargo check --quiet --message-format short' }],
  notes: () => 'build with cargo build (cargo build --release for a program to hand over), test with cargo test, run with cargo run -- <args>. Run commands directly with the shell tool, never through a wrapper script. For a panic, run it again with RUST_BACKTRACE=1 to see where. A program that reads a terminal (prompts, a TUI) goes in the terminal tool.',
  test: { needs: ['rust'] },
};
