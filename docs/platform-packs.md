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
    works: async () => ({ ok: true, why: '' }),   // optional: build something tiny
    brokenHint: 'what to offer the user when it is installed but cannot build', fixWith: 'msvc' }],

  // What marks a folder as this kind of project (file names, one folder deep), or detect(root) for deeper ones.
  markers: [/\.(csproj|sln)$/i],

  // 2. Check: runs once per project folder the reply changed; only errors in changed files count.
  checks: [{ id: 'dotnet', tool: 'dotnet', ext: /\.(cs|xaml)$/i, marker: (dir) => hasFile(dir, /\.csproj$/i),
    cmd: 'dotnet build --nologo -v q -clp:NoSummary', errors: /\berror\b/i }],
  //    When one fixed command isn't enough: cmd({ dir, files }) gives one or more lines for that folder and its
  //    changed files (or null: the check can't run there), parse(out, { dir, files }) turns the output into
  //    'file:line: message' lines (and runs even when the tool exits 0), and timeout sets a longer limit in ms.

  // 4. Debug: a Debug Adapter Protocol server listening on `port`. QuorX connects, sets breakpoints, and sends
  //    configurationDone on the first continue, so the program doesn't run a line before the breakpoints are in.
  debug: {
    exts: ['.cs'], label: 'C# (netcoredbg)',
    gate: ({ file, args }) => `dotnet run`,            // the command the rules and the approval card judge
    start: ({ file, args, cwd, port }) => ({
      line: `netcoredbg --interpreter=vscode --server=${port}`,
      adapterID: 'coreclr', request: 'launch', args: { program: 'bin/Debug/net8.0/app.dll', cwd, stopAtEntry: false },
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
| Tauri | `cargo tauri` builds; the WebView2 window driven through its DevTools port; Rust debugging | Rust, Build Tools, WebView2 |
| Go and C/C++ | Delve and lldb-dap debugging; CMake build check; crash dumps read | Go, CMake, a C++ compiler, LLVM |
| Java and Kotlin | Gradle and Maven compile checks; JUnit; debugging | A JDK |
| Android and Flutter | Emulator started and driven; Gradle and `flutter analyze` checks; Logcat crashes; Dart debugging | Android SDK, an emulator, Flutter |
| QuorX on macOS | Stop, rules, snapshots and the desktop tool on a Mac (process groups, zsh, Accessibility) | A Mac |
| Apple apps | Xcode builds and tests, the iOS Simulator driven, crash reports read, Swift debugging with lldb-dap | A Mac with Xcode |
| QuorX on Linux, Linux apps | The same safety layer on Linux; GTK and Qt apps driven through AT-SPI | Linux |
| Game engines and installers | Godot script checks and debugging in the running game; Unity batchmode compile check, tests and logs; WiX build check; MSIX packing and test signing | Godot 4; Unity with a license; WiX v4+ or the Windows SDK |

Apple apps need a Mac: Xcode, the iOS Simulator and Apple's signing only run on macOS. QuorX must run on that Mac too,
which is why "QuorX on macOS" comes first. Both are written so Mac owners can test them with `npm run test:packs`.

## Game engines and installers

**Godot 4** (`godot.js`). QuorX finds the editor on PATH, in winget's package folder (winget installs Godot as a
portable zip), in Scoop or Steam, or wherever `QX_GODOT` points. The check parses each changed `.gd` file with
`godot --headless --path . --check-only --script res://<file>.gd`, after `--import` when the project's class list
(`.godot/`) is missing or the reply declared a `class_name`. Debugging runs the editor headless with its Debug Adapter
Protocol server (`godot --editor --headless --dap-port <port>`); the editor starts the game in its window once the
breakpoints are set, so breakpoints, the stack, locals and expressions work in the running game. Logs are in
`user://logs/godot.log`.

**Unity** (`unity.js`). QuorX lists the editors Unity Hub installed and picks the one in
`ProjectSettings/ProjectVersion.txt`. The check compiles with `Unity.exe -batchmode -nographics -quit -projectPath .
-logFile -` and reads the `CSxxxx` errors. It runs only once the project has been imported (the first import can take
10 minutes or more) and while the project isn't open in the editor. Batchmode needs a Unity license. Tests run with
`-runTests`, which writes an NUnit XML file. Unity's own debugger is not one the debug tool can drive, so debugging
here means `Debug.Log` and the editor's and the game's logs.

**Windows installers** (`installers.js`). WiX v4 or later (`wix build`), and MakeAppx and SignTool from the Windows
SDK or its `Microsoft.Windows.SDK.BuildTools` NuGet package. The check builds changed `.wxs` files into a throwaway
MSI (a `.wixproj` builds with `dotnet build`). WiX 7 refuses to build until the user accepts its Open Source
Maintenance Fee EULA: QuorX says so and leaves accepting it to the user. Signing is only ever with a test certificate
made for the purpose. Installing changes the whole computer, so it always asks first.
