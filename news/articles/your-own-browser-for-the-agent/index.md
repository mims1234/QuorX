---
title: Your own browser, for the agent
date: 2026-10-22
summary: Google, X and many other sites refuse to sign in inside an app's built-in browser. With the QuorX extension, the agent works in your everyday Chrome, Brave or Edge, signed in as you, only in the tabs you allow, and it asks before anything that sends, deletes or buys.
tags: safety, platforms, research
version: 0.2.11
---

QuorX's agent has always had a browser of its own. It opens what it builds, scrolls, clicks and checks the screenshots.
That browser is built into the app, and for the agent's own pages it is exactly right.

It is the wrong place for *your* accounts. Google, X and a growing list of other sites refuse to sign in inside an
app's built-in browser. You get a page that says "This browser or app may not be secure", and no amount of trying
again changes it. Passkeys don't show their prompt there either.

From 0.2.11 the agent can work in **your everyday browser** instead: Chrome, Brave or Edge, where you are already
signed in. Nothing to sign in again, no new profile, and nothing for Google to block, because it is simply your
browser.

```compare
{ "prompt": "Check x.com and tell me what the latest post says", "options": [
  { "label": "The built-in browser", "steps": [
    { "title": "The agent opens x.com", "text": "in QuorX's own browser, which has never signed in anywhere" },
    { "title": "X shows its login wall", "text": "and Google sign-in says the browser may not be secure", "bad": true },
    { "title": "The agent asks you to paste the post", "text": "or to send a screenshot", "bad": true }
  ], "verdict": { "title": "Stuck at the door", "text": "Sites that block built-in browsers stay out of reach, however good the model is." } },
  { "label": "Your own browser", "steps": [
    { "title": "The agent opens x.com in your browser", "text": "in a QuorX window, signed in as you" },
    { "title": "It reads the timeline", "text": "like you would, with the same session you already have" },
    { "title": "It answers in the chat", "text": "and stops to ask before it posts, replies or deletes anything" }
  ], "verdict": { "title": "Straight in, with you in charge", "text": "The agent sees what you see, and every action that changes something waits for your yes." } }
] }
```

## What it unlocks

Anything you can do signed in, the agent can now read and help with:

- **Your inbox**: summarise today's mail, find the invoice from last week, draft a reply for you to send.
- **Social feeds**: see what people say about your project on X, collect the posts that mention a bug.
- **Dashboards you pay for**: read numbers from analytics, hosting or billing pages that have no public API.
- **Long forms**: fill in the boring parts of a form for you to check, then stop before Submit.
- **Research behind a login**: papers, docs or courses in tools you already have accounts for.

The agent still builds and checks its own pages in its own browser. Your browser is only for the work that needs you.

## How a request travels

```flow
{ "nodes": [
  { "id": "chat", "title": "You ask in a chat", "sub": "🧩 Chrome ticked", "cap": "You tick 🧩 Chrome for this chat and ask, for example, to check your latest emails." },
  { "id": "agent", "title": "The agent opens a tab", "sub": "chrome:mail.google.com", "new": true, "cap": "The agent asks QuorX for a tab at that address in your browser." },
  { "id": "ext", "title": "The QuorX extension", "sub": "in your browser", "new": true, "cap": "The extension opens it in a separate QuorX window and works only in that tab." },
  { "id": "page", "title": "Your signed-in page", "sub": "your own session", "cap": "The page is yours: same sign-ins, same cookies. Chrome shows that QuorX is controlling the tab." },
  { "id": "ask", "title": "A red card for big steps", "sub": "send · delete · buy", "cap": "Before a click that sends, deletes, buys, posts or changes your account, QuorX asks you. Always, in every mode." },
  { "id": "answer", "title": "The answer in your chat", "sub": "with screenshots", "cap": "What it read and did comes back to the chat, step by step." }
], "loops": [{ "from": "page", "to": "agent", "label": "next step" }] }
```

## Set it up once

The extension ships inside QuorX. Setting it up takes about a minute, and you do it once.

![The Chrome extension card in QuorX Settings, with buttons to open the extensions page, copy the folder path and show the folder](settings-card.png)

1. In QuorX, open **⚙ Settings → Code & servers → Chrome extension**. It names your default browser (Brave,
   Chrome or Edge) and has an **Open** button for its extensions page.
2. Turn on **Developer mode** on that page, press **Load unpacked**, and pick the folder QuorX shows. **Copy path** and
   **Show folder** are right next to it.
3. Click the QuorX icon in your browser's toolbar and press **Connect to QuorX**.
4. QuorX asks whether to allow it. Press **Allow**.

![The QuorX extension's popup in the browser toolbar, with a Connect to QuorX button](popup-connect.png)

![QuorX asking whether to let the browser connect, with Allow and Deny buttons](allow-notice.png)

No key to copy: the Allow click is the pairing. The extension updates itself after that: when QuorX has a newer
version, it reloads itself.

```callout
{ "tone": "info", "title": "Why Load unpacked?", "text": "Browsers only install extensions from their store or from a folder you pick yourself. Until QuorX is in the Chrome Web Store, picking the folder is the one step no app can do for you." }
```

## Two ways to use it

**Tick 🧩 Chrome in a chat.** It sits under the message box, next to Follow. With it on, the agent in that chat can
open its own tabs in your browser, in a separate QuorX window, whenever the request needs your accounts. Other chats
can't. Untick it and that chat's agent can't touch your browser at all.

![The message box with the Chrome tick box next to Follow](chrome-box.png)

**Give one tab.** Already on the page you mean? Click the QuorX icon on that tab, pick the chat, and press
**🤖 Give this tab**. The chat shows which tab it has, with **Take back** next to it.

![The extension's popup on a mail tab: pick a chat and press Give this tab](popup-give.png)

![A chat's message box showing the tab it was given, with a Take back button](lent-chip.png)

## What it can't do

The extension sits next to all your accounts, so it is built to do as little as possible:

```matrix
{ "levels": [{ "id": "proven", "label": "By design" }, { "id": "tested", "label": "Your switch" }],
  "columns": ["Protection", "How"],
  "rows": [
    { "level": "proven", "cells": ["Only tabs you allowed", "The extension refuses any command for a tab that wasn't given or opened for that chat."] },
    { "level": "proven", "cells": ["Asks before it acts", "Send, delete, buy, pay, post, reply, sign out, settings and passwords get a red card. The deciders never answer it, even in ⚡ YOLO."] },
    { "level": "proven", "cells": ["Only QuorX can connect", "The link only accepts a browser extension, paired by your Allow click. A web page can't use it."] },
    { "level": "proven", "cells": ["You see when it works", "Your browser shows that QuorX is controlling the tab while the agent works."] },
    { "level": "tested", "cells": ["Take it back any time", "Take back in QuorX, Cancel on the browser's bar, or close the tab."] },
    { "level": "tested", "cells": ["Turn it off", "Untick 🧩 Chrome in a chat, or switch off new tabs in the extension's popup."] }
  ] }
```

![A red card asking the user before the agent clicks Delete in their own tab](red-card.png)

```callout
{ "tone": "warn", "title": "Pages can talk back", "text": "A web page or an email can contain text written to steer an AI agent. That is why every action that changes something waits for your yes, and why QuorX tells the agent that page text is information, never instructions. Give it the tabs a task needs, and read a red card before you allow it." }
```

## What's next

A listing in the Chrome Web Store, so installing becomes one click. Until then, the folder in QuorX is the
extension, and it keeps itself up to date.
