// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The OpenCode on this computer as a model source ("OpenCode on this PC" in ⚙ Settings → OpenCode & Cline).
// QuorX starts OpenCode's own server (hidden, on a free local port, with a random password, in an empty folder of its
// own) with a QuorX agent that has no tools and no prompt of its own, so a call is just the model. OpenCode makes the
// call, so every provider the user connected there works as it does in OpenCode: their plans, keys and sign-ins.
// QuorX's tools go over as text (textcalls.js) and every call is one fresh OpenCode session, deleted afterwards, so the
// user's own session list stays clean. A refusal OpenCode would keep retrying (a used-up free tier, a rate limit) fails
// the call at once instead, and QuorX falls back to OpenRouter (agent.js).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { HOME } from './openrouter.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter, callKey } from './textcalls.js';

export const LOCAL_ID = 'opencode-local';
const DIR = path.join(HOME, 'data', 'opencode-local'); // the folder OpenCode runs in: empty, so no project files reach the model
const OC_TOOLS = ['invalid', 'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'webfetch', 'todowrite', 'websearch', 'skill', 'apply_patch'];
const NO_TOOLS = Object.fromEntries([['*', false], ...OC_TOOLS.map((t) => [t, false])]);
// QuorX's agent inside OpenCode: QuorX writes the whole system prompt, and OpenCode's own tools are off.
// No compaction inside a call either: QuorX trims its own transcript, and OpenCode's would be two more paid calls.
const CONFIG = { agent: { quorx: { mode: 'primary', description: 'Calls from QuorX', prompt: 'Follow the system instructions you are given exactly.', tools: { '*': false } } }, autoupdate: false, share: 'disabled', compaction: { auto: false, prune: false } };
// The most a call may write: QuorX's own output limit is per step, so OpenCode's 32k default would cut big files.
const OUTPUT_MAX = 128000;
const IDLE_STOP_MS = 15 * 60e3;

/** A program on PATH (Windows: with its .cmd/.exe), or null. */
export function findOnPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) { const f = path.join(dir, name + ext); try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ } }
  }
  return null;
}

let srv = null; // { base, auth, proc, ready, startedAt, lastUse, active, log, dead }
export const localServer = () => (srv && !srv.dead && srv.up ? { running: true, port: Number(new URL(srv.base).port), since: srv.startedAt, pid: srv.proc?.pid || null } : { running: false, ...(lastError ? { error: lastError } : {}) });
let lastError = '';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const killTree = (pid) => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } };
export function stopLocalServer() { const s = srv; srv = null; if (s?.proc?.pid && !s.dead) killTree(s.proc.pid); forget(); }
process.once('exit', stopLocalServer);
// A QuorX that was killed (Task Manager, a crash, the app closing it hard) never ran its exit handler, so the server it
// started is written down, and the next QuorX stops it: only when that process is still a cmd.exe or opencode.exe,
// never a process that happens to have reused the number.
const PIDFILE = path.join(DIR, 'server.json');
const forget = () => { try { fs.rmSync(PIDFILE, { force: true }); } catch { /* gone */ } };
function isOurs(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return true; } catch { return false; } }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  return /^"(cmd|opencode)\.exe"/im.test(String(r.stdout || ''));
}
// The OpenCode server QuorX started on that port: its command line names the port, which was free and random.
function serverPids(port) {
  if (!Number.isInteger(port) || process.platform !== 'win32') return [];
  const ps = `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -match 'serve --hostname 127\\.0\\.0\\.1 --port ${port}( |$)' } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
export function reapLeftover() {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch { return false; }
  if (!rec?.pid || (srv && srv.proc?.pid === rec.pid)) return false;
  // The cmd.exe that started it may be gone already (it dies with QuorX); OpenCode itself is found by its port.
  const pids = new Set([...(isOurs(rec.pid) ? [rec.pid] : []), ...serverPids(Number(rec.port))]);
  for (const pid of pids) killTree(pid);
  forget();
  return pids.size > 0;
}
setTimeout(() => { try { reapLeftover(); } catch { /* best effort */ } }, 2000).unref();
// OpenCode takes a few hundred MB: it stops after a quiet quarter of an hour, and starts again on the next call.
setInterval(() => { if (srv && !srv.active && Date.now() - srv.lastUse > IDLE_STOP_MS) stopLocalServer(); }, 60e3).unref();

const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);
/**
 * OpenCode's server, started if it isn't running. QX_OPENCODE_URL (and QX_OPENCODE_AUTH) point at one that is
 * already running instead (tests use a fake one).
 */
export async function ensureLocalServer({ start = spawn, find = findOnPath, readyMs = 60e3 } = {}) {
  if (process.env.QX_OPENCODE_URL) return { base: process.env.QX_OPENCODE_URL.replace(/\/+$/, ''), auth: process.env.QX_OPENCODE_AUTH || '', external: true, lastUse: Date.now(), active: 0 };
  if (srv && !srv.dead) {
    try { await srv.ready; } catch { /* started badly: start again below */ }
    if (srv && !srv.dead && srv.up) { srv.lastUse = Date.now(); return srv; }
  }
  const exe = find('opencode');
  if (!exe) throw err('OpenCode is not installed on this computer (npm i -g opencode-ai), or not on PATH.', { kind: 'notinstalled' });
  fs.mkdirSync(DIR, { recursive: true });
  reapLeftover();
  const port = await freePort(), pass = crypto.randomBytes(18).toString('base64url');
  // OpenCode uses its own sign-ins and keys: QuorX's OpenRouter key stays out of its environment.
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: pass, OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG), OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_MAX) };
  for (const k of Object.keys(env)) if (/^OPENROUTER_API_KEY/i.test(k)) delete env[k];
  const cmd = /\.(cmd|bat)$/i.test(exe);
  const proc = cmd
    ? start(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" serve --hostname 127.0.0.1 --port ${port}"`], { cwd: DIR, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : start(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: DIR, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const me = { base: `http://127.0.0.1:${port}`, auth: `Basic ${Buffer.from(`opencode:${pass}`).toString('base64')}`, proc, startedAt: Date.now(), lastUse: Date.now(), active: 0, log: '', up: false, dead: false };
  const keep = (d) => { me.log = (me.log + String(d)).slice(-2000); };
  proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
  proc.on('exit', () => { me.dead = true; if (srv === me) { srv = null; forget(); } });
  try { if (proc.pid) fs.writeFileSync(PIDFILE, JSON.stringify({ pid: proc.pid, port, at: me.startedAt })); } catch { /* best effort */ }
  proc.on('error', (e) => { me.dead = true; keep(e.message); });
  srv = me;
  me.ready = (async () => {
    const until = Date.now() + readyMs;
    while (Date.now() < until && !me.dead) {
      try {
        const r = await fetch(`${me.base}/agent`, { headers: { Authorization: me.auth }, signal: AbortSignal.timeout(3000) });
        // A refused password or a broken OpenCode config won't change by waiting: say so now.
        if (r.status === 401) throw err('OpenCode’s server refused QuorX’s password (is OPENCODE_SERVER_USERNAME or a proxy in the way?)', { kind: 'auth', permanent: true });
        if (r.status === 400) { const t = await r.text().catch(() => ''); throw err(`OpenCode’s server refused QuorX: ${(/"message"\s*:\s*"([^"]+)/.exec(t)?.[1] || t).slice(0, 200) || 'HTTP 400'} (check your OpenCode config)`, { kind: 'request', permanent: true }); }
        if (r.ok) {
          const agents = await r.json().catch(() => []);
          if (!Array.isArray(agents) || !agents.some((a) => a?.name === 'quorx')) throw err('this OpenCode did not take QuorX’s agent settings (it may be too old: update it with "opencode upgrade")');
          me.up = true; lastError = '';
          return;
        }
      } catch (e) { if (/agent settings/.test(e.message) || e.permanent) throw e; }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw err(`OpenCode's server did not start${me.log ? `: ${me.log.replace(/\s+/g, ' ').trim().slice(-200)}` : ''}`, { kind: 'network' });
  })();
  try { await me.ready; } catch (e) { lastError = e.message; stopLocalServer(); throw e; }
  return me;
}

const call = (s, method, p, body, signal) => fetch(s.base + p, { method, headers: { ...(s.auth ? { Authorization: s.auth } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal });

/** Every model of every provider connected in OpenCode, as catalogue entries (opencode-local/<provider>/<model>). */
export async function localModels({ server } = {}) {
  const s = server || await ensureLocalServer();
  const r = await call(s, 'GET', '/config/providers', null, AbortSignal.timeout(30000));
  if (!r.ok) throw err(`OpenCode's server said HTTP ${r.status}`, { status: r.status });
  const j = await r.json();
  const out = [];
  for (const p of Array.isArray(j?.providers) ? j.providers : []) {
    for (const m of Object.values(p?.models || {})) {
      try {
        if (!m?.id || m.capabilities?.output?.text === false || m.capabilities?.input?.text === false) continue;
        const c = m.cost || {}, list = [Number(c.input) || 0, Number(c.output) || 0];
        const plan = p.id === 'opencode-go' ? 'plan' : !list[0] && !list[1] ? 'free' : 'paid';
        out.push({
          id: `${LOCAL_ID}/${p.id}/${m.id}`, realId: `${p.id}/${m.id}`, providerID: p.id, modelID: m.id, providerName: p.name || p.id, source: LOCAL_ID,
          name: `${m.name || m.id} · ${p.name || p.id}`, kind: 'chat', ctx: m.limit?.context || null, maxOut: m.limit?.output || null,
          created: m.release_date ? Math.floor(Date.parse(m.release_date) / 1000) || 0 : 0,
          in: m.capabilities?.input?.image ? ['text', 'image'] : ['text'], out: ['text'],
          price: plan === 'paid' ? list : [0, 0], listPrice: list, cost: { input: list[0], output: list[1], ...(c.cache?.read != null ? { cache_read: c.cache.read } : {}), ...(c.cache?.write != null ? { cache_write: c.cache.write } : {}) }, plan,
          tools: true, temp: m.capabilities?.temperature !== false, reasoning: !!m.capabilities?.reasoning, variants: Object.keys(m.variants || {}),
          format: LOCAL_ID, status: m.status === 'deprecated' ? 'deprecated' : null, canonical: null, desc: '',
        });
      } catch { /* one odd entry */ }
    }
  }
  return out;
}

// The reasoning variant OpenCode has for this model closest to what QuorX asked for (none when it has none).
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function variantFor(reasoning, variants = []) {
  if (!reasoning || !variants.length) return null;
  const want = reasoning.enabled === false ? 'none' : reasoning.effort || (reasoning.max_tokens ? (reasoning.max_tokens <= 4000 ? 'low' : reasoning.max_tokens <= 10000 ? 'medium' : 'high') : null);
  if (!want) return null;
  const vs = variants.filter((v) => LADDER.includes(v));
  if (vs.includes(want)) return want;
  if (want === 'none') return vs.includes('minimal') ? 'minimal' : [...vs].sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b))[0] || null;
  return [...vs].sort((a, b) => Math.abs(LADDER.indexOf(a) - LADDER.indexOf(want)) - Math.abs(LADDER.indexOf(b) - LADDER.indexOf(want)))[0] || null;
}
const dataUrl = (u) => { const m = /^data:([^;,]+);base64,/.exec(String(u || '')); return m ? m[1] : null; };

/**
 * One call through the OpenCode on this computer, read into openrouter.js chatStream's result shape. Throws with
 * .status/.errorType/.kind when OpenCode or its provider refuses (sources.js classifies it).
 */
export async function localStream(body, signal, onText, onThink, { info = {}, idleMs = 180e3, server } = {}) {
  const rest = String(body.model || '').slice(LOCAL_ID.length + 1);
  const cut = rest.indexOf('/');
  if (cut <= 0) throw err(`${body.model} names no OpenCode provider`, { kind: 'request' });
  const providerID = rest.slice(0, cut), modelID = rest.slice(cut + 1);
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();
  const s = server || await ensureLocalServer();
  halt();
  s.active = (s.active || 0) + 1; s.lastUse = Date.now();
  const t = Date.now();
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let sid = null, accepted = false, outChars = 0;
  try {
    const created = await call(s, 'POST', '/session', { title: 'QuorX' }, AbortSignal.any([ac.signal, AbortSignal.timeout(30000)]));
    if (!created.ok) throw err(`OpenCode's server said HTTP ${created.status}`, { status: created.status >= 500 ? created.status : 502 });
    sid = (await created.json())?.id;
    if (!sid) throw err('OpenCode gave no session', { kind: 'shape' });
    // This call's key: only blocks carrying it are calls (textcalls.js).
    const key = callKey();
    const { system, transcript } = renderTranscript(body.messages, key);
    const parts = [{ type: 'text', text: transcript }];
    // Pictures go along when the model can see them: the newest four from any user message (the user's own attachment
    // stays after a later screenshot), oldest first.
    if ((info.in || []).includes('image')) {
      const pics = (body.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((p) => p?.type === 'image_url' && dataUrl(p.image_url?.url))).slice(-4);
      for (const p of pics) parts.push({ type: 'file', mime: dataUrl(p.image_url.url), url: p.image_url.url, filename: `picture-${parts.length}` });
    }
    const variant = variantFor(body.reasoning, info.variants);
    // Events first, so nothing of this call's stream is missed.
    const opening = setTimeout(() => ac.abort(), 30e3); // an event stream that never opens
    const ev = await fetch(`${s.base}/event`, { headers: s.auth ? { Authorization: s.auth } : {}, signal: ac.signal }).finally(() => clearTimeout(opening));
    if (!ev.ok || !ev.body) throw err(`OpenCode's event stream said HTTP ${ev.status}`, { status: 502 });
    const sent = await call(s, 'POST', `/session/${sid}/prompt_async`, { agent: 'quorx', model: { providerID, modelID }, system: `${system}${toolPrompt(body.tools, body.tool_choice, key)}`, tools: NO_TOOLS, ...(variant ? { variant } : {}), parts }, ac.signal);
    if (!sent.ok) throw err(`OpenCode refused the prompt (HTTP ${sent.status}): ${(await sent.text().catch(() => '')).slice(0, 200)}`, { status: sent.status });
    accepted = true;
    // Only the model's own message counts: OpenCode streams the prompt's parts too (QuorX's transcript).
    const kinds = new Map(), finalText = new Map(), order = [], mine = new Set();
    let thinking = '', firstMs = null, done = false, seen = 0, lastInfo = null, failure = null, idle = null;
    const costs = new Map(); // every assistant message's final cost: a call OpenCode made on its own is counted too
    const show = textFilter(onText);
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { failure ||= err(`OpenCode sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' }); ac.abort(); }, idleMs); };
    arm();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (e) => {
      const p = e?.properties || {};
      const of = p.sessionID || p.info?.sessionID || p.part?.sessionID;
      if (of !== sid) return;
      seen++; arm();
      if (e.type === 'message.updated' && p.info?.role === 'user') { mine.add(p.info.id); return; }
      if ((e.type === 'message.part.updated' && mine.has(p.part?.messageID)) || (e.type === 'message.part.delta' && mine.has(p.messageID))) return;
      if (e.type === 'message.part.updated' && p.part) {
        const part = p.part;
        kinds.set(part.id, part.type);
        if ((part.type === 'text' || part.type === 'reasoning') && !order.includes(part.id)) order.push(part.id);
        if (typeof part.text === 'string') finalText.set(part.id, part.text);
      } else if (e.type === 'message.part.delta' && typeof p.delta === 'string' && (p.field || 'text') === 'text') {
        const k = kinds.get(p.partID);
        outChars += p.delta.length;
        if (k === 'reasoning') { thinking += p.delta; onThink?.(p.delta); }
        else if (k === 'text' || !k) { if (firstMs == null) firstMs = Date.now() - t; if (!order.includes(p.partID)) order.push(p.partID); finalText.set(p.partID, (finalText.get(p.partID) || '') + p.delta); show(p.delta); }
      } else if (e.type === 'message.updated' && p.info?.role === 'assistant') {
        lastInfo = p.info;
        if (Number.isFinite(Number(p.info.cost))) costs.set(p.info.id, Number(p.info.cost));
        if (p.info.error) failure ||= fromError(p.info.error);
      } else if (e.type === 'session.status' && p.status?.type === 'retry') {
        // A short wait (an overload, a brief rate limit) is OpenCode's to sit out: its retries are few and the idle timer
        // still applies. A used-up free tier, plan or credit, or a long wait, fails the call now.
        const msg = String(p.status.message || 'the provider refused the call'), wait = p.status.next ? Number(p.status.next) - Date.now() : 0;
        const spent = /free|quota|credit|balance|insufficient|usage limit|plan limit|limit reached|exceeded your/i.test(msg) || /free_tier|account_rate/i.test(String(p.status.action?.reason || ''));
        if (spent || wait > 30e3) {
          const free = /free/i.test(msg) || /free_tier/i.test(String(p.status.action?.reason || ''));
          failure ||= err(msg, { status: spent ? (free ? 429 : 402) : /limit|429|rate|too many/i.test(msg) ? 429 : 503, ...(free ? { errorType: 'FreeUsageLimitError' } : {}), retryAfter: wait > 0 ? Math.max(1, Math.round(wait / 1000)) : undefined });
          done = true;
        }
      } else if (e.type === 'session.error') { failure ||= fromError(p.error); done = true; }
      else if (e.type === 'session.idle') done = true;
    };
    try {
      for await (const chunk of ev.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l.startsWith('data:')) { try { handle(JSON.parse(l.slice(5))); } catch { /* not an event */ } } }
        if (done || failure) break;
      }
    } catch (e) { if (signal?.aborted) throw e; if (!failure) throw err(`OpenCode's event stream broke: ${e.message}`, { kind: 'network' }); }
    finally { clearTimeout(idle); }
    if (failure) throw failure;
    if (!done) throw err('OpenCode ended the stream before the answer was done', { kind: 'network' });
    const full = order.filter((id) => kinds.get(id) !== 'reasoning').map((id) => finalText.get(id) || '').join('');
    const parsed = parseToolCalls(full, `call_${t.toString(36)}`, key);
    const tk = lastInfo?.tokens || {}, cache = tk.cache || {};
    const said = costs.size ? [...costs.values()].reduce((a, b) => a + b, 0) : Number(lastInfo?.cost);
    const usage = lastInfo ? {
      prompt_tokens: (tk.input || 0) + (cache.read || 0) + (cache.write || 0), completion_tokens: (tk.output || 0) + (tk.reasoning || 0),
      prompt_tokens_details: { cached_tokens: cache.read || 0, cache_write_tokens: cache.write || 0 },
      // OpenCode prices a call from its catalogue: real money for a paid provider; a plan's list price otherwise.
      ...(Number.isFinite(said) ? (info.plan === 'paid' ? { cost: said } : { opencode: { list_cost: said } }) : {}),
    } : {};
    return { text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, usage, ms: Date.now() - t, firstMs, finishReason: lastInfo?.finish === 'length' ? 'length' : parsed.calls.length ? 'tool_calls' : 'stop', provider: `${info.providerName || providerID} through OpenCode`, model: body.model, seen: seen || 1 };
  } catch (e) {
    if (accepted && e && typeof e === 'object' && !e.partial) e.partial = { outChars, ms: Date.now() - t };
    throw e;
  } finally {
    signal?.removeEventListener('abort', stop);
    ac.abort();
    // Deleting a session doesn't stop OpenCode's own retries or generation: it is told to stop first, always.
    if (sid) call(s, 'POST', `/session/${sid}/abort`, {}, AbortSignal.timeout(5000)).catch(() => {}).finally(() => call(s, 'DELETE', `/session/${sid}`, null, AbortSignal.timeout(10000)).catch(() => {}));
    s.active = Math.max(0, (s.active || 1) - 1); s.lastUse = Date.now();
  }
}
// OpenCode's error object ({ name, data: { message, statusCode, responseBody } }) as an Error sources.js can classify.
function fromError(e) {
  const d = e?.data || {}, body = String(d.responseBody || '');
  const typed = /"type"\s*:\s*"(\w+Error)"/.exec(body)?.[1];
  return err(String(d.message || e?.message || e?.name || 'OpenCode reported an error'), { status: Number(d.statusCode) || (e?.name === 'ProviderAuthError' ? 401 : undefined), ...(typed ? { errorType: typed } : {}) });
}
