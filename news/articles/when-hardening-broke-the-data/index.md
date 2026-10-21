---
title: When a security hardening broke the data
date: 2026-10-21
summary: QuorX 0.2.5 locked down its data folder so tightly that QuorX itself could no longer read it. Projects and chats seemed to vanish; nothing was lost. What happened, how 0.2.6 repaired it an hour later, and what every release does now.
tags: safety, tests, research
version: 0.2.7
---

QuorX 0.2.5 was called "Locked down by default". It made QuorX much harder to attack. It also locked QuorX out of its
own data. For about an hour, people who updated saw their projects, chats and terminal seem to disappear. Nothing was
lost, and 0.2.6 repaired it. This is what happened and what changed.

## What went wrong

0.2.5 locked the data folder on Windows so only the user's account and the system can read it. That folder holds
chats, projects, settings and keys. The rule was meant for the folder. It was applied with `icacls` to every file
inside it as well (the `/T` switch), with inheritance flags that only make sense on a folder. On a file, those flags
left no permission entries at all.

```flow
{ "nodes": [
  { "id": "lock", "title": "0.2.5 lock-down", "sub": "the folder and every file", "cap": "The permission rule was applied to the data folder and, with /T, to every file inside it." },
  { "id": "flags", "title": "Folder-only flags on files", "sub": "no entries left", "cap": "Inheritance flags that only apply to folders left each file with no permission entries at all." },
  { "id": "read", "title": "QuorX can't read its data", "sub": "access denied", "cap": "Not even QuorX, running as the same user, could open its own files." },
  { "id": "seen", "title": "What people saw", "sub": "empty lists", "cap": "An empty project list, missing chats, a broken terminal, and an app link said to be not valid." }
] }
```

QuorX treated "can't read the file" like "no file yet", so the empty project list looked normal. That made it worse:
it looked like data loss, not an error. And the update reached installed apps through auto-update, straight to
everyone.

## The fix, an hour later

```compare
{ "prompt": "QuorX starts on a data folder that 0.2.5 locked", "options": [
  { "label": "0.2.5", "steps": [
    { "title": "Every file locked", "text": "No permission entries on any file", "bad": true },
    { "title": "Reads fail", "text": "Treated as \"nothing there yet\"", "bad": true },
    { "title": "An empty QuorX", "text": "Projects and chats seem gone", "bad": true }
  ], "verdict": { "title": "Locked out", "text": "Secure, and unusable." } },
  { "label": "0.2.6", "steps": [
    { "title": "Probe before reading", "text": "Open app-key, projects, keys, access and one chat" },
    { "title": "Any refused: repair", "text": "Reset the files to inherit from the folder, no administrator rights needed" },
    { "title": "Start as usual", "text": "And if the project list can't be read, say so" }
  ], "verdict": { "title": "Back, with nothing lost", "text": "Only the folder is locked now, and its files inherit that." } }
] }
```

The first version of the repair checked a single file. But a file rewritten since 0.2.5 already inherits the right
entries, so one readable file doesn't mean the rest are. 0.2.6 probes several. A test now locks a data folder the
0.2.5 way, then checks that QuorX repairs it at start and that the new lock-down keeps files readable.

## Why the tests missed it

No test locked a data folder and then read it back the way QuorX does at start. A lock-down that is too strict looks
like success from the outside: the files were very private. Nobody could read them, QuorX included.

## What every release does now

- **A "can we still read it?" test** for any lock-down change: lock it, then read it back as the app would.
- **Staged releases.** A new version is first a pre-release that installed apps don't take, and it reaches them only
  when promoted. A bad one can be pulled. See [Shipping safer](articles/shipping-safer).
- **Upgrades tested from real old data.** For 0.2.7, the old version itself made a data folder with a project and three
  chats. 0.2.7 then started on it, and the project list and every chat's messages were byte for byte the same.

```callout
{ "tone": "warn", "title": "The lesson", "text": "Hardening can be an outage. A permission change is a data change, so test it like one: after locking something, read it back the way the app does." }
```

Pull request: #34 (0.2.6). The longer version is in `docs/research/lockdown-postmortem.md`.
