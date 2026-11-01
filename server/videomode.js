// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Video Mode: a request for a film gets a director's workflow instead of being treated like any other build.
// The harness notices the film (the prompt enhancer's "kind", or plain words when there is no reading), loads the
// video skills itself, and has the agent take a brief, pick a story and show a storyboard before anything is spent.
// The storyboard is a card the user approves; paid media waits for it. Before the final reply the reviewer gets the
// film's measured facts and a contact sheet, so it scores the film and not only the page around it.
// Everything here is off for a request that is not a film: none of it reaches the agent, its tools or its limits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mapMusic, cutsOf, cutsVsBeats } from './musicmap.js';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ⚙ Settings → Video. Merged into the agent's DEFAULTS, so the page gets them with the rest.
export const VIDEO_DEFAULTS = {
  videoMode: 'auto',        // 'auto' = a film request turns Video Mode on · 'off' = never
  videoAskLimit: 8,         // questions a reply in Video Mode may ask (the brief, the story, a storyboard change); the usual limit when that is higher, and none when questions are off
  videoWaitSecs: 120,       // ⚡ YOLO: the brief, story and storyboard cards wait this long for the user, then go with the agent's recommendations (0 = at once)
  videoStoryboard: true,    // paid pictures, clips, music and voice wait until the user approves a storyboard
  videoRoute: 'auto',       // the route the brief recommends: 'auto' (by subject) · 'animate' (stills turned into AI clips) · 'hybrid' · 'images' · 'code' · 'clips' · 'footage'
  videoMusic: 'ai',         // the music the brief recommends: 'ai' (a music model, then fitted to the film) · 'code' · 'own'
  videoLength: 30,          // seconds the brief recommends
  videoShapes: 'both',      // shapes the brief recommends: '16:9' · '9:16' · '1:1' · 'both' (16:9 and a 9:16 cut)
  videoViewer: false,       // also build a viewer page (index.html) around the film; off: the film itself is the deliverable
  videoReview: true,        // the reviewer gets each new film's facts (length, size, sound, loudness, cuts on the beat) and a contact sheet
};

// Loaded into every Video Mode reply. The route skill follows from the brief, so the agent loads that one.
export const VIDEO_SKILLS = ['video-direction', 'film-sound', 'film-review'];
export const ROUTE_SKILLS = { animate: 'film-from-images and film-from-ai-clips', hybrid: 'film-from-images and film-from-ai-clips', images: 'film-from-images', code: 'film-render', clips: 'film-from-ai-clips', footage: 'film-from-footage' };
const ROUTE_TEXT = {
  animate: 'generated stills, each turned into a short AI clip that starts from it (make_video with start_image), so everything moves and stays consistent',
  hybrid: 'generated stills: the 3 or 4 key shots turned into AI clips, the rest with camera moves',
  images: 'stills with camera moves only (cheapest; it reads as a slideshow, so cut it short and add movement inside the frame)',
  code: 'drawn in code (free, every frame exact)',
  clips: 'AI video clips from text (no stills first; shots may not match each other)',
  footage: 'cut from the user\'s own footage',
};
// What a route costs, roughly, for a film of `len` seconds with one shot every 3-4 s (prices of the cheapest models in use).
const ROUTE_COST = (route, len) => {
  const shots = Math.max(3, Math.round(len / 3.5)), stills = shots * 0.03;
  if (route === 'animate') return `about $${(stills + len * 0.035).toFixed(2)}`;
  if (route === 'hybrid') return `about $${(stills + Math.min(4, shots) * 3.5 * 0.035).toFixed(2)}`;
  if (route === 'images') return `about $${stills.toFixed(2)}`;
  if (route === 'clips') return `about $${(len * 0.035).toFixed(2)}`;
  return 'free';
};
const SHAPE_TEXT = { '16:9': '16:9', '9:16': '9:16 for phones', '1:1': '1:1 square', both: '16:9 plus a 9:16 cut for phones' };

// ---------- is this a film? ----------
// Things a person makes and watches. "animation" alone is left out: "a game with animation" is not a film.
const FILM = 'video|film|movie|trailer|teaser|reel|showreel|promo|montage|explainer|commercial|documentary';
// A film word followed by one of these is a feature of something else: a video player, a promo page, a film app.
const NOT_FILM_NEXT = new Set(['player', 'players', 'call', 'calls', 'chat', 'conference', 'conferencing', 'upload', 'uploads', 'uploader', 'stream', 'streaming', 'editor', 'element', 'tag', 'component', 'gallery', 'thumbnail', 'thumbnails', 'background', 'embed', 'feed', 'platform', 'site', 'website', 'page', 'app', 'section', 'tab', 'card', 'button', 'link', 'links', 'codec', 'format', 'file', 'files', 'library', 'api', 'sdk', 'plugin', 'tool', 'bot', 'game', 'review', 'reviews', 'recommendations', 'database', 'list', 'search', 'downloader', 'converter', 'url', 'id', 'quality', 'settings']);
const MAKE = /\b(make|makes|making|create|creating|produce|producing|render|generate|edit|cut|direct|animate|craft|put together|need|want|turn|shoot|film)\b/i;
const NOUN_RE = new RegExp(`\\b(music video|short film|animated (?:short|film|video|explainer)|${FILM})s?\\b(?:[\\s-]+(\\w+))?`, 'gi');

/** True when the user's words ask for a film to be made. Used when there is no enhancer reading to go by. */
export function looksLikeFilm(text) {
  const t = String(text || '');
  for (const m of t.matchAll(NOUN_RE)) {
    const next = String(m[2] || '').toLowerCase();
    if (NOT_FILM_NEXT.has(next)) continue;
    const before = t.slice(Math.max(0, m.index - 80), m.index);
    // "Make me a nice video of…", "I need a 30 s promo", "turn these photos into a reel".
    if (MAKE.test(before.split(/[.?!\n]/).pop())) return true;
    // "A video of India winning…", "a trailer for my game".
    if (/\b(a|an|the|my|our|this|one)\s+(?:[\w-]+\s+){0,3}$/i.test(before) && /^\s*(of|about|for|showing|that shows|on)\b/i.test(t.slice(m.index + m[0].length - (m[2] ? m[2].length : 0)))) return true;
  }
  return false;
}

/**
 * Whether this reply is in Video Mode, and why: { on, why } where why is 'chat' (the user's choice for this chat),
 * 'enhancer' (the reading says a film) or 'words'. kind: the enhancer's "what is being made", when it gave one.
 * chatMode: the chat's state from the page ('on' after Video Mode ran, 'off' after the user said "not a video").
 */
export function videoModeFor({ settings = {}, chatMode, kind, text, bench = false, root = null }) {
  if (bench || !root || settings.videoMode === 'off') return { on: false };
  if (chatMode === 'off') return { on: false, why: 'chat' };
  if (chatMode === 'on') return { on: true, why: 'chat' };
  if (kind) return kind === 'video' ? { on: true, why: 'enhancer' } : { on: false, why: 'enhancer' };
  return looksLikeFilm(text) ? { on: true, why: 'words' } : { on: false };
}

// ---------- what the agent is told ----------
/**
 * The brief's recommended route, from the setting or the request. cats: the paid tools on in this chat; a route that
 * needs one that is off is not recommended.
 */
export function recommendedRoute(S, text, cats = []) {
  const can = (r) => !['animate', 'hybrid', 'clips'].includes(r) || cats.includes('video');
  if (ROUTE_SKILLS[S.videoRoute] && can(S.videoRoute)) return S.videoRoute;
  const t = String(text || '').toLowerCase();
  if (/\b(my|our|these|this)\s+(?:\w+\s+){0,2}(footage|recordings?|clips|videos)\b/.test(t)) return 'footage';
  if (/\b(app|product|saas|dashboard|data|chart|ui|website|launch|logo|motion|kinetic|typograph\w*)\b/.test(t)) return 'code';
  return cats.includes('video') ? 'animate' : 'images';
}
/** The brief's recommended music: a music model when that tool is on (fitted to the film afterwards), else code. */
export function recommendedMusic(S, cats = []) {
  if (S.videoMusic === 'own') return 'own';
  if (S.videoMusic === 'code' || !cats.includes('music')) return 'code';
  return 'ai';
}
const MUSIC_TEXT = {
  ai: 'music from the music model, instrumental, then fitted to the film (a 30 s clip costs about $0.04, a longer piece about $0.08)',
  code: 'a score written in code (free; keep it simple and keep the bass below the rest)',
  own: 'the user\'s own music',
};

/**
 * The note on the user's message for a Video Mode reply. first: no earlier Video Mode turn in this chat.
 * ask: questions are possible (askLimit > 0); limit: how many; waitS: the YOLO wait; gate: paid media waits for the storyboard.
 */
export function videoRules(S, { first, ask, limit, yolo, waitS, gate, text, cats = [] }) {
  const route = recommendedRoute(S, text, cats), music = recommendedMusic(S, cats);
  const len = Math.max(5, Math.min(600, Number(S.videoLength) || VIDEO_DEFAULTS.videoLength));
  const shapes = SHAPE_TEXT[S.videoShapes] || SHAPE_TEXT.both;
  const viewer = S.videoViewer === true;
  const off = ['video', 'music'].filter((c) => !cats.includes(c));
  const how = ask
    ? `ask_user (up to ${limit} questions in this reply). Mark your recommendation in every question (put it first, recommended: 0)${yolo ? `: in ⚡ YOLO the user has ${waitS ? `${waitS} seconds` : 'no time'} to answer each card, then your recommendations stand` : ''}.`
    : 'no questions: questions are off in this chat, so choose the brief and the story yourself with the recommendations below, and say in your reply what you chose.';
  const deliver = viewer
    ? 'the film files, plus a viewer page (index.html) that plays them, opened with preview_site'
    : 'the film files themselves; open the main film for the user with browser action "open" and target "site:assets/edits/<name>.mp4". Don\'t build a page around it unless the user asks';
  if (!first) {
    return `[Video Mode is on for this chat: the harness reads it as a film. The brief and the story were settled earlier in this chat: don't ask them again unless the user changes direction. Keep the order for what is left: ${gate ? 'an approved storyboard before any paid media (call storyboard again if the shots change), ' : ''}music first and cuts on its bars (music_map, fit_music), moving pictures, render scripts that name their programs (edit them with edit_file), check the real frames, and deliver ${deliver}.]`;
  }
  return `[Video Mode: the harness reads this request as a film, so it loaded the video skills below for you. A film is judged by sound, rhythm and movement before looks. Work in this order; the user sees each step. Questions go through ${how}
1. Brief, once: one ask_user card with questions (up to 4) on what the request leaves open: length and shapes (recommend about ${len} s, ${shapes}); how the picture is made (recommend ${ROUTE_TEXT[route]}, ${ROUTE_COST(route, len)}; offer the cheaper routes with their prices); music (recommend ${MUSIC_TEXT[music]}); the user's own material and real people (theirs first; real people are allowed: ask how to show them, e.g. generated likenesses, licensed photos or the user's own, and credit the photos).${off.length ? ` This chat has ${off.map((c) => (c === 'video' ? 'video clips' : 'music')).join(' and ')} switched off: before the brief, call enable_media for ${off.join(' and ')} (one card where the user switches ${off.length > 1 ? 'them' : 'it'} on and picks the model), then recommend from what is on.` : ''}
2. Story: one ask_user with three different structures, one line each (a journey, a countdown, a before and after…). Your pick first; avoid the obvious cliché.
3. Plan: call plan with the spec (logline, length, shapes, route, music, the real facts it uses) and the items; done_when names the film files and the checks.
4. Storyboard: call storyboard with 6 to 9 key shots (time, framing, camera move, what we see, sound)${gate ? '. The harness refuses paid media until the user approves it' : ''}. Then load the route skill with use_skill (${[...new Set(Object.values(ROUTE_SKILLS).flatMap((v) => v.split(' and ')))].join(', ')}).
5. Paid media: list every paid call in one media_plan (stills, clips, music), then make them.
6. Music first. ${music === 'ai' ? 'compose_music: instrumental, the tempo (e.g. "96 BPM"), the sections in order and "a clean ending"; a music model ignores the exact length, so then' : music === 'own' ? 'Take the user\'s track, then' : 'Write the score (keep 20-150 Hz below the rest; no endless noise beds), then'} call music_map on it (with the tempo you asked for) for its bars, the places it changes and its ending, and fit_music to the film's length (it trims from the front on a bar line so the real ending stays, or plays whole bars again). Re-time the shots to the bar lines: cut on bars and accents, vary shot lengths (1, 2 or 3 bars), and put the key moment on the biggest change.
7. Pictures that move: ${route === 'animate' || route === 'hybrid' ? `make the stills first (they keep people and places consistent), then make_video from each still (start_image) for ${route === 'hybrid' ? 'the 3 or 4 key shots, and camera moves for the rest' : 'every shot'}, as long as its bars.` : route === 'images' ? 'every still gets a clear camera move (push, pan, tilt, parallax) and something moving inside the frame (rain, steam, light, particles); keep shots short.' : 'every shot has movement in it, not only a camera move.'}
8. Build and render: ${route === 'code' ? 'draw the film as a page with window.render(t), window.DUR and window.READY (film-render skill) and render it with render_film, with the fitted music as its audio: QuorX plays it frame by frame in its own browser, so there is no capture script and nothing to approve. Load motion-design for the motion. A film that is mostly type, UI and captions may instead be a HyperFrames project (film-hyperframes skill), once the user approves its install. Other ' : ''}scripts go in .quorx/scratch and call programs by name (execFileSync('ffmpeg', [...]), spawn('node', [...])), so the command checks can read them; change a script with edit_file, never with Get-Content/Set-Content or sed. Finished films go in assets/edits/<name>.mp4, plus the other shapes asked for; master at about -14 LUFS.
9. Check the film, not the plan: make a contact sheet (ffmpeg -vf "fps=1/2,scale=480:-1,tile=4x3" → assets/edits/sheet.jpg) and look at it; fix what fails. The harness measures the rest (length, sound, loudness, bass, cuts against the beat) for the reviewer.
10. Deliver ${deliver}. Say in your reply what was spent and what you assumed.]`;
}

// ---------- the music tools (server/musicmap.js) ----------
export const MUSIC_MAP_TOOL = { type: 'function', function: { name: 'music_map', description: 'Video Mode: map a track in the project: its tempo, bar lines, the places it gets louder or quieter, how it ends, and the best stretches for a part of the film. Use it before timing cuts to the music.', parameters: {
  type: 'object', required: ['path'], properties: {
    path: { type: 'string', description: 'An audio (or video) file in the project' },
    bpm: { type: 'number', description: 'The tempo you asked the music model for; it settles the detector when it lands on a related tempo' },
    seconds: { type: 'number', description: 'Optional: also find the best stretches of about this long' },
    shape: { type: 'string', enum: ['peak', 'build', 'calm', 'ending'], description: 'With seconds: loudest, rising most, quiet and steady, or the track\'s own ending (default peak)' } } } } };
export const FIT_MUSIC_TOOL = { type: 'function', function: { name: 'fit_music', description: 'Video Mode: make a copy of a track that is about `seconds` long, cut on bar lines: shorter by starting later (its own ending stays), longer by playing whole bars from the middle again with short crossfades on the downbeat. Returns the new length and its bar lines.', parameters: {
  type: 'object', required: ['path', 'out', 'seconds'], properties: {
    path: { type: 'string', description: 'The track in the project' },
    out: { type: 'string', description: 'Where to save the fitted copy, e.g. assets/audio/score-35s.mp3' },
    seconds: { type: 'number', description: 'The film\'s length; the result is the nearest length on bar lines' },
    bpm: { type: 'number', description: 'The tempo you asked for, as for music_map' },
    keep_ending: { type: 'boolean', description: 'When shortening: keep the track\'s ending (default true) or end on a bar line' } } } } };

// ---------- rendering a film drawn in code ----------
// QuorX's own browser plays the page frame by frame and ffmpeg encodes it: no capture script for the agent to write,
// and nothing to approve. A motion piece's capture scripts (Edge started from a path in a variable) waited for the user
// about 20 times in one test.
export const RENDER_FILM_TOOL = { type: 'function', function: { name: 'render_film', description: 'Video Mode: render a film drawn in code to an .mp4. The page in the project must define window.render(t) (draw the frame at time t, in seconds; it may return a promise) and set window.READY = true once fonts and images have loaded; window.DUR gives the length. QuorX opens it in its own browser at the film\'s size, calls render for every frame, and encodes it with ffmpeg, with the music if you give it. Free; no command to run.', parameters: {
  type: 'object', required: ['page', 'out'], properties: {
    page: { type: 'string', description: 'The film page in the project, e.g. film/index.html' },
    out: { type: 'string', description: 'Where to save the film, e.g. assets/edits/teaser.mp4' },
    seconds: { type: 'number', description: 'Length; default window.DUR' },
    fps: { type: 'integer', minimum: 12, maximum: 60, description: 'Frames per second (default 30)' },
    aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Shape: 1920×1080, 1080×1920 or 1080×1080 (default 16:9)' },
    audio: { type: 'string', description: 'Optional: the soundtrack in the project (e.g. the fit_music output), cut to the film\'s length' },
    start: { type: 'number', description: 'Optional: start at this time in the page (default 0)' } } } } };
export const RENDER_SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

/** ffmpeg's arguments for frames piped in as JPEGs, with an optional soundtrack cut to the picture. */
export function renderArgs({ fps, seconds, out, audio = '' }) {
  return ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', ...(audio ? ['-i', audio] : []),
    '-map', '0:v', ...(audio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-r', String(fps), '-t', String(seconds), '-movflags', '+faststart', out];
}

// ---------- the storyboard ----------
export const STORYBOARD_TOOL = { type: 'function', function: { name: 'storyboard', description: 'Video Mode: show the storyboard (6 to 9 key shots) in one sheet in the user\'s pane, and wait for them to approve it before paid pictures, clips, music or voice. Call it again with the changed shots when they ask for changes.', parameters: {
  type: 'object', required: ['title', 'shots'], properties: {
    title: { type: 'string', description: 'The film\'s working title' },
    logline: { type: 'string', description: 'One sentence: subject, goal, turn' },
    aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'The main shape (default 16:9)' },
    shots: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'object', required: ['time', 'what'], properties: {
      time: { type: 'string', description: 'When it starts, e.g. 0:03' },
      framing: { type: 'string', description: 'wide, medium, close, insert, title…' },
      move: { type: 'string', description: 'The camera move: push, pull, tilt, pan, hold…' },
      what: { type: 'string', description: 'What we see, in a few words' },
      sound: { type: 'string', description: 'What we hear' } } } },
    sections: { type: 'array', maxItems: 8, description: 'Optional: the film\'s parts in order, for the timeline bar', items: { type: 'object', required: ['name', 'seconds'], properties: { name: { type: 'string' }, seconds: { type: 'number' } } } } } } } };

const TINTS = ['#0b2a4a', '#3a2a06', '#123d2e', '#241a3a', '#3a1010', '#0e3440', '#33240e', '#1d2b10', '#2d1630'];
const BAR = ['#3987e5', '#199e70', '#d95926', '#c98500', '#8a5cd6', '#2fa8b8', '#c2457a', '#6f9a1f'];

/** The cleaned storyboard, or { error }. */
export function normalizeStoryboard(args) {
  const shots = (Array.isArray(args?.shots) ? args.shots : []).map((x) => ({
    time: clip(String(x?.time ?? '').trim(), 12), framing: clip(String(x?.framing ?? '').trim(), 40), move: clip(String(x?.move ?? '').trim(), 40),
    what: clip(String(x?.what ?? '').trim(), 140), sound: clip(String(x?.sound ?? '').trim(), 100),
  })).filter((x) => x.what).slice(0, 12);
  if (shots.length < 3) return { error: 'give at least 3 shots, each with time and what we see (6 to 9 key shots is right for most films).' };
  const sections = (Array.isArray(args?.sections) ? args.sections : []).map((x) => ({ name: clip(String(x?.name ?? '').trim(), 30), seconds: Math.max(0, Number(x?.seconds) || 0) })).filter((x) => x.name && x.seconds).slice(0, 8);
  return { title: clip(String(args?.title || 'Storyboard').trim(), 80) || 'Storyboard', logline: clip(String(args?.logline || '').trim(), 300), aspect: ['16:9', '9:16', '1:1'].includes(args?.aspect) ? args.aspect : '16:9', shots, sections };
}

/** The storyboard sheet as a self-contained page for the artifact pane. */
export function storyboardHtml(sb) {
  const total = sb.sections.reduce((s, x) => s + x.seconds, 0);
  const ratio = sb.aspect.replace(':', '/');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(sb.title)} · storyboard</title>
<style>
:root{--bg:#0b0f0d;--panel:#111815;--line:#273932;--text:#e7edea;--muted:#8fa098;--gold:#f0b429}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f5;--panel:#fff;--line:#d9e0dc;--text:#14201a;--muted:#5b6b63;--gold:#9a6a00}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",system-ui,sans-serif;padding:20px}
h1{font-size:21px;margin:0 0 4px;letter-spacing:-.01em}p.sub{color:var(--muted);margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${sb.aspect === '9:16' ? 150 : 210}px,1fr));gap:12px}
.shot{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.frame{aspect-ratio:${ratio};display:grid;place-items:center;text-align:center;padding:10px;background:linear-gradient(135deg,var(--a),#050a12);color:#fff;font-weight:700;font-size:14px;line-height:1.3}
.meta{padding:8px 10px;display:grid;gap:2px}.t{font:600 11px ui-monospace,Consolas,monospace;color:var(--gold)}.meta span{color:var(--muted);font-size:12px}
.bar{display:flex;height:10px;border-radius:4px;overflow:hidden;margin:16px 0 6px}.legend{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--muted);font-size:12px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
</style></head><body>
<h1>Storyboard · ${esc(sb.title)}</h1>
<p class="sub">${sb.logline ? `${esc(sb.logline)} · ` : ''}${sb.shots.length} key shots, ${esc(sb.aspect)}. Approve it in the chat, or say which shots to change.</p>
<div class="grid">${sb.shots.map((x, i) => `<div class="shot"><div class="frame" style="--a:${TINTS[i % TINTS.length]}">${esc(x.what)}</div><div class="meta"><span class="t">S${i + 1}${x.time ? ` · ${esc(x.time)}` : ''}${x.framing ? ` · ${esc(x.framing)}` : ''}${x.move ? ` · ${esc(x.move)}` : ''}</span>${x.sound ? `<span>🔊 ${esc(x.sound)}</span>` : ''}</div></div>`).join('')}</div>
${total ? `<div class="bar">${sb.sections.map((x, i) => `<i style="display:block;width:${(x.seconds / total * 100).toFixed(2)}%;background:${BAR[i % BAR.length]}"></i>`).join('')}</div><div class="legend">${sb.sections.map((x, i) => `<span><i style="background:${BAR[i % BAR.length]}"></i>${esc(x.name)} · ${x.seconds} s</span>`).join('')}</div>` : ''}
</body></html>`;
}

// The storyboard is kept per chat in .quorx/video/storyboard.json, so a later reply knows it was approved.
const boardFile = (root) => path.join(root, '.quorx', 'video', 'storyboard.json');
export function loadStoryboard(root, chatId) {
  try { const j = JSON.parse(fs.readFileSync(boardFile(root), 'utf8')); return j.chatId === (chatId || null) ? j : null; } catch { return null; }
}
export function saveStoryboard(root, chatId, data) {
  try {
    fs.mkdirSync(path.dirname(boardFile(root)), { recursive: true });
    fs.writeFileSync(boardFile(root), JSON.stringify({ chatId: chatId || null, at: Date.now(), ...data }, null, 2));
  } catch { /* the file is a convenience */ }
}

/**
 * The finished films among the video files a reply wrote ([{ r: project path, t: written at }]), best first. The parts
 * a film is made from (generated clips, a shot, a take) are left out: a 3 s shot "stops abruptly" by nature, and it
 * was reviewed as a film. Films in an edits/final/export folder come first, then the newest.
 */
export function finishedFilms(found) {
  const parts = /(^|\/)(clips?|shots?|takes?|generated|scratch|frames|tmp|temp|raw|parts)\//i;
  // …and copies that are not the film: a silent picture-only cut was reviewed as "no sound".
  const partName = /^(shot|clip|take|part|seg|video_)[\w-]*\.\w+$|[-_.](silent|nosound|no-sound|mute|muted|draft|test|tmp|temp|preview|proxy)\.\w+$/i;
  const finals = /(^|\/)(edits?|final|finals|export|exports|out|output|renders?|films?)\//i;
  return found.filter((x) => !parts.test(x.r) && !partName.test(x.r.split('/').pop()))
    .sort((a, b) => (finals.test(b.r) - finals.test(a.r)) || b.t - a.t).map((x) => x.r);
}

// ---------- the film's facts, for the reviewer ----------
const run = (cmd, args, ms = 60000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 8e6, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
});

/**
 * Measures one film: { rel, seconds, width, height, fps, audio, lufs, peak, black, sheet } (sheet: a contact sheet
 * saved in .quorx/video/, as a project path). null when ffprobe can't read it.
 */
export async function filmFacts(root, rel, { ff = run, music = mapMusic, cuts = cutsOf, bpm = 0 } = {}) {
  const file = path.join(root, rel);
  const p = await ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file], 20000);
  if (!p.ok) return null;
  let j;
  try { j = JSON.parse(p.out); } catch { return null; }
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) return null;
  const [a, b] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  const facts = { rel, seconds: +(Number(j.format?.duration) || 0).toFixed(2), width: v.width || 0, height: v.height || 0, fps: b ? +(a / b).toFixed(2) : 0, audio: (j.streams || []).some((s) => s.codec_type === 'audio'), lufs: null, peak: null, black: 0, sheet: null };
  if (facts.audio) {
    const l = await ff('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], 90000);
    const tail = l.err.slice(l.err.lastIndexOf('Summary:'));
    const I = tail.match(/I:\s+(-?[\d.]+)\s+LUFS/), P = tail.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
    if (I) facts.lufs = Number(I[1]);
    if (P) facts.peak = P[1] === '-inf' ? null : Number(P[1]);
    // The bass against the rest: a mix whose sound below 150 Hz is louder than everything above it rumbles (the
    // "waves" in every code-written score so far).
    const rmsOf = async (flt) => { const r = await ff('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `${flt},astats=metadata=0:measure_overall=RMS_level`, '-f', 'null', '-'], 90000); const m = [...r.err.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].at(-1); return m && m[1] !== '-inf' ? Number(m[1]) : null; };
    const lo = await rmsOf('lowpass=f=150,lowpass=f=150'), hi = await rmsOf('highpass=f=150,highpass=f=150');
    if (lo != null && hi != null) facts.bassDb = +(lo - hi).toFixed(1);
    // The music's beats against the picture's cuts, and whether the sound ends or just stops.
    try {
      // The tempo the music was made at settles the detector, which can land on a related tempo (129 for 96).
      const m = await music(file, { bpm });
      facts.bpm = m.bpm;
      facts.endsClean = m.ending.clean;
      const c = await cuts(file);
      if (c.length >= 3) facts.cuts = cutsVsBeats(c, m.beats);
    } catch { /* the facts above still stand */ }
  }
  // Only truly black frames: at the default threshold (0.10) dark, titled night shots counted as black.
  const bd = await ff('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.03', '-an', '-f', 'null', '-'], 90000);
  facts.black = +[...bd.err.matchAll(/black_duration:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0).toFixed(2);
  // A frame about every 1/12 of the film, nine to twelve frames on one sheet.
  const every = Math.max(0.5, facts.seconds / 12);
  const sheetRel = `.quorx/video/sheet-${path.basename(rel).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-')}.jpg`;
  fs.mkdirSync(path.join(root, '.quorx', 'video'), { recursive: true });
  const sh = await ff('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `fps=1/${every.toFixed(3)},scale=480:-2,tile=4x3`, '-frames:v', '1', path.join(root, sheetRel)], 90000);
  if (sh.ok && fs.existsSync(path.join(root, sheetRel))) facts.sheet = sheetRel;
  return facts;
}

/** The facts as lines, with what is off (no sound, too quiet or loud, long black stretches). */
export function factsText(f) {
  const issues = [];
  if (!f.audio) issues.push('it has no sound track');
  if (f.lufs != null && (f.lufs < -18 || f.lufs > -10)) issues.push(`loudness ${f.lufs} LUFS is far from the usual -14`);
  if (f.peak != null && f.peak > -0.5) issues.push(`peaks at ${f.peak} dBFS (clipping risk)`);
  if (f.seconds && f.black / f.seconds > 0.15) issues.push(`${f.black} s of black frames`);
  if (f.bassDb != null && f.bassDb > 0) issues.push(`the bass (below 150 Hz) is ${f.bassDb} dB louder than everything above it, so it rumbles; keep it about 3 dB below`);
  if (f.cuts && f.cuts.cuts >= 4 && f.cuts.onBeat / f.cuts.cuts < 0.5) issues.push(`only ${f.cuts.onBeat} of ${f.cuts.cuts} cuts land on a beat (within 2 frames)`);
  if (f.endsClean === false) issues.push('the sound stops abruptly at the end instead of ending');
  const music = [f.bassDb != null ? `bass ${f.bassDb > 0 ? '+' : ''}${f.bassDb} dB against the rest` : '', f.bpm ? `${f.bpm} BPM` : '', f.cuts ? `${f.cuts.onBeat} of ${f.cuts.cuts} cuts on the beat` : ''].filter(Boolean).join(', ');
  return `${f.rel}: ${f.seconds} s, ${f.width}×${f.height}${f.fps ? ` at ${f.fps} fps` : ''}, ${f.audio ? `sound${f.lufs != null ? ` at ${f.lufs} LUFS` : ''}${f.peak != null ? `, peak ${f.peak} dBFS` : ''}` : 'no sound'}${f.black ? `, ${f.black} s black` : ''}${music ? `, ${music}` : ''}${issues.length ? `. Off: ${issues.join('; ')}` : ''}`;
}
