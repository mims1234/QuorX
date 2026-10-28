// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Grok Build on this computer as a model source ("Grok Build on this PC" in ⚙ Settings → Apps on this PC).
// Each call starts `grok agent stdio` once, hidden, in an empty folder of QuorX's own, and speaks ACP to it (JSON-RPC
// over stdin/stdout, so a long system prompt and big screenshots have no command-line limit). Grok's built-in tools are
// removed at launch, its system prompt is replaced by QuorX's (session/new _meta.systemPromptOverride), every permission
// it asks for is refused, and a call where Grok starts a tool of its own is stopped: so a call is just the model, on the
// account the user signed in to Grok with. QuorX's tools go over as text (textcalls.js).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from './openrouter.js';
import { findOnPath, killTree } from './opencodelocal.js';
import { launch, envFor, claudeError as appError } from './claudelocal.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter, callKey } from './textcalls.js';

export const GROK_ID = 'grok-local';
const DIR = path.join(HOME, 'data', 'grok-local'); // the folder Grok runs in: empty, so no project files reach the model
// Every built-in tool Grok has, by each name it goes by (an unknown name only prints a warning). `--tools` keeps one,
// and `--disallowed-tools` (applied after it) removes that one too, so none is left.
const GROK_TOOLS = ['run_terminal_cmd', 'grep', 'read_file', 'search_replace', 'list_dir', 'web_search', 'web_fetch', 'todo_write', 'task', 'write', 'Agent', 'Task',
  'Shell', 'StrReplace', 'EditNotebook', 'Delete', 'ReadLints', 'SwitchMode', 'AskQuestion', 'CreatePlan', 'CallMcpTool', 'FetchMcpResource', 'ListMcpResources',
  'GenerateImage', 'get_task_output', 'wait_tasks', 'kill_task', 'lsp', 'enter_plan_mode', 'workflow', 'monitor', 'image_gen', 'image_edit', 'glob', 'search_tool', 'use_tool'];
export const GROK_ARGS = ['--no-auto-update', '--permission-mode', 'default', '--no-subagents', '--disable-web-search', '--tools', 'todo_write', '--disallowed-tools', GROK_TOOLS.join(','), 'agent', 'stdio'];
const SAY = 'You have no tools or functions of your own: never try to use one. Use only the tools QuorX describes below, by writing the text blocks it describes.';

const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);
const running = new Set();
export const grokRunning = () => running.size;
process.once('exit', () => { for (const p of running) if (p.pid) killTree(p.pid); });
const notInstalled = () => err('Grok Build is not installed on this computer (see x.ai/cli), or not on PATH.', { kind: 'notinstalled' });
const signIn = () => err('Grok Build is not signed in. Run grok login in a terminal, then try again.', { kind: 'auth', status: 401 });

/**
 * A Grok agent process, spoken to over ACP. `send` is a request (resolves with its result), `onUpdate` gets each
 * session/update, and a permission Grok asks for is refused and counted. `start`/`find` are for tests.
 */
function startGrok({ start = spawn, find = findOnPath } = {}) {
  const exe = find('grok');
  if (!exe) throw notInstalled();
  fs.mkdirSync(DIR, { recursive: true });
  const proc = launch(exe, GROK_ARGS, { cwd: DIR, env: envFor(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, start);
  running.add(proc);
  const me = { proc, pending: new Map(), next: 1, refused: [], onUpdate: null, onDead: null, stderr: '', dead: false };
  const write = (j) => { try { proc.stdin.write(`${JSON.stringify(j)}\n`); } catch { /* it died: close says so */ } };
  me.send = (method, params, ms = 60e3) => new Promise((resolve, reject) => {
    const id = me.next++;
    const timer = setTimeout(() => { me.pending.delete(id); reject(err(`Grok Build did not answer ${method} in ${Math.round(ms / 1000)} s`, { kind: 'timeout', name: 'TimeoutError' })); }, ms);
    me.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    write({ jsonrpc: '2.0', id, method, params });
  });
  me.notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  me.close = () => { if (!me.dead && proc.pid) killTree(proc.pid); running.delete(proc); };
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.id != null && !j.method) {
        const p = me.pending.get(j.id); if (!p) continue;
        me.pending.delete(j.id);
        if (j.error) p.reject(Object.assign(appError(String(j.error.data?.message || j.error.data || j.error.message || 'Grok Build reported an error')), { rpcCode: j.error.code }));
        else p.resolve(j.result);
      } else if (j.method === 'session/request_permission') {
        // Grok asked to use a tool of its own: always no, with the option it offered for that.
        me.refused.push(String(j.params?.toolCall?.title || j.params?.toolCall?.kind || 'a tool'));
        const no = (j.params?.options || []).find((o) => o.kind === 'reject_once') || (j.params?.options || []).find((o) => /reject/.test(o.kind || ''));
        write({ jsonrpc: '2.0', id: j.id, result: { outcome: no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } } });
        me.onUpdate?.({ sessionUpdate: 'qx_refused' });
      } else if (j.id != null && j.method) write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'QuorX offers no files or terminals to Grok' } });
      else if (j.method === 'session/update') me.onUpdate?.(j.params?.update || {});
    }
  });
  proc.stderr.on('data', (d) => { me.stderr = (me.stderr + String(d)).slice(-2000); });
  const dead = (why) => { if (me.dead) return; me.dead = true; running.delete(proc); for (const [, p] of me.pending) p.reject(err(why, { kind: 'network' })); me.pending.clear(); me.onDead?.(why); };
  proc.on('error', (e) => dead(`Grok Build didn't start: ${e.message}`));
  proc.on('close', (code) => dead(`Grok Build stopped (exit ${code})${me.stderr ? `: ${me.stderr.replace(/\s+/g, ' ').trim().slice(-200)}` : ''}`));
  proc.stdin.on('error', () => { /* it died: close says so */ });
  return me;
}

// The handshake every call starts with: what Grok can take, its models, and its sign-in.
async function handshake(g) {
  const init = await g.send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'QuorX', version: '1' } }, 60e3);
  const methods = (init?.authMethods || []).map((m) => m.id);
  if (methods.includes('cached_token')) {
    try { await g.send('authenticate', { methodId: 'cached_token' }, 60e3); } catch { throw signIn(); }
  } else if (methods.length && !process.env.XAI_API_KEY) throw signIn();
  return init || {};
}

/** Grok Build's models as catalogue entries (grok-local/<its id>). Starts Grok and signs in: nothing is sent to a model. */
export async function grokModels(opts = {}) {
  const g = startGrok(opts);
  try {
    const init = await handshake(g);
    const list = init._meta?.modelState?.availableModels || [];
    const pictures = init.agentCapabilities?.promptCapabilities?.image === true;
    return list.filter((m) => m?.modelId).map((m) => {
      const meta = m._meta || {}, efforts = (meta.reasoningEfforts || []).map((e) => e.value || e.id).filter(Boolean);
      return {
        id: `${GROK_ID}/${m.modelId}`, realId: m.modelId, providerID: 'x-ai', modelID: m.modelId, providerName: 'xAI', source: GROK_ID,
        name: m.name || m.modelId, kind: 'chat', ctx: Number(meta.totalContextTokens) || null, maxOut: null, created: 0,
        in: pictures ? ['text', 'image'] : ['text'], out: ['text'], price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'plan', planLabel: 'Grok',
        tools: true, temp: false, reasoning: !!meta.supportsReasoningEffort, variants: meta.supportsReasoningEffort ? efforts : [],
        format: GROK_ID, status: null, canonical: null, desc: String(m.description || ''),
      };
    });
  } finally { g.close(); }
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
const dataUrl = (u) => /^data:([^;,]+);base64,(.*)$/s.exec(String(u || ''));
// A select option's choices, grouped or not.
const choices = (o) => (o?.options || []).flatMap((x) => (Array.isArray(x?.options) ? x.options : [x])).map((x) => x?.value).filter(Boolean);

/**
 * One call through the Grok Build on this computer, read into openrouter.js chatStream's result shape. Throws with
 * .status/.kind when Grok or its account refuses (sources.js classifies it). `start` and `find` are for tests.
 */
export async function grokStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, start = spawn, find = findOnPath } = {}) {
  const model = String(body.model || '').slice(GROK_ID.length + 1);
  if (!model) throw err(`${body.model} names no Grok model`, { kind: 'request' });
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();
  const g = startGrok({ start, find });
  const t = Date.now();
  let sid = null, text = '', thinking = '', firstMs = null, seen = 0, outChars = 0, failure = null, idle = null, prompted = false;
  const show = textFilter(onText);
  const cancel = () => { if (sid) g.notify('session/cancel', { sessionId: sid }); };
  // Any failure (Stop, a tool of its own, the process dying) ends the prompt at once instead of waiting for Grok.
  let wake = null;
  const ended = new Promise((resolve) => { wake = resolve; });
  const fail = (e) => { failure ||= e; cancel(); wake(); setTimeout(() => g.close(), 1500); };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => fail(err(`Grok Build sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' })), idleMs); };
  const stop = () => { cancel(); g.close(); };
  signal?.addEventListener('abort', stop, { once: true });
  g.onDead = (why) => { failure ||= err(why, { kind: 'network' }); wake(); };
  g.onUpdate = (u) => {
    seen++; arm();
    const k = u.sessionUpdate;
    if (k === 'agent_message_chunk' && typeof u.content?.text === 'string') {
      if (firstMs == null) firstMs = Date.now() - t;
      text += u.content.text; outChars += u.content.text.length; show(u.content.text);
    } else if (k === 'agent_thought_chunk' && typeof u.content?.text === 'string') {
      thinking += u.content.text; outChars += u.content.text.length; onThink?.(u.content.text);
    } else if (k === 'tool_call' || k === 'qx_refused') {
      // The promise QuorX makes: no tool but QuorX's. A tool Grok starts or asks for stops the call.
      fail(err(`Grok Build reached for a tool of its own (${u.title || u.kind || g.refused.at(-1) || 'a tool'}), which QuorX keeps off; the call was stopped`, { kind: 'shape' }));
    }
  };
  try {
    const init = await handshake(g);
    halt();
    const key = callKey();
    const { system, transcript } = renderTranscript(body.messages, key);
    const ses = await g.send('session/new', { cwd: DIR, mcpServers: [], _meta: { systemPromptOverride: `${system}\n\n${SAY}${toolPrompt(body.tools, body.tool_choice, key)}` } }, 120e3);
    sid = ses?.sessionId;
    if (!sid) throw err('Grok Build gave no session', { kind: 'shape' });
    const opts = ses.configOptions || [];
    // The model first, then its effort, each confirmed before the next.
    const mOpt = opts.find((o) => o.category === 'model' || o.id === 'model');
    if (mOpt && mOpt.currentValue !== model) {
      if (choices(mOpt).length && !choices(mOpt).includes(model)) throw err(`Grok Build has no model ${model} now`, { status: 404 });
      await g.send('session/set_config_option', { sessionId: sid, configId: mOpt.id, value: model }, 30e3);
    }
    const effort = grokEffort(body.reasoning, info.variants);
    const eOpt = opts.find((o) => o.category === 'thought_level');
    if (effort && eOpt && choices(eOpt).includes(effort)) await g.send('session/set_config_option', { sessionId: sid, configId: eOpt.id, value: effort }, 30e3);
    halt();
    const prompt = [{ type: 'text', text: transcript }];
    // Pictures go along when the model can see them: the newest four from any user message, oldest first.
    if ((info.in || []).includes('image') && init.agentCapabilities?.promptCapabilities?.image) {
      const pics = (body.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((p) => p?.type === 'image_url' && dataUrl(p.image_url?.url))).slice(-4);
      for (const p of pics) { const [, mime, data] = dataUrl(p.image_url.url); prompt.push({ type: 'image', mimeType: mime, data }); }
    }
    arm();
    prompted = true;
    const res = await Promise.race([g.send('session/prompt', { sessionId: sid, prompt }, 30 * 60e3), ended.then(() => null)]);
    halt();
    if (failure) throw failure;
    if (!res) throw err('Grok Build ended the call before the answer was done', { kind: 'network' });
    if (res.stopReason === 'refusal') throw err('Grok Build refused to answer this request', { status: 400 });
    if (res.stopReason === 'cancelled') throw err('Grok Build cancelled the call', { kind: 'network' });
    const u = res._meta?.usage || res._meta || {}, ticks = Number(u.costUsdTicks);
    const usage = {
      prompt_tokens: (Number(u.inputTokens) || 0) + (Number(u.cachedReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0), completion_tokens: (Number(u.outputTokens) || 0) + (Number(u.reasoningTokens) || 0),
      prompt_tokens_details: { cached_tokens: Number(u.cachedReadTokens) || 0, cache_write_tokens: Number(u.cacheCreationTokens) || 0 },
      // Grok prices each call in ten-billionths of a dollar: on a Grok plan, what it counted against the plan.
      ...(Number.isFinite(ticks) && ticks > 0 ? (info.plan === 'plan' ? { plan_cost: ticks / 1e10 } : { cost: ticks / 1e10 }) : {}),
    };
    const parsed = parseToolCalls(text, `call_${t.toString(36)}`, key);
    return { text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, usage, ms: Date.now() - t, firstMs, finishReason: res.stopReason === 'max_tokens' ? 'length' : parsed.calls.length ? 'tool_calls' : 'stop', provider: 'xAI through Grok Build', model: body.model, seen: seen || 1 };
  } catch (e) {
    const out = failure || e;
    if (prompted && out && typeof out === 'object' && !out.partial) out.partial = { outChars, ms: Date.now() - t };
    throw out;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', stop);
    g.close();
  }
}
