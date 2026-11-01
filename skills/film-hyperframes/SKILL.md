---
name: film-hyperframes
description: Build a film as a HyperFrames project (timed HTML clips animated with GSAP) and render it with the HyperFrames CLI. An alternative code route for type-, layout- and UI-heavy films, transparent overlays and media on tracks. Load after video-direction, with motion-design.
---

# Film with HyperFrames (an alternative code route)

HyperFrames (by HeyGen, Apache 2.0) renders an HTML page to video. It seeks a paused GSAP timeline frame by frame in headless Chrome and encodes the frames with ffmpeg, so the same input always gives the same frames. (hyperframes 0.8.225 was tried on Windows by hand: init, check, snapshot and render all worked. The QuorX agent has not run it yet.)

## 1. Pick it, or not
| `film-render` with `render_film` (the default) | HyperFrames |
|---|---|
| Free, nothing to install or approve | Installs `hyperframes` from npm and runs its own Chrome: say so and get approval first |
| Canvas, WebGL, three.js, generative art, particles | Page layouts: kinetic type, UI mock-ups, cards, HTML/SVG charts, captions |
| Video Mode's film checks run on its output | Video and audio clips placed on tracks in the page, transparent MOV/WebM overlays for footage, about 450 ready-made blocks (transitions, titles, captions, charts) |

Choose HyperFrames only when its column clearly fits, and tell the user why.

## 2. Set up, once per project
- Check `node -v` (22 or later) and `ffmpeg -version`.
- Pin the version in every command: `npx -y hyperframes@0.8.225 <command>`, or the version the user agreed to. Never switch to `@latest` mid-project. Below, `hf` stands for that pinned command.
- Turn telemetry off before anything else: `hf telemetry disable`. It is on by default and sends usage to HeyGen.
- Create the project as a folder inside the user's project: `hf init film --non-interactive --skip-skills` (add `--resolution portrait` or `square` for other shapes). `--skip-skills` matters: without it, `init` writes HyperFrames' own agent skills into the user's global folders (`~/.claude/skills`, `~/.agents/skills`).
- The starter page loads GSAP from a CDN. Copy GSAP into the project and point the script tag at it, so nothing loads from the internet while rendering: `npm pack gsap@3.15.0`, then take `package/dist/gsap.min.js` from the archive into `film/assets/vendor/`. Delete the archive afterwards.
- Leave out the paid and online commands (`cloud`, `lambda`, `cloudrun`, `publish`, `usage`, and HeyGen media in `media-use`) unless the user asks for them: they cost money or upload the film. Don't run `skills update` either, because it writes into global folders.

## 3. The page contract
```html
<div id="root" data-composition-id="main" data-start="0" data-duration="15" data-width="1920" data-height="1080">
  <h1 id="title" class="clip" data-start="0" data-duration="4" data-track-index="0"><span class="w">Launch</span> <span class="w">day</span></h1>
  <audio id="music" src="assets/music.mp3" data-start="0" data-duration="15" data-track-index="9"></audio>
</div>
<script src="assets/vendor/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#title .w', { opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.13, stagger: 0.067, ease: 'power4.out' }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines['main'] = tl;
</script>
```

1. Every timed element has `class="clip"`, `data-start` and `data-duration` in seconds, and shows over `[start, start + duration)`. The root's `data-duration` is the film's length. `data-track-index` is only an editor lane; paint order is `z-index`.
2. Each composition builds one paused timeline and registers it after its tweens under its `data-composition-id`.
3. Deterministic: no `Date.now()`, no unseeded `Math.random()`, no timers, no fetches, no `repeat: -1`. Everything visible is a function of timeline time.
4. Never tween `display`, `visibility` or `autoAlpha` on a `.clip`: animate a child. Don't put a CSS `transform` on an element GSAP transforms. Animate transforms, not `left`/`top`/`width`/`height`.
5. Media: never call `play()`, `pause()` or seek. A `<video>` is `muted` unless it has `data-has-audio="true"`. Every `<audio>` has an `id`, or it is left out of the mix.
6. Asset paths are `assets/...` with no leading slash. Fonts other than the bundled ones need `@font-face` pointing to a file in `assets/fonts/`.
7. Films over ~15 s: one scene per file in `compositions/`, everything inside `<template>`, mounted from `index.html` by a host with `data-composition-src`. The host's `data-composition-id`, the scene's and its timeline key must match, or each scene waits 45 s and renders still. Inside scenes use `fromTo`, not `from`. `hf docs <topic>` prints the official notes.

The motion itself comes from `motion-design`: its GSAP column applies here unchanged.

## 4. Check and look
- After every pass, run `hf check --json`. Fix every error and weigh every warning (it flags an empty first frame, a film with no sound, overflow and low contrast).
- `hf snapshot --at 0,1.5,4,8` writes PNGs and a `contact-sheet.jpg` under `.hyperframes/artifacts/snapshots/<id>/`. Look at the contact sheet. Use `--range 2,4 --frames 8` for a single move.
- State intent in a `<name>.motion.json` next to the composition (`appearsBy`, `before`, `staysInFrame`, `keepsMoving`), so `check` tests it on the real timeline.
- Look with `snapshot`, not `preview`: `preview` is a server that keeps running. Tell the user they can run `hf preview` to scrub the film themselves.

## 5. Render
- From the project root: `hf render film --quality delivery -o assets/edits/<name>.mp4`. `-o` is relative to where the command runs. Use `--quality draft` for test renders.
- Shapes: lay out each shape at its own size (a composition made with `--resolution portrait` or `square`); never crop the master.
- Overlays for footage: `--format mov` (ProRes 4444 with alpha) or `--format webm`, then composite over the footage in ffmpeg (`film-from-footage`).
- Sound: put the fitted music (`fit_music`) in as an `<audio id>`, or render silent and mix later with `edit_video`. Master at -14 LUFS (`film-sound`).
- Afterwards, check the file isn't empty and that `ffprobe`'s duration matches the root `data-duration`. A 4 s 1080p test took about 25 s to render, most of it Chrome starting. Run long renders in the background.
- The render ends with a line advertising HeyGen's desktop app. Don't pass it on.

## 6. Deliver
As in `video-direction`: `assets/edits/<name>.mp4`, a poster frame, and the `film/` folder as the editable source. In `CREDITS` name GSAP (GreenSock's free licence), HyperFrames (Apache 2.0) and every registry block you added with `hf add`.
