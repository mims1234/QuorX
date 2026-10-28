// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Cline CLI on this computer as a model source ("Cline on this PC" in ⚙ Settings → Apps on this PC).
// QuorX runs `cline --acp` (the Agent Client Protocol: JSON-RPC over stdio) in an empty folder of its own, and Cline
// makes each call with the account the user signed in to there (Cline credits, ClinePass or a ChatGPT subscription), so
// QuorX holds no key and never touches Cline's sign-in. Cline always gives the model its own system prompt and tools,
// but asks before running any tool: QuorX refuses every one and stops the turn, and QuorX's tools go over as text in
// ```tool_call blocks (textcalls.js; Cline strips <tool_call> tags from what it passes on). Cline reports no usage, so a
// call is counted at an estimate from its characters, at the model's list price.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { HOME } from './openrouter.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter } from './textcalls.js';
import { findOnPath } from './opencodelocal.js';

export const CLINE_ID = 'cline-local';
const DIR = path.join(HOME, 'data', 'cline-local'); // where Cline runs: empty, so no project files reach the model
const IDLE_STOP_MS = 15 * 60e3;
const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);

let proc = null; // { child, send, pending, calls, ready, lastUse, active, dead, log, provider, models, version }
let lastError = '';
export const clineServer = () => (proc && !proc.dead && proc.up ? { running: true, since: proc.startedAt, pid: proc.child?.pid || null, provider: proc.provider || null } : { running: false, ...(lastError ? { error: lastError } : {}) });
const killTree = (pid) => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
export function stopCline() { const p = proc; proc = null; if (p?.child?.pid && !p.dead) killTree(p.child.pid); }
process.once('exit', stopCline);
// Cline takes a few hundred MB: it stops after a quiet quarter of an hour, and starts again on the next call.
setInterval(() => { if (proc && !proc.active && Date.now() - proc.lastUse > IDLE_STOP_MS) stopCline(); }, 60e3).unref();

/**
 * The Cline CLI in ACP mode, started if it isn't running. `start` and `find` are for tests (a fake agent).
 */
export async function ensureCline({ start = spawn, find = findOnPath, readyMs = 60e3 } = {}) {
  if (proc && !proc.dead) {
    try { await proc.ready; } catch { /* started badly: start again below */ }
    if (proc && !proc.dead && proc.up) { proc.lastUse = Date.now(); return proc; }
  }
  const exe = find('cline');
  if (!exe) throw err('Cline is not installed on this computer (npm i -g cline), or not on PATH.', { kind: 'notinstalled' });
  fs.mkdirSync(DIR, { recursive: true });
  // Cline uses its own sign-in: QuorX's OpenRouter key stays out of its environment.
  const env = { ...process.env, CLINE_NO_AUTO_UPDATE: '1' };
  for (const k of Object.keys(env)) if (/^OPENROUTER_API_KEY/i.test(k)) delete env[k];
  const cmd = /\.(cmd|bat)$/i.test(exe);
  const child = cmd
    ? start(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" --acp"`], { cwd: DIR, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : start(exe, ['--acp'], { cwd: DIR, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const me = { child, pending: new Map(), calls: new Map(), id: 0, startedAt: Date.now(), lastUse: Date.now(), active: 0, log: '', up: false, dead: false };
  const keep = (d) => { me.log = (me.log + String(d)).slice(-2000); };
  child.stderr?.on('data', keep);
  const fail = (why) => { me.dead = true; for (const [, p] of me.pending) p.reject(err(why, { kind: 'network' })); me.pending.clear(); for (const [, c] of me.calls) c.onDead?.(why); if (proc === me) proc = null; };
  child.on('exit', () => fail(`Cline stopped${me.log ? `: ${me.log.replace(/\s+/g, ' ').trim().slice(-200)}` : ''}`));
  child.on('error', (e) => { keep(e.message); fail(`Cline could not start: ${e.message}`); });
  const write = (j) => { try { child.stdin.write(`${JSON.stringify(j)}\n`); } catch { /* it died: fail() says so */ } };
  me.send = (method, params, ms = 60e3) => new Promise((resolve, reject) => {
    const id = ++me.id;
    const timer = setTimeout(() => { me.pending.delete(id); reject(err(`Cline did not answer ${method} in ${Math.round(ms / 1000)} s`, { kind: 'timeout', name: 'TimeoutError' })); }, ms);
    me.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    write({ jsonrpc: '2.0', id, method, params });
  });
  me.notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { keep(line); continue; }
      if (j.method && j.id != null) {
        // Cline asks before each of its own tools: always no. Files and terminals were never offered.
        if (j.method === 'session/request_permission') {
          me.calls.get(j.params?.sessionId)?.onOwnTool?.(j.params?.toolCall);
          const opts = j.params?.options || [];
          const no = opts.find((o) => o.kind === 'reject_once') || opts.find((o) => /reject/.test(o.kind || ''));
          write({ jsonrpc: '2.0', id: j.id, result: { outcome: no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } } });
        } else write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'QuorX offers no files or terminals to Cline' } });
      } else if (j.method === 'session/update') me.calls.get(j.params?.sessionId)?.onUpdate?.(j.params.update || {});
      else if (j.id != null && me.pending.has(j.id)) {
        const p = me.pending.get(j.id); me.pending.delete(j.id);
        if (j.error) p.reject(err(String(j.error.data?.message || j.error.message || 'Cline reported an error').replace(/^Internal error:\s*/i, ''), { rpcCode: j.error.code }));
        else p.resolve(j.result);
      }
    }
  });
  proc = me;
  me.ready = (async () => {
    const init = await me.send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, readyMs);
    me.version = init?.agentInfo?.version || null;
    me.up = true; lastError = '';
  })();
  try { await me.ready; } catch (e) { lastError = e.message; stopCline(); throw e.kind ? e : err(`Cline did not start: ${e.message}`, { kind: 'network' }); }
  return me;
}

// A fresh Cline session in QuorX's empty folder: its models, and the account it bills.
async function newSession(p, signal) {
  const r = await p.send('session/new', { cwd: DIR, mcpServers: [] }, 60e3);
  if (signal?.aborted) throw new Error('Stopped.');
  const opts = Array.isArray(r?.configOptions) ? r.configOptions : [];
  p.provider = opts.find((o) => o.id === 'provider')?.currentValue || p.provider || 'cline';
  return r;
}
// How each Cline account pays: credits per call, or a subscription.
const PLAN_PROVIDERS = new Set(['cline-pass', 'openai-codex']);
const PROVIDER_NAME = { cline: 'Cline credits', 'cline-pass': 'ClinePass', 'openai-codex': 'ChatGPT subscription' };

/**
 * Every model Cline offers the account it is signed in to, as catalogue entries (cline-local/<model>). `orList`
 * (OpenRouter's catalogue; Cline's ids are OpenRouter's) gives each one its context, abilities and list price.
 */
export async function clineModels({ orList = [] } = {}) {
  const p = await ensureCline();
  const r = await newSession(p);
  const raw = Array.isArray(r?.models?.availableModels) ? r.models.availableModels.map((m) => ({ id: m.modelId, name: m.name }))
    : (r?.configOptions || []).find((o) => o.id === 'model')?.options?.map((o) => ({ id: o.value, name: o.name })) || [];
  const by = new Map(orList.map((m) => [m.id, m]));
  // Cline names some vendors its own way (zai/ for OpenRouter's z-ai/): the same model name then finds the twin.
  const tail = (id) => String(id || '').split('/').pop().replace(/:.*$/, '').toLowerCase();
  const byTail = new Map();
  for (const m of orList) if (!/:(free|batch)$/.test(m.id) && !byTail.has(tail(m.id))) byTail.set(tail(m.id), m);
  const plan = PLAN_PROVIDERS.has(p.provider);
  return raw.filter((m) => m?.id).map((m) => {
    const tw = by.get(m.id) || by.get(m.id.replace(/^~/, '')) || by.get(m.id.replace(/:free$/, '')) || byTail.get(tail(m.id)) || {};
    const free = /:free$/.test(m.id), list = Array.isArray(tw.price) ? tw.price : [0, 0];
    return {
      id: `${CLINE_ID}/${m.id}`, realId: m.id, source: CLINE_ID, providerID: p.provider, providerName: PROVIDER_NAME[p.provider] || p.provider,
      name: `${m.name || m.id} · Cline`, kind: 'chat', ctx: tw.ctx || null, maxOut: tw.maxOut || null, created: tw.created || 0,
      // Cline's ACP passes only text on, so pictures stay with QuorX.
      in: ['text'], out: ['text'], price: free || plan ? [0, 0] : list, listPrice: list, cost: { input: list[0], output: list[1] },
      plan: free ? 'free' : plan ? 'plan' : 'paid', ...(free ? { free: true } : {}),
      tools: true, temp: true, reasoning: !!tw.reasoning, format: CLINE_ID, status: null, canonical: m.id.replace(/^~/, '').replace(/:free$/, ''), desc: tw.desc || '',
    };
  });
}

/**
 * One call through the Cline on this computer, read into openrouter.js chatStream's result shape. Throws with .kind
 * when Cline or its provider refuses (sources.js classifies it).
 */
export async function clineStream(body, signal, onText, onThink, opts = {}) {
  // A model that reached for Cline's own tools instead of QuorX's gets one more go, told what went wrong.
  try { return await clineOnce(body, signal, onText, onThink, opts); }
  catch (e) {
    if (!e.ownTool || signal?.aborted) throw e;
    return clineOnce(body, signal, onText, onThink, { ...opts, reminder: `Your last answer used Cline's own tool (${e.ownTool}), which is switched off here, so nothing ran. Call QuorX's tools only, with \`\`\`tool_call blocks as described above.` });
  }
}
async function clineOnce(body, signal, onText, onThink, { info = {}, idleMs = 180e3, reminder = '' } = {}) {
  const modelId = String(body.model || '').slice(CLINE_ID.length + 1);
  if (!modelId) throw err(`${body.model} names no Cline model`, { kind: 'request' });
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();
  const p = await ensureCline();
  halt();
  p.active++; p.lastUse = Date.now();
  const t = Date.now();
  let sid = null;
  try {
    sid = (await newSession(p, signal))?.sessionId;
    if (!sid) throw err('Cline gave no session', { kind: 'shape' });
    halt();
    await p.send('session/set_model', { sessionId: sid, modelId }, 30e3);
    halt();
    const { system, transcript } = renderTranscript(body.messages, 'fence');
    const prompt = `[QuorX] You are the model inside QuorX, an app that runs its own tools. Your built-in tools are switched off here: every call to one is refused and ends your turn. Answer in text, and call QuorX's tools as described below.\n\n[Instructions from QuorX]\n${system}${toolPrompt(body.tools, body.tool_choice, 'fence')}\n\n[Conversation]\n${transcript}${reminder ? `\n\n[QuorX] ${reminder}` : ''}`;
    let text = '', thinking = '', firstMs = null, ownTool = null, idle = null, failure = null, cancelled = false;
    const show = textFilter(onText);
    const cancel = () => { if (!cancelled) { cancelled = true; p.notify('session/cancel', { sessionId: sid }); } };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { failure ||= err(`Cline sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' }); cancel(); }, idleMs); };
    p.calls.set(sid, {
      onUpdate: (u) => {
        arm();
        const d = u.content?.type === 'text' ? String(u.content.text || '') : '';
        if (u.sessionUpdate === 'agent_message_chunk' && d) { if (firstMs == null) firstMs = Date.now() - t; text += d; show(d); }
        else if (u.sessionUpdate === 'agent_thought_chunk' && d) { thinking += d; onThink?.(d); }
        else if (u.sessionUpdate === 'tool_call') { ownTool ||= u.title || u.kind || 'a tool'; cancel(); }
      },
      // One of Cline's own tools: refused (above), and the turn stops so the model doesn't carry on without it.
      onOwnTool: (tc) => { ownTool ||= tc?.title || tc?.kind || 'a tool'; cancel(); },
      onDead: (why) => { failure ||= err(why, { kind: 'network' }); },
    });
    const stopNow = () => cancel();
    signal?.addEventListener('abort', stopNow, { once: true });
    arm();
    let res;
    try { res = await p.send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: prompt }] }, 30 * 60e3); }
    catch (e) { failure ||= fromError(e); }
    finally { clearTimeout(idle); signal?.removeEventListener('abort', stopNow); }
    halt();
    const parsed = parseToolCalls(text, `call_${t.toString(36)}`);
    // A refused tool of Cline's own, with no call of QuorX's: whatever it said, nothing it meant to do ran.
    if (!parsed.calls.length && ownTool) throw err(`The model used Cline's own tool (${String(ownTool).slice(0, 60)}) instead of QuorX's`, { kind: 'shape', ownTool: String(ownTool).slice(0, 60) });
    if (failure && !(cancelled && ownTool && (parsed.calls.length || parsed.text))) throw failure;
    if (!text && !thinking) {
      // Cline keeps a provider's refusal ("Insufficient balance…") in its own session file and sends nothing: read it.
      const said = savedAnswer(sid);
      throw said ? fromError(new Error(said)) : err('Cline ended the answer without any text', { kind: 'shape' });
    }
    // Cline reports no tokens: about 4 characters a token, priced by sources.js at the model's list price.
    const usage = { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil((text.length + thinking.length) / 4), estimated: true };
    const stop = res?.stopReason;
    return { text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, usage, ms: Date.now() - t, firstMs, finishReason: parsed.calls.length ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop', provider: `${info.providerName || PROVIDER_NAME[p.provider] || 'Cline'} through Cline`, model: body.model, seen: 1 };
  } finally {
    if (sid) p.calls.delete(sid);
    p.active = Math.max(0, p.active - 1); p.lastUse = Date.now();
  }
}
// The last thing Cline saved as the model's answer in a session (its data folder: CLINE_DATA_DIR, else ~/.cline/data).
const CLINE_DATA = () => process.env.CLINE_DATA_DIR || path.join(process.env.QX_SOURCES_HOME || os.homedir(), '.cline', 'data');
function savedAnswer(sid) {
  try {
    const f = path.join(CLINE_DATA(), 'sessions', sid, `${sid}.messages.json`);
    const msgs = JSON.parse(fs.readFileSync(f, 'utf8'))?.messages || [];
    const last = [...msgs].reverse().find((m) => m?.role === 'assistant');
    const t = (Array.isArray(last?.content) ? last.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join(' ').trim();
    return t.slice(0, 400);
  } catch { return ''; }
}
// Cline's error (an ACP error whose message is the provider's) as an Error sources.js can classify.
function fromError(e) {
  const m = String(e?.message || 'Cline reported an error');
  if (e?.kind) return e;
  if (/sign in|signed in|authenticat|unauthori[sz]ed|re-authenticate|401/i.test(m)) return err(m, { status: 401 });
  if (/insufficient|credit|balance|402/i.test(m)) return err(m, { status: 402, errorType: 'insufficient_credits' });
  if (/rate limit|429|too many/i.test(m)) return err(m, { status: 429 });
  if (/empty response/i.test(m)) return err(m, { kind: 'shape' });
  if (/model[^.]{0,40}(not found|unavailable|unknown)|404/i.test(m)) return err(m, { status: 404 });
  return err(m, { status: 502 });
}
