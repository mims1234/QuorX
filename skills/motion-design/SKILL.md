---
name: motion-design
description: Motion recipes with exact numbers - eases by role, springs, timing and stagger, title entrances, holds, transitions with a cause, beat-grid maths, loops, and the defaults that look generated. Load for any code-drawn film, titles or motion piece.
---

# Motion design

Motion is designed in numbers, not adjectives. Use these recipes as defaults. A reference the user gave, or a style's signature features (`film-style`, `motion-graphics`), win for their own moment. Each recipe gives the GSAP ease for `film-hyperframes` and a plain function for `render(t)` pages (`film-render`). (Adapted from the HyperFrames motion notes, Apache 2.0, and common motion-design practice. Untested in QuorX so far.)

## 1. Eases by role
| Role | Duration | GSAP | `render(t)` |
|---|---|---|---|
| Arrival: a title, card or element lands | 0.4-0.8 s | `expo.out`, `power4.out` | `outExpo`, `outQuart` |
| Exit | 40-50% of its entrance | `power3.in` | `inCubic` |
| Camera move, colour flood, morph | 0.6-1.2 s | `power2.inOut` | `inOutQuad` |
| Zoom through, whip | 0.13-0.35 s | `power3.in`, `expo.in` | `inCubic` |
| Rotation, progress, a counter at constant speed | any | `none` | linear |

Landing takes longer than leaving, and an exit is one smooth motion, never slide, stop, then leave. One ease and one duration for everything (`power2.out` at 0.5 s) is what makes a film look generated. Use linear only when constant speed is the point.

```js
// Helpers for render(t) pages. p is progress from 0 to 1; nothing is carried between frames.
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const prog = (t, start, dur) => clamp01((t - start) / dur);
const lerp = (a, b, p) => a + (b - a) * p;
const outExpo = (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p));
const outQuart = (p) => 1 - Math.pow(1 - p, 4);
const inCubic = (p) => p * p * p;
const inOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
// A spring as a function of time since it started. zeta: 1 never bounces, 0.7-0.85 reads premium,
// 0.4-0.6 playful, under 0.3 a cartoon. f: oscillations a second, about 1.5-3.
const spring = (t, zeta = 0.75, f = 2) => {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * f;
  if (zeta >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
};
// e.g. x = lerp(-200, 0, outExpo(prog(t, 1.2, 0.6)));  scale = 0.9 + 0.1 * spring(t - 2.0);
```

Position and scale may overshoot. Opacity and colour never do, so clamp them. The nearest GSAP built-ins to a spring are `back.out(1.4)` and `elastic.out(1, 0.5)`.

## 2. Timing
- **Overlap:** the next element starts when the previous one is 30-50% through. Fully one-after-another looks robotic, all at once looks cheap.
- **Stagger:** letters 1 frame apart (0.033 s at 30 fps), words 0.06-0.12 s, list items 0.04-0.08 s, cards 0.08-0.15 s.
- **Hook:** something is on screen or moving by 0.5 s. Frame 0 is the thumbnail on social players, so start with the title or key image on screen, or arriving at 0.
- **Holds:** a line the viewer must read stays 0.5 s plus 0.3 s a word. The last line stays at least 2 s, a logo at least 1.5 s, a one- or two-word chapter line 0.4 s.
- **Rhythm:** contrast speeds. Montage shots 0.13-0.8 s; ordinary shots 1.8-3 s with motion inside them; a UI demo may hold one framing 7-10 s while the UI works. Hold 0.3-0.75 s before the payoff, then play the payoff at normal speed.
- Entrances that are too snappy read as glitches. Slowing the whole film by about a second often fixes it before any ease needs changing.

## 3. Title entrances
Vary them within a film. Never fade-and-slide-up every time.
1. **Word blur-in:** each word blur 6 px → 0 and opacity 0 → 1 in 0.13 s, 0.067 s apart, no movement.
2. **Ink-up:** each word from light grey to ink, 0.07-0.1 s apart, no movement.
3. **Line blur:** the whole line blur 8 px → 0 in 0.13-0.2 s.
4. **Name by letters:** 0.1 s apart, opacity 0.3 → 1 with a slight blur.
5. **Mask rise:** each line rises its own height inside a clipping box, `expo.out` 0.6 s, lines 0.08 s apart.
6. **Slot roll:** one word rolls through options, about 0.1 s each, and lands with a short spring (zeta 0.8).
7. **Behind the subject:** the title sits between the background and a cut-out of the person or product.

A landed title is dead still: the motion moves to the next element, the camera or the world behind. Title size is 4-9% of the frame height, one or two lines; quiet lines 2.5-4% against hero words that fill 60-90% of the width. Use one accent-coloured word, and only when it carries the meaning. Exit with a blur-out and fade of 0.13-0.25 s, word by word, or ride out with the scene's move.

## 4. Transitions with a cause
Use 3-5 kinds in a film, each caused by something on screen. At most a third of the seams between scenes are hard cuts (punch-ins inside a scene don't count), and two worlds never crossfade.

| Transition | Recipe |
|---|---|
| Zoom through | the camera tracks to a button or shape (0.6 s, `power2.inOut`, with blur), then it scales from ~8% to ~250% of the frame in 0.35 s, `power3.in`; its fill becomes the next frame |
| Object becomes the world | a card or pill grows past the frame in 0.65 s, `power2.inOut`, its corner radius shrinking; what was around it blurs ~15 px and fades in 0.3 s; the new content fades in while it still grows |
| Morph | one container widens into the next (~110 → ~880 px in 0.2 s, `power3.out`) with a horizontal blur 12 → 0 |
| Carry across | the result shrinks 1 → 0.6 with blur peaking at 6 px mid-move and lands inside the next scene as it builds around it |
| Colour flood | the hero object stays while the ground changes colour in ~0.4 s, `power2.inOut` |
| Whip | a 0.13-0.3 s directional smear; the arriving element lands blurred and sharpens in ~0.13 s |
| Iris | a circular clip opens from the clicked point onto the next scene in 0.15 s |
| Dip cut | the outgoing frame darkens ~40% for 3 frames, then a hard cut |
| Match cut | cut at the fastest frame of a move, same direction and speed on both sides; mirror the eases across the seam (`power3.in` out, `power3.out` in) |

## 5. Moves
- A fast move (0.3-0.6 s) carries motion blur that peaks at its fastest frame: 6-12 px on text-sized elements, 15-20 px full frame, along the direction of travel only. In HyperFrames put `data-motion-blur="on"` on the root. In a canvas film draw the element 3-5 times along its path at falling opacity, or use a directional blur shader.
- Animate transforms (position, scale, rotation), not layout (left, top, width, height).
- Punch-in, reframe, Ken Burns: scale and move a wrapper, never the media itself; 3-8% over a shot, `power1.inOut`.
- A slow orbit of a background stage runs 3-5° a second. In parallax, far layers move 0.2-0.5× as far as near ones.

## 6. Beat grid
Frames per beat = fps × 60 / BPM. Compute each beat from its index and round once: `beatFrame = (i) => Math.round(i * fps * 60 / bpm)`. Never add a rounded beat again and again: at 128 BPM and 30 fps that drifts 2 frames in 32 beats. Cut on beats, change the layout on bars, and put the hero moment on the music's biggest change (`music_map`). Sounds land within one frame of their visual hit (`film-sound`).

## 7. Loops and end frames
- A loop's last frame leads into its first (same positions, motion continuing). Check it by looking at the last 0.5 s and the first 0.5 s side by side.
- The end frame is still and readable: logo or call to action, held at least 1.5 s, nothing creeping.

## 8. Defaults that look generated
Remove these on sight: breathing, floating or pulsing loops on titles and UI; titles that keep sliding or scaling after they land; a slow creeping zoom late in a scene; bounce on UI; click rings; every scene entering the same way; every element fading and sliding up; the same ease and duration everywhere; linear moves. A character's idle and overshoot are acting, not these.

## 9. When the user says
| The user says | Change |
|---|---|
| "too fast" | slow every zoom and pan to 0.7× of its speed, nothing else |
| "speed it up" | shorten the content and its beat by the same amount; later beats move up |
| "the titles move" | land them, then hold them dead still until they leave |
| "it feels like slides" | enter the next scene through an object on screen; cut a move mid-flight |
| "it looks cheap" | go through section 8 first, then vary the eases by role (section 1) |
