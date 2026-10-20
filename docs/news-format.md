# The News format

QuorX has a **News** section in its sidebar: what's new in each version, reports on models, tests and platforms, the
user's own numbers, and research articles. All of it ships with QuorX itself, in the `news/` folder, so News updates
whenever QuorX does. This page is the contract every News page is written to. `npm run news:check` checks it.

## The folder

```
news/
  updates.json                 What's new: one entry per version (see below)
  articles/<slug>/index.md     a research article, plus any data files it uses (*.json)
  reports/<slug>/index.md      a report (models, tests, platforms), plus its data files
```

A slug is lower case letters, digits and dashes: `quorum-experiment`, `models`. Folders starting with `_` are drafts:
the checker reads them, the app doesn't list them.

## What's new: `news/updates.json`

```json
{
  "versions": [
    {
      "version": "0.2.0",
      "date": "2026-10-20",
      "title": "Every kind of app",
      "items": [
        { "kind": "new", "text": "Platform packs: QuorX builds, checks and debugs C#, Go, Java, Android, Flutter and more.", "pr": 3, "link": "articles/platform-packs" },
        { "kind": "safety", "text": "Scripts that run other programs are read first and always ask.", "pr": 5 }
      ]
    }
  ]
}
```

- Newest version first. `version` matches `package.json`'s `version` when that version ships.
- `kind` is one of `new`, `improved`, `fixed`, `safety`.
- `text` is one plain sentence for users: what changed for them, not how it was built. Under 160 characters.
- `pr` (a pull request number) and `link` (`articles/<slug>` or `reports/<slug>`) are optional.

The app remembers the last version the user read. Items newer than that get a "new" mark, and the sidebar's News entry
shows a dot until they are opened.

## Articles and reports: `index.md`

A file starts with front matter between `---` lines, one `key: value` per line:

```
---
title: Can a quorum make a cheap model stronger?
date: 2026-10-20
summary: One or two sentences for the list.
tags: models, deciders, cost
version: 0.2.0
order: 1
---
```

| Key | Required | Meaning |
|---|---|---|
| `title` | yes | The headline |
| `date` | yes | `YYYY-MM-DD` |
| `summary` | yes | One or two sentences, under 280 characters |
| `tags` | no | Comma-separated, lower case: `models`, `safety`, `platforms`, `deciders`, `cost`, `tests`, `research` … |
| `version` | no | The QuorX version it arrived with |
| `order` | no | Reports only: their order in the Reports list |

The body is Markdown: headings (`##` and below), paragraphs, **bold**, *italic*, `code`, links, lists, tables, block
quotes, fenced code, and images relative to the article folder. Write it like the rest of QuorX: plain words, from
the reader's side, no hype.

## Interactive blocks

A fenced code block whose language is one of the names below becomes an interactive component. Its body is JSON.
Every component is complete at rest (it shows everything without scrolling or clicking); its animation only replays
what is already there, and respects reduced motion.

Any block may take its data from a file in the same folder instead of inline: `{ "src": "models.json" }` uses that
file's JSON as the block's body, and `{ "src": "models.json", "path": "leaderboard" }` uses one key of it. Inline keys
next to `src` override the file's.

| Block | JSON | Renders |
|---|---|---|
| `stat` | `{ "items": [{ "label", "from", "to", "unit"? }] }` | Before → after counters that count up |
| `chart` | `{ "type": "line" \| "bar" \| "pairs", "title"?, "x": [labels], "series": [{ "name", "values": [numbers] }], "unit"? }` | A line chart, bar chart, or before/after bar pairs (two series) |
| `timeline` | `{ "items": [{ "when", "title", "text", "tag"? }] }` | Dated steps along a line |
| `lanes` | `{ "start": "HH:MM", "end": "HH:MM", "rows": [{ "label", "build": ["HH:MM","HH:MM"], "review"?: ["HH:MM","HH:MM"], "back"?: n, "detail"? }] }` | A lanes (Gantt) chart; clicking a lane shows its detail |
| `flow` | `{ "nodes": [{ "id", "title", "sub"?, "new"?: true, "cap"? }], "loops"?: [{ "from", "to", "label" }] }` | A flowchart in order of `nodes`, with a Play button that walks it; `cap` is what each step says |
| `compare` | `{ "prompt"?, "options": [{ "label", "steps": [{ "title", "text", "bad"?: true }], "verdict": { "title", "text" } }] }` | A switch between two or more versions of the same story |
| `matrix` | `{ "levels": [{ "id", "label" }], "columns": ["…"], "rows": [{ "level", "cells": ["…"] }] }` | A table filtered by level, each row tagged with its level |
| `ledger` | `{ "rows": [{ "gain", "gainText", "cost", "costText", "mitigation"? }] }` | Gains next to their costs |
| `terminal` | `{ "title"?, "lines": [{ "cmd": "…" } \| { "out": "…" }] }` | A terminal that replays the lines |
| `callout` | `{ "tone": "info" \| "warn" \| "good", "title", "text" }` | A highlighted note |
| `local` | `{ "view": "models" \| "deciders" \| "costs" \| "tests" }` | The user's own numbers from this computer (see below) |

Level ids used across QuorX: `proven`, `tested`, `wired` (shown as "Logic tested"), `next` (shown as "Not yet").

## The user's own numbers: `local` blocks and `/api/news/local`

`local` blocks are filled at view time from the user's own logs on this computer (`logs/runs.jsonl`, decider votes,
test results). They never leave the computer and are never written into `news/`. The server answers
`GET /api/news/local?view=<view>` with JSON:

- `models`: `{ "rows": [{ "model", "replies", "passRate", "avgCost", "avgSteps", "avgSeconds" }], "since" }`
- `deciders`: `{ "questions", "confirmed", "flipped", "theater", "unclear", "byModel": [{ "model", "votes", "agreed" }] }`
- `costs`: `{ "days": [{ "date", "cost" }], "byModel": [{ "model", "cost" }] }`
- `tests`: the last `npm test`, `npm run test:packs` and UI test results this computer kept, if any.

With no logs yet, a block shows a short explanation of what will appear there.

## The routes

| Route | Answers |
|---|---|
| `GET /api/news` | `{ "version", "lastRead"?, "updates": updates.json, "articles": [front matter + slug], "reports": [front matter + slug] }` |
| `GET /api/news/item?kind=articles\|reports&slug=…` | `{ "front": {…}, "body": "markdown" }` |
| `GET /api/news/file?kind=…&slug=…&name=file.json` | that data file (JSON only; names are checked, nothing outside `news/` is served) |
| `GET /api/news/local?view=…` | the user's own numbers (above) |
| `POST /api/news/read` `{ "version" }` | marks News as read up to that version |
