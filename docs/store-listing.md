# Microsoft Store listing

[← Back to the README](../README.md)

The text for QuorX's Microsoft Store listing (Partner Center → Store listings → English). Keep it in step with the
README and the website when features change.

## Product name

QuorX

## Short description (up to 100 characters)

An open-source AI agent that builds on your computer, with a quorum of models checking its work.

## Description

QuorX is an open-source AI agent that builds real software on your own computer: games, websites, desktop apps and
fixes. You describe what you want; QuorX works in a project folder you choose, with a real terminal, a real browser and
the tools already on your computer. It builds the thing, opens it, tests it the way a person would, and shows you every
step it took.

Its work is checked, not trusted:

- A quorum of small, fast decider models answers the agent's questions and votes on what it may do.
- A separate reviewer model opens each build, clicks through it and scores it.
- A safety layer guards every command. Risky commands wait for your OK, every change can be undone, and Stop ends
  everything.
- Benchmarks with hidden checks show whether a change really helps.

Pick any model on OpenRouter, from free and cheap models to frontier ones, with its price shown before you use it. QuorX
needs your own OpenRouter key: sign in with OpenRouter, and you pay OpenRouter directly for what you use. QuorX itself
is free and sells nothing.

Your chats, projects and keys stay on your computer. QuorX answers only the computer it runs on.

QuorX is open source under the Apache License 2.0.

## What's new in this version

Steadier, safer and faster. Video Mode plans a film with a brief, a story pick and a storyboard before anything is
spent. Settings are redesigned, with Storage to see and clear what QuorX takes, and Skills you can write and share
across projects. Long replies, big projects and large backups no longer slow QuorX down, and streaming text stays put
so you can select it. QuorX opens at its own address, so your sign-in stays away from apps you build. The agent's
commands, key reads and desktop clicks get stronger checks, and stopped calls now count toward your spend.

## Product features (up to 20, each up to 200 characters)

- Builds games, websites, desktop apps and fixes in a project folder you choose
- Uses any model on OpenRouter, with its price shown up front
- Decider models answer the agent's questions and vote on what it may do
- A separate reviewer model opens, clicks through and scores each build
- Risky commands wait for your OK; every change can be undone; Stop ends everything
- A real terminal and a real browser, using the tools already on your computer
- Plans with a live checklist, and one approval for a paid media production plan
- Pictures, video, voice and music through OpenRouter's media models
- Diff review, hooks, scheduled tasks and a memory of your preferences
- Export and import: your chats, projects and settings in one file
- Research articles and reports in News on what was measured and learned
- Open source under Apache 2.0; your data stays on your computer

## Search terms (up to 7)

AI agent, coding agent, OpenRouter, developer tools, app builder, open source, AI code

## Copyright and trademark

© 2026 The QuorX authors. Licensed under the Apache License 2.0.

## Additional license terms

https://github.com/mims1234/QuorX/blob/main/LICENSE

## Screenshots

Use the README's images (docs/images), taken at 1920×1080 or larger:

1. A build: the chat, the reviewer's scores, and the game running in the Browser tab.
2. The steps of a reply: plan, commands, checks and costs.
3. Settings → Deciders and models, with prices.
4. News: an article and a report.

## Notes for certification

QuorX is a developer tool that builds and tests software in folders the user chooses. It runs the user's own
toolchains (Node, Python, compilers) and terminals, with approvals before risky commands, so it needs the
runFullTrust capability. It needs the user's own OpenRouter API key, which testers can create for free at
openrouter.ai; free models work without credit.
