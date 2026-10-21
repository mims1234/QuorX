# What QuorX does

[← Back to the README](../README.md)

QuorX is an AI coding agent that runs on your own computer. It works in a project folder you pick, with a real shell,
a real browser and your real toolchains, and shows how it got every answer.

![A build in QuorX: the chat, the reviewer's scores and the game running in the Browser tab](images/quorx-build.jpg)

## Highlights

- **Any model, with its price.** Every model on OpenRouter, through one key. The model picker searches, sorts by
  price, filters by what a model can do, and shows your own pass rate next to each price.
- **A card for each model.** Recommended and default models carry a short card: limits and quirks, prompting tips
  from the provider's docs (with the links), and QuorX's own benchmark results. Hover "card" in the model picker to
  read it. The agent gets the cards of the models it is using, a few lines each.
- **A quorum of deciders.** The agent can ask fast models yes/no and multiple-choice questions, writing its own
  guess first so you can see whether asking changed anything. Fixed checks ask them about every build too.
- **It reads your request in full.** A prompt enhancer spells out what a request implies (a movie trailer implies a
  voice-over and music) and shows it under your message, where you can correct it.
- **Guarded commands.** Every command line is parsed and each part classed (read, build, install, push, delete,
  can't be checked). Your rules decide what runs; the rest comes to your approval card, or to the deciders in ⚡ YOLO,
  who see only facts and your own messages. Deleting your profile, a drive root or anything above the project is
  refused outright.
- **Undo covers commands too.** The project is snapshotted before each command, so ↶ Undo and Review changes cover
  what a build script or an `rm` did as well as the agent's own file edits.
- **Stop ends everything.** Each command runs in a Windows job (a process group on macOS and Linux), so Stop ends
  every process it started and confirms "0 processes left".
- **A tripwire and spending caps.** A command that deletes many files outside the project is stopped. A cap per
  reply, an optional daily cap, project budgets and a media cap keep spending where you set it.
- **Films from pictures, finished with ffmpeg.** A clip can start from a picture the agent made (or one in the project)
  when the video model takes a first frame, so characters and style hold from shot to shot. `edit_video` then joins
  clips, stills, a voice-over and music into one .mp4 in the project with ffmpeg, as an ordinary checked command.
  Setup check offers to install ffmpeg when it is missing.
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
- **Design systems, comments and exports.** Pick one of six starters or have one measured from a site, and every
  chat builds to it. Point at part of a page to say what should change, and export a page as PDF or PNG or the
  project as a ZIP. Any MCP client can hand work to QuorX ([details](REPORT.md#design-systems-comments-exports-and-replay)).
- **News, inside the app.** What's new in each version, reports on models, tests and platforms, and research
  articles with interactive charts and flows. Numbers about the computer it runs on are worked out from that
  computer's own logs and never uploaded.

| | |
|---|---|
| ![The model picker, with prices and ratings](images/quorx-models.jpg) | ![The Running tab: servers and terminals with Stop](images/quorx-running.jpg) |
| **Pick any model**, with its price and how it did in tests. | **See and stop everything** a project has running. |
| ![Review changes: every file a reply touched, with Undo](images/quorx-review.jpg) | ![News: an article with an interactive flow](images/quorx-news.jpg) |
| **Review and undo** every change, commands included. | **News** about each version, models and research. |

## Deliberately narrow

- **Models only through OpenRouter.** One key reaches every model, prices are shown before you pick, and there are
  no direct provider keys to manage.
- **Windows first.** macOS and Linux have the same safety layer (process groups, bash and zsh rules, their own
  off-limits folders), but they are newer and less tested.
- **No OS sandbox yet.** The guards above work at the command level. They are not a container.
- **The agent runs real commands on your computer.** A program it writes and runs can read any file your account
  can. Keep ⚡ YOLO for projects you trust, and use 🔒 Strict (the default) to see each command that needs approval.

How all of this works, end to end, is in the [detailed report](REPORT.md).
