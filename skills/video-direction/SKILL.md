---
name: video-direction
description: Direct a short video (launch film, trailer, explainer, motion piece, social cut) so it looks directed - shot list first, a film drawn as a function of time, frame checks on a contact sheet, and a finish for muted phones.
---

# Video direction

Use this when the user asks for a launch video, trailer, promo, explainer, motion piece or social cut. A film looks directed when the whole plan exists before any frame does, every frame can be rebuilt exactly, and the checks look at real frames. (Distilled from public video-agent toolkits and film-editing references; see `docs/video-direction.md`.)

These rules come from reading those sources. QuorX has not yet tested them on video, and nothing here proves how the deciders do on video questions.

## 1. Brief and real assets
- Find out, or ask in one `ask_user` card: length (default 15-30 s for a launch film), where it will be posted (16:9, 9:16, 1:1), and whether it needs a voice. A movie implies music and sound even when the user doesn't say so.
- Use the product's real screens and real UI copy. Invented labels are the quickest way to make a video feel fake.

## 2. Plan the whole film first
- Call `plan` before writing any scene. Its spec names the shape: cold open, introduce, escalate, climax, button (for a product: the problem, the product, the payoff, the call to action).
- Put a shot list in the plan or in a `write_artifact` table. Each shot gets an id, its time range, its purpose, framing, camera move and the cut out of it. Aim for 6-18 shots.
- The product is on screen before 0:03. Pick the music's tempo first and land cuts on bar lines. The music changes mood at no more than two or three planned points.
- Rewriting scenes nobody needed is the costliest mistake, so the plan is what the user approves.

## 3. Lock the style
- With a `DESIGN.md`, use its tokens. Without one, pick one direction yourself (see `design-craft`) or read a reference with `extract_design`.
- Keep characters, colours and type the same in every shot. Write them down once and reuse them.

## 4. Build the film as a function of time
- Draw every frame from `t` alone: `drawFrame(t)` on a canvas, or a paused timeline you seek. No `Date.now()`, no `setInterval` timing, no unseeded `Math.random()`. Then the preview, the checks and the final render all show the same frames.
- Give the page two ways to show a fixed moment: `film.html?t=12.4` draws that frame and stops, and `sheet.html` draws 12 evenly spaced frames in a grid with their times underneath (the contact sheet).
- Motion: entering elements ease out, leaving elements ease in, moves within the frame ease in and out. Never linear. UI-like moves take 200-500 ms, small accents 150-250 ms. Stagger elements so one leads, and keep one main focus per frame.
- Real space (3-D scenes, two people talking): keep the camera on one side of the line between the subjects (180° rule), and move it at least 30° between two shots of the same subject. Cut in the middle of a movement.
- When a cut can't get everything right, keep emotion and story and give up rhythm, eye-trace and spatial neatness first (Murch's order).

## 5. Check real frames
- Open `sheet.html` and use `look` with checks you can't answer from your own code, guessing first:
  - "Every caption in these frames is fully readable."
  - "No text or face sits in the top 9% or bottom 20% of the 9:16 frames, or under the right-hand edge."
  - "Subject A stays on the left of the frame in shots 3 and 4."
- Measure what can be measured instead of asking: durations, frame count, loudness and beat timing come from your code or from `ffprobe`, not from a vote.
- Don't ask the deciders which look is nicer. Taste questions are where they are least sure.
- Fix what a settled "no" names, then check the sheet again. Stop after two rounds and list what is left in the reply.

## 6. Sound and finish
- Burn captions in: many viewers watch with the sound off.
- Text must stay readable when the video is shown at 720p.
- Mix to about -14 LUFS with true peaks under -1 dBTP (`ffmpeg -af loudnorm=I=-14:TP=-1`). Platforms turn louder masters down.
- `compose_music` and `speak` are paid and need approval. Ask for them only when the user wants sound, and say what each costs.

## 7. Render and deliver
- An MP4 needs `ffmpeg` (`ffmpeg -version`) and a script that opens `film.html` in a headless browser, seeks each frame, saves a PNG and encodes them. Installing a browser library for that is a package install and needs approval, so say so first.
- Default master: 1920×1080, 30 fps, H.264, CRF 18. Cut 9:16 (1080×1920) and 1:1 from the same film when the user posts there, and recompose the layout for each shape rather than cropping.
- `make_video` makes one short AI clip (15 s at most) from a prompt. Use it only for footage that code can't draw, and remember that a generated clip can't be re-rendered the same way.
- Never post anywhere yourself. Hand over the files and a caption, and the user posts them.
