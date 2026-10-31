// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Grok Build on this computer as a model source ("Grok Build on this PC" in ⚙ Settings → Providers).
// Each call runs `grok` once in its one-shot mode, hidden, in an empty folder of QuorX's own, with every built-in Grok
// tool removed (only this mode honours that: its ACP mode keeps them), web search and subagents off, and a short system
// prompt in place of Grok's own. QuorX's instructions, its tools (as text: textcalls.js) and the conversation go in a
// prompt file, since a Windows command line holds at most 32,767 characters. Grok's start-up event is checked: a call
// that starts with a built-in tool, or a model that asks for any tool of Grok's, is stopped. Pictures can't go along
// (in this mode they would have to fit on the command line), so its models are listed as not seeing them.
// The model list comes from Grok's ACP handshake, which signs in and sends nothing to a model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HOME } from './openrouter.js';
import { findOnPath, killTree } from './opencodelocal.js';
import { launch, envFor, claudeError as appError, sweepPrompts } from './claudelocal.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter, callKey, notRun } from './textcalls.js';

export const GROK_ID = 'grok-local';
const DIR = path.join(HOME, 'data', 'grok-local'); // the folder Grok runs in: empty, so no project files reach the model
// Every built-in tool Grok has, by each name it goes by (an unknown name only prints a warning). `--tools` keeps one,
// and `--disallowed-tools` (applied after it) removes that one too, so none is left.
const GROK_TOOLS = ['run_terminal_cmd', 'grep', 'read_file', 'search_replace', 'list_dir', 'web_search', 'web_fetch', 'todo_write', 'task', 'write', 'Agent', 'Task',
  'Shell', 'StrReplace', 'EditNotebook', 'Delete', 'ReadLints', 'SwitchMode', 'AskQuestion', 'CreatePlan', 'CallMcpTool', 'FetchMcpResource', 'ListMcpResources',
  'GenerateImage', 'get_task_output', 'wait_tasks', 'kill_task', 'lsp', 'enter_plan_mode', 'workflow', 'monitor', 'image_gen', 'image_edit', 'glob', 'search_tool', 'use_tool'];
// Grok's own prompt advertises its tools, so a short one replaces it; QuorX's real instructions travel in the message.
const SYSTEM = 'You are a language model called by the QuorX app. You have no tools or functions of your own and must never try to use one. The message holds QuorX\'s instructions, the tools QuorX offers (call them only by writing the text blocks it describes) and the conversation. Follow those instructions exactly. Start every call block on a new line of its own, never in the middle of a sentence or after other text on the same line: a block that does not start a line is not run. Every reply either makes its calls or is your final answer: when you say what you will do next, write its call blocks in that same reply, right after that sentence. A reply that only says what you will do ends the conversation with nothing done.';
export const grokArgs = ({ model, effort, file }) => ['--no-auto-update', '-m', model, ...(effort ? ['--effort', effort] : []), '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--max-turns', '1', '--no-subagents', '--disable-web-search', '--permission-mode', 'default', '--system-prompt-override', SYSTEM,
  '--tools', 'todo_write', '--disallowed-tools', GROK_TOOLS.join(','), '--prompt-file', file];
// Grok also reads Claude Code's and Cursor's skills, MCP servers, rules, hooks and agents, its memory and workflows,
// and lists them beside QuorX's prompt: switched off for QuorX's calls only (the user's own Grok setup is untouched).
export const GROK_ENV = Object.fromEntries([
  ...['CLAUDE', 'CURSOR'].flatMap((v) => ['SKILLS', 'MCPS', 'RULES', 'AGENTS', 'HOOKS'].map((k) => [`GROK_${v}_${k}_ENABLED`, 'false'])),
  ['GROK_MANAGED_MCPS_ENABLED', 'false'], ['GROK_MEMORY', '0'], ['GROK_WORKFLOWS', '0'],
]);

// Where a reply stops being the model's own: a turn tag carrying this call's key (renderTranscript's turns).
const TURN = (key) => new RegExp(`<(?:user|assistant|tool_result) key="${key}"`);
const MAX_REPLY = 300e3; // characters in one reply; far past any file a step writes
// Its last 400 characters, written 5 times or more: a model stuck in a loop (real files rarely repeat that much verbatim).
export function repeats(text, n = 400, times = 5) {
  if (text.length < n * times) return false;
  const tail = text.slice(-n);
  let seen = 0;
  for (let i = text.indexOf(tail); i >= 0 && seen < times; i = text.indexOf(tail, i + 1)) seen++;
  return seen >= times;
}
const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);
const running = new Set();
export const grokRunning = () => running.size;
process.once('exit', () => { for (const p of running) if (p.pid) killTree(p.pid); });
const notInstalled = () => err('Grok Build is not installed on this computer (see x.ai/cli), or not on PATH.', { kind: 'notinstalled' });
const signIn = () => err('Grok Build is not signed in. Run grok login in a terminal, then try again.', { kind: 'auth', status: 401 });

// ---------- the model list, from Grok's ACP handshake ----------
/** Starts `grok agent stdio`, signs in with its cached token and reads its models; nothing is sent to a model. */
async function handshake({ start = spawn, find = findOnPath } = {}) {
  const exe = find('grok');
  if (!exe) throw notInstalled();
  fs.mkdirSync(DIR, { recursive: true });
  const proc = launch(exe, ['--no-auto-update', 'agent', 'stdio'], { cwd: DIR, env: { ...envFor(), ...GROK_ENV }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, start);
  running.add(proc);
  const pending = new Map();
  let next = 1, buf = '', stderr = '';
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(err(`Grok Build did not answer ${method} in 60 s`, { kind: 'timeout', name: 'TimeoutError' })); }, 60e3);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    try { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); } catch { /* it died: close says so */ }
  });
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      const p = j.id != null && !j.method ? pending.get(j.id) : null;
      if (!p) continue;
      pending.delete(j.id);
      if (j.error) p.reject(appError(String(j.error.data?.message || j.error.data || j.error.message || 'Grok Build reported an error')));
      else p.resolve(j.result);
    }
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
  proc.stdin.on('error', () => { /* it died: close says so */ });
  const gone = (why) => { for (const [, p] of pending) p.reject(err(why, { kind: 'network' })); pending.clear(); };
  proc.on('error', (e) => gone(`Grok Build didn't start: ${e.message}`));
  proc.on('close', (code) => gone(`Grok Build stopped (exit ${code})${stderr ? `: ${stderr.replace(/\s+/g, ' ').trim().slice(-200)}` : ''}`));
  try {
    const init = await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'QuorX', version: '1' } });
    const methods = (init?.authMethods || []).map((m) => m.id);
    if (methods.includes('cached_token')) {
      try { await send('authenticate', { methodId: 'cached_token' }); } catch { throw signIn(); }
    } else if (methods.length && !process.env.XAI_API_KEY) throw signIn();
    return init || {};
  } finally { if (proc.pid) killTree(proc.pid); running.delete(proc); }
}

/** Grok Build's models as catalogue entries (grok-local/<its id>). `start`/`find` are for tests. */
export async function grokModels(opts = {}) {
  const init = await handshake(opts);
  return (init._meta?.modelState?.availableModels || []).filter((m) => m?.modelId).map((m) => {
    const meta = m._meta || {}, efforts = (meta.reasoningEfforts || []).map((e) => e.value || e.id).filter(Boolean);
    return {
      id: `${GROK_ID}/${m.modelId}`, realId: m.modelId, providerID: 'x-ai', modelID: m.modelId, providerName: 'xAI', source: GROK_ID,
      name: m.name || m.modelId, kind: 'chat', ctx: Number(meta.totalContextTokens) || null, maxOut: null, created: 0,
      // Pictures can't reach it in the mode QuorX uses (see the top of this file).
      in: ['text'], out: ['text'], price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'plan', planLabel: 'Grok',
      tools: true, temp: false, reasoning: !!meta.supportsReasoningEffort, variants: meta.supportsReasoningEffort ? efforts : [],
      format: GROK_ID, status: null, canonical: null, desc: String(m.description || ''),
    };
  });
}

// The effort Grok has closest to what QuorX asked for (none for a model without effort levels).
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function grokEffort(reasoning, variants = []) {
  if (!reasoning || !variants.length) return null;
  const want = reasoning.enabled === false ? 'low' : reasoning.effort || (reasoning.max_tokens ? (reasoning.max_tokens <= 4000 ? 'low' : reasoning.max_tokens <= 10000 ? 'medium' : 'high') : null);
  if (!want) return null;
  if (variants.includes(want)) return want;
  return [...variants].filter((v) => LADDER.includes(v)).sort((a, b) => Math.abs(LADDER.indexOf(a) - LADDER.indexOf(want)) - Math.abs(LADDER.indexOf(b) - LADDER.indexOf(want)))[0] || null;
}
// A model's end-of-text token, written out as text by some Grok builds.
const EOS = /<\|eos\|>/g;

/**
 * One call through the Grok Build on this computer, read into openrouter.js chatStream's result shape. Throws with
 * .status/.kind when Grok or its account refuses (sources.js classifies it). `start` and `find` are for tests.
 */
export async function grokStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, start = spawn, find = findOnPath } = {}) {
  const model = String(body.model || '').slice(GROK_ID.length + 1);
  if (!model) throw err(`${body.model} names no Grok model`, { kind: 'request' });
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();
  const exe = find('grok');
  if (!exe) throw notInstalled();
  fs.mkdirSync(DIR, { recursive: true }); sweepPrompts(DIR, 'prompt-');
  // This call's key: only blocks carrying it are calls (textcalls.js).
  const key = callKey();
  const { system, transcript } = renderTranscript(body.messages, key, { calls: !!body.tools?.length && body.tool_choice !== 'none' });
  const file = path.join(DIR, `prompt-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(file, `[QuorX's instructions]\n${system}${toolPrompt(body.tools, body.tool_choice, key)}\n\n${transcript}`);
  const t = Date.now();
  let proc;
  try { proc = launch(exe, grokArgs({ model, effort: grokEffort(body.reasoning, info.variants), file }), { cwd: DIR, env: { ...envFor(), ...GROK_ENV }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, start); } catch (e) { fs.rmSync(file, { force: true }); throw err(`Grok Build didn't start: ${e.message}`, { kind: 'network' }); }
  running.add(proc);
  let text = '', thinking = '', firstMs = null, seen = 0, result = null, failure = null, idle = null, outChars = 0, started = false, stderr = '', loopCheck = 8e3;
  const show = textFilter(onText);
  const kill = () => { if (proc.pid) killTree(proc.pid); };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { failure ||= err(`Grok Build sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' }); kill(); }, idleMs); };
  signal?.addEventListener('abort', kill, { once: true });
  const handle = (j) => {
    seen++; arm();
    if (j.type === 'system' && j.subtype === 'init') {
      // The promise QuorX makes: no built-in Grok tool. (An MCP server's tools, named server__tool, can't be removed
      // here; asking for one stops the call below, and the permission mode keeps it from running.)
      const own = (Array.isArray(j.tools) ? j.tools : []).filter((x) => !String(x).includes('__'));
      if (own.length) { failure ||= err(`Grok Build started with tools of its own (${own.slice(0, 6).join(', ')}), so QuorX stopped the call before the model ran: update Grok Build`, { kind: 'shape' }); kill(); }
      started = true;
    } else if (j.type === 'stream_event') {
      const d = j.event?.delta || {};
      if (j.event?.type === 'content_block_delta' && d.type === 'text_delta' && typeof d.text === 'string') {
        if (result?.cut) return;
        const piece = d.text.replace(EOS, '');
        if (firstMs == null) firstMs = Date.now() - t;
        text += piece; outChars += piece.length; show(piece);
        // A reply that runs away: the model writes the conversation's next turns itself (a tool's result, the user's
        // reply) or doesn't stop. Its reply ends where that starts, and the model is stopped; nothing after it is read.
        // Or one that repeats itself: the same stretch of text over and over (looked for every few KB, near the end only).
        const from = Math.max(0, text.length - piece.length - 40), at = text.slice(from).search(TURN(key));
        const turn = at < 0 ? -1 : from + at;
        let loops = false;
        if (text.length >= loopCheck) { loopCheck = text.length + 8e3; loops = repeats(text); }
        if (turn >= 0 || loops || text.length > MAX_REPLY) {
          if (turn >= 0) text = text.slice(0, turn);
          result ||= { stop_reason: turn >= 0 ? 'end_turn' : 'max_tokens', usage: {}, cut: true };
          kill();
        }
      } else if (j.event?.type === 'content_block_delta' && d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        thinking += d.thinking; outChars += d.thinking.length; onThink?.(d.thinking);
      }
    } else if (j.type === 'assistant' && j.message) {
      const asked = (j.message.content || []).filter((c) => c?.type === 'tool_use' || c?.type === 'server_tool_use');
      if (asked.length) { failure ||= err(`Grok Build reached for a tool of its own (${asked[0].name || 'a tool'}), which QuorX keeps off; the call was stopped`, { kind: 'shape' }); kill(); }
    } else if (j.type === 'result') result = j;
  };
  try {
    arm();
    const exit = await new Promise((resolve) => {
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith('{')) { try { handle(JSON.parse(l)); } catch { /* not an event */ } } }
      });
      proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
      proc.on('error', (e) => { failure ||= err(`Grok Build didn't start: ${e.message}`, { kind: 'network' }); resolve(null); });
      proc.on('close', (code) => resolve(code));
    });
    halt();
    if (failure) throw failure;
    const said = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    if (!result) throw /not (authenticated|signed in|logged in)/i.test(stderr) ? signIn() : appError(said(stderr).slice(-300) || `Grok Build ended (exit ${exit}) before the answer was done`, { exit });
    if (result.is_error || (result.subtype && result.subtype !== 'success')) {
      const why = (result.errors || []).join('; ') || said(stderr).slice(-300) || result.subtype;
      throw /not (authenticated|signed in|logged in)/i.test(why) ? signIn() : appError(why);
    }
    if (!started) throw err('Grok Build answered without its start-up event, so QuorX could not check its tools were off', { kind: 'shape' });
    const parsed = parseToolCalls(text.replace(EOS, ''), `call_${t.toString(36)}`, key);
    const u = result.usage || {}, cost = Number(result.total_cost_usd);
    const usage = {
      prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completion_tokens: u.output_tokens || 0,
      prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0, cache_write_tokens: u.cache_creation_input_tokens || 0 },
      // Grok prices each call: on a Grok plan, what it counted against the plan.
      ...(Number.isFinite(cost) && cost > 0 ? (info.plan === 'plan' ? { plan_cost: cost } : { cost }) : {}),
    };
    return { text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, ...notRun(parsed), usage, ms: Date.now() - t, firstMs, finishReason: result.stop_reason === 'max_tokens' ? 'length' : parsed.calls.length ? 'tool_calls' : 'stop', provider: 'xAI through Grok Build', model: body.model, seen: seen || 1 };
  } catch (e) {
    if (started && e && typeof e === 'object' && !e.partial) e.partial = { outChars, ms: Date.now() - t };
    throw e;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', kill);
    if (proc.exitCode == null) kill();
    running.delete(proc);
    fs.rmSync(file, { force: true });
  }
}
