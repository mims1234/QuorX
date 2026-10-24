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

## 2. Music, first
- The user's own music comes first. Otherwise **a music model** (`compose_music`, paid, needs approval): Lyria 3 Clip makes about 28-30 s for about $0.04, Lyria 3 Pro a longer piece for about $0.08. Ask for: instrumental (unless there is singing), the tempo ("96 BPM"), the instruments, the sections in order (quiet intro, build, full, ending) and "a clean ending".
- Measured in QuorX (October 2026): Pro ignores the length asked (35 s asked, 60 s made) but keeps the sections in order; Clip is 28-30 s; the same `seed` gives a different take. So **make the track, then fit the film to it**, not the other way round.
- In Video Mode: `music_map` gives the tempo (pass the tempo you asked for: the detector can land on a related one), the bar lines, where it gets louder or quieter and whether it ends cleanly, and the best stretch for a part ("peak", "build", "calm", "ending"). `fit_music` makes a copy of the film's length on bar lines: shorter by starting later (the real ending stays; a faded-out ending sounds cheap), longer by playing whole bars from the middle again, joined on the downbeat.
- Then the picture locks to that bar grid: cut on bars and accents, vary shot lengths (1, 2 or 3 bars) so cuts don't become predictable, and put the key moment on the biggest change. Aim for every cut within one frame of its beat.
- Written in code only for small accents and effects, or when the user wants it free. Scores written in code so far all rumbled: endless filtered-noise beds ("rain", "crowd") swelling under everything, which the -14 LUFS master then turned up. If you write one: no noise bed louder than the music, keep 20-150 Hz about 3 dB below the rest (high-pass the ambience at 150 Hz), skip pad notes below MIDI 48, and give the bass upper harmonics so it speaks on phone speakers.

## 3. Voice
- The user's own recording comes first. Otherwise `speak` (paid, approval) or a local voice model if one is installed.
- Spell numbers out in the spoken text and write them as digits in the subtitles.
- **Check every line:** transcribe each voice file back (for example faster-whisper) and compare it with the script. Regenerate lines that come back wrong. The same pass gives word timings for subtitles.
- Compress the voice first, then sit it about 10 dB above the music by RMS, and duck the music under speech and key foley.

## 4. Master
- Two-pass loudness normalisation to -14 LUFS integrated, true peak at or below -1 dBTP: measure with `ffmpeg -af loudnorm=I=-14:TP=-1:print_format=json -f null -`, then apply the measured values.
- Stereo AAC at 48 kHz in the MP4.
- Every row of the sound design table is actually audible in the final mix. Listen once at full speed before handing over.
