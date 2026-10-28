---
title: Run a chat on your OpenCode or Cline account
date: 2026-10-28
summary: A chat's main model can now run through the OpenCode on your computer, with every provider you connected there, or on your OpenCode, Go or Cline account, with OpenRouter still behind everything else. How to connect, what it costs, and what happens when one fails.
tags: models, cost, setup
version: 0.2.14
---

If you use OpenCode or Cline, you can now use them in QuorX: the OpenCode on your computer with all the providers you
connected there, or your OpenCode and Cline accounts directly. A chat's main model runs on your plan or credits, and every tool, file, command, browser step, check and schedule works the same as on any other
model. Everything here is in **⚙ Settings → Models → OpenCode & Cline**.

## Three new places a model can run

| Source | What you pay with | Model ids look like |
|---|---|---|
| **OpenCode on this PC** | Whatever each provider you connected in OpenCode bills: your plans, keys and sign-ins | `opencode-local/deepseek/…` |
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

## Use the OpenCode on your computer

If OpenCode is installed, switch on **OpenCode on this PC**: no key needed. QuorX starts OpenCode's own server in the
background when a chat needs it (and stops it after a quiet quarter of an hour), and every provider you connected in
OpenCode with `opencode auth login` shows up in the picker, tagged **This PC**: on one test computer that was 597
models from 8 providers. OpenCode makes each call itself, so your plans and sign-ins work as they do in OpenCode.

OpenCode runs with its own tools off. QuorX describes its tools to the model, and the model writes its calls as text
that QuorX reads back (in QuorX's format, or the model's own, such as DeepSeek's). Each call is a fresh OpenCode session
that QuorX deletes afterwards, so your own session list stays as it was. **Test the connection** here only starts
OpenCode and lists its models: nothing to pay.

## Connect OpenCode's services with a key

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
{ "tone": "info", "title": "Free models, when they're allowed", "text": "Every model OpenCode and Cline offer is in the list, free ones included, tagged Free. Today both keep their free models for their own apps: OpenCode answers other apps with \"Free usage limit reached\", and Cline's free models work only inside Cline. QuorX asks under its own name and never pretends to be either app. When one says no, only that model is set aside: the step runs on OpenRouter and says so, and the rest of that source keeps working. If they open their free models to other apps, they simply work." }
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
