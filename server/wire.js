// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Wire formats for model sources other than OpenRouter (sources.js). QuorX keeps every conversation in OpenAI's chat
// shape (messages with tool_calls, tool results and image parts). Each format here turns one call into its own request
// and reads the streamed answer back into the shape openrouter.js's chatStream returns, so the agent loop never sees a
// difference:
//   chat      : OpenAI chat/completions (OpenAI-compatible gateways)
//   responses : OpenAI Responses API
//   anthropic : Anthropic Messages API
//   google    : Google Gemini generateContent
// What a step needs carried to the next step of the same model (thinking signatures, reasoning text some models
// want back) rides on the assistant message as `qx_pass`; every other route drops it.
import { readChatStream } from './openrouter.js';
import { withCacheMarks } from './loop.js';

export const FORMATS = ['chat', 'responses', 'anthropic', 'google'];

// ---------- shared pieces ----------
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n') : '');
const parts = (c) => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : Array.isArray(c) ? c.filter(Boolean) : []);
// data:image/png;base64,AAAA → { mime, data }
export function dataUrl(u) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(u || ''));
  return m ? { mime: m[1], data: m[2] } : null;
}
const parseArgs = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }; } catch { return {}; } };
const callsOf = (m) => (Array.isArray(m?.tool_calls) ? m.tool_calls.filter((c) => c?.function?.name) : []);
// The pass-back of an earlier step, only when that step came from the same source and model.
const passOf = (m, source, model) => (m?.qx_pass && m.qx_pass.source === source && m.qx_pass.model === model ? m.qx_pass : null);

/**
 * What QuorX asked for, in OpenRouter's terms, as one level: { off } or { effort, budget }.
 * reasoning: { enabled: false } · { effort } · { max_tokens } · nothing (the model's own default → null).
 */
export function reasoningLevel(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.enabled === false) return { off: true };
  const budget = Number(r.max_tokens) || ({ low: 3000, medium: 8000, high: 16000 }[r.effort] || 0);
  const effort = r.effort || (budget ? (budget <= 4000 ? 'low' : budget <= 10000 ? 'medium' : 'high') : null);
  return effort || budget ? { effort: effort || 'medium', budget: budget || 8000 } : null;
}
// The model's own effort word closest to the one asked for (models.dev lists the ones each model takes).
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function nearestEffort(want, values) {
  const vs = (values || []).filter((v) => LADDER.includes(v));
  if (!vs.length) return null;
  if (vs.includes(want)) return want;
  const w = LADDER.indexOf(want);
  return [...vs].sort((a, b) => Math.abs(LADDER.indexOf(a) - w) - Math.abs(LADDER.indexOf(b) - w) || LADDER.indexOf(a) - LADDER.indexOf(b))[0];
}
const optionOf = (info, type) => { const o = Array.isArray(info?.reasoningOptions) ? info.reasoningOptions.find((x) => x?.type === type) : null; return o && type === 'effort' ? (Array.isArray(o.values) && o.values.length ? o : null) : o; };

// Errors read the same way whatever the format: { message, status }.
export function errorText(j, status) {
  const e = j?.error;
  const msg = typeof e === 'string' ? e : e?.message || j?.message || j?.detail || (Array.isArray(j) && j[0]?.error?.message) || '';
  return String(msg || `HTTP ${status}`);
}

// Server-sent events: each data line's JSON, in order. `event:` lines are not needed (every format names its event in
// the data too). A last line with no newline after it still counts.
async function eachEvent(r, fn) {
  const dec = new TextDecoder();
  let buf = '';
  const line = (raw) => {
    const s = raw.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    fn(j);
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, i); buf = buf.slice(i + 1); line(s); }
  }
  if (buf) line(buf);
}
// One result shape for every format (openrouter.js chatStream's): what the agent loop reads.
function result(st, t) {
  const calls = st.calls.filter(Boolean).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
  const outChars = st.text.length + st.thinking.length + calls.reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0);
  return { text: st.text, thinking: st.thinking, reasoningDetails: [], toolCalls: calls, usage: st.usage || {}, ms: Date.now() - t, firstMs: st.firstMs, finishReason: st.finish, provider: null, model: st.model || null, seen: st.seen,
    ...(st.pass ? { passBack: st.pass } : {}), ...(st.usage ? {} : { partial: { id: st.id || null, model: st.model || null, outChars, ms: Date.now() - t } }) };
}
const fresh = () => ({ text: '', thinking: '', calls: [], usage: null, finish: null, firstMs: null, seen: 0, model: null, id: null, pass: null });

// ---------- chat: OpenAI chat/completions ----------
const OPENROUTER_ONLY = ['provider', 'models', 'usage', 'transforms', 'plugins', 'route', 'reasoning', 'stream', 'stream_options', 'max_tokens'];
/**
 * The request for an OpenAI-compatible gateway. `info` is the model's catalogue entry (sources.js): its real id,
 * reasoning options, and the field some models want their earlier reasoning back in (models.dev "interleaved").
 * `openrouterLike`: the gateway takes OpenRouter's own extras (reasoning, usage) as they are.
 */
export function toChat(body, info = {}, { openrouterLike = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body)) if (!OPENROUTER_ONLY.includes(k)) out[k] = v;
  out.model = info.realId || body.model;
  if (info.temp === false) delete out.temperature;
  // A model that reasons between tool calls wants that reasoning back on every assistant turn, in the field the
  // catalogue names (some providers refuse a turn without it, even an empty one): its own steps carry it.
  const field = typeof info.interleaved === 'string' && info.interleaved !== 'reasoning_details' ? info.interleaved : null;
  out.messages = (body.messages || []).map((m) => {
    const { qx_pass: qp, reasoning_details: rd, ...rest } = m;
    if (rest.role === 'assistant' && field) rest[field] = qp && qp.source === info.source && qp.model === info.realId && typeof qp.thinking === 'string' ? qp.thinking : '';
    if (openrouterLike && rd) rest.reasoning_details = rd; // a gateway in front of OpenRouter takes them back as OpenRouter does
    // Every format but OpenRouter's rejects a part type it doesn't know; a PDF the model can't take was already
    // sent as text by the agent, so a stray file part only happens on a fallback model.
    if (Array.isArray(rest.content)) rest.content = rest.content.filter((p) => p?.type === 'text' || p?.type === 'image_url' || (p?.type === 'file' && info.files)).map(({ cache_control: _c, ...p }) => p);
    return rest;
  });
  // Through an OpenRouter-style gateway, a Claude model caches the start of the prompt as it does on OpenRouter.
  if (openrouterLike && /^anthropic\//.test(out.model)) out.messages = withCacheMarks(out.messages, out.model);
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  out.stream = true;
  if (openrouterLike) {
    if (body.reasoning) out.reasoning = body.reasoning;
    out.usage = { include: true };
    out.stream_options = { include_usage: true };
  } else {
    out.stream_options = { include_usage: true };
    const lv = reasoningLevel(body.reasoning), eff = optionOf(info, 'effort');
    if (lv && info.reasoning !== false && eff) {
      const pick = lv.off ? (eff.values.includes('none') ? 'none' : null) : nearestEffort(lv.effort, eff.values);
      if (pick) out.reasoning_effort = pick;
    }
  }
  return out;
}

// ---------- anthropic: the Messages API ----------
// Anthropic takes tool ids of letters, digits, _ and - only; other gateways' ids ("functions.write_file:0") are mapped.
export const anthropicId = (id) => String(id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'call';
function anthropicPart(p, info) {
  if (p.type === 'text') return p.text ? { type: 'text', text: p.text } : null;
  if (p.type === 'image_url') {
    const u = p.image_url?.url || '', d = dataUrl(u);
    return d ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } } : /^https?:/.test(u) ? { type: 'image', source: { type: 'url', url: u } } : null;
  }
  if (p.type === 'file' && info.files) {
    const d = dataUrl(p.file?.file_data);
    return d ? { type: 'document', source: { type: 'base64', media_type: d.mime, data: d.data } } : null;
  }
  return null;
}
export function toAnthropic(body, info = {}) {
  const model = info.realId || body.model;
  const msgs = body.messages || [];
  const system = msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).filter(Boolean).join('\n\n');
  const lv = reasoningLevel(body.reasoning);
  const maxTokens = Math.max(256, Number(body.max_tokens) || 8192);
  let think = !!(lv && !lv.off && info.reasoning !== false && maxTokens > 2048);
  const turns = [];
  const add = (role, content) => {
    if (!content.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content); else turns.push({ role, content: [...content] });
  };
  const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => anthropicId(m.tool_call_id)));
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') { add('user', [{ type: 'tool_result', tool_use_id: anthropicId(m.tool_call_id), content: text(m.content) || '(empty)' }]); continue; }
    if (m.role === 'assistant') {
      // The model's own turn goes back exactly as it wrote it (thinking between calls, in order, signed); a turn from
      // elsewhere is rebuilt from its text and calls.
      const qp = passOf(m, info.source, model);
      const blocks = qp?.anthropicContent?.length ? qp.anthropicContent.map((b) => (b.type === 'tool_use' ? { ...b, id: anthropicId(b.id) } : b))
        : [...(qp?.anthropic || []), ...parts(m.content).map((p) => anthropicPart(p, info)).filter(Boolean),
          ...callsOf(m).map((c) => ({ type: 'tool_use', id: anthropicId(c.id), name: c.function.name, input: parseArgs(c.function.arguments) }))];
      add('assistant', blocks);
      // A call with no result after it (a reply cut off part-way) still needs one.
      const missing = callsOf(m).filter((c) => !answered.has(anthropicId(c.id)));
      if (missing.length) add('user', missing.map((c) => ({ type: 'tool_result', tool_use_id: anthropicId(c.id), content: '(no result: the call was not run)' })));
      continue;
    }
    add('user', parts(m.content).map((p) => anthropicPart(p, info)).filter(Boolean));
  }
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing)' }] });
  // Results go first in a user turn that also has text (Anthropic reads them as answers to the calls before it).
  for (const t of turns) if (t.role === 'user') t.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  // With thinking on, the last assistant turn, when it called tools, must start with the model's own signed thinking.
  // A step that came from elsewhere (thinking off, another model, a fallback) has none, so this call goes without.
  const lastA = [...turns].reverse().find((t) => t.role === 'assistant');
  if (think && lastA?.content.some((b) => b.type === 'tool_use') && !['thinking', 'redacted_thinking'].includes(lastA.content[0]?.type)) think = false;
  // The model's own thinking blocks stay either way (newer models think whether asked or not).
  for (const t of turns) if (!t.content.length) t.content.push({ type: 'text', text: '(empty)' });
  const tools = (body.tools || []).filter((x) => x?.function?.name).map((x) => ({ name: x.function.name, description: x.function.description || '', input_schema: x.function.parameters || { type: 'object', properties: {} } }));
  if (tools.length) tools.at(-1).cache_control = { type: 'ephemeral' };
  const out = { model, max_tokens: maxTokens, stream: true, messages: turns };
  if (system) out.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  // The newest user turn is the end of what the next step reads again: cache up to there.
  const lastU = [...turns].reverse().find((t) => t.role === 'user');
  if (lastU) { const b = lastU.content.at(-1); if (b && b.type !== 'thinking') b.cache_control = { type: 'ephemeral' }; }
  if (tools.length) {
    out.tools = tools;
    const tc = body.tool_choice;
    // Newer models refuse a forced tool (any, or a named one), so a forced call is left to the model: the agent
    // already copes with a model that answers without the tool it was pointed at.
    out.tool_choice = tc === 'none' ? { type: 'none' } : { type: 'auto' };
  }
  // Thinking as the model takes it: an effort level (adaptive thinking, the newer models) or a token budget (older
  // ones). No temperature: newer models refuse one, and the Messages API is moving away from it.
  if (think) {
    const eff = optionOf(info, 'effort'), bud = optionOf(info, 'budget_tokens');
    if (eff && !bud) { out.thinking = { type: 'adaptive' }; out.output_config = { effort: nearestEffort(lv.effort, eff.values) || 'medium' }; }
    else out.thinking = { type: 'enabled', budget_tokens: Math.max(Number(bud?.min) || 1024, Math.min(lv.budget, maxTokens - 1024)) };
  }
  return out;
}
export async function readAnthropicStream(r, t, onText, onThink) {
  const st = fresh(), blocks = [], keep = [];
  const use = { input: 0, output: 0, read: 0, write: 0, seen: false };
  try {
    await eachEvent(r, (j) => {
      st.seen++;
      if (j.type === 'error') throw Object.assign(new Error(j.error?.message || 'stream error'), { streamStatus: j.error?.type === 'overloaded_error' ? 529 : j.error?.type === 'rate_limit_error' ? 429 : null });
      if (j.type === 'message_start') {
        const m = j.message || {}, u = m.usage || {};
        st.id = m.id || null; st.model = m.model || null;
        use.input = u.input_tokens || 0; use.read = u.cache_read_input_tokens || 0; use.write = u.cache_creation_input_tokens || 0; use.output = u.output_tokens || 0;
      } else if (j.type === 'content_block_start') {
        const b = j.content_block || {};
        blocks[j.index] = { ...b, text: b.text || '', thinking: b.thinking || '', json: '', signature: b.signature || '' };
        if (b.type === 'tool_use') st.calls[j.index] = { id: b.id, name: b.name, args: '' };
      } else if (j.type === 'content_block_delta') {
        const b = blocks[j.index] || (blocks[j.index] = { type: 'text', text: '', thinking: '', json: '', signature: '' }), d = j.delta || {};
        if (d.type === 'text_delta' && d.text) { if (st.firstMs == null) st.firstMs = Date.now() - t; st.text += d.text; b.text += d.text; onText?.(d.text); }
        else if (d.type === 'thinking_delta' && d.thinking) { st.thinking += d.thinking; b.thinking += d.thinking; onThink?.(d.thinking); }
        else if (d.type === 'signature_delta' && d.signature) b.signature += d.signature;
        else if (d.type === 'input_json_delta' && d.partial_json != null) { b.json += d.partial_json; if (st.calls[j.index]) st.calls[j.index].args += d.partial_json; }
      } else if (j.type === 'content_block_stop') {
        const b = blocks[j.index];
        if (b?.type === 'thinking') keep.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        else if (b?.type === 'redacted_thinking') keep.push({ type: 'redacted_thinking', data: b.data });
      } else if (j.type === 'message_delta') {
        const sr = j.delta?.stop_reason;
        if (sr) st.finish = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : sr === 'end_turn' || sr === 'stop_sequence' ? 'stop' : sr;
        if (j.usage) {
          const u = j.usage;
          use.output = u.output_tokens ?? use.output; if (u.input_tokens != null) use.input = u.input_tokens; if (u.cache_read_input_tokens != null) use.read = u.cache_read_input_tokens; if (u.cache_creation_input_tokens != null) use.write = u.cache_creation_input_tokens;
          if (u.cost != null) use.cost = u.cost; // a gateway's own figure (OpenCode sends it here)
          if (u.opencode) use.opencode = u.opencode;
          use.seen = true;
        }
      } else if (j.type === 'message_stop') use.seen = true;
    });
  } catch (e) {
    if (e && typeof e === 'object') { try { e.partial = result(st, t).partial; } catch { /* nothing to add */ } }
    throw e;
  }
  for (const c of st.calls) if (c && !c.args) c.args = '{}';
  if (use.seen) st.usage = anthropicUsage(use);
  if (keep.length) st.pass = { anthropicContent: orderedTurn(blocks) };
  return result(st, t);
}
// A turn as the model wrote it, block by block, for the next step of the same model.
const orderedTurn = (blocks) => blocks.filter(Boolean).map((b) => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
  : b.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: b.data } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: parseArgs(b.json || '{}') }
  : b.type === 'text' && b.text ? { type: 'text', text: b.text } : null)).filter(Boolean);
const anthropicUsage = (u) => ({ prompt_tokens: u.input + u.read + u.write, completion_tokens: u.output, prompt_tokens_details: { cached_tokens: u.read, cache_write_tokens: u.write }, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write,
  ...(u.cost != null ? { cost: u.cost } : {}), ...(u.opencode ? { opencode: u.opencode } : {}) });

// ---------- responses: OpenAI's Responses API ----------
export function toResponses(body, info = {}, { session } = {}) {
  const input = [];
  const answered = new Set((body.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id || '')));
  const sys = [];
  for (const m of body.messages || []) {
    if (m.role === 'system') { sys.push(text(m.content)); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: text(m.content) || '(empty)' }); continue; }
    if (m.role === 'assistant') {
      const tx = text(m.content);
      if (tx) input.push({ role: 'assistant', content: [{ type: 'output_text', text: tx }] });
      for (const c of callsOf(m)) input.push({ type: 'function_call', call_id: String(c.id || ''), name: c.function.name, arguments: c.function.arguments || '{}' });
      for (const c of callsOf(m)) if (!answered.has(String(c.id || ''))) input.push({ type: 'function_call_output', call_id: String(c.id || ''), output: '(no result: the call was not run)' });
      continue;
    }
    const content = parts(m.content).map((p) => (p.type === 'text' ? (p.text ? { type: 'input_text', text: p.text } : null)
      : p.type === 'image_url' ? { type: 'input_image', image_url: p.image_url?.url }
      : p.type === 'file' && info.files ? { type: 'input_file', filename: p.file?.filename || 'file.pdf', file_data: p.file?.file_data } : null)).filter(Boolean);
    if (content.length) input.push({ role: 'user', content });
  }
  const out = { model: info.realId || body.model, input, stream: true, store: false };
  if (session) out.prompt_cache_key = session; // the conversation's steps share the gateway's prompt cache
  if (sys.length) out.instructions = sys.filter(Boolean).join('\n\n');
  if (body.max_tokens) out.max_output_tokens = body.max_tokens;
  const tools = (body.tools || []).filter((x) => x?.function?.name).map((x) => ({ type: 'function', name: x.function.name, description: x.function.description || '', parameters: x.function.parameters || { type: 'object', properties: {} }, strict: false }));
  if (tools.length) {
    out.tools = tools;
    const tc = body.tool_choice;
    out.tool_choice = tc === 'none' || tc === 'required' ? tc : tc?.function?.name ? { type: 'function', name: tc.function.name } : 'auto';
  }
  const lv = reasoningLevel(body.reasoning), eff = optionOf(info, 'effort');
  if (lv && info.reasoning !== false) {
    const pick = eff ? (lv.off ? nearestEffort('none', eff.values.filter((v) => ['none', 'minimal'].includes(v))) : nearestEffort(lv.effort, eff.values)) : lv.off ? null : lv.effort;
    if (pick) out.reasoning = { effort: pick, ...(pick !== 'none' ? { summary: 'auto' } : {}) };
  }
  if (body.temperature != null && info.temp !== false && !out.reasoning) out.temperature = body.temperature;
  return out;
}
export async function readResponsesStream(r, t, onText, onThink) {
  const st = fresh(), byItem = new Map();
  let done = false;
  try {
    await eachEvent(r, (j) => {
      st.seen++;
      const ty = j.type || '';
      if (ty === 'error') throw Object.assign(new Error(j.message || j.error?.message || 'stream error'), { streamStatus: Number(j.code) || null });
      if (ty === 'response.failed') throw new Error(j.response?.error?.message || 'the response failed');
      if (ty === 'response.created' || ty === 'response.in_progress') { st.id = j.response?.id || st.id; st.model = j.response?.model || st.model; }
      else if (ty === 'response.output_text.delta' && j.delta) { if (st.firstMs == null) st.firstMs = Date.now() - t; st.text += j.delta; onText?.(j.delta); }
      else if ((ty === 'response.reasoning_summary_text.delta' || ty === 'response.reasoning_text.delta') && j.delta) { st.thinking += j.delta; onThink?.(j.delta); }
      else if (ty === 'response.output_item.added' && j.item?.type === 'function_call') {
        const c = { id: j.item.call_id || j.item.id, name: j.item.name || '', args: j.item.arguments || '' };
        byItem.set(j.item.id, c); st.calls.push(c);
      } else if (ty === 'response.function_call_arguments.delta') { const c = byItem.get(j.item_id); if (c && j.delta) c.args += j.delta; }
      else if (ty === 'response.function_call_arguments.done') { const c = byItem.get(j.item_id); if (c && typeof j.arguments === 'string') c.args = j.arguments; }
      else if (ty === 'response.output_item.done' && j.item?.type === 'function_call') {
        let c = byItem.get(j.item.id);
        if (!c) { c = { id: j.item.call_id || j.item.id, name: j.item.name || '', args: '' }; byItem.set(j.item.id, c); st.calls.push(c); }
        if (typeof j.item.arguments === 'string' && j.item.arguments) c.args = j.item.arguments;
        if (j.item.name) c.name = j.item.name;
      } else if (ty === 'response.completed' || ty === 'response.incomplete') {
        done = true;
        const resp = j.response || {}, u = resp.usage || {};
        st.model = resp.model || st.model;
        const cached = u.input_tokens_details?.cached_tokens || 0;
        st.usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, prompt_tokens_details: { cached_tokens: cached }, ...(u.cost != null ? { cost: u.cost } : {}), ...(u.opencode ? { opencode: u.opencode } : {}) };
        st.finish = ty === 'response.incomplete' && /max_output_tokens/.test(resp.incomplete_details?.reason || '') ? 'length' : null;
      }
    });
  } catch (e) {
    if (e && typeof e === 'object') { try { e.partial = result(st, t).partial; } catch { /* nothing to add */ } }
    throw e;
  }
  for (const c of st.calls) if (!c.args) c.args = '{}';
  st.finish ??= st.calls.length ? 'tool_calls' : done ? 'stop' : null;
  return result(st, t);
}

// ---------- google: Gemini generateContent ----------
// Gemini takes a narrow subset of JSON Schema for tool parameters (OpenAPI 3.0's): anything else is refused.
const G_KEEP = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'title']);
export function googleSchema(s, nested = false) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'string' };
  let src = s;
  const alt = s.anyOf || s.oneOf;
  if (Array.isArray(alt) && alt.length) { const pick = alt.find((x) => x && x.type !== 'null') || alt[0]; src = { ...pick, ...(s.description ? { description: s.description } : {}) }; }
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!G_KEEP.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) { const t = v.filter((x) => x !== 'null'); out.type = String(t[0] || 'string').toUpperCase(); if (v.includes('null')) out.nullable = true; continue; }
    if (k === 'type') { out.type = String(v).toUpperCase(); continue; }
    if (k === 'properties' && v && typeof v === 'object') { out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, googleSchema(pv, true)])); continue; }
    if (k === 'items') { out.items = googleSchema(Array.isArray(v) ? v[0] : v, true); continue; }
    if (k === 'enum') { if (Array.isArray(v) && v.length) out.enum = v.map(String); continue; }
    if (k === 'format' && !['enum', 'date-time'].includes(v)) continue;
    out[k] = v;
  }
  if (!out.type) out.type = out.properties ? 'OBJECT' : out.items ? 'ARRAY' : 'STRING';
  if (out.type === 'OBJECT' && out.properties && !Object.keys(out.properties).length) delete out.properties;
  // Gemini refuses an object with no properties; inside a tool's parameters a free-form object is sent as JSON text.
  if (out.type === 'OBJECT' && !out.properties && nested) return { type: 'STRING', description: `${out.description ? `${out.description} ` : ''}(a JSON object, as text)`, ...(out.nullable ? { nullable: true } : {}) };
  if (Array.isArray(out.required) && out.properties) out.required = out.required.filter((k) => k in out.properties);
  else delete out.required;
  return out;
}
// Gemini 3 wants each function call it made sent back with its thought signature; one we don't have (a step from
// elsewhere) gets the value Google documents for exactly that case.
const NO_SIGNATURE = 'skip_thought_signature_validator';
export function toGoogle(body, info = {}) {
  const model = info.realId || body.model;
  const answered = new Set((body.messages || []).filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const names = new Map();
  const contents = [];
  const add = (role, ps) => {
    if (!ps.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...ps); else contents.push({ role, parts: [...ps] });
  };
  const sys = [];
  const part = (p) => {
    if (p.type === 'text') return p.text ? { text: p.text } : null;
    if (p.type === 'image_url') { const d = dataUrl(p.image_url?.url); return d ? { inlineData: { mimeType: d.mime, data: d.data } } : null; }
    if (p.type === 'file' && info.files) { const d = dataUrl(p.file?.file_data); return d ? { inlineData: { mimeType: d.mime, data: d.data } } : null; }
    return null;
  };
  for (const m of body.messages || []) {
    if (m.role === 'system') { sys.push(text(m.content)); continue; }
    if (m.role === 'tool') { add('user', [{ functionResponse: { name: names.get(m.tool_call_id) || 'tool', response: { name: names.get(m.tool_call_id) || 'tool', content: text(m.content) } } }]); continue; }
    if (m.role === 'assistant') {
      const qp = passOf(m, info.source, model)?.gemini || {};
      const ps = parts(m.content).map(part).filter(Boolean);
      for (const c of callsOf(m)) { names.set(c.id, c.function.name); ps.push({ functionCall: { name: c.function.name, args: parseArgs(c.function.arguments) }, thoughtSignature: qp.calls?.[c.id] || NO_SIGNATURE }); }
      add('model', ps);
      const missing = callsOf(m).filter((c) => !answered.has(c.id));
      if (missing.length) add('user', missing.map((c) => ({ functionResponse: { name: c.function.name, response: { name: c.function.name, content: '(no result: the call was not run)' } } })));
      continue;
    }
    add('user', parts(m.content).map(part).filter(Boolean));
  }
  if (contents[0]?.role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(continuing)' }] });
  const out = { contents, generationConfig: {} };
  if (sys.filter(Boolean).length) out.systemInstruction = { parts: [{ text: sys.filter(Boolean).join('\n\n') }] };
  // A tool with no parameters goes without any (Gemini refuses an object with no properties).
  const fns = (body.tools || []).filter((x) => x?.function?.name).map((x) => { const p = googleSchema(x.function.parameters || { type: 'object', properties: {} }); return { name: x.function.name, description: x.function.description || '', ...(p.type === 'OBJECT' && !p.properties ? {} : { parameters: p }) }; });
  if (fns.length) {
    out.tools = [{ functionDeclarations: fns }];
    const tc = body.tool_choice;
    out.toolConfig = { functionCallingConfig: tc === 'none' ? { mode: 'NONE' } : tc === 'required' ? { mode: 'ANY' } : tc?.function?.name ? { mode: 'ANY', allowedFunctionNames: [tc.function.name] } : { mode: 'AUTO' } };
  }
  if (body.max_tokens) out.generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature != null && info.temp !== false) out.generationConfig.temperature = body.temperature;
  const lv = reasoningLevel(body.reasoning), eff = optionOf(info, 'effort');
  if (info.reasoning !== false && lv && !lv.off) out.generationConfig.thinkingConfig = { includeThoughts: true, ...(eff ? { thinkingLevel: nearestEffort(lv.effort, eff.values) || lv.effort } : { thinkingBudget: lv.budget }) };
  else if (info.reasoning !== false && !lv) out.generationConfig.thinkingConfig = { includeThoughts: true };
  return out;
}
export async function readGoogleStream(r, t, onText, onThink) {
  const st = fresh(), sigs = {};
  let n = 0;
  try {
    await eachEvent(r, (j) => {
      st.seen++;
      if (j.error) throw Object.assign(new Error(j.error.message || 'stream error'), { streamStatus: Number(j.error.code) || null });
      const cand = j.candidates?.[0] || {};
      for (const p of cand.content?.parts || []) {
        if (p.functionCall) {
          const id = p.functionCall.id || `call_${Date.now().toString(36)}_${n++}`;
          st.calls.push({ id, name: p.functionCall.name || '', args: JSON.stringify(p.functionCall.args || {}) });
          if (p.thoughtSignature) sigs[id] = p.thoughtSignature;
        } else if (typeof p.text === 'string' && p.text) {
          if (p.thought) { st.thinking += p.text; onThink?.(p.text); }
          else { if (st.firstMs == null) st.firstMs = Date.now() - t; st.text += p.text; onText?.(p.text); }
        }
      }
      if (cand.finishReason) st.finish = cand.finishReason === 'STOP' ? 'stop' : cand.finishReason === 'MAX_TOKENS' ? 'length' : String(cand.finishReason).toLowerCase();
      if (j.modelVersion) st.model = j.modelVersion;
      if (j.responseId) st.id = j.responseId;
      const u = j.usageMetadata, extra = j.usage || {};
      if (u) st.usage = { prompt_tokens: u.promptTokenCount || 0, completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount || 0 },
        ...(extra.cost != null ? { cost: extra.cost } : u.cost != null ? { cost: u.cost } : {}), ...(extra.opencode ? { opencode: extra.opencode } : {}) };
    });
  } catch (e) {
    if (e && typeof e === 'object') { try { e.partial = result(st, t).partial; } catch { /* nothing to add */ } }
    throw e;
  }
  if (st.calls.length) { if (st.finish === 'stop' || !st.finish) st.finish = 'tool_calls'; st.pass = { gemini: { calls: sigs } }; }
  return result(st, t);
}

// ---------- one call, any format ----------
export const BUILD = { chat: toChat, responses: toResponses, anthropic: toAnthropic, google: toGoogle };
export const READ = { chat: (r, body, t, onText, onThink) => readChatStream(r, body, t, onText, onThink), responses: (r, body, t, a, b) => readResponsesStream(r, t, a, b), anthropic: (r, body, t, a, b) => readAnthropicStream(r, t, a, b), google: (r, body, t, a, b) => readGoogleStream(r, t, a, b) };

/**
 * An answer that came back whole (some gateways ignore stream: true) in any of the four shapes, read into the same
 * result. Returns null when it is none of them.
 */
export function readWhole(format, j, t, onText, onThink) {
  const st = fresh();
  st.seen = 1;
  if (format === 'chat' && Array.isArray(j?.choices)) {
    const m = j.choices[0]?.message || {};
    st.text = typeof m.content === 'string' ? m.content : text(m.content);
    st.thinking = m.reasoning || m.reasoning_content || '';
    st.calls = callsOf(m).map((c) => ({ id: c.id, name: c.function.name, args: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) }));
    st.finish = j.choices[0]?.finish_reason || null;
    st.usage = j.usage || null; st.model = j.model || null; st.id = j.id || null;
  } else if (format === 'anthropic' && Array.isArray(j?.content)) {
    const keep = [];
    for (const b of j.content) {
      if (b.type === 'text') st.text += b.text || '';
      else if (b.type === 'thinking') { st.thinking += b.thinking || ''; keep.push({ type: 'thinking', thinking: b.thinking, signature: b.signature }); }
      else if (b.type === 'redacted_thinking') keep.push({ type: 'redacted_thinking', data: b.data });
      else if (b.type === 'tool_use') st.calls.push({ id: b.id, name: b.name, args: JSON.stringify(b.input || {}) });
    }
    const u = j.usage || {};
    st.usage = anthropicUsage({ input: u.input_tokens || 0, output: u.output_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0 });
    st.finish = j.stop_reason === 'tool_use' ? 'tool_calls' : j.stop_reason === 'max_tokens' ? 'length' : 'stop';
    st.model = j.model || null; st.id = j.id || null;
    if (keep.length) st.pass = { anthropicContent: j.content.filter((b) => ['thinking', 'redacted_thinking', 'tool_use'].includes(b.type) || (b.type === 'text' && b.text)) };
    if (u.cost != null) st.usage.cost = u.cost;
    if (u.opencode) st.usage.opencode = u.opencode;
  } else if (format === 'responses' && Array.isArray(j?.output)) {
    for (const it of j.output) {
      if (it.type === 'message') st.text += (it.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      else if (it.type === 'function_call') st.calls.push({ id: it.call_id || it.id, name: it.name, args: it.arguments || '{}' });
      else if (it.type === 'reasoning') st.thinking += (it.summary || []).map((s) => s.text || '').join('');
    }
    const u = j.usage || {};
    st.usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens || 0 }, ...(u.cost != null ? { cost: u.cost } : {}), ...(u.opencode ? { opencode: u.opencode } : {}) };
    st.finish = st.calls.length ? 'tool_calls' : 'stop'; st.model = j.model || null; st.id = j.id || null;
  } else if (format === 'google' && Array.isArray(j?.candidates)) {
    const sigs = {};
    let n = 0;
    for (const p of j.candidates[0]?.content?.parts || []) {
      if (p.functionCall) { const id = p.functionCall.id || `call_${n++}`; st.calls.push({ id, name: p.functionCall.name, args: JSON.stringify(p.functionCall.args || {}) }); if (p.thoughtSignature) sigs[id] = p.thoughtSignature; }
      else if (p.thought) st.thinking += p.text || '';
      else st.text += p.text || '';
    }
    const u = j.usageMetadata || {}, extra = j.usage || {};
    st.usage = { prompt_tokens: u.promptTokenCount || 0, completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount || 0 }, ...(extra.cost != null ? { cost: extra.cost } : {}), ...(extra.opencode ? { opencode: extra.opencode } : {}) };
    st.finish = st.calls.length ? 'tool_calls' : j.candidates[0]?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
    if (st.calls.length) st.pass = { gemini: { calls: sigs } };
  } else return null;
  if (st.text) { st.firstMs = Date.now() - t; onText?.(st.text); }
  if (st.thinking) onThink?.(st.thinking);
  return result(st, t);
}
