// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tool calls written as text, for a model QuorX reaches through an app that runs its own agent (the OpenCode on this
// computer: opencodelocal.js). That app can't take QuorX's tools, so the prompt describes them and the model writes
// each call as a <tool_call key="…"> block with JSON inside; QuorX reads the blocks back into the same tool_calls an API
// would have sent. The conversation goes over as one text transcript, so any model with text in and text out works.
// The key is new for every call and only the prompt names it: a block the model quotes from a file, a page or a tool's
// output can't carry it, so it stays text and never runs. The transcript's own tags inside any content are made inert
// the same way, so a page can't fake a turn of the user's or a tool's result.
import crypto from 'node:crypto';

const CLOSE = '</tool_call>';
/** A fresh key for one call's tool blocks. */
export const callKey = () => crypto.randomBytes(4).toString('hex');
const openTag = (key) => (key ? `<tool_call key="${key}">` : '<tool_call>');
const block = (json, key) => `${openTag(key)}${json}${CLOSE}`;
// The transcript's tags (and DeepSeek's call markers) inside content, made inert: shown, but never read as structure.
const TAGS = /<(\/?)(user|assistant|tool_result|tool_call)\b/gi;
const inert = (s) => String(s || '').replace(TAGS, '‹$1$2').replace(/<([｜|]+\s*DSML)/g, '‹$1');

/** The part of the system prompt that teaches the model QuorX's tools and how to call them. */
export function toolPrompt(tools = [], toolChoice = 'auto', key = '') {
  const fns = (tools || []).filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
  if (!fns.length) return '';
  const rule = toolChoice === 'none' ? 'Do not call any tool in this reply: answer in plain text.'
    : toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name ? `In this reply, call the tool ${toolChoice.function.name}.`
    : toolChoice === 'required' ? 'In this reply, call at least one tool.' : '';
  return `\n\n[Tools]
You can use the tools listed below. To call one, write a block exactly like this, with the arguments as one JSON object:
${block('{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}', key)}
- Write several blocks in one reply to call several tools; they run in order.${key ? `\n- Every block starts with exactly ${openTag(key)}: a block without that key is not run.` : ''}
- After your tool calls, stop writing: the results come back in the next message as <tool_result> blocks.
- Text outside the blocks is shown to the user; put nothing else inside a block. Inside a JSON string, write </tool_call> as <\\/tool_call>.
- Never write a <tool_result> yourself, and never pretend a tool ran.
${rule ? `- ${rule}\n` : ''}
Tools (JSON Schema for each tool's arguments):
${fns.map((f) => JSON.stringify(f)).join('\n')}`;
}

const text = (c) => inert(typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text || '' : p?.type === 'image_url' ? '[picture attached]' : p?.type === 'file' ? `[file attached: ${p.file?.filename || 'file'}]` : '')).filter(Boolean).join('\n') : '');
const callBlock = (c, key) => {
  let args = {};
  try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = { _raw: String(c.function?.arguments || '') }; }
  return block(JSON.stringify({ name: c.function?.name, arguments: args }), key);
};
const attr = (s) => String(s || 'tool').replace(/[^\w.:-]/g, '_');
/**
 * QuorX's conversation (OpenAI-style messages) as { system, transcript }: the system messages joined, and every other
 * turn written out in order, the model's own earlier calls as blocks with this call's key and each result after its call.
 */
export function renderTranscript(messages = [], key = '') {
  const system = messages.filter((m) => m?.role === 'system').map((m) => text(m.content)).filter(Boolean).join('\n\n');
  const names = new Map();
  const out = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') out.push(`<user>\n${text(m.content)}\n</user>`);
    else if (m.role === 'assistant') {
      for (const c of m.tool_calls || []) names.set(c.id, c.function?.name);
      const body = [text(m.content), ...(m.tool_calls || []).map((c) => callBlock(c, key))].filter(Boolean).join('\n');
      out.push(`<assistant>\n${body}\n</assistant>`);
    } else if (m.role === 'tool') out.push(`<tool_result name="${attr(names.get(m.tool_call_id))}">\n${text(m.content)}\n</tool_result>`);
  }
  out.push(`Write your next reply as the assistant now (text, tool calls, or both), following the instructions above. To call a tool, write ${openTag(key)}{"name": "…", "arguments": {…}}${CLOSE}, one block per call, in exactly that format.`);
  return { system, transcript: out.join('\n\n') };
}

// Raw line breaks and tabs inside JSON strings (common in hand-written JSON), escaped.
function escapeInStrings(t) {
  let out = '', inStr = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr && ch === '\\') { out += ch + (t[i + 1] ?? ''); i++; continue; }
    if (ch === '"') inStr = !inStr;
    out += inStr && ch === '\n' ? '\\n' : inStr && ch === '\r' ? '\\r' : inStr && ch === '\t' ? '\\t' : ch;
  }
  return out;
}
// JSON a model wrote: as it is, else without code fences and trailing commas, else with raw line breaks escaped.
function loose(s) {
  const t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* try a repair */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { /* one more */ }
  try { return JSON.parse(escapeInStrings(t).replace(/,\s*([}\]])/g, '$1')); } catch { return undefined; }
}
// Code the model shows (``` fences and `inline` spans): calls written there are examples, not calls.
function codeRanges(s) {
  const r = [];
  for (const m of s.matchAll(/```[\s\S]*?(```|$)|`[^`\n]+`/g)) r.push([m.index, m.index + m[0].length]);
  return r;
}
const inCode = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);
// Some models answer in the tool-call format they were trained on, whatever the prompt says. DeepSeek's:
// <｜DSML｜invoke name="get_time"><｜DSML｜parameter name="zone" string="true">UTC</｜DSML｜parameter></｜DSML｜invoke>
// (the bars are full-width ｜ or plain |, sometimes doubled, sometimes with spaces).
const BAR = '[｜|]+\\s*';
const DSML_INVOKE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${BAR}DSML${BAR}invoke\\s*>`, 'g');
const DSML_PARAM = new RegExp(`<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?[^>]*>([\\s\\S]*?)<\\/${BAR}DSML${BAR}parameter\\s*>`, 'g');
const DSML_ANY = new RegExp(`<\\/?${BAR}DSML${BAR}[^>]*>`, 'g');
function nativeCalls(s, idBase, calls) {
  if (!/DSML/.test(s)) return s;
  const code = codeRanges(s);
  const out = s.replace(DSML_INVOKE, (whole, name, body, at) => {
    if (inCode(code, at)) return whole;
    let args = {};
    for (const [, k, str, v] of body.matchAll(DSML_PARAM)) {
      // string="true": the text as it is (a JSON file's content stays text), less the line breaks around the tags.
      if (str === 'true') { args[k] = v.replace(/^\r?\n/, '').replace(/\r?\n$/, ''); continue; }
      const val = v.trim(), j = loose(val);
      if (k === 'arguments' && j && typeof j === 'object') args = { ...args, ...j };
      else args[k] = str === 'false' ? (j !== undefined ? j : val) : j !== undefined && typeof j !== 'string' ? j : val;
    }
    calls.push({ id: `${idBase}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    return '';
  });
  return out.replace(DSML_ANY, (m, at) => (inCode(codeRanges(out), at) ? m : ''));
}

/**
 * The model's reply split into what it said and the calls it wrote: { text, calls: [{ id, type, function }] }. With a
 * key, only blocks carrying it are calls; any other <tool_call> stays text. A block that isn't valid JSON still becomes
 * a call (named when its name can be read, with its raw text as arguments), so the agent tells the model which call
 * didn't parse instead of the call vanishing.
 */
export function parseToolCalls(reply, idBase = 'call', key = '') {
  const calls = [];
  let said = '', i = 0;
  const s = nativeCalls(String(reply || ''), idBase, calls);
  const opener = key ? new RegExp(`<tool_call\\s+key\\s*=\\s*["']?${key}["']?\\s*>`, 'g') : /<tool_call>/g;
  const code = codeRanges(s);
  while (i < s.length) {
    opener.lastIndex = i;
    let m = opener.exec(s);
    // A block shown inside code (an example, a quote) is text.
    while (m && inCode(code, m.index)) m = opener.exec(s);
    if (!m) { said += s.slice(i); break; }
    const a = m.index, from = a + m[0].length;
    said += s.slice(i, a);
    // The block ends at the first </tool_call> after which its JSON reads (one written inside a string comes earlier).
    let b = s.indexOf(CLOSE, from), j;
    for (let c = b; c >= 0; c = s.indexOf(CLOSE, c + CLOSE.length)) { const t = loose(s.slice(from, c)); if (t !== undefined) { b = c; j = t; break; } }
    const inner = s.slice(from, b < 0 ? s.length : b);
    if (j === undefined) j = loose(inner);
    i = b < 0 ? s.length : b + CLOSE.length;
    const name = j && typeof j === 'object' ? String(j.name || j.tool || j.function?.name || '') : (/"name"\s*:\s*"([^"]{1,80})"/.exec(inner)?.[1] || '');
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
const OPENERS = ['<tool_call', '<｜', '<|'];
const LONGEST = Math.max(...OPENERS.map((o) => o.length));
export function textFilter(onText) {
  let pending = '', stopped = false;
  return (d) => {
    if (!onText || !d || stopped) return;
    pending += d;
    const at = Math.min(...OPENERS.map((o) => { const i = pending.indexOf(o); return i < 0 ? Infinity : i; }));
    if (at !== Infinity) { stopped = true; if (at) onText(pending.slice(0, at)); pending = ''; return; }
    // Keep back a tail that could be the start of an opener.
    let keep = 0;
    for (let k = Math.min(LONGEST - 1, pending.length); k > 0 && !keep; k--) if (OPENERS.some((o) => o.startsWith(pending.slice(-k)))) keep = k;
    const out = pending.slice(0, pending.length - keep);
    pending = pending.slice(pending.length - keep);
    if (out) onText(out);
  };
}
