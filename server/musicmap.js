// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Music for films (Video Mode): map a track (tempo, bar lines, how loud each moment is, where it changes, how it ends),
// pick the best stretch for a part of the film, and fit a track to a length on bar lines: trimmed from the front so
// its own ending stays, or lengthened by playing whole bars again with short crossfades on the downbeat.
// Music models make fixed lengths (Lyria Clip about 30 s; Pro ignores the length asked), so the film fits the music
// this way instead of the music being stretched.
import { execFile } from 'node:child_process';

const SR = 11025, HOP = 256, WIN = 1024;
const run = (cmd, args, { buffer = false, ms = 120000 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 1e9, windowsHide: true, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve(stdout)));
});

/** Mono samples at 11 kHz, decoded by ffmpeg (any audio or video file). */
async function samples(file) {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { buffer: true });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/**
 * The onset curve (rises in energy in three bands) and loudness per frame. Pure, for tests.
 * Band split: one-pole filters run over the whole signal, so there are no edges at frame borders.
 */
export function analyse(x, sr = SR) {
  const n = Math.max(0, Math.floor((x.length - WIN) / HOP));
  const aLo = 1 - Math.exp(-2 * Math.PI * 200 / sr), aHi = 1 - Math.exp(-2 * Math.PI * 2000 / sr);
  const lo = new Float32Array(x.length), hi = new Float32Array(x.length);
  let yl = 0, yh = 0;
  for (let i = 0; i < x.length; i++) { yl += aLo * (x[i] - yl); yh += aHi * (x[i] - yh); lo[i] = yl; hi[i] = x[i] - yh; }
  const rms = new Float32Array(n), onset = new Float32Array(n);
  let prev = [0, 0, 0];
  for (let f = 0; f < n; f++) {
    const e = [0, 0, 0]; let s = 0;
    for (let k = f * HOP, end = k + WIN; k < end; k++) { const v = x[k], l = lo[k], h = hi[k], m = v - l - h; e[0] += l * l; e[1] += m * m; e[2] += h * h; s += v * v; }
    rms[f] = Math.sqrt(s / WIN);
    const le = e.map((b) => Math.log1p(1000 * b / WIN));
    onset[f] = le.reduce((a, b, j) => a + Math.max(0, b - prev[j]), 0);
    prev = le;
  }
  // lead: a frame is stamped with the start of its window, but a hit shows up when the window reaches it.
  return { rms, onset, fps: sr / HOP, dur: x.length / sr, lead: WIN / sr };
}

/** Tempo in BPM from the onset curve (autocorrelation, 70-180 BPM), and how strongly it stands out. */
export function tempoOf(onset, fps) {
  const n = onset.length, score = (L) => { let c = 0; for (let i = L; i < n; i++) c += onset[i] * onset[i - L]; return c / Math.max(1, n - L); };
  let best = 0, lag = 0, sum = 0, k = 0;
  for (let L = Math.round(fps * 60 / 180); L <= Math.round(fps * 60 / 70); L++) { const c = score(L); sum += c; k++; if (c > best) { best = c; lag = L; } }
  return { bpm: lag ? 60 * fps / lag : 0, strength: k ? best / (sum / k) : 0 };
}

/**
 * The detected tempo checked against the one the music was asked for. A detector often lands on a related tempo
 * (double, half, 3:4); when the detected one is such a relative of the hint, or far from it, the hint wins.
 * Returns { bpm, source: 'detected' | 'hint', detected }.
 */
export function settleTempo(detected, hint) {
  const h = Number(hint) || 0;
  if (!h || !detected) return { bpm: detected || h, source: detected ? 'detected' : 'hint', detected };
  if (Math.abs(detected - h) / h <= 0.06) return { bpm: detected, source: 'detected', detected };
  return { bpm: h, source: 'hint', detected };
}

/** Bar lines (4 beats) from the onset curve and a tempo: the phase with the most onset energy on the beat. */
export function barsOf({ onset, rms, fps, dur, lead = 0 }, bpm) {
  const lag = fps * 60 / bpm, n = onset.length;
  let phase = 0, top = -1;
  for (let p = 0; p < lag; p += 0.5) { let s = 0; for (let t = p; t < n; t += lag) s += onset[Math.round(t)] || 0; if (s > top) { top = s; phase = p; } }
  let down = 0, dtop = -1;
  for (let b = 0; b < 4; b++) { let s = 0; for (let t = phase + b * lag; t < n; t += 4 * lag) { const i = Math.round(t); s += (onset[i] || 0) + (rms[i] || 0); } if (s > dtop) { dtop = s; down = b; } }
  const beat = 60 / bpm, bar = 4 * beat, first = ((phase + down * lag) / fps + lead) % bar;
  const bars = []; for (let t = first; t < dur - 0.01; t += bar) bars.push(+t.toFixed(3));
  const beats = []; for (let t = first % beat; t < dur - 0.01; t += beat) beats.push(+t.toFixed(3));
  return { beat: +beat.toFixed(4), bar: +bar.toFixed(4), bars, beats };
}

const db = (a) => 20 * Math.log10(a + 1e-9);

/** Loudness per half second (dB), the places it changes a lot (section starts), and whether it ends cleanly. */
export function shapeOf({ rms, fps, dur }) {
  const half = [];
  for (let t = 0; t < dur; t += 0.5) { const a = Math.floor(t * fps), b = Math.min(rms.length, Math.floor((t + 0.5) * fps)); let s = 0; for (let i = a; i < b; i++) s += rms[i] * rms[i]; half.push(+db(Math.sqrt(s / Math.max(1, b - a))).toFixed(1)); }
  const mean = (a, b) => { const v = half.slice(a, b); return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length); };
  // A section starts where the next 4 s differ from the last 4 s by 4 dB or more (one per 4 s at most).
  const changes = [];
  for (let i = 8; i < half.length - 8; i++) { const d = mean(i, i + 8) - mean(i - 8, i); if (Math.abs(d) >= 4 && (!changes.length || i / 2 - changes.at(-1).t >= 4)) changes.push({ t: i / 2, to: d > 0 ? 'louder' : 'quieter', db: +d.toFixed(1) }); }
  const body = mean(0, half.length), tail = half.at(-1) ?? -120;
  return { loud: half, changes, ending: { clean: tail <= body - 18, tailDb: tail, bodyDb: +body.toFixed(1) } };
}

/** Everything about a track: { dur, bpm, tempo: { source, detected }, beat, bar, bars, beats, loud, changes, ending }. */
export async function mapMusic(file, { bpm: hint } = {}) {
  const a = analyse(await samples(file));
  const t = tempoOf(a.onset, a.fps), settled = settleTempo(t.bpm, hint);
  const grid = barsOf(a, settled.bpm);
  return { dur: +a.dur.toFixed(3), bpm: +settled.bpm.toFixed(1), tempo: { source: settled.source, detected: +t.bpm.toFixed(1), strength: +t.strength.toFixed(2) }, ...grid, ...shapeOf(a) };
}

/**
 * The best stretches of about `seconds` (whole bars, starting on a bar line) for a shape: 'peak' (loudest), 'build'
 * (rises most), 'calm' (quiet and steady) or 'ending' (keeps the track's own ending). Top three, best first.
 */
export function pickWindows(map, { seconds, shape = 'peak' }) {
  const nb = Math.max(1, Math.round(seconds / map.bar)), len = nb * map.bar;
  const at = (t) => map.loud[Math.min(map.loud.length - 1, Math.max(0, Math.floor(t * 2)))];
  const mean = (a, b) => { let s = 0, k = 0; for (let t = a; t < b; t += 0.5) { s += at(t); k++; } return s / Math.max(1, k); };
  const spread = (a, b) => { const v = map.loud.slice(Math.floor(a * 2), Math.ceil(b * 2)); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
  const starts = shape === 'ending' ? [map.bars.filter((s) => s <= map.dur - len + 0.05).at(-1) ?? 0] : map.bars.filter((s) => s + len <= map.dur + 0.05);
  const score = (s) => (shape === 'build' ? mean(s + len * 2 / 3, s + len) - mean(s, s + len / 3)
    : shape === 'calm' ? -mean(s, s + len) - spread(s, s + len)
    : shape === 'ending' ? 0 : mean(s, s + len));
  return starts.map((s) => {
    const end = shape === 'ending' ? map.dur : s + len;
    return { start: +s.toFixed(3), end: +end.toFixed(3), seconds: +(end - s).toFixed(2), bars: shape === 'ending' ? +((end - s) / map.bar).toFixed(1) : nb, score: +score(s).toFixed(2) };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * How to bring a track to `seconds` on bar lines. Shorter: start later on a bar line, so the track's own ending stays
 * (or, keepEnding false, end on a bar line). Longer: play the whole bars before a bar line near the middle again.
 * Returns { parts: [[from, to], …] in track seconds, seconds, method }. Pure, for tests.
 */
export function fitPlan(map, seconds, { keepEnding = true } = {}) {
  const want = Math.max(map.bar, Number(seconds) || 0);
  if (Math.abs(want - map.dur) < map.bar / 2) return { parts: [[0, map.dur]], seconds: map.dur, method: 'as is' };
  if (want < map.dur) {
    if (keepEnding) {
      const start = map.bars.reduce((best, s) => (Math.abs(map.dur - s - want) < Math.abs(map.dur - best - want) ? s : best), map.bars[0] ?? 0);
      return { parts: [[start, map.dur]], seconds: +(map.dur - start).toFixed(3), method: `started ${start.toFixed(2)} s in, on a bar line, keeping the ending` };
    }
    const end = map.bars.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), map.bars.at(-1) ?? map.dur);
    return { parts: [[0, end]], seconds: +end.toFixed(3), method: `ended at ${end.toFixed(2)} s, on a bar line` };
  }
  const extra = Math.max(1, Math.round((want - map.dur) / map.bar));
  // The join: the bar line nearest the middle that has enough whole bars before it (after the first bar line).
  const usable = map.bars.filter((b, i) => i >= 1 && b < map.dur - map.bar);
  const mid = usable.reduce((best, b) => (Math.abs(b - map.dur / 2) < Math.abs(best - map.dur / 2) ? b : best), usable[0] ?? map.bars[0] ?? 0);
  const before = Math.max(1, Math.min(extra, map.bars.filter((b) => b < mid - 0.01).length));
  const loop = [+(mid - before * map.bar).toFixed(3), +mid.toFixed(3)];
  const parts = [[0, loop[1]]];
  for (let left = extra; left > 0; left -= before) {
    const take = Math.min(before, left);
    parts.push([+(loop[1] - take * map.bar).toFixed(3), loop[1]]);
  }
  parts.push([loop[1], map.dur]);
  const total = parts.reduce((s, [a, b]) => s + (b - a), 0);
  return { parts, seconds: +total.toFixed(3), method: `played ${extra} bar${extra > 1 ? 's' : ''} (${loop[0].toFixed(2)}-${loop[1].toFixed(2)} s) again at ${loop[1].toFixed(2)} s, joined on the downbeat` };
}

/** Writes the fitted track (any audio extension ffmpeg knows). 25 ms crossfades at every join. */
export async function writeFit(file, out, plan) {
  const XF = 0.025;
  if (plan.parts.length === 1) {
    const [a, b] = plan.parts[0];
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-af', `atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,afade=t=in:d=0.01`, out]);
    return;
  }
  const chains = plan.parts.map(([a, b], i) => `[0:a]atrim=start=${a}:end=${b + (i < plan.parts.length - 1 ? XF : 0)},asetpts=PTS-STARTPTS[p${i}]`);
  let last = 'p0';
  for (let i = 1; i < plan.parts.length; i++) { chains.push(`[${last}][p${i}]acrossfade=d=${XF}:c1=tri:c2=tri[x${i}]`); last = `x${i}`; }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-filter_complex', chains.join(';'), '-map', `[${last}]`, out]);
}

/**
 * Scene cuts in a film (ffmpeg's scene score), in seconds. 0.15: at 0.3 cuts between dark, similar shots were missed
 * (0 of 8 in a test film); at 0.15 the Mumbai film's 7 cuts were all found.
 */
export async function cutsOf(file, threshold = 0.15) {
  const out = await new Promise((resolve) => execFile('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { timeout: 180000, maxBuffer: 1e8, windowsHide: true }, (e, so, se) => resolve(String(se || ''))));
  return [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => +Number(m[1]).toFixed(3));
}

/** How cuts sit against beats: { cuts, onBeat (within 2 frames at 25 fps), worst } with offsets in seconds. */
export function cutsVsBeats(cuts, beats, tol = 0.08) {
  if (!cuts.length || !beats.length) return { cuts: cuts.length, onBeat: 0, offsets: [] };
  const offsets = cuts.map((c) => beats.reduce((m, b) => Math.min(m, Math.abs(b - c)), Infinity));
  return { cuts: cuts.length, onBeat: offsets.filter((o) => o <= tol).length, offsets: offsets.map((o) => +o.toFixed(3)), worst: +Math.max(...offsets).toFixed(3) };
}
