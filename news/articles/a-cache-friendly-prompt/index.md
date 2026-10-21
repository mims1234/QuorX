---
title: A smaller, cache-friendly agent prompt
date: 2026-10-21
summary: 0.2.7 reorders the agent's prompt so its stable parts are cached on every step, offers helpers only where they help, and counts how long a reply reads before it writes. The honest headline: the conversation is the cost, not the system prompt.
tags: cost, models, research
version: 0.2.7
---

In 0.2.7 the agent's prompt got smaller and was put in a new order: the parts that never change come first. Helpers
are offered only where they can help. And QuorX now counts how long a reply reads before it writes anything. The
honest headline is that **the system prompt is a small slice of what a step costs**. The rest of this page explains
why.

## What a step's prompt is made of

Measured on builds with DeepSeek V4.1 Flash as the builder:

| Part | Size |
|---|---:|
| System prompt, first step | about 2.8k–3.4k tokens |
| Tool definitions | about 5.3k–5.5k tokens |
| File list (60 files) | at most about 340 tokens |
| Skills list | about 340 tokens |
| Helper rules plus the `delegate` tool | about 335 tokens |
| Builder prompt per call, over a whole build | 45k–58k tokens |
| Share of it read from the provider's cache | 92–98% |

The prompt grows because the conversation grows: every tool call and every result stays in it.

## Why cache hits matter

Providers cache the start of a prompt. When the next call begins with the same tokens, they are read from the cache,
which most providers bill at a fraction of the normal input price. A call is only as cacheable as its longest unchanged
start: change one line near the top, and everything after it is a miss. So 0.2.7 orders the prompt from the most
stable part to the least.

```flow
{ "nodes": [
  { "id": "rules", "title": "Rules", "sub": "the same in every reply", "cap": "First, so they are cached for every step of every reply." },
  { "id": "state", "title": "Project state", "sub": "toolchains, files, servers", "new": true, "cap": "Fixed for the length of a reply. The file list is grouped by folder." },
  { "id": "memory", "title": "Project memory", "sub": "AGENT.md, work log, skills", "new": true, "cap": "Also fixed for a reply. Skills are listed by name, with descriptions only for the ones the request mentions." },
  { "id": "deciders", "title": "Decider rules", "sub": "switch on mid-reply", "cap": "Last of the system prompt, because they can change during a reply." },
  { "id": "talk", "title": "The conversation", "sub": "grows every step", "cap": "The biggest part by far, and mostly cache reads from the second step on." }
] }
```

We kept one thing we were tempted to drop. Removing the file list after the first step would save 100–300 tokens a
step, but changing the system prompt mid-reply breaks the cached start. At a 92–98% cache share, the miss costs more
than those tokens, which are almost all cheap cache reads anyway.

Before reordering, the whole system prompt was compared line by line on both versions. Every rule line is the same,
including the rules for untrusted content and commands.

Since 0.2.7, the chat's usage view and the cost card show the cache-hit share for each model, such as "80% cached".
It turns green at 50% or more. A model whose provider doesn't report caching shows nothing, not a misleading 0%.

## Helpers only for big projects

QuorX can hand a side task to a helper with the `delegate` tool. In 151 build-benchmark runs, across 8 builder models,
all with helpers on, `delegate` was called **0 times**. Offering helpers still cost about 335 tokens on every step,
plus a nudge after 3 steps of reading that pointed the agent at a tool it then didn't use. So helpers are now offered
only in projects with at least 40 files: a setting under *Agent loop → Helpers*, where 0 means always.

## The slow start, per model

Some models read, search and browse for many steps before they write their first file. Each reply now records how
many steps only looked before the first write. The table below shows it per model, from this computer's own replies.

```local
{ "view": "models" }
```

## The measurement

#58 compared the prompt before and after on the build benchmark's standard tasks (snake with portals and a sales
dashboard), judged the stricter way #51 introduced: builder DeepSeek V4.1 Flash, one run of each task per version, one
after the other on a quiet machine.

```chart
{ "type": "pairs", "title": "Build benchmark, as reported in #58", "x": ["Tasks passed (of 2)", "Score sum (of 25)", "Cost per run (US cents)"], "series": [{ "name": "Before", "values": [1, 13.5, 12.7] }, { "name": "After", "values": [2, 17.0, 9.4] }] }
```

```callout
{ "tone": "info", "title": "Read this with care", "text": "One run of each task per version is not enough to call it a win. Most of the gap between single runs is run-to-run variation: the system prompt is a small part of each call. The goal was a smaller prompt with no drop in score, and the score didn't drop." }
```

## A benchmark that can still tell

The old build tasks scored 19–20 out of 20, and a benchmark at its ceiling can't show whether a change helps. #51
added three harder tasks with **hidden checks** the builder never sees: a three-page trip planner (8 checks), a budget
tracker with six planted bugs of which the request names three (7), and a Python command-line tool with CSV edge cases
(11). The share of checks that pass caps the function score, and a stricter originality score rewards results that
are distinct, not just complete.

```chart
{ "type": "bar", "title": "Harder tasks on DeepSeek V4.1 Flash, best of two runs (five scores out of 5)", "unit": "of 25", "x": ["trip_planner", "fix_budget", "py_ledger"], "series": [{ "name": "Score", "values": [19, 17, 14] }] }
```

Each hidden check was tried against a reference solution (all pass) and against the planted bugs (they fail). The
whole validation cost $0.31. It also found a real problem: in YOLO, an approval the deciders aren't sure of waits for
the user, and in a benchmark nobody answers. The benchmark now declines such a wait after a minute.

```callout
{ "tone": "good", "title": "What we learned", "text": "The conversation is the cost, so order the prompt for the cache and don't change its start mid-reply. Measure before you offer a tool: one nobody calls still costs tokens on every step. And keep the benchmark off its ceiling." }
```

Pull requests: #42, #51 and #58. The longer version is in `docs/research/cache-friendly-prompt.md`.
