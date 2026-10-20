# QuorX on macOS and Linux

QuorX was built on Windows first. Before it can help build iPhone, Mac or Linux apps, its safety layer has to hold on
those systems too: Stop must end everything a command started, the rules must read bash and zsh, the places that hurt
to lose must be off limits, and the desktop tool must reach only the agent's own windows. This page says how each part
works there, what is still missing, and how to test it.

## What changes away from Windows

| Part | Windows | macOS and Linux |
|---|---|---|
| **Stop** | Each command runs in a Windows job; Stop ends the job and counts what is left | Each command runs in a process group of its own; Stop ends the group and counts what is left |
| **If QuorX is killed** | The job closes with it | The command's gate notices and ends its own group |
| **The agent's shell** | Windows PowerShell (read by its own parser), PowerShell 7, cmd, Git Bash | bash (the default) or zsh, read by the same rules |
| **Off limits** | Drive roots, your profile and its folders, Windows and Program Files | `/`, your home and its folders, other people's homes, the system's folders, `~/Library`, `~/.ssh`, drives |
| **Installs for the whole computer** | winget, choco, scoop, `npm -g` … ask you | brew, apt, dnf, pacman, snap, port, `sudo` … ask you |
| **Tripwire** | Watches your profile and the project's neighbours | The same on macOS; on Linux your home is watched one level deep |
| **Desktop tool** | UI Automation | macOS: the Accessibility API. Linux: AT-SPI |
| **Memory cap per command** | Yes | Not yet |

### Stop

Every command and server the agent starts goes through a small gate (`server/jobgate.cjs`). On macOS and Linux QuorX
starts the gate in a new session and process group, so everything the command starts joins that group. Stop sends
`SIGTERM` to the whole group, waits a moment for programs to close their files, sends `SIGKILL` to what is left, and
looks again: the command row says "0 processes left", or names the ones that would not stop. The same happens when a
command reaches its time limit, and when a command ends while something it started is still running.

A program can leave its group on purpose (a daemon calls `setsid`). QuorX follows those too: a child of anything in the
job belongs to the job, and a process seen in the job once stays in it, checked by name so a reused process id is never
touched. The one thing it can miss is a program that daemonizes and leaves between two looks.

If QuorX itself is killed, there is no job to close with it. Instead each gate checks every second that QuorX is still
its parent; when it isn't, the gate ends its own group.

The code is `server/procgroup.js`, behind the same functions as the Windows job host (`server/jobhost.js`), so the rest
of QuorX doesn't change. **⚙ Settings → Safety & commands → Stop** shows "Process groups: every process, confirmed".

### Rules for bash and zsh

Each command line is split into its commands first, and the strictest one decides. On top of what was already there,
the rules now see commands hidden in:

- groups and blocks: `(rm -rf ~)`, `{ rm -rf ~; }`, `if …; then rm -rf ~; fi`, `! rm …`;
- wrappers that run the rest as a command: `env`, `timeout`, `nohup`, `nice`, `command`, `caffeinate`, `xcrun`, `noglob` …;
- a redirection on its own (`> ~/.zshrc` empties the file) and `>&`, `>|`.

Anything that turns text into a command asks you: `eval`, `$(…)`, `` `…` ``, `<(…)`, `env -S`, functions, `for`
loops, `awk`, `open`, zsh's `=(…)` and `=name`, and zsh glob qualifiers like `*(e:…:)` (they run code). `~user` paths
can't be resolved beforehand, so they ask too.

Programs that change the system are never allowed: `launchctl`, `systemctl` (but `systemctl status` reads),
`crontab` (but `crontab -l`), `csrutil`, `tccutil`, `diskutil`, `mount`, `mkfs`, user and firewall tools, and `sudo`
for anything except an install. `security` reads your keychain, so only `security find-identity` (code-signing
identities) is allowed. `defaults` may read; writing macOS's own settings is never allowed.

Installs for the whole computer (`brew install`, `apt install`, `sudo apt install`, `pacman -S`, `gem install`,
`xcode-select --install` …) always ask you; listing and searching (`brew list`, `apt list`, `pacman -Qi`) just run.
`sudo` needs your password, which an agent command can't type, so the card says to run it yourself in a terminal tab.

### Off limits

Deletes and writes are judged by their real target. Blocked outright, besides what was already blocked:

- **macOS:** `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc` (`/private/etc`), `/opt`
  (Homebrew), `/Users` and other people's folders in it (not `/Users/Shared`), a drive in `/Volumes`, your
  `~/Library` (except Xcode's DerivedData, the simulators' caches and `~/Library/Caches`, which only ask).
- **Linux:** `/etc`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/boot`, `/sys`, `/proc`, `/dev`, `/run`, `/var` (not
  `/var/tmp`), `/opt`, `/srv`, `/root`, `/snap`, `/home` and other people's homes, a drive in `/mnt` or `/media`.
- **Both:** `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.local/bin`, `~/.config/autostart`,
  `~/.config/systemd`, and (as on Windows) your home and every folder directly in it.

macOS compares paths without regard to case, as its disks do.

### The desktop tool

The agent starts an app with `shell` and `background: true`, then reads its windows as numbered controls and presses,
types and sends keys, in the same text form as on Windows. Only windows of processes in that background job can be
reached.

**macOS** uses the Accessibility API through a small Swift helper (`server/axhost.swift`). QuorX builds it the first
time the tool is used, with Apple's Command Line Tools (`xcode-select --install` if you don't have them; installing
them is yours to do), and keeps it in its data folder. Then:

- macOS asks you once to allow **Accessibility** for the app QuorX runs in: the QuorX app, or Terminal / iTerm when you
  started QuorX with `npm start`. Turn it on in **System Settings → Privacy & Security → Accessibility**.
  **⚙ Settings → Setup check** shows whether it is allowed.
- **Screenshots** need **Screen Recording** in the same place. Reading and pressing controls work without it.
- Keys go to the app's own process, never to the window in front. A mouse click (for controls without a press action)
  is only sent when one of the agent's windows is on top at that point.
- In keys, `^` is the Command key (`^s` saves, `^q` quits).
- Start a Mac app by its own program, `MyApp.app/Contents/MacOS/MyApp`, not with `open`: `open` hands the app to
  macOS, so it isn't the agent's process and can't be reached (and `open` asks you, since it can start anything).

**Linux** uses AT-SPI through Python (`server/atspihost.py`), which needs `python3-pyatspi` (apt, dnf) or
`python-atspi` (pacman). GTK apps take part on their own; start Qt apps with `QT_ACCESSIBILITY=1` and Electron apps
with `--force-renderer-accessibility`. Keys and clicks work on X11 and XWayland; screenshots of windows are not there
yet.

## Not there yet

- A memory cap per command (Windows jobs have one).
- An operating-system sandbox around commands (macOS `sandbox-exec`, Linux namespaces).
- Screenshots of windows on Linux, and keys on pure Wayland sessions.
- PowerShell as the agent's shell on macOS and Linux (its parser runs in the Windows job host).

## Testing it

You need Node.js 20+, and perl (macOS has it; most Linux systems too). No OpenRouter key.

```bash
npm install
npm test
npm run test:packs -- --pack system
```

`npm run test:packs -- --pack system` runs `scripts/test-posix.mjs` and writes `pack-test-report.md`; paste it into
the pull request. On Windows the same file tests the logic (a fake process table, macOS and Linux paths, the bash and
zsh rules, the desktop tool's keys); on macOS and Linux it also starts real processes: a command that leaves a
background child, one with a `setsid` daemon, a timeout, a QuorX that is killed, and zsh.

To try the desktop tool by hand on a Mac: start QuorX, ask the agent to "write a small SwiftUI or tkinter counter app,
run it, and click its button three times", and allow Accessibility when macOS asks.
