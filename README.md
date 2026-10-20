# QuorX

QuorX is an AI coding agent that runs on your own computer: it works in a project folder you pick, with a real
shell, a real browser and your real toolchains, and shows how it got every answer. Any model on OpenRouter can be
the agent, with a quorum of fast "decider" models behind it to answer its questions and check risky actions.

> **Screenshot:** none in the repo yet. Run it (below) to see the page: chats on the left, the conversation in the
> middle, and a pane on the right with the browser, terminals, files, the Running tab and each reply's steps.

## Setup

You need **Node.js 20 or newer** and an **OpenRouter** account.

```bash
npm install
npm start
```

Open http://localhost:5188 and choose **Sign in with OpenRouter** (⚙ Settings → API keys opens by itself the first
time). openrouter.ai asks you to approve, lets you set a spending limit for the new key, and sends the key back to
QuorX. You can paste a key instead, or put `OPENROUTER_API_KEY` in a `.env` file. Then ⚙ Settings → **Setup check**
shows what this computer has (Git, Python, a browser, toolchains) and offers to install what is missing.

**The desktop app** puts the same page in its own window, with real browser tabs in the pane and a tray icon that
keeps QuorX running for your phone:

```bash
npm run desktop:setup
npm run desktop
```

`desktop:setup` installs Electron (about 100 MB) into `desktop/` only. `npm run desktop:dist` builds a Windows
installer.

**Where your data lives:** chats, projects and keys in `data/`, logs in `logs/`, both next to the code and ignored by
git (the installed app asks where to keep them). Each project keeps QuorX's own working files (undo history, trash,
snapshots, scratch work) in a hidden `.quorx/` folder inside it, which git ignores. Keys stay on the server; the page
only ever sees them masked.

Ports, phones and other devices, the installer, updates and every setting from `.env` are in
[the report's setup section](docs/REPORT.md#setup-in-detail).

## What's great

- **Any model, with its price.** Every model on OpenRouter, through one key. The model picker searches, sorts by
  price, filters by what a model can do, and shows your own pass rate next to each price.
- **A quorum of deciders.** The agent can ask fast models yes/no and multiple-choice questions, writing its own
  guess first so you can see whether asking changed anything. Fixed checks ask them about every build too.
- **Guarded commands.** Every command line is parsed and each part classed (read, build,
  install, push, delete, can't be checked). Your rules decide what runs; the rest comes to your approval card, or to
  the deciders in ⚡ YOLO, who see only facts and your own messages. Deleting your profile, a drive root or anything
  above the project is refused outright.
- **Undo covers commands too.** The project is snapshotted before each command, so ↶ Undo and Review changes cover
  what a build script or an `rm` did as well as the agent's own file edits.
- **Stop ends everything.** Each command runs in a Windows job (a process group on macOS and Linux), so Stop ends
  every process it started and confirms "0 processes left".
- **A tripwire and spending caps.** A command that deletes many files outside the project is stopped. A cap per
  reply, an optional daily cap, project budgets and a media cap keep spending where you set it.
- **16 platform packs** for apps beyond the web: Rust, Node and TypeScript, Python, .NET, Go, C and C++, Java and
  Kotlin, Android, Flutter, Electron, Tauri, Godot, Unity, Windows installers and Apple apps, plus one for every
  project. Each finds its toolchain (and whether it really builds here), compiles what a reply changed before the
  reply ends, runs and drives the app, and debugs it with breakpoints.
- **The Running tab.** Everything running in a project in one list: background builds, servers, the agent's
  terminals and yours, who started each one, with Stop and Stop all.
- **Real apps, driven like a person would.** A real browser (a real tab you can take over in the desktop app),
  desktop windows through UI Automation, Android emulators, and terminal programs that ask questions.
- **The agent tests its own work before it replies.** Every file is checked as it is written. Before the final
  reply, QuorX checks the changed files again, opens what was built, runs the compiler checks, catches weakened
  tests, and a separate reviewer model plays the result and scores it. Problems go back to the agent.
- **News, inside the app.** What's new in each version, reports on models, tests and platforms, and research
  articles with interactive charts and flows. It ships with QuorX, so it updates when QuorX does, and "Your numbers"
  are worked out from this computer's own logs, never uploaded.

## Deliberately narrow

- **Models only through OpenRouter.** One key reaches every model, prices are shown before you pick, and there are
  no direct provider keys to manage.
- **Windows first.** macOS and Linux have the same safety layer (process groups, bash and zsh rules, their own
  off-limits folders), but they are newer and less tested.
- **No OS sandbox yet.** The guards above work at the command level. They are not a container.
- **The agent runs real commands on your computer.** A program it writes and runs can read any file your account
  can. Keep ⚡ YOLO for projects you trust, and use 🔒 Strict (the default) to see each command that needs approval.

## Testing

```bash
npm test
```

180 tests: the agent loop driven by a scripted model (no network, no cost), security, the rule engine and the rest of
the safety layer, macOS and Linux paths, and the News format. On Windows 10 of them skip because they need macOS or
Linux. A few tests count real processes or wait on a terminal; on a busy PC, rerun a failing
`stop: …` or `terminal: …prompts` test alone.

```bash
npm run test:packs
```

Runs every platform pack self-test your computer can run, with no OpenRouter key, and writes `pack-test-report.md`.
Packs whose toolchain is missing are listed with what they need. To test one pack, add `-- --pack <id>`.
**Anyone with a toolchain can help:** paste the report into the pack's pull request, or open a "Pack test report"
issue.

```bash
npm run test:ui
```

Starts the desktop app from this checkout with its own data folder and port, drives the window the way a person
would, and saves a screenshot of every step with an HTML report. `-- --scenario settings` needs no key.

## Where to go next

The [detailed report](docs/REPORT.md) covers how QuorX works end to end:

- [How a reply runs](docs/REPORT.md#how-a-reply-runs): the loop, artifacts and projects, the checks and the
  reviewer.
- [The deciders and the quorum experiment](docs/REPORT.md#the-deciders-and-the-quorum-experiment), with benchmark
  results.
- [The safety layer](docs/REPORT.md#the-safety-layer): the rule engine, scripts, paths, approvals, Stop, snapshots,
  the tripwire and caps.
- [The Running tab and background jobs](docs/REPORT.md#the-running-tab-and-background-jobs).
- [Platform packs](docs/REPORT.md#platform-packs) and [Testing](docs/REPORT.md#testing).
- [Setup in detail](docs/REPORT.md#setup-in-detail): keys, ports, devices, data, the desktop app, `.env`.
- [Research and decisions](docs/REPORT.md#research-and-decisions) and
  [Known limits](docs/REPORT.md#known-limits).

More documents:

| Document | What it covers |
|---|---|
| [docs/platform-packs.md](docs/platform-packs.md) | How a pack is written and tested, compiled-language debugging, Python, game engines and installers |
| [docs/shell-safety-plan.md](docs/shell-safety-plan.md) | The safety layer's plan, with the reasons behind each guard |
| [docs/macos-and-linux.md](docs/macos-and-linux.md) | Stop, rules, off-limits folders and the desktop tool on macOS and Linux |
| [docs/apple-apps.md](docs/apple-apps.md) | Xcode builds, the iOS Simulator, crash reports and Swift debugging |
| [docs/java-and-kotlin.md](docs/java-and-kotlin.md) | Gradle and Maven checks, JUnit summaries, Swing and JavaFX, debugging with the JDK |
| [docs/desktop-browser-plan.md](docs/desktop-browser-plan.md) | Why the desktop app uses Electron, and how its real tabs work |
| [docs/news-format.md](docs/news-format.md) | The format for QuorX's in-app News |
