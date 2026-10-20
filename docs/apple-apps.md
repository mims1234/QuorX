# Apple apps

QuorX can help build and debug iPhone, iPad and Mac apps (SwiftUI, UIKit, AppKit) and Swift packages. They need a
Mac: Xcode, the iOS Simulator and Apple's signing only run on macOS, and QuorX's safety layer runs there too (see
[QuorX on macOS and Linux](macos-and-linux.md)). The pack is `server/packs/apple.js`; its parsers are in
`server/packs/_apple.js`.

## What the pack does

| | What QuorX does |
|---|---|
| **Detect** | Xcode's version, and whether it is ready: the active developer folder is Xcode (not only the Command Line Tools), its license is accepted, its first launch is done. Each fix needs your password, so the agent tells you the line to run in a terminal tab. Also the simulators (`xcrun simctl list`), Swift, lldb-dap, and idb if you have it. |
| **Check** | Before the final reply, changed `.swift`, `.m`, `.mm` and `.h` files are built: `xcodebuild -quiet` of the project's scheme for a generic simulator (or the Mac), with signing off, so no device or certificate is needed; `swift build` for Swift packages. Errors come back with their file and line. |
| **Run and drive** | The notes give the agent the exact commands for this project: build with `-derivedDataPath build` (so the app's path is known), `simctl boot`, `install`, `launch --console-pty` (its `print` output in a background job), `io screenshot`, `log stream` for the app's subsystem. The agent starts the Simulator app by its own program, so the desktop tool can read the app's controls and press them; Mac apps are started the same way. |
| **Crashes** | When a run crashes, or the agent reads a `.ips` report, QuorX puts a summary above the output: the exception, the message (Swift's `Fatal error: …`, an uncaught Objective-C exception), where it was thrown, and the crashing thread's frames, with the app's own frames marked. Reports are read from `~/Library/Logs/DiagnosticReports` and the simulators' folders. |
| **Debug** | `debug start` on a `.swift`, `.m` or `.mm` file builds the app and starts it paused under lldb-dap (from Xcode 16): a Mac app or a Swift package's program is launched; an iPhone or iPad app is installed in a simulator, started waiting for the debugger, and lldb-dap attaches to it. |
| **Explain** | Notes on the project's scheme, platform and bundle id, the commands above, and that real devices and the App Store need your Apple ID: the agent doesn't try to set up signing. |

## Rules for Apple's tools

`xcrun` is unwrapped, so the tool it runs is what is judged.

- Just run: `simctl list`, `xcodebuild -list` / `-showBuildSettings`, `simctl spawn booted log stream`, `log show`,
  `plutil -p`, `xcresulttool`, `xcode-select -p`, `security find-identity`.
- Ask until a rule allows them (the panel suggests `xcodebuild*`, `simctl boot*`, `simctl install*`, `simctl launch*`,
  `swift build*` …): builds, tests, booting, installing and launching.
- Always ask you: `simctl erase` / `delete` (they delete a simulator or its data), `simctl spawn` of anything but
  `log`, `xcodebuild -downloadPlatform`, `swift package update`, `notarytool` and `altool` (they send the app to
  Apple), `devicectl` on a real device.
- Never: `log erase`, `log config`, and `sudo` for anything but an install.
- A screenshot (`simctl io … screenshot`) is a write: into the project or `.quorx/scratch` it runs; into your profile
  folder it is refused.

## Testing it

You need a Mac with Xcode 16 or later (for lldb-dap), its license accepted, and at least one iOS simulator.

```bash
npm install
npm run test:packs -- --pack apple --pack system
```

The self-test checks that Xcode and a simulator are found, that `swift build` catches an error in a changed file and
names it, that a small program builds and runs, that a real crash report is found and summed up (the first frame in
the program is `main.swift:3`), and that lldb-dap stops at a breakpoint and reads a variable. On other systems only the
logic runs (the simulator list, error lines, crash reports, schemes, notes and rules, on fixtures).

Then try it for real in QuorX: ask the agent to "make a SwiftUI counter app for iPhone, run it in the simulator and tap
the button three times", and to "make the app crash when the count reaches 5, then find out why". Paste
`pack-test-report.md` and what happened into the pull request.

## Not there yet

- Real devices (they need your Apple ID and a development certificate), TestFlight and App Store uploads.
- UI tests through `xcodebuild test` run, but their results are read from the output, not the `.xcresult` bundle.
- visionOS, tvOS and watchOS apps build and run in their simulators the same way, but nobody has tested them yet.
