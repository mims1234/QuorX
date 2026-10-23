---
name: film-review
description: Review a film before handing it over - contact sheets, frame strips of key actions, measured checks (length, loudness, black and frozen frames, cue timing, reading time), look checks on frames, and an anchored 1-10 rubric with a timecoded fix list. Load with video-direction on every route.
---

# Film review

Review the real frames, measure what can be measured, and give the deciders only what a person would judge by looking. (Adapted from lemo-opuscar and mg-styles-15, both MIT. QuorX has not tested this on video, and nothing here proves how well the deciders judge video.)

## 1. Look at it properly
- **Contact sheets:** a frame every 1-2 s (`ffmpeg -i film.mp4 -vf "fps=1,scale=480:-1,tile=6x4" sheet%02d.jpg`). Two full passes.
- **Frame strips** at 0.2 s steps for every key action: hand-overs, hits, falls, logo landings.
- Full-size frames at 5-8 key times, to see edges, type, banding and aliasing.
- Watch it once at full speed with sound.

## 2. Measure, don't vote
- `ffprobe`: exact length, size, fps, audio present.
- Loudness: `ffmpeg -i film.mp4 -af ebur128 -f null -` → about -14 LUFS (±1), true peak ≤ -1 dBTP.
- `blackdetect` and `freezedetect`: no blank or stuck frames except on purpose.
- Cue timing: every visual hit within one frame of its music cue.
- Reading time: from `TEXTS(t)` or the caption list, every text that finishes animating stays at least letters ÷ 15 + 1.5 s; subtitles at least 1.8 s and at least the spoken line + 0.6 s; title cards at least 4 s.
- Voice: the final mix transcribes back to the script.

## 3. Look checks (deciders)
Use `look` on contact sheets and key frames with yes/no statements, guessing first:
- "The subject fills at least a third of the frame height in this shot."
- "No caption or subtitle covers the subject."
- "The text is readable against its background (no colour on a similar colour)."
- "Nothing important sits under the right-hand rail or the bottom fifth of the 9:16 frames."
- "Subject A stays on the left in both shots."
- "The transition frames are never blank."
- "The effect still follows the subject after the camera moves."
Don't ask which version looks nicer: taste is where the deciders are least sure.

## 4. Score it like a jury
For an independent review, ask a fresh model (the reviewer, or `delegate`) that didn't make the film. Score 1-10 on each, with fixed anchors (5 = competent student work, 6 = decent template, 7 = solid professional, 8 = high-end agency, 9 = award shortlist; most first renders deserve 5-7):
- **style fidelity** (every signature feature present), **concept and hook** (hook in the first second, a hero moment, a satisfying end frame), **motion craft** (easing, overlap, anticipation, follow-through), **design and type**, **finish** (light, texture, no artefacts), **sound and sync**, **technical** (spec, fonts loaded, no glitches).

Then 5-10 fixes ordered by impact, each with timecodes, what is wrong, why it matters, and how to fix it with numbers (curve, frames, pixels, colours). At least one fix must raise the wow, not just polish. Flag anything that reads as a generic template, fallback fonts, or a spec failure as critical.

## 5. Fix rounds
- Fix everything in one round, then check once more. Report anything bigger that is left in one line.
- For showcase pieces, two rounds of make, review, revise. Keep the previous version before each round, and don't break what the review praised.
- After delivery, the user's notes are new rounds: change only what they ask.
