// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Model makers' own APIs, with the user's own key (⚙ Settings → Providers): OpenAI, Anthropic, Google Gemini,
// Moonshot (Kimi) and Meta. Each runs as a source next to OpenRouter (sources.js), so a model id names where a call goes:
// openai-api/gpt-5-mini, anthropic-api/claude-sonnet-5-5, gemini-api/gemini-3.5-flash.
//   - Which models a key can use comes from the provider's own list (it needs the key, so listing them is the free key
//     check too). Names, limits and prices come from models.dev's entry for that provider; a model models.dev doesn't
//     know yet still shows, with its price unknown rather than guessed.
//   - Prices are guarded: a missing, negative or absurd price (over $1000 per M tokens) is unknown, never a huge figure.
//   - OpenAI, Gemini (its OpenAI-compatible endpoint), Moonshot and Meta take the OpenAI chat format: the same body as
//     OpenCode Go's (opencodego.js), read in OpenRouter's shape (openrouter.js). Anthropic takes its Messages API: the
//     call is translated as for Command Code's Claude models (commandcode.js).
//   - What a model needs back on its next step goes in qx_pass: Claude's signed thinking, Kimi's reasoning, Gemini's
//     thought signatures on its tool calls.
//   - Any of these models can also be a decider: it is asked the typed questions in plain words and answers with
//     probabilities in JSON, read into the shape OpenRouter's Decisions API answers in.
import { readChatStream } from './openrouter.js';
import { goBody } from './opencodego.js';
import { messagesBody, readMessagesStream } from './commandcode.js';

const MODELS_DEV = process.env.QX_MODELS_DEV || 'https://models.dev/api.json';

// What QuorX knows about each provider. `wire`: the chat format it takes. `dev`: its id on models.dev. `maker` and
// `or`: who makes its models, and that maker's name on OpenRouter (for the same model there).
export const DIRECT = {
  'openai-api': {
    name: 'OpenAI', short: 'OpenAI', wire: 'chat', base: 'https://api.openai.com/v1', dev: 'openai', maker: 'openai', or: ['openai'],
    env: ['OPENAI_API_KEY'], site: 'https://platform.openai.com', keyUrl: 'https://platform.openai.com/api-keys', docs: 'https://platform.openai.com/docs/api-reference/chat',
    keyHint: 'An API key from the OpenAI platform (platform.openai.com → API keys). It starts with sk-.',
  },
  'anthropic-api': {
    name: 'Anthropic', short: 'Anthropic', wire: 'messages', base: 'https://api.anthropic.com/v1', dev: 'anthropic', maker: 'anthropic', or: ['anthropic'],
    env: ['ANTHROPIC_API_KEY'], site: 'https://www.anthropic.com/api', keyUrl: 'https://console.anthropic.com/settings/keys', docs: 'https://docs.anthropic.com/en/api/messages',
    keyHint: 'An API key from the Claude Console (console.anthropic.com → API keys). It starts with sk-ant-.',
  },
  'gemini-api': {
    name: 'Google Gemini', short: 'Gemini', wire: 'chat', base: 'https://generativelanguage.googleapis.com/v1beta/openai', dev: 'google', maker: 'google', or: ['google'],
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], site: 'https://ai.google.dev', keyUrl: 'https://aistudio.google.com/apikey', docs: 'https://ai.google.dev/gemini-api/docs/openai',
    keyHint: 'A Gemini API key from Google AI Studio (aistudio.google.com → Get API key).',
  },
  'moonshot-api': {
    name: 'Moonshot (Kimi)', short: 'Kimi', wire: 'chat', base: 'https://api.moonshot.ai/v1', dev: 'moonshotai', maker: 'moonshotai', or: ['moonshotai'],
    env: ['MOONSHOT_API_KEY'], site: 'https://platform.moonshot.ai', keyUrl: 'https://platform.moonshot.ai/console/api-keys', docs: 'https://platform.moonshot.ai/docs/api/chat',
    keyHint: 'An API key from the Moonshot AI platform (platform.moonshot.ai → API keys).',
  },
  'meta-api': {
    name: 'Meta (Llama API)', short: 'Meta', wire: 'chat', base: 'https://api.meta.ai/v1', dev: 'meta', maker: 'meta', or: ['meta-llama', 'meta'],
    env: ['META_MODEL_API_KEY', 'LLAMA_API_KEY'], site: 'https://dev.meta.ai', keyUrl: 'https://dev.meta.ai', docs: 'https://dev.meta.ai/docs',
    keyHint: 'An API key from Meta’s developer platform. For the older Llama API, set the address to https://api.llama.com/compat/v1.',
  },
};
export const DIRECT_IDS = Object.keys(DIRECT);
export const isDirect = (id) => Object.hasOwn(DIRECT, String(id));

/** The address calls go to: the user's own (⚙ Settings) when it is a sane one, else the provider's. */
export function cleanBase(s) {
  const t = String(s || '').trim().replace(/\/+$/, '');
  if (!t || t.length > 300) return '';
  let u; try { u = new URL(t); } catch { return ''; }
  // https anywhere; plain http only to this computer (a local proxy, the tests' fake server).
  if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return t;
  return '';
}

// ---------- prices ----------
// Above this a price per M tokens is taken for a bad record, not a price: the dearest real ones are a few hundred.
export const PRICE_MAX = 1000;
const okPrice = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= PRICE_MAX;
/**
 * A models.dev cost record kept only where every figure is sane: input and output both needed; cache prices and
 * context tiers kept when they are sane themselves. null when the price isn't known.
 */
export function saneCost(c) {
  if (!c || typeof c !== 'object' || !okPrice(c.input) || !okPrice(c.output)) return null;
  const out = { input: Number(c.input), output: Number(c.output) };
  for (const k of ['cache_read', 'cache_write']) if (okPrice(c[k])) out[k] = Number(c[k]);
  const tiers = (Array.isArray(c.tiers) ? c.tiers : []).filter((t) => okPrice(t?.input) && okPrice(t?.output) && Number(t?.tier?.size) > 0)
    .map((t) => ({ input: Number(t.input), output: Number(t.output), ...(okPrice(t.cache_read) ? { cache_read: Number(t.cache_read) } : {}), ...(okPrice(t.cache_write) ? { cache_write: Number(t.cache_write) } : {}), tier: { type: 'context', size: Number(t.tier.size) } }));
  if (tiers.length) out.tiers = tiers;
  return out;
}

// ---------- model lists ----------
async function getJSON(url, { headers = {}, ms = 20000, fetchFn = fetch } = {}) {
  const r = await fetchFn(url, { headers: { 'User-Agent': 'QuorX', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw await failure(r, url);
  return r.json();
}
let devCache = null; // { at, p }: models.dev, kept an hour
function modelsDev(fetchJSON) {
  if (fetchJSON) return fetchJSON(MODELS_DEV).catch(() => null);
  if (devCache && Date.now() - devCache.at < 3600e3) return devCache.p;
  const p = getJSON(MODELS_DEV).catch(() => null);
  devCache = { at: Date.now(), p };
  p.then((v) => { if (!v) devCache = null; });
  return p;
}
const nice = (id) => String(id).replace(/^models\//, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// A dated snapshot (claude-haiku-4-5-20251001, gpt-5-2025-08-07) takes its family's record when it has none of its own.
const undated = (id) => String(id).replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-(latest)$/, '');
// What OpenAI's list has that answers no chat call: pictures, voices, embeddings, moderation, the Responses-only models.
const NOT_CHAT = /embed|tts|whisper|dall-e|image|realtime|audio|transcribe|moderation|davinci|babbage|sora|computer-use|search|deep-research|live|lyria|veo|imagen|aqa/i;
const RESPONSES_ONLY = /(^|-)pro($|-)|codex/i; // OpenAI's that answer only on its Responses API

/** One provider's model as a catalogue entry like the other sources' (`<source>/<model>`). */
export function directEntry(src, live = {}, md = null) {
  const def = DIRECT[src], id = String(live.id || md?.id || '').replace(/^models\//, '');
  const cost = saneCost(md?.cost);
  const opts = Array.isArray(md?.reasoning_options) ? md.reasoning_options : [];
  const effort = opts.find((o) => o?.type === 'effort' && Array.isArray(o.values));
  const canon = String(md?.canonical_model_id || '');
  const created = Number(live.created) > 1e9 ? Number(live.created) : Date.parse(live.created_at || md?.release_date || '') / 1000 || 0;
  return {
    id: `${src}/${id}`, realId: id, modelID: id, providerID: src, source: src, maker: canon.includes('/') ? canon.split('/')[0] : def.maker,
    wire: def.wire, name: md?.name || live.display_name || live.displayName || nice(id), kind: 'chat',
    ctx: md?.limit?.context || Number(live.inputTokenLimit) || Number(live.context_length) || Number(live.max_input_tokens) || null,
    maxOut: md?.limit?.output || Number(live.outputTokenLimit) || Number(live.max_tokens) || null, created: Math.floor(created) || 0,
    in: (md?.modalities?.input || ['text']).filter((x) => x === 'text' || x === 'image'), out: ['text'],
    // Paid per call at the provider's price; unknown when models.dev has none (or none that is sane).
    price: cost ? [cost.input, cost.output] : [0, 0], cost: cost || {}, plan: 'paid', ...(cost ? {} : { priceUnknown: true }),
    tools: md ? md.tool_call !== false : true, temp: md ? md.temperature !== false : true, reasoning: !!md?.reasoning,
    efforts: effort ? effort.values.map(String) : [], budget: opts.some((o) => o?.type === 'budget_tokens'),
    interleaved: md?.interleaved && typeof md.interleaved === 'object' ? md.interleaved.field || null : null,
    status: md?.status === 'deprecated' ? 'deprecated' : null, canonical: canon || null,
    desc: String(md?.description || live.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}
// The provider's own list, with the key: OpenAI's shape ({ data: [{ id }] }) everywhere but Gemini (its own API names
// each model's methods and limits) and Anthropic (paged, with display names).
async function liveList(src, { key, base, fetchFn }) {
  const def = DIRECT[src], b = base || def.base;
  if (src === 'anthropic-api') {
    const out = [];
    let after = '';
    for (let page = 0; page < 10; page++) {
      const j = await getJSON(`${b}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: authHeaders(src, key), fetchFn });
      out.push(...(Array.isArray(j?.data) ? j.data : []));
      if (!j?.has_more || !j.last_id) break;
      after = j.last_id;
    }
    return out;
  }
  if (src === 'gemini-api' && /\/openai$/.test(b)) {
    const j = await getJSON(`${b.replace(/\/openai$/, '')}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, fetchFn });
    return (Array.isArray(j?.models) ? j.models : []).filter((m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({ ...m, id: String(m.name || '').replace(/^models\//, '') }));
  }
  const j = await getJSON(`${b}/models`, { headers: authHeaders(src, key), fetchFn });
  return Array.isArray(j?.data) ? j.data : [];
}
/**
 * The models a key can use on one provider. `fetchFn`/`fetchJSON` are for tests. One that answers in something other
 * than text, or doesn't take chat calls, is left out.
 */
export async function directModels(src, { key, base, fetchFn = fetch, fetchJSON } = {}) {
  if (!key) throw Object.assign(new Error(`Add your ${DIRECT[src].name} key first.`), { kind: 'auth' });
  const [live, dev] = await Promise.all([liveList(src, { key, base, fetchFn }), modelsDev(fetchJSON)]);
  const info = dev?.[DIRECT[src].dev]?.models || {};
  const out = [], seen = new Set();
  for (const m of live) {
    const id = String(m?.id || '').replace(/^models\//, '');
    if (!/^[\w.:@+/-]{1,120}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const md = Object.hasOwn(info, id) ? info[id] : Object.hasOwn(info, undated(id)) ? info[undated(id)] : null;
    if (md && Array.isArray(md.modalities?.output) && !md.modalities.output.includes('text')) continue;
    if (!md?.tool_call && NOT_CHAT.test(id) && src !== 'anthropic-api') continue;
    if (src === 'openai-api' && (NOT_CHAT.test(id) || RESPONSES_ONLY.test(id))) continue; // even with a record
    try { out.push(directEntry(src, m, md)); } catch { /* one odd entry */ }
  }
  return out;
}

// ---------- one call ----------
function authHeaders(src, key) {
  if (src === 'anthropic-api') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}
// Their errors come as OpenAI's { error: { message, type, code } }, Anthropic's { type: "error", error }, or Google's
// [{ error: { code, message, status } }].
const CODE_KIND = { invalid_api_key: 'auth', authentication_error: 'auth', permission_error: 'auth', unauthenticated: 'auth', permission_denied: 'auth', insufficient_quota: 'quota', billing_error: 'quota',
  rate_limit_exceeded: 'rate', rate_limit_error: 'rate', resource_exhausted: 'rate', model_not_found: 'model', not_found_error: 'model', not_found: 'model', overloaded_error: 'server', api_error: 'server', unavailable: 'server', internal: 'server' };
export async function failure(r, where = '') {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  if (Array.isArray(j)) j = j[0];
  const e = j?.error && typeof j.error === 'object' ? j.error : {};
  const msg = String(e.message || j?.message || t.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${r.status}`).slice(0, 400);
  const errorType = [e.code, e.type, e.status].find((x) => typeof x === 'string') || undefined;
  const kind = CODE_KIND[String(errorType || '').toLowerCase()]
    || (/api key not valid|incorrect api key|invalid (credential|api[ _-]?key|x-api-key|authentication)|unauthori[sz]ed/i.test(msg) ? 'auth'
      : /credit balance is too low|exceeded your current quota|billing/i.test(msg) ? 'quota' : undefined);
  const host = (() => { try { return new URL(where || r.url || '').host; } catch { return ''; } })();
  return Object.assign(new Error(`${host ? `${host}: ` : ''}${msg}`), { status: r.status, errorType, retryAfter: Number(r.headers?.get?.('retry-after')) || 0, ...(kind ? { kind } : {}) });
}
// The stream's chunks, with a limit on how long it may go quiet: a call that stops sending fails instead of hanging.
async function* quietLimit(body, ms, ac, name) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`${name} sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}
/** The chat-format request for one of QuorX's calls, with each provider's own differences. */
export function directChatBody(src, body, info = {}) {
  // Gemini's thought signatures go back on the tool calls they came with.
  const msgs = src !== 'gemini-api' ? body.messages : (body.messages || []).map((m) => {
    const sig = m?.role === 'assistant' && m.qx_pass?.gemini_sigs;
    if (!sig || !Array.isArray(m.tool_calls)) return m;
    return { ...m, tool_calls: m.tool_calls.map((c) => (sig[c?.id] ? { ...c, extra_content: { google: { thought_signature: sig[c.id] } } } : c)) };
  });
  const out = goBody({ ...body, messages: msgs }, info);
  if (src === 'openai-api' && out.max_tokens !== undefined) { out.max_completion_tokens = out.max_tokens; delete out.max_tokens; }
  if (src === 'gemini-api') { delete out.seed; delete out.parallel_tool_calls; }
  if (src === 'moonshot-api' && out.temperature !== undefined) out.temperature = Math.max(0, Math.min(1, out.temperature));
  return out;
}
/**
 * One streamed call to a provider, read into openrouter.js chatStream's result shape. Throws with
 * .status/.errorType/.kind when it refuses (sources.js classifies it).
 */
export async function directStream(src, body, signal, onText, onThink, { info = {}, idleMs = 180e3, key, base, fetchFn = fetch } = {}) {
  const def = DIRECT[src];
  if (!key) throw Object.assign(new Error(`There is no ${def.name} key yet: add one in ⚙ Settings → Providers.`), { kind: 'auth' });
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now(), b = base || def.base, messages = def.wire === 'messages';
  const real = info.realId || String(body.model || '').slice(src.length + 1);
  const post = (req) => fetchFn(`${b}${messages ? '/messages' : '/chat/completions'}`, { method: 'POST', signal: ac.signal, headers: { ...authHeaders(src, key), 'Content-Type': 'application/json', 'User-Agent': 'QuorX' }, body: JSON.stringify(req) });
  try {
    let req = messages ? messagesBody(body, { ...info, realId: real }) : directChatBody(src, body, { ...info, realId: real });
    let r = await post(req);
    // An older Claude model that takes no thinking display goes again without it.
    if (!r.ok && messages && r.status === 400 && req.thinking?.display) {
      const e = await failure(r, b);
      if (!/display/i.test(e.message)) throw e;
      req = { ...req, thinking: { type: 'adaptive' } };
      r = await post(req);
    }
    if (!r.ok) throw await failure(r, b);
    const s = { body: quietLimit(r.body, idleMs, ac, def.name) };
    const out = messages ? await readMessagesStream(s, body, t, onText, onThink) : await readChatStream(s, body, t, onText, onThink);
    if (!out.seen) throw Object.assign(new Error(`${def.name} answered with an empty stream`), { kind: 'shape' });
    out.provider = def.name;
    out.model = body.model;
    // Cached tokens as costOf reads them (Moonshot names them at the top of its usage).
    if (out.usage && Number(out.usage.cached_tokens) > 0 && !out.usage.prompt_tokens_details?.cached_tokens) out.usage.prompt_tokens_details = { ...(out.usage.prompt_tokens_details || {}), cached_tokens: Number(out.usage.cached_tokens) };
    // What the model needs back on its next step (agent.js qx_pass).
    const sigs = {};
    for (const c of out.toolCalls) { const g = c.extra_content?.google?.thought_signature; if (g && c.id) sigs[c.id] = g; delete c.extra_content; }
    if (messages && out.thinkingBlocks?.length) out.passBack = { cc_thinking: out.thinkingBlocks };
    else if (Object.keys(sigs).length) out.passBack = { gemini_sigs: sigs };
    else if (info.interleaved && out.thinking) out.passBack = { [info.interleaved]: out.thinking };
    delete out.thinkingBlocks;
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw Object.assign(ac.signal.reason, { partial: e?.partial });
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}

// ---------- deciders ----------
// A decider's id: the source, "decider", and the model (openai-api/decider/gpt-5-mini), apart from the chat model's.
export const deciderId = (src, realId) => `${src}/decider/${realId}`;
export const deciderReal = (model) => { const m = /^[a-z-]+\/decider\/(.+)$/.exec(String(model || '')); return m ? m[1] : null; };
/** A provider's chat models as decider models: they answer typed questions in JSON (directDecisions). */
export function directDeciders(list = []) {
  return list.filter((m) => m.kind === 'chat' && m.status !== 'deprecated').map((m) => ({
    ...m, id: deciderId(m.source, m.realId), kind: 'decision', out: ['decisions'], tools: false, chatDecider: true, chatId: m.id,
    desc: `${m.name} on your ${DIRECT[m.source]?.name || m.source} key, asked the questions in plain words: it answers with probabilities in JSON. Slower than a decision model; billed per call at its price.`,
  }));
}
const qText = (id, q) => {
  if (q.type === 'noul') return `"${id}" (yes/no): ${q.instructions}\n  keys: "yes", "no"`;
  if (q.type === 'score') return `"${id}" (score): ${q.instructions}\n  keys: ${(q.criteria || []).map((l, i) => `"${i}" = ${l}`).join('; ')}`;
  return `"${id}" (choice): ${q.instructions}\n  keys: ${Object.entries(q.criteria || {}).map(([k, v]) => `"${k}" = ${v}`).join('; ')}`;
};
const keysFor = (q) => (q.type === 'noul' ? ['yes', 'no'] : q.type === 'score' ? (q.criteria || []).map((_, i) => String(i)) : Object.keys(q.criteria || {}));
/** The answers in a decider's reply, as probabilities per question that add up to 1 (a question it skipped is left out). */
export function readDecisions(text, questions) {
  const s = String(text || ''), a = s.indexOf('{'), z = s.lastIndexOf('}');
  let j = null; try { j = JSON.parse(s.slice(a, z + 1)); } catch { /* not JSON */ }
  const got = j?.answers && typeof j.answers === 'object' ? j.answers : j || {};
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const v = got[id]?.probabilities || got[id];
    if (!v || typeof v !== 'object') continue;
    const keys = keysFor(q), p = keys.map((k) => { const n = Number(v[k]); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e6) : 0; });
    const sum = p.reduce((x, y) => x + y, 0);
    if (!(sum > 0)) continue;
    answers[id] = { probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i] / sum])) };
  }
  return answers;
}
/**
 * One decision request to a chat model: the state and the questions in, probabilities out, answered like
 * openrouter.js decisions(). `stream` makes the call (sources.js passes the provider's stream with its key).
 */
export async function directDecisions(info, state, questions, signal, { stream }) {
  const parts = [];
  for (const x of [].concat(state)) {
    if (typeof x === 'string') parts.push({ type: 'text', text: x });
    else if (x?.type === 'image_url' && (info.in || []).includes('image')) parts.push(x);
    else if (x && typeof x === 'object' && x.type !== 'image_url') parts.push({ type: 'text', text: `Context: ${JSON.stringify(x)}` });
  }
  parts.push({ type: 'text', text: `Questions:\n${Object.entries(questions).map(([id, q]) => qText(id, q)).join('\n')}\n\nFor every question give a probability for each of its keys (they add up to 1), calibrated: 0.5 when you can't tell. Reply with JSON only, no other text: {"answers": {"<question id>": {"<key>": <probability>, ...}, ...}}` });
  const r = await stream({
    model: info.chatId, max_tokens: 800, temperature: 0, reasoning: { effort: 'low' },
    messages: [{ role: 'system', content: 'You are a careful, calibrated judge. You never write prose: you answer typed questions with probabilities in JSON.' }, { role: 'user', content: parts }],
  }, signal);
  const answers = readDecisions(r.text, questions);
  if (!Object.keys(answers).length) throw Object.assign(new Error(`${info.name} gave no answers QuorX could read`), { kind: 'shape' });
  return { answers, usage: r.usage || {}, ms: r.ms, provider: r.provider, resolved: info.chatId };
}
