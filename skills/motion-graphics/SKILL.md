---
name: motion-graphics
description: Make a short design-led motion piece (5-15 s; logo sting, product teaser, title sequence, social loop, kinetic type) in code, from a brief with testable signature features, per-second beats and an exact output spec. Load with video-direction and film-render.
---

# Motion graphics

A short motion piece lives or dies on its first half-second, one hero moment and a clean end frame. Write the brief so a reviewer can check it, then build it as a code film (`film-render`). (Adapted from mg-styles-15, MIT. Untested in QuorX so far.)

## 1. Write the brief in four parts
1. **Output (fixed):** size, fps, exact length (for example 10.000 s), H.264 with stereo AAC at 48 kHz, -14 LUFS, true peak under -1 dBTP.
2. **Technical route:** SVG, Canvas, WebGL or three.js, and the key techniques. Choose a better route if it clearly raises quality, and say why.
3. **Creative seed:** a one-line title, then what happens second by second (hook, build, peak, end frame), a palette of 3-6 exact colours, the type's character, and the sound (music style and the key effects).
4. **Signature features:** what makes this style itself, written so it can be checked. Write "overshoot with cubic-bezier(0.34, 1.56, 0.64, 1), elements staggered 2-4 frames apart", not "bouncy". Write "halftone dots at 45°, 6 px", not "retro texture".

The creative seed may change if a stronger idea appears. The signature features may not.

## 2. Motion craft
- Hook in the first 0.5 s: something moves or appears at once.
- Every meaningful move has anticipation, action and follow-through. Overlap the parts (a title's letters land 2-4 frames apart), and move along arcs, not straight lines, when the style allows.
- One hero moment, timed to the strongest hit in the music.
- A satisfying end frame held long enough to read (at least 1 s; a logo at least 1.5 s).
- No dead frames and no jitter: every element is either still on purpose or moving with easing.
- Make sounds land on the visual hits (`film-sound`): within one frame.

## 3. Variants
Lay out 16:9, 9:16 and 1:1 from the page size rather than cropping. For a seamless loop, the last frame must lead into the first (same positions, motion continuing).

## 4. Review
Two rounds of make, review, revise: an independent review with the `film-review` rubric, scored against the signature features above.
