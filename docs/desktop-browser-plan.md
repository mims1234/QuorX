# A real browser in the pane: desktop app plan

Status (2026-10-18): all six steps are built and tested (`desktop/`, `server/desktop.js`, the transport in `server/browser.js`, the Browser tab in `public/app.js`, the installer and start at login). Updates are built too: the app checks a feed, downloads on Update, and installs on restart (`npm run desktop:release`, then upload the three files). Not done: code signing.

## Why the pane can't do this today

QuorX is a web page served by `server.js` (port 5188, listening on every interface so phones on the LAN can use it). A web page can't host a browser. The only built-in way to show another site is an `<iframe>`, and most big sites refuse that (`X-Frame-Options`, `frame-ancestors`). So the Browser tab runs pages in a headless Edge/Chrome (`server/browser.js`, driven over the DevTools protocol) and shows them as screenshots, sending clicks, scrolling and typing through `/api/ubrowser` (`server/userbrowser.js`). The agent's tab is shared with the pane as `agent-<chat>`. `adoptAgentTab` makes it watch-only while a reply runs, and `releaseAgentTab` hands it to the user afterwards.

That works, but it's a picture. There's no smooth scrolling, no text selection, copy or paste, no right-click, no IME, no drag and drop, no video or sound, no downloads, no DevTools, and no lasting sign-ins. Every interaction is a round trip plus a JPEG.

The fix is to run the page inside a desktop shell that can place **native browser views** over the pane's Browser area. The page keeps drawing the tab strip and address bar. The shell draws the web page under them.

## The three options

| | **Electron** (`WebContentsView`) | **WebView2** in a small Windows host (C#) | **Tauri 2** (Rust, system webview) |
|---|---|---|---|
| Engine for browse tabs | The Chromium bundled with Electron. Same engine as Chrome. | Edge's Chromium (Evergreen runtime, built into Windows 11) | WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux |
| How `server.js` runs | Electron includes Node. Run it unchanged in a `utilityProcess` (crash-isolated from the window). | It needs `node.exe`, either bundled (~80 MB) or the user's installed Node, run as a child process. | Same as WebView2: Node as a "sidecar" binary (bundled `node.exe` or a Node single-executable build) |
| How `public/app.js` runs | `BrowserWindow` loads `http://localhost:<port>`. A preload script adds a small `window.ohDesktop` bridge. | One WebView2 loads the page. The bridge goes through `chrome.webview.postMessage`. | The main webview loads the page. The bridge goes through Tauri `invoke`. |
| Real tabs in the pane | One `WebContentsView` per tab, moved to the pane's rectangle. This API is stable and documented. | One extra WebView2 control per tab, placed over the pane rectangle. Stable. | `Window::add_child` multi-webview, still behind Tauri's `unstable` flag |
| Agent drives a real tab (CDP) | `webContents.debugger.sendCommand(...)` takes the same CDP commands as `browser.js` and needs no open port. | `CallDevToolsProtocolMethodAsync` (same commands), or a debugging port | Only on Windows, through WebView2. macOS and Linux have no CDP, so they would keep headless Edge. |
| Cookies / profiles | `session.fromPartition('persist:user')` and a separate partition for the agent | A separate user-data folder per environment | Per OS. Limited control on WebKit. |
| DevTools, downloads, popups, permissions | All built in: `openDevTools`, `will-download`, `setWindowOpenHandler`, `setPermissionRequestHandler` | All built in (`OpenDevToolsWindow`, `DownloadStarting`, `NewWindowRequested`, `PermissionRequested`) | Partial, and it varies by OS |
| Packaging / auto-start | electron-builder (NSIS, per-user, no admin). Auto-start with `app.setLoginItemSettings({ openAtLogin: true })` plus a tray icon. Updates through electron-updater. | `dotnet publish` single-file plus Inno Setup or MSIX. Auto-start via a `HKCU\…\Run` entry. | Tauri bundler (NSIS/MSI). Auto-start with the `autostart` plugin. |
| Size | Installer about 90–110 MB, about 300 MB installed (Chromium + Node) | Host about 1–5 MB, plus `node.exe` if bundled. The runtime is already on Windows. | Host about 5–10 MB, plus the Node sidecar (40–80 MB) |
| New languages or toolchains | None. It's JavaScript like the rest of the repo. | C# / .NET SDK | Rust toolchain |
| Cross-platform | Windows, macOS, Linux, all the same | Windows only | Yes, but browse tabs and the agent work differently on each OS |

### Phones (same for all three)

A phone can't get a native view, so phones keep today's streamed view through `/api/ubrowser`, unchanged. The page checks for `window.ohDesktop`. If it's there, the Browser tab shows a real view. If it isn't (a phone, or the plain web version in any browser), the Browser tab streams pictures as it does now. With Electron or WebView2, the stream for a phone can come from the **same real tab** the desktop has open (`Page.captureScreenshot` works on a `WebContentsView` too). A phone can then watch or take over the tab you were using at your desk.

Two things change for phones. First, the desktop app must keep the server running when its window closes, so ✕ minimises it to the tray and only "Quit" in the tray menu stops it. With auto-start at login, the phone address works as soon as the PC is on. Second, a real view is never shown on a phone, so phone CSS (`phone.css`, the layout under 900px) needs no changes.

## Recommendation: Electron

Electron is the only option that covers everything without a second language or an unstable API. It hosts any site in real tabs with cookies, DevTools and downloads. It runs `server.js` as it is. The agent's CDP code in `browser.js` maps almost one-to-one onto `webContents.debugger`. Its cost is size (about 100 MB to download), which is acceptable for a desktop tool. The plain web version stays as it is, and phones and other browsers keep working without the desktop app.

WebView2 would be the pick only if a small installer mattered more than staying in one language. Tauri's multi-webview is still unstable, and on macOS and Linux it has no CDP, so the agent's tab couldn't be a real tab there.

**Known limits, even with Electron.** Electron's Chromium is the Chrome engine, but the app is not Chrome. There is no Chrome sync, saved passwords, Chrome extensions or Widevine DRM (Netflix-style video). Google sign-in may block embedded browsers. To reduce that, use Chrome's user agent without the `Electron/…` part, and add an **↗ Open in Chrome** button next to the address bar for the rare site that still refuses.

## How it fits together (Electron)

- **Folder:** a new `desktop/` folder with its own `package.json` (devDependencies `electron`, `electron-builder`). The root `package.json` and `npm start` stay zero-dependency and unchanged.
- **Main process (`desktop/main.js`):** takes the single-instance lock and starts `server.js` in a `utilityProcess`. The server reports the port it actually got (it already moves up from 5188 when the port is busy). The main process then opens a `BrowserWindow` on that port, with a tray icon and auto-start.
- **Bridge:** the preload exposes `window.ohDesktop` only when `location.origin` is the app's own origin. Browse tabs and hosted artifacts (`/art/…`, `/preview/page/…`) get no preload, and run with `sandbox: true` and `contextIsolation: true`. The bridge API is small: `open(sid, url)`, `setBounds(sid, rect)`, `show/hide(sid)`, `back/forward/reload`, `devtools(sid)`, and events for title, URL, loading state and downloads.
- **Pane Browser tab (`public/app.js`):** the tab strip, address bar and buttons stay HTML, so they follow the house rules: controls next to what they act on, distinct looks, compact. The page area becomes an empty placeholder `<div>`. A `ResizeObserver` sends its rectangle to the main process, which moves the native view to it.
- **Menus over the view:** native views sit above all HTML, so a dropdown or dialog that overlaps the pane would be hidden under one. Before such an overlay opens, the page asks the main process for a `capturePage()` snapshot, shows the snapshot in place of the view, and hides the view. The view comes back when the overlay closes.
- **User tabs:** each tab uses `persist:user`, so sign-ins last. Popups open as new pane tabs (`setWindowOpenHandler`). Downloads go to the user's Downloads folder and show as a row under the address bar. Camera, microphone and notification requests show a prompt in the pane (the user decides). DevTools open detached.
- **The agent's tab:** `browser.js` gets a second transport. `openTab()` currently builds `send()` on a WebSocket to headless Edge. In desktop mode, `send()` goes over the `utilityProcess` message port to the main process, which creates a `WebContentsView` in the `persist:agent` partition and calls `webContents.debugger.sendCommand`. Everything above `send()` (open, click, type, screenshot, summary, the console capture) stays the same. `adoptAgentTab` and `releaseAgentTab` keep their meaning:
  - **Locked (the reply is running):** the view is shown in the pane at the agent's own emulated size, scaled to fit. A transparent input-catching layer on top blocks your clicks and keys, and a "🤖 agent is using this tab" bar shows above it, so you can watch at full frame rate.
  - **Released:** the layer goes away and the device-metrics override is cleared, so the page follows the pane. It's now your tab, with the agent's cookies and page state intact. Nothing has to be reopened.
  - The agent's partition is separate from yours, so the agent never sees your sign-ins unless you take over its tab and sign in there yourself (the same isolation as today's temporary profile).
- **What stays headless:** the final-reply check in `agent.js` (`vt ??= openTab()`) and bench runs keep using headless Edge. They run in parallel, need no window, and must work without the desktop app.

## First concrete steps

1. **Prototype the shell.** Create `desktop/package.json` and `desktop/main.js`. Run `server.js` in a `utilityProcess`, read the port from its first log line or a message, open the window, add the tray, and make ✕ minimise to the tray. Done when `npm run desktop` shows today's app unchanged and a phone on the LAN still works with the window closed.
2. **One real tab.** Add the preload bridge and a single `WebContentsView` tied to a placeholder rectangle. Done when google.com, youtube.com and github.com (sites that refuse iframes) load, scroll, play sound, accept a sign-in that lasts after a restart, and open DevTools.
3. **Wire up the Browser tab in `app.js`.** Use a real view when `window.ohDesktop` is there and the stream otherwise. Include several tabs, the snapshot-under-overlay handling, downloads and popups. Coordinate with the UI/UX session, which is editing the same file.
4. **Give `browser.js` a transport.** Factor `send()` and the event listener out of `openTab()`, then add the desktop transport. Done when `scripts/test-agent.mjs` passes in both modes.
5. **Agent tab as a real view.** Desktop versions of `adoptAgentTab` and `releaseAgentTab` with the lock layer, and phone streaming from the same `webContents`. Done when you watch an agent run live on the desktop, take the tab over afterwards with its state intact, and see the same tab streamed on a phone.
6. **Package it.** electron-builder NSIS per-user installer, auto-start at login (a ✓ checkbox in ⚙ Settings, off by default), Chrome user agent, ↗ Open in Chrome. Note that the installer will show a SmartScreen warning until it is code-signed.

## What you gain over today's streamed view

In the desktop app, the Browser tab becomes a real Chromium browser instead of a picture of one. Pages scroll smoothly at full frame rate and play video and sound. Text selection, copy and paste, right-click, drag and drop, and keyboard input all behave normally. Sites stay signed in between sessions, downloads save to your Downloads folder, and DevTools work on any tab. Sites that refuse iframes still load. You can watch the agent's tab live and take it over exactly where the agent left it, with nothing reloaded and no extra delay. Phones and the plain web version keep today's streamed view, so nothing is lost there, and a phone can stream the same tab you're using at your desk. The costs are an install of about 100 MB, a few sites (Google sign-in, DRM video) that may still need ↗ Open in Chrome, and a desktop shell to maintain alongside the web app.
