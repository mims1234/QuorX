<p align="center">
  <img src="public/brand/quorx-192.png" width="96" alt="QuorX logo">
</p>

<h1 align="center">QuorX</h1>

<p align="center">
  <b>An open-source AI agent that builds on your own computer, with a quorum of models checking its work.</b><br>
  Any model on OpenRouter · Windows first · Apache 2.0
</p>

<p align="center">
  <a href="https://youtu.be/-A36aZuz0m0"><img src="docs/images/trailer.jpg" width="720" alt="Watch the QuorX trailer on YouTube"></a><br>
  <a href="https://youtu.be/-A36aZuz0m0">▶ Watch the trailer</a>
</p>

## What it is

You describe what you want: a game, a site, a desktop app, a fix. QuorX's agent works in a project folder you pick,
with a real terminal, a real browser and the tools already on your computer. It builds the thing, opens it, tests it
the way a person would, and shows you every step it took.

![QuorX building a game: the chat on the left, the reviewer's scores, and the game running in the Browser tab](docs/images/quorx-build.jpg)

- **Any model, priced up front.** Pick from every model on OpenRouter, cheap or frontier, with its price shown.
- **A quorum behind it.** Small, fast "decider" models answer the agent's questions and check its work, which helps
  cheaper models build better.
- **Safe by default.** Risky commands wait for your OK, every change can be undone, and Stop ends everything.
- **It checks before it says done.** Each build is opened, clicked through and scored by a separate reviewer model.

## Get it

**Windows:** download the installer from the [latest release](https://github.com/mims1234/QuorX/releases/latest).
It isn't code-signed yet, so Windows may warn you; [here's how to check the download](docs/GETTING-STARTED.md#install-the-app-windows).

**From source** (Windows, macOS, Linux), with Node.js 20+:

```bash
npm install
npm start
```

Then open http://localhost:5188 and sign in with OpenRouter. The full setup is in [Getting started](docs/GETTING-STARTED.md).

## Learn more

| | |
|---|---|
| [What QuorX does](docs/FEATURES.md) | Every feature, with screenshots, and what it deliberately doesn't do |
| [Getting started](docs/GETTING-STARTED.md) | Installing, signing in, the desktop app, and where your data lives |
| [How it works](docs/REPORT.md) | The full report: the agent loop, the deciders, the safety layer, platform packs, research |
| [Testing](docs/TESTING.md) | Running the tests, and helping test platform packs |
| [Privacy](PRIVACY.md) | What stays on your computer and what leaves it |
| [Security](SECURITY.md) | Reporting a problem, checking downloads, and what the guards do and don't cover |

<p align="center">
  <img src="docs/images/quorx-phone.jpg" width="240" alt="QuorX on a phone: a finished build with the reviewer's scores">
  <br><sub>Leave the desktop app running and use QuorX from your phone.</sub>
</p>

## Use it at your own risk

QuorX lets an AI agent run real commands on your computer. Its guards make mistakes unlikely, not impossible, and
they are not a sandbox. Keep backups, use 🔒 Strict (the default) for anything that matters, and read
[Security](SECURITY.md) before you switch to ⚡ YOLO. The software comes with no warranty, as the licence says.

## Licence

Open source under the [Apache License 2.0](LICENSE): use it, change it and fork it, for personal or commercial work,
as long as you keep the licence and the [NOTICE](NOTICE). The QuorX name and logo aren't covered by the licence, so a
fork should use its own.
