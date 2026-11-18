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

Pick any model, from free and cheap ones to frontier ones, with its price shown before you use it: every model on
OpenRouter (sign in with OpenRouter and pay it directly for what you use), makers' own APIs with your key, coding-plan
subscriptions, the coding CLIs you've signed in to, or local models on this PC at no cost. QuorX itself is free and
sells nothing.

It's laid out like a code editor: projects and chats as tabs, two chats side by side, one-click layouts, a bottom panel
for terminals and servers, and Settings in its own window.

Your chats, projects and keys stay on your computer. QuorX answers only the computer it runs on.

QuorX is open source under the Apache License 2.0.

## What's new in this version

A new workspace: a menu bar, project tabs, an activity bar and a status bar, chats as tabs you can put side by side,
one-click layouts, and Settings in its own large window. Many more providers: makers' APIs such as xAI, DeepSeek and
Mistral, coding-plan subscriptions, coding CLIs signed in on this PC, and free local models from LM Studio, Foundry
Local and llama.cpp. Plus a worktree per chat, search inside every chat, a context meter with Compact, and sidebar
views that fit and resize.

## Product features (up to 20, each up to 200 characters)

- Builds games, websites, desktop apps and fixes in a project folder you choose
- Any model, priced up front: OpenRouter, makers' APIs, coding plans, signed-in CLIs or local models
- Laid out like a code editor: project and chat tabs, side-by-side chats, layouts and a bottom panel
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

Use the README's images (docs/images), taken at 2400×1500 and scaled to 1600 wide:

1. A build: the project's chats, the reply with its checks, and the finished page in the Browser tab (quorx-build.jpg).
2. Two chats side by side, each with its steps and costs (quorx-layouts.jpg).
3. Settings in its own window (quorx-settings.jpg), and Providers & keys (quorx-providers.jpg).
4. The model picker, with prices (quorx-models.jpg).
5. Review changes and Undo under a reply (quorx-review.jpg).

## Notes for certification

QuorX is a developer tool that builds and tests software in folders the user chooses. It runs the user's own
toolchains (Node, Python, compilers) and terminals, with approvals before risky commands, so it needs the
runFullTrust capability. The easiest way to test it is an OpenRouter API key, which testers can create for free at
openrouter.ai; free models work without credit. A local model server (LM Studio, Ollama) works without any key.
