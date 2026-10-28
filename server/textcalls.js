// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tool calls written as text, for a model QuorX reaches through an app that runs its own agent (the OpenCode on this
// computer: opencodelocal.js). That app can't take QuorX's tools, so the system prompt describes them and the model
// writes each call as a <tool_call> block with JSON inside; QuorX reads the blocks back into the same tool_calls an
// API would have sent. The conversation goes over as one text transcript, so any model with text in and text out works.

const OPEN = '<tool_call>', CLOSE = '</tool_call>';

/** The part of the system prompt that teaches the model QuorX's tools and how to call them. */
export function toolPrompt(tools = [], toolChoice = 'auto') {
  const fns = (tools || []).filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
  if (!fns.length) return '';
  const rule = toolChoice === 'none' ? 'Do not call any tool in this reply: answer in plain text.'
    : toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name ? `In this reply, call the tool ${toolChoice.function.name}.`
    : toolChoice === 'required' ? 'In this reply, call at least one tool.' : '';
  return `\n\n[Tools]
You can use the tools listed below. To call one, write a block exactly like this, with the arguments as one JSON object:
${OPEN}{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}${CLOSE}
- Write several blocks in one reply to call several tools; they run in order.
- After your tool calls, stop writing: the results come back in the next message as <tool_result> blocks.
- Text outside the blocks is shown to the user; put nothing else inside a block.
- Never write a <tool_result> yourself, and never pretend a tool ran.
${rule ? `- ${rule}\n` : ''}
Tools (JSON Schema for each tool's arguments):
${fns.map((f) => JSON.stringify(f)).join('\n')}`;
}

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text || '' : p?.type === 'image_url' ? '[picture attached]' : p?.type === 'file' ? `[file attached: ${p.file?.filename || 'file'}]` : '')).filter(Boolean).join('\n') : '');
const callBlock = (c) => {
  let args = {};
  try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = { _raw: String(c.function?.arguments || '') }; }
  return `${OPEN}${JSON.stringify({ name: c.function?.name, arguments: args })}${CLOSE}`;
};
/**
 * QuorX's conversation (OpenAI-style messages) as { system, transcript }: the system messages joined, and every other
 * turn written out in order, the model's own earlier calls as the blocks it wrote and each result after its call.
 */
export function renderTranscript(messages = []) {
  const system = messages.filter((m) => m?.role === 'system').map((m) => text(m.content)).filter(Boolean).join('\n\n');
  const names = new Map();
  const out = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') out.push(`<user>\n${text(m.content)}\n</user>`);
    else if (m.role === 'assistant') {
      for (const c of m.tool_calls || []) names.set(c.id, c.function?.name);
      const body = [text(m.content), ...(m.tool_calls || []).map(callBlock)].filter(Boolean).join('\n');
      out.push(`<assistant>\n${body}\n</assistant>`);
    } else if (m.role === 'tool') out.push(`<tool_result name="${names.get(m.tool_call_id) || 'tool'}">\n${text(m.content)}\n</tool_result>`);
  }
  out.push(`Write your next reply as the assistant now (text, tool calls, or both), following the instructions above. To call a tool, write ${OPEN}{"name": "…", "arguments": {…}}${CLOSE}, one block per call, in exactly that format.`);
  return { system, transcript: out.join('\n\n') };
}

// JSON a model wrote: as it is, else without code fences and trailing commas.
function loose(s) {
  const t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* try a repair */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { return undefined; }
}
// Some models answer in the tool-call format they were trained on, whatever the prompt says. DeepSeek's:
// <｜DSML｜invoke name="get_time"><｜DSML｜parameter name="zone" string="true">UTC</｜DSML｜parameter></｜DSML｜invoke>
// (the bars are full-width ｜ or plain |, sometimes doubled, sometimes with spaces).
const BAR = '[｜|]+\\s*';
const DSML_INVOKE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${BAR}DSML${BAR}invoke\\s*>`, 'g');
const DSML_PARAM = new RegExp(`<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${BAR}DSML${BAR}parameter\\s*>`, 'g');
const DSML_ANY = new RegExp(`<\\/?${BAR}DSML${BAR}[^>]*>`, 'g');
function nativeCalls(s, idBase, calls) {
  if (!/DSML/.test(s)) return s;
  const out = s.replace(DSML_INVOKE, (_, name, body) => {
    let args = {};
    for (const [, k, v] of body.matchAll(DSML_PARAM)) {
      const val = v.trim(), j = loose(val);
      if (k === 'arguments' && j && typeof j === 'object') args = { ...args, ...j };
      else args[k] = j !== undefined && typeof j !== 'string' ? j : val;
    }
    calls.push({ id: `${idBase}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    return '';
  });
  return out.replace(DSML_ANY, '');
}

/**
 * The model's reply split into what it said and the calls it wrote: { text, calls: [{ id, type, function }] }.
 * A block that isn't valid JSON still becomes a call (with its raw text as arguments), so the agent tells the model
 * its arguments didn't parse instead of the call vanishing.
 */
export function parseToolCalls(reply, idBase = 'call') {
  const calls = [];
  let said = '', i = 0;
  const s = nativeCalls(String(reply || ''), idBase, calls);
  while (i < s.length) {
    const a = s.indexOf(OPEN, i);
    if (a < 0) { said += s.slice(i); break; }
    said += s.slice(i, a);
    const b = s.indexOf(CLOSE, a + OPEN.length);
    const inner = s.slice(a + OPEN.length, b < 0 ? s.length : b);
    i = b < 0 ? s.length : b + CLOSE.length;
    const j = loose(inner);
    const name = j && typeof j === 'object' ? String(j.name || j.tool || j.function?.name || '') : '';
    const args = j && typeof j === 'object' ? j.arguments ?? j.args ?? j.parameters ?? j.function?.arguments ?? {} : null;
    calls.push({ id: `${idBase}_${calls.length}`, type: 'function', function: { name: name || 'invalid', arguments: args == null ? inner.trim() : typeof args === 'string' ? args : JSON.stringify(args) } });
  }
  return { text: said.replace(/\n{3,}/g, '\n\n').trim(), calls };
}

/**
 * Passes streamed text through to the page, but holds back anything that might be the start of a tool call, and
 * drops what is inside one: the page shows what the model says, never the raw blocks.
 */
// Where the calls start: QuorX's own block, or a model's native format (DeepSeek's starts "<｜"). Text after the first
// call is rare and is still in the final reply; the stream shows only what came before.
const OPENERS = [OPEN, '<｜', '<|'];
export function textFilter(onText) {
  let pending = '', stopped = false;
  return (d) => {
    if (!onText || !d || stopped) return;
    pending += d;
    const at = Math.min(...OPENERS.map((o) => { const i = pending.indexOf(o); return i < 0 ? Infinity : i; }));
    if (at !== Infinity) { stopped = true; if (at) onText(pending.slice(0, at)); pending = ''; return; }
    // Keep back a tail that could be the start of an opener.
    let keep = 0;
    for (let k = Math.min(OPEN.length - 1, pending.length); k > 0 && !keep; k--) if (OPENERS.some((o) => o.startsWith(pending.slice(-k)))) keep = k;
    const out = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    if (out) onText(out);
  };
}
