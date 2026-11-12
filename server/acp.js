// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Subscription-login coding CLIs on this computer that speak the Agent Client Protocol (ACP, JSON-RPC 2.0 over stdio):
// Google Antigravity, OpenAI Codex, GitHub Copilot, Cursor, Factory Droid, Kimi Code and Qwen Code.
// Google Antigravity runs only on a Gemini API key or Google Cloud: Google's Additional Terms (section 6) keep its
// personal sign-in (Free, AI Pro, Ultra) out of third-party agent apps, so QuorX never uses that sign-in.
//   - The user signs in once with each CLI's own login command; QuorX never reads or copies its tokens.
//   - Every call runs in an empty folder of QuorX's own (data/<source>), with fs:false, terminal:false and no MCP
//     servers. Any built-in tool the agent asks permission to run (session/request_permission) or starts (tool_call) is
//     refused and cancelled at once: QuorX's own tools travel as keyed <quorx_call> text blocks (textcalls.js), so
//     QuorX's approvals, command checks and snapshots stay in charge.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HOME } from './openrouter.js';
import { findOnPath, killTree } from './opencodelocal.js';
import { launch, envFor, claudeError as appError } from './claudelocal.js';
import { repeats } from './groklocal.js';
import { saneCost, modelsDev } from './directapi.js';
import { toolPrompt, renderTranscript, parseToolCalls, textFilter, callKey, notRun } from './textcalls.js';

export const ANTIGRAVITY_ID = 'antigravity-local';
export const CODEX_ID = 'codex-local';
export const COPILOT_ID = 'copilot-local';
export const CURSOR_ID = 'cursor-local';
export const DROID_ID = 'droid-local';
export const KIMI_CLI_ID = 'kimi-local';
export const QWEN_CLI_ID = 'qwen-local';

export const ACP_SOURCES = {
  [ANTIGRAVITY_ID]: {
    id: ANTIGRAVITY_ID, name: 'Google Antigravity on this PC', short: 'Antigravity', app: 'agy', apps: ['agy', 'agy_acp_server'], appName: 'Google Antigravity',
    acpArgs: (exe) => (/agy_acp_server/i.test(path.basename(String(exe || ''))) ? (process.platform === 'linux' ? ['--uid='] : []) : ['acp']),
    billing: 'mixed', local: true, planLabel: 'Antigravity', providerName: 'Google Antigravity', maker: 'google', dev: 'google', update: 'agy update', minVersion: '1.5.0',
    // Only these sign-ins, never the personal one (oauth-personal / a cached personal token): see authFor().
    authOnly: ['gemini-api-key', 'agent-platform'],
    site: 'https://antigravity.google', keyUrl: 'https://antigravity.google/docs/cli/acp/', docs: 'https://antigravity.google/docs/cli/acp/',
    keyHint: 'Runs on your Gemini API key (⚙ Settings → Providers → Google Gemini) or Google Cloud (GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION), billed per call. Google’s terms don’t allow its personal sign-in in other agent apps.', install: 'winget install Google.AntigravityCLI',
  },
  [CODEX_ID]: {
    id: CODEX_ID, name: 'Codex on this PC', short: 'Codex', app: 'codex-acp', apps: ['codex-acp'], appName: 'Codex',
    acpArgs: () => [], billing: 'mixed', local: true, planLabel: 'ChatGPT', providerName: 'OpenAI through Codex', maker: 'openai', dev: 'openai', login: 'codex login',
    site: 'https://developers.openai.com/codex/cli', keyUrl: 'https://developers.openai.com/codex/cli', docs: 'https://github.com/agentclientprotocol/codex-acp',
    keyHint: 'No key: QuorX uses the ChatGPT plan or key you signed in to Codex with (codex login).', install: 'npm i -g @openai/codex @agentclientprotocol/codex-acp',
  },
  [COPILOT_ID]: {
    id: COPILOT_ID, name: 'GitHub Copilot on this PC', short: 'Copilot', app: 'copilot', apps: ['copilot'], appName: 'GitHub Copilot CLI',
    acpArgs: () => ['--acp', '--stdio'], billing: 'plan', local: true, planLabel: 'Copilot', providerName: 'GitHub Copilot', maker: null, dev: 'github-copilot', login: 'copilot login',
    site: 'https://github.com/features/copilot/cli', keyUrl: 'https://github.com/features/copilot/cli', docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    keyHint: 'No key: QuorX uses the GitHub Copilot subscription you signed in with (copilot login).', install: 'npm i -g @github/copilot',
  },
  [CURSOR_ID]: {
    id: CURSOR_ID, name: 'Cursor on this PC', short: 'Cursor', app: 'cursor-agent', apps: ['cursor-agent'], appName: 'Cursor CLI',
    acpArgs: () => ['acp'], billing: 'plan', local: true, planLabel: 'Cursor', providerName: 'Cursor', maker: null, dev: null, login: 'cursor-agent login',
    site: 'https://cursor.com/cli', keyUrl: 'https://cursor.com/docs/cli/acp', docs: 'https://cursor.com/docs/cli/acp',
    keyHint: 'No key: QuorX uses the Cursor plan you signed in with (cursor-agent login).', install: 'irm https://cursor.com/install?win32=true | iex',
  },
  [DROID_ID]: {
    id: DROID_ID, name: 'Factory Droid on this PC', short: 'Droid', app: 'droid', apps: ['droid'], appName: 'Factory Droid',
    acpArgs: () => ['exec', '--output-format', 'acp'], envVars: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    billing: 'plan', local: true, planLabel: 'Factory', providerName: 'Factory Droid', maker: null, dev: null, login: 'droid',
    site: 'https://factory.ai/product/cli', keyUrl: 'https://docs.factory.ai/cli/getting-started/overview', docs: 'https://docs.factory.ai/cli/getting-started/overview',
    keyHint: 'No key: QuorX uses the Factory account you signed in to Droid with (run droid once).', install: 'npm i -g droid',
  },
  [KIMI_CLI_ID]: {
    id: KIMI_CLI_ID, name: 'Kimi Code on this PC', short: 'Kimi Code', app: 'kimi', apps: ['kimi'], appName: 'Kimi Code',
    acpArgs: () => ['acp'], billing: 'plan', local: true, planLabel: 'Kimi', providerName: 'Moonshot through Kimi Code', maker: 'moonshotai', dev: 'moonshotai', login: 'kimi login',
    site: 'https://moonshotai.github.io/kimi-code/', keyUrl: 'https://moonshotai.github.io/kimi-code/', docs: 'https://moonshotai.github.io/kimi-code/',
    keyHint: 'No key: QuorX uses the Kimi Coding Plan account you signed in with (kimi login).', install: 'npm i -g @moonshot-ai/kimi-code',
  },
  [QWEN_CLI_ID]: {
    id: QWEN_CLI_ID, name: 'Qwen Code on this PC', short: 'Qwen Code', app: 'qwen', apps: ['qwen'], appName: 'Qwen Code',
    acpArgs: () => ['--acp'], billing: 'mixed', local: true, planLabel: 'Qwen', providerName: 'Alibaba through Qwen Code', maker: 'qwen', dev: 'alibaba', login: 'qwen',
    site: 'https://qwenlm.github.io/qwen-code-docs/', keyUrl: 'https://qwenlm.github.io/qwen-code-docs/', docs: 'https://qwenlm.github.io/qwen-code-docs/',
    keyHint: 'No key: QuorX uses the Qwen account or Coding Plan you signed in with (run qwen once).', install: 'npm i -g @qwen-code/qwen-code',
  },
};
export const ACP_IDS = Object.keys(ACP_SOURCES);

const SYSTEM = 'You are a language model called by the QuorX app. You have no built-in tools, files or terminal of your own and must never call a native tool or function. Follow QuorX\'s instructions in the prompt and write tool calls only as <quorx_call> text blocks starting on a new line of their own. Every reply either writes its <quorx_call> blocks or gives your final answer.';
const TURN = (key) => new RegExp(`<(?:user|assistant|tool_result) key="${key}"`);
const EOS = /<\|eos\|>/g;
const MAX_REPLY = 300e3;
const err = (msg, extra = {}) => Object.assign(new Error(msg), extra);

const active = new Map(); // sourceId → Set<ChildProcess>
export const acpRunning = (id) => active.get(id)?.size || 0;
process.once('exit', () => { for (const set of active.values()) for (const p of set) if (p.pid) killTree(p.pid); });

/** The first installed executable of an ACP source (`{ exe, app }`), or null. */
export function findAcpExe(id, find = findOnPath) {
  const def = ACP_SOURCES[id];
  if (!def) return null;
  for (const app of def.apps || [def.app]) { const exe = find(app); if (exe) return { exe, app }; }
  return null;
}
const dirFor = (id) => path.join(HOME, 'data', id);
const envOf = (def, extra = {}) => ({ ...envFor(), NO_UPDATE_NOTIFIER: '1', ...(def.envVars || {}), ...extra });
const notInstalled = (def) => err(`${def.appName} is not installed on this computer (${def.install}), or not on PATH.`, { kind: 'notinstalled' });
const signIn = (def) => err(`${def.appName} is not signed in. Run "${def.login}" in a terminal, then try again.${def.signInNote ? ` ${def.signInNote}` : ''}`, { kind: 'auth', status: 401 });
/**
 * The sign-in QuorX may use for a source that allows only some (Antigravity: a Gemini API key, else Google Cloud's
 * Application Default Credentials with a project and location), from QuorX's environment plus `env`; null when none
 * is set up. Sources without such a list sign in as before.
 */
export function authFor(def, env = {}) {
  if (!def?.authOnly) return undefined;
  const e = { ...process.env, ...env };
  if (def.authOnly.includes('gemini-api-key') && String(e.GEMINI_API_KEY || '').trim()) return 'gemini-api-key';
  if (def.authOnly.includes('agent-platform') && String(e.GOOGLE_CLOUD_PROJECT || '').trim() && String(e.GOOGLE_CLOUD_LOCATION || '').trim()) return 'agent-platform';
  return null;
}
const personalOff = (def) => err(`${def.appName} needs a Gemini API key (⚙ Settings → Providers → Google Gemini) or Google Cloud (GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION) in QuorX. Google’s terms don’t allow its personal Google sign-in (Free, AI Pro or Ultra) inside other agent apps, so QuorX never uses it.`, { kind: 'auth', status: 401, personalOff: true });
// A CLI from before its ACP mode refuses the argument (agy before 1.5.0: unexpected argument "acp").
const TOO_OLD = /unexpected argument|unknown (command|subcommand|flag|option|argument)|unrecognized (argument|option|command)|invalid choice|no such (command|option)/i;
const tooOld = (def) => err(`${def.appName} on this PC is too old for QuorX: it has no ACP mode yet${def.minVersion ? ` (it needs ${def.minVersion} or newer)` : ''}. Update it with "${def.update || def.install}", then try again.`, { kind: 'notinstalled' });

// Non-interactive API-key auth methods an ACP agent may offer when an environment variable is set.
const ENV_AUTH = [
  ['gemini-api-key', () => !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)],
  ['openai-api-key', () => !!process.env.OPENAI_API_KEY],
  ['api-key', () => !!process.env.OPENAI_API_KEY],
  ['factory-api-key', () => !!process.env.FACTORY_API_KEY],
  ['dashscope-api-key', () => !!process.env.DASHSCOPE_API_KEY],
  ['mistral-api-key', () => !!process.env.MISTRAL_API_KEY],
];
function pickEnvAuth(methods = []) {
  const byId = new Map((Array.isArray(methods) ? methods : []).filter((m) => m?.id && m.type !== 'terminal').map((m) => [m.id, m]));
  for (const [id, ok] of ENV_AUTH) if (byId.has(id) && ok()) return id;
  return null;
}
const isAuthErr = (e) => e?.code === -32000 || e?.status === 401 || /auth[_ ]?required|authentication required|not (authenticated|signed in|logged in)|unauthori[sz]ed|login required|please (sign|log) in/i.test(String(e?.message || ''));

// Starts an ACP subprocess and speaks newline-delimited JSON-RPC 2.0 over stdio.
function openAcp(def, { start = spawn, find = findOnPath, onNotify, onRequest, env = {} } = {}) {
  if (authFor(def, env) === null) throw personalOff(def); // nothing starts without an allowed sign-in
  const found = findAcpExe(def.id, find);
  if (!found) throw notInstalled(def);
  const dir = dirFor(def.id);
  fs.mkdirSync(dir, { recursive: true });
  let proc;
  try {
    proc = launch(found.exe, def.acpArgs(found.exe), { cwd: dir, env: envOf(def, env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, start);
  } catch (e) { throw err(`${def.appName} didn't start: ${e.message}`, { kind: 'network' }); }
  let set = active.get(def.id);
  if (!set) active.set(def.id, (set = new Set()));
  set.add(proc);

  const pending = new Map(), dec = new StringDecoder('utf8');
  let next = 1, buf = '', stderr = '', closed = false;
  const write = (obj) => { if (!closed) { try { proc.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* close reports why */ } } };
  const send = (method, params, timeoutMs = 60e3) => new Promise((resolve, reject) => {
    if (closed) return reject(err(`${def.appName} stopped${stderr ? `: ${stderr.replace(/\s+/g, ' ').trim().slice(-200)}` : ''}`, { kind: 'network' }));
    const id = next++;
    const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(err(`${def.appName} did not answer ${method} in ${Math.round(timeoutMs / 1000)} s`, { kind: 'timeout', name: 'TimeoutError' })); }, timeoutMs) : null;
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    write({ jsonrpc: '2.0', id, method, params });
  });
  const handleLine = (line) => {
    if (!line.startsWith('{')) return;
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.id != null && !j.method) {
      const p = pending.get(j.id);
      if (!p) return;
      pending.delete(j.id);
      if (j.error) {
        const msg = String(j.error.data?.message || (typeof j.error.data === 'string' ? j.error.data : '') || j.error.message || `${def.appName} reported an error`);
        const e = appError(msg);
        if (j.error.code != null) e.code = j.error.code;
        if (isAuthErr(e)) { e.kind = 'auth'; e.status = 401; }
        p.reject(e);
      } else p.resolve(j.result);
      return;
    }
    if (j.method && j.id == null) { onNotify?.(j.method, j.params || {}); return; }
    if (j.method && j.id != null) {
      if (onRequest) onRequest(j.id, j.method, j.params || {}, (res) => write({ jsonrpc: '2.0', id: j.id, ...res }));
      else write({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'Method not found' } });
    }
  };
  proc.stdout.on('data', (d) => {
    buf += dec.write(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handleLine(l); }
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
  proc.stdin.on('error', () => {});
  const gone = (why) => {
    if (closed) return;
    closed = true;
    const tail = buf.trim(); buf = ''; if (tail) handleLine(tail);
    const said = stderr.replace(/\s+/g, ' ').trim().slice(-240);
    const e = /not (authenticated|signed in|logged in)|authentication required/i.test(said) ? signIn(def) : TOO_OLD.test(said) ? tooOld(def) : err(`${why}${said ? `: ${said}` : ''}`, { kind: 'network' });
    for (const [, p] of pending) p.reject(e);
    pending.clear();
    set.delete(proc);
  };
  proc.on('error', (e) => gone(`${def.appName} didn't start (${e.message})`));
  proc.on('close', (code) => gone(`${def.appName} stopped (exit ${code})`));
  const close = (why = `${def.appName} stopped`) => { gone(why); if (proc.pid && proc.exitCode == null) killTree(proc.pid); };
  return { dir, proc, send, notify: (method, params) => write({ jsonrpc: '2.0', method, params }), close, stderr: () => stderr };
}

// Initializes an ACP connection, authenticates silently when needed, and opens a fresh empty session.
async function startSession(def, conn, sysText = '', env = {}) {
  const init = await conn.send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'QuorX', version: '1' },
  });
  const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
  let paidAuth = false;
  const only = authFor(def, env);
  if (only === null) throw personalOff(def);
  if (only) {
    if (!methods.some((m) => m?.id === only)) throw err(`${def.appName} on this PC doesn’t offer the ${only} sign-in QuorX needs. Update it with "${def.update || def.install}", then try again.`, { kind: 'notinstalled' });
    try { await conn.send('authenticate', { methodId: only }); } catch (e) { throw err(`${def.appName} refused the ${only === 'gemini-api-key' ? 'Gemini API key' : 'Google Cloud sign-in'}: ${e?.message || 'authentication failed'}`, { kind: 'auth', status: 401 }); }
    paidAuth = true;
  } else if (methods.some((m) => m?.id === 'cached_token')) {
    try { await conn.send('authenticate', { methodId: 'cached_token' }); } catch { throw signIn(def); }
  }
  const sysCap = init?.agentCapabilities?.sessionCapabilities?.systemPrompt;
  const sysMode = sysCap ? (sysCap.mode?.override ? 'override' : 'append') : null;
  const newParams = { cwd: conn.dir, mcpServers: [], ...(sysMode && sysText ? { systemPrompt: { mode: sysMode, content: [{ type: 'text', text: sysText }] } } : {}) };
  let session;
  try {
    session = await conn.send('session/new', newParams);
  } catch (e) {
    if (!isAuthErr(e)) throw e;
    const envMethod = pickEnvAuth(methods);
    if (!envMethod) throw signIn(def);
    try { await conn.send('authenticate', { methodId: envMethod }); } catch { throw signIn(def); }
    paidAuth = /api-key$/i.test(envMethod);
    session = await conn.send('session/new', newParams);
  }
  return { init: init || {}, session: session || {}, paidAuth, sysMode };
}

// Flattens a SessionConfigOption's `options` (flat items or `{ group, options }` groups).
const flatOpts = (opt) => (Array.isArray(opt?.options) ? opt.options.flatMap((o) => (Array.isArray(o?.options) ? o.options : o ? [o] : [])) : []);
const findOpt = (opts, pred) => (Array.isArray(opts) ? opts.find((o) => o && (o.type === 'select' || !o.type) && pred(o)) : null);
const modelConfigOpt = (opts) => findOpt(opts, (o) => o.category === 'model' || o.id === 'model');
const effortConfigOpt = (opts) => findOpt(opts, (o) => o.category === 'thought_level' || /^(thought|thinking|reasoning|effort)/i.test(String(o.id || '')));
const modeConfigOpt = (opts) => findOpt(opts, (o) => o.category === 'mode' || o.id === 'mode');

const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const canonLevel = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'off') return 'none';
  if (s === 'extra') return 'xhigh';
  return s;
};
/** The effort option closest to what QuorX asked for, returning the exact value string the ACP agent expects. */
export function acpEffort(reasoning, variants = []) {
  if (!reasoning || !variants.length) return null;
  const want = reasoning.enabled === false ? 'none' : reasoning.effort || (reasoning.max_tokens ? (reasoning.max_tokens <= 4000 ? 'low' : reasoning.max_tokens <= 10000 ? 'medium' : 'high') : null);
  if (!want) return null;
  const mapped = variants.map((raw) => ({ raw: String(raw), c: canonLevel(raw) })).filter((x) => LADDER.includes(x.c));
  if (!mapped.length) return want === 'none' ? null : String(variants[0]);
  const hit = mapped.find((x) => x.c === want);
  if (hit) return hit.raw;
  if (want === 'none') return (mapped.find((x) => x.c === 'minimal') || mapped.sort((a, b) => LADDER.indexOf(a.c) - LADDER.indexOf(b.c))[0])?.raw || null;
  const on = mapped.filter((x) => x.c !== 'none');
  const pool = on.length ? on : mapped;
  return [...pool].sort((a, b) => Math.abs(LADDER.indexOf(a.c) - LADDER.indexOf(want)) - Math.abs(LADDER.indexOf(b.c) - LADDER.indexOf(want)))[0]?.raw || null;
}

const VENDOR_BUCKETS = ['anthropic', 'openai', 'google', 'moonshotai', 'alibaba', 'deepseek', 'xai', 'zhipuai', 'mistral', 'minimax'];
const normId = (s) => String(s || '').toLowerCase().replace(/^models\//, '').replace(/-[0-9]{8}$|-[0-9]{4}-[0-9]{2}-[0-9]{2}$|-latest$/g, '').replace(/[._]+/g, '-');
function inferMaker(id, canon, fallback = null) {
  if (canon && canon.includes('/')) return canon.split('/')[0];
  const s = String(id || '').toLowerCase();
  if (/^claude/.test(s)) return 'anthropic';
  if (/^(gpt|o[1-9]|codex)/.test(s)) return 'openai';
  if (/^gemini/.test(s)) return 'google';
  if (/^kimi/.test(s)) return 'moonshotai';
  if (/^(qwen|qwq)/.test(s)) return 'qwen';
  if (/^glm/.test(s)) return 'z-ai';
  if (/^deepseek/.test(s)) return 'deepseek';
  if (/^grok/.test(s)) return 'x-ai';
  if (/^(mistral|codestral|devstral)/.test(s)) return 'mistralai';
  if (/^minimax/.test(s)) return 'minimax';
  return fallback;
}
function findMd(dev, def, rawId) {
  if (!dev || typeof dev !== 'object') return null;
  const bare = String(rawId || '').replace(/^models\//, ''), tail = bare.includes('/') ? bare.split('/').pop() : bare, want = normId(tail);
  const buckets = [...new Set([def.dev, ...VENDOR_BUCKETS].filter(Boolean))];
  for (const b of buckets) {
    const models = dev[b]?.models;
    if (!models || typeof models !== 'object') continue;
    if (Object.hasOwn(models, bare)) return models[bare];
    if (Object.hasOwn(models, tail)) return models[tail];
    const hit = Object.values(models).find((m) => m?.id && normId(m.id) === want);
    if (hit) return hit;
  }
  return null;
}
const nice = (id) => String(id || '').split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Lists the models an ACP source offers now, enriched with limits and list prices from models.dev. */
export async function acpModels(id, { start = spawn, find = findOnPath, fetchJSON, env = {} } = {}) {
  const def = ACP_SOURCES[id];
  if (!def) throw err(`no such ACP source ${id}`, { kind: 'request' });
  const conn = openAcp(def, { start, find, env });
  try {
    const [{ init, session, paidAuth }, dev] = await Promise.all([startSession(def, conn, '', env), modelsDev(fetchJSON)]);
    if (init.agentCapabilities?.sessionCapabilities?.close && session.sessionId) conn.send('session/close', { sessionId: session.sessionId }, 5000).catch(() => {});
    const cfg = session.configOptions || [];
    const mOpt = modelConfigOpt(cfg), eOpt = effortConfigOpt(cfg);
    const sharedEfforts = eOpt ? flatOpts(eOpt).map((o) => String(o.value || '')).filter(Boolean) : [];
    let raw = [];
    if (mOpt) raw = flatOpts(mOpt).filter((o) => o?.value).map((o) => ({ id: String(o.value), name: o.name || nice(o.value), desc: o.description || '', meta: o._meta || {} }));
    else if (Array.isArray(session.models?.availableModels)) raw = session.models.availableModels.filter((m) => m?.modelId).map((m) => ({ id: String(m.modelId), name: m.name || nice(m.modelId), desc: m.description || '', meta: m._meta || {} }));
    else if (Array.isArray(init._meta?.modelState?.availableModels)) raw = init._meta.modelState.availableModels.filter((m) => m?.modelId).map((m) => ({ id: String(m.modelId), name: m.name || nice(m.modelId), desc: m.description || '', meta: m._meta || {} }));
    else if (session.sessionId) raw = [{ id: 'default', name: `${def.appName} (default)`, desc: '', meta: {} }];

    const canImg = !!init.agentCapabilities?.promptCapabilities?.image;
    const seen = new Set(), out = [];
    for (const m of raw) {
      if (!m.id || m.id === 'auto' && raw.length > 1 || seen.has(m.id)) continue;
      seen.add(m.id);
      const md = m.id === 'default' ? null : findMd(dev, def, m.id);
      if (md && Array.isArray(md.modalities?.output) && !md.modalities.output.includes('text')) continue;
      const cost = saneCost(md?.cost), list = cost ? [cost.input, cost.output] : [0, 0];
      const ownEfforts = Array.isArray(m.meta?.reasoningEfforts) ? m.meta.reasoningEfforts.map((x) => String(x?.value || x?.id || x || '')).filter(Boolean) : [];
      const mdEffort = (Array.isArray(md?.reasoning_options) ? md.reasoning_options : []).find((o) => o?.type === 'effort' && Array.isArray(o.values));
      const variants = ownEfforts.length ? ownEfforts : sharedEfforts.length ? sharedEfforts : mdEffort ? mdEffort.values.map(String) : [];
      const canon = String(md?.canonical_model_id || '');
      const maker = inferMaker(m.id, canon, def.maker);
      const seesImg = canImg && (!md?.modalities?.input || md.modalities.input.includes('image'));
      const plan = paidAuth ? 'paid' : 'plan';
      out.push({
        id: `${id}/${m.id}`, realId: m.id, modelID: m.id, providerID: maker || id, providerName: def.providerName, source: id,
        ...(maker ? { maker } : {}),
        name: m.name || md?.name || nice(m.id), kind: 'chat',
        ctx: Number(m.meta?.totalContextTokens) || md?.limit?.context || null,
        maxOut: md?.limit?.output || null,
        created: md?.release_date ? Math.floor(Date.parse(md.release_date) / 1000) || 0 : 0,
        in: seesImg ? ['text', 'image'] : ['text'], out: ['text'],
        price: plan === 'paid' ? list : [0, 0], listPrice: list, cost: cost || {}, plan,
        ...(plan === 'plan' ? { planLabel: def.planLabel } : cost ? {} : { priceUnknown: true }),
        tools: true, temp: false, reasoning: variants.length > 0 || !!m.meta?.supportsReasoningEffort || !!md?.reasoning, variants,
        format: id, status: md?.status === 'deprecated' || /\[deprecated\]/i.test(m.name) ? 'deprecated' : null,
        canonical: canon || null, desc: String(m.desc || md?.description || '').replace(/\s+/g, ' ').slice(0, 220),
      });
    }
    return out;
  } finally { conn.close(); }
}

const dataUrl = (u) => /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(String(u || ''));
function estimateTokens(body, outText) {
  let chars = 0, pics = 0;
  for (const m of body.messages || []) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) for (const p of m.content) { if (p?.type === 'text') chars += String(p.text || '').length; else if (p?.type === 'image_url') pics++; }
    for (const tc of m?.tool_calls || []) chars += String(tc.function?.arguments || '').length + 20;
  }
  if (body.tools) chars += JSON.stringify(body.tools).length;
  return { prompt_tokens: Math.max(1, Math.ceil(chars / 4) + pics * 1000), completion_tokens: Math.ceil(String(outText || '').length / 4), tokens_estimated: true };
}
function mergeUsage(acc, raw) {
  if (!raw || typeof raw !== 'object') return;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
  const num = (...ks) => { for (const k of ks) if (Number.isFinite(Number(u[k])) && Number(u[k]) >= 0) return Number(u[k]); return null; };
  const inp = num('inputTokens', 'input_tokens', 'prompt_tokens');
  const out = num('outputTokens', 'output_tokens', 'completion_tokens', 'candidates_tokens');
  const read = num('cachedReadTokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens');
  const write = num('cachedWriteTokens', 'cacheWriteTokens', 'cache_creation_input_tokens', 'cache_write_tokens');
  const think = num('thoughtTokens', 'thinking_tokens', 'reasoning_tokens');
  if (inp != null) acc.in = inp;
  if (out != null) acc.out = out + (think || 0);
  if (read != null) acc.read = read;
  if (write != null) acc.write = write;
  if (inp == null && Number.isFinite(Number(raw.used)) && Number(raw.used) > 0) acc.used = Number(raw.used);
  if (raw.cost && typeof raw.cost === 'object' && Number.isFinite(Number(raw.cost.amount)) && /^usd$/i.test(String(raw.cost.currency || 'USD'))) acc.usd = Number(raw.cost.amount);
  else if (Number.isFinite(Number(u.total_cost_usd ?? u.costUsd ?? u.cost_usd))) acc.usd = Number(u.total_cost_usd ?? u.costUsd ?? u.cost_usd);
}

// A web search the agent wanted, read through fetch_url: DuckDuckGo's plain HTML results read as text without a
// browser (Google and Bing answer a plain fetch with a script or a consent page).
export const SEARCH_PAGE = 'https://html.duckduckgo.com/html/?q=';
/**
 * The QuorX tool call that does what an agent's own built-in tool wanted (ACP `kind`, `title` and `rawInput`), when
 * that QuorX tool is offered this step: [name, args], else null. It then runs under QuorX's approvals and checks like
 * any other call, so a reply carries on instead of stopping on "reached for a built-in tool".
 *   web search → fetch_url of a search page · a page → fetch_url · a command → shell · a file → read_file ·
 *   a search of the files → search_files. Edits and anything else are never guessed.
 */
export function quorxFor(native, tools = []) {
  if (!native) return null;
  const offered = new Set((tools || []).map((x) => x?.function?.name).filter(Boolean));
  const inp = native.input && typeof native.input === 'object' ? native.input : {};
  const kind = String(native.kind || '').toLowerCase(), title = String(native.title || ''), names = `${native.tool || ''} ${title}`;
  const str = (...ks) => { for (const k of ks) if (typeof inp[k] === 'string' && inp[k].trim()) return inp[k].trim(); return ''; };
  const told = (title.match(/:\s*(.+)$/) || [])[1]?.trim() || ''; // "Web search: stock market news" → "stock market news"
  if (offered.has('fetch_url')) {
    const url = str('url', 'uri', 'href') || (/^https?:\/\/\S+$/i.test(told) ? told : '');
    if (/^https:\/\//i.test(url)) return ['fetch_url', { url }];
    if (/web[\s_-]?search|search[\s_-]?(the[\s_-]?)?web|internet search|google[\s_-]?search/i.test(names) || (kind === 'fetch' && !url)) {
      const q = str('query', 'search_term', 'searchTerm', 'q', 'search_query') || told;
      if (q) return ['fetch_url', { url: SEARCH_PAGE + encodeURIComponent(q.slice(0, 400)) }];
    }
  }
  if (offered.has('shell') && (kind === 'execute' || /\b(terminal|shell|bash|run_?command|run_terminal_cmd)\b/i.test(native.tool || ''))) {
    const command = str('command', 'cmd', 'commandLine');
    if (command) return ['shell', { command }];
  }
  if (offered.has('read_file') && kind === 'read') {
    const p = str('path', 'file_path', 'filePath', 'target_file', 'abs_path');
    if (p) return ['read_file', { path: p }];
  }
  if (offered.has('search_files') && kind === 'search') {
    const q = str('query', 'pattern', 'search_term', 'regex');
    if (q) return ['search_files', { query: q }];
  }
  return null;
}

/**
 * One streamed call through an ACP source, read into openrouter.js chatStream's result shape. Retries once with a
 * reminder if the model reaches for one of the agent's own built-in tools instead of writing a <quorx_call> block.
 */
export async function acpStream(id, body, signal, onText, onThink, opts = {}) {
  try { return await acpOnce(id, body, signal, onText, onThink, opts); }
  catch (e) {
    if (!e?.retryWith || signal?.aborted) throw e;
    const r = await acpOnce(id, body, signal, null, onThink, { ...opts, reminder: e.retryWith });
    const first = Number(e.firstCost);
    if (Number.isFinite(first) && first > 0) {
      const u = (r.usage ||= {});
      if ((opts.info?.plan || 'plan') === 'plan') u.plan_cost = (Number(u.plan_cost) || 0) + first;
      else u.cost = (Number(u.cost) || 0) + first;
    }
    return r;
  }
}

async function acpOnce(id, body, signal, onText, onThink, { info = {}, idleMs = 180e3, start = spawn, find = findOnPath, reminder = '', onCall, env = {} } = {}) {
  const def = ACP_SOURCES[id];
  if (!def) throw err(`no such ACP source ${id}`, { kind: 'request' });
  const realModel = String(body.model || '').slice(id.length + 1);
  if (!realModel) throw err(`${body.model} names no ${def.appName} model`, { kind: 'request' });
  const halt = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Stopped.'); };
  halt();

  const key = callKey();
  const { system, transcript } = renderTranscript(body.messages, key, { calls: !!body.tools?.length && body.tool_choice !== 'none' });
  const fullSystem = `${SYSTEM}\n\n[QuorX's instructions]\n${system}${toolPrompt(body.tools, body.tool_choice, key)}`;
  const t = Date.now();
  let sessionId = null, text = '', thinking = '', firstMs = null, seen = 0, outChars = 0, cut = null, failure = null, native = null, idle = null, loopCheck = 8e3;
  const usageAcc = {};
  const show = textFilter(onText, onCall);

  let conn, killSoon = null;
  const stopTurn = (graceMs = 0) => {
    if (sessionId) conn?.notify('session/cancel', { sessionId });
    if (graceMs > 0) { killSoon ||= setTimeout(() => conn?.close(), graceMs); killSoon.unref?.(); }
    else conn?.close();
  };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { failure ||= err(`${def.appName} sent nothing for ${Math.round(idleMs / 1000)} s`, { name: 'TimeoutError', kind: 'timeout' }); stopTurn(); }, idleMs); };
  const noteNative = (name, input, { kind, title } = {}) => {
    native = {
      tool: String(name || native?.tool || 'tool'), input: input && typeof input === 'object' && Object.keys(input).length ? input : native?.input || null,
      kind: kind || native?.kind || '', title: title || native?.title || '',
    };
    stopTurn(200);
  };

  conn = openAcp(def, {
    start, find, env,
    onRequest: (_reqId, method, params, reply) => {
      if (method === 'session/request_permission') {
        const optsList = Array.isArray(params.options) ? params.options : [];
        const deny = optsList.find((o) => /^reject/i.test(String(o?.kind || ''))) || optsList.find((o) => /deny|reject|cancel|no/i.test(String(o?.optionId || o?.name || '')));
        reply({ result: { outcome: signal?.aborted || !deny ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: deny.optionId } } });
        const tc = params.subject?.toolCall || params.toolCall || {};
        noteNative(tc._meta?.claudeCode?.toolName || tc.name || tc.title || params.title || 'a built-in tool', tc.rawInput || null, { kind: tc.kind, title: tc.title || params.title });
      } else reply({ error: { code: -32601, message: 'Method not found' } });
    },
    onNotify: (method, params) => {
      if (method !== 'session/update' || (sessionId && params.sessionId && params.sessionId !== sessionId)) return;
      const u = params.update || {};
      seen++; arm();
      if (u.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') {
        if (cut) return;
        const piece = u.content.text.replace(EOS, '');
        if (!piece) return;
        if (firstMs == null) firstMs = Date.now() - t;
        text += piece; outChars += piece.length; show(piece);
        const from = Math.max(0, text.length - piece.length - 40), at = text.slice(from).search(TURN(key));
        const turn = at < 0 ? -1 : from + at;
        let loops = false;
        if (text.length >= loopCheck) { loopCheck = text.length + 8e3; loops = repeats(text); }
        if (turn >= 0 || loops || text.length > MAX_REPLY) {
          if (turn >= 0) text = text.slice(0, turn);
          cut = turn >= 0 ? 'end_turn' : 'max_tokens';
          stopTurn();
        }
      } else if (u.sessionUpdate === 'agent_thought_chunk' && typeof u.content?.text === 'string') {
        thinking += u.content.text; outChars += u.content.text.length; onThink?.(u.content.text);
      } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        noteNative(u._meta?.claudeCode?.toolName || u.name || u.title || 'a built-in tool', u.rawInput || null, { kind: u.kind, title: u.title });
      } else if (u.sessionUpdate === 'usage_update') {
        mergeUsage(usageAcc, u);
      }
    },
  });

  const onAbort = () => stopTurn();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    arm();
    const { init, session, paidAuth, sysMode } = await startSession(def, conn, fullSystem, env);
    halt();
    sessionId = session.sessionId;
    if (!sessionId) throw err(`${def.appName} gave no ACP session id`, { kind: 'shape' });

    let cfg = session.configOptions || [];
    const modeOpt = modeConfigOpt(cfg);
    if (modeOpt && /yolo|accept|auto|code|bypass|skip|full/i.test(String(modeOpt.currentValue || ''))) {
      const safe = flatOpts(modeOpt).find((o) => /^(ask|default|read[-_]?only|plan)$/i.test(String(o?.value || '')));
      if (safe) { const r = await conn.send('session/set_config_option', { sessionId, configId: modeOpt.id, value: safe.value }); if (Array.isArray(r?.configOptions)) cfg = r.configOptions; }
    }
    if (realModel !== 'default') {
      const mOpt = modelConfigOpt(cfg);
      if (mOpt && mOpt.currentValue !== realModel) {
        const r = await conn.send('session/set_config_option', { sessionId, configId: mOpt.id, value: realModel });
        if (Array.isArray(r?.configOptions)) cfg = r.configOptions;
      } else if (!mOpt && session.models) {
        await conn.send('session/set_model', { sessionId, modelId: realModel });
      }
    }
    const eOpt = effortConfigOpt(cfg);
    if (eOpt) {
      const variants = flatOpts(eOpt).map((o) => String(o.value || '')).filter(Boolean);
      const effort = acpEffort(body.reasoning, variants.length ? variants : info.variants);
      if (effort && eOpt.currentValue !== effort) await conn.send('session/set_config_option', { sessionId, configId: eOpt.id, value: effort }).catch(() => {});
    }

    const promptText = `${sysMode === 'override' ? '' : `${fullSystem}\n\n`}${transcript}${reminder ? `\n\n[QuorX] ${reminder}` : ''}`;
    const prompt = [{ type: 'text', text: promptText }];
    if ((info.in || []).includes('image') && init.agentCapabilities?.promptCapabilities?.image) {
      const pics = (body.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((p) => p?.type === 'image_url' && dataUrl(p.image_url?.url))).slice(-4);
      for (const p of pics) { const [, mimeType, data] = dataUrl(p.image_url.url); prompt.push({ type: 'image', mimeType, data }); }
    }

    let promptRes = null;
    try {
      promptRes = await conn.send('session/prompt', { sessionId, prompt }, 0);
    } catch (e) {
      if (!cut && !native) throw e;
    }
    halt();
    if (failure) throw failure;
    if (promptRes) mergeUsage(usageAcc, promptRes);
    if (init.agentCapabilities?.sessionCapabilities?.close) conn.send('session/close', { sessionId }, 3000).catch(() => {});

    const parsed = parseToolCalls(text.replace(EOS, ''), `call_${t.toString(36)}`, key);
    if (native && !parsed.calls.length) {
      const offered = (body.tools || []).some((x) => x?.function?.name === native.tool);
      const as = offered && native.input ? [native.tool, native.input] : quorxFor(native, body.tools);
      if (as) parsed.calls = [{ id: `call_${t.toString(36)}_n`, type: 'function', function: { name: as[0], arguments: JSON.stringify(as[1]) } }];
      // A web search or page with no fetch_url this step: the chat's Browser tool is off, so there is no web to reach.
      const web = !!quorxFor(native, [{ function: { name: 'fetch_url' } }]);
      if (!as) throw err(`${def.appName} reached for a built-in tool (${native.tool}), which QuorX keeps off${web ? '. This chat has no web access: turn on Browser in the message box to let it read the web through QuorX' : ''}`, {
        kind: 'shape', native, firstCost: usageAcc.usd,
        retryWith: web
          ? `Your last answer tried a built-in web search or fetch (${native.tool}), which QuorX keeps off, and this chat has no web access, so nothing ran. Answer from what you already know, say plainly that it may be out of date, and mention the user can turn on Browser in the message box for live results.`
          : `Your last answer tried to call a built-in agent tool (${native.tool}), which QuorX keeps off, so nothing ran. Write each tool call as a <quorx_call> text block on a line of its own, exactly as the instructions show.`,
        partial: { outChars, ms: Date.now() - t },
      });
    }

    const plan = paidAuth ? 'paid' : info.plan || 'plan';
    const hasTokens = usageAcc.in != null || usageAcc.out != null || usageAcc.used != null;
    const est = hasTokens ? null : estimateTokens(body, `${thinking}${text}`);
    const read = usageAcc.read || 0, write = usageAcc.write || 0;
    const prompt_tokens = usageAcc.in != null ? usageAcc.in + (usageAcc.in >= read + write ? 0 : read + write) : usageAcc.used || est.prompt_tokens;
    const completion_tokens = usageAcc.out != null ? usageAcc.out : est.completion_tokens;
    const usage = {
      prompt_tokens, completion_tokens,
      ...(read || write ? { prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } } : {}),
      ...(est ? { tokens_estimated: true } : {}),
      ...(Number.isFinite(usageAcc.usd) && usageAcc.usd > 0 ? (plan === 'plan' ? { plan_cost: usageAcc.usd } : { cost: usageAcc.usd }) : {}),
    };
    const stopReason = cut || promptRes?.stopReason || 'end_turn';
    if (stopReason === 'refusal' && !parsed.text && !parsed.calls.length) throw err(`${def.appName} declined to answer`, { kind: 'request' });
    return {
      text: parsed.text, thinking, reasoningDetails: [], toolCalls: parsed.calls, ...notRun(parsed),
      usage, ms: Date.now() - t, firstMs,
      finishReason: stopReason === 'max_tokens' ? 'length' : parsed.calls.length ? 'tool_calls' : 'stop',
      provider: def.providerName, model: body.model, seen: seen || 1,
    };
  } catch (e) {
    if (seen && e && typeof e === 'object' && !e.partial) e.partial = { outChars, ms: Date.now() - t };
    throw e;
  } finally {
    clearTimeout(idle);
    clearTimeout(killSoon);
    signal?.removeEventListener('abort', onAbort);
    conn.close();
  }
}
