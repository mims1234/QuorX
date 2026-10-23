---
name: film-from-ai-clips
description: Make a film from AI-generated video clips (make_video) - shot prompts, keeping characters and places the same from shot to shot with start images, choosing between takes, and joining the clips with voice and music. Load after video-direction for the AI-clip route.
---

# Film from AI clips

Generated clips look like live action but are the most expensive tool, can't be re-rendered the same way, and drift between shots. Plan hard before spending. QuorX has not tested this route yet.

## 1. Plan the spend first
- Write the shot list (`video-direction`), then count: number of clips × seconds × takes. Show the user the total before the first `make_video` call. Every call needs approval.
- Keep clips short (3-8 s). Shorter is cheaper and drifts less. Clips can't exceed 15 s.
- Use code (`film-render`) for titles, captions, logos, UI, charts and anything with exact text: video models get text and screens wrong.

## 2. Lock the look and the cast
- Write one **look line** (medium, light, palette, lens, film stock, era) and reuse it word for word in every prompt.
- Make one key picture per character and per location with `imagine`, and check them with `look`. Start every clip from a key picture with `start_image` (on models that take one), so faces and places stay the same.
- For a cut inside one scene, start the next clip from the last frame of the previous clip (`ffmpeg -sseof -0.1 -i a.mp4 -frames:v 1 last.png`).

## 3. Write each shot prompt
One sentence each for: subject, action (one action per clip), camera (framing and one move), light and mood, and the look line. Name what must not change ("the same red scarf"). Avoid asking for readable text.

## 4. Choose between takes
- When a shot matters, make two takes and pick one. Pick by a `decide` choice question against the user's own words and the shot's purpose, with the options in random order. Don't pick by which is prettier.
- Check each chosen clip with `look` on a few frames: right character, right place, no warped hands or faces, nothing important cut off.
- Regenerate only what fails, and tell the user what each retry costs.

## 5. Join and finish
- `edit_video` joins clips and pictures in order with a voice-over and music, fitted to the chosen aspect ratio. It drops the clips' own sound.
- For titles, captions or code-drawn graphics on top, render them as a code film with a transparent background, or composite in a code film that plays the clips as video textures (`film-render`).
- Trim every clip to its beat in the cue map, then mix the sound with `film-sound` and check with `film-review`.
