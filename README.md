# QuorX

**An open-source AI agent with a quorum of models behind every call.** Any model, through OpenRouter.

*Formerly OpenHarness. Projects, settings and the desktop app's data carry over by themselves: a project's `.openharness` folder becomes `.quorx` the first time it is opened, and the desktop app copies its settings from `%APPDATA%OpenHarness` on first start.*

A web app that works a bit like Claude Code: a chat agent runs a tool loop, builds **artifacts** (HTML pages, pictures, music, voice) that open in a side pane, and shows **how it got its answer** under every reply.

The experiment: **can a small, cheap model get stronger by building its own questions for fast decision models**, instead of relying on itself? To make that measurable, the agent has to **write down its own guess before asking**. The trace then shows whether asking changed anything.

Built on the Synapse workshop (`../decision-project`, see its `docs/HANDOFF.md`). `server/openrouter.js` is copied from there unchanged apart from the port and title.

## Run it

```
npm start
```

Then open http://localhost:5188. It needs Node 20+ and `npm install` once: the only packages are `node-pty` and xterm.js for the Terminal tab. `node-pty` ships ready-built files for Windows and macOS (x64 and arm64); on Linux it compiles, which needs Python 3, `make` and a C++ compiler. Without it, terminal tabs fall back to a plain shell and everything else works.

**OpenRouter keys:** with no key, the page opens ⚙ Settings → API keys and the message boxes stay locked until you add one. The easy way is **Sign in with OpenRouter**: openrouter.ai opens, you approve (and can set a spending limit for the new key there), and the key comes back to the harness by itself (OAuth with PKCE: the secret part stays on the server, and QuorX never sees your password). When the page is opened from another device, OpenRouter shows a code to paste instead. You can still paste a key; the server checks it with OpenRouter before saving it. Then models, prices and balances load. You can add several keys and choose which one is active. A key in `.env` (`OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_BOT`) also works and shows up as "From .env". Keys live only in `data/keys.json` (git-ignored). The page only ever gets them masked (`sk-or-v1-••••••••317c`), agent processes run without them, and the agent's file tools can't read `.env` or `data/keys.json`. A script the agent writes and runs could still read any file on disk, so keep ⚡ YOLO for projects you trust.

**Ports:**
- The harness uses **5188**. To use another port, set `AGENT_PORT=…` in `.env`.
- If the port is already taken by another program, the harness moves up to the next free one and prints the address it actually uses ("Port 5188 is in use…; trying 5189").
- Agent dev servers get ports from **5300–5999**.
- Nothing here uses 7860, a common port for Gradio and other Python apps.

**Phones and other devices:** the harness can run commands in a real shell, so only this computer gets in on its own. A phone or another computer on your network pairs once: open ⚙ Settings → About → **Other devices** on this computer, click **Show links**, and open the pairing link on the device (copy it, or type it). It leaves a cookie for a year. **New link…** signs every paired device out, and **Allow other devices** off refuses them all. Ten wrong links from one address lock it out for 10 minutes.
- `AGENT_HOST=127.0.0.1` in `.env` keeps the harness on this computer only (it doesn't listen on the network at all).
- The harness only answers to `localhost`, IP addresses and this computer's own name, so a web page can't reach it through DNS rebinding. Reaching it by another name (for example a Tailscale name)? List it in `OH_ALLOWED_HOSTS=name1,name2`.
- Other sites, and pages the agent builds (dev servers on other ports, sandboxed artifacts), can't call `/api`.

**Pictures and media in chats** (screenshots the agent takes, pictures it makes) are stored once each in `data/blobs/` and chats refer to them by address, so chat files stay small. Older chats move their pictures there the next time they are saved. Blobs no chat, deleted chat or recent run log refers to are removed after 2 days.


### Desktop app (a real browser in the pane)
`npm run desktop` opens QuorX in its own window. The page is the same, but the pane's **Browser** tab uses **real Chromium tabs** instead of streamed pictures. Every site loads, including Google, YouTube and GitHub, which refuse frames. Scrolling is smooth, video and sound play, sign-ins last between sessions, text selection, copy, paste and right-click work, and pop-ups open as new pane tabs. Downloads go to your Downloads folder and show in the bar; click one to show it in the folder. **DevTools** and **↗ Your browser** sit next to the address bar.
- **First time:** `npm run desktop:setup` (installs Electron, about 100 MB, into `desktop/` only; the main app stays dependency-free).
- **The server:** if a harness already runs on `AGENT_PORT` (5188 by default), the window attaches to it. Otherwise it starts one itself, and ✕ then keeps it running in the tray, so phones on Wi-Fi still reach it. **Quit** is in the tray menu.
- **Phones and normal browsers** keep the streamed Browser tab, so nothing changes there.
- **↗ and new windows** (links in pages and artifacts that open a new window) open in your **default browser**. Pop-ups inside the Browser tab's own tabs still open as new pane tabs.
- **⟳ Restart the harness** (top bar; the amber "Restart" notice is clickable too, and the tray menu has it) loads new server code. If the app runs the harness itself, it stops and restarts it. If it is attached to one that was already running, it asks that one to stop and starts its own, so from then on restarts and the tray are the app's. In a plain browser, the harness starts a fresh copy of itself on the same port, which keeps running in the background with its output in `logs/harness.log`. It warns first when replies are running; they can be resumed afterwards.
- **Updating while you build:** page changes need **Ctrl+R** (or nothing, after a ⟳). Server changes need ⟳. Changes to `desktop/main.js` or `preload.js` need the app closed and `npm run desktop` run again.
- **Real tabs step aside** whenever they would cover something: another pane tab, a dialog (a snapshot shows in their place), a hidden pane.
- **The agent's tab is a real view too.** When the agent uses its `browser` tool in a chat, its tab opens as a real Chromium view in that chat's pane (with ☑ Follow the agent, the pane switches to it). While the reply runs, a see-through cover with "🤖 The agent is using this page" blocks your clicks, and the agent's page (usually 1280 wide) is scaled down to fit. Its own screenshots stay full size for its vision checks. When the reply ends, the cover lifts and the page fits the pane: it is your tab now, exactly where the agent left it, nothing reloaded. The agent's tabs use their own profile, separate from your sign-ins. Phones see the same tab as pictures. If the desktop app isn't linked, or a tab doesn't answer within 8 seconds, the agent uses the headless browser as before. The final "check the work" pass always uses the headless browser.
- **Installer:** `npm run desktop:dist` builds `desktop/dist/QuorX-Setup-<version>.exe` (about 112 MB). It installs per user, needs no admin rights, lets you pick the folder, and adds Start menu and desktop shortcuts. It isn't code-signed yet, so Windows SmartScreen warns the first time (More info → Run anyway). The installer carries only the code: no chats, keys or `.env`.
- **Your data in the installed app:** on first run it asks where to keep chats, projects and keys: a new folder in your profile (recommended), or an existing QuorX folder such as this repo, to keep your chats. The choice is saved in `%APPDATA%\QuorX\config.json`, and updates never touch the data. (The server reads the data location from `OH_HOME`; without it, data stays next to the code as before.) The tray menu has **Open the data folder**.
- **Updates, pushed from the app (no code signing needed):** the app checks your update feed shortly after it starts and every 6 hours. When a newer version is out, the top bar shows **⬆ Update to vX**. Pressing it downloads the update (with progress) and checks it against the SHA-512 in the feed. It then shows **↻ Restart to update**, which installs the update and reopens the app. Your data folder isn't touched. A downloaded update also installs the next time you quit. ⚙ Settings → About shows the version, **Check now** and the feed address.
- **Publishing an update (GitHub Releases, automatic):** the feed is the public repo **mims1234/QuorX**: `quorx.updateUrl` is `https://github.com/mims1234/QuorX/releases/latest/download` (Settings → About can still change it per PC).
  1. `npm run release:bump` raises the version (0.1.1 → 0.1.2) in `desktop/package.json` and `package.json`. Commit it.
  2. `git tag v<version>` and `git push origin main v<version>`.
  3. `.github/workflows/release.yml` runs on GitHub's Windows machines: it checks the tag matches the version, installs, builds the installer, and creates the release with `latest.yml`, `QuorX-Setup-<version>.exe` and its `.blockmap`. It also writes the winget manifests for that version (downloadable from the run as `winget-manifests-<version>`).

  Every installed app sees it at its next check. Building by hand still works: `npm run desktop:release`, then upload those three files to a new release yourself.
- **First time on GitHub:** create the public repo `mims1234/QuorX`, then from this folder `git init`, commit and push `main`. `.gitignore` keeps `.env`, `data/` (chats and keys), `logs/`, `workspaces/`, `node_modules/` and `desktop/dist/` out. Make the first tag newer than any installer you already handed out (0.1.1 exists), e.g. `v0.1.2`, or those copies won't see it as an update.
- **winget:** `npm run winget -- --url <download base>` writes the three winget manifests for the built installer to `desktop/dist/winget/<version>/` (with its SHA-256) and `--validate` checks them with `winget validate`. The address must stay on that version (winget pins the hash): `{version}` in the base is filled in, and a GitHub `releases/latest/download` address becomes `releases/download/v<version>`. Publisher, license and the base live in `desktop/package.json` → `quorx.winget`. Publishing is a pull request to microsoft/winget-pkgs: the first version by hand (`wingetcreate submit <folder>` with a GitHub token, using the manifests from the release run). After it is merged, `winget install QuorX.QuorX` works, and if you add a `WINGET_TOKEN` secret (a token with public_repo scope) to the repo, the release workflow submits every later version by itself.
- **Start at login:** a ✓ checkbox in ⚙ Settings → About (desktop only, off by default) and in the tray menu. When on, the app starts hidden in the tray when you sign in to Windows, so the harness is up for your phone right away.
## What's on the page

### Landing screen
The app opens on a start screen ("What are we building?") instead of the last chat. Get back to it any time with **🏠** next to ☰ in the sidebar (also in the collapsed rail; it's lit while you're on the start screen) or by clicking the app's name in the top bar. It has:
- a project picker with ＋ New chat
- **📂 Open folder…**: your PC's own folder picker (on Windows the modern Explorer-style one, kept in front of the browser with a taskbar entry). If the folder already belongs to a project, a chat opens there; otherwise it becomes a new project named after the folder, and a chat opens in it. (When the page is opened from another computer the dialog can't show, so the New project window opens to type the path.)
- **Start from a template:** one card per starter in `templates/` (canvas game, static site, Node server, Python server). A card opens a new chat in the chosen project with the message begun ("Start from the … template (scaffold it), then build: "); you finish the sentence.
- your 6 most recent chats
- a card per project with its chats, spend and budget bar, plus ＋ New chat here and ⚙

Deleting the chat or project you're in brings you back here; so does clicking the QuorX name in the top bar. A `?chat=<id>` link still opens that chat directly.

### Top bar: the whole app only
- **💲:** off by default. Turn it on in ⚙ Settings → Privacy & display. Hovering shows the last hour, today, this week, and (behind 👁) all-time spend, credit left and the key limit.
- **◐ theme:** system, dark or light.
- **⚙ Settings**

Things that belong to a chat or a project sit next to it. ☰ and ＋ New chat are in the sidebar; ◧, 🗂 and the cost badge (usage) are in each chat's header. On phones, ☰ in the top bar opens the sidebar as a drawer.

### Sidebar: projects and chats
- **☰** next to search collapses the sidebar to a slim rail of chat icons (Discord-style); ☰ on the rail expands it. **＋ New chat** starts a chat in the current project.
- **Budgets:** every project starts with a **$10 budget** for all its chats together, unless you choose "No limit" in its settings.
- **Under each project's name:** its chat count and spend. With a budget, a meter shows "$0.023 of $0.10" and "23% · $0.077 left". It's green, turns amber from 85%, and red with "Budget reached". Click it, or ⚙, to open **project settings**.
- **Project settings (⚙):** a window with:
  - the name (click to rename) and the folder (📂 Open in File Explorer, Change folder)
  - the **budget**: No limit or Set a budget. It has a live meter of what's spent, a − / $ / ＋ stepper and +$1, +$5, +$10, ×2. It can never go below what's already spent, and it's locked while a chat in the project is working (the server refuses changes then too, except from a reply's own "budget reached" card).
  - **costs per chat** (messages, top models, today, total), paged
  - a danger zone to delete the project
- **Near-budget notice:** at 80% of a project's budget, a widget appears at the top of its chats: "'Game' has used 86% of its $10.00 budget · $1.40 left", with a bar and **Raise budget**. At 100% it turns red and says replies pause until you raise the budget. ✕ hides it until the next threshold or a new budget. It's only on the page and never sent to the agent.
- **Click a project's header**, or the chevron at its top left (⌄ open, › folded, in the project's colour), to fold its chats away; click again to unfold. **Drag the ⠿ grip** at the right of a project's name to reorder projects (only the grip drags, so the buttons stay easy to click; keyboard: focus the grip and press ↑ / ↓). Both are remembered in this browser.
- Each **project** is two compact lines: its folder icon and name (long names are cut off), then **one strip** with its spend and its ＋ ⚙ 🗑 buttons. With a budget the strip reads `$0.42 / $10  4%` over a thin bar that turns amber near the limit and red at it; click the amount for the budget in project settings. Without one it shows the chat count, the spend and "no limit". See [Project budgets](#project-budgets).
- Each **chat** row shows a coloured avatar, its title, a preview of the last reply, how long ago it was active, its model and its cost.
- A chat that's **running** shows a pulsing green dot and "Working…". One that's waiting for your approval says so.
- Chats are sorted by their **latest reply**.
- Hovering a chat shows ⧉ (open it beside the current chat), ✎ rename and 🗑 delete.
- **💲 Costs** opens the cost calculator: today / last 7 days / all time, each project with a share bar, and each chat's messages, the models it used with their cost, today and total. Click a chat to open it.

### A chat: one agent
- **Header** (two tiers, designed with OpenDesign; `public/header.css`):
  - **Top line:** the project tag in the project's colour (click it to open the folder in File Explorer), the message count, the model (violet) and the cost badge (amber, with ▾; click it for the usage breakdown).
  - **Main line:** the chat's avatar, the **title** (click to rename), a state badge (Ready, a pulsing Running, or an amber "Needs your approval"). The buttons sit on the left so they never move when the pane opens or closes: ◧ pane, 🗂 explorer and **⋯**. ◧ hides and shows the pane even while a "Steps" trace is open; the trace comes back with it.
  - **⋯ menu:** rename, open the project folder, post usage in this chat and, set apart in red, **Clear conversation**.
- **Message box = this chat's controls:** the model (with its price; click to pick any model), reasoning, **🔒 Strict / ⚡ YOLO**, **🧰 Tools**, 📎 files, 🎤 mic and Send/Stop.
- **🧰 Tools:** each tool's model is a button that opens the model picker right there (it becomes model 1 for that tool in every chat). A 🎤 Mic row picks the speech-to-text model. The menu also switches the paid 🖼 Pictures, 🎬 Video, 🎵 Music and 🗣 Voice on or off **for this chat** (**off by default in every chat**). Making pages, code & servers and the browser are always on. Models and prices live in ⚙ Settings.
- **`@`** in the message box suggests recent chats in this project, this project's files, chats in other projects, and other projects. Type to filter. Picking one attaches it as context for your next message: a chat's recent conversation and artifacts, a file's contents, or a project's notes and file list.
- **Ctrl+K** (or **Search** in the top bar) opens one search over everything: chats (the six most recent before you type), the same commands as `/`, Home / theme / restart, "New chat in" any project, every Settings page, and the open project's files (a file opens in the pane's Files view). ↑ ↓ and Enter pick; Esc closes.
- **`/`** runs a command: `/model`, `/reason high`, `/strict`, `/yolo`, `/new`, `/clear`, `/undo`, `/usage`, `/files`, `/notes`, `/image`, `/attach`, `/costs`, `/skills`, `/settings` and `/help`.
- **Files of any kind:** 📎, paste or drag-and-drop, as many as you like. Each gets a chip saying what happened to it. Pictures are shrunk in the browser to at most 1568px; models that can see images get them directly, and the deciders can always look at them. Everything else is uploaded to the project's git-ignored `.quorx/uploads/` and read:
  - **What is read:** plain text and code, **PDF** (free on this computer with `pdftotext`, which Git for Windows includes; otherwise OpenRouter's free parser), **Word, PowerPoint (with notes), Excel (every sheet), OpenDocument, EPUB** and HTML.
  - **Small documents** (up to 15k tokens, ⚙ Settings → Documents) go into your message whole: **✓ included**.
  - **Big documents** are split into passages and embedded once with an OpenRouter embedding model (default `openai/text-embedding-3-small`, $0.02 per million tokens; any of the ~33 can be picked, with prices). The chip says **🔎 searchable** and shows the cost. The agent then uses **`search_docs`** (best passages with document, page and line numbers) and **`read_doc`** (exact numbered lines), and cites them. Measured: a 78k-token handbook took $0.0022 to index, and a question found the right section first.
  - **Costs that need your OK:** indexing that would cost more than $0.50 waits for **Make searchable · ~$x**. A scanned PDF with no text offers **Read with OCR · ~$x** (mistral-ocr, about $2 per 1,000 pages).
  - **Files it can't read** are saved anyway (**saved · agent decides**). The agent is told the name, type, size and path, and decides whether it can read them with its own tools (for example a Python script in `.quorx/scratch/`), or tells you what it would need.
  - **⚙ Settings → Documents** has the size for sending whole, the upload limit, the embedding model, the OK threshold, and **Send PDFs as files** (models that read files see the PDF itself, layout and pictures included; it costs more).
  - Documents belong to the project, so later chats in it can search them too. ✕ on a chip before sending removes the upload. Reading and indexing costs count toward the project budget.
- Every post has a **timestamp**. Each reply's footer shows its time, duration, cost and model calls, plus **↶ Undo changes** if it changed files. **✓ Checked** or **⚠ N problems left** says how the checks before the final reply ended (hover for the problems), and **step limit reached** when the reply used all its steps. A reply cut off by a restart shows **▶ Resume where it stopped**.
- **Message icons:** a finished reply has small icons at the bottom: **copy** and **⑂ remix**. Your messages show **↩ rewind** and **copy** under the bubble on hover. Code blocks have their own Copy button. There are no avatars: the bubble style already shows who wrote what.
- **↩ Rewind** (on your messages): the chat goes back to just before that message, and your message returns to the box to edit and send again. If the replies after it changed files, you choose **Rewind, keep the files** (only the conversation goes back) or **Rewind and undo the file changes**. That one undoes them newest first, warns before overwriting newer changes, and removes pages those replies made. Replies whose undo copy has expired keep their files either way, and the dialog says so.
- **⑂ Remix** (on replies): a new chat in the same project that starts with the conversation up to that reply. Files aren't touched, and the copied replies have no Undo.
- **Messages:** your posts are aqua bubbles on the right ("You"). Replies are cards with a violet edge and the model's initials; the edge glows green while working, turns amber while waiting for your approval, and turns red on an error. Both render **markdown**:
  - headings, bold, italic, strikethrough and highlight, links and images
  - lists (nested), task lists, tables (with alignment), block quotes and rules
  - fenced code with syntax colours, a language label and **Copy**
  - **math** with KaTeX: `$…$` or `\(…\)` inline, `$$…$$` or `\[…\]` as a block. Dollar amounts like "$0.15 in / $0.60 out" stay text. KaTeX loads from a CDN only when a message has math; offline, the formula shows as text.
  - **⧉** copies a whole message as markdown.
- **💭 Thinking:** with reasoning on (Low, Medium, High), models that share their reasoning (DeepSeek, for example) stream it into a "💭 Thinking…" block above the reply. It's open while the model thinks and folds to "💭 Thought · N words" once it answers; click to reopen. The same text is under each model step in Steps. Some models (for example Claude) keep their reasoning private, so nothing shows for them.
- **Reply footer:** the time, duration, cost and model calls in quiet colours (aqua, violet, amber, green).
- **Review changes:** under a reply that changed files, a folded card lists each file with what happened to it (A new, M changed, D deleted), its + / − lines, and **changed since** when a later reply or you edited it again. Your project's files come first, the agent's own `.quorx` files after. Click a file for its diff with line numbers; **↶ Undo file** puts back just that file (if it changed since, it asks first). The version it replaces goes to `.quorx/trash`, so that can be taken back by hand. The reply's **↶ Undo changes (N)** then covers only the files that are left. The card is there while the reply's undo copy is kept.
- **🧭 Steps:** a small button under each reply. Click it to open that reply's trace in the side pane (the button turns solid aqua and reads "✕ Close how it got here" while it's open) (every model call, tool call, permission ask, decision card, screenshot, command and file change, live while it runs). ✕ Close puts the pane back as it was.

### Reading a reply
- **A reply reads like a timeline, top to bottom.**
  - **Thinking:** one folded line per step ("💭 Thought · 812 words ›"); click it to read it.
  - **What the agent said** at that step, as normal text.
  - **Tool work:** one line for that step's tool calls, such as "Read 3 files, ran 2 commands ›". Click it to see each call and open its result.
  - **Cards and notes:** cards that ask you something (approvals, questions, the budget card) and the notes you sent while it worked sit where they happened.
  - **The final answer** comes last, followed by any reviewer cards.
  - **Full detail:** the 🧭 icon in the footer opens the whole trace in the side pane.
- **Open lines stay open** while the reply keeps updating.
- **The chat follows the newest output** while you're at the bottom; ↓ Latest jumps back after you scroll up.
- **Reordering projects:** drag one by its ⠿ grip. A small name pill follows the pointer, the project stays in place as a dashed outline, and a bright line shows where it will land. The list scrolls by itself near its edges.

### 📊 Usage (per chat)
The **cost badge** in the chat header (`$0.077 ▾`) opens a live breakdown of what this chat has cost: the total, replies and model calls, then one group per kind of call (💬 chat model, ⚖️ deciders, 🗜 summaries, 🖼 pictures, 🎬 video, 🎵 music, 🗣 voice, 🎤 mic). Each model shows its calls, tokens in and out, cost and share. **📌 Post in this chat**, or the **`/usage`** command, adds that breakdown to the conversation as a card. It's your note: usage cards are never sent to the agent or included when another chat is attached with `@`. ✕ removes a card.

### One chat on screen, many running
One chat is on screen at a time, with its own artifact pane; there is no side-by-side view. Every chat still runs on its own: start a long task, switch to another chat, and the first keeps working. The sidebar shows a live dot and "Working…" (or "Waiting for your approval / answer"), and the reply is there when you come back. Replies run on the server, not in the page: **closing or reloading the page doesn't stop them**. The page picks them up again and replays what it missed. Only ■ Stop stops a reply. Two chats in the same project share its folder and servers; chats in different projects are fully separate.

### Artifact pane (always the hosted, newest version)
The pane works like a small browser of its own.
- **Tabs:** **Artifact** (with a count), **Browser**, **Steps**, **Terminal** (with a count of what runs in the background) and **Files**. Click the open tab again to go back to Artifact.
- **The address bar** shows where the open thing is served: `/art/<chat>/<id>` for pages and documents, `/ws/<project>/…` for sites, `http://localhost:53xx/` for running apps. It has ↻ reload, ⧉ copy and ↗ open in a new tab. Pictures and media embedded in the chat say so instead. Type any address and press Enter to look at it yourself in the Browser tab.
- **Browser:** a small browser with its own tab strip. It has **🤖 the agent's page** for this chat, live: the very tab the agent's `browser` tool is driving, refreshed every second and **watch-only while its reply runs**. When the reply ends, that page is yours to use. You can also open tabs of your own (＋, ×), and a new tab offers quick links to what the chat built and its running servers. Outside sites run in the harness's headless browser, sized to the pane: you see a live picture, and clicks, the scroll wheel and typing (keyboard, paste or IME) go through, with ◀ ▶ for back and forward and ↻ to reload. Your own served pages can show in a frame instead. With **☑ Follow the agent** the pane switches to the agent's page whenever it starts browsing. Step-by-step screenshots stay in Steps.
- **Terminal:** tabs like a real terminal: **≡ Activity** (everything), **🤖 Agent** (its commands), one tab per server, and your own **Terminal 1, 2…** (＋, ×). Each of your terminals is a **real shell**: PowerShell 7 if it is installed, else Windows PowerShell; your login shell (bash, zsh…) on macOS and Linux. It starts in the project folder, and pipes, quotes, scripts, git, installs and dev servers all work; the prompt follows the shell's folder. While a command runs, what you type goes to it as input; **■** stops it (there is no Ctrl+C without a terminal, so the shell restarts, in the same folder). It is a plain process, not a terminal emulator: full-screen programs (vim, htop, arrow-key menus) need a terminal app. Only your own windows reach it: requests from other sites are refused, pages the agent writes are served sandboxed, and the agent's browser cannot open the harness's own pages. The agent never uses it; its `run_command` keeps the allow-list. History is ↑ ↓; `clear` empties the tab; closing a tab ends its shell. A **Running** strip at the top lists every server and command running in the background (■ to stop), plus what is running in other projects.
- **Phones:** the tabs scroll sideways in the Preview view.

Page and document artifacts are **hosted by the server** at `/art/<chat>/<artifact>` and the preview loads that address. Documents the agent writes in Markdown (`write_artifact` with `markdown`: reports, research notes, plans) are served as a rendered, readable page in both themes. So the preview, and ↗ in a new tab, always show the newest version: while a reply is still writing it, that's the agent's latest copy. Hosted pages run sandboxed: even in their own tab they can't call the app's API. They also get thin scrollbars that suit the theme; the artifact's own code is unchanged. Sites and running apps **reload on their own** when files in the project folder change (checked every 2.5 s while shown, and right away when the agent writes a file). An opened **🧭 Steps** is an entry in the pane's dropdown, so you can switch between the output and the trace. There's only one: opening another reply's trace takes its place, and ✕ Close removes it.

**Artifacts are for planning only:** plans, specs, research notes, reports and comparisons, as Markdown or a self-contained HTML page, and the Artifact tab shows no address. What the agent builds (sites, apps, games, tools) lives in the project folder and runs from the launch file: it opens in the **Browser** tab and is listed under **🖥 servers**. Pictures and other media are in **Files**. Artifacts have **no versions**: an edit replaces the artifact in place. The pane's top rows are compact: the tabs, then one toolbar with the browser's controls and the address (icons; hover any of them for what it does). Its buttons:
- **↻** reload and **↗** open in your own browser; in the Browser tab also **◀ ▶** back and forward, the address, and **⧉** copy it (a **Copied** tip confirms).
- **Files** (also 🗂 in the chat header): this chat's artifacts, then the project's files as a folder tree, each previewed like in an editor: **pictures** (size, click for actual size), **video** and **audio** players (with their length), **PDF** in the browser's viewer, the text of **Word, PowerPoint, Excel, OpenDocument and EPUB** files, **CSV/TSV** as a table, **fonts** as a sample, and **Markdown, HTML pages and SVG** with **Preview / Source**. Everything else opens in the code viewer. Each preview has **Copy path** (with a Copied tip) and **Open ↗**. It shows HTML, CSS, JS/TS, JSON, Python, Markdown and shell with syntax colours, line numbers, ✨ Formatted / Original and ⧉ Copy. It opens on the artifact you were looking at, so its code is one click away. **📂 Open in File Explorer** is in its bar.

Servers are run, stopped and edited from **🖥** (with their logs in the Terminal). The pane can also show the **⌨ Terminal** (below). Pages the agent writes as artifacts are stored with the chat. Files it writes with `write_file` are in the project folder.

### ⚙ Settings
A full page: categories on the left, that category's settings on the right. A search box searches every category. Changes are a draft until **Save**. **Cancel** or Esc drops them, and **Reset category** restores that category's defaults.

| Group | Categories |
|---|---|
| Harness | **Setup check:** one row per thing this computer needs (OpenRouter key, the harness address, Git, Python 3, Edge or Chrome, pdftotext, PowerShell 7, Node.js for the web version, free space), with a Ready / Optional / Missing pill, what it is for, what was found, and one Fix: Sign in for the key, a download link for a browser, or on Windows **Install with winget**, which opens winget in its own console window so you see and answer its prompts (only from this computer, only for that list of packages). **Check again** re-runs it. The first time a key is in, the page runs it once and opens it if something is missing. **Appearance:** theme with previews, density, message text size, **motion** (Follow system, the default, uses Windows' Animation effects setting; or On / Reduced), timestamps (time / relative / off), and **notifications**: while QuorX is in the background it tells you when a reply needs your approval or answer, hits the project budget, or ends (Needs me or ends / Needs me / Off). The browser asks once, on your first Send; in the desktop app clicking one brings the window back from the tray and opens that chat. **Layout:** sidebar at start, artifact pane (auto / always / only when asked), reset project order. **Privacy & display:** 💲 button in the top bar (off by default; click it to open a card with last hour / today / this week, then all time, credit left and key limit, masked until 👁; click 💲 again, click outside or press Esc to close it), hide amounts until 👁, blur folder paths. On/off options are square ✓ boxes, never sliding switches. **Compact** density tightens the chat header, messages, sidebar rows, composer and trace without overlapping anything. |
| OpenRouter | **API keys:** add, verify, activate, rename or remove keys. Each key shows its spend for the last 1 h, 3 h, 24 h, 3 days and 7 days, and (behind 👁) all time, plus its limit bar. **Account credits:** total credits and total used, both behind 👁. **Models & catalogue:** refresh model lists and prices, default chat model and reasoning. |
| Agent | **New chats** (permission mode, which paid tools start on), **Agent loop** (**Plan first**: Off, Big tasks or Always. With it on, the agent's first plan in a reply waits on a "Plan first" card: **Go ahead**, **Stop here**, or type what to change and it plans again. File changes, commands and servers are refused until you say Go ahead; reading and searching are fine. Big tasks lets small fixes through without a plan. It waits for you in 🔒 Strict and ⚡ YOLO alike and isn't counted as one of the reply's questions. Max model calls, default 60 and up to 120; output per model call, default 64k tokens and never above the model's own limit; the thinking share of that output, default 25%; retries on model errors; look-ups together; the checks before the final reply and how many rounds to fix; questions per reply; when to trim a long reply; when to summarise long chats), **Deciders**, **Tools & media** (models per tool), **Budget & approvals** (media cap per reply, the YOLO decider check, the allowance a running reply may go past the project budget), **Skills**. |
| Workspace | **Projects:** open in File Explorer, change folder (the name follows it), remove, new project. **Code & servers:** allowed commands, dev-server ports, headless browser, how secrets are protected. |
| Data | **Usage & costs** (the cost badge in chat headers on/off), **Data & storage** (export every chat as JSON, clear this browser's preferences), **Shortcuts**, **About**. |

OpenRouter reports a key's total, today, this week and this month. The 1 h, 3 h, 24 h, 3 day and 7 day figures are measured by the harness: while it runs, it samples each key's running total every 10 minutes (and whenever you look) in `data/key-usage.json`. A window longer than the samples so far says "since <time>".

### 🔒 Strict vs ⚡ YOLO (per chat)
- **🔒 Strict:** the agent asks before **every** tool it uses. Each card offers:
  - **Allow once** (for paid calls, **Approve $…**, with a model menu to switch first)
  - **Always allow**, which stops asking for that tool in this chat (click the chip under the header to take it back). Cards for the same tool that are open at that moment, from look-ups running side by side, are answered with it.
  - **Decline**, with a reason the agent reads
- **⚡ YOLO:** the agent never asks you. By default the deciders still check each paid call ("needed?", "fair price?"). Untick that in ⚙ Settings for no checks at all.
- In both modes, the **per-reply media cap** stops any paid picture, video, music or voice call that would go over it, and the [project budget](#project-budgets) stops the reply itself at its limit.
- **Questions** from the agent (`ask_user`) are not permissions: they show in both modes as a card with 2–4 options and a box for your own words, and the reply waits for your answer.
  - **Several at once:** the agent can send up to 4 questions in one card, each with the answer it recommends already ticked. Change what you like, type your own words under any question, then **Send answers**, or take them all with **Use the recommendations**. Each question counts against the questions-per-reply limit; ones past it aren't asked, and the agent is told to decide those itself. In ⚡ YOLO the deciders answer each one.
  - **Not for taste:** the agent is told never to ask you to pick a visual style, palette or font. It chooses one direction itself and says what it chose, so you can ask for another.

## How a reply runs

The loop borrows the parts of ALMA's build harness that make long builds reliable. It keeps what QuorX already did better: real commands and servers, your approvals, and Undo. It also goes further where running real tools makes that possible.

| Part | What happens |
|---|---|
| **Steps** | Up to 60 model calls per reply (⚙ up to 120). Every tool result ends with `[steps: 12 of 60 used · media: $0.02 of $0.50]`. At 80% the agent is told to stop adding features and wrap up. After 8 steps of only looking around, it's told to make the changes. The last step must be a plain summary. |
| **Retries** | A failed model call (rate limit, network, provider error) is retried up to 3 times with growing waits, shown as ↻ in the trace. Bad requests aren't retried. If the model keeps failing after real work, the reply ends with a ⚠ note, and the files it changed stay (and can be undone). |
| **Thinking can't eat the answer** | Reasoning low / medium / high gets a thinking budget of about 3k / 8k / 16k tokens, never more than half the output limit, so there is always room to act. If a call still comes back with no text and no tool call (all of it went on thinking), the agent is told to act now and the call is retried with less reasoning (high → low → off), at most twice. If it still gives nothing, the reply says so instead of ending blank. |
| **Look-ups together** | Up to 4 neighbouring reads, listings, searches, fetches or skill loads in one step run at the same time (⇉ in the trace). Writes, commands and everything else run alone and in order. In 🔒 Strict each still gets its own card. |
| **Reading files** | `read_file` returns numbered lines, 400 at a time, and says where to continue (`offset`). Long artifacts come the same way. |
| **Editing files** | `edit_file` takes one find/replace or up to 20 `edits`, applied all or none. |
| **A check after every write** | After `write_file`, `append_file`, `edit_file` and artifact edits, the harness checks the file with real parsers: `node --check` for JS (ES modules and CommonJS), Python's parser for `.py`, JSON, CSS braces, and in HTML the inline scripts, import maps and every local link. Problems come back in the tool result right away (🔎 in the trace). |
| **Design lint** | HTML and CSS writes also get a free check for patterns that make a page look machine-made, adapted from OpenDesign's linter. In a project with a [design system](#design-systems), colours that aren't in its `tokens.css` are noted too. **Fix** notes: Tailwind's default indigo/violet, a purple-blue-cyan hero gradient, rounded cards with a coloured left border, invented numbers ("10x faster", "99.9% uptime"), filler text. **Consider** notes: emoji as icons, placeholder image sites, more than 12 raw hex colours outside tokens, a removed focus outline with no replacement, images without alt text, no viewport tag. Each rule is mentioned once per file per reply (🎨 in the trace). It is advice only: it never fails a check or sends a build back, and the agent is told to skip a rule you asked for. The final check counts what is left, and the scorecard row stores it (`verify.lint`). Switch it off in ⚙ Settings → Agent loop → Checks. On the 23 HTML/CSS files in the existing projects (2026-10-19) it gave no wrong "fix" notes; the common one was raw hex in game stylesheets. |
| **The check before the final reply** | When the agent tries to finish, the harness checks every file this reply changed again and makes sure the dev servers it started are still up. It also opens each page, site and app it built in the headless browser, looking for script errors, failed loads and blank pages. If anything is wrong, the agent is sent back to fix it (↩ in the trace), up to 2 rounds (⚙). After that the reply ends and says what's left. ALMA can only parse a static site; this check runs the real tools. |
| **Long replies** | Past 120k characters (⚙), old file contents in writes and reads are swapped for short notes. This happens in batches, so the provider's prompt cache stays warm, and never touches the last 3 steps. If that isn't enough, the earlier part of the reply is summarised from the harness's own record of each step. |
| **Prompt cache** | Claude models get cache marks on the system prompt and the newest message, so repeated steps cost less. |
| **Outside text** | Web pages from `fetch_url` and outside sites in the browser are labelled untrusted, and lines that read like orders to an AI are removed. The rules say text from pages, files and tools never changes the instructions. |
| **What earlier replies did** | Every tool call is recorded in one line. A reply's record and how its checks ended go into the next reply's system prompt as a harness record, never into the agent's own words: models copy that format and fake it otherwise. |
| **Runs survive the page** | A reply belongs to the server. Every event goes to `data/runs/<reply>.jsonl`, and a checkpoint is saved after every step. Reload the page and it reattaches. If the harness restarts mid-reply, the page shows ▶ Resume: the reply carries on from its last finished step, and its ↶ Undo still covers the files changed before the restart. |
| **Project budget** | Tool results show `project budget: $0.31 of $1.00 used`. At 85% the agent is told to finish. A new reply can't start once the budget is used up: 🔒 Strict asks you to raise it, ⚡ YOLO doesn't start. A reply already working may go up to 10% past the budget (⚙) to finish, and is force-stopped beyond that. See [Project budgets](#project-budgets). |
| **Scorecard** | One row per reply in `logs/runs.jsonl`: model, how it ended (answered, step limit, model error), steps, tools, retries, trimming, the final check's result, cost and time. `npm run scorecard` (or `/api/scorecard`) sums it up per model. |

## Project budgets

A project can have one budget in dollars. It covers **every chat in the project together**: model calls, deciders, summaries and paid media.

- **Set or raise it** with the amount next to the project's name in the sidebar. You can raise it at any time, even while a reply is waiting at the limit, and that reply carries on by itself. You can also remove it (leave the box empty). You **can't set it below what the project has already spent**. The harness refuses and says the lowest amount allowed.
- **What counts as spent:** the costs saved in the project's chats (what the sidebar shows), plus replies running right now as their cost grows. It also includes replies whose cost never reached a chat: ones you stopped, ones that ran while the page was closed, and chats you deleted later. Each reply's cost goes into `logs/runs.jsonl` when it ends, however it ends, so deleting a chat doesn't give money back to the budget. A reply resumed after a restart keeps the cost it had before.
- **A reply that is already working finishes its work.** Tool results carry the meter, and at 85% the agent is told to finish what it's doing. If the reply passes the budget anyway, it isn't cut off mid-task. The agent is told once that the budget is used up, to finish the task it's on in as few steps as possible and add nothing new, and when it will be stopped. It may go **up to 10% past the budget** (⚙ Settings → Budget & approvals → *Allowance to finish a reply*, 0–100%).
- **Force stop past the allowance.** Once the project's spend goes beyond budget + allowance (for example $1.10 on a $1.00 budget), the harness stops the reply at once: no further model call, and the tool calls of the call that crossed the line aren't run. The harness writes the reply itself, saying what was done, what wasn't run and how to carry on. The footer says **stopped past the budget**. A paid media call that would go beyond the allowance is declined.
- **The next reply is what the budget stops.** A new reply in any of the project's chats can't start once the budget is used up:
  - **🔒 Strict:** a 💵 card shows what's spent. **Raise and carry on** sets a new budget, suggesting about double the old one, and the reply starts. **Wrap up** means it doesn't start. Raising the budget from the sidebar works the same way. While it waits, the sidebar says "Waiting: project budget reached".
  - **⚡ YOLO:** the reply doesn't start (no model call). The harness says so and how to carry on. The footer says **budget reached**.
- Projects have no budget until you set one.

## The model decides when to ask the deciders
There are no strategy presets anymore. Every agent always has `decide` and **chooses itself** when a judgment is worth asking about. It writes its own questions and commits its own guess first, so the trace shows whether asking changed anything. The deciders can also **look at images**:
- `images: ["attached:1"]` for your attached images (sent automatically if the agent names none)
- `"screenshot"` for the page open in its browser
- `"artifact:<id>"` for one of its pictures or pages

Open questions sent as yes/no ("What shape…?") are bounced back with the fix ("use a choice with options"), because small models do this.

Measured: Ling 3.0 Flash, a text-only model, was given a picture of a red circle. It asked the deciders "What shape?" and "What colour?" as choices (circle 0.99, red 0.99) and answered correctly, for $0.0002. The forced-asking and draft strategies remain only in the **benchmark** (`scripts/bench.mjs`, which marks its runs with `bench: true`).

## Project memory, skills and templates
- **`AGENT.md`:** every chat in a project gets the project's notes in its context. The agent keeps them current: what the project is, how to run it, a file map, decisions and to-dos.
- **Work log:** after each reply that changed something, the harness adds one line to `<project>/.quorx/log.md` (time, chat, model, what changed). The last 15 lines are in every chat's context.
- **Skills:** playbooks the agent loads with `use_skill` when a task fits. Only their names and descriptions sit in the prompt.
  - Built in: `web-app`, `design-craft`, `design-system`, `node-server`, `canvas-game`, `ui-review`, `debug-loop`, `decide-well`, in `skills/<name>/SKILL.md`.
  - `design-craft` covers committing to one visual direction (decided by the agent, never asked), tokens, type, colour, layout, content, states and accessibility. It is adapted from OpenDesign's craft rules (Apache-2.0) and refero_skill (MIT). `web-app` loads it.
  - **The agent writes its own:** after a task that took several attempts, `save_skill` stores what worked in `<project>/.quorx/skills/`.
  - ⚙ Settings lists every skill with an on/off switch.
- **Templates:** `scaffold` copies a starter project in without overwriting anything: `static-site`, `node-http` (`server.cjs` + `public/`), `canvas-game` (plumbing only, with no gameplay to copy: states, keyboard/mouse/touch input, delta-time loop, sound, particles and screen shake; the game goes in three hooks) and `python-http`. Each sits in `templates/<name>/` with a `template.json`.
- **More tools:**
  - `search_files` (literal search with a glob filter)
  - `delete_file` (moves the file to `.quorx/trash`)
  - `append_file` (large files are written in parts)
  - `fetch_url` (https pages as text, up to 20k characters, labelled untrusted; private addresses are blocked)
  - `ask_user` (a question with options, see above)
- **Big files:** each call may write up to the **Output per model call** setting (64k by default), never more than the model's own limit, and thinking gets at most its share of that (25% by default). The rules say never to draft code in thinking: plan briefly, then write straight into files. If a reply is cut off mid tool call, nothing is written and the agent is told to write in parts. If a step comes back with no answer and no tool call because thinking used the whole output, it's retried, up to twice, with lower reasoning. The model gets back the start and end of its own plan, so the idea isn't lost. It never fails silently.
- **Reasoning carries between steps:** the model's reasoning (OpenRouter's `reasoning_details`) goes back unchanged with its tool calls, so each step continues its thinking instead of planning again. Only within one reply. If a provider refuses it, that reply carries on without it and the trace says so.
- **Creativity (per chat):** **🎨 Creativity** beside **🧠 Reasoning** in the message box: **Default** sends no temperature, so each model uses its own; **Focused** (0.3) is for fixes and data; **Creative** (1.0) is for games, designs and writing. It's only sent to models that accept it. Claude with reasoning on only takes Creative.
- **Plan first (live to-do list):** for a build (an app, game, site, tool, or a change across several files), the agent first calls `plan`.
  - **What the plan holds:** a short spec (what it will build and what will make it good rather than merely working), a to-do list, and "done when" checks.
  - **On the reply:** it shows as a checklist with a progress bar. Items tick off (✓ done, ◐ in progress) as the agent calls `plan` again. The spec and the checks fold open.
  - **On disk:** it's also written to `.quorx/plan.md`.
  - **Strict and the meter:** in 🔒 Strict, the first plan asks for your OK and later updates don't. Each tool result's step meter shows `plan: 2 of 5 done`.
- **Reviewer (⚙ Settings → Agent loop → Reviewer):** when the builder gives its final reply and the file and page checks pass, a **separate model with a fresh context** tests what was built.
  - **What it sees:** your request, the plan and its done checks, the list of pages and apps, and the builder's summary, which it treats as claims to check. It never sees the builder's conversation.
  - **How it tests:** it opens each target in the same browser you can watch in the pane, clicks, presses keys and plays. When the model can see images, it gets a screenshot after each action.
  - **The verdict:** it submits scores from 1 to 5 for **function, craft, design, originality and accessibility** (contrast, labelled controls, Tab with a visible focus, and a look at phone width), specific bugs, and a short summary.
  - **Brand fit:** when the project folder has a `DESIGN.md`, the reviewer gets it and also scores **brand fit**. A reviewer that leaves out the accessibility or brand score isn't failed for it; a missing core score still counts as 1.
  - **In the build benchmark** the judge scores accessibility too, but pass still means the four core scores reach the bar, so pass rates stay comparable with earlier runs. Accessibility shows as its own `a11y` column.
  - **Below the bar:** if any score falls below the bar (3 by default), the builder gets the bugs and fixes them, up to **Rounds to fix** (1 by default). Anything still open after that is listed in the reply.
  - **On the reply:** each round shows as a card with the scores, the bar and the bugs. Its steps show in "Steps", marked 🧪 reviewer.
  - **When it runs:** **Builds** (default) reviews when the agent made a plan; **Always** reviews whenever something openable was built or changed; **Off** never reviews.
  - **The model:** the default reviewer is `openai/gpt-6-luna`. It's cheap, sees screenshots, and comes from a different family than most builders; `qwen/qwen3.7-flash` reviews instead when the chat itself uses gpt-6-luna. Pick another in Settings; it needs tools and image input.
- **Helpers (⚙ Settings → Agent loop → Helpers):** in a chat with a project folder, the agent can call `delegate` to hand a read-only job to a **helper**. Typical jobs: explore the project, find where something is handled, summarise some files.
  - **Clean context:** the helper runs on a cheaper model, `qwen/qwen3.7-flash` by default (very cheap, uses tools, 1M-token window). It sees only the task and the project's file list.
  - **What it can do:** `list_files`, `read_file`, `search_files`, plus `read_doc` and `search_docs` when documents are attached.
  - **Only the report comes back:** a short report (about 400 words, with `path:line` references). The files it read never enter the main agent's context.
  - **Several at once:** several `delegate` calls in one step run at the same time.
  - **Read-only:** helpers never write; every change stays with the main agent.
  - **In the trace:** helper steps show as 🤝 helper, with their own steps, time and cost.
  - **Settings:** switch helpers on or off, pick the helper model, and set the steps per helper (12 by default).
- **Real key presses:** the headless browser's `press` sends the real `key`, `code` and key code for every key, for example Space as `' '`, `Space` and 32, and P as `P`, `KeyP` and 80. Games that check `e.code` respond to the agent and the reviewer just as they do to a keyboard.
- **Routing (⚙ Settings → Models → Routing):** these apply to every chat's agent calls.
  - **Provider order:** Auto lets OpenRouter favour providers with reliable tool calling (Exacto); Cheapest and Fastest sort by price or speed instead.
  - **Only providers that support every feature:** on by default. If no provider qualifies, that reply uses OpenRouter's default routing instead.
  - **Zero data retention only:** keeps your prompts to providers that store no copy.
  - **Fallback model:** none by default; OpenRouter switches to it when a chat's model fails, billed at its own price.
  - **In the trace:** every step in "Steps" shows the provider that answered (`via …`), and a step answered by the fallback model is marked.
- **↶ Undo:** before a reply first changes a file, its previous version is saved in `.quorx/checkpoints/<reply>`. Undo puts every changed file back, and files the reply created move to the trash.
  - **It doesn't last forever.** Only the **newest 10 replies per project, for at most 7 days**, keep Undo (⚙ Settings → Code & servers). Older undo copies are removed when a new reply starts, and their footer says *↶ undo no longer kept*. It survives page reloads and harness restarts, because replies keep running on the server. For history that lasts, use git.
  - **It won't silently throw away newer work.** When a reply ends, its checkpoint records what each file looked like. If a later reply or you changed one of those files since, Undo lists them and asks: **Undo only the other files**, **Undo everything (overwrite newer changes)**, or Cancel.
- **Long chats:** past about 24k characters of history, the older turns are summarised once (shown in the trace as 🗜) and only the summary plus recent turns are sent.

Measured: a fresh chat asked for "a simple dodge-the-blocks game" loaded the `canvas-game` skill, scaffolded the template, previewed it, played it in the browser and checked it with `look` at desktop and 390px, for $0.025. A second chat in the same project read the notes and log, fixed the title with two small edits, confirmed it at 360px and wrote `AGENT.md` ($0.006). Undo restored `game.js` exactly and moved the new `AGENT.md` to the trash.

## Design systems

A project can have one look that every chat builds to. It is two files in the project folder's root:
- **`DESIGN.md`**: the look in words (colours with their roles, type, spacing and shape, components, do and don't).
- **`tokens.css`**: the same values as CSS custom properties, linked by every page (`<link rel="stylesheet" href="tokens.css">`) and used with `var()`.

When a project has them, every chat gets `DESIGN.md` in its context and is told to follow it, link `tokens.css` and not ask you to pick a style.

**⚙ Project settings → Design system** (next to the folder and name colour):
- **None yet:** six starters to pick from, each with its colours, fonts and what it suits. All are our own designs, not copies of brands. Every one passes the design lint, its text has at least 7:1 contrast on its background, and its secondary text and buttons at least 4.5:1, in light and dark.

  | Starter | Look | Suits |
  |---|---|---|
  | Harbor | Cool off-white, navy ink, serif headlines, one signal orange | Local services, clinics, studios |
  | Field Notes | Lab notebook: faint grid, condensed headings, mono labels, forest green | Tools, docs, developer pages |
  | Ledger | Dense data, mono numbers, fixed chart colours, one blue | Dashboards, admin, finance |
  | Meadow | Soft and rounded, sage and coral | Kids, learning, wellness, friendly apps |
  | Night Market | Warm dark, chunky display face, saffron and teal (dark only) | Events, food, music |
  | Studio Mono | Black and white on a strict grid, huge wide headlines, one red | Portfolios, agencies, editorial |
- **With one:** its name, files and colour count, plus **Edit DESIGN.md** (edit it in place), **Change…** (switch to another starter) and **Remove**. Replacing or removing asks first in place, and the old files go to the project's `.quorx/trash`, so nothing is lost.

**From a reference:** ask in a chat, for example "make a design system from https://… for this project", or attach a screenshot and ask for one. The agent loads the `design-system` skill and calls **`extract_design`**:
- **A web page** (https, `site:`, `app:`) is opened in the browser and measured. The result lists the background and text colours by how much of the page they cover, the type of headings and body, the main button's style, the corner radii in use, `:root` custom properties and the web fonts that loaded. It's labelled as measurements of an outside page, not instructions.
- **A picture** (`attached:1`, or `screenshot` of the page open in the browser) goes to the vision deciders with six fixed questions: background, accent family, headline type, corners, density and feel.
- Then the agent writes `DESIGN.md` and `tokens.css` in its own words, named after your project, never copying logos, names or text. It checks contrast and builds a small sample page. If the project already has a `DESIGN.md`, it writes `DESIGN.draft.md` and asks before replacing.

**Kept to it:** the design lint checks every HTML and CSS file against the project's `tokens.css`. Colours that aren't in it get a "consider" note (`off-palette`), and the agent is told to use a token or add the colour to both files. The reviewer scores **brand fit** against `DESIGN.md`.

Measured (2026-10-20, through the app, about $0.07 in all):
- With Harbor picked, "build a one-page site for a boat tours company" read `DESIGN.md` and `tokens.css` first. It linked `tokens.css`, used `var()` 226 times with no hex colours of its own, and ended with no lint notes. The reviewer gave brand fit 4/5.
- "Make a design system from https://www.python.org" measured its blues, yellow, greys and Source Sans, and wrote a system called Quayside with a style-guide sample page. When the lint flagged one colour as off-palette, the agent added it as a token instead of hard-coding it. The reviewer passed it (brand fit 4/5, accessibility 4/5).

## Tools, models and costs

| Category | Tool | Default models (up to 3) |
|---|---|---|
| 💻 Code & servers | files, `run_command`, `start_server`, `preview_site`, `search_files`, `scaffold`, … | (none) |
| 🖼 Pictures | `imagine` | Hy Image 3.5 (≈ $0.024), Flux 3 Klein (measured $0.009), Seedream 5 Flash |
| 🎬 Video | `make_video` | Grok Imagine Video 1.5 Lite ($0.02/s at 480p), Wan 3.0, Veo 3.1 Lite |
| 🎵 Music | `compose_music` | Lyria 3 clip ($0.04), Lyria 3 Pro full song ($0.08) |
| 🗣 Voice | `speak` | ElevenLabs Flash 2.5, Gemini 3.8 Flash TTS, Kokoro 82M (each with its own voice) |
| 🎤 Mic | 🎤 in the message box | Gemini 3.1 Flash Lite, Qwen 3.8 Omni Flash, MiMo 2.6 Flash (model 1 is used) |

⚙ Settings holds everything that applies to the whole app:
- what new chats start with (model and permission mode)
- the deciders (up to 5) and their thresholds
- each tool category's models, with **Model per call**: *I pick* or *Agent picks among these*
- picture size, video resolution and length, voices
- the budget per reply and the YOLO check
- skills
- the agent loop: model calls per reply (default 60, up to 120), output per call and the thinking share, retries, look-ups together, the checks before the final reply, questions per reply, when to trim a long reply

Every place a model is chosen opens the same **model picker**: the chat model, the default model, deciders, and the picture, video, music, voice and mic models.
- **Top:** the current model with its price.
- **Search** by name, id or provider.
- **Sort:** Cheapest, Priciest, Newest, Oldest, Name or Largest context. It's remembered per kind of model.
- **Filters that combine:** Free, 👁 sees images, 🧰 uses tools, 🧠 reasoning, 📜 long context (200k+), ✨ new (60 days) and ★ favourites, each with a count. **Providers** is a searchable multi-select, also with counts.
- **Each row:** the provider badge, name and id, capability icons, context size, age, and the price in the right unit (per M tokens in and out, per picture, per second, per clip, per M characters). Free models show a FREE badge.
- **★ Favourites** and **Recently used** sit at the top.
- **Long lists** load as you scroll. ↑ ↓ and Enter choose, Esc closes.

The model lists are public, so you can browse them before adding a key; a banner says nothing will run until you do. If OpenRouter can't be reached, the picker says why and offers ↻ Try again. Adding or switching a key reloads the lists everywhere.

The reasoning control in the message box is the app's own menu (Off, Low, Medium, High, Model default, each with a short note), not the system dropdown. It shows "No reasoning" for models that don't support it.

How paid calls are priced:
- **Pictures:** about 15k image tokens per 1K picture.
- **Video:** the catalogue's per-second price at the chosen resolution.
- **Music:** the list price.
- **Voice:** the price per character.

After the first real call, a model's billed cost is remembered, so later cards show a *measured* price. Video runs as a job (submit, poll every 4s, download): a 3-second 480p Grok Lite clip took 29s and cost $0.059.

## Look and layout

The UI theme was designed with **OpenDesign**, from a snapshot of this page's real markup, so its stylesheet maps onto every class the app uses:
- **Structure:** a Discord-style channel sidebar, X-style post timeline, and YouTube-style artifact "player".
- **Colours:** black base, **forest green** for primary, approve, Strict and send; **aqua** for focus, info and asks; **red** for YOLO, stop, declines and errors.
- **Fonts:** Inter and JetBrains Mono.
- **Icons** (`public/icons.js` swaps the emoji in app.js as the page renders): things such as files, money, media and keys are the coloured icons in `public/icons/`; actions and chrome (✕ close, ↻ reload, ⧉ copy, ◧ pane, ☰ menu, ↗ open, 🖥 servers…) are line icons in `public/icons/line/`, drawn in the button's own colour. 🟢🟡🔴 ratings and 📘📕📙📗 document kinds stay emoji because their colour is the meaning. A control with only icons gets a spoken name (its title, else the icon's name), and icons beside words stay silent.
- **Theme toggle:** ◐ in the top bar cycles between system, ☾ dark and ☀ light.
- **Resizing:** drag the thin bars between the sidebar, the chat and the artifact pane to resize them (keyboard: focus a bar and use ←/→; double-click resets). Sizes are remembered in this browser.
- The design project lives in `../../OpenDesign/agent-001-harness-redesign/`: `theme.css` and `index.html` (v1), then `v2/theme-v2.css` and `v2/index.html` (the simplified layout: sidebar rail, thin chat header, one composer box, the 🧰 popover, the @ / popup and the 💲 card). `public/style.css` is the v1 theme, the app's additions, and an "OPENDESIGN V2 PORT" section at the end that fits v2 onto the app's markup.
- **v4 "visual grammar" theme** (`public/theme-v4.css`, from `v4/theme-v4.css` in the design project): each kind of element has its own look.
  - Solid green is only for the main action (Send, Save, Approve).
  - Secondary actions sit on a neutral raised surface, and icon tools are square ghost buttons.
  - Strict/YOLO is a track switch (green or red), status pills are a dot with a tint, and tags are flat.
  - Model names are violet mono, money is amber mono everywhere, and inputs are recessed with an aqua focus ring.
  - Your posts are bubbles and replies are cards.
- **Load order:** `style.css`, then `theme-v4.css`, then `header.css`, then `last.css` (the sidebar's project colours, and fixes that must win).
- **Phones and small tablets (≤ 900px):** a dedicated layout. A bottom bar switches between 💬 Chats, 🗨 Chat, 🖼 Preview and ⚙ Settings, with one full-screen view at a time. Tapping a chat, an artifact chip, 🧭 or 🗂 goes to the matching view, and a dot on Preview means something new was built.

## Projects, chats and history

- **Sorted by the latest reply:** the sidebar orders chats by their newest message, not by when a file was last saved, and every post shows its time ("· 14:32", "Yesterday 14:32", or a date; hover for the full timestamp). A chat is only saved once it has a message, so empty "New chat" entries don't pile up.
- **Context from other chats, files and projects:** type `@` in the message box (see above).
- **Delete with confirmation:** 🗑 on a chat moves it to `data/trash/`. 🗑 on a project (not Scratch) moves *all its chats* to `data/trash/` and forgets the project; **its folder and files are never touched**.

- **Chats are saved on the server**, in `data/chats/<id>.json`, not in the browser. Each chat keeps its own agent (model, reasoning, Strict/YOLO, tools), conversation and artifacts. **＋ New chat** starts a fresh one in the current project with the same model and an empty history. The old chat stays in the sidebar.
- **A project is a folder that many chats share.** This keeps each chat's context small while the work carries on in the same files, like several Claude Code sessions on one repo:
  - **📁＋** adds a project: **an existing folder on this PC**, such as a repo, picked with **📂 Browse…** (the computer's own folder dialog). **A project is always named after its folder**, so there is no rename: its name changes only when you pick a different folder with **⚙ → Change folder…**. Folders are never created for you. Typing a path is offered only when the dialog can't open, e.g. when the page is used from another computer. Chats can still be renamed freely.
  - **Nothing lives inside QuorX itself.** Every project works in a folder you picked, outside the app and its data folder. The project's own working files (undo history, trash, scratch scripts, uploads, plan, skills, launch configs, work log) sit in a hidden **`.quorx/`** folder inside it. The name won't clash with other tools' `.agent` folders, and git ignores it.
    - **Older projects:** a `.agent` folder made by an earlier version is renamed to `.quorx` the first time the project is used. A `.agent` folder from another tool is left exactly as it is.
    - **Scratch** lives in `Documents\QuorX\Scratch`; its old files were copied there.
    - **Projects inside the app:** a project with no folder picked, or one whose folder is inside the app, shows **📁 pick a folder** in the sidebar and a notice in its chats, and can't run until you pick one. Its files are copied over (nothing is overwritten).
    - **Picking a folder inside the app is refused.**
    - **Not affected:** chat history, keys and settings stay in the app's data folder.
  - **A folder that disappears is noticed.** If a chosen folder is moved, renamed or deleted outside the app, the project shows **⚠ missing** in the sidebar, its chats show a red notice, and sending is held until you **Reselect folder…**. Nothing is recreated at the old path. The check runs again whenever the window comes back into focus.
  - Every chat in a project sees the folder's current file list and its running dev servers in its context, so a new chat can pick up where another left off.
  - The default project is **Scratch**. The conversation this browser held before chats existed was moved there as "Earlier chat".
- Settings and layout preferences (pane sizes, theme, open chats) stay in this browser. `data/` and `workspaces/` are git-ignored.

## Code, servers and the browser

The agent always works in the chat's project folder:

| Tool | What it does |
|---|---|
| `list_files`, `read_file`, `write_file`, `edit_file` | Files in the project folder. Paths can't leave it. |
| `run_command` | One program with plain arguments, waits up to 3 minutes: `node`, `npm`, `npx`, `python`, `pip`, `deno`, `bun`, `pnpm`, `yarn` or `uv`. No shell operators, quotes, `$`, `%`, pipes or redirects; for anything complex, the agent writes a script and runs it. |
| `start_server` / `stop_server` | A long-running dev server. It gets a free port (5300–5999) in `PORT` and as `{PORT}` in its arguments. It is saved to the project's launch file (`.quorx/launch.json`), opens in the pane's **Browser** tab, and is listed under **🖥 servers**, where you run, stop and edit it. It is not an artifact. |
| `preview_site` | Runs a static multi-file site with the harness's small static server, copied into the project as `.quorx/serve.mjs` (no dependencies, local only, no caching). It is saved in the launch file as **site** (`node .quorx/serve.mjs index.html`), so it behaves like any other server: Browser tab, 🖥 list, run it again any time. |

The pane's **🗂** button browses the project's files. Child processes get your environment **with API keys, tokens and secrets removed**.

**🖥 Servers** (chat header, with a count of running servers) lists the project's launch configs, like Claude Code's `launch.json`. They are kept in `<project>/.quorx/launch.json`; a `.claude/launch.json` in the folder is read too. Each row has ▶ Run / ■ Stop / ↻ Restart / ◧ Show (as a live app in the pane), its output in the terminal, ✎ Edit and 🗑. **＋ Add** takes a name, a program from the allowed list, plain arguments and an optional fixed port; leave the port empty to get a free one as `PORT` / `{PORT}`. Commands that are running right now are listed with ■ Stop.

**⌨ Terminal** (chat header; it pulses while something runs) opens in the pane and streams every command and server in the project **live**: what the agent runs (🤖, with the chat it came from), what you run (👤) and each server's output (🖥), with exit codes and times. Filter by All / Commands / a server, ■ Stop anything running, and run a command yourself in the box at the bottom (same allowed programs; ↑ ↓ for history). The last 3000 lines per project are kept while the harness runs.

**The agent's own folder.** Research and throwaway work (scrapers, fetch scripts, downloads, test data) goes in `<project>/.quorx/scratch/`, not among your files. `.quorx/` also holds undo checkpoints, deleted files and the launch file. A `.gitignore` of `*` inside `.quorx/` keeps the whole folder **out of git** without touching your own `.gitignore`. The agent is told how big the folder is; when it passes your limit (⚙ Settings → Code & servers, default 500 MB) the chat shows **🧹** with what takes the room and buttons to **Clear scratch**, **Empty agent trash** or **Trim undo history** (keeps the 10 newest replies), and the agent asks you before adding more. It also asks before big downloads or installs.

The **browser** is always available: the agent checks its own work in a headless Edge or Chrome, driven over the DevTools protocol with no dependencies:
- **`browser`** opens `artifact:<id>`, `site:<path>`, `app:<name>` or an http(s) URL. It clicks (by selector, visible text or x/y), types, presses keys and scrolls. Each step returns the page title, visible text, clickable controls and **console errors**, and a screenshot appears in the trace.
- **`look`** screenshots the page and sends it to the vision-capable deciders with **yes/no checks the agent writes, guessing first**, like `decide`. For example: "A Reset button is clearly visible", "No text is cut off". The agent fixes what fails and looks again, at most 3 rounds per issue.

Measured: a fresh chat built a Node counter app, started it, clicked + twice and checked it with `look` (P=0.99, 0.92, 0.93), all for **$0.002 in 15s**. A *second* chat in the same project, with no shared history, read the files, added a Reset button with three `edit_file` changes, restarted the server and confirmed it, for **$0.0034 in 11s**.

**🔒 Strict** asks before each of these tools, showing the exact command or file. **⚡ YOLO** runs them without asking, which means the agent runs programs on your machine. Keep YOLO for projects you're happy to let it change.

### 💬 Comment on part of a page
**💬 Comment** in the Browser tab's bar shows a live picture of the page, the same in all three ways the tab can show one (a frame, the harness browser, or a real tab in the desktop app).
- **Click any part** of it. QuorX finds the element under the click and draws a box around it. A small box then shows what it is (for example `a` "Book a tour"), a cropped picture of it, and the selector the agent will use to find it.
- **Say what should change** (or leave the note empty), then **Add to message**. The comment becomes a chip in the message box, with its picture and ✕ to remove it. Add as many as you like; scroll the picture with the wheel to reach the rest of the page.
- **Send your message** as usual. The agent gets each element's tag, text, selector, section and size with your note, and its crop as an attached picture. It's told to change only those elements. Your message bubble lists what you pointed at, and later replies in the chat remember it.
- Pages the agent builds mark their sections and repeated blocks with `data-qx-id` (`web-app` and `design-craft` say so), so a selector still finds the element after edits.

Measured (2026-10-20, through the app): on the boat-tours site, a comment on the hero's "Book a tour" saying "make this button sea-glass green with dark text, and a little bigger" changed only that button. It added three colour tokens instead of hard-coding them, and the header's "Book a tour" stayed as it was. $0.0042.

### ⤓ Export
**⤓ Export** beside it offers:
- **PDF of this page** (with its print styles and backgrounds)
- **PNG of the whole page** (one long picture, up to 20,000 px)
- **ZIP of the project's files** (without `.quorx`, `.git`, `node_modules` or build output, with files over 25 MB left out)

The file is saved by your browser. Measured: the boat-tours page gave a 7-page PDF with no blank pages, a 1280×3745 PNG, and a 6-file ZIP that Windows opens.

## QuorX as an MCP server

Other agents can hand work to QuorX: Claude Code, OpenDesign, or any MCP client. `server/mcp.js` is an MCP server over stdio. It talks to the QuorX you have running (at `QUORX_URL`, by default `http://localhost:` plus `AGENT_PORT` or 5188):

```
claude mcp add quorx -- node D:/path/to/QuorX/server/mcp.js
```

| Tool | What it does |
|---|---|
| `list_projects` | Your projects, with folder, spend and budget |
| `list_files`, `read_file` | A project's files, and one text file in windows of 100k characters |
| `start_reply` | Asks QuorX's agent to do something in a project. It's an ordinary chat in your sidebar, so you can open it and watch, with the project's budget, checks and reviewer. Paid media is off, and Strict is the default (`approval: "yolo"` to change it). Pass `chat` to continue a chat. |
| `get_reply` | Waits up to `wait` seconds (default 20), then says how the reply is doing (working, waiting for you, done or failed) with its last steps, checks, review, cost, changed files and answer. When it has ended, the answer is saved into the chat. |
| `stop_reply` | Stops it |

Approvals and the agent's questions stay yours. A client sees that a reply is "waiting for the user in QuorX", but there's no tool to answer for you.

Measured (2026-10-20): a client listed the projects, read `DESIGN.md`, started "open the site in the Browser tab, change nothing", followed it to the end and got the answer back. The chat appeared in the sidebar with its answer and cost. $0.0015.

**Two QuorX on one data folder** (for example the desktop app and a second copy): a reply that one of them runs, and whose log was written in the last 90 seconds, now counts as "running elsewhere" for the other one, and isn't marked "interrupted" over the chat. `get_reply` also repairs a chat that an older copy marked that way.

### ⏵ Replay
**⏵ Replay** in a finished reply's Steps plays it again from the start, step by step, with its real timing. Controls:
- ⏮ ◀ ⏵/⏸ ▶ ⏭ buttons, a scrubber, and 1× / 4× / 16× speed.
- Keys: J/K or ←/→ for the previous or next step, Space to play and pause, Home/End for the ends, Esc to leave.

A reply the page never saw (one started over MCP, or while the page was closed) replays from QuorX's own log (`/api/runs/<id>/log`).

## Decide-with-guess

Every agent has a `decide` tool. For **every** question, the agent must commit `my_guess` and `my_confidence` before the deciders answer. Three deciders then answer: Jev 1.14, Liquid d1-ultra and GPT-6 Luna Decisions, with choice options shuffled per decider. Each question gets one of these labels:

| Label | Meaning |
|---|---|
| **already knew** | The deciders agreed with a guess the agent was already ≥ 80% sure of. Asking was theater. |
| **confirmed** | The deciders agreed with a guess the agent was unsure of. |
| **changed answer** | The deciders confidently disagreed with the agent's guess. This is where asking pays off, or does harm. |
| **deciders unsure** | The deciders couldn't settle it (confidence below 0.5). |

The deciders always see the user's latest message word for word, plus the agent's short `state` notes. In the benchmark's "must ask first" setup, a model that answers without asking is sent back once; if it still refuses, the run is counted as *skipped*.

Every question is appended to `logs/decisions.jsonl`: the question, guess, confidence, decider pick, confidence, agreement and label. This is the raw material for a later benchmark.

## Files

| File | What it does |
|---|---|
| `server.js` | HTTP server: `/api/run` (starts a reply and streams it), `/api/runs/<id>` (status), `/api/runs/<id>/events` (reattach), `/api/runs/<id>/stop`, `/api/runs` (running now), `/api/answer`, `/api/scorecard`, `/api/projects/<id>/budget` (set or raise), `/api/budget-stop` (Wrap up), `/api/approve`, `/api/transcribe`, `/api/models`, `/api/config`, `/api/balance`, `/api/chats`, `/api/projects`, `/api/files`, `/api/servers/*` (and `/overview`), `/api/launch`, `/api/term/stream|run|stop`, `/api/agent-space` (+ `/clear`), `/api/pick-folder`, `/api/docs` (+ `/upload`, `/process`, `/models`), `/api/costs`, `/api/skills`, `/api/checkpoints/restore`, `/ws/<project>/…` (project files), static files |
| `server/agent.js` | One reply: the tool loop (retries, look-ups together, nudges, checks, trimming, resume), artifacts, decide-with-guess (with images), project tools, ask_user, notes/log/skills, paid media behind the approval gate |
| `server/loop.js` | Pure loop helpers: grouping look-ups, numbered file windows, trimming and compaction, prompt-cache marks, labelling outside text, which errors to retry |
| `server/design.js`, `design-systems/` | Design systems: the starters (`DESIGN.md` + `tokens.css` each), a project's own, applying, editing and removing them |
| `server/checks.js` | File checks with real parsers (Node, Python, JSON, CSS, HTML scripts and links), and the design lint (`lintHtml`, `lintCss`, `lintFile`) |
| `server/runs.js` | Replies on the server: event log, reattach, stop, checkpoints for resume, the scorecard and cost ledger |
| `server/budget.js` | Project budgets: what a project has spent (saved chats + ledger + running replies), setting a budget never below that |
| `scripts/test-loop.mjs`, `scripts/test-agent.mjs` | `npm test`: the helpers, and the whole loop driven by a scripted model (no network, no cost) |
| `server/decisions.js` | The decider ensemble (adapted from the workshop): one call per decider, averaged votes, per-type confidence |
| `server/openrouter.js` | OpenRouter client (from the workshop) |
| `public/` | The page: plain JS, no framework. Chats are saved on the server; preferences (settings, sizes, theme) in this browser. |
| `bench/tasks.json`, `scripts/bench.mjs` | The known-answer benchmark (see below) |
| `bench/tasks-build.json`, `scripts/bench-build.mjs` | The build benchmark (`--set build`): real builds scored by a judge model |
| `server/store.js` | Chats (`data/chats`, trash in `data/trash`) and projects (`data/projects.json`) |
| `server/workspace.js` | Project folders: safe paths, allow-listed commands, dev servers on free ports, launch configs, the agent's `.quorx/` folder (git-ignored scratch, size, clearing) |
| `server/docs.js` | Attached files: uploads, text from PDF/Office/OpenDocument/EPUB/HTML/text, passages and embeddings, `search_docs` / `read_doc` |
| `server/terminal.js` | The live terminal feed per project: command and server output, running jobs, stop |
| `server/pickfolder.js` | 📂 Browse…: the computer's own folder dialog |
| `server/artifacts.js` | Hosting artifacts at `/art/…`: pages as they are, Markdown documents rendered |
| `server/mcp.js` | QuorX as an MCP server (stdio): projects, files, start / follow / stop a reply |
| `server/zip.js` | A small ZIP writer for ⤓ Export (deflate, no dependencies) |
| `server/clis.js` | Other agent CLIs as bench builders (Claude Code, Codex CLI, or ones in `bench/clis.json`) |
| `server/browser.js` | Headless Edge/Chrome over the DevTools protocol: open, click, type, screenshot, console errors (a temporary profile per process). Also what's under a point and a crop of it (💬 Comment), and a full-page PNG and a PDF (⤓ Export). A click with a selector or text ignores x/y, since models often send `x: 0, y: 0` alongside. When Edge hands off to a new process at start (it exits with code 0 but keeps the debugging port), that browser is used rather than a fresh one being started, and its real process is closed when QuorX exits. |
| `server/skills.js`, `skills/`, `templates/` | Skills (built-in and per project) and starter templates |
| `server/keys.js` | OpenRouter keys (data/keys.json), the active key, per-key usage windows, account credits |
| `public/code.js` | The code viewer: highlighting, formatting, line numbers |

## First measurements (2026-10-18)

- **C on a "should I repay a loan first?" judgment:** the model guessed, three deciders voted in 1.3s, and both questions were *already knew*. Total $0.0013.
- **"Draw a pixel cactus" (C):** the agent chose a free hand-coded page over a paid picture. $0.003, 9.7s.
- **Strict decline:** you declined a $0.024 picture with the reason "make it as a page instead", and the agent rebuilt the scene as v2 of the page.
- **YOLO:** the deciders approved a requested watercolor (needed P=0.98, fair P=0.93). The real cost was $0.024.
- **Arena, "car wash 50 m away: walk or drive?":** all three said *drive*. A cost $0.0003 in 1.6s, C $0.0009 in 4.9s, E $0.0087 in 3.4s.
- **Arena, "coworker microwaving fish":** all three picked "talk privately". A cost $0.00004, C $0.0004, E $0.008.

(These runs predate the switch to one agent per chat; the arena has since been removed.) So far every decision has been *already knew* or *deciders unsure*, with no *changed answer* yet. These prompts were too easy to separate the setups. The next step is prompts where small models actually fail.

## Benchmark

There are two task sets. `bench/tasks.json` (the default) has 41 known-answer tasks in six groups:
- **trap:** a famous riddle changed so the memorised answer is wrong
- **trick:** classic reasoning traps
- **physical:** everyday physics
- **safety, social and pick:** judgments with a clear best option

Each reply must end with `ANSWER: …`, which is graded against patterns. If that line is missing, a decider grades the reply instead.

```
node scripts/bench.mjs --setups A,C,D,E --limit 10
node scripts/bench.mjs --setups A,C,D --small inclusionai/ling-3.0-flash --repeat 2
node scripts/bench.mjs --tasks bench/tasks-hard.json --setups A,C,D,E
```

Options:
- `--only id,id`, `--cat trap,trick`
- `--repeat n`: the same task several times, because small models are noisy
- `--concurrency n`, `--small <model>`, `--frontier <model>`
- `--d2-fallback C|strong|none`, `--strong <model>` (for D2)

`bench/tasks-hard.json` has 40 harder tasks in four groups:
- **fresh_trap:** a famous puzzle with one detail changed
- **careful:** one detail flips the obvious answer
- **constraint:** which reply follows every stated constraint
- **judgment:** multi-step everyday decisions

**Setup D** (generate, then pick) runs in the benchmark (it was also in the harness and arena before both were simplified). The small model writes 3 drafts in parallel. At the same time, one decider question checks whether the user wants something *built*: if so, D uses the normal tool loop instead. Otherwise the deciders pick the best draft. The trace shows every draft with its pick probability.

Each run writes `logs/bench-<time>.jsonl`, one line per task and setup with the reply, answer, grade, cost and every decider question. It prints:
- accuracy, cost and speed per setup
- accuracy per category
- what asking did in C
- **helped / hurt** for C and D against A (same model, same task)
- the tasks that separated the setups

### First results (2026-10-18, about $0.45 in total)

| Small model | A alone | C asks first | D 3 drafts + pick | Notes |
|---|---|---|---|---|
| DeepSeek V4.1 Flash (1 run) | 98% | 98% | 98% | Ceiling: 42 of 45 decider questions were "already knew" |
| Ling 3.0 Flash ($0.021/M in, 3 × 2 runs) | 91–94% | **98–99%** | 96% | C helped 4–5 tasks and hurt 0–1 in every round |
| Qwen 3.7 Flash ($0.03/M in, 3 × 2 runs) | 87–89% | 88–89% | **95%** | C's questions mostly echoed its own reading; D helped 5 and hurt 0 |
| *Claude Opus 5.5 (setup E)* | *100%* | | | *$0.0065 per task, 3.5s* |

Costs per task: A about $0.00001–0.0001, C about $0.0001–0.0004 (4–6s), D about $0.00005–0.0002 (1.3–2.5s), and Opus $0.0065.

What this says so far:
- **A strong small model gains nothing.** It already knows these tricks, so asking is theater.
- **For weaker models, it depends on the model.** Ling asked useful questions and C gained about 5 points, landing within 1–2% of Opus at about 1/50 of the price. Qwen asked questions that only confirmed its own reading, so C gained nothing.
- **Generate-then-pick (D) was the most reliable.** It helped both weak models, almost never hurt, ran about as fast as A, and cost about 2–3× A.
- **Bug found and fixed: the agent's misreading reached the deciders.** They used to see only the agent's retelling of the question. Qwen retold the modified bat-and-ball riddle as the classic one, and the deciders confirmed the wrong answer. Adding the user's words wasn't enough on its own, because confident agent notes ("the correct answer is $0.05") still pulled them to P=0.77. With the notes labelled *unverified* and a rule that the user message wins, the same deciders gave P=0.04. The harness now does both.
- **Forced asking isn't guaranteed.** DeepSeek ignored a forced `decide` call in 2 of 10 runs. The harness now sends it back once and counts any refusals as *skipped*.

**Caveats:**
- Only 41 tasks, at most 2 runs each, so differences of 1–3 tasks are within noise. A itself flips between runs.
- Only the *trap* group really separates the setups, and many of these riddles are probably in the models' training data.
- A harder, fresher task set is the next step.

### Hard set results (2026-10-18, about $0.40)

These runs use D inside the harness, so they were directly comparable with the arena of the time.

| Small model | A alone | C asks first | D 3 drafts + pick | Helped / hurt vs A |
|---|---|---|---|---|
| Ling 3.0 Flash (2 runs) | 94% | **98%** | 94% | C +4 / −1 · D +2 / −2 |
| Qwen 3.7 Flash (2 runs) | 95% | 98% | **100%** | C +3 / −1 · D +4 / −0 |
| DeepSeek V4.1 Flash (1 run) | 98% | 98% | 98% | C +1 / −1 · D +1 / −1 |
| *Claude Opus 5.5 (E)* | *100%* | | | *$0.0070 per task* |

Costs per task: A ≈ $0.00001–0.0001, C ≈ $0.0001–0.0007 (3.5–6s), D ≈ $0.0002–0.0003 (2–4s).

Across both task sets, the pattern held:
- **Ling gains most from C.** Its own questions really change its answers: 7 changes across 79 questions, all to the correct answer.
- **Qwen gains most from D.** Its questions mostly echo its first reading, but its drafts vary enough for the deciders to find the right one. D was 100% here and never hurt.
- **DeepSeek is at the ceiling,** so both C and D are pure overhead for it.
- **The best weak model with its best helper scores 98–100%, against 100% for Opus,** at roughly 1/25 to 1/70 of the price.

**The hard set still mostly hits the ceiling.** Only the *fresh_trap* group separates the setups. Careful reading, constraint following and everyday judgment were near-perfect for every model. The next task set needs longer, multi-constraint tasks, or checks on built artifacts.

**What D taught us:**
- **The deciders can overrule a majority.** On the steam-train trap, 2 of 3 drafts said "south" (correct), but the deciders picked the "up" draft. A majority vote across drafts, with the deciders breaking ties, would avoid this.
- **The pick's confidence is a useful signal.** On the "two coins, neither a nickel" question, the deciders were only 12% confident in their pick, and the pick was wrong. A low-confidence pick could fall back to C or to a stronger model.

### D2: majority vote + fallback (2026-10-18, about $0.16)

D2 writes the same 3 drafts as D. In the **same** decider request as the pick, it also asks pairwise questions ("reply_1 and reply_2 reach the same final answer"), so it adds no time. Code then applies one of these rules:
- **Majority agrees with the pick:** take it.
- **Pick is the odd one out:** the majority wins unless the pick is ≥ 80% confident.
- **No majority and the pick is under 50% confident:** fall back. `fallback: 'C'` runs decide-with-guess; `'strong'` has Claude Sonnet 5.5 write the reply with the drafts as reference.

The trace shows which drafts agree and which rule decided.

| Small model, task set (2 runs each) | A alone | D | D2 |
|---|---|---|---|
| Ling 3.0 Flash, first set | 93% | 98% | 98% |
| Ling 3.0 Flash, hard set | 93% | **95%** | 94% |
| Qwen 3.7 Flash, first set | 88% | 95% | **96%** |
| Qwen 3.7 Flash, hard set | 95% | 99% | **100%** |

What we learned:
- **D2 ≈ D, within noise.** Neither ever does worse than A by more than one task.
- **Overruling the deciders with the majority was usually wrong:** 1 of 5 such runs ended correct. A confident pick overruling the majority was correct 3 of 3 times. The drafts come from one model, so their errors are **correlated**: on a trap, two drafts often share the same memorised wrong answer. The deciders read the literal question independently, so even their "weak" pick carries more information than a majority of look-alike drafts.
- **Pick confidence is low even when it's right** (often 0.2–0.45, even when all 3 drafts agree), so on its own it's a poor trigger for escalation.
- **The fallback almost never fires.** Small models' drafts nearly always form a majority, even for "pick a random number" (all three said 73). Both fallback paths work when forced: with 2 differing drafts, C made the agent ask the deciders ($0.0008), and Sonnet wrote the reply ($0.0005).
- **Recommendation:** keep D (trust the deciders' pick), and use the agreement check only as a signal to escalate when there's *no* majority.

### Build set (`--set build`)

The Q&A sets can't show whether a harness change makes *builds* better, so there is a third set: `bench/tasks-build.json` has 9 build tasks. There are 5 browser games (Snake with portals, brick breaker, memory match, 2048, space dodger), a sales dashboard, and 3 form tools (invoice builder, habit tracker, kanban board). The order mixes them, so `--limit 2` already runs a game and the dashboard. Each build must be plain static files (index.html plus its .js/.css, no npm, no network).

```
node scripts/bench.mjs --set build --limit 2
node scripts/bench.mjs --set build --review off,builds --limit 4
node scripts/bench.mjs --set build --helpers on,off --reasoning off,low --only snake_portals,invoice_builder
node scripts/bench.mjs --set build --builder deepseek/deepseek-v4.1-flash,anthropic/claude-haiku-5.5 --repeat 2
node scripts/bench.mjs --set build --mode harness,cli:claude --only snake_portals,sales_dashboard
```

**Other agent CLIs as builders:** `--mode cli:claude` (Claude Code) or `cli:codex` (Codex CLI) has that agent build the task in its throwaway folder, and the same judge scores what it leaves. Each CLI is one data object in `server/clis.js`: program, arguments, prompt on stdin, how to read its answer. More can go in `bench/clis.json` with the same shape. They run only here, because QuorX's approvals can't reach inside another agent. Each CLI's own flags limit it to editing files in that folder, so Claude Code runs with `acceptEdits` and only its file tools. Arguments are fixed flags or a checked model id (`--cli-model`), so no task text reaches a command line. Claude Code reports its cost, which goes into the run's cost. These runs use your own Claude or OpenAI account, not OpenRouter.

How a run works:
- **Its own project.** Every run gets a new folder under the OS temp dir, registered as a throwaway project (`bench-…`). When the run ends, its servers are stopped, the project is forgotten, and the folder is deleted (`--keep` keeps the folder; its path is in the results). `workspaces/` and the chats in `data/` are never touched.
- **The real harness.** The run goes through `server/agent.js` with `bench: 'build'`. Unlike the Q&A bench, this keeps the plan rules, the verify checks and the reviewer on, like a chat. It runs in YOLO with media off and no `ask_user`. The bench serves the builds itself on a local port, so the harness server doesn't need to be running.
- **A judge scores every build.** When the run ends, a judge model plays the result in the headless browser. It uses the reviewer's own instructions in a fresh context and sees only the request, not the plan or the builder's summary. It gives the same 4 scores as the reviewer: function, craft, design and originality. A build passes when every score reaches the bar. Builds with the reviewer off are scored exactly like those with it on. `--judge off` uses the in-loop reviewer's last verdict instead.

Setups: each comma list is an axis, and every combination is one setup.
- `--builder <model,…>`: default `anthropic/claude-haiku-5.5`. A cheap alternative is `deepseek/deepseek-v4.1-flash`.
- `--review off,builds,always`: default `builds`, which reviews only when the agent made a plan.
- `--helpers on,off`: default `on`.
- `--reasoning off,low,medium,high`: default `off`.

Other options:
- `--reviewer <model>` (in-loop reviewer, default `openai/gpt-6-luna`) and `--judge <model>|off` (default: the reviewer model).
- `--rounds n` (times the reviewer may send a build back, default 1) and `--bar n` (default 3).
- `--limit n`, `--only id,id`, `--cat game,dashboard,form`, `--repeat n`, `--concurrency n` (default 2).
- `--steps n` (model calls per run, default 60), `--minutes n` (time limit per run, default 15), `--keep`.

For each run it records:
- the judge's 4 scores, pass/fail and bugs
- the builder run's cost (`stats.cost` and `byRole`: writer, reviewer, helper) plus the judge's cost on its own
- model calls in all and per role, the time, and the steps
- how many times the build was sent back (by the reviewer, by the checks)
- whether a plan was made and how much of it was ticked off
- the in-loop review verdicts, the files built and any error

It prints a table per setup (pass rate, average scores, $ per run by role, calls, minutes, rounds sent back, runs with a plan) and a grid per task. It writes `logs/bench-build-<time>.json` (settings, summary and every run) and `logs/bench-build-<time>.jsonl` (one line per run as it finishes).

**First run (2026-10-18, `--limit 2`, defaults, $0.07 in total):** Haiku 5.5 made a plan in both runs and ticked off every item. The checks passed, and the reviewer sent each build back once. Both builds still failed the judge on function: the dashboard scored 2/4/4/2 and the snake game 1/4/4/3. Each run cost about $0.02–0.035, plus $0.003–0.011 for the judge, with about 40 model calls and 2.5–3 minutes per run. The in-loop reviewer and the judge agreed on what was broken: the filters didn't respond, and P and the arrow keys ended the snake game. One run per task is only a smoke test. Use `--repeat` and the full set before drawing conclusions.

## Next ideas

- **D with agreement as a signal only:** never let the majority overrule the pick, and escalate only when no two drafts agree.
- **A third, harder task set:** long multi-constraint requests, and "does this artifact meet the spec" checks using screenshots.
- A **`look` tool:** screenshot the HTML artifact and let vision deciders check it against the request.
- **Voice replies on autoplay:** an option to read every reply aloud with the chosen voice.
