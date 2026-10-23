---
name: film-render
description: Build a film whose every frame is drawn by code (canvas, SVG, WebGL, three.js) as a pure function of time, preview it, capture it frame by frame in a headless browser and encode it with ffmpeg. Load after video-direction for the code route.
---

# Film render (the code route)

A code film is a web page that can draw any moment on demand. Then the preview, the checks and the final render all show the same frames, any frame can be rebuilt alone, and a change costs one re-render instead of a new generation. (Adapted from lemo-opuscar and mg-styles-15, both MIT. Untested in QuorX so far.)

## 1. The page contract
The film's `index.html` exposes:

```js
window.DUR = 42.0;                 // length in seconds
window.render = (t) => { /* draw the frame at time t */ };
window.READY = true;               // set once fonts, images and models have loaded
window.EV = [{ t: 1.5, type: 'whoosh' }, ...];      // optional: sound events for the mixer
window.TEXTS = (t) => [{ text, x0, y0, x1, y1 }];   // optional: every text on screen at t
```

- **Deterministic:** no `Date.now()`, no `performance.now()`, no unseeded `Math.random()` (use a seeded generator), no state carried from the previous frame.
- `film.html?t=12.4` draws that frame and stops, so the browser tool and `look` can see any moment.
- **One world-to-screen function:** anything that follows a subject (a zoom, a spotlight, a caption) goes through it. Never hand-type screen positions that break when the camera moves.
- Draw for the output size (1920×1080 by default; 1080×1920 for vertical) and lay out from the page size.
- Load fonts and assets from the project with absolute paths. Nothing loads from the internet while rendering.
- Canvas 2D for most 2-D looks, three.js for 3-D, WebGL shaders for post effects. Animate on twos (12 fps steps) only when the style wants a stop-motion or cel look, and keep the camera smooth every frame.

## 2. Preview and check
- `preview_site` the page, open `film.html?t=<time>` at key moments, and use `look` on them.
- Make `sheet.html`: 12-24 frames in a grid with their times underneath (the contact sheet). It reuses `render(t)`.
- `TEXTS(t)` lets a script check that every text stays long enough to read (`film-review`).

## 3. Capture
QuorX's own browser tool is for looking, not batch capture, so write a small Node script in the project:
1. Check `ffmpeg -version` first. Installing a browser library (for example `puppeteer-core`, pointed at the installed Edge or Chrome) is a package install, so say so and get approval.
2. Open the page at the output size, wait for `window.READY`, then for each frame `n` call `render(n / fps)` and save a JPEG screenshot (JPEG is much faster than PNG).
3. Run 2-4 workers, each with its own browser and its own range of frames.
4. Encode: `ffmpeg -framerate 30 -i frames/%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 out/video.mp4`.
5. Add film grain in ffmpeg (`noise` filter), not in the page: grain drawn in the page makes every frame slow to compress.

Write the steps into `build.ps1` or `build.sh` so the whole film rebuilds with one command.

## 4. Formats
- Master: 1920×1080, 24 or 30 fps, H.264, CRF 18, `yuv420p`.
- Vertical 1080×1920 and square 1080×1080 are re-laid-out from the page size, never cropped from the master.
- For a GIF preview: `ffmpeg -i film.mp4 -vf "fps=12,scale=900:-1:flags=lanczos" preview.gif`.
