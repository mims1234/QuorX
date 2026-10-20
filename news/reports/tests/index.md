---
title: Tests: what QuorX checks before every change
date: 2026-10-20
summary: The test suites and how they grew, the platform packs' self-tests, the UI test that drives the desktop app, and the last results kept on your computer.
tags: tests, platforms, safety
order: 2
---

Every change to QuorX goes through three kinds of tests. None of them needs an OpenRouter key or spends money: they
drive QuorX's real code with no model, or with a scripted one.

| Command | What it tests | Takes |
|---|---|---|
| `npm test` | The agent loop, the safety rules, Stop, the terminal, approvals, the desktop tool, News | About a minute |
| `npm run test:packs` | Each platform pack's self-test that this computer can run: real toolchains, real builds, real debuggers | Minutes, more with more toolchains |
| `npm run test:ui` | The QuorX desktop app itself, driven like a person would, with a screenshot of every step | A few minutes |

## What runs

```stat
{"src":"tests.json","path":"stats"}
```

```chart
{"src":"tests.json","path":"suitesChart"}
```

The biggest files are the agent (`test-agent`: the loop, tools, checks and reviewer) and safety (`test-safety`: the
rules for commands, the folders that are off limits, Stop, background jobs, the debugger). `test-posix` tests the
same safety layer the way it works on macOS and Linux; on Windows, the parts that need those systems skip.

## Over time

Counted from the test files at each change merged into QuorX's main branch: the `test(…)` calls in the files
`npm test` runs, and in the platform packs' self-tests.

```chart
{"src":"tests.json","path":"historyChart"}
```

## Pack self-tests

The last `npm run test:packs` published here ran on 2026-10-20 01:19 UTC (commit 3d75802, Windows). Toolchains it found: Git 2.55.0, Node.js 22.23.1, Python 3 3.12.10, Rust (cargo) 1.97.1 (cannot build here), WebView2 runtime 155.0.4283.62. A pack whose toolchain is missing skips the tests that need it; its logic (parsers, rules, notes) is still tested. This is one computer's run: the Platforms report rates each pack by the best run on record, often on a computer set up with that toolchain.

```matrix
{"src":"tests.json","path":"packMatrix"}
```

```chart
{"src":"tests.json","path":"packsChart"}
```

## UI test

The last UI test published here (`npm run test:ui -- --scenario settings`) ran on 2026-10-20 01:22 UTC, commit 3d75802: 9 of 9 steps passed. It starts the QuorX desktop app with its own data folder and port, drives its window the way a person would, and saves a screenshot of every step. Scenarios: `settings`, `cli`, `running`.

## Your own results

The last `npm test`, `npm run test:packs` and `npm run test:ui` you ran in your QuorX folder, if any. Each run keeps
only its counts and the names of failed tests, in `logs/test-results.json` on this computer.

```local
{"view":"tests"}
```

## Help test

Tests pass on the machines they ran on. The more systems they run on, the more they're worth: a pack's self-test that
skips here may be the one that fails on yours. Run the kit and paste its report into a "Pack test report" issue.

```terminal
{"title":"Test QuorX on your computer","lines":[{"cmd":"npm test"},{"cmd":"npm run test:packs"},{"out":"Report: pack-test-report.md (paste it into a \"Pack test report\" issue)"}]}
```
