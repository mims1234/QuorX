---
title: How to use computer use
date: 2026-10-29
summary: Let the agent work in the apps on your Windows PC, one app at a time and as far as you allow: View, Click or Full. How to turn it on, what you see while it works, what's new in 0.2.14, and which models do it best.
tags: desktop, safety
version: 0.2.14
---

Computer use lets the agent work in the apps on your PC the way you would: it looks at a window, clicks, types and
reads what changed. It's off in every chat until you turn it on, and each app needs your OK. It works on Windows for
now.

## Turn it on in a chat

1. In the message box, press **🖥 Computer use** and tick **Let the agent use apps on this computer**. It's for this
   chat only.
2. Ask for something in an app: "Open Calculator and work out 17% of 2,340", or "Draw a house in Paint". The agent
   works in apps that are already open, or opens installed ones by their Start-menu name.
3. The first time it wants an app, a card asks you. Once you allow it, the app shows in the 🖥 panel with how far the
   agent may go in it.

| Level | What the agent may do in that app |
|---|---|
| **View** | Look only: its windows, their text, a screenshot |
| **Click** | Look, and click buttons and points |
| **Full** | Look, click, type and send keys |

Change an app's level in the 🖥 panel at any time, or remove it. Apps stay open after the agent uses them, so they can
be used again.

```flow
{ "nodes": [
  { "id": "on", "title": "Turn it on", "sub": "🖥 Computer use, this chat", "cap": "Off in every chat until you tick it." },
  { "id": "ask", "title": "Ask for something", "sub": "in an app", "cap": "It uses apps already open, or opens installed ones by their Start-menu name." },
  { "id": "ok", "title": "Allow the app once", "sub": "View, Click or Full", "cap": "A card asks the first time. The app then shows in the 🖥 panel with its level." },
  { "id": "work", "title": "It works, you watch", "sub": "glowing edge, Stop button", "cap": "A glowing edge shows it is working; press Stop at any time to end it." }
] }
```

## While it works

A glowing edge goes round the screen and a **Stop** button stays on top while the agent uses your desktop (or one of
your Chrome tabs). Press Stop at any time to end it.

- **System tools and admin shells are never used**, whatever the level.
- **What you named in your message is your go-ahead.** Ask for Paint and it can use Paint; an app you didn't name
  asks first.
- **Dialogs like "Replace it?" ask you first**, so the agent can't overwrite a file on its own.

To keep an eye on it from QuorX, **👁 Follow the agent** shows the page or terminal it's using. The new **🧭** button
follows the running reply's steps instead, one chat at a time.

## New in 0.2.14

- **Freehand drawing:** one held stroke through many points, so it can draw a curve in Paint rather than a row of
  dots.
- **Smooth held mouse moves**, for dragging.
- **Up to 40 steps in one go**, so a drawing doesn't pause after every move.

## Which model to use

Computer use works best with a model that sees pictures, because the agent reads the screen from screenshots:

- a Claude Code model, through [Apps on this PC](articles/your-own-ai-apps);
- an OpenRouter model with image input.

It isn't available on Grok Build models, which read text only; the chat says so.

```callout
{ "tone": "info", "title": "Start small", "text": "Try View first on an app you don't mind, then raise it to Click or Full once you've seen how the agent works there." }
```
