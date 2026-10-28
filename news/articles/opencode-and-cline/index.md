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

Once a source is connected, its models show in the chat model pickers, tagged **OpenCode**, **Go** or **Cline**. The
**Where it runs** switch at the top of the picker shows one source at a time, so a long list stays short.

## What runs where

Only the chat's main model runs on the source (its summaries of a long chat too). Deciders, paid media, the prompt
enhancer, helpers and the reviewer stay on OpenRouter, so you still need an OpenRouter key.

You can switch a chat between OpenRouter and a source at any time. The conversation carries over.

```flow
{ "nodes": [
  { "id": "connect", "title": "Connect a source", "sub": "paste a key, test it", "cap": "Paste an OpenCode or Cline API key in Settings and press Test the connection." },
  { "id": "pick", "title": "Pick its model", "sub": "tagged OpenCode, Go or Cline", "cap": "Choose a source model in the chat's model picker. Where it runs filters the list to one source." },
  { "id": "run", "title": "The main model runs there", "sub": "your plan or credits", "cap": "Each step of the reply calls the source. Tools, files, commands and checks work as usual." },
  { "id": "fail", "title": "If a call fails", "sub": "one retry, then it stops and says why", "new": true, "cap": "A hiccup gets one quick retry. If it still fails, the reply stops and says which model failed and why; you pick the next model. A fallback to OpenRouter is there only if you choose one." },
  { "id": "rest", "title": "Everything else", "sub": "on OpenRouter", "cap": "Deciders, paid media, the prompt enhancer, helpers and the reviewer keep running on OpenRouter." }
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
2. Paste it in QuorX, in the OpenCode card or the OpenCode Go card. One key from a Personal workspace serves both:
   QuorX offers it to the other card too, so to use both, tick the other one as well.

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
`/inference`), and Cline's CLI updated itself twice in one day. QuorX never crashes over it, and it never switches
your model behind your back.

- **A hiccup** (a rate limit with a short wait, a server error, a dropped connection) gets one quick retry.
- **Then the reply stops** and says which model failed and why (an expired key, a used-up plan, a free model the source
  keeps for its own app). The work done so far stays. Pick another model in the chat's model button and send a message
  to carry on: the conversation carries over.
- **A model that keeps failing** is skipped by every chat for a while instead of each one waiting on it: until its
  plan window resets or for up to 30 minutes, and under 5 minutes after a server error. Only a refused key, spent
  account credit or an unreachable gateway skips the whole source; one Go model reaching its limit leaves the others
  working.
- **Answers QuorX can't read** count as failures too: a web page from a CDN, an empty stream, a shape it doesn't know.

Any text streamed before a failure moves into the steps, so the reply isn't written twice. No tool call from a failed
answer ever runs.

If you'd rather have the reply carry on by itself, choose a fallback in **⚙ Settings → Models → OpenCode & Cline →
When a call fails**: **Same model on OpenRouter** (for example `opencode-go/glm-5.3` becomes `z-ai/glm-5.3`) or
**Always this model**. A step that falls back shows ⤵ with why, and costs OpenRouter's price.

```compare
{ "prompt": "Go hits its 5-hour limit halfway through a reply", "options": [
  { "label": "Stop and tell me (the default)", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "The reply stops there", "text": "and says which model and why" },
    { "title": "You choose", "text": "wait for the window, or pick another model in the chat's model button" }
  ], "verdict": { "title": "Nothing changes behind your back", "text": "The work so far stays, nothing is spent elsewhere, and the chat carries on with the model you pick." } },
  { "label": "Same model on OpenRouter", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "QuorX skips that Go model for the rest of the reply", "text": "and the next step runs z-ai/glm-5.3 on OpenRouter" },
    { "title": "The steps show ⤵", "text": "with why, and what OpenRouter charged" }
  ], "verdict": { "title": "The reply finishes by itself", "text": "Same model, same conversation, paid on OpenRouter until Go's window resets. Then Go is tried again." } }
] }
```
