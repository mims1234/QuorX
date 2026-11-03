// Plays pixelfx effects on one small pixel canvas, which the game scales up and draws over its scene.
// QuorX writes it beside the pixelfx files; it is not part of pixelfx.
//
//   const fx = createFxLayer({ width: view.w, height: view.h, scale: 3 });  // the game's size, and how big one effect pixel is
//   const boom = fx.play(explosion, { x: enemy.x, y: enemy.y });            // game coordinates; returns a handle
//   every frame: fx.update(dt); then draw fx.render() over the scene at the game's size, unsmoothed.

import { createFrame, clearFrame, createFx, createAct, composite } from './core/index.js';

// Weather and transitions are drawn for one 320 x 180 screen.
const SCREEN_W = 320, SCREEN_H = 180;

/**
 * @param {object} opts
 * @param {number} opts.width the game's width in its own units (view.w)
 * @param {number} opts.height the game's height (view.h)
 * @param {number|'cover'} [opts.scale] game units per effect pixel (3: a 960 x 540 view is a 320 x 180 pixel canvas);
 *   'cover' picks the scale at which a 320 x 180 screen covers the whole view, for weather and transitions
 */
export function createFxLayer({ width, height, scale = 3 } = {}) {
  const cover = scale === 'cover';
  const canvas = document.createElement('canvas');
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  let k, w, h, frame, image;
  // The view can change (a phone turned, a window resized): the canvas and its buffers change with it.
  function size(nextWidth, nextHeight) {
    width = Math.max(1, Number(nextWidth) || 1);
    height = Math.max(1, Number(nextHeight) || 1);
    k = cover ? Math.max(width / SCREEN_W, height / SCREEN_H) : Math.max(1, Number(scale) || 3);
    w = Math.max(1, Math.round(width / k));
    h = Math.max(1, Math.round(height / k));
    canvas.width = w;
    canvas.height = h;
    frame = createFrame(w, h);
    image = ctx.createImageData(w, h);
  }
  size(width, height);
  const live = [];
  /** The top-left of what the game shows, in game units: set it from the game's camera each frame. */
  const camera = { x: 0, y: 0 };
  let overlaid = null;

  function add(inst, isAct, drawOpts, pin = null) {
    const options = isAct ? inst.fx.options : inst.options;
    const handle = {
      /** Move a running effect (a projectile, an aura that follows someone). Acts and screen effects stay put. */
      moveTo(x, y) {
        if (isAct || pin) return;
        options.x = x / k;
        options.y = y / k;
      },
      /** Turn it to face left (true) or right (false). */
      face(left) { if (!isAct) options.flip = !!left; },
      /** Let it end: a loop fades out, a one-shot is cut short. */
      stop: () => inst.stop(),
      done: () => inst.done(),
      get t() { return inst.t; },
      meta: inst.meta,
    };
    live.push({ inst, isAct, drawOpts, pin, handle });
    return handle;
  }

  // An option left empty (palette: undefined, a PAL name that does not exist) keeps the effect's own, rather than breaking it.
  const given = (opts) => Object.fromEntries(Object.entries(opts || {}).filter(([key, value]) =>
    value != null && (key !== 'palette' || (Array.isArray(value) && value.length > 0))));
  const scaled = (opts) => ({ ...given(opts), x: (opts?.x ?? 0) / k, y: (opts?.y ?? 0) / k });

  function place() {
    if (!overlaid) return;
    const box = overlaid.getBoundingClientRect();
    // Fit the game's shape inside the element, centred, as letterboxing engines do.
    const fit = Math.min(box.width / width, box.height / height);
    const cw = width * fit, ch = height * fit;
    Object.assign(canvas.style, { left: `${box.left + (box.width - cw) / 2}px`, top: `${box.top + (box.height - ch) / 2}px`, width: `${cw}px`, height: `${ch}px` });
  }

  return {
    canvas,
    camera,
    get width() { return w; },
    get height() { return h; },
    get scale() { return k; },
    /** The view changed (an adaptive view): give the new size, in game units. Running effects carry on. */
    resize(nextWidth, nextHeight) {
      if (nextWidth === width && nextHeight === height) return;
      size(nextWidth, nextHeight);
      place();
    },
    /**
     * Start an effect. opts: x, y (game units, where its origin goes), flip (face left), angle (radians),
     * palette (hex colours, dark to bright), seed, light (glow strength), and the effect's own options.
     */
    play(mod, opts = {}) {
      return add(createFx(mod, scaled(opts)), false);
    },
    /**
     * Play an effect with its act: the stock grey character winds up, lets go and recovers, and a straw target
     * takes the hit. { body: false, target: false } leaves them out and keeps the timing, freezes and shake.
     */
    act(mod, opts = {}) {
      const { body = true, target = true, ...rest } = opts;
      return add(createAct(mod, scaled(rest)), true, { body, target });
    },
    /**
     * Start a whole-screen effect (weather, a transition), pinned to the middle of the view so it stays on screen as
     * the camera moves. Its 320 x 180 screen fills the view on a layer made with scale: 'cover'.
     */
    cover(mod, opts = {}) {
      const [x, y] = mod.meta?.origin ?? [0, 0];
      return add(createFx(mod, { ...given(opts), x, y }), false, null, [x, y]);
    },
    update(dt) {
      for (const item of live) item.inst.update(dt);
      for (let i = live.length - 1; i >= 0; i--) if (live[i].inst.done()) live.splice(i, 1);
    },
    /**
     * Draw every effect into the canvas, and return it. layer: 'back' for the parts that go behind characters,
     * 'front' for the rest, or nothing for all of it at once. Acts are drawn whole, with 'front' or nothing.
     */
    render(layer) {
      clearFrame(frame);
      frame.ox = Math.round(camera.x / k);
      frame.oy = Math.round(camera.y / k);
      for (const item of live) {
        if (item.pin) {
          item.inst.options.x = frame.ox + item.pin[0] + Math.round((w - SCREEN_W) / 2);
          item.inst.options.y = frame.oy + item.pin[1] + Math.round((h - SCREEN_H) / 2);
        }
        if (item.isAct) {
          if (layer !== 'back') item.inst.draw(frame, item.drawOpts);
        } else item.inst.draw(frame, layer);
      }
      composite(frame, image.data, null);
      ctx.putImageData(image, 0, 0);
      return canvas;
    },
    /**
     * Lay the canvas over an element that shows the game (the engine's canvas), lined up with its play area,
     * for engines that draw their own canvas (Phaser, KAPLAY, three.js). Clicks go through to the game.
     */
    overlay(element) {
      overlaid = element;
      Object.assign(canvas.style, { position: 'fixed', pointerEvents: 'none', zIndex: '1' });
      if (!canvas.isConnected) document.body.appendChild(canvas);
      place();
      addEventListener('resize', place);
      if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(element);
      return canvas;
    },
    /** Remove every effect at once (a new level, back to the title screen). */
    clear() { live.length = 0; },
    get count() { return live.length; },
    /** True while an act holds still on a hit: stop updating the game too, for the same hit-stop. */
    get frozen() { return live.some((item) => item.isAct && item.inst.frozen); },
    /** How far to throw the picture right now, in game units, from the acts' screen shake: [x, y]. */
    get shake() {
      let x = 0, y = 0;
      for (const item of live) {
        if (!item.isAct) continue;
        const [sx, sy] = item.inst.shake;
        x += sx * k;
        y += sy * k;
      }
      return [x, y];
    },
  };
}
