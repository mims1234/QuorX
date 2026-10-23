// Video Mode: a request for a film gets a director's workflow instead of being treated like any other build.
// The harness notices the film (the prompt enhancer's "kind", or plain words when there is no reading), loads the
// video skills itself, and has the agent take a brief, pick a story and show a storyboard before anything is spent.
// The storyboard is a card the user approves; paid media waits for it. Before the final reply the reviewer gets the
// film's measured facts and a contact sheet, so it scores the film and not only the page around it.
// Everything here is off for a request that is not a film: none of it reaches the agent, its tools or its limits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ⚙ Settings → Video. Merged into the agent's DEFAULTS, so the page gets them with the rest.
export const VIDEO_DEFAULTS = {
  videoMode: 'auto',        // 'auto' = a film request turns Video Mode on · 'off' = never
  videoAskLimit: 8,         // questions a reply in Video Mode may ask (the brief, the story, a storyboard change); the usual limit when that is higher, and none when questions are off
  videoWaitSecs: 120,       // ⚡ YOLO: the brief, story and storyboard cards wait this long for the user, then go with the agent's recommendations (0 = at once)
  videoStoryboard: true,    // paid pictures, clips, music and voice wait until the user approves a storyboard
  videoRoute: 'auto',       // the route the brief recommends: 'auto' (by subject) · 'images' · 'code' · 'clips' · 'footage'
  videoLength: 30,          // seconds the brief recommends
  videoShapes: 'both',      // shapes the brief recommends: '16:9' · '9:16' · '1:1' · 'both' (16:9 and a 9:16 cut)
  videoReview: true,        // the reviewer gets each new film's facts (length, size, sound, loudness) and a contact sheet
};

// Loaded into every Video Mode reply. The route skill follows from the brief, so the agent loads that one.
export const VIDEO_SKILLS = ['video-direction', 'film-sound', 'film-review'];
export const ROUTE_SKILLS = { images: 'film-from-images', code: 'film-render', clips: 'film-from-ai-clips', footage: 'film-from-footage' };
const ROUTE_TEXT = {
  images: 'stills with camera moves (generated pictures, or the user\'s photos)',
  code: 'drawn in code (free, every frame exact)',
  clips: 'AI video clips (the most expensive route)',
  footage: 'cut from the user\'s own footage',
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
/** The brief's recommended route, from the setting or the request. */
export function recommendedRoute(S, text) {
  if (ROUTE_SKILLS[S.videoRoute]) return S.videoRoute;
  const t = String(text || '').toLowerCase();
  if (/\b(my|our|these|this)\s+(?:\w+\s+){0,2}(footage|recordings?|clips|videos)\b/.test(t)) return 'footage';
  if (/\b(app|product|saas|dashboard|data|chart|ui|website|launch|logo|motion|kinetic|typograph\w*)\b/.test(t)) return 'code';
  return 'images';
}

/**
 * The note on the user's message for a Video Mode reply. first: no earlier Video Mode turn in this chat.
 * ask: questions are possible (askLimit > 0); limit: how many; waitS: the YOLO wait; gate: paid media waits for the storyboard.
 */
export function videoRules(S, { first, ask, limit, yolo, waitS, gate, text, cats = [] }) {
  const route = recommendedRoute(S, text);
  const len = Math.max(5, Math.min(600, Number(S.videoLength) || VIDEO_DEFAULTS.videoLength));
  const shapes = SHAPE_TEXT[S.videoShapes] || SHAPE_TEXT.both;
  const paid = cats.length ? `paid ${cats.map((c) => ({ image: 'pictures', video: 'clips', music: 'music', speech: 'voice' }[c] || c)).join(', ')}` : '';
  const how = ask
    ? `ask_user (up to ${limit} questions in this reply). Mark your recommendation in every question (put it first, recommended: 0)${yolo ? `: in ⚡ YOLO the user has ${waitS ? `${waitS} seconds` : 'no time'} to answer each card, then your recommendations stand` : ''}.`
    : 'no questions: questions are off in this chat, so choose the brief and the story yourself with the recommendations below, and say in your reply what you chose.';
  if (!first) {
    return `[Video Mode is on for this chat: the harness reads it as a film. The brief and the story were settled earlier in this chat: don't ask them again unless the user changes direction. Keep the order for what is left: ${gate ? 'an approved storyboard before any paid media (call storyboard again if the shots change), ' : ''}render scripts that name their programs, check the real frames, and keep the viewer page up to date.]`;
  }
  return `[Video Mode: the harness reads this request as a film, so it loaded the video skills below for you. Work in this order; the user sees each step. Questions go through ${how}
1. Brief, once: one ask_user card with questions (up to 4) on what the request leaves open: length and shapes (recommend about ${len} s, ${shapes}); how the picture is made (recommend ${ROUTE_TEXT[route]}); the user's own material and real people (theirs first; real people are allowed: ask how to show them, e.g. generated likenesses, licensed photos or the user's own, and credit the photos); sound (recommend an original score made in code and no voice, unless the request implies speech).
2. Story: one ask_user with three different structures, one line each (a journey, a countdown, a before and after…). Your pick first; avoid the obvious cliché.
3. Plan: call plan with the spec (logline, length, shapes, route, sound, the real facts it uses) and the items; done_when names the film files and the checks.
4. Storyboard: call storyboard with 6 to 9 key shots (time, framing, camera move, what we see, sound) before any ${paid || 'rendering'}${gate ? '. The harness refuses paid media until the user approves it' : ''}. Then load the route skill with use_skill (${Object.values(ROUTE_SKILLS).join(', ')}).
5. ${cats.length ? 'Paid media: list every paid call in one media_plan, then make them.' : 'No paid media is switched on in this chat: use the free routes (code, the user\'s pictures or footage).'}
6. Build and render: scripts go in .quorx/scratch and call programs by name (execFileSync('ffmpeg', [...]), spawn('node', [...])), so the command checks can read them. Finished films go in assets/edits/<name>.mp4, plus the other shapes asked for.
7. Check the film, not the plan: ffprobe it (length, size, sound), make a contact sheet (ffmpeg -vf "fps=1/2,scale=480:-1,tile=4x3" → assets/edits/sheet.jpg) and look at it; fix what fails.
8. Deliver: a viewer page (index.html) that plays each film with controls and shows the contact sheet; open it with preview_site. Say in your reply what was spent and what you assumed.]`;
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

// ---------- the film's facts, for the reviewer ----------
const run = (cmd, args, ms = 60000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 8e6, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
});

/**
 * Measures one film: { rel, seconds, width, height, fps, audio, lufs, peak, black, sheet } (sheet: a contact sheet
 * saved in .quorx/video/, as a project path). null when ffprobe can't read it.
 */
export async function filmFacts(root, rel, { ff = run } = {}) {
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
  return `${f.rel}: ${f.seconds} s, ${f.width}×${f.height}${f.fps ? ` at ${f.fps} fps` : ''}, ${f.audio ? `sound${f.lufs != null ? ` at ${f.lufs} LUFS` : ''}${f.peak != null ? `, peak ${f.peak} dBFS` : ''}` : 'no sound'}${f.black ? `, ${f.black} s black` : ''}${issues.length ? `. Off: ${issues.join('; ')}` : ''}`;
}
