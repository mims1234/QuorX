---
title: Deciders vs creativity
date: 2026-10-21
summary: Strict deciders see only the user's words, so they turned down what a request only implies, like the voice-over in a 30-second movie. How a prompt enhancer, a 15-second wait, production plans and model cards fixed that without loosening the judge.
tags: deciders, research, safety, models
version: 0.2.7
---

In ⚡ YOLO, QuorX doesn't ask the user about every paid call or risky command. A quorum of small **decider** models
votes instead. They are strict on purpose. They see only the user's own messages and facts the harness computed, never
the agent's reasons, because the agent's text is where injected instructions hide.

That strictness has a cost. Literal readers turn down what a request only implies.

## "Make a 30-second movie"

Ask for a 30-second movie, and the agent plans clips, a narration, music and sound. Each paid call then goes to the
deciders with one question: did the user's messages ask for this?

```compare
{ "prompt": "make a 30-second movie about a cat", "options": [
  { "label": "Before", "steps": [
    { "title": "Make a video clip?", "text": "Yes: a movie is video." },
    { "title": "Make a voice-over?", "text": "No: the user never asked for speech.", "bad": true },
    { "title": "The movie has no narration", "text": "Nothing in the words said otherwise.", "bad": true }
  ], "verdict": { "title": "Right by the rules, wrong for the user", "text": "Most people asking for a movie would be disappointed by one with no voice." } },
  { "label": "After", "steps": [
    { "title": "The enhancer reads the request", "text": "Goal: a 30-second short movie. Includes: narration (speech), background music, sound effects." },
    { "title": "The user sees that reading", "text": "Under the message, where it can be corrected or dropped." },
    { "title": "The deciders read it too", "text": "\"Asked for, or clearly implied\": the voice-over counts." }
  ], "verdict": { "title": "The movie the user meant", "text": "The judge still sees only the user's words, in a fuller reading." } }
] }
```

We didn't want to weaken the judge. Letting it read the agent's plan would bring back the injection risk. So we gave it
a better reading of the user's words instead.

## The prompt enhancer

A cheap model reads the request, and only the request, and answers with three parts: the **goal** in one sentence,
what the result **includes** even though the request doesn't say it, and the **assumptions** it chose for what the
request leaves open (length, style, shape). Its rule for "implied" is simple: most people asking this would be
disappointed without it. It never sees the agent's text, tool output, files or attachments.

The reading goes to the user (under the message), to the agent (as a note on the request) and to the deciders (beside
the user's own messages, labelled as written by the harness, never by the agent).

## A person can still steer

In YOLO, a question or an unsettled approval now waits 15 seconds, with a countdown, before the deciders answer or
the reply carries on. *Wait for me*, or typing in the card, stops the clock. The time is a setting under Budget &
approvals. The wait never approves anything by itself: a split vote still comes to the user.

```flow
{ "nodes": [
  { "id": "q", "title": "A question or an unsettled approval", "cap": "Something the agent can't settle on its own." },
  { "id": "wait", "title": "15-second countdown", "sub": "you can answer", "new": true, "cap": "You can answer, or press Wait for me to keep it for yourself." },
  { "id": "vote", "title": "The deciders vote", "sub": "only your words and facts", "cap": "When the time is up, the deciders answer from your words and the harness's facts." },
  { "id": "go", "title": "Settled: carry on", "sub": "split or unsure: back to you", "cap": "A settled vote goes on. A split or unsure vote waits for you." }
] }
```

## One plan, not twenty calls

A trailer needs paid pieces nobody names: stills, clips, a voice-over, music. Each call was judged on its own, so
literal deciders still turned down the in-between steps. Now the agent lists the paid calls up front in a
**production plan**. QuorX prices it with the same estimates the single-call cards use.

- In 🔒 Strict, the plan is one card: a row per kind, and the total. Approve, Always allow or Decline.
- In ⚡ YOLO, the deciders judge the whole plan once: is it what the request asks for or clearly implies, is it a
  sensible way to make it, and is the total reasonable?

Matching calls then run without another vote: same kind and model, calls left, and no more than 20% over the planned
price, per call and in total. Anything off the plan is judged on its own, and budgets still apply first.

```ledger
{ "rows": [
  { "gain": "One decision with a price", "gainText": "A trailer is approved once, by the user or the deciders, instead of call by call.", "cost": "A plan can be wrong", "costText": "The agent may need a call it didn't plan.", "mitigation": "Calls off the plan or over its estimate are judged on their own." },
  { "gain": "Implied parts count", "gainText": "The enhancer's reading lets a voice-over count as asked for.", "cost": "A reading can overreach", "costText": "The enhancer might imply something the user didn't want.", "mitigation": "It shows under the message, where the user can correct or drop it." }
] }
```

## Knowing the model's limits

Creativity also fails in duller ways. The agent picked settings and wrote prompts without knowing a model's limits.
Veo takes only 4, 6 or 8 seconds. Lyria Clip is always 30 seconds. Eleven Flash misreads numbers. Recommended and
default models now carry a **model card** with their limits, quirks and the provider's own prompting tips. The agent
gets only the cards of the models it is using, at most about 250 tokens each, and nothing is fetched while it runs.

```callout
{ "tone": "good", "title": "What we learned", "text": "Don't loosen the judge: give it a better reading of the user's words, and show that reading to the user. Approve the plan, not each step. A short wait lets a person steer the big choices without giving up YOLO." }
```

Pull requests: #44 (production plans) and #52 (model cards); the enhancer and the wait arrived in 0.2.3. The longer
version is in `docs/research/deciders-vs-creativity.md`.
