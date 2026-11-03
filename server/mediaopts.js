// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Per-call options for the paid media tools (imagine, make_video, compose_music, speak): what each model's OpenRouter
// catalogue entry says it takes, and the request fields a call's options become. An option the model doesn't take is
// left out with a note that says why and what it does take, so a call never fails (or costs) because of one.

const lower = (v) => String(v ?? '').trim().toLowerCase();
/** The catalogue's own spelling of a value (case-insensitive), or null. */
export function offered(values, want) {
  const w = lower(want);
  if (!w || !Array.isArray(values)) return null;
  return values.find((v) => lower(v) === w) ?? null;
}

/**
 * A voice for a speech model: the one asked for when the model has it, else the settings' voice for that model, else
 * the model's first. Returns { voice, note }. A model whose catalogue lists no voices takes any name as it is.
 */
export function pickVoice(spec, want, setting) {
  const list = spec?.voices || [];
  if (want) {
    const hit = list.length ? offered(list, want) : String(want).trim();
    if (hit) return { voice: hit, note: '' };
  }
  const base = (list.length ? offered(list, setting) : setting) || list[0];
  const note = want ? ` ${spec?.id || 'This model'} has no voice "${want}", so it used ${base || 'its default voice'}. Its voices: ${list.join(', ')}.` : '';
  return { voice: base || undefined, note };
}

/** The speed for a speech call: 0.5 to 2 (1 = normal), or undefined. */
export function pickSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n !== 1 ? Math.max(0.5, Math.min(2, n)) : undefined;
}

/** The size of a picture: the one asked for if the model offers it, else the setting (if offered), else its first. */
export function imageSize(spec, want, setting) {
  const p = spec?.params?.resolution;
  if (p?.type !== 'enum') return { res: setting || '1K', note: '' };
  const hit = offered(p.values, want);
  if (hit) return { res: hit, note: '' };
  const base = offered(p.values, setting) || p.values[0];
  return { res: base, note: want ? ` ${spec.id} has no ${want} size, so it used ${base} (it offers ${p.values.join(', ')}).` : '' };
}

/** The resolution of a clip: the one asked for if the model offers it, else the setting (if offered), else its first. */
export function videoSize(spec, want, setting) {
  const list = spec?.resolutions || [];
  if (!list.length) return { res: want || setting || '480p', note: '' };
  const hit = offered(list, want);
  if (hit) return { res: hit, note: '' };
  const base = offered(list, setting) || list[0];
  return { res: base, note: want ? ` ${spec.id} has no ${want}, so it used ${base} (it offers ${list.join(', ')}).` : '' };
}

const seedOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 2 ** 31 - 1 ? n : undefined; };

/**
 * The extra request fields for a picture: output_format, background, quality, seed, output_compression — each only when
 * the model lists it. Returns { body, note } with what was used and what was left out.
 */
export function imageExtras(spec, opts = {}) {
  const P = spec?.params || {}, body = {}, skipped = [];
  for (const k of ['output_format', 'background', 'quality']) {
    if (opts[k] == null || opts[k] === '') continue;
    const hit = P[k]?.type === 'enum' ? offered(P[k].values, opts[k]) : null;
    if (hit) body[k] = hit; else skipped.push(P[k]?.values ? `${k} ${opts[k]} (it offers ${P[k].values.join(', ')})` : k);
  }
  if (opts.seed != null && opts.seed !== '') { const s = seedOf(opts.seed); if (P.seed && s != null) body.seed = s; else skipped.push('seed'); }
  if (opts.output_compression != null && opts.output_compression !== '') {
    const r = P.output_compression, n = Number(opts.output_compression);
    if (r?.type === 'range' && Number.isFinite(n)) body.output_compression = Math.max(r.min, Math.min(r.max, Math.round(n))); else skipped.push('output_compression');
  }
  return { body, note: skipped.length ? ` ${spec?.id || 'The model'} doesn't take ${skipped.join('; ')}, so ${skipped.length > 1 ? 'they were' : 'it was'} left out.` : '' };
}

/** The extra request fields for a clip: seed and generate_audio, each only when the model takes it. */
export function videoExtras(spec, opts = {}) {
  const body = {}, skipped = [];
  if (opts.seed != null && opts.seed !== '') { const s = seedOf(opts.seed); if (spec?.seed && s != null) body.seed = s; else skipped.push('seed'); }
  if (typeof opts.audio === 'boolean') { if (spec?.audio) body.generate_audio = opts.audio; else if (opts.audio) skipped.push('sound (it makes silent clips)'); }
  return { body, note: skipped.length ? ` ${spec?.id || 'The model'} doesn't take ${skipped.join('; ')}, so ${skipped.length > 1 ? 'they were' : 'it was'} left out.` : '' };
}

/** What a model takes per call, in one short line for the agent (tool descriptions and quorx_settings explain). */
export function optionsLine(cat, spec) {
  if (!spec) return '';
  if (cat === 'speech') return spec.voices?.length ? `${spec.id}: voices ${spec.voices.join(', ')}` : `${spec.id}: no voice list (any name it knows)`;
  if (cat === 'image') {
    const P = spec.params || {};
    const parts = [P.resolution?.values && `size ${P.resolution.values.join('/')}`, P.output_format?.values && `format ${P.output_format.values.join('/')}`,
      P.background?.values && `background ${P.background.values.join('/')}`, P.quality?.values && `quality ${P.quality.values.join('/')}`, P.seed && 'seed'].filter(Boolean);
    return `${spec.id}: ${parts.join(', ') || 'no options'}`;
  }
  if (cat === 'video') {
    const parts = [spec.resolutions?.length && `resolution ${spec.resolutions.join('/')}`, spec.durations?.length && `seconds ${spec.durations.join('/')}`,
      spec.aspects?.length && `shapes ${spec.aspects.join('/')}`, spec.seed && 'seed', spec.audio && 'sound on/off'].filter(Boolean);
    return `${spec.id}: ${parts.join(', ') || 'no options'}`;
  }
  if (cat === 'music') return `${spec.id}: ${spec.length || 'a clip'}, seed`;
  return '';
}
