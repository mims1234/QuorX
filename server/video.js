// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Video helpers: the make_video request body (with a picture as the first frame), and edit_video, which joins
// clips and stills, a voice-over and music into one finished file with ffmpeg. For edit_video this file only builds
// the command line and the filter graph; the agent runs the line through the same command policy and approval as
// any shell command, so nothing here bypasses the rules.
// The filter graph goes into a file (-/filter_complex, or -filter_complex_script before ffmpeg 7) because shell
// lines may not carry the brackets and semicolons a filter graph needs.
const VIDEO = /\.(mp4|mov|webm|mkv|m4v|avi)$/i, IMAGE = /\.(png|jpe?g|webp|bmp)$/i, AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
export const EDIT_SIZES = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080], '4:3': [960, 720], '3:4': [720, 960] };
const FPS = 30;
// Characters a quoted path can't carry safely in PowerShell, cmd and POSIX shells alike.
const UNSAFE = /["`$%!\r\n]/;
const q = (p) => `"${p}"`;

/**
 * clips: [{ path, seconds? }] in order (videos, or stills that show for `seconds`, default 3; a video with `seconds`
 * is cut to that length). voice, music: project paths or empty. musicVolume: 0-1 (music under a voice). aspect: a
 * key of EDIT_SIZES. out: the output path. filterFile: where the filter graph is written. ffmpegMajor: the installed
 * version, for the filter-file flag. Returns { line, filter, width, height } or { error }.
 */
export function editCommand({ clips, voice = '', music = '', musicVolume = 0.25, aspect = '16:9', out, filterFile, ffmpegMajor = 7 }) {
  const list = (Array.isArray(clips) ? clips : []).map((c) => (typeof c === 'string' ? { path: c } : c || {}));
  if (!list.length) return { error: 'give clips: the videos and pictures to join, in order.' };
  if (list.length > 40) return { error: 'at most 40 clips in one edit.' };
  for (const p of [...list.map((c) => c.path), voice, music, out, filterFile].filter(Boolean)) if (UNSAFE.test(String(p))) return { error: `the path ${p} has a character an edit can't pass safely (" \` $ % !); rename the file first.` };
  for (const [i, c] of list.entries()) {
    if (!c.path || !(VIDEO.test(c.path) || IMAGE.test(c.path))) return { error: `clip ${i + 1} (${c.path || 'no path'}) is not a video or a picture.` };
  }
  if (voice && !AUDIO.test(voice)) return { error: `voice (${voice}) is not an audio file.` };
  if (music && !AUDIO.test(music)) return { error: `music (${music}) is not an audio file.` };
  if (!/\.mp4$/i.test(String(out || ''))) return { error: 'out must be an .mp4 path in the project.' };
  const [w, h] = EDIT_SIZES[aspect] || EDIT_SIZES['16:9'];
  const vol = Math.max(0, Math.min(1, Number(musicVolume) || 0.25));
  const inputs = [], graph = [];
  list.forEach((c, i) => {
    const secs = Number(c.seconds) > 0 ? Math.max(0.5, Math.min(60, Number(c.seconds))) : 0;
    if (IMAGE.test(c.path)) inputs.push(`-loop 1 -framerate ${FPS} -t ${secs || 3} -i ${q(c.path)}`);
    else inputs.push(`${secs ? `-t ${secs} ` : ''}-i ${q(c.path)}`);
    graph.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
  });
  graph.push(`${list.map((_, i) => `[v${i}]`).join('')}concat=n=${list.length}:v=1:a=0[vout]`);
  // The clips' own sound is left out (many have none, and concat needs the same streams in every part).
  // A voice is padded with silence and music loops, so the sound runs to the end of the picture; -shortest stops there.
  let n = list.length, audio = false;
  const vi = voice ? n++ : -1, mi = music ? n++ : -1;
  if (voice) inputs.push(`-i ${q(voice)}`);
  if (music) inputs.push(`-stream_loop -1 -i ${q(music)}`);
  if (voice && music) { graph.push(`[${vi}:a]apad[vo]`, `[${mi}:a]volume=${vol}[mu]`, '[vo][mu]amix=inputs=2:duration=first:normalize=0[aout]'); audio = true; }
  else if (voice) { graph.push(`[${vi}:a]apad[aout]`); audio = true; }
  else if (music) { graph.push(`[${mi}:a]volume=${vol}[aout]`); audio = true; }
  const filterFlag = ffmpegMajor >= 7 ? '-/filter_complex' : '-filter_complex_script';
  const line = ['ffmpeg -hide_banner -loglevel error -y', ...inputs, `${filterFlag} ${q(filterFile)}`, `-map "[vout]"`, ...(audio ? ['-map "[aout]"', '-c:a aac -b:a 192k -shortest'] : ['-an']),
    `-c:v libx264 -preset veryfast -crf 20 -r ${FPS} -movflags +faststart`, q(out)].join(' ');
  return { line, filter: `${graph.join(';\n')}\n`, width: w, height: h };
}

/** The ffmpeg major version from a version string such as "9.0.2-full_build" or "n7.1". 0 when unknown. */
export const ffmpegMajor = (v) => Number(String(v || '').match(/(\d+)\./)?.[1]) || 0;

// ---------- make_video: the request body ----------
/** Whether a video model (from videoModels()) can start from a picture: its catalogue lists a first-frame input. */
export const canStartFromImage = (spec) => (spec?.frames || []).includes('first_frame');

/**
 * The body for POST /api/v1/videos. spec: the model's catalogue entry (or nothing). aspect: the shape asked for (the
 * model's nearest offered one is used; 16:9 when none was asked and it is offered). firstFrame: a data or https URL
 * of the picture to start from. Returns { body, note } or { error }.
 */
export function videoBody({ model, prompt, secs, res, spec, aspect, firstFrame }) {
  const body = { model, prompt: String(prompt || ''), duration: secs, resolution: res };
  const offered = (spec?.aspects || []).filter((v) => /^\d+:\d+$/.test(v));
  let note = '';
  const want = /^\d+:\d+$/.test(String(aspect || '')) ? aspect : '16:9';
  if (!offered.length || offered.includes(want)) body.aspect_ratio = want;
  else if (aspect) {
    const num = (v) => { const [w, h] = v.split(':').map(Number); return w / h; };
    body.aspect_ratio = offered.reduce((a, b) => (Math.abs(Math.log(num(b) / num(want))) < Math.abs(Math.log(num(a) / num(want))) ? b : a));
    note = ` ${model} has no ${want}, so it used the nearest shape, ${body.aspect_ratio}.`;
  }
  if (firstFrame) {
    if (!canStartFromImage(spec)) return { error: `${model} can't start from a picture (its catalogue lists no first-frame input)` };
    body.frame_images = [{ type: 'image_url', image_url: { url: firstFrame }, frame_type: 'first_frame' }];
  }
  return { body, note };
}
