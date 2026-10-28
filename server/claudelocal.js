// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Claude Code on this computer as a model source ("Claude Code on this PC" in ⚙ Settings → Apps on this PC).
// Each call runs `claude -p` once, hidden, in an empty folder of QuorX's own, with every built-in tool off (--tools ""),
// no MCP servers, no settings files and QuorX's own system prompt in place of Claude Code's: so a call is just the
// model, on the plan or key the user signed in to Claude Code with. QuorX's tools go over as text (textcalls.js), and
// Claude Code's start-up event is checked: a call that starts with any tool of its own is stopped before the model runs.
// Nothing is saved to Claude Code's own history (--no-session-persistence).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { HOME } from './openrouter.js';
import { findOnPath, killTree } from './opencodelocal.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter, callKey } from './textcalls.js';

export const CLAUDE_ID = 'claude-local';
const DIR = path.join(HOME, 'data', 'claude-local'); // the folder Claude Code runs in: empty, so no project files reach the model
// Claude Code's own names for the newest model of each family: they follow its updates by themselves.
const MODELS = [
  { alias: 'fable', name: 'Claude Fable (newest)', effort: true },
  { alias: 'opus', name: 'Claude Opus (newest)', effort: true },
  { alias: 'sonnet', name: 'Claude Sonnet (newest)', effort: true },
  { alias: 'haiku', name: 'Claude Haiku (newest)', effort: false },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CONTEXT = 200000;

const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);
const running = new Set(); // calls under way: Settings shows them, and QuorX closing stops them
export const claudeRunning = () => running.size;
process.once('exit', () => { for (const p of running) if (p.pid) killTree(p.pid); });

// A .cmd runs through cmd.exe; /s strips the outer pair of quotes, so each quoted argument keeps its own.
const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
export function launch(exe, args, opts, start = spawn) {
  if (/\.(cmd|bat)$/i.test(exe)) return start(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map(quote).join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  return start(exe, args, opts);
}
// An app's environment: its own sign-in, never QuorX's OpenRouter key, and not told it runs inside another Claude Code.
export function envFor() {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  for (const k of Object.keys(env)) if (/^OPENROUTER_API_KEY/i.test(k) || /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/i.test(k)) delete env[k];
  return env;
}
const notInstalled = () => err('Claude Code is not installed on this computer (npm i -g @anthropic-ai/claude-code), or not on PATH.', { kind: 'notinstalled' });

// "claude auth status": signed in, and with what (a Claude subscription, or an API key). Cached for ten minutes.
let auth = null;
export function claudeAuth({ refresh = false, find = findOnPath, run = execFile } = {}) {
  if (auth && !refresh && Date.now() - auth.at < 10 * 60e3) return Promise.resolve(auth.v);
  const exe = find('claude');
  if (!exe) return Promise.reject(notInstalled());
  fs.mkdirSync(DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const [cmd, args, extra] = /\.(cmd|bat)$/i.test(exe) ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" auth status"`], { windowsVerbatimArguments: true }] : [exe, ['auth', 'status'], {}];
    run(cmd, args, { timeout: 30000, windowsHide: true, cwd: DIR, env: envFor(), ...extra }, (e, out) => {
      let j = null;
      try { j = JSON.parse(String(out || '')); } catch { /* not JSON: an older Claude Code */ }
      if (!j) return reject(err(`Claude Code didn't say whether it is signed in${e ? ` (${String(e.message).slice(0, 120)})` : ''}: update it with "claude update"`, { kind: e ? 'network' : 'shape' }));
      if (!j.loggedIn) return reject(err('Claude Code is not signed in. Run claude in a terminal and sign in, then test again.', { kind: 'auth', status: 401 }));
      const sub = j.authMethod === 'claude.ai' || !!j.subscriptionType;
      const v = { subscription: sub, plan: sub ? String(j.subscriptionType || 'Claude') : null, method: j.authMethod || null };
      auth = { v, at: Date.now() };
      resolve(v);
    });
  });
}
const planLabel = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : '');

/** Claude Code's models as catalogue entries (claude-local/<its name>). Reads the sign-in only: nothing is sent. */
export async function claudeModels({ authInfo } = {}) {
  const a = authInfo || await claudeAuth();
  return MODELS.map((m) => ({
    id: `${CLAUDE_ID}/${m.alias}`, realId: m.alias, providerID: 'anthropic', modelID: m.alias, providerName: 'Anthropic', source: CLAUDE_ID,
    name: m.name, kind: 'chat', ctx: CONTEXT, maxOut: null, created: 0,
    in: ['text', 'image'], out: ['text'], price: [0, 0], listPrice: [0, 0], cost: {}, plan: a.subscription ? 'plan' : 'paid',
    ...(a.subscription ? { planLabel: planLabel(a.plan) } : { priceFromApp: true }),
    tools: true, temp: false, reasoning: m.effort, variants: m.effort ? EFFORTS : [],
    format: CLAUDE_ID, status: null, canonical: null, desc: '',
  }));
}

// The effort Claude Code has closest to what QuorX asked for (none for a model without effort levels).
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function effortFor(reasoning, variants = []) {
  if (!reasoning || !variants.length) return null;
  const want = reasoning.enabled === false ? 'low' : reasoning.effort || (reasoning.max_tokens ? (reasoning.max_tokens <= 4000 ? 'low' : reasoning.max_tokens <= 10000 ? 'medium' : 'high') : null);
  if (!want) return null;
  if (variants.includes(want)) return want;
  return [...variants].sort((a, b) => Math.abs(LADDER.indexOf(a) - LADDER.indexOf(want)) - Math.abs(LADDER.indexOf(b) - LADDER.indexOf(want)))[0] || null;
}
const dataUrl = (u) => /^data:([^;,]+);base64,(.*)$/s.exec(String(u || ''));

// What Claude Code's refusal says, as an Error sources.js can classify.
export function claudeError(text, { exit } = {}) {
  const msg = String(text || '').trim() || `Claude Code stopped${exit != null ? ` (exit ${exit})` : ''} without saying why`;
  // A subscription's usage limit: "…usage limit reached|<when it resets, in seconds>".
  const limit = /usage limit|limit reached|out of extra usage|weekly limit|session limit/i.test(msg);
  if (limit) {
    const at = Number(/\|(\d{9,})/.exec(msg)?.[1]) * 1000;
    return err(msg.replace(/\|\d{9,}/, ''), { status: 429, kind: 'quota', ...(at > Date.now() ? { retryAfter: Math.round((at - Date.now()) / 1000) } : {}) });
  }
  if (/not (signed|logged) in|please run \/login|\/login|invalid api key|authenticat|oauth token|401/i.test(msg)) return err(msg, { status: 401 });
  if (/credit balance|billing|402/i.test(msg)) return err(msg, { status: 402 });
  if (/rate.?limit|429|too many requests/i.test(msg)) return err(msg, { status: 429 });
  if (/overloaded|529|5\d\d|internal server error|api error/i.test(msg)) return err(msg, { status: 503 });
  if (/model.{0,40}(not found|not available|invalid|unknown|does not exist)|no such model/i.test(msg)) return err(msg, { status: 404 });
  if (/prompt is too long|context|too large/i.test(msg)) return err(msg, { status: 400 });
  return err(msg, { kind: 'unknown' });
}

/**
 * One call through the Claude Code on this computer, read into openrouter.js chatStream's result shape. Throws with
 * .status/.kind when Claude Code or its account refuses (sources.js classifies it). `start` and `find` are for tests.
 */
export async function claudeStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, start = spawn, find = findOnPath } = {}) {
  const alias = String(body.model || '').slice(CLAUDE_ID.length + 1);
  if (!alias) throw err(`${body.model} names no Claude Code model`, { kind: 'request' });
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();
  const exe = find('claude');
  if (!exe) throw notInstalled();
  fs.mkdirSync(DIR, { recursive: true });
  // This call's key: only blocks carrying it are calls (textcalls.js).
  const key = callKey();
  const { system, transcript } = renderTranscript(body.messages, key, { calls: !!body.tools?.length && body.tool_choice !== 'none' });
  // The system prompt goes in a file: on Windows a command line holds at most 32,767 characters.
  const tag = crypto.randomBytes(6).toString('hex');
  const sysFile = path.join(DIR, `system-${tag}.txt`), mcpFile = path.join(DIR, 'no-mcp.json');
  fs.writeFileSync(sysFile, `${system}${toolPrompt(body.tools, body.tool_choice, key)}`);
  fs.writeFileSync(mcpFile, '{"mcpServers":{}}');
  const content = [{ type: 'text', text: transcript }];
  // Pictures go along when the model can see them: the newest four from any user message, oldest first.
  if ((info.in || []).includes('image')) {
    const pics = (body.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((p) => p?.type === 'image_url' && dataUrl(p.image_url?.url))).slice(-4);
    for (const p of pics) { const [, mime, data] = dataUrl(p.image_url.url); content.push({ type: 'image', source: { type: 'base64', media_type: mime, data } }); }
  }
  const effort = effortFor(body.reasoning, info.variants);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json',
    '--model', alias, '--tools', '', '--strict-mcp-config', '--mcp-config', mcpFile, '--setting-sources', '', '--no-session-persistence',
    '--system-prompt-file', sysFile, '--max-turns', '1', ...(effort ? ['--effort', effort] : [])];
  const t = Date.now();
  let proc;
  try { proc = launch(exe, args, { cwd: DIR, env: envFor(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, start); } catch (e) { fs.rmSync(sysFile, { force: true }); throw err(`Claude Code didn't start: ${e.message}`, { kind: 'network' }); }
  running.add(proc);
  let text = '', thinking = '', firstMs = null, seen = 0, result = null, failure = null, idle = null, outChars = 0, started = false, last = null, stderr = '';
  const show = textFilter(onText);
  const kill = () => { if (proc.pid) killTree(proc.pid); };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { failure ||= err(`Claude Code sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' }); kill(); }, idleMs); };
  const stop = () => kill();
  signal?.addEventListener('abort', stop, { once: true });
  const handle = (j) => {
    seen++; arm();
    if (j.type === 'system' && j.subtype === 'init') {
      // The promise QuorX makes: the model has no tools but QuorX's. A Claude Code that started with any is stopped here.
      const own = [...(Array.isArray(j.tools) ? j.tools : []), ...(Array.isArray(j.mcp_servers) ? j.mcp_servers.map((s) => `mcp:${s?.name || s}`) : [])];
      if (own.length) { failure ||= err(`Claude Code started with tools of its own (${own.slice(0, 6).join(', ')}), so QuorX stopped the call before the model ran: update Claude Code with "claude update"`, { kind: 'shape' }); kill(); }
      started = true;
    } else if (j.type === 'stream_event') {
      const ev = j.event || {};
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        if (firstMs == null) firstMs = Date.now() - t;
        text += ev.delta.text; outChars += ev.delta.text.length; show(ev.delta.text);
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
        thinking += ev.delta.thinking; outChars += ev.delta.thinking.length; onThink?.(ev.delta.thinking);
      }
    } else if (j.type === 'assistant' && j.message) {
      last = j.message;
      // Its own tool, asked for anyway: never run, and the call is stopped.
      if ((j.message.content || []).some((c) => c?.type === 'tool_use')) { failure ||= err('The model asked Claude Code for one of its own tools, which QuorX keeps off; the call was stopped', { kind: 'shape' }); kill(); }
      if (j.error) failure ||= claudeError(`${j.error}: ${(j.message.content || []).map((c) => c?.text || '').join(' ')}`);
    } else if (j.type === 'result') result = j;
  };
  try {
    proc.stdin.on('error', () => { /* it died: its exit says why */ });
    proc.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
    arm();
    const exit = await new Promise((resolve) => {
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith('{')) { try { handle(JSON.parse(l)); } catch { /* not an event */ } } }
      });
      proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
      proc.on('error', (e) => { failure ||= err(`Claude Code didn't start: ${e.message}`, { kind: 'network' }); resolve(null); });
      proc.on('close', (code) => resolve(code));
    });
    halt();
    if (failure) throw failure;
    if (!result) throw claudeError(stderr.replace(/\s+/g, ' ').trim().slice(-300) || `Claude Code ended (exit ${exit}) before the answer was done`, { exit });
    if (result.is_error || (result.subtype && result.subtype !== 'success')) throw claudeError(typeof result.result === 'string' && result.result ? result.result : (result.errors || []).join('; ') || result.subtype);
    if (!started) throw err('Claude Code answered without its start-up event, so QuorX could not check its tools were off', { kind: 'shape' });
    // No streamed text (an older Claude Code): the final message's text.
    if (!text) text = (last?.content || []).filter((c) => c?.type === 'text').map((c) => c.text || '').join('') || String(result.result || '');
    const parsed = parseToolCalls(text, `call_${t.toString(36)}`, key);
    const u = result.usage || {}, said = Number(result.total_cost_usd);
    const usage = {
      prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completion_tokens: u.output_tokens || 0,
      prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0, cache_write_tokens: u.cache_creation_input_tokens || 0 },
      // Claude Code prices each call: money on an API key; on a subscription, what it counted against the plan, at list price.
      ...(Number.isFinite(said) ? (info.plan === 'plan' ? { plan_cost: said } : { cost: said }) : {}),
    };
    const length = last?.stop_reason === 'max_tokens';
    return { text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, ...(parsed.skipped + parsed.dsml ? { skippedCalls: parsed.skipped + parsed.dsml } : {}), usage, ms: Date.now() - t, firstMs, finishReason: length ? 'length' : parsed.calls.length ? 'tool_calls' : 'stop', provider: 'Anthropic through Claude Code', model: body.model, seen: seen || 1 };
  } catch (e) {
    if (started && e && typeof e === 'object' && !e.partial) e.partial = { outChars, ms: Date.now() - t };
    throw e;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', stop);
    if (proc.exitCode == null) kill();
    running.delete(proc);
    fs.rmSync(sysFile, { force: true });
  }
}
