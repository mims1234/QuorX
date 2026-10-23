---
name: film-from-footage
description: Cut a film from real footage - screen recordings, interviews, talking heads, event or product clips - by transcribing it, choosing takes, trimming silences, adding b-roll, titles and word-timed captions, and exporting a timeline a person can keep editing. Load after video-direction for the footage route.
---

# Film from footage

Real footage is the most believable picture there is. The work is choosing and cutting, not making. QuorX has not tested this route yet.

## 1. Log the material
- List every file with `ffprobe` (length, size, fps, audio) and keep the list in `LOG.md`.
- Transcribe speech with a local model (for example faster-whisper; installing it needs approval) to get word timings. Keep the transcript beside each clip.
- Pull a contact sheet per clip (`ffmpeg -i clip.mp4 -vf "fps=1/2,scale=320:-1,tile=6x4" sheet.jpg`) and use `look` on it to find the usable shots.

## 2. Build the paper edit
- Write the story from the transcript first: which lines, in which order, for the arc in the treatment. Cut words, not seconds.
- Remove silences, false starts and filler words. Keep breaths that carry meaning.
- Mark b-roll moments (where the speaker mentions something the viewer should see) and fill them with screen captures, stills or code-drawn graphics.
- Cut on action and on the beat, and keep the 180° rule in interviews shot from two angles.

## 3. Cut it
- Write the edit as a list of `(file, in, out)` and cut with ffmpeg so nothing is lost (keep the originals untouched). `edit_video` joins clips and pictures quickly but drops their sound, so for talking heads cut with ffmpeg and keep the audio.
- Titles, lower thirds and captions come from a code film with a transparent background (`film-render`), overlaid in ffmpeg.
- Captions: word-timed from the transcript, burned in, and exported as `.srt`.

## 4. Hand over an editable timeline
Export the edit list as an EDL or OpenTimelineIO file next to the MP4, so the user can open the cut in their own editor (DaVinci Resolve, Premiere and others read these) and keep going.

## 5. Rights
Use footage only when the user says they have the right to it. Blur faces or screens with private data unless the user confirms they may be shown.
