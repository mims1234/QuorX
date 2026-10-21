---
title: Agentic integrity in 0.2.7
date: 2026-10-21
summary: QuorX is built so an agent's work is checked, not trusted. What 0.2.7 measured across models, what broke one release earlier, and what changed, in one page with links to the full articles.
tags: research, models, safety, tests
version: 0.2.7
---

QuorX is built around one idea: **agentic integrity**. An agent's work should be checked, not trusted. Deciders vote
on what it may do. A reviewer opens and scores what it built. A safety layer guards every command. Benchmarks show
whether a change really helped. And because QuorX runs any model on OpenRouter, all of that has to hold for a
frontier model, a cheap fast one, and one that doesn't support tools at all.

QuorX 0.2.7 is 24 pull requests (#35 to #61, not counting #55, held for 0.2.8, and #60, the version bump). This page
sums them up. Every number comes from a pull request, a release note or a test run, and one-run results are labelled.

## Five releases in two days

```timeline
{ "items": [
  { "when": "20 Oct 15:29", "title": "Read the request in full", "text": "A prompt enhancer spells out what a request implies, and YOLO waits 15 seconds for you before the deciders answer.", "tag": "v0.2.3" },
  { "when": "20 Oct 18:05", "title": "Open source", "text": "Apache 2.0, with SHA-256 checksums and a signed build attestation on every release.", "tag": "v0.2.4" },
  { "when": "20 Oct 20:15", "title": "Locked down by default", "text": "Much harder to attack, but the data files were left unreadable.", "tag": "v0.2.5" },
  { "when": "20 Oct 21:14", "title": "Repaired at start", "text": "QuorX probes its own files when it starts and repairs them. Nothing was lost.", "tag": "v0.2.6" },
  { "when": "21 Oct", "title": "Checked work across models", "text": "A cache-friendly prompt, model cards, diff review, staged releases, and a QuorX that answers only this computer.", "tag": "v0.2.7" }
] }
```

## How QuorX checks an agent's work

```flow
{ "nodes": [
  { "id": "req", "title": "Your request", "sub": "read in full", "cap": "A small model spells out what the request implies. You see it under your message and can correct it." },
  { "id": "agent", "title": "The agent", "sub": "any OpenRouter model", "cap": "The agent works in your project with a real terminal and browser. It reads the card of the model it runs on." },
  { "id": "guard", "title": "The safety layer", "sub": "rules, approvals, Stop, Undo", "cap": "Every command is parsed and classed. Your rules decide, the rest comes to you, or to the deciders in YOLO." },
  { "id": "deciders", "title": "The deciders", "sub": "a quorum of small models", "cap": "They see only your words and facts the harness computed, never the agent's reasons." },
  { "id": "review", "title": "The reviewer", "sub": "opens, clicks, scores", "new": true, "cap": "Each build is opened and scored, and /review now reads code changes for bugs with file:line." },
  { "id": "bench", "title": "Benchmarks", "sub": "hidden checks, per model", "new": true, "cap": "Harder tasks with hidden checks show whether a change helped, model by model." }
], "loops": [{ "from": "bench", "to": "agent", "label": "what we change next" }] }
```

## Seeing integrity model by model

Every model behaves differently, so 0.2.7 shows QuorX's checks per model:

- **Model cards** for 18 models: limits, quirks, prompting tips from each provider's docs, and QuorX's own results. The
  agent reads the cards of the models it uses.
- **Cache-hit share per model** in the chat's usage view and the cost card, so it's clear which models really cost
  less over a long reply.
- **Looks before writing**, per model, in the *On this computer* table below: how many steps a reply reads before it
  writes anything.
- **A harder build benchmark** with hidden checks, so scores no longer sit at the ceiling.

The new checks are cheap on cheap models. On the same small tests, a fast model got the same correct result as a
frontier one:

```chart
{ "type": "pairs", "title": "Cost of the same correct result, two small tests each", "unit": "US cents", "x": ["/review: 2 planted bugs, 1 clean change", "Memory: propose a fact, then use it"], "series": [{ "name": "A frontier model", "values": [0.946, 1.76] }, { "name": "Fast model (DeepSeek V4.1 Flash)", "values": [0.031, 0.06] }] }
```

Both models found both planted bugs on the right lines with no false alarm, and both proposed a memory when expected
and not when not. Two tasks each show that the checks work on a cheap model, not how often.

```local
{ "view": "models" }
```

## The numbers

```stat
{ "items": [
  { "label": "Tests passing on main", "from": 214, "to": 271 },
  { "label": "Models with a model card", "from": 0, "to": 18 },
  { "label": "Hidden checks in the harder benchmark", "from": 0, "to": 26 },
  { "label": "Pull requests in 0.2.7", "from": 0, "to": 24 }
] }
```

The helpers were offered in all 151 runs, across 8 builder models, and never called. So 0.2.7 offers them only in
projects with 40 or more files. [A smaller, cache-friendly agent prompt](articles/a-cache-friendly-prompt) has the
rest.

## The articles

- [A smaller, cache-friendly agent prompt](articles/a-cache-friendly-prompt): why the conversation is the cost, and a
  benchmark that can still tell.
- [Deciders vs creativity](articles/deciders-vs-creativity): literal checkers turn down what a request only implies.
- [When a security hardening broke the data](articles/when-hardening-broke-the-data): a post-mortem of 0.2.5.
- [Shipping safer](articles/shipping-safer): tests on every pull request, staged releases, and this computer only.
- [Building a release in parallel](articles/building-a-release-in-parallel): how the pull requests came together.
- [Four workflow features](articles/four-workflow-features): diff review, hooks, schedules and memory, for any model.
