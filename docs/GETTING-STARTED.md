# Getting started

[← Back to the README](../README.md)

## Install the app (Windows)

The easiest way is the [Microsoft Store](https://apps.microsoft.com/detail/9NBK5DMLMTFF?mode=direct): Microsoft signs
that copy, so Windows doesn't warn about it, and the Store keeps it up to date.

Or download `QuorX-Setup-<version>.exe` from the [latest release](https://github.com/mims1234/QuorX/releases/latest)
and run it. The app updates itself from the same releases.

**"Windows protected your PC"?** The installer isn't code-signed yet, so Windows SmartScreen warns about it. To check
that the file is the one built here, compare its checksum with `SHA256SUMS.txt` on the same release page:

```powershell
Get-FileHash .\QuorX-Setup-0.2.21.exe -Algorithm SHA256
```

On macOS or Linux, with `SHA256SUMS.txt` in the same folder as the installer:

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt
```

If the two match, choose **More info → Run anyway**. Every installer is built from this repository's code by GitHub
Actions ([the workflow](../.github/workflows/release.yml)), and you can always build or run QuorX from source instead.

## Run from source

You need **Node.js 20 or newer**, and a way to reach models: an **OpenRouter** account is the easiest (one key for
every model, and what the helpers and deciders use by default).

```bash
npm install
npm start
```

Open the link `npm start` prints once (it signs this browser in; QuorX then opens at http://quorx.localhost:5188, a
name only QuorX uses, so its sign-in never reaches dev servers on localhost) and choose **Sign in with OpenRouter** (⚙
Settings → Providers & keys opens by itself the first time). openrouter.ai asks you to approve, lets you set a spending
limit for the new key, and sends the key back to QuorX. You can paste a key instead, or put `OPENROUTER_API_KEY` in a
`.env` file.

The same page turns on the other providers: a maker's API with your key (OpenAI, Anthropic, Gemini, xAI, DeepSeek and
more), a coding-plan subscription, a coding CLI you've signed in to on this PC, or a local model server (LM Studio,
Ollama, Foundry Local, llama.cpp). Without an OpenRouter key, chats run on those. Then ⚙ Settings → **Setup check**
shows what this computer has (Git, Python, a browser, toolchains) and offers to install what is missing.

## Finding your way around

- **Across the top:** the menus (QuorX, File, Edit, View, Chat, Agent, Run, Window, Help), your projects as tabs, and
  **Go to or run…** (Ctrl+K) to jump to any chat, file or command. The layout menu at the right (Single, Chat +
  preview, Two chats and more) arranges the chats and panes; Ctrl+Alt+1–9 switch layouts.
- **Down the left:** the activity bar opens a view in the sidebar: Chats, Search, Running, Servers & pages, Source
  control, Extensions, Schedules and, at the bottom, Spending, ⟳ Restart the harness and ⚙ Settings. Click the open
  view again to hide the sidebar, and drag its edge to make it wider.
- **In the middle:** the chats you have open, as tabs. With no chat open, Home shows your projects and recent chats.
  Each chat's own tabs (Steps, Plan, Browser, Terminal, Files, Source control: changes, history and pull requests) open beside it; ＋ adds one.
- **Along the bottom:** the status bar, and a panel with the project's terminals, what's running and its servers.
- **Settings** opens in its own window over the app. Esc, ✕ or a click beside it closes it.
- **A window of its own** (desktop app): right-click a tab and choose Pop out, or drag it out of the window; Dock back
  returns it.

## The desktop app from source

The desktop app puts the same page in its own window, with real browser tabs in the Browser tab and a tray icon that keeps
QuorX running for scheduled tasks. The first ✕ shows a short notice (Keep running or Quit QuorX); right-click the tray
icon → Quit QuorX stops it, and ⚙ Settings → About sets what ✕ does:

```bash
npm run desktop:setup
npm run desktop
```

`desktop:setup` installs Electron (about 100 MB) into `desktop/` only. `npm run desktop:dist` builds a Windows
installer.

## Where your data lives

Chats, projects and keys are in `data/`, logs in `logs/`, both next to the code and ignored by git (the installed app
asks where to keep them). Each project keeps QuorX's own working files (undo history, trash, snapshots, scratch work)
in a hidden `.quorx/` folder inside it, which git ignores. Keys stay on the server; the page only ever sees them
masked. What leaves your computer is described in [Privacy](../PRIVACY.md).

Ports, the installer, updates and every setting from `.env` are in
[the report's setup section](REPORT.md#setup-in-detail).
