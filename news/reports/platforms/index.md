---
title: Platforms: every kind of app QuorX builds, and how sure we are
date: 2026-10-20
summary: The 16 platform packs as one matrix: what each detects, checks, runs, debugs and explains, rated proven, tested, logic tested or not yet by the evidence behind it.
tags: platforms, tests
order: 3
---

QuorX builds web apps, and much more: command-line programs, desktop apps, phone apps, games and installers. Each
kind of app is a **platform pack**, one file in `server/packs/` that tells QuorX how to find the toolchain, check the
work, run and drive the app, debug it, and explain it to the agent. This page lists every pack and how much evidence
stands behind it.

## What a pack does

```flow
{ "nodes": [
  { "id": "detect", "title": "Detect", "sub": "the toolchain, and that it really builds", "cap": "Detect: QuorX finds the toolchain and checks it really builds here (Rust without a linker is installed but can't build), and offers to install it." },
  { "id": "check", "title": "Check", "sub": "compile what the reply changed", "cap": "Check: before the final reply, QuorX compiles what the reply changed and sends the work back if it broke." },
  { "id": "run", "title": "Run and drive", "sub": "use it like a person", "cap": "Run and drive: QuorX runs the program and uses it: types into prompts, clicks windows, taps a phone screen." },
  { "id": "debug", "title": "Debug", "sub": "breakpoints, variables, the stack", "cap": "Debug: QuorX stops at breakpoints and reads variables and the stack through a real debugger." },
  { "id": "explain", "title": "Explain", "sub": "how it is built, tested, run", "cap": "Explain: the agent is told how this kind of project is built, tested and run, and where its crashes are reported." }
] }
```

A pack doesn't need all five on day one. Where a cell in the matrix says "–", that part isn't there yet, or the
platform doesn't have one (an installer has nothing to debug).

## How sure we are

Each pack is rated by the evidence behind it, not by how much code it has:

- **Proven**: an agent built and ran a real app with it in a QuorX chat.
- **Tested**: its self-tests passed on a real machine with the toolchain installed.
- **Logic tested**: the pack is written and its logic (parsers, rules, command lines) passes its tests, but nobody
  has run it against the real toolchain yet.
- **Not yet**: planned, not started.

```stat
{"src":"packs.json","path":"stats"}
```

```chart
{"src":"packs.json","path":"levelChart"}
```

No pack is rated proven yet. That level needs a recorded chat in which an agent builds and runs a real app with the
pack, and the UI test (`npm run test:ui`) is how such a run gets recorded. The tested packs passed their self-tests on
the machines where their pull requests were tested; the evidence column names the run.

## The matrix

Filter by level to see what is ready. Each row comes from the pack registry (`server/packs/`), with the evidence for
its level.

```matrix
{"src":"packs.json","path":"matrix"}
```

## Help test a pack

The fastest way to move a pack from logic tested to tested is to run its self-test on a computer that has the
toolchain. No key is needed and nothing is spent: the self-tests drive QuorX's own checks, debugger and builds
directly, and skip whatever the computer doesn't have.

```terminal
{"title":"Test the packs a computer can run","lines":[{"cmd":"npm run test:packs"},{"cmd":"npm run test:packs -- --pack dotnet"},{"out":"Report: pack-test-report.md"}]}
```

Paste `pack-test-report.md` into the pack's pull request or a "Pack test report" issue. Some packs need a little
setup first: `QX_PYTHON` pointing at a Python with debugpy and pyflakes for the Python debugger, `QX_ELECTRON` at an
Electron binary (or `npm run desktop:setup` once), and a running emulator or a virtual device for Android. The full
guide is in `docs/platform-packs.md`.
