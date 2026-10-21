---
title: Four workflow features, for any model
date: 2026-10-21
summary: Diff review, hooks, scheduled tasks and memory arrived in 0.2.7. Each had to work with a frontier model, a cheap one and one without tools, with the rules enforced by QuorX rather than by the prompt. What each does and the choices behind it.
tags: research, models, safety
version: 0.2.7
---

Diff review, hooks, scheduled tasks and memory are familiar ideas from other coding tools. QuorX's versions have one
extra constraint: QuorX runs any model on OpenRouter. A feature has to work with a frontier model, a cheap fast one,
and one that doesn't support tools at all. And QuorX, not the prompt, has to enforce the rules.

| Feature | What it is | On a cheap model |
|---|---|---|
| `/review` (#37) | Lists bugs in what changed, with `file:line` | Found both planted bugs, no false alarm, for $0.00021 |
| Hooks (#38) | Commands the user picks, run around the agent's writes and commands | A lint failure went back to the agent, which asked and then fixed it, for $0.0049 |
| Schedules (#39) | Chats QuorX starts on its own | A missed run found both TODOs with the right lines, for $0.0011 |
| Memory (#45) | A short list of facts the user approves, in every chat | Proposed and used a fact like a frontier model did, for $0.0006 over two tasks |

These are small tests with one or two tasks each. They show the features work on a cheap model, not how well they
work in general.

## Diff review

`/review` reviews the last reply's files, uncommitted changes, or the branch against `main`. QuorX collects the diff
itself and gives the reviewer each changed file with line numbers; the reviewer gets no tools. Findings are checked
before they're shown: a finding about a file that didn't change is dropped and a line past the end is clamped. Files
like `.env` and private keys are never sent, and keys inside code become `[secret removed]`. Models without tools
answer in JSON instead.

## Hooks

A hook is a command the user chooses, such as "after every file write, run `npm run lint`". The model never decides to
run one and can't change one.

```flow
{ "nodes": [
  { "id": "write", "title": "The agent writes cart.js", "cap": "The agent writes a file that matches the hook's pattern." },
  { "id": "approve", "title": "The hook asks first", "sub": "same rules as any command", "cap": "The hook's command goes through the same rules and approvals as the agent's own. The card says it is the user's hook." },
  { "id": "run", "title": "node lint.mjs cart.js", "sub": "fails: no-var", "cap": "The lint fails at cart.js line 8." },
  { "id": "back", "title": "The output goes back", "sub": "\"Fix what it reports\"", "cap": "The failure is added to the tool result, so the agent sees it at once." },
  { "id": "fix", "title": "The agent fixes it", "sub": "after asking which rule wins", "cap": "The request said to use var; the agent noticed the clash, asked, then rewrote it with let and const." }
] }
```

Hooks live in QuorX's data folder, not in the project, so a folder that is opened can't bring hooks of its own. A file
name the agent chose is passed to a hook only when it's a plain path; anything holding `;`, `$( )`, quotes or
backticks skips the hook, and the steps say why.

## Scheduled tasks

A schedule starts a normal chat on its own, such as every weekday at 9 in one project. A run missed while the computer
slept runs once when QuorX is back, labelled as missed. 🔒 Strict approvals wait for the user, and a schedule uses ⚡
YOLO only when YOLO was chosen for that schedule. Budgets apply, and two QuorX processes never both start a run.

## Memory

Memory is a short list of facts and preferences, such as "I use pnpm", that every chat gets. The whole list stays under
300 tokens, so small models can afford it. The agent can only **propose** a fact; it's saved only when the user says
yes, in YOLO too, where the deciders never answer it. Keys, tokens and passwords are refused. A model without tools,
or with under 16k of context, gets the facts but not the tool.

```callout
{ "tone": "info", "title": "The choices behind all four", "text": "Enforce in code, not in the prompt. Assume the model might be small. Keep the user's hooks, memory and review cards out of the agent's reach. And send everything through the same rules, approvals, budgets and Stop as the agent's own work." }
```

The longer version is in `docs/research/workflow-features.md`.
