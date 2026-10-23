---
name: film-sound
description: Sound for any film - ambience, foley on every action, an original score from the cue map (free sample libraries or synthesis), voice-over with a speech-to-text check, J and L cuts, ducking, and a -14 LUFS master. Load with video-direction on every route.
---

# Film sound

Sound is half the film. A silent or generic soundtrack makes good pictures feel cheap. (Adapted from lemo-opuscar and mg-styles-15, both MIT. Untested in QuorX so far.)

## 1. Design it in three layers
- **Ambience:** the room, wind, rain, city, under every scene.
- **Foley:** every visible action has a sound that matches its material (paper, wood, metal, glass, ink, cloth all sound different). In a code film, drive it from `window.EV` so each sound lands on its frame.
- **Music:** written from the cue map, in the instruments of the style's sound palette.
- At least **two real silences** (or near-silences) before the turn or the peak. The first sound after a silence should be one of the most important in the film.
- Use sound as a transition at least twice: the next scene's sound starts early (J-cut), or the last scene's sound runs over the cut (L-cut).

## 2. Music
- The user's own music comes first. `compose_music` is paid and needs approval.
- Free route: write the score as events `(time, instrument, pitch, length, velocity, pan)` and play them with samples from free libraries (VSCO 2 Community Edition, VCSL, FreePats, Salamander piano and others; check each licence and list it in CREDITS), or synthesise with numpy for chiptune, drones and effects.
- Tempo first, then the picture locks to the bar grid. Check that every visual hit lands on its cue; aim for 0 ms, accept one frame.
- Balance the low end: synthetic scores get bass-heavy. Keep 20-120 Hz about 3 dB below the rest, skip pad notes below MIDI 48, and give the bass some upper harmonics so it speaks on phone speakers.

## 3. Voice
- The user's own recording comes first. Otherwise `speak` (paid, approval) or a local voice model if one is installed.
- Spell numbers out in the spoken text and write them as digits in the subtitles.
- **Check every line:** transcribe each voice file back (for example faster-whisper) and compare it with the script. Regenerate lines that come back wrong. The same pass gives word timings for subtitles.
- Compress the voice first, then sit it about 10 dB above the music by RMS, and duck the music under speech and key foley.

## 4. Master
- Two-pass loudness normalisation to -14 LUFS integrated, true peak at or below -1 dBTP: measure with `ffmpeg -af loudnorm=I=-14:TP=-1:print_format=json -f null -`, then apply the measured values.
- Stereo AAC at 48 kHz in the MP4.
- Every row of the sound design table is actually audible in the final mix. Listen once at full speed before handing over.
