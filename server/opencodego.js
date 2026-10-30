// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// OpenCode Go over its API, with the user's own key (⚙ Settings → API keys). Go is OpenCode's subscription: its models
// cost nothing per call up to the plan's 5-hour, weekly and monthly limits (https://opencode.ai/docs/go/).
//   - Which models Go serves today comes from its own list (GET /inference/go/v1/models, no key needed). Their names,
//     limits and list prices come from models.dev, the catalogue OpenCode itself reads; a model models.dev doesn't
//     know yet still shows, without prices.
//   - Every text model answers on the OpenAI chat endpoint (the Console translates for the models that speak another
//     format), so tool calls go over natively and the answer streams in OpenRouter's shape (openrouter.js).
//   - Each call names a steady session for its chat (x-opencode-session): Go refuses calls without one.
import crypto from 'node:crypto';
import { readChatStream } from './openrouter.js';

export const GO_ID = 'opencode-go';
const BASE = process.env.QX_OPENCODE_GO_BASE || 'https://opencode.ai/inference/go';
export const GO_API = `${BASE}/openai/v1`;
const GO_MODELS = `${BASE}/v1/models`;
const MODELS_DEV = process.env.QX_MODELS_DEV || 'https://models.dev/api.json';

async function getJSON(url, ms = 20000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} said HTTP ${r.status}`), { status: r.status });
  return r.json();
}
const per = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const nice = (id) => String(id).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** One Go model as a catalogue entry like the others (opencode-go/<model>), from Go's list and models.dev's entry. */
export function goEntry(id, md = null) {
  const c = md?.cost || {}, list = [per(c.input), per(c.output)];
  const canon = String(md?.canonical_model_id || '');
  const effort = (Array.isArray(md?.reasoning_options) ? md.reasoning_options : []).find((o) => o?.type === 'effort' && Array.isArray(o.values));
  return {
    id: `${GO_ID}/${id}`, realId: id, modelID: id, providerID: GO_ID, source: GO_ID,
    // Who made it, for the picker's makers filter: models.dev's canonical id names the vendor (zhipuai/glm-5.3).
    ...(canon.includes('/') ? { maker: canon.split('/')[0] } : {}),
    name: md?.name || nice(id), kind: 'chat', ctx: md?.limit?.context || null, maxOut: md?.limit?.output || null,
    created: md?.release_date ? Math.floor(Date.parse(md.release_date) / 1000) || 0 : 0,
    in: (md?.modalities?.input || ['text']).filter((x) => x === 'text' || x === 'image'), out: ['text'],
    // Nothing to pay per call: the list price is what a call counts against the plan's limits.
    price: [0, 0], listPrice: list, cost: c, plan: 'plan',
    tools: md ? md.tool_call !== false : true, temp: md?.temperature !== false, reasoning: !!md?.reasoning, efforts: effort ? effort.values.map(String) : [],
    interleaved: md?.interleaved && typeof md.interleaved === 'object' ? md.interleaved.field || null : null,
    status: md?.status === 'deprecated' ? 'deprecated' : null, canonical: canon || null,
    desc: String(md?.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}
/**
 * The models Go serves now. `fetchJSON` is for tests. A model models.dev lists for Go but Go's own list doesn't is
 * left out (dropped or not out yet); one only Go lists shows with its id for a name and no prices.
 */
export async function goModels({ fetchJSON = getJSON } = {}) {
  const [live, dev] = await Promise.all([fetchJSON(GO_MODELS), fetchJSON(MODELS_DEV).catch(() => null)]);
  const ids = (Array.isArray(live?.data) ? live.data : []).map((m) => String(m?.id || '')).filter((x) => /^[\w.:@+-]{1,120}$/.test(x));
  const info = dev?.[GO_ID]?.models || {};
  const out = [];
  for (const id of [...new Set(ids)]) {
    const md = Object.hasOwn(info, id) ? info[id] : null;
    // Go also serves models that draw or speak: only those that answer in text are chat models here.
    if (md && Array.isArray(md.modalities?.output) && !md.modalities.output.includes('text')) continue;
    try { out.push(goEntry(id, md)); } catch { /* one odd entry */ }
  }
  return out;
}

// The thinking level a call asks for, as the model's own effort values name it (none when it has none to choose).
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function effortFor(reasoning, efforts = []) {
  if (!reasoning || !efforts.length) return null;
  const want = reasoning.enabled === false ? 'none' : reasoning.effort || (reasoning.max_tokens ? (reasoning.max_tokens <= 4000 ? 'low' : reasoning.max_tokens <= 10000 ? 'medium' : 'high') : null);
  if (!want) return null;
  if (efforts.includes(want)) return want;
  if (want === 'none') return efforts.includes('minimal') ? 'minimal' : null;
  const on = efforts.filter((v) => v !== 'none' && LADDER.includes(v));
  return on.sort((a, b) => Math.abs(LADDER.indexOf(a) - LADDER.indexOf(want)) - Math.abs(LADDER.indexOf(b) - LADDER.indexOf(want)))[0] || null;
}
// The messages as Go takes them: no OpenRouter-only fields or cache marks; a model that wants its reasoning back
// (interleaved thinking) gets it on its own earlier steps.
export function wireMessages(msgs = []) {
  return msgs.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const { qx_pass: pass, reasoning_details: _rd, ...rest } = m;
    if (rest.role === 'assistant' && pass && typeof pass === 'object') for (const [k, v] of Object.entries(pass)) if (/^reasoning(_content)?$/.test(k) && typeof v === 'string' && v) rest[k] = v;
    if (Array.isArray(rest.content)) rest.content = rest.content.map((p) => { if (!p || typeof p !== 'object' || !('cache_control' in p)) return p; const { cache_control: _c, ...q } = p; return q; });
    return rest;
  });
}
/** The request body Go gets for one of QuorX's calls (openrouter.js's shape in, the OpenAI chat format out). */
export function goBody(body, info = {}) {
  const s = String(body.model || ''), model = info.realId || (s.startsWith(`${GO_ID}/`) ? s.slice(GO_ID.length + 1) : s);
  const out = { model, messages: wireMessages(body.messages), stream: true, stream_options: { include_usage: true } };
  for (const k of ['tools', 'tool_choice', 'max_tokens', 'temperature', 'top_p', 'stop', 'seed', 'response_format', 'parallel_tool_calls']) if (body[k] !== undefined) out[k] = body[k];
  if (info.temp === false) delete out.temperature;
  const effort = effortFor(body.reasoning, info.efforts);
  if (effort) out.reasoning_effort = effort;
  return out;
}
// Go's errors come as { type: "error", error: { type, message } } (or OpenAI's { error: { message, code } }).
async function failure(r) {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  const e = j?.error && typeof j.error === 'object' ? j.error : {};
  const msg = e.message || j?.message || t.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${r.status}`;
  const errorType = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : undefined;
  const kind = errorType === 'MissingSessionID' ? 'request' : /invalid (credential|api key)|unauthori[sz]ed/i.test(msg) ? 'auth' : undefined;
  return Object.assign(new Error(`OpenCode Go: ${msg}`), { status: r.status, errorType, retryAfter: Number(r.headers.get('retry-after')) || 0, ...(kind ? { kind } : {}) });
}
// The stream's chunks, with a limit on how long it may go quiet: a call that stops sending fails instead of hanging.
async function* quietLimit(body, ms, ac) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`OpenCode Go sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}
/**
 * One streamed call to Go, read into openrouter.js chatStream's result shape. `key` is the user's Go key; `session`
 * the chat's steady session id. Throws with .status/.errorType/.kind when Go refuses (sources.js classifies it).
 */
export async function goStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, session, key, fetchFn = fetch } = {}) {
  if (!key) throw Object.assign(new Error('There is no OpenCode Go key yet: add one in ⚙ Settings → API keys.'), { kind: 'auth' });
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now();
  try {
    const req = goBody(body, info);
    const r = await fetchFn(`${GO_API}/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-opencode-session': session || `ses_qx${crypto.randomBytes(12).toString('hex')}`, 'User-Agent': 'QuorX' },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw await failure(r);
    const out = await readChatStream({ body: quietLimit(r.body, idleMs, ac) }, body, t, onText, onThink);
    if (!out.seen) throw Object.assign(new Error('OpenCode Go answered with an empty stream'), { kind: 'shape' });
    out.provider = 'OpenCode Go';
    out.model = body.model;
    // A model with interleaved thinking continues from its own reasoning on the next step (agent.js qx_pass).
    if (info.interleaved && out.thinking) out.passBack = { [info.interleaved]: out.thinking };
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw Object.assign(ac.signal.reason, { partial: e?.partial });
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}
/**
 * What is used of the plan's limits, from Go's usage endpoint: the 5-hour, weekly and monthly windows, each as a share
 * used (0–100) and when it resets. Go names no plan tier and no dollar amounts, so none are shown.
 */
export async function goAccount(key, { fetchFn = fetch } = {}) {
  if (!key) throw Object.assign(new Error('Add your OpenCode Go key first.'), { kind: 'auth' });
  const r = await fetchFn(`${BASE}/v1/usage`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'QuorX' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw await failure(r);
  const u = (await r.json())?.usage || {};
  const win = (label, w) => {
    const p = Number(w?.percent);
    if (!w || typeof w !== 'object' || !Number.isFinite(p)) return null;
    const percent = Math.max(0, Math.min(100, p));
    return { label, percent, over: percent >= 100 || (typeof w.status === 'string' && w.status !== 'ok'), resetAt: Date.parse(w.resetsAt || '') || null };
  };
  return { plan: null, windows: [win('5-hour window', u.rolling), win('Weekly window', u.weekly), win('Monthly window', u.monthly)].filter(Boolean), checked: Date.now() };
}
/** Checks a key with the smallest call Go takes: a few tokens from its cheapest model, counted against the plan. */
export async function goCheck(key, list, { fetchFn = fetch } = {}) {
  const cheap = [...list].filter((m) => m.tools).sort((a, b) => (a.listPrice[0] + a.listPrice[1]) - (b.listPrice[0] + b.listPrice[1]))[0] || list[0];
  if (!cheap) throw Object.assign(new Error('OpenCode Go listed no models'), { kind: 'shape' });
  const r = await goStream({ model: cheap.id, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }, new AbortController().signal, null, null, { info: cheap, key, idleMs: 30e3, fetchFn });
  return { model: cheap.id, usage: r.usage };
}
