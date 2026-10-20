---
title: Every block, one page
date: 2026-10-20
summary: A draft that uses each part of the News format once, so the renderer can be checked. Its numbers come from the platform work of 19–20 October.
tags: research, tests
version: 0.2.0
---

This page is a **draft**: its folder starts with `_`, so News doesn't list it. Open it at `#news/articles/_sample`.
Writers can copy any part of it; the format is in *docs/news-format.md*, and `npm run news:check` checks a page
before it ships.

## Text

Paragraphs, **bold**, *italic*, `code`, [a link to the web](https://openrouter.ai), a link to
[another News page](articles/_sample), and [a link inside this page](#numbers). Anything that looks like markup is
shown as text: <b>this stays plain</b>, and so does <script>this</script>.

- A list item
- Another, with `code`
  - and a nested one
- A third

1. First
2. Second

> A block quote: what a reader should keep from a section.
> It can run over **two lines**.

| What | Before | Now |
|---|---:|---:|
| Toolchains QuorX detects | 15 | 33 |
| Compiler checks before a reply | 4 | 13 |
| Debugger languages | 2 | 9 |

```powershell
npm run news:check
```

![A picture from this folder: two boxes joined by an arrow](diagram.svg)

---

## Numbers

```stat
{ "items": [
  { "label": "Platform packs", "from": 0, "to": 16 },
  { "label": "Toolchains QuorX detects", "from": 15, "to": 33 },
  { "label": "Automated tests", "from": 129, "to": 176 },
  { "label": "Debugger languages", "from": 2, "to": 9 }
] }
```

```chart
{ "src": "data.json", "path": "tests", "title": "Automated tests after each step" }
```

```chart
{ "type": "bar", "title": "Lines added by each pack pull request", "unit": "lines", "x": ["#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11", "#12", "#13", "#14"], "series": [{ "name": "Lines added", "values": [462, 471, 272, 682, 346, 854, 1005, 1433, 1601, 741, 568] }] }
```

```chart
{ "src": "data.json", "path": "reach" }
```

## How it went

```timeline
{ "items": [
  { "when": "19 Oct · 17:53", "title": "Safety layer", "text": "A real shell with rules, Windows jobs, snapshots, deciders and a tripwire.", "tag": "PR 1" },
  { "when": "20 Oct · 01:59", "title": "Running tab", "text": "Everything that runs in a project in one place, with Stop.", "tag": "PR 2" },
  { "when": "20 Oct · 04:34", "title": "Pack framework", "text": "One file per kind of app, and a tester kit anyone can run.", "tag": "PR 3" },
  { "when": "20 Oct · 06:04", "title": "Ten packs at once", "text": "Ten sessions side by side, each reviewed and tested before it merged.", "tag": "PRs 4–14" }
] }
```

```lanes
{ "start": "04:30", "end": "06:10", "rows": [
  { "label": "#4 .NET pack", "build": ["04:36", "04:51"], "review": ["04:51", "05:04"], "detail": "WinForms and WPF apps built and driven, and netcoredbg debugging." },
  { "label": "#5 Scripts guard", "build": ["04:36", "04:52"], "review": ["04:52", "05:13"], "back": 1, "detail": "Sent back once to also read package.json scripts behind npm run." },
  { "label": "#6 Tauri pack", "build": ["04:36", "04:56"], "review": ["04:56", "05:04"] },
  { "label": "#10 Android and Flutter", "build": ["04:36", "05:05"], "review": ["05:05", "05:48"], "back": 2, "detail": "Emulators booted and driven, crashes summed up, Gradle and flutter analyze checks." },
  { "label": "#11 Java and Kotlin", "build": ["04:36", "05:07"], "review": ["05:07", "06:04"], "back": 2, "detail": "Compile checks, JUnit summaries and a debug adapter on the JDK's own debugger." }
] }
```

## How a command runs

```flow
{ "nodes": [
  { "id": "cmd", "title": "Agent command", "sub": "any program", "new": true, "cap": "The agent runs a command through the shell tool." },
  { "id": "rules", "title": "Rule engine", "sub": "parsed and classed", "new": true, "cap": "Each part of the command gets a class and the real paths it touches." },
  { "id": "card", "title": "Your card", "sub": "or the deciders", "cap": "You decide in Strict; the deciders vote in YOLO." },
  { "id": "snap", "title": "Snapshot", "sub": "Undo covers it", "new": true, "cap": "The project is copied first, so Undo can put back what the command changes." },
  { "id": "job", "title": "Windows job", "sub": "Stop ends it all", "cap": "Everything it starts lives in one job; Stop ends all of it." },
  { "id": "checks", "title": "Pack checks", "sub": "compile what changed", "cap": "Before the final reply, the packs compile what changed." },
  { "id": "result", "title": "Result", "sub": "audit log", "cap": "The result goes back to the agent, and the audit log keeps who allowed it." }
], "loops": [{ "from": "checks", "to": "cmd", "label": "errors in changed files" }] }
```

```compare
{ "prompt": "Create a small Rust CLI called wc-lite and build it", "options": [
  { "label": "Before", "steps": [
    { "title": "Only a short list of programs may run", "text": "cargo is not on it", "bad": true },
    { "title": "It writes the whole crate, then builds", "text": "the build fails: no linker", "bad": true },
    { "title": "You install the linker yourself", "text": "outside QuorX" }
  ], "verdict": { "title": "It got there, the long way", "text": "The missing linker was found only after everything was written." } },
  { "label": "After", "steps": [
    { "title": "QuorX checks the toolchain first", "text": "Rust is here, the linker is not" },
    { "title": "The agent offers three ways on", "text": "you pick one; the install runs in the background" },
    { "title": "Checks, tests, then the real program", "text": "cargo check before the reply" }
  ], "verdict": { "title": "Straight there, with you in charge", "text": "The agent knows what this computer can build before it writes a line." } }
] }
```

## Where things stand

```matrix
{ "levels": [{ "id": "proven", "label": "Proven" }, { "id": "tested", "label": "Tested" }, { "id": "wired", "label": "Logic tested" }, { "id": "next", "label": "Not yet" }],
  "columns": ["What you can build", "Evidence"],
  "rows": [
    { "level": "proven", "cells": ["Websites, web apps, canvas games", "Opened and checked in a browser before each reply"] },
    { "level": "proven", "cells": ["Rust command-line programs", "wc-lite built in a real chat for $0.039"] },
    { "level": "tested", "cells": ["Electron apps", "8 of 8 self-tests against a real Electron"] },
    { "level": "tested", "cells": ["Java and Kotlin", "14 of 14 with a real JDK 21 and Gradle"] },
    { "level": "wired", "cells": ["Go programs", "The Delve plan is tested; needs Go"] },
    { "level": "next", "cells": ["Embedded boards", "Arduino and ESP32 are not covered"] }
  ] }
```

```ledger
{ "rows": [
  { "gain": "Any toolchain, not six programs", "gainText": "The agent runs cargo, dotnet or gradle directly, and you see the real command.", "cost": "More cards to answer", "costText": "Builds ask in Strict until a rule allows them.", "mitigation": "\"Always allow\" on the card, or the deciders in YOLO." },
  { "gain": "Long work is never cut off", "gainText": "Builds and installs keep going in the background.", "cost": "A forgotten command keeps using the computer", "costText": "Nothing ends it on a timer any more.", "mitigation": "The Running tab lists each one with Stop." }
] }
```

```terminal
{ "title": "Rust-Test · the program the agent built", "lines": [
  { "cmd": ".\\target\\release\\wc-lite.exe Cargo.toml src\\main.rs" },
  { "out": "    16    44   290 Cargo.toml\n   528  1933 16607 src\\main.rs\n   544  1977 16897 total" },
  { "cmd": ".\\target\\release\\wc-lite.exe -l Cargo.toml" },
  { "out": "  16 Cargo.toml" }
] }
```

```callout
{ "tone": "info", "title": "A note", "text": "Callouts hold one thing the reader should not miss, with `code` and **bold** allowed." }
```

```callout
{ "tone": "warn", "title": "A warning", "text": "Something to be careful about." }
```

```callout
{ "tone": "good", "title": "Good news", "text": "Something that worked." }
```

## Your own numbers

These come from this computer's own logs and never leave it. With no logs yet, each one says what will show.

```local
{ "view": "models" }
```

```local
{ "view": "deciders" }
```

```local
{ "view": "costs" }
```

```local
{ "view": "tests" }
```
