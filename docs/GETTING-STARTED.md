# Getting started

[← Back to the README](../README.md)

## Install the app (Windows)

Download `QuorX-Setup-<version>.exe` from the [latest release](https://github.com/mims1234/QuorX/releases/latest)
and run it. The app updates itself from the same releases.

**"Windows protected your PC"?** The installer isn't code-signed yet, so Windows SmartScreen warns about it. To check
that the file is the one built here, compare its checksum with `SHA256SUMS.txt` on the same release page:

```powershell
Get-FileHash .\QuorX-Setup-0.2.4.exe -Algorithm SHA256
```

On macOS or Linux, with `SHA256SUMS.txt` in the same folder as the installer:

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt
```

If the two match, choose **More info → Run anyway**. Every installer is built from this repository's code by GitHub
Actions ([the workflow](../.github/workflows/release.yml)), and you can always build or run QuorX from source instead.

Or with winget, once QuorX is listed there: `winget install QuorX.QuorX`.

## Install the app (macOS and Linux)

From 0.2.7 each release also has:

| | File | Updates itself |
|---|---|---|
| **macOS, Apple silicon** | `QuorX-<version>-mac-arm64.dmg` | Not yet (see below) |
| **macOS, Intel** | `QuorX-<version>-mac-x64.dmg` | Not yet (see below) |
| **Linux** | `QuorX-<version>-linux-x86_64.AppImage` | Yes |
| **Debian, Ubuntu** | `quorx_<version>_amd64.deb` | Install the new deb |

Check the file against `SHA256SUMS.txt` first: `sha256sum -c --ignore-missing SHA256SUMS.txt` (on macOS,
`shasum -a 256 -c --ignore-missing SHA256SUMS.txt`).

- **macOS:** open the dmg and drag QuorX to Applications. The app isn't signed or notarized yet, so the first time,
  right-click QuorX → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**). macOS only installs
  updates for signed apps, so until then QuorX tells you a new version is out and you download it the same way.
- **AppImage:** `chmod +x QuorX-*.AppImage` and run it. Some distributions need `libfuse2` for AppImages.
- **deb:** `sudo apt install ./quorx_<version>_amd64.deb`, then start QuorX from your app menu or with `quorx`.

## Run from source

You need **Node.js 20 or newer** and an **OpenRouter** account.

```bash
npm install
npm start
```

Open http://localhost:5188 and choose **Sign in with OpenRouter** (⚙ Settings → API keys opens by itself the first
time). openrouter.ai asks you to approve, lets you set a spending limit for the new key, and sends the key back to
QuorX. You can paste a key instead, or put `OPENROUTER_API_KEY` in a `.env` file. Then ⚙ Settings → **Setup check**
shows what this computer has (Git, Python, a browser, toolchains) and offers to install what is missing.

## The desktop app from source

The desktop app puts the same page in its own window, with real browser tabs in the pane and a tray icon that keeps
QuorX running for your phone. The first ✕ shows a short notice (Keep running or Quit QuorX); right-click the tray
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

Ports, phones and other devices, the installer, updates and every setting from `.env` are in
[the report's setup section](REPORT.md#setup-in-detail).
