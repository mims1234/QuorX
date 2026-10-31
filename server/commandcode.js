// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Command Code over its Provider API, with the user's own key (⚙ Settings → Providers). Every Command Code plan but Go
// has API access, and a call takes from the plan's credits at the model's list price
// (https://commandcode.ai/docs/provider).
//   - Which models it serves today comes from its own list (GET /provider/v1/models, no key needed), which also says
//     which endpoint each one answers on. Names, limits and list prices come from models.dev's entry for Command Code;
//     a model models.dev doesn't know yet still shows, without prices.
//   - Most models answer on the OpenAI chat endpoint: the same body as OpenCode Go's (opencodego.js), read in
//     OpenRouter's shape (openrouter.js). Claude models answer only on the Anthropic Messages endpoint: the call is
//     translated here (messages, tool calls and results, pictures, cache marks, thinking and effort) and its stream
//     read back into the same shape, so the agent can't tell the two apart.
//   - A Claude model's thinking blocks go back unchanged on its own next step (qx_pass), as Anthropic asks of a
//     tool-calling turn.
import { readChatStream } from './openrouter.js';
import { goBody, effortFor } from './opencodego.js';

export const CC_ID = 'commandcode';
const BASE = process.env.QX_COMMANDCODE_BASE || 'https://api.commandcode.ai/provider/v1';
const MODELS_DEV = process.env.QX_MODELS_DEV || 'https://models.dev/api.json';

async function getJSON(url, ms = 20000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} said HTTP ${r.status}`), { status: r.status });
  return r.json();
}
const per = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const nice = (id) => String(id).split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// Who made it, for the picker's makers filter: the vendor in the id (deepseek/deepseek-v4-pro), else the family.
const makerOf = (id, canon) => (canon.includes('/') ? canon.split('/')[0] : id.includes('/') ? id.split('/')[0].toLowerCase() : /^claude/i.test(id) ? 'anthropic' : /^gpt|^o\d/i.test(id) ? 'openai' : /^gemini/i.test(id) ? 'google' : null);

/** One Command Code model as a catalogue entry like the others (commandcode/<model>), from its list and models.dev's entry. */
export function ccEntry(live, md = null) {
  const id = String(live?.id || md?.id || '');
  const eps = Array.isArray(live?.supported_endpoints) ? live.supported_endpoints : [];
  const c = md?.cost || {}, list = [per(c.input), per(c.output)];
  const canon = String(md?.canonical_model_id || '');
  const opts = Array.isArray(md?.reasoning_options) ? md.reasoning_options : [];
  const effort = opts.find((o) => o?.type === 'effort' && Array.isArray(o.values));
  const maker = makerOf(id, canon);
  return {
    id: `${CC_ID}/${id}`, realId: id, modelID: id, providerID: CC_ID, source: CC_ID,
    ...(maker ? { maker } : {}),
    // Claude models answer only on the Messages endpoint; the rest on the OpenAI chat endpoint.
    wire: eps.includes('/chat/completions') || !eps.includes('/messages') ? 'chat' : 'messages',
    name: md?.name || live?.name || nice(id), kind: 'chat', ctx: md?.limit?.context || live?.context_length || null, maxOut: md?.limit?.output || null,
    created: md?.release_date ? Math.floor(Date.parse(md.release_date) / 1000) || 0 : 0,
    in: (md?.modalities?.input || ['text']).filter((x) => x === 'text' || x === 'image'), out: ['text'],
    // Nothing to pay per call: the list price is what a call takes from the plan's credits.
    price: [0, 0], listPrice: list, cost: c, plan: 'plan',
    tools: md ? md.tool_call !== false : true, temp: md?.temperature !== false, reasoning: !!md?.reasoning,
    efforts: effort ? effort.values.map(String) : [], budget: opts.some((o) => o?.type === 'budget_tokens'),
    interleaved: md?.interleaved && typeof md.interleaved === 'object' ? md.interleaved.field || null : null,
    status: md?.status === 'deprecated' ? 'deprecated' : null, canonical: canon || null,
    desc: String(md?.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}
/**
 * The models Command Code serves now. `fetchJSON` is for tests. One that answers on neither the chat nor the Messages
 * endpoint (its decision models) or doesn't answer in text is left out.
 */
export async function ccModels({ fetchJSON = getJSON } = {}) {
  const [live, dev] = await Promise.all([fetchJSON(`${BASE}/models`), fetchJSON(MODELS_DEV).catch(() => null)]);
  const info = dev?.[CC_ID]?.models || {};
  const out = [], seen = new Set();
  for (const m of Array.isArray(live?.data) ? live.data : []) {
    const id = String(m?.id || '');
    if (!/^[\w.:@+/-]{1,120}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const eps = Array.isArray(m.supported_endpoints) ? m.supported_endpoints : ['/chat/completions'];
    if (!eps.includes('/chat/completions') && !eps.includes('/messages')) continue;
    const md = Object.hasOwn(info, id) ? info[id] : null;
    if (md && Array.isArray(md.modalities?.output) && !md.modalities.output.includes('text')) continue;
    try { out.push(ccEntry(m, md)); } catch { /* one odd entry */ }
  }
  return out;
}

// ---------- the Messages endpoint (Claude models) ----------
// One part of an OpenAI-shaped message as Anthropic content blocks. Audio and file parts are left out: the endpoint
// refuses them.
function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => {
    if (!p || typeof p !== 'object') return [];
    if (p.type === 'text') return typeof p.text === 'string' && p.text ? [{ type: 'text', text: p.text }] : [];
    if (p.type === 'image_url') {
      const u = String((typeof p.image_url === 'string' ? p.image_url : p.image_url?.url) || '');
      const d = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(u);
      return d ? [{ type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } }] : /^https?:/i.test(u) ? [{ type: 'image', source: { type: 'url', url: u } }] : [];
    }
    return [];
  });
}
const argsOf = (s) => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
/**
 * The conversation as the Messages endpoint takes it: the opening system messages as `system`; tool calls as tool_use
 * blocks and their results as tool_result blocks in the next user turn; a Claude model's thinking from its own
 * earlier step in front of its calls. Each tool call gets an answer (a result the stream never had is "not run"), the
 * first turn is the user's and the last is never the assistant's (Claude takes no prefill).
 */
export function toMessages(msgs = []) {
  const system = [], out = [];
  const add = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: [...blocks] });
  };
  let opening = true;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const b = blocksOf(m.content).filter((x) => x.type === 'text');
      if (opening) system.push(...b); else add('user', b.map((x) => ({ type: 'text', text: `[System note]\n${x.text}` })));
      continue;
    }
    opening = false;
    if (m.role === 'assistant') {
      const think = Array.isArray(m.qx_pass?.cc_thinking) ? m.qx_pass.cc_thinking.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')) : [];
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter((c) => c?.function?.name).map((c, i) => ({ type: 'tool_use', id: String(c.id || `call_${out.length}_${i}`), name: c.function.name, input: argsOf(c.function.arguments) }));
      add('assistant', [...(calls.length ? think : []), ...blocksOf(m.content), ...calls]);
    } else if (m.role === 'tool') {
      const b = blocksOf(m.content);
      add('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: b.length ? b : '(no output)' }]);
    } else add('user', blocksOf(m.content));
  }
  // Every tool_use has its result at the top of the next user turn; a result for no call goes as text.
  const asText = (b) => ({ type: 'text', text: `[Tool result]\n${typeof b.content === 'string' ? b.content : b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n')}` });
  for (let i = 0; i < out.length; i++) {
    const ids = out[i].role === 'assistant' ? out[i].content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [];
    if (out[i].role === 'user' && out[i - 1]?.role !== 'assistant') out[i].content = out[i].content.map((b) => (b.type === 'tool_result' ? asText(b) : b));
    if (out[i].role !== 'assistant') continue;
    let next = out[i + 1];
    if (!ids.length && next?.role !== 'user') continue;
    if (!next || next.role !== 'user') { next = { role: 'user', content: [] }; out.splice(i + 1, 0, next); }
    const mine = (b) => b.type === 'tool_result' && ids.includes(b.tool_use_id);
    const results = next.content.filter(mine);
    const rest = next.content.filter((b) => !mine(b)).map((b) => (b.type === 'tool_result' ? asText(b) : b));
    const missing = ids.filter((id) => !results.some((b) => b.tool_use_id === id)).map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'Not run.', is_error: true }));
    next.content = [...ids.map((id) => results.find((b) => b.tool_use_id === id)).filter(Boolean), ...missing, ...rest];
    i++; // the user turn after it is settled
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing)' }] });
  if (out[out.length - 1]?.role === 'assistant' || !out.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  return { system, messages: out };
}
// Cache marks (four at most): the tools, the system prompt, and the last two user turns, so each step reads the one
// before it from the cache.
function markCache(req) {
  const mark = (b) => { if (b && b.type !== 'thinking' && b.type !== 'redacted_thinking') b.cache_control = { type: 'ephemeral' }; };
  if (req.tools?.length) mark(req.tools[req.tools.length - 1]);
  if (req.system?.length) mark(req.system[req.system.length - 1]);
  const users = req.messages.filter((m) => m.role === 'user').slice(-2);
  for (const m of users) mark(m.content[m.content.length - 1]);
}
const BUDGET = { minimal: 1024, low: 2048, medium: 8000, high: 16000, xhigh: 24000, max: 32000 };
/** The Messages request for one of QuorX's calls (openrouter.js's shape in). */
export function messagesBody(body, info = {}) {
  const s = String(body.model || ''), model = info.realId || (s.startsWith(`${CC_ID}/`) ? s.slice(CC_ID.length + 1) : s);
  const { system, messages } = toMessages(body.messages);
  const cap = Number(info.maxOut) || 64000;
  const out = { model, max_tokens: Math.min(cap, Number(body.max_tokens) || Math.min(cap, 32000)), messages, stream: true };
  if (system.length) out.system = system;
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.function?.name);
  if (tools.length) {
    out.tools = tools.map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), input_schema: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} } }));
    // Forced tool use is refused by the newest Claude models: the prompt asks for the call instead.
    out.tool_choice = body.tool_choice === 'none' ? { type: 'none' } : { type: 'auto', ...(body.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}) };
  }
  if (Array.isArray(body.stop) ? body.stop.length : body.stop) out.stop_sequences = [].concat(body.stop).map(String).slice(0, 4);
  const off = body.reasoning?.enabled === false;
  if (info.efforts?.length) {
    // Thinking on (shown as a summary), at the effort the call asks for; off is the lowest effort (the newest models
    // can't turn it off).
    if (!off) out.thinking = { type: 'adaptive', display: 'summarized' };
    const e = off ? (info.efforts.includes('low') ? 'low' : info.efforts[0]) : effortFor(body.reasoning, info.efforts);
    if (e) out.output_config = { effort: e };
  } else if (info.budget && body.reasoning && !off) {
    const b = Math.max(1024, Math.min(Number(body.reasoning.max_tokens) || BUDGET[body.reasoning.effort] || 8000, cap - 1024));
    out.thinking = { type: 'enabled', budget_tokens: b };
    out.max_tokens = Math.min(cap, Math.max(out.max_tokens, b + 4096));
  }
  if (!out.thinking && info.temp !== false && !info.efforts?.length && body.temperature !== undefined) out.temperature = body.temperature;
  markCache(out);
  return out;
}
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter', pause_turn: 'stop' };
/** A Messages stream read into openrouter.js chatStream's result shape, with the thinking blocks to pass back. */
export async function readMessagesStream(r, body, t, onText, onThink) {
  const dec = new TextDecoder();
  let buf = '', text = '', thinking = '', firstMs = null, finish = null, model = null, genId = null, seen = 0, refusal = null;
  const u = {}, blocks = [], calls = [];
  const sofar = () => ({ id: genId, model: model || body.model, outChars: text.length + thinking.length + calls.reduce((n, c) => n + (c?.function.arguments.length || 0), 0), ms: Date.now() - t });
  const use = (x) => { for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (Number.isFinite(Number(x?.[k]))) u[k] = Number(x[k]); };
  const line = (raw) => {
    const s = raw.trim();
    if (!s.startsWith('data:')) return;
    let j; try { j = JSON.parse(s.slice(5).trim()); } catch { return; }
    seen++;
    if (j.type === 'error') throw Object.assign(new Error(j.error?.message || 'stream error'), { streamStatus: j.error?.type === 'overloaded_error' ? 529 : null, errorType: j.error?.type });
    if (j.type === 'message_start') { genId = j.message?.id || null; model = j.message?.model || null; use(j.message?.usage); return; }
    if (j.type === 'message_delta') { if (j.delta?.stop_reason) finish = j.delta.stop_reason; if (j.delta?.stop_details) refusal = j.delta.stop_details; use(j.usage); return; }
    const i = j.index;
    if (j.type === 'content_block_start') {
      const b = j.content_block || {};
      if (b.type === 'tool_use') calls[i] = { id: b.id || '', type: 'function', function: { name: b.name || '', arguments: '' } };
      else if (b.type === 'thinking') blocks[i] = { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' };
      else if (b.type === 'redacted_thinking') blocks[i] = { type: 'redacted_thinking', data: b.data || '' };
      return;
    }
    if (j.type !== 'content_block_delta') return;
    const d = j.delta || {};
    if (d.type === 'text_delta' && d.text) { if (firstMs == null) firstMs = Date.now() - t; text += d.text; onText?.(d.text); }
    else if (d.type === 'thinking_delta' && d.thinking) { thinking += d.thinking; onThink?.(d.thinking); if (blocks[i]) blocks[i].thinking += d.thinking; }
    else if (d.type === 'signature_delta' && blocks[i]) blocks[i].signature += d.signature || '';
    else if (d.type === 'input_json_delta' && calls[i]) calls[i].function.arguments += d.partial_json || '';
  };
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, k); buf = buf.slice(k + 1); line(s); }
    }
    if (buf) line(buf);
  } catch (e) {
    if (e && typeof e === 'object' && !Object.keys(u).length) { try { e.partial = sofar(); } catch { /* a frozen error carries nothing */ } }
    throw e;
  }
  const toolCalls = calls.filter(Boolean).map((c) => (c.function.arguments ? c : { ...c, function: { ...c.function, arguments: '{}' } }));
  if (finish === 'refusal' && !text && !toolCalls.length) throw Object.assign(new Error(`the model declined to answer${refusal?.category ? ` (${refusal.category})` : ''}${refusal?.explanation ? `: ${refusal.explanation}` : ''}`), { kind: 'request' });
  const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
  const usage = Object.keys(u).length ? { prompt_tokens: (u.input_tokens || 0) + read + write, completion_tokens: u.output_tokens || 0, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } } : {};
  return { text, thinking, reasoningDetails: [], toolCalls, usage, ms: Date.now() - t, firstMs, finishReason: FINISH[finish] || finish, provider: null, model, seen,
    thinkingBlocks: blocks.filter((b) => b && (b.type === 'redacted_thinking' ? b.data : b.signature)), ...(Object.keys(usage).length ? {} : { partial: sofar() }) };
}

// ---------- one call ----------
// Its errors come in OpenAI's envelope ({ error: { message, type, code } }) or Anthropic's ({ type: "error", error }).
const CODE_KIND = { upgrade_required: 'auth', authentication_error: 'auth', unauthorized: 'auth', unsupported_model: 'model', model_region_unavailable: 'setting', content_policy_refused: 'request', upstream_refused: 'request', request_too_large: 'request', cmd_zdr_no_providers: 'setting', rate_limit_error: 'rate', model_temporarily_unavailable: 'server', upstream_unavailable: 'server', overloaded_error: 'server' };
async function failure(r) {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  const e = j?.error && typeof j.error === 'object' ? j.error : {};
  let msg = e.message || j?.message || t.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${r.status}`;
  const errorType = typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined;
  if (errorType === 'upgrade_required') msg = `${msg} (the Go plan has no API access: GOAT, Pro, Max, Teams or Provider does)`;
  const kind = CODE_KIND[String(errorType || '').toLowerCase()] || (/invalid (credential|api key)|unauthori[sz]ed/i.test(msg) ? 'auth' : undefined);
  return Object.assign(new Error(`Command Code: ${msg}`), { status: r.status, errorType, retryAfter: Number(r.headers.get('retry-after')) || 0, ...(kind ? { kind } : {}) });
}
// The stream's chunks, with a limit on how long it may go quiet: a call that stops sending fails instead of hanging.
async function* quietLimit(body, ms, ac) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`Command Code sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}
/**
 * One streamed call to Command Code, read into openrouter.js chatStream's result shape. `key` is the user's Command Code
 * key. Throws with .status/.errorType/.kind when it refuses (sources.js classifies it).
 */
export async function ccStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, key, fetchFn = fetch } = {}) {
  if (!key) throw Object.assign(new Error('There is no Command Code key yet: add one in ⚙ Settings → Providers.'), { kind: 'auth' });
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now();
  const claude = (info.wire || (/^claude/i.test(info.realId || '') ? 'messages' : 'chat')) === 'messages';
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'QuorX', ...(claude ? { 'anthropic-version': '2023-06-01' } : {}) };
  const post = (req) => fetchFn(`${BASE}${claude ? '/messages' : '/chat/completions'}`, { method: 'POST', signal: ac.signal, headers, body: JSON.stringify(req) });
  try {
    let req = claude ? messagesBody(body, info) : goBody(body, info);
    let r = await post(req);
    // An older Claude model that takes no thinking display goes again without it.
    if (!r.ok && claude && r.status === 400 && req.thinking?.display) {
      const e = await failure(r);
      if (!/display/i.test(e.message)) throw e;
      req = { ...req, thinking: { type: 'adaptive' } };
      r = await post(req);
    }
    if (!r.ok) throw await failure(r);
    const src = { body: quietLimit(r.body, idleMs, ac) };
    const out = claude ? await readMessagesStream(src, body, t, onText, onThink) : await readChatStream(src, body, t, onText, onThink);
    if (!out.seen) throw Object.assign(new Error('Command Code answered with an empty stream'), { kind: 'shape' });
    out.provider = 'Command Code';
    out.model = body.model;
    // What the model needs back on its next step (agent.js qx_pass): a Claude model's signed thinking blocks, or the
    // reasoning of a model with interleaved thinking.
    if (claude && out.thinkingBlocks?.length) out.passBack = { cc_thinking: out.thinkingBlocks };
    else if (!claude && info.interleaved && out.thinking) out.passBack = { [info.interleaved]: out.thinking };
    delete out.thinkingBlocks;
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw Object.assign(ac.signal.reason, { partial: e?.partial });
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}
// ---------- decision models (Jev) ----------
// TypeSafe's Jev answers on /systemone in the same shape as OpenRouter's Decisions API (a state and typed questions in;
// a probability or a distribution per question out). Command Code's model list doesn't name it, so its docs do.
export const JEV = [{ id: 'typesafe/jev', name: 'Jev (newest)' }, { id: 'typesafe/jev-1.14.0', name: 'Jev 1.14.0' }];
/**
 * Command Code's decision models as catalogue entries (commandcode/typesafe/jev). `orList` is OpenRouter's decision
 * catalogue: the same Jev's price there is the list price a call takes from the plan's credits.
 */
export function ccDecisionModels(orList = []) {
  const or = orList.find((m) => /^typesafe\/jev/.test(m?.id || '') && (m.price?.[0] || m.price?.[1]));
  return JEV.map((j) => ({
    id: `${CC_ID}/${j.id}`, realId: j.id, modelID: j.id, providerID: CC_ID, source: CC_ID, maker: 'typesafe',
    name: j.name, kind: 'decision', ctx: 64000, maxOut: null, created: 0, in: ['text'], out: ['decisions'],
    price: [0, 0], listPrice: or ? or.price.slice(0, 2) : [0, 0], cost: or ? { input: or.price[0], output: or.price[1] } : {}, plan: 'plan',
    tools: false, temp: false, reasoning: false, desc: 'TypeSafe’s Jev decision model on your Command Code plan: yes/no, choice and score questions about one state.',
  }));
}
/** One Decisions request to Jev on Command Code, answered like openrouter.js decisions(). */
export async function ccDecisions(model, state, questions, signal, { key, fetchFn = fetch } = {}) {
  if (!key) throw Object.assign(new Error('There is no Command Code key yet: add one in ⚙ Settings → Providers.'), { kind: 'auth' });
  const s = String(model || ''), id = s.startsWith(`${CC_ID}/`) ? s.slice(CC_ID.length + 1) : s;
  const t = Date.now();
  const r = await fetchFn(`${BASE}/systemone`, { method: 'POST', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'QuorX' }, body: JSON.stringify({ model: id, state, questions }) });
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  if (!j || typeof j.answers !== 'object') throw Object.assign(new Error('Command Code answered a decision in a shape QuorX can’t read'), { kind: 'shape' });
  return { answers: j.answers, usage: { prompt_tokens: Number(j.usage?.input_tokens) || 0, completion_tokens: Number(j.usage?.output_tokens) || 0 }, ms: Date.now() - t, provider: 'Command Code', resolved: j.model || id };
}

// ---------- the plan and what is left of it ----------
// The plan's name from its id (goat_monthly, max_20x, …); Go has no API access, so a key on it never gets this far.
export function planName(id) {
  const s = String(id || '').toLowerCase();
  return /enterprise/.test(s) ? 'Enterprise' : /provider/.test(s) ? 'Provider' : /team/.test(s) ? 'Teams' : /max/.test(s) ? (/20/.test(s) ? 'Max 20×' : 'Max 10×')
    : /goat/.test(s) ? 'GOAT' : /pro/.test(s) ? 'Pro' : /go/.test(s) ? 'Go' : s && s !== 'free' ? s.replace(/[_-]+/g, ' ') : 'Free';
}
const usd = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) < 1e6 ? Math.round(Number(x) * 1e4) / 1e4 : 0);
const win = (w) => (w && typeof w === 'object' && Number(w.cap) > 0 ? { used: usd(w.used), cap: usd(w.cap), exceeded: !!w.exceeded, resetAt: Number(w.resetAt) > 0 ? Number(w.resetAt) : null } : null);
/**
 * The plan a key is on and what is left of it, from the endpoints Command Code's own usage tools read (not in its
 * public docs, so any field may be missing): the plan and its period, the credits left (the month's, bought and free)
 * and the 5-hour and weekly windows. The plan's monthly allowance isn't given, so none is guessed.
 */
export async function ccAccount(key, { fetchFn = fetch } = {}) {
  if (!key) throw Object.assign(new Error('Add your Command Code key first.'), { kind: 'auth' });
  const root = BASE.replace(/\/provider\/v1$/, '');
  const get = async (p) => {
    const r = await fetchFn(`${root}${p}`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'QuorX' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw await failure(r);
    return r.json();
  };
  const [sub, cr] = await Promise.all([get('/alpha/billing/subscriptions'), get('/alpha/billing/credits')]);
  const d = sub?.data || {}, c = cr?.credits || {}, w = cr?.windowLimits || {};
  const credits = { monthly: usd(c.monthlyCredits), purchased: usd(c.purchasedCredits), free: usd(c.freeCredits) };
  const out = {
    planId: String(d.planId || 'free'), plan: planName(d.planId), status: String(d.status || 'none'),
    periodEnd: Date.parse(d.currentPeriodEnd || '') || null,
    // Set to stop at the end of the period (or on a date of its own): the period end is when it ends, not renews.
    cancels: d.cancelAtPeriodEnd === true || Date.parse(d.cancelAt || '') > Date.now(),
    credits: { ...credits, left: usd(credits.monthly + credits.purchased + credits.free) },
    fiveHour: win(w.fiveHour), weekly: win(w.weekly), checked: Date.now(),
  };
  // The windows as every source's plan panel shows them: a share used, the amounts behind it, when it resets.
  out.windows = [['5-hour window', out.fiveHour], ['Weekly window', out.weekly]].filter(([, x]) => x).map(([label, x]) => ({ label, percent: Math.min(100, (x.used / x.cap) * 100), used: x.used, cap: x.cap, over: x.exceeded, resetAt: x.resetAt }));
  return out;
}
/**
 * Checks a key with the smallest call it takes: a few tokens from a free model, else its cheapest priced one (a model
 * models.dev has no price for may not be cheap).
 */
export async function ccCheck(key, list, { fetchFn = fetch } = {}) {
  const rank = (m) => (/[:-]free$/.test(m.realId) ? -1 : m.listPrice[0] + m.listPrice[1] || Infinity);
  const cheap = [...list].filter((m) => m.tools && m.wire === 'chat').sort((a, b) => rank(a) - rank(b))[0] || list[0];
  if (!cheap) throw Object.assign(new Error('Command Code listed no models'), { kind: 'shape' });
  const r = await ccStream({ model: cheap.id, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }, new AbortController().signal, null, null, { info: cheap, key, idleMs: 30e3, fetchFn });
  return { model: cheap.id, usage: r.usage };
}
