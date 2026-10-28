---
title: Run a chat on your OpenCode or Cline account
date: 2026-10-28
summary: A chat's main model can now run on your own OpenCode, OpenCode Go or Cline account, with OpenRouter still there for everything else. How to connect, what runs where, what it costs, and what happens when one of these services has a bad moment.
tags: models, cost, setup
version: 0.2.14
---

If you already pay for OpenCode or Cline, you can now use that account in QuorX. A chat's main model runs on your
plan or credits, and every tool, file, command, browser step, check and schedule works the same as on any other
model. Everything here is in **⚙ Settings → Models → OpenCode & Cline**.

## Three new places a model can run

| Source | What you pay with | Model ids look like |
|---|---|---|
| **OpenCode** | Pay as you go on OpenCode Console (formerly Zen) | `opencode/…` |
| **OpenCode Go** | A $10/month plan, with usage limits per model in a 5-hour, a weekly and a monthly window | `opencode-go/glm-5.3` |
| **Cline** | Your Cline credits; ClinePass models are paid by that plan | `cline/…` |

Once a source is connected, its models show in every model picker, tagged **OpenCode**, **Go** or **Cline**. The
**Where it runs** switch at the top of the picker shows one source at a time, so a long list stays short.

## What runs where

Only the chat's main model runs on the source, plus the helper or reviewer if you pick a source model for them.
Deciders, paid media, the prompt enhancer, and helpers and the reviewer on their usual models stay on OpenRouter, so
you still need an OpenRouter key.

You can switch a chat between OpenRouter and a source at any time. The conversation carries over.

```flow
{ "nodes": [
  { "id": "connect", "title": "Connect a source", "sub": "paste a key, test it", "cap": "Paste an OpenCode or Cline API key in Settings and press Test the connection." },
  { "id": "pick", "title": "Pick its model", "sub": "tagged OpenCode, Go or Cline", "cap": "Choose a source model in the chat's model picker. Where it runs filters the list to one source." },
  { "id": "run", "title": "The main model runs there", "sub": "your plan or credits", "cap": "Each step of the reply calls the source. Tools, files, commands and checks work as usual." },
  { "id": "fail", "title": "If a call fails", "sub": "one retry, then ⤵ OpenRouter", "new": true, "cap": "A hiccup gets one quick retry. If it still fails, that step goes to OpenRouter and the steps show ⤵ with why. The chat never stops for it." },
  { "id": "rest", "title": "Everything else", "sub": "on OpenRouter", "cap": "Deciders, paid media, the prompt enhancer, and helpers and the reviewer on their usual models keep running on OpenRouter." }
] }
```

## Connect OpenCode

1. Open [OpenCode Console](https://opencode.ai/console), go to **Account → Personal API keys** and press
   **Add API key**. The key starts with `oc_sk_`.
2. Paste it in QuorX. One key from a Personal workspace serves both pay as you go and Go.

If OpenCode on your computer already has a key (from `opencode auth login`), press **Use the key OpenCode has** and
QuorX copies it. It only ever copies an API key, never a sign-in. Installing OpenCode isn't needed; if you want it,
it's `npm i -g opencode-ai`.

## Connect Cline

1. Open [app.cline.bot](https://app.cline.bot), go to **Settings → API Keys** and create a key. It's shown once, so
   copy it then.
2. Paste it in QuorX.

QuorX never uses the Cline app's own sign-in. That token lasts about an hour, and refreshing it from another app would
sign the Cline app out. The Cline CLI (`npm i -g cline`) is optional and not needed. Cline's own docs are at
[docs.cline.bot](https://docs.cline.bot).

## Test the connection

**Test the connection** checks the key before you rely on it. For Cline it asks Cline's account page: no model call,
nothing to pay. For OpenCode it makes a tiny call to the cheapest model: nothing on Go, well under a cent pay as you go.

Keys stay on this computer, in QuorX's data folder. The Settings page only sees them masked, and the agent's processes
never get them.

```callout
{ "tone": "warn", "title": "No free models here", "text": "OpenCode's free models (Big Pickle and the -free ones) are kept for OpenCode itself; any other app gets \"Free usage limit reached\". Cline's free models work only inside Cline's own apps. So QuorX doesn't list either." }
```

## How QuorX talks to them

OpenCode serves its models in four API formats: OpenAI chat completions, OpenAI Responses, Anthropic Messages and
Google Gemini. QuorX reads which one each model uses from models.dev, the same catalogue OpenCode reads, and speaks
that format. Models the gateway no longer serves are dropped from the list. Cline speaks OpenRouter's format.

QuorX identifies itself honestly: its own User-Agent and, for OpenCode, a steady session id per chat (Go asks for
one). It never borrows another app's identity. OpenCode says Go is meant for coding agents and watches its traffic.

## What it costs

OpenCode and Cline report each call's cost, and QuorX counts it in the reply, the project and your daily caps. Go
calls count $0, since the plan pays, and each step shows what it counted against the plan at list price.

## When it fails

These services change often. While this was being built, OpenCode moved its gateway address twice (from `/zen/v1` to
`/inference`), and Cline's CLI updated itself twice in one day. So QuorX never stops a chat because a source failed.

- **A hiccup** (a rate limit with a short wait, a server error, a dropped connection) gets one quick retry.
- **Then the step goes to OpenRouter.** By default it's the same model on OpenRouter when it has it (for example
  `opencode-go/glm-5.3` becomes `z-ai/glm-5.3`), otherwise a fallback model you choose, otherwise the default chat
  model. The reply's steps show ⤵ with why.
- **A source that refuses its key, runs out of credit or plan usage, or fails twice in a reply** is skipped for the
  rest of that reply. Other chats skip it for a short while instead of waiting, and the next reply tries again.
- **Answers QuorX can't read** count as failures too: a web page from a CDN, an empty stream, a shape it doesn't know.

Any text streamed before a failure moves into the steps, so the reply isn't written twice. No tool call from a failed
answer ever runs.

You choose what happens in **⚙ Settings → Models → OpenCode & Cline → When a call fails**: **Same model on
OpenRouter**, **Always this model**, or **Stop and tell me**, which spends nothing on OpenRouter and keeps the work
done so far.

```compare
{ "prompt": "Go hits its 5-hour limit halfway through a reply", "options": [
  { "label": "Same model on OpenRouter", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "QuorX skips Go for the rest of the reply", "text": "and the next step runs z-ai/glm-5.3 on OpenRouter" },
    { "title": "The steps show ⤵", "text": "with why, and what OpenRouter charged" }
  ], "verdict": { "title": "The reply finishes", "text": "Same model, same conversation, paid on OpenRouter until Go's window resets. The next reply tries Go again." } },
  { "label": "Stop and tell me", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "The reply stops there", "text": "and says why", "bad": true },
    { "title": "Nothing is spent on OpenRouter", "text": "you decide whether to wait, switch model or switch source" }
  ], "verdict": { "title": "Nothing extra spent", "text": "The work waits for you. Switch the chat to OpenRouter, or come back when the window resets." } }
] }
```
