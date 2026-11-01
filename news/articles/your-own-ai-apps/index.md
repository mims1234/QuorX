---
title: Your own AI apps as the chat model
date: 2026-10-29
summary: A chat's main model can now run through AI apps already on your PC: OpenCode, Claude Code and Grok Build. Your own plan pays, QuorX holds no key, and QuorX's tools work the same. How to switch them on, and what changes.
tags: models, cost, safety
version: 0.2.14
---

If you already pay for an AI app on your computer, QuorX can use it as a chat's main model. The app makes each call
with your own plan, subscription or sign-in; QuorX keeps everything else: its files, browser, terminal, artifacts,
checks and schedules. It's all in **⚙ Settings → Apps on this PC**.

| App on your PC | What it brings | Signed in how |
|---|---|---|
| **OpenCode** | Every provider you connected in OpenCode | OpenCode's own sign-ins and keys |
| **Claude Code** | The models of the account it's signed in to | Claude Code's own sign-in |
| **Grok Build** | Grok's models, for text and build work | Grok's own sign-in (grok login) |

## Switch one on

Tick the app in **⚙ Settings → Apps on this PC**, then press **Test the connection**. It lists the models the app
offers and costs nothing. QuorX holds no key for these apps: the app makes the call, and your plan pays.

Then pick a model in the chat's model button. The picker now starts with **where a model runs**: OpenRouter, OpenCode,
Claude Code or Grok Build, each with its logo. Pick one, and that source's own filters follow, so a long list stays
short.

**OpenCode's own free models can't be picked.** The free models from OpenCode's own provider answer only inside the
OpenCode app, so QuorX shows them in the picker but locked: hover or click one and it says why, and a call to one is
refused before it goes out. Free models from other providers you connected in OpenCode work as usual.

```flow
{ "nodes": [
  { "id": "on", "title": "Switch the app on", "sub": "Settings → Apps on this PC", "cap": "Tick it and press Test the connection: it lists the models and costs nothing." },
  { "id": "pick", "title": "Pick where it runs", "sub": "then the model", "cap": "The model picker starts with OpenRouter, OpenCode, Claude Code or Grok Build, then that source's filters." },
  { "id": "run", "title": "The app makes each call", "sub": "on your plan", "cap": "QuorX holds no key. Its own tools (files, browser, terminal, artifacts) work as on any model." },
  { "id": "stop", "title": "If a call fails", "sub": "the reply stops and says why", "cap": "It names the model that failed and why. A fallback to OpenRouter is there only if you turn it on." }
] }
```

## No OpenRouter key? You can still chat

A chat can run on one of these models with no OpenRouter key at all. The helper, the reviewer, the prompt enhancer and
fresh eyes can run on a model from an app on this PC too, so they keep working without a key. The deciders and paid
media stay on OpenRouter: without a key they're off, and the chat says so. Add an OpenRouter key later and they come
back.

For the reviewer, pick a model that sees pictures: it looks at screenshots of what was built, so a text-only model
such as Grok makes a weak reviewer.

## When a call fails

QuorX never swaps your model behind your back. If a call fails (a used-up plan, an expired sign-in, a free tier that
ran out), the reply stops and says which model failed and why; the work so far stays. Pick another model and carry
on. If you'd rather it carried on by itself, turn on a fallback to OpenRouter in Settings. How OpenCode's failures and
fallbacks work, step by step, is in [Run a chat through OpenCode on your PC](articles/opencode-on-your-pc).

When a setting in your provider account blocks a model, QuorX says so straight away and points you to the setting,
instead of reporting a server error after several retries. For example, OpenCode Go's "This Go model requires Global
regions" points you to **Privacy → Global** in your OpenCode workspace.

## Grok Build: text and build work

Grok Build models read text only, so computer use is off with them, and the chat says so. Everything else (writing,
building, running and checking code) works as usual.

## Safe by design

These apps can't call QuorX's tools directly, so their models write each call as text and QuorX reads it back. That
text could also come from somewhere else (a web page the agent read, or a file), so QuorX only runs a call that:

- carries the key for that step, which changes every step;
- sits on a line of its own;
- is outside code, quotes and plans.

A page or a file can't trigger one. If a model stalls or writes a call in the wrong place, QuorX asks it again, and a
reply that loops or runs on is stopped.

```callout
{ "tone": "good", "title": "Your own app, QuorX's guards", "text": "The tools a step uses are QuorX's own, so its approvals, Undo and Stop apply whichever app chose the step." }
```
