// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ToAPIs' pictures, videos and music, with the key saved for it in ⚙ Settings → Providers (its chat models run as a
// maker's API source: directapi.js). Every job is a task: submit, poll until it finishes, download what it made.
//   - Model ids are `toapis-api/<model>`, so the media tools (agent.js) and mediacat.js know where a call goes.
//   - Its lists come from GET /v1/models?type=image|video|audio with the key. They name no prices or options, so a
//     job is estimated like any model without a price, and the bill is what the finished task reports (cost_usd).
//   - Each model family takes its own fields (docs.toapis.com/docs/en/api-reference): a shape goes as `size` for most
//     pictures and `aspect_ratio` for Grok's; a clip's first frame goes as image_urls, image_with_roles or image.
//     Fields a family doesn't document are left out, so the model's own defaults apply.
//   - Its jobs take pictures by URL only (no data URLs): a start picture is uploaded first (/v1/uploads/images).
//   - Music is Suno: a description in, two songs out; the first is kept.

export const TOAPIS_ID = 'toapis-api';
const PREFIX = `${TOAPIS_ID}/`;
export const isToapisModel = (id) => String(id || '').startsWith(PREFIX);
const bare = (id) => String(id || '').slice(PREFIX.length);

// ---------- requests ----------
async function call(url, { key, method = 'GET', body, form, signal, ms = 60000 } = {}) {
  if (!key) throw Object.assign(new Error('Add your ToAPIs key first (⚙ Settings → Providers → ToAPIs).'), { kind: 'auth' });
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const r = await fetch(url, { method, signal: sig, headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'QuorX', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : form });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  if (!r.ok || j?.success === false || (j?.error && !j?.status)) {
    const e = j?.error && typeof j.error === 'object' ? j.error : {};
    const msg = String(e.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || (/^\s*</.test(t) ? '' : t.slice(0, 300)) || `HTTP ${r.status}`).slice(0, 400);
    const kind = r.status === 401 || r.status === 403 ? 'auth' : r.status === 402 ? 'quota' : r.status === 429 ? 'rate' : undefined;
    throw Object.assign(new Error(`ToAPIs: ${msg}`), { status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0, ...(kind ? { kind } : {}) });
  }
  return j ?? {};
}
const wait = (ms, signal) => new Promise((ok, no) => {
  const k = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(k); no(new Error('aborted')); }, { once: true });
});
/** Polls a task until it is completed or failed; onStatus gets each status. */
// Tests poll faster (QX_TOAPIS_POLL_MS).
const POLL_MS = Number(process.env.QX_TOAPIS_POLL_MS) || 0;
async function untilDone(url, { key, signal, every: ms, limit, what, onStatus }) {
  const t = Date.now(), every = POLL_MS || ms;
  for (;;) {
    if (Date.now() - t > limit) throw new Error(`${what} timed out after ${Math.round(limit / 60000)} minutes`);
    await wait(every, signal);
    let st;
    try { st = await call(url, { key, signal, ms: 30000 }); } catch (e) {
      if (e.status === 429 || e.status >= 500 || e.name === 'TimeoutError') { await wait(Math.max(every, (e.retryAfter || 0) * 1000), signal); continue; }
      throw e;
    }
    onStatus?.(st.status, Date.now() - t, st.progress);
    if (st.status === 'completed' || st.status === 'succeeded') return st;
    if (st.status === 'failed' || st.status === 'cancelled') throw new Error(`ToAPIs: ${st.error?.message || st.error || `${what} failed`}`);
  }
}
/** A file a task made, as a data URL (its links expire, so it is kept now). */
async function download(url, signal, fallback) {
  let r = await fetch(url, { signal }).catch(() => null);
  if ((!r || !r.ok) && fallback) r = await fetch(fallback, { signal }).catch(() => null);
  if (!r || !r.ok) throw new Error(`ToAPIs: download failed${r ? `: HTTP ${r.status}` : ''}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime: String(r.headers.get('content-type') || '').split(';')[0] };
}
const asDataUrl = ({ buf, mime }, guess) => `data:${/^(image|video|audio)\//.test(mime) ? mime : guess};base64,${buf.toString('base64')}`;
/** What the task says it cost, in dollars, or undefined while it isn't settled. */
const billed = (st) => {
  const c = st?.billing?.status === 'settled' ? Number(st.billing.cost_usd) : Number(st?.cost);
  return Number.isFinite(c) && c >= 0 && c < 100 ? c : undefined;
};

// ---------- model lists ----------
const lists = new Map(); // `${type}|${base}|${key tail}` → { at, p }
export function clearToapisLists() { lists.clear(); priceLists.clear(); }
async function listOf(type, { key, base }) {
  const k = `${type}|${base}|${String(key).slice(-6)}`;
  const c = lists.get(k);
  if (c && Date.now() - c.at < 3600e3) return c.p;
  const p = call(`${base}/models?type=${type}`, { key, ms: 20000 }).then((j) => (Array.isArray(j?.data) ? j.data : []).filter((m) => /^[\w.:@+-]{1,120}$/.test(String(m?.id || ''))));
  lists.set(k, { at: Date.now(), p });
  p.catch(() => lists.delete(k));
  return p;
}
// ---------- prices ----------
// Its public price list (GET <site>/api/pricing, the feed its pricing page reads; no key) names every model's billing:
//   quota_type 0: per token. model_ratio 1 = $2 per M input tokens; output = input × completion_ratio; cache reads
//                 × cache_ratio, cache writes × create_cache_ratio. Seedance's video tokens are priced the same way.
//   quota_type 1: model_price dollars per call (a picture, a clip, a song).
//   quota_type 2: model_price dollars per second of video.
// Every figure is multiplied by the default group's ratio (1 today). A missing or absurd figure stays unknown.
const priceLists = new Map(); // site → { at, p }
export function priceSite(base) { try { return new URL(base).origin; } catch { return 'https://toapis.com'; } }
/** model id → its price record, from the public list (an empty map when it can't be read). Kept an hour. */
export function toapisPrices(base, fetchFn = fetch) {
  const site = priceSite(base);
  const c = priceLists.get(site);
  if (c && Date.now() - c.at < 3600e3) return c.p;
  const p = fetchFn(`${site}/api/pricing`, { headers: { 'User-Agent': 'QuorX' }, signal: AbortSignal.timeout(20000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => readPrices(j)).catch(() => new Map());
  priceLists.set(site, { at: Date.now(), p });
  p.then((m) => { if (!m.size) priceLists.delete(site); });
  return p;
}
const num = (x, max) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= max ? Number(x) : null);
/** The public list as model id → { kind, per: 'token'|'call'|'second', in, out, cacheRead, cacheWrite, usd, created }. */
export function readPrices(j) {
  const out = new Map();
  const group = num(j?.group_ratio?.[j?.auto_groups?.[0] || 'default'], 100) ?? 1;
  for (const m of Array.isArray(j?.data) ? j.data : []) {
    const id = String(m?.model_name || '');
    if (!/^[\w.:@+-]{1,120}$/.test(id)) continue;
    const created = Number(m.created_time) > 1e9 ? Number(m.created_time) : 0;
    const rec = { kind: { 1: 'chat', 2: 'image', 3: 'video', 4: 'music' }[m.model_type] || '', created };
    if (m.quota_type === 0) {
      const input = num(m.model_ratio, 500) === null ? null : m.model_ratio * 2 * group;
      if (input === null || input > 1000) continue;
      const times = (r) => (num(r, 100) === null ? null : input * Number(r));
      Object.assign(rec, { per: 'token', in: input, out: times(m.completion_ratio ?? 1) ?? input, cacheRead: times(m.cache_ratio), cacheWrite: times(m.create_cache_ratio) });
    } else if (m.quota_type === 1 || m.quota_type === 2) {
      const usd = num(m.model_price, m.quota_type === 1 ? 50 : 10);
      if (!usd) continue;
      Object.assign(rec, { per: m.quota_type === 1 ? 'call' : 'second', usd: usd * group });
    } else continue;
    out.set(id, rec);
  }
  return out;
}
/** A chat model's cost in models.dev's shape (directapi.js saneCost reads it), or null when the list has none. */
export function chatCost(rec) {
  if (rec?.per !== 'token') return null;
  return { input: rec.in, output: rec.out, ...(rec.cacheRead != null ? { cache_read: rec.cacheRead } : {}), ...(rec.cacheWrite != null ? { cache_write: rec.cacheWrite } : {}) };
}
// The date its model list gives a model it has no date for (2021-07-20), which would show as years old.
const DEFAULT_CREATED = 1626777600;
export const createdOf = (live, rec) => rec?.created || (Number(live?.created) > 1e9 && Number(live.created) !== DEFAULT_CREATED ? Number(live.created) : 0);

// seedream-5-0-pro → Seedream 5.0 Pro (a version's parts joined by a dot, not a space).
const nice = (id) => String(id).replace(/(\d)-(?=\d)/g, '$1.').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const owner = (m) => (typeof m.owned_by === 'string' && m.owned_by ? ` · ${m.owned_by}` : '');
const fromToapis = { source: TOAPIS_ID, created: 0, ctx: null, price: [0, 0] };
const known = (ok) => (ok ? {} : { priceUnknown: true });

// What each picture family takes (docs.toapis.com, per model page), in the shape of OpenRouter's supported_parameters
// so imagine's options and references work the same way: refs = reference pictures (image_urls), res = the sizes and
// where they go (resolution, or metadata.resolution), quality and background where documented.
export function imageFamily(model) {
  const m = isToapisModel(model) ? bare(model) : String(model || '');
  if (/^gpt-image/i.test(m)) return { refs: 10, res: { values: ['1k', '2k', '4k'], at: 'resolution' }, background: ['transparent', 'opaque'] };
  if (/^gemini-.*image/i.test(m)) return { refs: 6, res: { values: ['0.5K', '1K', '2K', '4K'], at: 'metadata' } };
  if (/^(doubao-)?seedream-5/i.test(m)) return { refs: 10, res: { values: ['2K', '3K'], at: 'metadata' } };
  if (/^grok-image-2/i.test(m)) return { refs: 5, quality: ['low', 'medium'] };
  if (/^grok-image/i.test(m)) return { refs: 5 };
  // Other families take image_urls too (the common field); how many isn't documented, so a few.
  return { refs: 4 };
}
const familyParams = (f) => ({
  input_references: { type: 'range', min: 0, max: f.refs },
  ...(f.res ? { resolution: { type: 'enum', values: f.res.values } } : {}),
  ...(f.quality ? { quality: { type: 'enum', values: f.quality } } : {}),
  ...(f.background ? { background: { type: 'enum', values: f.background } } : {}),
});

/** Its picture models, in the shape of OpenRouter's image catalogue (openrouter.js imageModels), with its prices. */
export async function toapisImageModels(opts) {
  const [list, prices] = await Promise.all([listOf('image', opts), toapisPrices(opts.base)]);
  return list.map((m) => {
    const p = prices.get(m.id);
    // Per picture, or per token (the -official GPT and Gemini ones): price[1] is $ per M output tokens, as on OpenRouter.
    const perImage = p?.per === 'call' ? p.usd : null, price = p?.per === 'token' ? [p.in, p.out] : [0, 0];
    return {
      ...fromToapis, id: PREFIX + m.id, name: nice(m.id), kind: 'image', created: createdOf(m, p), price, perImage, ...known(perImage || price[1]),
      in: ['text', 'image'], out: ['image'], params: familyParams(imageFamily(m.id)), desc: `Pictures on ToAPIs${owner(m)}. Billed by ToAPIs ${perImage ? 'per picture' : 'per token'}.`,
    };
  });
}
// Families whose clips start from a picture, and how they take it. The -ext Seedance models take reference pictures only.
const NO_FRAME = /^seedance-2(-fast)?-ext$|^seedance-2[.-]5-ext$/i;
// Families that can also end on a picture, and those that take a seed (each family's docs page).
const LAST_FRAME = /^(seedance-2(-fast|-mini)?$|kling-v3$|veo3\.1-(fast|lite)$|viduq3-(pro|turbo)$|wan3)/i;
const SEEDED = /^(seedance-2(-fast|-mini)?$|wan2\.6|viduq3)/i;
/** Its price as the video catalogue's skus (agent.js videoPrice, the picker's videoRate read them), or {}. */
function videoSkus(p) {
  if (p?.per === 'second') return { duration_seconds: String(p.usd) };
  if (p?.per === 'call') return { per_clip: String(p.usd) };
  if (p?.per === 'token') return { video_tokens: String(p.in / 1e6) };
  return {};
}
/** Its video models, in the shape of OpenRouter's video catalogue (openrouter.js videoModels), with its prices. */
export async function toapisVideoModels(opts) {
  const [list, prices] = await Promise.all([listOf('video', opts), toapisPrices(opts.base)]);
  return list.map((m) => {
    const p = prices.get(m.id), skus = videoSkus(p);
    return {
      ...fromToapis, id: PREFIX + m.id, name: nice(m.id), kind: 'video', created: createdOf(m, p), ...known(Object.keys(skus).length),
      in: ['text', 'image'], out: ['video'], skus, resolutions: [], durations: [], aspects: [],
      frames: NO_FRAME.test(m.id) ? [] : LAST_FRAME.test(m.id) ? ['first_frame', 'last_frame'] : ['first_frame'], audio: false, seed: SEEDED.test(m.id),
      desc: `Videos on ToAPIs${owner(m)}. Billed by ToAPIs ${p?.per === 'second' ? 'per second' : p?.per === 'call' ? 'per clip' : p?.per === 'token' ? 'per video token' : 'per clip'}.`,
    };
  });
}
/** Its music models (Suno), in the shape of openrouter.js musicModels, with its price per call. */
export async function toapisMusicModels(opts) {
  const [list, prices] = await Promise.all([listOf('audio', opts), toapisPrices(opts.base)]);
  return list.filter((m) => /^suno/i.test(m.id)).map((m) => {
    const p = prices.get(m.id), perUse = p?.per === 'call' ? p.usd : null;
    return {
      ...fromToapis, id: PREFIX + m.id, name: nice(m.id), kind: 'music', created: createdOf(m, p), in: ['text'], out: ['audio'], perUse, ...known(perUse),
      length: 'full song', desc: `Suno songs on ToAPIs${perUse ? `: $${perUse} a call` : ''} (two versions per call; QuorX keeps the first).`,
    };
  });
}

// ---------- pictures ----------
/**
 * One picture. body: what agent.js builds for OpenRouter's Image API ({ model, prompt, aspect_ratio, … }). Returns
 * what generateImage in openrouter.js returns: { images: [dataUrl], usage: { cost? }, ms }.
 */
export async function toapisImage(body, signal, { key, base }) {
  const t = Date.now(), model = bare(body.model);
  const req = { model, prompt: String(body.prompt || ''), n: 1 };
  if (/^\d+:\d+$/.test(String(body.aspect_ratio || ''))) req[/^grok-image/i.test(model) ? 'aspect_ratio' : 'size'] = body.aspect_ratio;
  // The size, quality and background the family documents (imageFamily), where agent.js set them from its params.
  const f = imageFamily(model);
  if (body.resolution && f.res?.values.includes(body.resolution)) { if (f.res.at === 'metadata') (req.metadata ||= {}).resolution = body.resolution; else req.resolution = body.resolution; }
  if (body.quality && f.quality?.includes(body.quality)) req.quality = body.quality;
  if (body.background === 'transparent' && f.background) req.background = 'transparent';
  // Reference pictures: ToAPIs takes links only, so each is uploaded first.
  const refs = (body.input_references || []).map((r) => r?.image_url?.url).filter(Boolean).slice(0, f.refs);
  if (refs.length) req.image_urls = await Promise.all(refs.map((u) => toapisUpload(u, signal, { key, base })));
  const job = await call(`${base}/images/generations`, { key, method: 'POST', body: req, signal });
  const id = job.id || job.task_id || job.data?.id;
  const st = job.status === 'completed' && job.result ? job : await untilDone(`${base}/images/generations/${encodeURIComponent(id)}`, { key, signal, every: 3000, limit: 6 * 60e3, what: 'the picture' });
  const d = st.result?.data?.[0];
  if (!d?.url) throw new Error('ToAPIs: no picture returned');
  const file = await download(d.url, signal, d.fallback_url);
  return { images: [asDataUrl(file, 'image/png')], usage: { ...(billed(st) !== undefined ? { cost: billed(st) } : {}) }, ms: Date.now() - t };
}

// ---------- videos ----------
/** Uploads a picture (a data URL) so a job can use it; an https URL is used as it is. */
export async function toapisUpload(url, signal, { key, base }) {
  if (/^https:\/\//i.test(url)) return url;
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(String(url || ''));
  if (!m) throw new Error('ToAPIs: a picture must be a PNG, JPEG, WebP or GIF');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1]] || 'png';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `start.${ext}`);
  const j = await call(`${base}/uploads/images`, { key, method: 'POST', form, signal, ms: 120000 });
  if (!j?.data?.url) throw new Error('ToAPIs: the picture upload returned no URL');
  return j.data.url;
}
// Families with no top-level resolution field (they take a mode, or put it in metadata).
const NO_RES = /^(kling-v2-6|kling-v3|kling-v3-omni|kling-video-o1|sora|veo3\.1-(fast|lite)$|doubao-seedance-1-5)/i;
/** The request body ToAPIs takes for one clip: the fields each family documents. firstUrl: an https start picture. */
// lastUrl: an https end picture; refUrls: https reference pictures (each family's own field, where it has one).
export function toapisVideoBody(body, firstUrl, lastUrl, refUrls = []) {
  const model = bare(body.model), req = { model, prompt: String(body.prompt || '') };
  const ext = NO_FRAME.test(model), secs = Math.round(Number(body.duration)) || undefined, shape = /^\d+:\d+$/.test(String(body.aspect_ratio || '')) ? body.aspect_ratio : undefined;
  if (ext) { if (secs) req.seconds = secs; if (shape) req.size = shape; } else {
    if (secs) req.duration = secs;
    if (shape) req[/^wan3/i.test(model) ? 'ratio' : 'aspect_ratio'] = shape;
  }
  if (body.resolution && !NO_RES.test(model)) req.resolution = String(body.resolution);
  if (typeof body.generate_audio === 'boolean' && /^seedance-2/i.test(model) && !ext) req.generate_audio = body.generate_audio;
  if (Number.isInteger(body.seed) && SEEDED.test(model)) req.seed = body.seed;
  const roles = /^(wan3|kling-v2-6|kling-v3$)/i.test(model) || (lastUrl && /^seedance-2/i.test(model)) || (refUrls.length && /^seedance-2/i.test(model));
  if (firstUrl || lastUrl) {
    if (/^grok-(imagine-)?video/i.test(model)) req.image = firstUrl;
    else if (roles) req.image_with_roles = [...(firstUrl ? [{ url: firstUrl, role: 'first_frame' }] : []), ...(lastUrl ? [{ url: lastUrl, role: 'last_frame' }] : [])];
    else {
      req.image_urls = [firstUrl, lastUrl].filter(Boolean);
      // Veo takes start and end as a pair of frames.
      if (lastUrl && /^veo3/i.test(model)) (req.metadata ||= {}).generation_type = 'frame';
    }
  } else if (refUrls.length) {
    // Reference pictures for the look, where the family documents them (a start or end picture takes their place).
    if (/^seedance-2/i.test(model)) req.image_with_roles = refUrls.slice(0, 9).map((url) => ({ url, role: 'reference_image' }));
    else if (/^(kling-v3|grok-(imagine-)?video)/i.test(model)) req.reference_images = refUrls.slice(0, /^kling/i.test(model) ? 4 : 7);
    else if (/^veo3/i.test(model)) { req.image_urls = refUrls.slice(0, 3); (req.metadata ||= {}).generation_type = 'reference'; }
    else if (/^viduq3$/i.test(model) || NO_FRAME.test(model)) req.image_urls = refUrls.slice(0, 7);
  }
  return req;
}
/**
 * One clip. body: what video.js videoBody builds for OpenRouter (frame_images carries the start picture). Returns
 * what generateVideo in openrouter.js returns: { url: dataUrl, usage: { cost? }, ms, bytes }.
 */
export async function toapisVideo(body, signal, onStatus, { key, base }) {
  const t = Date.now();
  const frame = (type) => body.frame_images?.find((f) => f.frame_type === type)?.image_url?.url;
  const up = (u) => (u ? toapisUpload(u, signal, { key, base }) : null);
  const [firstUrl, lastUrl] = await Promise.all([up(frame('first_frame')), up(frame('last_frame'))]);
  const refUrls = await Promise.all((body.input_references || []).map((r) => r?.image_url?.url).filter(Boolean).slice(0, 9).map(up));
  const job = await call(`${base}/videos/generations`, { key, method: 'POST', body: toapisVideoBody(body, firstUrl, lastUrl, refUrls), signal });
  const id = job.id || job.task_id;
  // Seedance reviews start pictures before it begins, which can take several minutes on a first use.
  const st = await untilDone(`${base}/videos/generations/${encodeURIComponent(id)}`, { key, signal, every: 5000, limit: 20 * 60e3, what: 'the video', onStatus: (s, ms) => onStatus?.(s, ms) });
  const d = st.result?.data?.[0];
  if (!d?.url) throw new Error('ToAPIs: no video returned');
  const file = await download(d.url, signal, d.fallback_url);
  return { url: asDataUrl(file, 'video/mp4'), usage: { ...(billed(st) !== undefined ? { cost: billed(st) } : {}) }, ms: Date.now() - t, bytes: file.buf.length };
}

// ---------- music ----------
/** One song with Suno. Returns what composeMusic in openrouter.js returns: { url, text, usage, ms }. */
// lyrics / title / style / instrumental: Suno's custom mode (the words sung, the song's name, its style tags, no vocals).
// With none of them, the description alone (gpt_description) is Suno's own pick.
export function sunoBody({ model, prompt, lyrics, title, style, instrumental }) {
  const req = { model: bare(model) || 'suno' };
  const custom = !!(String(lyrics || '').trim() || String(title || '').trim() || String(style || '').trim());
  if (custom) {
    req.custom = true;
    req.prompt = String(lyrics || '').trim().slice(0, 5000);
    req.style = String(style || prompt || '').trim().slice(0, 1000);
    if (String(title || '').trim()) req.title = String(title).trim().slice(0, 120);
  } else req.gpt_description = String(prompt || '').slice(0, 3000);
  if (instrumental === true) req.instrumental = true;
  else if (custom && !req.prompt) req.auto_lyrics = true; // a title or a style with no words: Suno writes them
  return req;
}
export async function toapisMusic(args, signal, { key, base }) {
  const t = Date.now();
  const job = await call(`${base}/music/generations/generation`, { key, method: 'POST', body: sunoBody(args), signal });
  const id = job.task_id || job.id;
  const st = await untilDone(`${base}/music/tasks/${encodeURIComponent(id)}`, { key, signal, every: 5000, limit: 10 * 60e3, what: 'the song' });
  const song = (st.result?.music || []).find((x) => x?.audio_url);
  if (!song) throw new Error('ToAPIs: no song returned');
  const file = await download(song.audio_url, signal);
  const text = [song.title, song.tags, song.lyrics].filter(Boolean).join('\n');
  return { url: asDataUrl(file, 'audio/mpeg'), text, usage: { ...(billed(st) !== undefined ? { cost: billed(st) } : {}) }, ms: Date.now() - t };
}
