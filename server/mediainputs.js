// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What the paid media tools can be given besides a prompt, model by model, from OpenRouter's catalogues:
//   - imagine: reference pictures (input_references, image-to-image and edits), up to the model's own count;
//   - make_video: a start picture and an end picture (frame_images, first_frame / last_frame), and reference pictures
//     for the look (input_references);
//   - speak: a recording of a voice to speak in (voice cloning, input_references with input_audio), and its transcript.
// Music (Lyria) takes text only: OpenRouter documents no picture or sound input for it.

/** The most reference pictures an image model takes (0: none), from its catalogue entry's supported_parameters. */
export const imageRefMax = (spec) => {
  const r = spec?.params?.input_references;
  return r && Number(r.max) > 0 ? Math.min(16, Math.floor(Number(r.max))) : 0;
};
/** Which frames a video model can be given: 'first_frame', 'last_frame'. */
export const videoFrames = (spec) => (Array.isArray(spec?.frames) ? spec.frames : []);
/** The voice-cloning flags of a speech model's endpoints (any endpoint that takes it counts). */
export const voiceClone = (endpoints) => {
  const list = Array.isArray(endpoints) ? endpoints : [];
  const can = list.filter((e) => e?.supports_voice_cloning);
  return can.length ? { multi: can.some((e) => e.supports_multiple_audio_references), image: can.some((e) => e.supports_image_reference) } : null;
};

/**
 * For the models in use (T[kind].models), what each takes: { imageRefs: { id: max }, videoStart: [id], videoEnd: [id],
 * voiceClone: { id: { multi, image } } }. lists: { images(), videos(), speechEndpoints(id) }, each async.
 */
export async function mediaInputs(cats, T, lists) {
  const out = { imageRefs: {}, videoStart: [], videoEnd: [], voiceClone: {}, videoSettings: {}, videoRefMedia: [], musicEdit: [] };
  if (cats.includes('image')) {
    for (const m of await lists.images().catch(() => [])) if (T.image?.models?.includes(m.id) && imageRefMax(m)) out.imageRefs[m.id] = imageRefMax(m);
  }
  if (cats.includes('video')) {
    for (const m of await lists.videos().catch(() => [])) {
      if (!T.video?.models?.includes(m.id)) continue;
      if (videoFrames(m).includes('first_frame')) out.videoStart.push(m.id);
      if (videoFrames(m).includes('last_frame')) out.videoEnd.push(m.id);
      if (m.passthrough?.length) out.videoSettings[m.id] = m.passthrough;
      if (m.refMedia?.length) out.videoRefMedia.push(m.id);
    }
  }
  if (cats.includes('music') && lists.music) {
    for (const m of await lists.music().catch(() => [])) if (T.music?.models?.includes(m.id) && m.edits) out.musicEdit.push(m.id);
  }
  if (cats.includes('speech')) {
    for (const id of T.speech?.models || []) {
      const v = voiceClone(await lists.speechEndpoints(id).catch(() => []));
      if (v) out.voiceClone[id] = v;
    }
  }
  return out;
}

// Sound files a voice sample may be: the ones OpenRouter's speech providers read.
export const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
export const VOICE_SAMPLE_MAX = 15 * 1024 * 1024; // OpenRouter's cap on a decoded sample

/** The input_references for a speech call: 1-3 recordings (data URLs) and, when known, what they say. */
export function speechRefs(samples, transcript, { multi = false } = {}) {
  const list = samples.slice(0, multi ? 3 : 1).map((data) => ({ type: 'input_audio', input_audio: { data } }));
  if (transcript && String(transcript).trim()) list.push({ type: 'text', text: String(transcript).trim().slice(0, 10000) });
  return list;
}
/** input_references for pictures (image or video calls): data or https URLs. */
export const pictureRefs = (urls) => urls.map((url) => ({ type: 'image_url', image_url: { url } }));

// Video files a reference clip may be (ToAPIs takes MP4, WebM and MOV, up to 50 MB).
export const VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
export const REF_VIDEO_MAX = 50 * 1024 * 1024;

/**
 * A video model's provider settings (its catalogue's allowed_passthrough_parameters) as OpenRouter's request field:
 * provider.options.<endpoint tag>, nested under `parameters` for Google's Veo (google-vertex), as the docs show.
 * Returns { provider, note }: settings the model doesn't list are left out, and the note says which.
 */
export function passthroughBody(opts, allowed, tags) {
  const want = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const ok = {}, skipped = [];
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined || v === null || v === '') continue;
    const hit = (allowed || []).find((a) => a.toLowerCase() === k.toLowerCase());
    if (hit) ok[hit] = v; else skipped.push(k);
  }
  const note = skipped.length ? ` The model doesn't take ${skipped.join(', ')}${allowed?.length ? ` (it takes ${allowed.join(', ')})` : ''}, so ${skipped.length > 1 ? 'they were' : 'it was'} left out.` : '';
  const list = [...new Set((tags || []).filter(Boolean))];
  if (!Object.keys(ok).length || !list.length) return { provider: null, note: note || (Object.keys(ok).length ? ' Its provider settings were left out: QuorX could not tell which provider runs it.' : '') };
  return { provider: { options: Object.fromEntries(list.map((t) => [t, t === 'google-vertex' ? { parameters: ok } : ok])) }, note };
}
