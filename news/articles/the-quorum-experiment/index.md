---
title: The quorum experiment
date: 2026-10-20
summary: QuorX began as one question. Can a cheap model do better by asking a quorum of fast decider models? How QuorX measures that on every question, what the first benchmarks found, what isn't known yet, and where any computer running QuorX shows the same numbers for itself.
tags: deciders, models, research, cost
---

QuorX is named after the idea it was built to test. Every chat runs one model of the user's choice, often a cheap one. Behind it sit **deciders**: small, fast models that never write text. They only judge. They answer a typed question (yes or no, pick an option, rate on a scale) with a probability, in about half a second, for a tiny fraction of a cent.

The experiment is this: **can a small, cheap model get stronger by writing its own questions for a quorum of deciders**, instead of relying on its own judgment? This article explains how QuorX measures that, what we know so far, and what we don't.

## Why it's hard to measure

If an agent asks a question and then does the right thing, did asking help? There is no way to tell. Maybe it already knew. Maybe the deciders agreed with a wrong idea. Most systems that consult other models can't answer this, because the asking model never says what it thought before it asked.

QuorX makes it say. For **every** question, the agent must commit its own answer and how sure it is, before the deciders reply. Then the trace can show, question by question, whether asking changed anything.

```flow
{
  "nodes": [
    { "id": "need", "title": "The agent hits a judgment", "sub": "what does the user mean? which approach?", "cap": "The agent chooses when to ask. It is told to ask when a judgment matters and it isn't sure, and not to ask what it already knows." },
    { "id": "guess", "title": "It writes its own guess first", "sub": "my_guess · my_confidence", "new": true, "cap": "Each question carries the agent's own answer and a confidence from 0 to 1. Without them, the question is refused." },
    { "id": "ask", "title": "Three deciders answer", "sub": "options shuffled per decider", "cap": "Jev 1.14, Liquid d1-ultra and GPT-6 Luna Decisions. They see the user's latest message word for word, the agent's short notes marked as unverified, and the question. Nothing else." },
    { "id": "agg", "title": "Their votes are combined", "sub": "a pick and a confidence", "cap": "If they can't settle it (confidence below 0.5), the answer is 'unsure'." },
    { "id": "label", "title": "The question gets a label", "sub": "already knew · confirmed · changed · unsure", "new": true, "cap": "QuorX compares the guess with the deciders' pick. The label goes into the trace and into logs/decisions.jsonl." },
    { "id": "use", "title": "The agent carries on", "sub": "follows a settled disagreement", "cap": "If the deciders settle on something different, the agent is told to follow them unless it has concrete evidence they are wrong." }
  ]
}
```

## The four labels

Each question ends up with one label. The code calls them `theater`, `confirmed`, `flipped` and `unclear`; the trace shows them in plain words.

| Label | When | What it says about asking |
|---|---|---|
| **Already knew** (theater) | The deciders agreed with a guess the agent was at least 80% sure of | Asking cost time and money and changed nothing |
| **Confirmed** | The deciders agreed with a guess the agent was less sure of | Asking may have helped: it turned a doubt into a decision |
| **Changed answer** (flipped) | The deciders settled on a different answer than the guess | This is where asking pays off, or does harm |
| **Deciders unsure** (unclear) | The deciders couldn't settle it | No signal either way |

A fifth case is bookkeeping: if the agent's guess doesn't match any of the options it offered, the question can't be scored.

"Changed answer" is the interesting label, and it cuts both ways. It is only good if the deciders were right. In the benchmarks below we know the right answer, so we can tell; in a normal chat we can't, and nobody is checking.

## What the benchmarks found

QuorX has a benchmark (`scripts/bench.mjs`) with tasks whose answers are known: famous riddles changed so the memorised answer is wrong, classic reasoning traps, everyday physics, and judgments with a clear best option. It compares setups on the same model and the same tasks:

- **A**: the small model alone;
- **C**: the small model must ask the deciders first, guessing first;
- **D**: the small model writes three drafts and the deciders pick one;
- **E**: a frontier model alone (Claude Opus 5.5), as a reference.

These runs are from 18 October and cost about $0.45 (first set) and $0.40 (hard set) in total; every number below is from the results tables in QuorX's README.

```chart
{ "src": "results.json", "path": "hard" }
```

Ling and Qwen: 2 runs each. DeepSeek: 1 run. Claude Opus 5.5 alone scored 100% on the same set, at $0.0070 per task.

On the first set of 41 tasks the picture was similar: Ling went from 91–94% alone to 98–99% asking first, Qwen from 87–89% to 88–89%, and DeepSeek stayed at 98%. What that suggests:

- **A strong small model gains nothing.** DeepSeek V4.1 Flash already gets these right. On the first set, 42 of its 45 decider questions were "already knew". For it, asking is pure overhead.
- **For weaker models, it depends on the model.** Ling asked questions that really changed its answers: across both sets, 7 changes in 79 questions, all of them to the correct answer. Asking first put it within 1–2 points of Opus, at about a fiftieth of the price on the first set. Qwen mostly asked questions that echoed its own first reading, so asking didn't move it on the first set.
- **Asking first costs very little.** Per task, C cost about $0.0001 to $0.0007 and took 3.5 to 6 seconds.

The benchmarks also caught a real flaw. The deciders used to see only the agent's retelling of the question. Qwen retold a modified riddle as the classic one, and the deciders confirmed the classic, wrong answer. Showing them the user's own words wasn't enough on its own, because a confident note from the agent still pulled them toward its answer. With the agent's notes marked *unverified* and a rule that the user's message wins, the same deciders moved from 77% to 4% on the wrong answer. QuorX now does both.

## What we don't know yet

```callout
{ "tone": "warn", "title": "Small numbers", "text": "Each set has about 40 tasks, run once or twice per model. A difference of 1 to 3 tasks is inside the noise; the small model alone flips between runs. Only the trap tasks really separate the setups, and many of those riddles are probably in the models' training data." }
```

- **Whether asking helps on real work.** The benchmarks are short questions with one right answer. QuorX's chats are builds, fixes and decisions with no answer key. In the first measured chats (18 October), every question was "already knew" or "deciders unsure", with no "changed answer" at all. Those prompts were too easy to tell anything apart.
- **Whether the agent asks the right questions.** Since there are no strategy presets any more, the agent chooses when to ask. A model that only asks what it already knows will log a lot of "already knew" and gain nothing. The labels will show that, but only once there are enough of them.
- **Whether forced asking holds.** In the benchmark's "must ask first" setup, DeepSeek skipped the forced question in 2 of 10 runs. The benchmark now sends it back once and counts a second refusal as *skipped*.
- **Whether a quorum beats one good decider.** QuorX's benchmarks haven't compared the two.

The next step on the benchmark side is a harder, fresher task set: longer requests with several constraints, and checks on things the agent actually built.

## On this computer

Every question any chat on a computer asks is written to its `logs/decisions.jsonl` with the guess, the confidence, the deciders' pick and the label. That file never leaves the computer and is never written into News. The block below reads it when this page opens:

```local
{ "view": "deciders" }
```

Mostly "already knew" means the chat model rarely needs the deciders for the questions it chooses to ask, and the asking buys a little reassurance at a small price. Frequent "changed answer" is worth a look at a few of those questions in the trace: those are the moments where the experiment either worked or went wrong, and only the person who asked can tell which.

## Why this is the founding question

Cheap models are good enough for most of a coding task and wrong at a few critical moments. If a few cents of fast, independent judgment at those moments closes most of the gap to a frontier model, a harness built on cheap models becomes the sensible default. If it doesn't, that is worth knowing too. Either way, the only honest way to find out is to make the model say what it thought before it asked, and count.
