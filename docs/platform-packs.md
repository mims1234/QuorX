# Platform packs

QuorX builds web apps, and it can build much more: command-line programs, desktop apps, phone apps, games. Each kind
of app beyond the web is a **platform pack**: one file in `server/packs/` that tells QuorX everything it needs to help
someone build that kind of app, and help them debug it when it goes wrong.

This page says what "support" means, how a pack is written, how to test one on your own computer, and which packs are
planned. You don't need an OpenRouter key to test a pack.

## What "supported" means

A platform is supported when QuorX can do all five of these for it:

| | What QuorX does | Where it lives in a pack |
|---|---|---|
| **1. Detect** | Knows whether the toolchain is installed *and really builds here* (Rust without a linker is installed but can't build), and offers to install it | `toolchains` |
| **2. Check** | Before the final reply, compiles what the reply changed and sends the work back if it broke | `checks` |
| **3. Run and drive** | Runs the program and uses it like a person: types into prompts, clicks windows, taps a phone screen | `notes`, plus QuorX's tools (`terminal`, `desktop`, `android`, `browser`) |
| **4. Debug** | Stops at breakpoints, reads variables and the stack, through a debugger | `debug` |
| **5. Explain** | Tells the agent how this kind of project is built, tested and run, and where its crashes are reported | `notes` |

A pack doesn't need all five on day one. The QuorX Build Atlas rates each platform by the evidence behind it:
**proven** (built and run in a real chat), **tested** (self-tests pass on a real machine), **wired** (the pack exists,
nobody has tested it with the toolchain yet), **next** (not started).

## Writing a pack

A pack is a default export from `server/packs/<id>.js`. QuorX loads every file in that folder by itself, so a new
platform is a new file, not edits across the code. A pack that fails to load is skipped and named in the console.

```js
export default {
  id: 'dotnet',                         // also the file name: dotnet.js
  label: '.NET (C#)',
  summary: 'Console, WPF, WinForms, MAUI and ASP.NET apps',
  hosts: ['win32', 'darwin', 'linux'],  // where it works (default: everywhere)

  // 1. Detect: a probe command and a version pattern (or detect() for anything else), whether it really works,
  //    and how to install it. winget ids power the Setup check's Install button on Windows; brew and apt are shown
  //    elsewhere.
  toolchains: [{ id: 'dotnet', label: '.NET SDK', for: 'C#: console apps, WPF, WinForms', probe: ['dotnet', ['--version']],
    re: /^(\d+\.\d+\.\d+)/m, winget: 'Microsoft.DotNet.SDK.8', brew: 'dotnet-sdk', url: 'https://dot.net',
    // install: 'go install …'           // a command line, for tools that come without winget (shown by the Setup check)
    works: async () => ({ ok: true, why: '' }),   // optional: build something tiny
    brokenHint: 'what to offer the user when it is installed but cannot build', fixWith: 'msvc' }],

  // What marks a folder as this kind of project (file names, one folder deep), or detect(root) for deeper ones.
  markers: [/\.(csproj|sln)$/i],

  // 2. Check: runs once per project folder the reply changed; only errors in changed files count. `cmd` can also be
  //    a function of that folder (CMake's check builds whichever build folder the project already has).
  checks: [{ id: 'dotnet', tool: 'dotnet', ext: /\.(cs|xaml)$/i, marker: (dir) => hasFile(dir, /\.csproj$/i),
    cmd: 'dotnet build --nologo -v q -clp:NoSummary', errors: /\berror\b/i,
    tidy: (line, dir) => line }],                      // optional: an error line as the agent should read it

  // 3. Run: a short summary put above a command's output (failed tests, with their file and line).
  summaries: [{ cmd: /^\s*dotnet\s+test\b/i, summarize: (out) => 'dotnet test: 1 failed, 7 passed …' }],

  // 4. Debug: a Debug Adapter Protocol server listening on `port`. QuorX connects, sets breakpoints, and sends
  //    configurationDone on the first continue, so the program doesn't run a line before the breakpoints are in.
  //    start() may be async: for compiled languages it builds the program and finds it, and `program` is set when
  //    the agent names the built program itself. What the program prints comes back with the next state. Optional
  //    plan fields: initWait (ms until the adapter is ready, for adapters that build first), evalContext ('watch'
  //    for lldb), note (a sentence for the agent, such as "no debug info").
  debug: {
    exts: ['.cs'], label: 'C# (netcoredbg)',
    gate: ({ file, args, cwd, program }) => `dotnet run`, // the command the rules and the approval card judge
    start: async ({ file, args, cwd, port, program }) => ({
      line: `netcoredbg --interpreter=vscode --server=${port}`,
      adapterID: 'coreclr', request: 'launch', args: { program: 'bin/Debug/net8.0/app.dll', cwd, stopAtEntry: false },
      exceptions: ['user-unhandled'],                  // optional: the adapter's filters for stopping at exceptions
      missing: 'netcoredbg is not installed: …',
    }),
  },

  // 5. Explain: short, specific, for the agent. Only sent when the project is this kind.
  notes: (have) => 'build with dotnet build, run with dotnet run, test with dotnet test. …',

  test: { needs: ['dotnet'] },          // the self-test runs when these toolchains are installed
};
```

Rules of thumb:

- **Run commands directly.** Notes should never suggest wrapper scripts; QuorX's rules judge the real command.
- **Installs for the whole computer** (winget, brew, rustup, sdkmanager) always ask the user, and run in the
  background so they are never cut off half-way.
- **Debuggers start paused.** The agent only gets the debugger after plain debugging has failed twice.
- **Keep notes short.** They go into the agent's instructions for every reply in that kind of project.

## Debugging compiled programs

The debug tool starts from a source file, which picks the language. For compiled languages QuorX then builds the
program and finds it by itself, the way each toolchain describes its own output:

| Language | Debugger | What runs |
|---|---|---|
| Go | Delve (`dlv dap`) | The package of the `.go` file (Delve builds it with debug info); a `_test.go` file runs its package's tests |
| Rust | CodeLLDB when it is installed, else lldb-dap | `cargo build`, then the binary cargo reports for that file (`src/main.rs`, `src/bin/x.rs`), else the package's own binary |
| C and C++ | lldb-dap (LLVM 18 and later; lldb-vscode in older builds) | `cmake --build` on the project's build folder, then the executable CMake's file API lists for that source file |

When QuorX can't tell (two programs share a file, or there is no CMake project), the agent passes `program`, the
built program to run. Delve installs with `go install github.com/go-delve/delve/cmd/dlv@latest`, which puts it in
the user's Go bin folder for every project, so the agent asks first; lldb-dap comes with LLVM (`winget install
LLVM.LLVM`, `brew install llvm`, `apt install lldb`).

Every debugger stops by itself where the program fails: Delve on an unrecovered panic, LLDB on a crash, and in Rust
on every panic (a breakpoint on std's `rust_panic`). For Rust, lldb-dap loads the formatters that ship with the
toolchain (`lib/rustlib/etc`), so `String`, `Vec` and `Option` read as values.

**Windows limits.** A program built by MSVC (or clang-cl) keeps its debug info in a `.pdb`. LLDB reads it, so
breakpoints, the stack and plain variables work, but STL containers and Rust's `String` and `Vec` can show raw fields.
GCC, Clang and Rust's GNU toolchain write DWARF, which LLDB reads fully. MinGW's gdb speaks the Debug Adapter Protocol
only over its own input and output (`gdb -i dap`), which QuorX's debugger doesn't drive yet, so lldb-dap is the
debugger for MinGW builds too. For a crash outside the debugger, Windows Error Reporting can keep a dump (the
`LocalDumps` key, a setting for the whole computer, so the agent asks first); `lldb <program> -c <dump>` opens it.

## Testing a pack (no key needed)

Each pack has a self-test in `server/packs/tests/<id>.test.mjs`. It drives QuorX's real code (the compiler checks,
the debugger, a real build) with no model, and skips itself when the toolchain is missing.

```bash
npm run test:packs
```

That runs every self-test your computer can run and writes `pack-test-report.md`: your OS, the toolchains found, and
each pack's result. To test one pack: `npm run test:packs -- --pack dotnet`. To include the Python debugger, set
`QX_PYTHON` to a Python that has debugpy.

**Have a toolchain we can't test?** Run the kit and paste `pack-test-report.md` into the pack's pull request, or open
a "Pack test report" issue. A pack moves from *wired* to *tested* once someone with the toolchain reports a pass, and
to *proven* once an agent builds and runs a real app with it in QuorX (the UI test, `npm run test:ui`, can show that).

A good self-test checks, at least:

1. the toolchain is found and its version read;
2. the compiler check catches an error in a changed file (and names that file);
3. a small program builds and runs;
4. the debugger stops at a breakpoint and reads a variable (once the pack has `debug`);
5. for apps with a window or a screen: the agent's tool can read it and press a button.

## Planned packs

Each is its own pull request, so people with that toolchain can test it on its own.

| Pull request | What it adds | Testers need |
|---|---|---|
| Pack framework and tester kit | This page, the pack loader, generic DAP debugging, `npm run test:packs`; today's languages moved into packs | Node.js |
| Commands hidden in scripts | Scripts that mainly launch other programs are marked "can't be checked"; the agent runs commands directly | Windows |
| .NET | WinForms and WPF apps built and driven; `dotnet test`; debugging with netcoredbg | .NET 8 SDK, netcoredbg |
| Python desktop | tkinter and PyQt windows driven; pytest; debugpy set up in the project's own venv | Python 3 |
| Electron | Apps started with their DevTools port and driven; main-process debugging | Node.js |
| Tauri | Tauri 1 and 2 apps found; `cargo check` in `src-tauri`; `tauri dev` started with WebView2's DevTools port, so the window is read and clicked; panics and capability errors explained (Rust breakpoints come with the C/C++ pack's lldb-dap) | Rust with the MSVC linker (Build Tools with C++), the Tauri CLI, WebView2, Node.js |
| Go, C/C++ and Rust debugging | Delve and lldb-dap debugging; CMake build check; crashes caught under the debugger | Go and Delve, CMake and a C++ compiler, LLVM with lldb-dap, Rust with a linker |
| Java and Kotlin | Gradle and Maven compile checks; JUnit; debugging | A JDK |
| Android and Flutter | Emulator started and driven; Gradle and `flutter analyze` checks; Logcat crashes; Dart debugging | Android SDK, an emulator, Flutter |
| QuorX on macOS | Stop, rules, snapshots and the desktop tool on a Mac (process groups, zsh, Accessibility) | A Mac |
| Apple apps | Xcode builds and tests, the iOS Simulator driven, crash reports read, Swift debugging with lldb-dap | A Mac with Xcode |
| QuorX on Linux, Linux apps | The same safety layer on Linux; GTK and Qt apps driven through AT-SPI | Linux |
| Game engines and installers | Godot and Unity checks and logs; MSIX and WiX packaging | Godot, Unity, WiX |

Apple apps need a Mac: Xcode, the iOS Simulator and Apple's signing only run on macOS. QuorX must run on that Mac too,
which is why "QuorX on macOS" comes first. Both are written so Mac owners can test them with `npm run test:packs`.
