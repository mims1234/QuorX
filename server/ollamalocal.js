// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Ollama on this computer as a model source ("Ollama on this PC" in ⚙ Settings → Providers): the models the
// user pulled, run on this computer at no cost, and the Ollama cloud models they signed in for (ollama signin).
//   - Its server is the one the Ollama app runs (http://127.0.0.1:11434, or OLLAMA_HOST). When it isn't running and
//     a call needs it, QuorX starts `ollama serve` hidden and leaves it running, as the Ollama app would.
//   - The list is the models pulled (GET /api/tags), each asked what it can do (POST /api/show): only those that call
//     tools are chat models here, since the agent works through tools.
//   - Calls go to the native /api/chat, not the OpenAI-style endpoint: only the native one takes a context size, and
//     Ollama's default is too small for QuorX's instructions and tools, which it would cut without saying so.
import { spawn } from 'node:child_process';
import { findOnPath } from './opencodelocal.js';

export const OLLAMA_ID = 'ollama-local';
// OLLAMA_HOST as Ollama reads it: host, host:port or a full URL.
export function ollamaBase(host = process.env.OLLAMA_HOST) {
  const h = String(host || '').trim();
  if (!h) return 'http://127.0.0.1:11434';
  const u = /^https?:\/\//i.test(h) ? h : `http://${h}`;
  try { const x = new URL(u); return `${x.protocol}//${x.hostname === '0.0.0.0' ? '127.0.0.1' : x.hostname}:${x.port || 11434}`; } catch { return 'http://127.0.0.1:11434'; }
}
// The context size a call asks for: OLLAMA_CONTEXT_LENGTH when the user set one, else the model's own up to 32K
// (a bigger window takes more memory, and a change reloads the model).
export const ctxFor = (info = {}) => Number(process.env.OLLAMA_CONTEXT_LENGTH) || Math.min(Number(info.ctx) || 32768, 32768);

const err = (m, x = {}) => Object.assign(new Error(m), x);
let started = null; // the `ollama serve` QuorX started: { proc, at }
let seenAt = 0; // when its server last answered
async function up(base, ms = 2500) {
  try { const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(ms) }); if (!r.ok) return null; seenAt = Date.now(); return (await r.json()).version || '?'; } catch { return null; }
}
/** The server's address, started first when it isn't running. Throws notinstalled or network. */
export async function ensureOllama({ find = findOnPath, start = spawn, readyMs = 60e3 } = {}) {
  const base = ollamaBase();
  if (await up(base)) return base;
  const exe = find('ollama');
  if (!exe) throw err('Ollama is not installed on this computer (ollama.com/download), or not on PATH.', { kind: 'notinstalled' });
  // Only a local address can be started from here; one elsewhere is the user's to start.
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(base)) throw err(`Ollama at ${base} isn’t answering.`, { kind: 'network' });
  if (!started || started.proc.exitCode !== null) {
    const proc = start(exe, ['serve'], { windowsHide: true, detached: true, stdio: 'ignore' });
    proc.on?.('error', () => {});
    proc.unref?.();
    started = { proc, at: Date.now() };
  }
  for (const t = Date.now(); Date.now() - t < readyMs;) {
    if (await up(base, 1500)) return base;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw err('Ollama’s server didn’t start. Open the Ollama app, then test again.', { kind: 'network' });
}
/** What Settings shows of the server: running or not, and whether QuorX started it. */
export const ollamaServer = () => ({ running: Date.now() - seenAt < 120e3, port: new URL(ollamaBase()).port || 11434, startedHere: !!started && started.proc.exitCode === null });

async function getJSON(url, init = {}, ms = 15000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw await failure(r);
  return r.json();
}
// The context length a model was trained for: model_info names it after its architecture (qwen3.context_length).
const ctxOf = (show) => { for (const [k, v] of Object.entries(show?.model_info || {})) if (/\.context_length$/.test(k) && Number(v) > 0) return Number(v); return null; };
/** One pulled model as a catalogue entry like the others (ollama-local/<name>), from /api/tags and /api/show. */
export function ollamaEntry(tag, show = {}) {
  const name = String(tag?.name || tag?.model || '');
  const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
  const cloud = !!show.remote_host || !!tag?.remote_host || /[:-]cloud$/.test(name);
  const d = { ...(tag?.details || {}), ...(show.details || {}) };
  return {
    id: `${OLLAMA_ID}/${name}`, realId: name, modelID: name, providerID: 'ollama', providerName: cloud ? 'Ollama cloud' : 'Ollama', source: OLLAMA_ID,
    ...(d.family ? { maker: String(d.family) } : {}),
    name: `${name}${d.parameter_size && !cloud ? ` · ${d.parameter_size}` : ''}`, kind: 'chat', ctx: ctxOf(show), maxOut: null, created: Math.floor(Date.parse(tag?.modified_at || '') / 1000) || 0,
    in: caps.includes('vision') ? ['text', 'image'] : ['text'], out: ['text'],
    // A pulled model runs on this computer for nothing; a cloud one on the Ollama plan the user signed in with.
    price: [0, 0], listPrice: [0, 0], cost: {}, plan: cloud ? 'plan' : 'free', ...(cloud ? { planLabel: 'Ollama' } : {}),
    tools: caps.includes('tools'), temp: true, reasoning: caps.includes('thinking'), efforts: /gpt-oss/i.test(name) ? ['low', 'medium', 'high'] : [],
    cloud, format: OLLAMA_ID, status: null, canonical: null, desc: cloud ? 'An Ollama cloud model: runs on Ollama’s servers with the account you signed in with (ollama signin).' : `Runs on this computer${d.quantization_level ? ` (${d.quantization_level})` : ''}.`,
  };
}
/** The models pulled into Ollama that can call tools. `fetchJSON` is for tests. */
export async function ollamaModels({ fetchJSON = getJSON, ensure = ensureOllama } = {}) {
  const base = await ensure();
  const tags = (await fetchJSON(`${base}/api/tags`))?.models || [];
  const shows = await Promise.all(tags.map((t) => fetchJSON(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: t.name || t.model }) }).catch(() => null)));
  return tags.map((t, i) => (shows[i] ? ollamaEntry(t, shows[i]) : null)).filter((m) => m && m.tools);
}

// ---------- one call ----------
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '');
// Pictures as Ollama takes them: base64 without the data: prefix (it takes no links).
const imagesOf = (c) => (Array.isArray(c) ? c.filter((p) => p?.type === 'image_url').map((p) => /^data:image\/[\w.+-]+;base64,(.*)$/s.exec(String((typeof p.image_url === 'string' ? p.image_url : p.image_url?.url) || ''))?.[1]).filter(Boolean) : []);
const argsOf = (s) => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
/** The conversation as /api/chat takes it: tool calls with their arguments as objects, results named by their tool. */
export function ollamaMessages(msgs = []) {
  const names = new Map();
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'developer' ? 'system' : m.role;
    const imgs = imagesOf(m.content);
    if (role === 'assistant') {
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((c) => c?.function?.name);
      for (const c of calls) if (c.id) names.set(c.id, c.function.name);
      out.push({ role, content: textOf(m.content), ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.function.name, arguments: argsOf(c.function.arguments) } })) } : {}) });
    } else if (role === 'tool') {
      out.push({ role, content: textOf(m.content) || '(no output)', ...(names.has(m.tool_call_id) ? { tool_name: names.get(m.tool_call_id) } : {}), ...(imgs.length ? { images: imgs } : {}) });
    } else out.push({ role, content: textOf(m.content), ...(imgs.length ? { images: imgs } : {}) });
  }
  return out;
}
/** The /api/chat request for one of QuorX's calls (openrouter.js's shape in). */
export function ollamaBody(body, info = {}) {
  const s = String(body.model || ''), model = info.realId || (s.startsWith(`${OLLAMA_ID}/`) ? s.slice(OLLAMA_ID.length + 1) : s);
  const options = { num_ctx: ctxFor(info) };
  if (body.max_tokens) options.num_predict = Number(body.max_tokens);
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.stop !== undefined) options.stop = [].concat(body.stop);
  const out = { model, messages: ollamaMessages(body.messages), stream: true, options };
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.function?.name);
  if (tools.length) out.tools = tools.map((t) => ({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } }));
  // Thinking: off when the call turns it off, the effort level for a model that takes one (gpt-oss), else on.
  if (info.reasoning) {
    const off = body.reasoning?.enabled === false, e = body.reasoning?.effort;
    out.think = off ? false : info.efforts?.length ? (info.efforts.includes(e) ? e : 'medium') : true;
  }
  return out;
}
async function failure(r) {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  const msg = (typeof j?.error === 'string' ? j.error : j?.error?.message) || t.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${r.status}`;
  const kind = r.status === 404 && /model/i.test(msg) ? 'model' : r.status === 401 || /unauthori[sz]ed|ollama signin|sign ?in/i.test(msg) ? 'auth' : undefined;
  return Object.assign(new Error(`Ollama: ${msg}`), { status: r.status, retryAfter: Number(r.headers?.get?.('retry-after')) || 0, ...(kind ? { kind } : {}) });
}
const FINISH = { stop: 'stop', length: 'length', load: 'stop', unload: 'stop' };
/** An /api/chat stream (one JSON object per line) read into openrouter.js chatStream's result shape. */
export async function readOllamaStream(r, body, t, onText, onThink) {
  const dec = new TextDecoder();
  let buf = '', text = '', thinking = '', firstMs = null, finish = null, model = null, seen = 0;
  const calls = [], usage = {};
  const line = (raw) => {
    const s = raw.trim(); if (!s) return;
    let j; try { j = JSON.parse(s); } catch { return; }
    seen++;
    if (j.error) throw Object.assign(new Error(`Ollama: ${typeof j.error === 'string' ? j.error : j.error.message || 'stream error'}`), { streamStatus: null });
    if (j.model && !model) model = j.model;
    const m = j.message || {};
    if (typeof m.thinking === 'string' && m.thinking) { thinking += m.thinking; onThink?.(m.thinking); }
    if (typeof m.content === 'string' && m.content) { if (firstMs == null) firstMs = Date.now() - t; text += m.content; onText?.(m.content); }
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (!c?.function?.name) continue;
      const a = c.function.arguments;
      calls.push({ id: c.id || `call_${calls.length}_${Date.now().toString(36)}`, type: 'function', function: { name: c.function.name, arguments: typeof a === 'string' ? a : JSON.stringify(a ?? {}) } });
    }
    if (j.done) {
      finish = calls.length ? 'tool_calls' : FINISH[j.done_reason] || j.done_reason || 'stop';
      if (Number.isFinite(j.prompt_eval_count)) usage.prompt_tokens = j.prompt_eval_count;
      if (Number.isFinite(j.eval_count)) usage.completion_tokens = j.eval_count;
    }
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let k;
    while ((k = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, k); buf = buf.slice(k + 1); line(s); }
  }
  if (buf) line(buf);
  return { text, thinking, reasoningDetails: [], toolCalls: calls, usage, ms: Date.now() - t, firstMs, finishReason: finish, provider: null, model, seen };
}
// The stream's chunks, with a limit on how long it may go quiet: a call that stops sending fails instead of hanging.
// A model still loading into memory sends nothing for a while, so the first wait is longer.
async function* quietLimit(body, ms, ac) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`Ollama sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}
/** One streamed call to Ollama, read into openrouter.js chatStream's result shape. Throws with .status/.kind. */
export async function ollamaStream(body, signal, onText, onThink, { info = {}, idleMs = 300e3, ensure = ensureOllama, fetchFn = fetch } = {}) {
  const base = await ensure();
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now();
  try {
    const r = await fetchFn(`${base}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ollamaBody(body, info)) });
    if (!r.ok) throw await failure(r);
    const out = await readOllamaStream({ body: quietLimit(r.body, idleMs, ac) }, body, t, onText, onThink);
    if (!out.seen) throw Object.assign(new Error('Ollama answered with an empty stream'), { kind: 'shape' });
    out.provider = info.cloud ? 'Ollama cloud' : 'Ollama';
    out.model = body.model;
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw ac.signal.reason;
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}
