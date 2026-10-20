// OpenRouter access: chat completions (plain, streaming, with tools), Decisions, catalogues.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeKey } from './keys.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where chats, projects, keys, logs and .env live: the app folder itself, unless OH_HOME points elsewhere
// (the installed desktop app keeps them in your profile, so updates never touch them).
export const HOME = process.env.OH_HOME ? path.resolve(process.env.OH_HOME) : ROOT;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(HOME, '.env'));
if (HOME !== ROOT) loadEnv(path.join(ROOT, '.env'));
// The key every call uses: the one marked active in ⚙ Settings → API keys (.env's key by default).
export const currentKey = () => activeKey();
export const PORT = Number(process.env.AGENT_PORT || 5188);
// The port the harness actually listens on (it moves up if PORT is taken by another program).
export const runtime = { port: PORT };

const BASE = 'https://openrouter.ai';
const headers = () => ({
  Authorization: `Bearer ${currentKey()}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': `http://localhost:${runtime.port}`,
  'X-Title': 'QuorX',
});

async function postJSON(url, body, signal) {
  const t = Date.now();
  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
  const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
  if (!r.ok || j.error) {
    const e = new Error(j.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return { j, ms: Date.now() - t };
}

// Some models refuse `reasoning: {enabled: false}` (reasoning is mandatory). Retry those with the
// lightest reasoning instead, and remember the model so later calls skip the failed attempt.
const mustReason = new Set();
const REASONING_REQUIRED = /reasoning is mandatory|cannot be disabled/i;
const adapt = (body) => (mustReason.has(body.model) && body.reasoning?.enabled === false ? { ...body, reasoning: { effort: 'low', exclude: true } } : body);
async function withReasoningFallback(body, fn) {
  try { return await fn(adapt(body)); }
  catch (e) {
    if (!REASONING_REQUIRED.test(e.message) || mustReason.has(body.model)) throw e;
    mustReason.add(body.model);
    return fn(adapt(body));
  }
}

export function chat(body, signal) {
  return withReasoningFallback(body, (b) => chatOnce(b, signal));
}
async function chatOnce(body, signal) {
  const { j, ms } = await postJSON(`${BASE}/api/v1/chat/completions`, body, signal);
  return { message: j.choices?.[0]?.message || {}, usage: j.usage || {}, ms };
}

// Streams a chat completion. Text deltas go to onText as they arrive; tool-call deltas are
// assembled and returned, so one function serves both "speak" and "call a tool" steps.
// Reasoning ("thinking") deltas, when the model sends them, go to onThink the same way.
export function chatStream(body, signal, onText, onThink) {
  return withReasoningFallback(body, (b) => chatStreamOnce(b, signal, onText, onThink));
}
async function chatStreamOnce(body, signal, onText, onThink) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ ...body, stream: true, usage: { include: true } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(j.error?.message || `HTTP ${r.status}`);
    e.status = r.status; // the loop retries rate limits and server errors, not bad requests
    throw e;
  }
  const dec = new TextDecoder();
  let buf = '', text = '', thinking = '', usage = {}, firstMs = null, finish = null, provider = null, model = null;
  const calls = [];
  // reasoning_details arrive in pieces; pieces with the same index belong to one block (text, summary or
  // encrypted data, plus a signature at the end). They are passed back unchanged on the next tool step.
  const details = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'stream error');
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) { if (firstMs == null) firstMs = Date.now() - t; text += delta.content; onText?.(delta.content); }
      // Thinking arrives as delta.reasoning (text) or delta.reasoning_details (parts with text or a summary).
      const think = delta.reasoning || (delta.reasoning_details || []).map((x) => x.text || x.summary || '').join('');
      if (think) { thinking += think; onThink?.(think); }
      for (const d of delta.reasoning_details || []) {
        const k = Number.isInteger(d.index) ? d.index : details.length;
        const cur = details[k];
        if (!cur) { details[k] = { ...d }; continue; }
        for (const [f, v] of Object.entries(d)) {
          if (v == null || f === 'index') continue;
          cur[f] = (f === 'text' || f === 'summary' || f === 'data') && typeof cur[f] === 'string' ? cur[f] + v : v;
        }
      }
      if (j.provider && !provider) provider = j.provider;
      if (j.model && !model) model = j.model;
      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? calls.length;
        calls[k] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[k].id = tc.id;
        if (tc.function?.name) calls[k].function.name += tc.function.name;
        if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments;
      }
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (j.usage) usage = j.usage;
    }
  }
  return { text, thinking, reasoningDetails: details.filter(Boolean), toolCalls: calls.filter(Boolean), usage, ms: Date.now() - t, firstMs, finishReason: finish, provider, model };
}

// One Decisions request: a state plus many typed questions, answered in parallel by one model.
export async function decisions(model, state, questions, signal) {
  const { j, ms } = await postJSON(`${BASE}/api/alpha/decisions`, { model, state, questions }, signal);
  return { answers: j.answers || {}, usage: { cost: j.usage?.cost || 0, prompt_tokens: j.usage?.input_tokens || 0, completion_tokens: 0 }, ms, provider: j.provider, resolved: j.model };
}

// ---------- catalogues (cached for an hour) ----------
const cache = {};
// Drops every cached catalogue, so the next request fetches fresh model lists and prices.
export function clearCatalogues() { for (const k of Object.keys(cache)) delete cache[k]; }
async function cached(key, fn) {
  const c = cache[key];
  if (c && Date.now() - c.at < 3600e3) return c.v;
  try { cache[key] = { v: await fn(), at: Date.now() }; } catch (e) { if (!c) throw e; }
  return cache[key].v;
}
const slim = (m, kind) => ({
  id: m.id, name: m.name, ctx: m.context_length, kind, created: m.created || 0,
  in: m.architecture?.input_modalities || [], out: m.architecture?.output_modalities || [],
  price: [Number(m.pricing?.prompt || 0) * 1e6, Number(m.pricing?.completion || 0) * 1e6],
  tools: (m.supported_parameters || []).includes('tools'),
  temp: (m.supported_parameters || []).includes('temperature'),
  reasoning: (m.supported_parameters || []).some((x) => x === 'reasoning' || x === 'include_reasoning'),
  maxOut: m.top_provider?.max_completion_tokens || null,
  desc: String(m.description || '').replace(/\s+/g, ' ').slice(0, 220),
});
export const chatModels = () => cached('chat', async () => {
  const j = await (await fetch(`${BASE}/api/v1/models`)).json();
  return j.data.filter((m) => !m.id.endsWith(':batch')).map((m) => slim(m, 'chat'));
});
// Embedding models (for searching big attached documents), with their price per million tokens.
export const embeddingModels = () => cached('embeddings', async () => {
  const j = await (await fetch(`${BASE}/api/v1/embeddings/models`)).json();
  return (j.data || []).map((m) => ({ id: m.id, name: m.name || m.id, ctx: m.context_length || 512, price: Number(m.pricing?.prompt || 0) * 1e6, desc: String(m.description || '').replace(/\s+/g, ' ').slice(0, 220) }));
});
/** Vectors for a batch of texts. The cost comes from OpenRouter when it reports one, else from the model's price. */
export async function embed(model, input, signal) {
  const { j, ms } = await postJSON(`${BASE}/api/v1/embeddings`, { model, input }, signal);
  const vectors = (j.data || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  if (vectors.length !== input.length) throw new Error(`the embedding model returned ${vectors.length} vectors for ${input.length} texts`);
  let cost = Number(j.usage?.cost);
  if (!Number.isFinite(cost)) { const m = (await embeddingModels().catch(() => [])).find((x) => x.id === model); cost = ((j.usage?.prompt_tokens || j.usage?.total_tokens || 0) * (m?.price || 0)) / 1e6; }
  return { vectors, usage: { ...(j.usage || {}), cost }, ms };
}
export const decisionModels = () => cached('decisions', async () => {
  const j = await (await fetch(`${BASE}/api/v1/models?output_modalities=decisions`)).json();
  return j.data.map((m) => slim(m, 'decision'));
});


// ---------- images (dedicated Image API: /api/v1/images) ----------
// The image catalogue (61+ models) merges capabilities from /images/models with prices from /models.
export const imageModels = () => cached('images', async () => {
  const [list, priced] = await Promise.all([
    fetch(`${BASE}/api/v1/images/models`).then((r) => r.json()),
    fetch(`${BASE}/api/v1/models?output_modalities=image`).then((r) => r.json()),
  ]);
  const price = Object.fromEntries((priced.data || []).map((m) => [m.id, m.pricing || {}]));
  return (list.data || []).filter((m) => !/^openrouter\//.test(m.id)).map((m) => ({
    id: m.id, name: m.name, kind: 'image', created: m.created || 0, ctx: null,
    in: m.architecture?.input_modalities || ['text'], out: ['image'],
    // price[1] = $ per 1M output image tokens; perImage = flat fee per picture when the provider charges one
    price: [Number(price[m.id]?.prompt || 0) * 1e6, Number(price[m.id]?.image_output || 0) * 1e6],
    // Some providers list a tiny per-INPUT-image price here (e.g. $0.0000003); only a real per-picture fee counts.
    perImage: Number(price[m.id]?.image || 0) >= 0.001 ? Number(price[m.id].image) : null,
    params: m.supported_parameters || {},
  }));
});

export async function generateImage(body, signal) {
  const { j, ms } = await postJSON(`${BASE}/api/v1/images`, body, signal);
  const images = (j.data || []).map((d) => `data:${d.media_type || 'image/png'};base64,${d.b64_json}`);
  return { images, usage: j.usage || {}, ms };
}

// ---------- speech (text-to-speech: /api/v1/audio/speech) and music (Google Lyria via chat) ----------
export const speechModels = () => cached('speech', async () => {
  const j = await (await fetch(`${BASE}/api/v1/models?output_modalities=speech`)).json();
  return (j.data || []).map((m) => ({
    id: m.id, name: m.name, kind: 'speech', created: m.created || 0, ctx: null,
    in: m.architecture?.input_modalities || ['text'], out: ['speech'],
    // price[0] = $ per 1M input characters/tokens of text to read aloud; price[1] = $ per 1M audio tokens out (Gemini)
    price: [Number(m.pricing?.prompt || 0) * 1e6, Number(m.pricing?.completion || 0) * 1e6],
    voices: m.supported_voices || [],
  }));
});
// Only Google's Lyria models: music generation with a known per-clip / per-song price.
export const musicModels = () => cached('music', async () => {
  const j = await (await fetch(`${BASE}/api/v1/models?output_modalities=audio`)).json();
  return (j.data || []).filter((m) => /^google\/lyria/.test(m.id)).map((m) => ({
    id: m.id, name: m.name, kind: 'music', created: m.created || 0, ctx: null, in: ['text'], out: ['audio'],
    price: [0, 0], perUse: /pro/.test(m.id) ? 0.08 : 0.04, length: /pro/.test(m.id) ? 'full song' : '30-second clip',
  }));
});

// Raw 16-bit mono PCM (what Gemini TTS returns) wrapped into a playable WAV file.
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function synthesize({ model, input, voice, instructions }, signal) {
  const t = Date.now();
  const send = (format) => fetch(`${BASE}/api/v1/audio/speech`, { method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ model, input, ...(voice ? { voice } : {}), ...(instructions ? { instructions } : {}), response_format: format }) });
  let r = await send('mp3'), format = 'mp3';
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`;
    if (!/pcm/i.test(msg)) throw new Error(msg);
    r = await send('pcm'); format = 'pcm'; // e.g. Gemini TTS only returns raw PCM
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
  }
  let buf = Buffer.from(await r.arrayBuffer());
  let mime = r.headers.get('content-type') || 'audio/mpeg';
  if (format === 'pcm') { buf = pcmToWav(buf); mime = 'audio/wav'; }
  return { url: `data:${mime};base64,${buf.toString('base64')}`, ms: Date.now() - t, bytes: buf.length, generationId: r.headers.get('x-generation-id') };
}

// Lyria answers a streamed chat request with base64 audio chunks.
export async function composeMusic({ model, prompt }, signal) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/v1/chat/completions`, { method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ model, stream: true, modalities: ['text', 'audio'], audio: { format: 'mp3' }, messages: [{ role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
  const dec = new TextDecoder();
  let buf = '', audio = '', text = '', usage = {};
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'music generation failed');
      const d = j.choices?.[0]?.delta || {};
      if (d.audio?.data) audio += d.audio.data;
      if (d.audio?.transcript) text += d.audio.transcript;
      if (d.content) text += d.content;
      if (j.usage) usage = j.usage;
    }
  }
  if (!audio) throw new Error('no audio returned');
  return { url: `data:audio/mpeg;base64,${audio}`, text, usage, ms: Date.now() - t };
}

// ---------- video (async jobs: /api/v1/videos) ----------
export const videoModels = () => cached('videos', async () => {
  const j = await (await fetch(`${BASE}/api/v1/videos/models`)).json();
  return (j.data || []).map((m) => ({
    id: m.id, name: m.name, kind: 'video', created: m.created || 0, ctx: null, in: ['text'], out: ['video'], price: [0, 0],
    skus: m.pricing_skus || {}, resolutions: m.supported_resolutions || [], durations: m.supported_durations || [],
    aspects: m.supported_aspect_ratios || [],
    // first_frame / last_frame: the pictures it can start (or end) a clip from; audio: whether it makes sound.
    frames: m.supported_frame_images || [], audio: m.generate_audio === true,
  }));
});

// Submits a video job, polls until it finishes, then downloads the first output as a data URL.
export async function generateVideo(body, signal, onStatus) {
  const t = Date.now();
  const { j: job } = await postJSON(`${BASE}/api/v1/videos`, body, signal);
  const poll = job.polling_url || `${BASE}/api/v1/videos/${job.id}`;
  let st = job;
  while (!['completed', 'failed'].includes(st.status)) {
    if (Date.now() - t > 6 * 60e3) throw new Error('video timed out after 6 minutes');
    await new Promise((r, rej) => { const k = setTimeout(r, 4000); signal?.addEventListener('abort', () => { clearTimeout(k); rej(new Error('aborted')); }, { once: true }); });
    const r = await fetch(poll, { headers: headers(), signal });
    st = await r.json();
    if (st.error && st.status !== 'failed') throw new Error(st.error.message || String(st.error));
    onStatus?.(st.status, Date.now() - t);
  }
  if (st.status === 'failed') throw new Error(st.error?.message || st.error || 'video generation failed');
  const r = await fetch(`${BASE}/api/v1/videos/${job.id}/content?index=0`, { headers: headers(), signal });
  if (!r.ok) throw new Error(`video download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get('content-type') || 'video/mp4';
  return { url: `data:${mime};base64,${buf.toString('base64')}`, usage: st.usage || {}, ms: Date.now() - t, bytes: buf.length };
}

// Speech to text with an audio-capable chat model (OpenRouter has no transcription endpoint).
export async function transcribe({ model, audio, format = 'wav' }, signal) {
  const r = await chat({ model, max_tokens: 600, temperature: 0, reasoning: { enabled: false }, messages: [{ role: 'user', content: [
    { type: 'text', text: 'Transcribe this speech verbatim. Output only the transcript.' },
    { type: 'input_audio', input_audio: { data: audio, format } }] }] }, signal);
  return { text: String(r.message.content || '').trim(), usage: r.usage, ms: r.ms };
}
