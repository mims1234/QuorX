---
title: Models: which ones build, and what a working build costs
date: 2026-10-20
summary: The build benchmark's leaderboard (pass rate, cost per working build, steps and time per model), the decider experiment explained, and the same numbers from the computer QuorX runs on.
tags: models, cost, deciders, research
order: 1
---

QuorX runs any model through OpenRouter, so the useful question is not "which model is best" but "which model builds
a given job, for how much". This report answers it with numbers from QuorX's own benchmarks, and shows the same
numbers for the replies run on this computer, from its logs.

```callout
{ "tone": "info", "title": "For choosing a model, start with OpenRouter's rankings", "text": "QuorX's own benchmark is small: a few tasks on a few models, run when a change needs measuring. For which models people actually use for coding and agents, and how they compare, see OpenRouter's rankings at https://openrouter.ai/rankings. Every model QuorX lists comes from OpenRouter, with its price, so the two line up." }
```

## How models are compared

The build benchmark gives every model the same tasks from `bench/tasks-build.json`: games, a dashboard and forms
(snake with portals, a sales dashboard, an invoice builder, 2048, a kanban board and more). Each run goes through the
real QuorX agent in a throwaway folder, with its plan, its checks and its reviewer, exactly as in a chat. Then a judge
model, which sees only the request, plays the build in a headless browser and scores it from 1 to 5 on function,
craft, design and originality. A build **passes** when all four reach the bar (3 by default).

```flow
{ "nodes": [
  { "id": "task", "title": "A task", "sub": "the same request for every model", "cap": "Every model gets the same request from bench/tasks-build.json." },
  { "id": "build", "title": "The agent builds", "sub": "plan, write, check, review", "cap": "The full QuorX agent builds it in a fresh folder: the same steps, checks and reviewer as in a chat." },
  { "id": "judge", "title": "A judge plays it", "sub": "headless browser", "cap": "A judge model opens the build, plays it and scores function, craft, design and originality." },
  { "id": "score", "title": "Pass or fail", "sub": "all four at the bar", "cap": "A build passes when all four scores reach the bar. Cost, steps and time are recorded with it." }
] }
```

The numbers that matter for choosing a model:

- **Pass rate**: the share of runs whose build passed.
- **Cost per working build**: everything the runs cost, divided by the builds that passed. A cheap model that fails
  most tasks can cost more per working build than a dearer one that passes.
- **Steps** and **minutes**: how long the agent worked on each build.

The builders tried are listed in `bench/models-build.json`, from free models to frontier ones. Running the benchmark
spends real money on OpenRouter, so it only runs when someone chooses to, with a spending cap.

## Leaderboard

From 4 build runs (`bench-build-2026-10-20T23-13-27.json`, `bench-build-2026-10-21T00-03-03.json`). Each run is one task from `bench/tasks-build.json`, built by the full QuorX agent in a throwaway folder; a judge model then plays the build and scores it. A build passes when function, craft, design and originality all reach the bar.

| Model | Runs | Passed | Cost per run | Cost per working build | Steps | Minutes |
|---|---|---|---|---|---|---|
| deepseek/deepseek-v4.1-flash-1017 | 4 | 100% | US$0.094 | US$0.094 | 94.5 | 8.6 |

```chart
{"src":"bench.json","path":"passChart"}
```

```chart
{"src":"bench.json","path":"costChart"}
```

## The decider experiment

QuorX started from one question: **can a cheap model get stronger by asking a quorum?** Next to the model that writes
the reply, QuorX keeps a panel of *deciders*: other models it can ask a short question, such as "the page shows a
start button" or "the answer is 42". Each decider gives its own probability; the panel's answer is their combined
vote, and a split or unsure panel says so instead of guessing.

The agent asks with its own guess and how sure it is. Comparing the guess with the panel's answer sorts every
question into one of four buckets:

| Bucket | What happened | What it says about asking |
|---|---|---|
| **Confirmed** | The panel agreed with a guess the agent wasn't sure of | Worth asking: the agent goes on with more certainty |
| **Flipped** | The panel disagreed with the agent's guess | The case asking exists for: the answer changed |
| **Theater** | The agent was already sure (80% or more) and the panel agreed | Asking cost money and changed nothing |
| **Unclear** | The panel couldn't agree, or too few votes came back | No help either way |

The known-answer benchmark (`bench/tasks.json` and `bench/tasks-hard.json`: trick questions, traps and puzzles with
one right answer) measures it directly. The same small model answers alone (setup **A**), asks the deciders first
(setup **C**), or writes three drafts for the deciders to pick from (setup **D**); a frontier model alone (setup
**E**) shows the ceiling. If C or D closes the gap to E for much less money, the quorum works.

```callout
{"tone":"warn","title":"What counts as a win","text":"Asking only helps when it flips a wrong answer. A run full of theater costs more and changes nothing, so the experiment reports the buckets next to the accuracy, not accuracy alone."}
```

## The decider experiment: the numbers

No run of the known-answer benchmark has been published here yet. It compares the same small model alone (setup A) with the small model asking the deciders (setup C), three drafts picked by the deciders (D), and a frontier model alone (E). It costs money too:

```terminal
{"title":"Run the decider experiment","lines":[{"cmd":"node scripts/bench.mjs --setups A,C,E --limit 10"},{"cmd":"node scripts/news-data.mjs"}]}
```

## On this computer

These numbers come from this computer only: every reply QuorX ran here is logged in `logs/runs.jsonl`, and every
question the deciders answered in `logs/decisions.jsonl`, `logs/checks.jsonl` and `logs/approvals.jsonl`. They never
leave the computer and are never written into News. Below: the models used here over the last 90 days (the pass rate
counts replies whose checks before the final answer passed), then what asking the deciders changed.

```local
{"view":"models"}
```

```local
{"view":"deciders"}
```

What QuorX spent here, per day and per model, over the last 30 days:

```local
{"view":"costs"}
```
