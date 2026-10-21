---
title: Building a release in parallel
date: 2026-10-21
summary: 0.2.7 was built as five feature bundles, a stack of four workflow features and two early fixes, with a merge coordinator. What made it fast, where the pull requests collided, and what we'd do the same way again.
tags: tests, research
version: 0.2.7
---

0.2.7 was built in parallel. The work was split into five feature bundles, a stack of four workflow features and two
early fixes, with a merge coordinator who reviewed each pull request, ran the full suite on `main` after merges, and
decided the order. From the first pull request opened to the last one merged took a little under four hours.

## The pull requests, opened to merged

Each lane is one pull request's life on GitHub, from opened to merged (UTC, 20 to 21 October). Most work started before
its pull request was opened. Click a lane for what it did.

```lanes
{ "start": "21:30", "end": "01:30", "rows": [
  { "label": "#35 resumed replies", "build": ["21:33", "23:15"], "detail": "Early fix: a reply resumed after a restart stays in one bubble and keeps its result." },
  { "label": "#36 setup and lockfile", "build": ["21:41", "23:15"], "detail": "Early fix: desktop setup no longer adds a stray dependency." },
  { "label": "#37 diff review", "build": ["22:30", "00:32"], "detail": "First of a stack of four. It and #58 both changed the agent loop file, so one waited for the other." },
  { "label": "#38 hooks", "build": ["22:42", "00:56"], "detail": "Built on #37, so it had conflicts to settle after #37 was squash-merged." },
  { "label": "#39 schedules", "build": ["22:53", "01:03"], "detail": "Built on #38: the same rebase, one level further down." },
  { "label": "#40 tests on every PR", "build": ["22:56", "23:11"], "detail": "One of the first merges, so every later pull request was tested on Windows and Linux." },
  { "label": "#41 nested projects", "build": ["23:00", "23:35"] },
  { "label": "#42 cache share", "build": ["23:06", "23:22"] },
  { "label": "#43 pre-releases", "build": ["23:06", "23:19"] },
  { "label": "#44 production plans", "build": ["23:09", "00:06"], "detail": "One of three media pull requests that touched the agent loop in separate places and merged in any order." },
  { "label": "#45 memory", "build": ["23:21", "01:08"], "detail": "Last of the stack of four, and the last feature merged." },
  { "label": "#46 check time-outs", "build": ["23:22", "23:24"] },
  { "label": "#47 video and ffmpeg", "build": ["23:29", "23:55"] },
  { "label": "#49 clear quitting", "build": ["23:37", "23:43"] },
  { "label": "#50 rename retry", "build": ["23:38", "23:44"] },
  { "label": "#51 harder benchmark", "build": ["23:44", "23:46"] },
  { "label": "#52 model cards", "build": ["23:55", "00:00"] },
  { "label": "#53 installer modules", "build": ["23:59", "00:06"], "detail": "Found while checking installers: the desktop app had shipped without its full terminal." },
  { "label": "#54 export and import", "build": ["00:00", "00:16"] },
  { "label": "#56 first-run tour", "build": ["00:03", "00:09"] },
  { "label": "#57 sign-in per port", "build": ["00:06", "00:10"], "detail": "Found because several copies of QuorX ran on one computer and signed each other out." },
  { "label": "#58 smaller prompt", "build": ["00:20", "00:53"], "detail": "Reviewed against its benchmark and a line-by-line check that no safety rule changed." },
  { "label": "#59 high-port crash", "build": ["00:36", "00:51"], "detail": "Found at integration: a port above 64535 put the pages port out of range and stopped QuorX." },
  { "label": "#61 this computer only", "build": ["01:22", "01:26"], "detail": "The scope narrowed at the end: QuorX answers only the computer it runs on." }
] }
```

## Passing tests on main

The coordinator ran the full suite on `main` after each wave of merges. Some runs had one flaky test that passed on a
rerun; this chart counts passes only. #61 replaced a few tests with one check that other devices are refused.

```chart
{ "type": "line", "title": "Passing tests on main, UTC", "unit": "tests", "x": ["23:15", "23:38", "00:00", "00:10", "00:53", "01:08", "01:26"], "series": [{ "name": "Passing", "values": [217, 224, 233, 241, 257, 274, 271] }] }
```

## What worked, and what hurt

```ledger
{ "rows": [
  { "gain": "Bundles that owned their files merged cleanly", "gainText": "The three media pull requests touched the agent loop in separate places and merged in any order.", "cost": "Two pull requests in one file", "costText": "#37 and #58 both changed the agent loop, so one waited for the other and rebased.", "mitigation": "Split work by file ownership, not by feature size." },
  { "gain": "A stack of four was quick to review", "gainText": "Each workflow feature showed only its own diff.", "cost": "and slow to merge", "costText": "After each squash merge, the next one retargeted to main and had conflicts to settle.", "mitigation": "Stack only when a feature really needs the one below it." },
  { "gain": "Integration found real bugs", "gainText": "A crash on high ports (#59) and copies of QuorX signing each other out (#57).", "cost": "Flaky tests on busy machines", "costText": "Process-count tests sometimes failed with several test runs on one computer, then passed alone.", "mitigation": "Kept strict, documented, and rerun on a quiet machine." }
] }
```

## Risky platform work waited

The macOS and Linux installers (#55) were ready to review, but their publish and promote steps had never run end to
end. A release-pipeline change is the kind that breaks everyone at once, so they moved to 0.2.8.

```callout
{ "tone": "good", "title": "What we learned", "text": "Split work by file ownership. Stack only when you must. Measure loop changes with benchmarks. Keep risky platform work in its own release. And expect integration to find what unit tests don't." }
```

The longer version is in `docs/research/parallel-release.md`.
