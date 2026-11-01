---
name: video-direction
description: Start here for any video (launch film, trailer, explainer, motion piece, social cut, music video, documentary short). Picks the route (code, images, AI clips, footage or a mix), writes the treatment and shot list, and names the other video skills to load.
---

# Video direction

Use this first for any video request. It covers the decisions every route shares and tells you which other skill to load. A film is judged in this order: **sound, rhythm, camera, directing**. Good-looking frames are only the starting point. (Adapted from public video-agent toolkits and film references; see `docs/video-direction.md`. QuorX has not tested these rules on video yet.)

## 1. Pick the route
| Route | Picture comes from | Load | Cost |
|---|---|---|---|
| Code | `render(t)` on a canvas, SVG, WebGL or three.js page | `film-render` | free |
| Code (HyperFrames) | timed HTML clips animated with GSAP, rendered by the HyperFrames CLI | `film-hyperframes` | free; installs a package from npm |
| Moving stills | `imagine` stills (or the user's photos), each turned into a clip with `make_video` from that still | `film-from-images`, `film-from-ai-clips` | about $1 for 30 s plus the stills |
| Images | the user's photos, screenshots or `imagine` stills, moved by a camera only | `film-from-images` | free, or paid per image; reads as a slideshow |
| AI clips | `make_video` shots of up to 15 s, joined | `film-from-ai-clips` | paid per clip, usually the most expensive |
| Footage | the user's recordings, screen captures or interviews, cut together | `film-from-footage` | free |
| Mix | any of the above in one timeline, for example code titles over footage or AI clips inside a code-drawn frame | the skills for each part | sum of the parts |

- Default to **code** for product, data and motion-design films: every frame can be re-rendered, and it costs nothing. Use `film-render` unless the film is mostly type, UI layouts and captions, or needs transparent overlays or media on tracks; then offer **HyperFrames** and get approval for its install. Either way, load `motion-design` for the motion.
- Use **moving stills** when the subject is photographic and video clips are on: the stills keep the look consistent and every shot moves. Plain **images** with camera moves only when clips are off or the user wants it free. **AI clips** from text only when no still is needed; **footage** when the user has real recordings.
- Short design-led pieces (5-15 s): also load `motion-graphics`. 3D objects or characters built from a reference picture: `three-from-image`.
- Every route also loads `film-sound` and `film-review`. Load `film-style` when the user names a look or wants a reusable one.

## 2. Take the brief, once
Ask everything in one `ask_user` card, then no more questions:
- length (default 30-60 s; launch films 15-30 s), shape (16:9, 9:16, 1:1) and where it will be posted;
- whether they have their own voice, music, footage, photos, logo or data (theirs comes first);
- whether they want to see a storyboard before the full film.

Paid tools (`imagine`, `make_video`, `compose_music`, `speak`) need approval: say what each will cost before using it. Use only the product's real UI copy; invented labels make a video feel fake.

## 3. Write TREATMENT.md before any picture
1. **Three candidate structures** (for example a journey, a before/after, a countdown, a list that turns), then the one you chose and why. The first idea for a style is usually its cliché.
2. **Logline and arc:** one subject, one goal, one turn; setup, turn, ending. A product film: problem, product, payoff, call to action.
3. **Benchmark:** one or two reference works for this style and topic, with what to learn (pacing, camera grammar, colour logic, score shape) and what not to take (characters, designs, melodies, logos).
4. **Shot list:** id, time range, framing (wide, full, medium, close, insert), angle, camera move, and **why** this shot is shot this way.
5. **Beat sheet**, second by second, and a **cue map**: tempo, bar grid, and on which beat every cut, key action and subtitle lands.
6. **Sound design table:** per section, the ambience, the foley and the music state (`film-sound`).
7. **Titles and subtitles:** the type is part of the style.

Show the plan with `plan` (or a `write_artifact` table) and let the user approve it before building.

## 4. Story, camera and motion
- Hook in the first 3 seconds; the product or subject is on screen before 0:03. End with an echo of the opening, a scale reveal, or the subject getting it right the second time.
- One **native move** at the emotional peak: something only this medium can do (a fold that becomes the transition, ink that blooms into the next scene). Cut any extra beat that needs explaining.
- At least **four different camera moves** and real changes of framing (2-D has a camera too: push, pull, parallax, focus pulls). One **signature shot** people remember. Transitions made from the medium itself, not default fades.
- At key moments the subject fills at least a third of the frame height.
- Real space: keep the camera on one side of the line between subjects (180° rule) and move at least 30° between two shots of one subject. Cut in the middle of a movement.
- Vary the pace: one clear acceleration or slowdown, and one held breath. One action, one sound, one cut, but not a cut on every beat.
- Easing: entering ease-out, leaving ease-in, moving within the frame ease-in-out; never linear. When a cut can't get everything right, keep emotion and story and give up rhythm and spatial neatness first.

## 5. One timeline drives everything
Keep sections, tempo, beats and hit points in one `timeline.json`. The picture, the score, the sound effects, the subtitles and the checks all read it, so nothing drifts.

## 6. Prove the look before the film
Render three style frames (or a model sheet for characters) with the real route, and check them against the style. With a storyboard requested: 6-9 key shots tiled in one sheet with shot number, framing and duration, then wait for approval. In QuorX's Video Mode the `storyboard` tool draws that sheet and waits for the user's Go ahead; paid media waits for it.

## 7. Deliver
- The film is the deliverable: open it in the browser (`site:assets/edits/<name>.mp4`). Build a viewer page only when the user asks.
- `<name>.mp4` (1920×1080 by default, other shapes recomposed rather than cropped), `poster.jpg`, `<name>.srt` when there is speech or subtitles, `TREATMENT.md`, and a one-command build script for code routes.
- `CREDITS`: every third-party asset with its source and licence (CC0, CC BY or OFL only, unless the user owns it). A film that states facts keeps `FACTS.md`: each claim with its source.
- Never post anywhere yourself. Hand over the files and a caption.
- References teach grammar only: no copied characters, shots, melodies, logos or brands the user has no right to.
