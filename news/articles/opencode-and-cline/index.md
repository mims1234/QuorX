---
title: Run a chat through OpenCode or Cline on your PC
date: 2026-10-28
summary: A chat's main model can now run through the OpenCode app or the Cline CLI on your computer, with the providers and accounts you connected there, while OpenRouter stays behind everything else. How to switch them on, what they cost, and what happens when a call fails.
tags: models, cost, setup
version: 0.2.14
---

If you use OpenCode or Cline, QuorX can now run a chat through it: every provider you connected in OpenCode (your plans,
keys and sign-ins), and the account you signed in to in Cline, show up in QuorX's model picker. A chat's main model runs there, and every tool, file, command, browser
step, check and schedule works the same as on any other model. Everything here is in **⚙ Settings → Models → Apps on
this PC**.

## Switch it on

QuorX finds OpenCode on this computer and the providers you already connected in it. Tick **OpenCode on this PC** and
press **Test the connection**: it shows how many models OpenCode offers and from which providers. Nothing to pay, and
QuorX holds no key for it. If OpenCode isn't installed yet, the page shows the command: `npm i -g opencode-ai`.

| What you connected in OpenCode | What you pay with | Model ids look like |
|---|---|---|
| A provider's API key (DeepSeek, OpenRouter, NVIDIA…) | That provider's prices, on your key | `opencode-local/deepseek/…` |
| A plan (OpenCode Go and others) | The plan: nothing per call here | `opencode-local/opencode-go/…` |
| A free tier | Nothing, while the provider allows it | `opencode-local/…` |

Once it's on, its models show in the chat model pickers, tagged **This PC**. On one test computer that was 854 models.
The **Where it runs** switch at the top of the picker shows one source at a time, so a long list stays short.

## Cline on your PC

Cline works the same way: tick **Cline on this PC** and press **Test the connection**. QuorX finds the Cline CLI
(`npm i -g cline`) and the account you signed in to there (Cline credits, ClinePass or a ChatGPT subscription), and
its models show in the picker, tagged **Cline**. Cline makes each call itself, so QuorX holds no key and never touches
Cline's sign-in.

Three things differ from OpenCode:

- **Cline reports no usage**, so QuorX counts each call at an estimate: its characters at the model's list price. Free
  models and subscriptions count $0.
- **Cline keeps every call in its own session history**, and it gives other apps no way to remove them, so QuorX's calls
  show up there.
- **Pictures stay with QuorX**: Cline passes only text on, so a Cline model can't see screenshots (the deciders still can,
  when you have an OpenRouter key).

Cline always offers the model its own tools too. QuorX refuses every one before it runs. When QuorX has the same kind
of tool (a search, a file read or edit, a command, a web page), the call becomes QuorX's and runs with its usual checks;
for any other, the model gets a second try with a reminder to use QuorX's tools. The MCP servers you set up in Cline
stay out of QuorX's calls.

## How it works

QuorX starts OpenCode's own server in the background when a chat needs it, and stops it after a quiet quarter of an
hour. OpenCode makes each call itself, so your plans and sign-ins work as they do in OpenCode.

OpenCode runs with its own tools off. QuorX describes its tools to the model, and the model writes its calls as text
that QuorX reads back (in QuorX's format, or the model's own, such as DeepSeek's). Each call is a fresh OpenCode session
that QuorX deletes afterwards, so your own session list stays as it was.

```flow
{ "nodes": [
  { "id": "on", "title": "Switch it on", "sub": "and test the connection", "cap": "QuorX finds OpenCode or Cline and what you connected in it. No key goes into QuorX." },
  { "id": "pick", "title": "Pick its model", "sub": "tagged This PC or Cline", "cap": "Choose one in the chat's model button. Where it runs filters the list to one source." },
  { "id": "run", "title": "The app makes the call", "sub": "on your provider or account", "cap": "Each step of the reply runs through the app. Tools, files, commands and checks work as usual." },
  { "id": "fail", "title": "If a call fails", "sub": "the reply stops and says why", "new": true, "cap": "The reply stops and says which model failed and why; you pick the next model. A fallback to OpenRouter is there only if you choose one." },
  { "id": "rest", "title": "Everything else", "sub": "on OpenRouter", "cap": "Deciders, paid media, the prompt enhancer, helpers and the reviewer keep running on OpenRouter." }
] }
```

## What runs where

Only the chat's main model runs through the app (its summaries of a long chat too). Deciders, paid media, the prompt
enhancer, helpers and the reviewer stay on OpenRouter, so you still need an OpenRouter key. You can switch a chat
between OpenRouter and an app on your PC at any time. The conversation carries over.

## What it costs

When a provider reports a call's cost, QuorX counts it in the reply, the project and your daily caps; otherwise it
counts the call's tokens at the provider's list price. Plan and free models count $0, and each step on a plan shows
what it counted against the plan, at list price.

## No OpenRouter key yet?

You can still chat: with no OpenRouter key, the models tagged **This PC** and **Cline** run, and the others show locked
until you add a key. The deciders, the prompt enhancer, helpers, the reviewer and paid media need OpenRouter, so they are
off until then.

## When it fails

QuorX never switches your model behind your back.

- **The reply stops** and says which model failed and why (an expired key, a used-up plan, a free tier that ran out).
  The work done so far stays. Pick another model in the chat's model button and send a message to carry on: the
  conversation carries over.
- **A model that keeps failing** is skipped by every chat for a while instead of each one waiting on it: until its plan
  window resets or for up to 30 minutes, and under 5 minutes after a server error. Each provider is separate, so one
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
