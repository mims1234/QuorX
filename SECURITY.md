# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/mims1234/QuorX/security/advisories/new), not in a public issue.
Say what you found, how to reproduce it, and which version you used. You'll get a reply as soon as it has been read,
and credit in the fix's notes if you'd like it.

Especially welcome: ways to get a command past the rule engine, to make an approval judge approve something harmful,
to read or write outside a project, or to reach a key.

## Supported versions

Only the latest release gets fixes. The desktop app updates itself, so staying current is the default.

## Checking a download

Installers are built from this repository by GitHub Actions ([the workflow](.github/workflows/release.yml)) and
published with a `SHA256SUMS.txt` on each [release](https://github.com/mims1234/QuorX/releases). The installer isn't
code-signed yet, so Windows SmartScreen warns about it; compare its checksum first, as
[Getting started](docs/GETTING-STARTED.md#install-the-app-windows) shows.

## Who can reach QuorX

- **Your own windows only.** QuorX's API answers only pages that opened it with its app link (printed when it starts;
  the desktop app uses it by itself). Other programs on the computer, including commands the agent runs, can't use it.
- **This computer only, by default.** Other devices (a phone on Wi-Fi) are off until you turn them on in
  ⚙ Settings → About; until then QuorX listens on this computer alone. Pairing travels over plain HTTP, so use it on
  networks you trust.
- **Keys stay put.** QuorX's data folder and `.env` are readable by your account only. The agent's commands may not read
  them, your key folders (`.ssh`, `.aws`, …) or browser profiles, and they ask before reading outside the project.
  Command rules are kept in QuorX's data folder, never in a project, so a folder you open can't bring its own.

## What QuorX does and doesn't protect

QuorX gives an AI agent a real shell on your computer. Its guards (the command rule engine, approvals, snapshots and
Undo, Stop, the tripwire and spending caps) are described in [the safety layer](docs/REPORT.md#the-safety-layer).
They work at the command level and are **not** an operating-system sandbox: a program the agent writes and runs can
read any file your account can. Use 🔒 Strict (the default) to see every command that needs approval, and keep ⚡ YOLO
for projects you trust.
