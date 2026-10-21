---
title: Shipping safer
date: 2026-10-21
summary: In 0.2.5 a bad version reached installed apps through auto-update. 0.2.7 puts tests on every pull request, stages each release as a pre-release with Promote and Pull, checks its checksums, and makes QuorX answer only the computer it runs on.
tags: safety, tests, research
version: 0.2.7
---

In 0.2.5, a bad version reached installed apps through auto-update. 0.2.7 puts more steps between a change and the
computers QuorX runs on. Each step is small. Together they mean a change is tested, built by a read-only job, checked,
tried as a pre-release, and approved twice before it updates anyone.

## From pull request to an installed app

Press Play to walk the steps.

```flow
{ "nodes": [
  { "id": "pr", "title": "Pull request", "sub": "tests on Windows and Linux", "new": true, "cap": "Every pull request runs the full suite on Windows and the POSIX and News tests on Linux. Both are required." },
  { "id": "main", "title": "Protected main", "sub": "squash, linear history", "cap": "Changes reach main only through a pull request with both checks green." },
  { "id": "tag", "title": "Protected release tag", "sub": "can't be moved or deleted", "new": true, "cap": "A ruleset protects every v* tag, so a version always means the same code." },
  { "id": "build", "title": "Read-only build", "sub": "checksums and attestation", "cap": "The installer is built by a job that can only read the repository, with SHA256SUMS.txt and a signed build attestation." },
  { "id": "pre", "title": "Pre-release", "sub": "approved by the owner", "new": true, "cap": "Published as a pre-release. Installed apps read the latest release, and a pre-release is never latest, so nobody updates yet." },
  { "id": "promote", "title": "Promote release", "sub": "approved again", "new": true, "cap": "Checks every file against the checksums, makes it the latest release and reads that back. Only then does winget get it." },
  { "id": "live", "title": "Installed apps update", "sub": "and winget", "cap": "Installed apps are offered the new version." }
], "loops": [{ "from": "live", "to": "pre", "label": "Pull release: the version before becomes latest again" }] }
```

## Tests on every pull request (#40)

Every pull request, and every push to `main`, runs two required jobs: **Tests on Windows** (the full suite) and
**POSIX and News tests on Linux** (the tests that start real processes on macOS and Linux). The workflow needs no
secrets, because the tests drive the agent with a scripted model.

The first run found two real bugs before #40 even merged: a debug adapter bridge broke arguments holding `$` or quotes
under `sh`, and a test refused the runner's short 8.3 temp path, which contains `~`. Both were fixed in the same pull
request.

## Staged releases with Promote and Pull (#43)

A new version is now a **pre-release** first. **Promote release** checks it and makes it the update. **Pull release**
makes the version before it the update again, first, so the feed moves off a bad version at once, then marks the bad
one "Pulled". It says plainly what it can't undo: apps that already updated stay on that version until a newer one
ships. Both run only with the owner's approval, and never at the same time.

```callout
{ "tone": "warn", "title": "What wasn't run", "text": "These workflows only run on a release tag or by hand, so a green pull request doesn't test them. When #43 merged they had been parsed and syntax-checked, and the checksum step was tried locally. The 0.2.7 tag is their first real run." }
```

Since 0.2.4, each release lists a SHA-256 checksum and a signed proof that GitHub built it from the repository. In
0.2.7, `SHA256SUMS.txt` uses plain line endings, so `sha256sum -c SHA256SUMS.txt` works on macOS and Linux as well as
`Get-FileHash` on Windows.

## This computer only (#61)

The smallest attack surface is the one that isn't there. QuorX's agent runs real commands, so in 0.2.7 QuorX answers
only the computer it runs on. It listens on 127.0.0.1, and refuses any request from anywhere else (403). The code for other devices is gone, so there is less to guard and less to test, and a test checks the refusal.

## A gap the pipeline didn't catch (#53)

While checking installers, we found the desktop app had been shipping without its bundled modules: no full terminal
(node-pty), terminal view or math rendering. The terminal quietly fell back to a plain shell, so it was easy to miss.
Each module is now listed on its own, and the fix was checked by loading node-pty inside the packaged app.

```ledger
{ "rows": [
  { "gain": "Two approvals before anyone updates", "gainText": "One to publish a pre-release, one to promote it.", "cost": "Slower releases", "costText": "A version waits for a person to try it and promote it.", "mitigation": "Promote checks the files itself, so the wait is for judgement, not chores." },
  { "gain": "Taking a version back is one step", "gainText": "Pull release moves the update feed first.", "cost": "Some apps already updated", "costText": "They stay on the bad version until a newer one ships.", "mitigation": "Pull release says so in its summary, so nobody assumes otherwise." }
] }
```

```callout
{ "tone": "good", "title": "What we learned", "text": "Put two approvals between a merge and the people who use it. Make taking it back one step. Say what wasn't run. And test the thing people install, not only the source: a silent fallback hides bugs." }
```

The longer version is in `docs/research/shipping-safer.md`.
