# The desktop bridge

QuorX's page talks to the desktop app through one object, `window.ohDesktop`. It is the whole contract between the
page and the shell around it: a different shell (another Electron version, or something else entirely) only has to
provide these calls and send these events for QuorX to work the same.

`scripts/test-bridge.mjs` (part of `npm test`) checks this file against the code. It fails when the page uses a call
not listed here, when a call listed here is gone, or when the shell sends an event not described below. Add a new
call here in the same change that adds it.

## How it works

- `desktop/preload.js` exposes `window.ohDesktop` to QuorX's own page only. Browser tabs never get it.
- Each call is `ipcRenderer.invoke('oh:<name>', ...args)`. `desktop/main.js` answers it with `handle('<name>', fn)`,
  which refuses calls from anything but the app's page.
- Events go the other way on the `oh-desktop` channel; the page listens with `ohDesktop.on(fn)`.
- The page checks `window.ohDesktop?.available` before using any of it. Opened in a normal browser, QuorX works
  without the bridge (the Browser tab streams pictures instead of showing real tabs, for example).
- The server (`server.js`, `server/`) never uses the bridge or Electron. Everything here is about the window.

## Calls

All calls return a promise.

| Call | What it does | Arguments | Returns |
|---|---|---|---|
| `available` | Always `true` (a value, not a call): the page is inside the desktop app | | `true` |
| `open` | Opens a page in one of your browser tabs, making the tab if needed | `sid`, `url` (http or https only) | `true` |
| `bounds` | Places a tab over the box the page drew for it (in the page's pixels) | `sid`, `{ x, y, width, height }` | `true`, or `false` for no such tab |
| `show` | Shows one tab and hides every other | `sid` (or nothing to hide all) | `true` |
| `showSet` | Shows several tabs at once (one per pane area) and hides the rest | `[sid, ...]` | `true` |
| `hideAll` | Hides every tab | | `true` |
| `nav` | Back, forward, reload, stop or DevTools for a tab | `sid`, `'back' \| 'forward' \| 'reload' \| 'stop' \| 'devtools'` | `true`, or `false` for no such tab |
| `close` | Closes a tab (or forgets a sleeping one) | `sid` | `true` if there was one |
| `snapshot` | A picture of a tab on screen, to stand in while something covers it | `sid` | a PNG data URL, or `null` |
| `sound` | Volume and mute for every tab, the agent's tabs, or one tab | `'set'`, `{ volume, muted, agentMuted }` · `'tab'`, `{ sid, muted }` · nothing to read | the sound settings |
| `tabs` | The Running list: every tab with its page and sound, or close one | nothing to list · `'close'`, `sid` | `[{ sid, agent, chatId, url, title, audible, muted, shown, asleep? }]` |
| `loginItem` | Start QuorX with Windows: read it, or set it | nothing · `true \| false` | `true \| false` |
| `closeAction` | What closing the window does: keep running in the tray, quit, or ask | nothing · `'tray' \| 'quit' \| 'ask'` | the choice |
| `quit` | Quits the app | | `true` |
| `update` | The app's own updates | `'state'` · `'check'` · `'download'` · `'install'` · `'setUrl'`, url · `'store'` | the update state |
| `info` | Version, packaged or not, dev build, store, data folder, address, whether it runs the server | | `{ version, packaged, dev, store, home, origin, ownsServer }` |
| `restartHarness` | Restarts the QuorX server the app runs | | |
| `storage` | Settings → Storage: measure, clear, and the app's own cleanup rules | `'measure'` · `'clear'`, `[parts]` · `'rules'`, `{ updateCleanup, agentCacheOnStart }` | per step |
| `openHome` | Opens the data folder in File Explorer | | `true` |
| `focusWindow` | Brings the window forward (a clicked notification) | | `true` |
| `notify` | A Windows notification (a newer one for the same chat replaces the older); clicking it sends `notify-click` | `{ title, body, silent, chatId }` | `false` when Windows has no notifications |
| `badge` | The taskbar icon's badge: how many chats need you, drawn by the page | count, a PNG data URL (nothing at 0) | `true` |
| `zoom` | QuorX's own zoom, remembered between starts | `'in' \| 'out' \| 'reset' \| 'get'` | the zoom factor |
| `openExternal` | Opens a web address in your own browser | `url` (http or https only) | `true` |
| `showFile` | Shows a downloaded file in File Explorer | a path inside Downloads | `true` |
| `perf` | The performance readout: every process with memory and processor, each tab, lost 3D views | | `{ totalMb, appMb, gpuMb, tabsMb, cpu, gpuCpu, procs, tabs, webglLost }` |
| `navButtons` | Always `true` (a value, not a call): the mouse's side buttons arrive as `ws-nav` events, so the page ignores its own | | `true` |
| `on` | Listens to the shell's events (below) | `fn(event)` | a function that stops listening |

## Events

Sent on the `oh-desktop` channel; each has a `type`.

| Event | When |
|---|---|
| `state` | A tab's address, title, loading state or back/forward changed (`sid`, `url`, `title`, `loading`, `canBack`, `canForward`) |
| `error` | A tab's page failed to load (`sid`, `url`, `message`) |
| `favicon` | A tab's icon changed (`sid`, `icon`) |
| `popup` | A page asked for a new window; the page opens it as a tab (`sid`, `url`) |
| `zoom` | A tab's own zoom changed (`sid`, `factor`) |
| `audio` | A tab started or stopped making sound (`sid`, `audible`) |
| `download` | A tab's download started, moved on or ended (`sid`, `state`, `name`, `file`, `received`, `total`) |
| `sleep` | A hidden tab went to sleep to save memory (`sid`); it wakes by itself when placed, shown or reloaded |
| `wake` | A sleeping tab opened again (`sid`) |
| `agent-tab` | A chat's agent got a tab of its own (`sid`, `chatId`) |
| `agent-lock` | The agent started or stopped driving its tab (`sid`, `locked`) |
| `compact` | The window went into or out of its small "watch the agent" size (`on`, `chatId`) |
| `notify-click` | A notification was clicked, or the extension asked to open a chat (`chatId`) |
| `zoom-key` | Ctrl + / − / 0 was pressed in the window; the page decides what it zooms (`dir`) |
| `zoom-wheel` | Ctrl+wheel in the window (`dir`) |
| `ws-nav` | The mouse's back or forward button, with the pointer and focus outside your browser tabs: the page steps back or forward through the workspace (`dir`: `back` or `forward`). Inside a tab the shell takes that page back or forward itself |
| `update` | The update state changed (the same object `update('state')` returns) |

## For another shell

A replacement shell needs, roughly in order of effort:

1. **Real browser tabs** placed over the page (`open`, `bounds`, `show`, `showSet`, `hideAll`, `nav`, `close`,
   `snapshot`, `tabs`, and the tab events). This is the part most tied to Electron's `WebContentsView`. Sleeping tabs
   live entirely in the shell (`desktop/tab-sleep.js` decides which).
2. **The agent's tabs** (`agent-tab`, `agent-lock`, `compact`), driven over DevTools by the desktop link in `main.js`.
3. **Window and system** (`zoom`, `notify`, `focusWindow`, `loginItem`, `closeAction`, `quit`, `openExternal`,
   `showFile`, `openHome`).
4. **App updates and storage** (`update`, `storage`, `info`, `restartHarness`).
5. **Readout** (`perf`): optional; the page shows its own numbers without it.
