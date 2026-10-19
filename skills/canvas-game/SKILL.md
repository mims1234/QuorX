---
name: canvas-game
description: Build a browser game (2D canvas or three.js 3D) that is original, deep, playable, restartable and checked in the browser.
---

# Browser game

1. **Design first, briefly.** Pick an original core mechanic that fits the request. Don't make a reskin of "dodge the falling things", "catch with a paddle" or a multiple-choice quiz unless the user asked for that. In a few lines, decide:
   - the core verb (what the player does every second);
   - what makes it get harder or deeper (levels, new enemy types, upgrades, combos);
   - the goal and the fail state;
   - the look (palette, shapes, motion).

   Then build it. Plan in a few sentences: **never write the code in your thinking**. Your thinking is not saved, and a long one can use up your output before any file is written.
2. **Template (optional):** `scaffold` with `canvas-game` gives only plumbing: a loop, states, input, sound, particles and screen shake. It has no gameplay. Use it if it saves time and write your game in its `newGame` / `update` / `draw` hooks, or write your own structure.
3. **Files:** split by purpose once a file passes ~400 lines (for example `game.js`, `levels.js`, `entities.js`, `render.js`). Write each file with `write_file`, then add the rest with `append_file` in parts of about 300 lines.
4. **Loop:**
   - Use `requestAnimationFrame` with a delta time, capping dt at 50ms.
   - Keep update and draw separate.
   - Pause when the tab is hidden.
5. **Input:**
   - Keyboard (WASD/arrows), mouse and touch.
   - Pointer lock only after a click, for first-person games.
   - Always show the controls on the start screen.
6. **States:** title → playing → paused → game over → restart, without reloading the page.
7. **Depth and feel:** this is what separates a good game from a demo.
   - Difficulty that ramps up, or a few hand-made levels.
   - At least one twist that appears later in a run.
   - Clear feedback on every hit and score: particles, screen shake, flashes, sound.
   - A satisfying game-over screen showing the score and best.
8. **3D (three.js):**
   - Load a pinned version from cdnjs, e.g. `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`.
   - Keep geometry simple: boxes, planes and low-poly shapes; aim for 60 fps on a laptop.
   - Handle window resizing (camera aspect and renderer size).
9. **Sound:** generate it with WebAudio (oscillators, slides, noise). There's no need for audio files.
10. **Check it:**
    - `preview_site`, then `browser open site:index.html`, click start and play with key presses.
    - `look` checks: "A start screen with the controls is visible", "The player and HUD are visible during play", "No error text is on the screen".
    - Fix any console errors.
11. **Save the best score and settings** in `localStorage`, wrapped in try/catch.
