# Privacy

QuorX runs on your computer. It has no account, no analytics and no telemetry, and it sends nothing to its authors.

## What stays on your computer

- Your chats, projects, settings and keys (in `data/`, or the folder the installed app asks for).
- Logs of runs, checks and costs (in `logs/`). The numbers in News that are about your computer are worked out from
  these logs on your computer and never uploaded.
- Your project files. QuorX's own working files for a project (undo history, trash, snapshots) stay in its hidden
  `.quorx/` folder.

## What leaves your computer, and why

| Where | What is sent | When |
|---|---|---|
| [OpenRouter](https://openrouter.ai) | Your messages and what the agent works with (file contents, command output, screenshots) go to the models you pick, as any AI app must send them | Every model call, under your own OpenRouter key and their [privacy policy](https://openrouter.ai/privacy) |
| Package registries (npm, PyPI, crates.io, NuGet, Go, Maven) | The names of packages the agent wants to install | Before an install, to check that each package exists and isn't brand new |
| GitHub | A request for the latest release | When the desktop app checks for updates |
| Sites the agent opens | Normal web requests from its browser | Only when you or the agent open a page |

Commands the agent runs can of course reach the network themselves (an `npm install`, a `git push`). Those go through
the approval rules described in the [safety layer](docs/REPORT.md#the-safety-layer).

## Your keys

Your OpenRouter key is kept by the local QuorX server. The page only ever sees it masked, and it is never written to
logs or sent anywhere except OpenRouter.
