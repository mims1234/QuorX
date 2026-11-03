---
name: canvas-game
description: Build a browser game (2D canvas, Phaser, KAPLAY or three.js 3D) that is original, deep, playable on a monitor or a phone, restartable and checked in the browser.
---

# Browser game

1. **Design first, briefly.** Pick an original core mechanic that fits the request. Don't make a reskin of "dodge the falling things", "catch with a paddle" or a multiple-choice quiz unless the user asked for that. In a few lines, decide:
   - the core verb (what the player does every second);
   - what makes it get harder or deeper (levels, new enemy types, upgrades, combos);
   - the goal and the fail state;
   - the look (palette, shapes, motion).

   Then build it. Plan in a few sentences: **never write the code in your thinking**. Your thinking is not saved, and a long one can use up your output before any file is written.
2. **Template (optional):** `scaffold` with `canvas-game` gives only plumbing: a loop, states, input, sound, particles, screen shake, the adaptive view below and a full-screen button. It has no gameplay. Use it if it saves time and write your game in its `newGame` / `update` / `draw` hooks, or write your own structure.
3. **Files:** split by purpose once a file passes ~400 lines (for example `game.js`, `levels.js`, `entities.js`, `render.js`). Write each file with `write_file`, then add the rest with `append_file` in parts of about 300 lines.
4. **Loop:**
   - Use `requestAnimationFrame` with a delta time, capping dt at 50ms.
   - Keep update and draw separate.
   - Pause when the tab is hidden.
5. **The view fills the screen and adapts to it.** The play area is the whole window (`position: fixed; inset: 0`), with the HUD and menus laid over it: no small game box in a page of text, no bands of empty space. Fix the view's **short side at 540 game units** and let the long side follow the window, so a wide monitor sees more to the sides, a phone held upright sees more above and below, and nothing is letterboxed into a strip:

       const SHORT = 540;                          // the short side of the view, in game units
       const view = { w: 960, h: 540, zoom: 1 };
       function fit() {
         const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
         view.zoom = Math.min(w, h) / SHORT;
         view.w = w / view.zoom; view.h = h / view.zoom;
         canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
         ctx.setTransform(view.zoom * dpr, 0, 0, view.zoom * dpr, 0, 0);
       }
       addEventListener('resize', fit); fit();

   Draw, spawn, bound the play and place the HUD from `view.w` and `view.h`, never from fixed numbers, and turn a pointer into game units with `(e.clientX - rect.left) / view.zoom`. A game whose rules need a fixed shape (a puzzle grid, a pitch, a board) centres it in the view and draws the background across the rest.
   - **Phaser:** `scale: { mode: Phaser.Scale.RESIZE, width: 960, height: 540 }` in the config, `addEventListener('resize', () => game.scale.refresh())`, and in each scene's `create()` a camera zoom of `Math.min(this.scale.width, this.scale.height) / 540`, set again on the scale's `resize` event (removed on `shutdown`). Place things from `this.cameras.main.worldView`. Add `pixelArt: true` for pixel art.
   - **KAPLAY:** `kaplay({ canvas, scale: Math.min(innerWidth, innerHeight) / 540, global: false, ... })` with no `width`, `height` or `letterbox`; `k.width()` and `k.height()` are the view, and lay out again on the window's `resize`.
6. **Input:**
   - Keyboard (WASD/arrows), mouse and touch.
   - Pointer lock only after a click, for first-person games.
   - Always show the controls on the start screen.
   - **Phones, upright and sideways:** touch controls under the thumbs at the screen's edges (a drag stick or a pad lower left, action buttons lower right), **at least 56px**, clear of the HUD, inside `env(safe-area-inset-*)`. Give the play area `touch-action: none` and the page `user-select: none; -webkit-touch-callout: none; overscroll-behavior: none`. Show the touch controls when a touch is first used (or on `(pointer: coarse)`) and hide them for keyboard play.
7. **Full screen:** a button on the title screen and in the pause menu (and the F key) that toggles it: `document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()`, with the `webkit` versions as a fallback and a try/catch for browsers without it. Label it from `document.fullscreenElement` and relabel it on `fullscreenchange`.
8. **States:** title → playing → paused → game over → restart, without reloading the page.
9. **Depth and feel:** this is what separates a good game from a demo.
   - Difficulty that ramps up, or a few hand-made levels.
   - At least one twist that appears later in a run.
   - Clear feedback on every hit and score: particles, screen shake, flashes, sound.
   - A satisfying game-over screen showing the score and best.
10. **3D (three.js):**
    - Load a pinned version from cdnjs, e.g. `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`.
    - Keep geometry simple: boxes, planes and low-poly shapes; aim for 60 fps on a laptop.
    - Handle window resizing (camera aspect and renderer size).
11. **Sound:** generate it with WebAudio (oscillators, slides, noise). There's no need for audio files.
12. **Credits:** when the game uses someone else's work (a library, art, effects, a font), show who made it on a Credits screen inside the game: a panel over the title screen or the pause menu, with a Back button. Never send the player away from the game to read them: no plain link to `credits.txt` that replaces the page. Keep any `credits.txt` and licence files the work came with.
13. **Check it:**
    - `preview_site`, then `browser open site:index.html`, click start and play with key presses.
    - `look` checks: "A start screen with the controls is visible", "The player and HUD are visible during play", "No error text is on the screen".
    - Fix any console errors.
14. **Save the best score and settings** in `localStorage`, wrapped in try/catch.
