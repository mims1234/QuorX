---
title: Installed is not working
date: 2026-10-20
summary: A PC can have Rust and still be unable to build a Rust program. Here is what an agent did when it found that out halfway through a task, and what QuorX checks now before the agent starts.
tags: platforms, toolchains, research
---

You ask an agent to write a small Rust program, build it and run it. The computer has Rust: `cargo --version` answers, `rustc --version` answers. The agent writes the code, runs `cargo build`, and gets this:

```terminal
{
  "title": "UI test, 20 Oct 01:23 IST: the first build (from the run's log)",
  "lines": [
    { "cmd": "cargo build 2>&1 | Select-Object -Last 30" },
    { "out": "   Compiling wc-lite v0.1.0" },
    { "out": "error: linker `link.exe` not found" },
    { "out": "  |" },
    { "out": "  = note: program not found" },
    { "out": "note: the msvc targets depend on the msvc linker but `link.exe` was not found" },
    { "out": "note: please ensure that Visual Studio 2017 or later, or Build Tools for Visual Studio were installed with the Visual C++ option" },
    { "out": "note: VS Code is a different product, and is not sufficient" },
    { "out": "error: could not compile `wc-lite` (bin \"wc-lite\") due to 1 previous error" }
  ]
}
```

Rust compiles your code itself, but on Windows it hands the last step, linking, to Microsoft's linker. That linker comes with Visual Studio or its Build Tools, and only when the C++ part is ticked. A computer can have a complete, current Rust install and no linker at all. The Windows PC the runs below come from was exactly that computer.

This article is about that gap between "the tool is installed" and "the tool can do the job", what it costs an agent to find the gap by itself, and what QuorX does about it now.

## What the agent did without help

QuorX has a UI test (`npm run test:ui`) that drives the desktop app like a person would. One of its scenarios asks the agent for exactly this task: a Rust program called `wc-lite` that counts lines, words and bytes, built and then run on its own `Cargo.toml`. The test answers each approval card like a careful user: it allows builds and reads, and refuses installs for the whole computer.

On 20 October at 00:55 IST, before QuorX checked toolchains by building anything, the agent (DeepSeek V4.1 Flash) hit the linker error on its first build and then went looking for a way around it. This is what it ran, from the run's own log:

```terminal
{ "src": "hunt.json" }
```

Eleven commands in all. Some of them are reasonable: look for Visual Studio, look for MinGW, check which toolchain is active. Two of them show how a search like this goes wrong.

- **It asked for an install that changes the whole computer.** `rustup target add x86_64-pc-windows-gnu` downloads a second Rust target into your profile. At the time the rules filed it as an install without marking it as one for the whole computer, so the card looked like an ordinary step. While it ran, rustup unpacked and deleted 25 files in its own temp folder within 3 seconds, and QuorX's tripwire stopped it. That was a false alarm, and it is part of the story in [Stop means stop](articles/stop-means-stop).
- **It found the wrong `link.exe`.** Git for Windows ships a `link.exe` in `C:\Program Files\Git\usr\bin`. It is the Unix `link` command, which makes hard links between files. It has nothing to do with linking programs. An agent that sees "FOUND link.exe" and puts that folder first on its PATH has made the problem harder to read.

The agent did end honestly: its last plan item says the build is blocked on the missing linker. The test still failed, because the test asked for a built program and there wasn't one. The run took 140 seconds and $0.0045, according to its line in the test's `logs/runs.jsonl`.

## Why an agent can't skip this check

A person who sets up their own PC knows what they installed. An agent arrives cold. It has two cheap ways to learn what a computer has, and both mislead in the same direction:

1. **Version commands.** `cargo --version` proves cargo starts. It says nothing about the linker, the SDK, a licence that hasn't been accepted, or a workload that is half installed.
2. **Its own training.** "Rust on Windows needs the MSVC Build Tools" is common knowledge. Whether this computer has them is not.

So the agent finds out the expensive way: by trying to build, failing, and then searching. Each search is a command the user has to read on an approval card. Each guess risks an install the user didn't ask for. The longer the hunt, the more likely the agent settles on a workaround, such as a different toolchain or a wrapper script, which leaves the project in a state the user didn't choose.

There is a second reason to check up front. When the agent knows from the start, it can tell you before it writes any code, and you can choose: install the Build Tools, accept a checked but unbuilt crate, or use a different language.

## What QuorX does now

QuorX now checks Rust by building a tiny program. The Rust pack (`server/packs/rust.js`) writes `fn main() {}` to a temporary folder, runs `rustc` on it, and looks for the resulting `main.exe`. If there is no program and the output mentions the linker, the toolchain is marked "installed, but it can't build programs here", with the reason.

```flow
{
  "nodes": [
    { "id": "probe", "title": "Find it", "sub": "cargo --version", "cap": "QuorX runs the toolchain's version command with a short time limit. An answer means it is installed." },
    { "id": "build", "title": "Build something tiny", "sub": "fn main() {} → main.exe", "new": true, "cap": "In a temporary folder, rustc builds an empty program. This is the step that needs the linker." },
    { "id": "judge", "title": "Did a program appear?", "sub": "works / can't build", "new": true, "cap": "No main.exe and a mention of link.exe means 'no C linker'. Any other failure is reported with its first error line." },
    { "id": "tell", "title": "Tell the agent and you", "sub": "agent notes · Setup check", "new": true, "cap": "The agent's notes say Rust can't build programs here, what still works (cargo check), and to tell you before trying. ⚙ Settings → Setup check shows the same row with a fix." },
    { "id": "fix", "title": "Offer the fix", "sub": "Build Tools with C++", "cap": "The Setup check installs the Build Tools with the C++ workload. A plain install has no linker, so the C++ part is included." },
    { "id": "again", "title": "Look again", "sub": "every minute", "new": true, "cap": "A missing or broken toolchain is checked again after a minute, with fresh PATH entries from the registry. An install made mid-chat counts on the next reply, with no restart." }
  ],
  "loops": [{ "from": "again", "to": "probe", "label": "until it works" }]
}
```

The result goes two places.

- **Into the agent's notes for every reply.** For a broken toolchain the note reads, in part: *"Rust (cargo): no C linker … Checking code still works (cargo check …), but building or running a program won't: before you try, tell the user."* It then lists the options in order: install the Build Tools from the Setup check, let the agent run the Build Tools install (which asks you first and shows Windows' admin prompt), use the GNU toolchain for this folder only, or stop at a checked crate.
- **Into ⚙ Settings → Setup check,** where the Rust row says what is wrong and offers the install, with the C++ workload included.

Here is the same task, before and after the check, from the two UI test runs on this PC:

```compare
{
  "prompt": "The same request, on the same PC with Rust and no linker",
  "options": [
    {
      "label": "00:55 IST, no build check",
      "steps": [
        { "title": "Writes the crate", "text": "Cargo.toml and src/main.rs, no extra crates." },
        { "title": "Builds, and the linker is missing", "text": "The first `cargo build` fails at link.exe.", "bad": true },
        { "title": "Searches the disk", "text": "Visual Studio folders, Windows Kits, MinGW, ten candidate folders for any linker.", "bad": true },
        { "title": "Asks for a new Rust target", "text": "`rustup target add x86_64-pc-windows-gnu`, filed as a plain install. The tripwire stopped it.", "bad": true },
        { "title": "Finds Git's link.exe", "text": "A file-linking tool with the same name as the C linker.", "bad": true },
        { "title": "Stops at a checked crate", "text": "`cargo check` passes; the plan's last item is marked blocked." }
      ],
      "verdict": { "title": "11 commands, no program, test failed", "text": "17 of 18 test steps passed. The agent found the truth, after a search the user had to approve card by card." }
    },
    {
      "label": "01:23 IST, with the build check",
      "steps": [
        { "title": "Knows before it starts", "text": "Its plan, 14 seconds in: \"this machine has Rust but no C linker (no MSVC Build Tools), so linking may fail\"." },
        { "title": "Writes the crate", "text": "Same program, std only." },
        { "title": "Tries once, then tries rust-lld", "text": "Two build attempts with the linker bundled in Rust. Both fail.", "bad": true },
        { "title": "Asks for the GNU target", "text": "This time the card says it installs for the whole computer. The test refuses it." },
        { "title": "Checks its counting another way", "text": "A Python script ports its counting code and compares it with a second implementation on tricky inputs." },
        { "title": "Says so plainly", "text": "\"The crate is written, but I could not build or run it here: this machine has Rust with no C linker.\"" }
      ],
      "verdict": { "title": "7 commands, honest reply, test passed", "text": "18 of 18 steps. The pass condition on a PC like this is the agent saying it can't link, with the reason." }
    }
  ]
}
```

Be careful with the comparison. The runs cost about the same ($0.0045 and $0.0043) and took about the same time (140 and 144 seconds). The agent still tried to build, twice more than it needed to. What changed is where it started from and what you saw: one install card instead of a disk search, and that card named the install for what it was.

## How the program finally got built

A QuorX chat on a Windows PC met the same problem, with a user who wanted a working program. Rust 1.97.1 compiled, and there was no `link.exe`, `gcc` or `clang`. The chat used DeepSeek V4.1 Flash and took three replies. The numbers are from that chat's run logs:

| Reply | What happened | Model calls | Commands | Minutes | Cost |
|---|---|---|---|---|---|
| 1 | Checked the toolchain, found no C linker, wrote the crate, ran `cargo check`, then asked how to get a linker: the GNU toolchain through rustup, the Build Tools with C++, or "I'll install it myself" | 15 | 6 | 1.3 | $0.0092 |
| 2 | Installed the GNU toolchain (`rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal`) as a background job the user approved, and pinned it to this folder only with a `rust-toolchain.toml` | 28 | 10 | 6.7 | $0.0202 |
| 3 | `cargo build --release`, the tests, and a run on its own files | 20 | 6 | 5.6 | $0.0099 |
| **All** | | **63** | **22** | **13.6** | **$0.0393** |

The GNU toolchain is the third option QuorX's notes offer for a PC like this: it makes this one folder build and leaves the rest of the computer as it was. It doesn't fit every project. Tauri's dependencies, for one, need an assembler that the GNU toolchain doesn't ship, so for those the notes offer only the Build Tools.

The program it built is `target\release\wc-lite.exe`, about 1.2 MB. Run outside QuorX afterwards, in the chat's folder (named Rust-Test), it prints:

```terminal
{ "src": "wc-lite.json" }
```

The build output itself isn't in the run logs we have, so it isn't shown here. The program exists and runs, and that is the evidence.

```callout
{ "tone": "warn", "title": "One thing in that chat went wrong", "text": "The agent ran its commands through a small script it wrote, .quorx/scratch/run.mjs, including the rustup install. So the card the user approved in reply 2 said node. Nothing on it said a Rust toolchain would be installed for the whole computer. QuorX now reads such a script first and shows the install on the card." }
```

That part of the story is in [Agents route around guardrails](articles/agents-route-around-guardrails).

## Rust was only the first

The same idea now runs through QuorX's platform packs. A pack's toolchain can carry a `works()` check that does the smallest real job; a version query alone proves too little. At the merge of the pack framework (PR #3) one toolchain had such a check: Rust. Today ten of the 33 toolchains the packs know have one:

| Toolchain | What "works" means |
|---|---|
| Rust | builds an empty program (needs a C linker) |
| .NET SDK | builds something: a broken workload or a `global.json` pinning a missing SDK only shows up then |
| Java (JDK) | compiles and runs a tiny program: a Java runtime without the JDK has no `javac` |
| Tauri CLI | works only where Rust can link, so it asks the Rust check |
| Godot 4 | starts and parses a script (a Godot 3 editor fails here) |
| WiX Toolset | builds a tiny package (WiX 7 refuses until its licence is accepted) |
| Xcode | is ready: the right developer folder, licence accepted, first launch done |
| Android SDK | has a platform and build-tools installed |
| Android emulator | has at least one virtual device to start |
| LLDB (lldb-dap) | the debug adapter starts and answers `--help` |

Counts are from `allToolchains()` in `server/packs/index.js` at commit 0174105 (the PR #3 merge) and at today's main.

```callout
{ "tone": "warn", "title": "What this doesn't catch", "text": "A works() check proves the smallest job, once, with QuorX's environment. A project can still need things the tiny program doesn't: a specific SDK version, a native library, a network registry. And a check that passes is cached for 10 minutes; one that fails is looked at again after a minute. If you change your setup in between, Check again in the Setup check looks at once." }
```

## What to take from this

If you build agents: a version string is a weak signal. Prove the toolchain does the smallest real job, tell the model the result before it plans, and tell it what still works, so it has a useful fallback instead of a search.

If you use QuorX: open ⚙ Settings → Setup check once on a new PC. A toolchain marked "can't build here" will cost you a confused first reply if you don't fix it first.
