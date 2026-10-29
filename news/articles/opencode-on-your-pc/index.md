---
title: Run a chat through OpenCode on your PC
date: 2026-10-28
summary: A chat's main model can now run through the OpenCode app on your computer, with every provider you connected there, and OpenRouter behind the rest by default. How to switch it on, what it costs, and what happens when a call fails.
tags: models, cost, setup
version: 0.2.14
---

If you use OpenCode, QuorX can now run a chat through it: every provider you connected in OpenCode (your plans, keys
and sign-ins) shows up in QuorX's model picker. A chat's main model runs there, and every tool, file, command, browser
step, check and schedule works the same as on any other model. Everything here is in **⚙ Settings → Models → Apps on
this PC**.

## Switch it on

QuorX finds OpenCode on this computer and the providers you already connected in it. Tick **OpenCode on this PC** and
press **Test the connection**: it shows how many models OpenCode offers and from which providers. Nothing to pay, and
QuorX holds no key for it. If OpenCode isn't installed yet, the page shows the command: `npm i -g opencode-ai` (in Windows
itself, not only in WSL: QuorX looks for it on the Windows PATH). To add a provider, run `opencode auth login` in a
terminal, then test the connection again.

| What you connected in OpenCode | What you pay with | Model ids look like |
|---|---|---|
| A provider's API key (DeepSeek, OpenRouter, NVIDIA…) | That provider's prices, on your key | `opencode-local/deepseek/…` |
| A plan (OpenCode Go and others) | The plan: nothing per call here | `opencode-local/opencode-go/…` |
| Another provider's free tier | Nothing, while the provider allows it | `opencode-local/…` |

OpenCode's own free models (its **OpenCode** provider, at no price) answer only inside OpenCode's own app. They show
in QuorX's picker but locked: hover or click says why, and a call to one is refused before it goes out.

Once it's on, its models show in the chat model pickers, tagged **This PC**. On one test computer that was 854 models.
The **Where it runs** switch at the top of the picker shows one source at a time, so a long list stays short.

## How it works

QuorX starts OpenCode's own server in the background when a chat needs it, and stops it after a quiet quarter of an
hour. OpenCode makes each call itself, so your plans and sign-ins work as they do in OpenCode.

OpenCode runs with its own tools off. QuorX describes its tools to the model, and the model writes its calls as text
that QuorX reads back (in QuorX's format, or the model's own, such as DeepSeek's). Each call is a fresh OpenCode session
that QuorX deletes afterwards, so your own session list stays as it was.

```flow
{ "nodes": [
  { "id": "on", "title": "Switch it on", "sub": "and test the connection", "cap": "QuorX finds OpenCode and the providers connected in it. No key goes into QuorX." },
  { "id": "pick", "title": "Pick its model", "sub": "tagged This PC", "cap": "Choose one in the chat's model button. Where it runs filters the list to one source." },
  { "id": "run", "title": "The app makes the call", "sub": "on your provider or account", "cap": "Each step of the reply runs through the app. Tools, files, commands and checks work as usual." },
  { "id": "fail", "title": "If a call fails", "sub": "the reply stops and says why", "new": true, "cap": "The reply stops and says which model failed and why; you pick the next model. A fallback to OpenRouter is there only if you choose one." },
  { "id": "rest", "title": "Everything else", "sub": "your choice", "cap": "Helpers, the reviewer, the prompt enhancer and fresh eyes can run on OpenRouter or an app on your PC. Deciders and paid media stay on OpenRouter." }
] }
```

## What runs where

The chat's main model runs through the app (its summaries of a long chat too). Helpers, the reviewer, the prompt
enhancer and fresh eyes run on OpenRouter by default, and each can be set to a model tagged **This PC** in its model
picker. For the reviewer, pick one that sees pictures: it looks at screenshots. Deciders and paid media always run on
OpenRouter. You can switch a chat between OpenRouter and an app on your PC at any time. The conversation carries over.

## What it costs

When a provider reports a call's cost, QuorX counts it in the reply, the project and your daily caps; otherwise it
counts the call's tokens at the provider's list price. Plan and free models count $0, and each step on a plan shows
what it counted against the plan, at list price.

## No OpenRouter key yet?

You can still chat: with no OpenRouter key, the models tagged **This PC** run, and the others show locked
until you add a key. The deciders and paid media need OpenRouter, so they are off until then. Helpers, the reviewer,
the prompt enhancer and fresh eyes are off too, unless you set them to a model tagged **This PC**: then they keep
working. The chat says which ones are off.

## When it fails

QuorX never switches your model behind your back.

- **The reply stops** and says which model failed and why (an expired key, a used-up plan, a free tier that ran out).
  When a setting in your account there blocks the model (OpenCode Go: "This Go model requires Global regions"), it
  says so at once: change it in your OpenCode workspace (Privacy → Global), or pick another model.
  The work done so far stays. Pick another model in the chat's model button and send a message to carry on: the
  conversation carries over.
- **A model that failed** is skipped by every chat, this one included, for a while instead of each one waiting on it:
  10 minutes after a refused key, up to 30 minutes after a used-up plan, up to 6 hours after a free tier says no, and
  under 5 minutes after a server error. A passing **Test the connection** tries them all again at once. A short
  overload or rate limit is waited out first, the way OpenCode retries it. Each provider is separate, so one
  model reaching its limit leaves the others working. Only the app itself missing or unreachable affects them all.

Any text streamed before a failure moves into the steps, so the reply isn't written twice. No tool call from a failed
answer ever runs.

If you'd rather have the reply carry on by itself, choose a fallback in **⚙ Settings → Models → Apps on this PC → When a
call fails**: **Same model on OpenRouter** (for example `opencode-local/opencode-go/glm-5.3` becomes `z-ai/glm-5.3`)
or **Always this model**. A step that falls back shows ⤵ with why, and costs OpenRouter's price.

```compare
{ "prompt": "A Go model hits its 5-hour limit halfway through a reply", "options": [
  { "label": "Stop and tell me (the default)", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "The reply stops there", "text": "and says which model and why" },
    { "title": "You choose", "text": "wait for the window, or pick another model in the chat's model button" }
  ], "verdict": { "title": "Nothing changes behind your back", "text": "The work so far stays, nothing is spent elsewhere, and the chat carries on with the model you pick." } },
  { "label": "Same model on OpenRouter", "steps": [
    { "title": "Go says the plan's usage is used up", "text": "for this model, in this 5-hour window" },
    { "title": "QuorX skips that model for the rest of the reply", "text": "and the next step runs z-ai/glm-5.3 on OpenRouter" },
    { "title": "The steps show ⤵", "text": "with why, and what OpenRouter charged" }
  ], "verdict": { "title": "The reply finishes by itself", "text": "Same model, same conversation, paid on OpenRouter until Go's window resets. Then Go is tried again." } }
] }
```
