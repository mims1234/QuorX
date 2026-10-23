---
name: film-from-images
description: Make a film from still pictures - the user's photos or screenshots, or images made with imagine - by giving every still a camera move, layering it for depth, and cutting it to music and voice. Load after video-direction for the image route.
---

# Film from images

Stills become a film when every shot has a camera move, a reason and a sound. This route is cheap (free with the user's pictures, one `imagine` call per new image) and keeps characters consistent more easily than generated clips. QuorX has not tested it on video yet.

## 1. Gather and lock the pictures
- The user's own pictures come first. Ask if they have photos, screenshots or a logo.
- With `imagine`: write one **look line** first (medium, light, palette with 3-6 colours, lens, era) and put it in every prompt, so the stills match. Describe the same character the same way in every prompt, and keep one image per character as the reference.
- Use the aspect ratio of the final film (`16:9`, `9:16`). For camera moves, make the picture a little larger than the frame, or generate at 21:9 or 3:2 and crop.
- `imagine` is paid: list the images you plan and their total cost before making them.
- Check each still with `look` before using it ("The character's face matches the reference", "No text or watermark in the picture"). Remake only the ones that fail.

## 2. Give every still a move
- Push in, pull out, pan, tilt or a slow drift. Vary them: at least four different moves in the film.
- Move slowly, about 5-10% of the frame across a 3-5 s shot, eased in and out. A fast zoom on a still looks cheap.
- **Parallax:** split a still into layers (foreground, subject, background) and move them at different speeds for depth. Cut the layers with a mask, or ask `imagine` for the background and the subject separately.
- Match moves across cuts: if one shot pushes in, the next can continue the motion or answer it.

## 3. Build it
- **Quick:** `edit_video` joins pictures (each with a `seconds` length), a voice-over and music into one MP4. It gives no camera moves.
- **With camera moves (recommended):** draw each still on a canvas in a code film (`film-render`) and move it with `render(t)`, or use ffmpeg's `zoompan` filter per still. The code route gives easing, parallax, titles and exact timing.
- Cut on the beat from the cue map, and hold each still at least 2 s unless the cut is a deliberate rapid sequence.

## 4. Words and sound
- Burned-in captions, laid out inside the safe zone (`film-review`).
- Sound makes stills feel alive: ambience for every place, a sound for every visible action, and music from `film-sound`.
