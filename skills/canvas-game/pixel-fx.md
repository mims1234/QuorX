---
name: pixel-fx
description: The canvas-game skill's part on pixel art effects (pixelfx). Added to the skill only when the request asks for pixel effects.
---

## Pixel art effects (pixelfx)

The request asks for pixel effects, so `pixel_fx` gives you 244 ready-made ones: explosions, fire, spells, slashes, hit sparks, projectiles, pickups, level ups, weather, critters and screen wipes. Each is code, not a picture: it draws itself pixel by pixel, so it can go anywhere, face either way, take your palette and run at any frame rate. They look far better than particles written from scratch.

**Getting them**
- `pixel_fx` `find` with plain words, several at once: `"explosion, sword slash, coin, heal, rain"`. Each result gives its id, its timing (a one-shot of so many seconds, or a loop) and its size in effect pixels.
- Save every one the game needs with one `pixel_fx` `add` (`ids`, and `folder` when the game's index.html is not in the project folder). They land in `js/pixelfx/` beside index.html: the effect at `js/pixelfx/fx/<category>/<name>.js`, the shared core, and `js/pixelfx/layer.js`, which plays them. **Never read, copy, search or edit anything in `js/pixelfx/`**: this guide is all you need.
- At most 24 effects in a game. An effect "drawn on a character" paints onto the stock grey character pixelfx brings with it (frozen, poisoned, burning, level up): use those only when that character is shown (see Acts); for your own characters pick another.

**Modules.** The effects are ES modules: the game's script must be one too (`<script type="module" src="game.js"></script>`, no `defer` needed) and the page must be opened through `preview_site`, not as a file.

**The layer**

    import { createFxLayer } from './js/pixelfx/layer.js';        // the path from your script to index.html's js/
    import * as boom from './js/pixelfx/fx/explosions/small-explosion.js';
    import * as slash from './js/pixelfx/fx/melee/sword-slash.js';

    const fx = createFxLayer({ width: view.w, height: view.h, scale: 3 });   // the view in game units; one effect pixel = 3 units

    fx.play(boom, { x: enemy.x, y: enemy.y });                         // game coordinates, where its origin goes
    fx.play(slash, { x: hero.x, y: hero.y, flip: hero.facing < 0 });  // effects face right; flip faces left
    // every frame, while not paused:
    fx.update(dt);                                                     // seconds, capped at 0.05 like the game's own

- One layer for the game's effects. Its canvas is `view.w / scale` by `view.h / scale` pixels; the game draws it at full size without smoothing, which is what makes it pixel art. `scale: 3` suits the 540-unit view; `2` makes every effect smaller, `4` bigger. An effect's size from find times the scale is how much of the game it covers: a 136 x 104 slash at scale 3 is about 400 x 300 units. Pick effects that fit the thing: a hit spark on an enemy, the big explosion for a boss.
- On every view change, `fx.resize(view.w, view.h)`; running effects carry on.
- The origin is the effect's anchor: the feet of what stands on the ground (fire, pillars, slashes, novas: pass the y of the floor or the character's feet), the middle of what floats (orbs, pickups, projectiles).
- `play` returns a handle: `handle.moveTo(x, y)` every frame for a projectile or an aura that follows something, `handle.face(left)`, `handle.stop()` to end a loop (it fades) or cut a one-shot short, `handle.done()`. One-shots remove themselves when they end. `fx.clear()` on a restart or a new level.
- Options in the same object: `palette` (hex colours dark to bright, recolours the whole effect: a blue fire, a green heal), `seed` (another take on the same effect, so ten coins don't sparkle in step), `angle` (radians), `light` (glow strength, 0 to 1.5). Ready ramps: `import { PAL } from './js/pixelfx/core/index.js'`, then `PAL.ice`, `PAL.poison`, `PAL.holy`, `PAL.shadow`, `PAL.gold` (also fire ember lava smoke dust water electric volt heal arcane blood earth stone leaf wood metal bone neon cyber matrix candy night).
- A scrolling game sets `fx.camera.x` and `fx.camera.y` to the top-left of the view, in game units, every frame; effects then stay where they were started in the world.

**Weather and screen wipes** are drawn for one 320 x 180 screen. Give them a second layer that covers the whole view at any shape, and start them with `cover` (options as for play, no x or y); they stay on screen as the camera moves:

    const sky = createFxLayer({ width: view.w, height: view.h, scale: 'cover' });
    sky.cover(rain);                                     // and sky.resize(view.w, view.h) on every view change
    const wipe = sky.cover(iris);                        // between levels: change the level when the screen is covered,
    if (wipe.t >= wipe.meta.duration / 2) nextLevel();   // halfway through

**Drawing it**
- Plain canvas: after the world and before the HUD, in game units: `ctx.imageSmoothingEnabled = false; ctx.drawImage(fx.render(), 0, 0, view.w, view.h);`. For effects both behind and in front of characters (a fire ring around the hero): draw `fx.render('back')` before the characters and `fx.render('front')` after.
- Phaser: make the layer the size of what the camera shows and lay it over the game's canvas. After the zoom is set in `create()`: `const z = this.cameras.main.zoom; const fx = createFxLayer({ width: this.scale.width / z, height: this.scale.height / z, scale: 3 }); fx.overlay(this.game.canvas);` with `pixelArt: true` in the game config, and `fx.resize(this.scale.width / z, this.scale.height / z)` in the resize handler, after the zoom. In `update(time, delta)`: `const v = this.cameras.main.worldView; fx.camera.x = v.x; fx.camera.y = v.y; fx.update(Math.min(delta / 1000, 0.05)); fx.render();`.
- KAPLAY, three.js or any engine with its own canvas: `fx.overlay(theGameCanvas)` lays the layer over it, lined up with its play area, and lets clicks through. Then `fx.update(dt); fx.render();` once per frame (KAPLAY: in `k.onUpdate` with `k.dt()`; the camera's top-left is `k.camPos()` minus half of `k.width()` and `k.height()`). In three.js, turn a world position into game units with `const v = pos.clone().project(camera)`, then `x = (v.x + 1) / 2 * width` and `y = (1 - v.y) / 2 * height`.

**Acts**
- An effect marked "acted" carries the body that goes with it: a wind-up, a freeze on contact, a target rocking back, a recovery. `fx.act(slash, { x, y })` plays it with pixelfx's grey fighter and a straw target, which suits a training ground, a demo or a fighting game built around them.
- With your own characters: `fx.act(slash, { x, y, body: false, target: false })` keeps the timing. While `fx.frozen` is true, skip updating the game too (that is the hit-stop), and offset the whole drawing by `fx.shake` (`[x, y]` in game units). The effect starts after its wind-up, so start the character's own attack animation at the same moment.
- The moves category (sword combo, fireball throw, meteor call, ground pound) are whole attacks chained from several effects: reach for them when the game needs a move rather than a spark.

**Feel**
- Fire one at every moment that matters: a hit spark and a short shake on every hit, a poof or a shatter when an enemy dies, a collect burst on a pickup, a level up, a screen wipe between levels. Small and fast for frequent things, big and slow for rare ones.
- Keep the count in check: a few dozen live effects at once is fine (`fx.count`); one per bullet in a bullet storm is not. Reuse a loop with `moveTo` instead of starting a new one every frame.
- Pixel effects belong with pixel-sized art. Shapes drawn in code sit well with them; beside smooth, detailed art, make the effects bigger (a larger scale) so they read as a deliberate style.
- Credit: `add` writes pixelfx into credits.txt and its licence into js/pixelfx/license.txt. Keep both, and show the credit on the game's own credits screen.
