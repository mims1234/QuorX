// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible local model servers on this computer (⚙ Settings → Providers → On this PC):
// LM Studio (`lmstudio-local`), Microsoft Foundry Local (`foundry-local`), and llama.cpp `llama-server` (`llamacpp-local`).
//   - All three run on this computer at no cost (`plan: 'free'`). Like Ollama, QuorX never starts them on its own: when
//     a server isn't running, the call says how to start it, and its last model list stays saved in data/source-lists.json.
//   - LM Studio is listed through its native `/api/v1/models` (or `/api/v0/models` on older builds), keeping only LLMs
//     trained for tool calling, with their context window, vision flag and quantization.
//   - Foundry Local binds a dynamic port: when no address is set, `foundry service status` finds it, and `/openai/models`
//     with `/foundry/list` names the cached chat models that call tools.
//   - llama.cpp (`llama-server`) checks `:8080` (Docker / common setups) and `:9931` (`llama-server`'s own default port)
//     when no address is set, reading `/v1/models` (modality & training context) and `/props` (the active slot's `n_ctx`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readChatStream } from './openrouter.js';
import { goBody } from './opencodego.js';
import { findOnPath } from './opencodelocal.js';

export const LMSTUDIO_ID = 'lmstudio-local';
export const FOUNDRY_ID = 'foundry-local';
export const LLAMACPP_ID = 'llamacpp-local';

export const LOCAL_HTTP = {
  [LMSTUDIO_ID]: {
    id: LMSTUDIO_ID, name: 'LM Studio on this PC', short: 'LM Studio', app: 'lms', appName: 'LM Studio',
    billing: 'free', local: true, portServer: true, base: 'http://127.0.0.1:1234',
    site: 'https://lmstudio.ai', keyUrl: 'https://lmstudio.ai/download', docs: 'https://lmstudio.ai/docs/api/rest-api',
    keyHint: 'No key: QuorX uses the models in your local LM Studio server (Developer → Start Server, or lms server start).',
    install: 'winget install ElementLabs.LMStudio',
  },
  [FOUNDRY_ID]: {
    id: FOUNDRY_ID, name: 'Foundry Local on this PC', short: 'Foundry Local', app: 'foundry', appName: 'Foundry Local',
    billing: 'free', local: true, portServer: false, base: 'http://127.0.0.1:5272',
    site: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/', keyUrl: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/get-started',
    docs: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/reference/reference-rest',
    keyHint: 'No key: QuorX finds Foundry Local’s dynamic port automatically (foundry service start).',
    install: 'winget install Microsoft.FoundryLocal',
  },
  [LLAMACPP_ID]: {
    id: LLAMACPP_ID, name: 'llama.cpp on this PC', short: 'llama.cpp', app: 'llama-server', appName: 'llama-server',
    billing: 'free', local: true, portServer: true, base: 'http://127.0.0.1:8080',
    site: 'https://github.com/ggml-org/llama.cpp', keyUrl: 'https://github.com/ggml-org/llama.cpp/releases',
    docs: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    keyHint: 'No key: QuorX connects to llama-server (port 8080 or 9931, or set Address for Jan / KoboldCpp / another port).',
    install: 'winget install ggml.llamacpp',
  },
};
export const LOCAL_HTTP_IDS = Object.keys(LOCAL_HTTP);

const err = (m, x = {}) => Object.assign(new Error(m), x);
const seen = new Map(); // id → { at, port }
const markUp = (id, root) => { try { const u = new URL(root); seen.set(id, { at: Date.now(), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }); } catch { /* ignore */ } };
export function localHttpServer(id, configuredBase = '') {
  const s = seen.get(id), root = normalizeRoot(configuredBase || envHost(id) || LOCAL_HTTP[id]?.base || 'http://127.0.0.1:8080', defaultPort(id));
  const port = s && Date.now() - s.at < 120e3 ? s.port : (() => { try { const u = new URL(root); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return defaultPort(id); } })();
  return { running: !!s && Date.now() - s.at < 120e3, port, startedHere: false };
}

function defaultPort(id) {
  return id === LMSTUDIO_ID ? 1234 : id === FOUNDRY_ID ? 5272 : Number(process.env.LLAMA_ARG_PORT) || 8080;
}
function envHost(id) {
  if (id === LMSTUDIO_ID) return process.env.LMSTUDIO_HOST || '';
  if (id === FOUNDRY_ID) return process.env.FOUNDRY_LOCAL_HOST || '';
  if (id === LLAMACPP_ID) return process.env.LLAMACPP_HOST || (process.env.LLAMA_ARG_PORT ? `http://127.0.0.1:${process.env.LLAMA_ARG_PORT}` : '');
  return '';
}
function authHeader(id) {
  const k = id === LMSTUDIO_ID ? (process.env.LMSTUDIO_API_KEY || process.env.LM_API_TOKEN)
    : id === LLAMACPP_ID ? process.env.LLAMA_API_KEY : '';
  return k ? { Authorization: `Bearer ${k}` } : {};
}
/** Strips trailing `/v1` or `/api/v1` and normalizes `host:port` or `0.0.0.0` to a clean server root URL. */
export function normalizeRoot(host, fallbackPort = 8080) {
  let h = String(host || '').trim();
  if (!h) return `http://127.0.0.1:${fallbackPort}`;
  const scheme = /^https?:\/\//i.test(h);
  if (!scheme && /^[0-9a-f]*:[0-9a-f]*:[0-9a-f:]*$/i.test(h)) h = `[${h}]`;
  try {
    const x = new URL(scheme ? h : `http://${h}`);
    const name = x.hostname === '0.0.0.0' || x.hostname === '[::]' ? '127.0.0.1' : x.hostname;
    const port = x.port || (!scheme ? String(fallbackPort) : '');
    const p = x.pathname.replace(/\/+$/, '').replace(/\/(api\/v[01]|v1)$/i, '');
    return `${x.protocol}//${name}${port ? `:${port}` : ''}${p}`;
  } catch { return `http://127.0.0.1:${fallbackPort}`; }
}

/** Finds LM Studio's `lms` CLI on PATH or in `~/.lmstudio/bin`. */
export function findLocalApp(id, find = findOnPath) {
  const def = LOCAL_HTTP[id];
  if (!def) return null;
  const hit = find(def.app);
  if (hit) return hit;
  if (id === LMSTUDIO_ID) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const p = path.join(os.homedir(), '.lmstudio', 'bin', `lms${ext}`);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not there */ }
  }
  return null;
}

// Discovers Foundry Local's dynamic port via `foundry service status` when no explicit address is configured.
let foundryCachedRoot = '';
function discoverFoundryRoot({ find = findOnPath, run = execFile } = {}) {
  const exe = find('foundry');
  if (!exe) return Promise.reject(err('Foundry Local is not installed on this computer (winget install Microsoft.FoundryLocal), or not on PATH.', { kind: 'notinstalled' }));
  return new Promise((resolve, reject) => {
    const cmd = /\.(cmd|bat)$/i.test(exe) ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" service status"`], { windowsVerbatimArguments: true }] : [exe, ['service', 'status'], {}];
    run(cmd[0], cmd[1], { timeout: 10000, windowsHide: true, ...cmd[2] }, (_e, out, stderr) => {
      const m = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i.exec(`${out || ''}\n${stderr || ''}`);
      if (!m) return reject(err('Foundry Local isn’t running. Run "foundry service start" in a terminal, then try again.', { kind: 'network' }));
      foundryCachedRoot = normalizeRoot(m[0], 5272);
      resolve(foundryCachedRoot);
    });
  });
}

async function probeOk(url, headers = {}, fetchFn = fetch, ms = 3000) {
  try {
    const r = await fetchFn(url, { headers, signal: AbortSignal.timeout(ms) });
    if (r.status === 401 || r.status === 403) return { authError: r };
    if (!r.ok) return null;
    return await r.json().catch(() => ({}));
  } catch { return null; }
}

/** Resolves and checks the running server root for `id`, throwing `notinstalled`, `auth`, or `network` when unavailable. */
export async function ensureLocalHttp(id, { base = '', fetchFn = fetch, find = findOnPath, run = execFile } = {}) {
  const def = LOCAL_HTTP[id];
  if (!def) throw err(`no such local server ${id}`, { kind: 'request' });
  const headers = { 'User-Agent': 'QuorX', ...authHeader(id) };
  const explicit = base && base !== def.base ? base : envHost(id);

  if (id === FOUNDRY_ID) {
    if (explicit) {
      const root = normalizeRoot(explicit, 5272);
      const ok = await probeOk(`${root}/openai/status`, headers, fetchFn) || await probeOk(`${root}/openai/models`, headers, fetchFn);
      if (ok?.authError) throw err(`Foundry Local refused the request (HTTP ${ok.authError.status}).`, { status: ok.authError.status, kind: 'auth' });
      if (!ok) throw err(`Foundry Local at ${root} isn’t answering. Run "foundry service start", then try again.`, { kind: 'network' });
      markUp(id, root);
      return root;
    }
    if (foundryCachedRoot && await probeOk(`${foundryCachedRoot}/openai/status`, headers, fetchFn, 1500)) { markUp(id, foundryCachedRoot); return foundryCachedRoot; }
    const root = await discoverFoundryRoot({ find, run });
    markUp(id, root);
    return root;
  }

  const candidates = explicit ? [normalizeRoot(explicit, defaultPort(id))]
    : id === LLAMACPP_ID ? ['http://127.0.0.1:8080', 'http://127.0.0.1:9931']
    : [normalizeRoot(def.base, defaultPort(id))];
  const checkPaths = id === LMSTUDIO_ID ? ['/api/v1/models', '/api/v0/models', '/v1/models'] : ['/health', '/v1/models'];
  for (const root of candidates) {
    for (const p of checkPaths) {
      const got = await probeOk(`${root}${p}`, headers, fetchFn, 2500);
      if (got?.authError) throw err(`${def.appName} refused the request (HTTP ${got.authError.status}). Check ${id === LMSTUDIO_ID ? 'LMSTUDIO_API_KEY' : 'LLAMA_API_KEY'}.`, { status: got.authError.status, kind: 'auth' });
      if (got) { markUp(id, root); return root; }
    }
  }
  const shown = candidates[0];
  throw err(id === LMSTUDIO_ID
    ? `LM Studio’s server isn’t running at ${shown}. Start it in LM Studio (Developer → Start Server) or run "lms server start", then try again.`
    : `llama-server isn’t running at ${explicit ? shown : 'http://127.0.0.1:8080 or :9931'}. Start llama-server (or set its port in Address), then try again.`, { kind: 'network' });
}

const NOT_CHAT = /embed|rerank|whisper|tts|audio|bge-|nomic-embed|snowflake-arctic-embed/i;
const cleanGgufName = (s) => String(s || '').split(/[\\/]/).pop().replace(/\.gguf$/i, '');
const inferMaker = (id, pub = '') => {
  const s = `${pub}/${id}`.toLowerCase();
  if (/qwen|qwq|alibaba/.test(s)) return 'qwen';
  if (/llama|meta/.test(s)) return 'meta';
  if (/gemma|gemini|google/.test(s)) return 'google';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/mistral|ministral|codestral|devstral|pixtral/.test(s)) return 'mistralai';
  if (/glm|zhipu|zai/.test(s)) return 'z-ai';
  if (/phi|microsoft/.test(s)) return 'microsoft';
  if (/gpt-oss|openai/.test(s)) return 'openai';
  if (/kimi|moonshot/.test(s)) return 'moonshotai';
  if (/minimax/.test(s)) return 'minimax';
  return pub ? String(pub).toLowerCase() : null;
};

/** Lists the chat models a local OpenAI-compatible server offers now. */
export async function localHttpModels(id, { base = '', fetchFn = fetch, find = findOnPath, run = execFile } = {}) {
  const root = await ensureLocalHttp(id, { base, fetchFn, find, run });
  const headers = { 'User-Agent': 'QuorX', ...authHeader(id) };
  const get = async (p) => {
    const r = await fetchFn(`${root}${p}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };

  if (id === LMSTUDIO_ID) {
    const v1 = await get('/api/v1/models');
    if (Array.isArray(v1?.models)) {
      return v1.models.filter((m) => m?.key && m.type === 'llm' && m.capabilities?.trained_for_tool_use !== false).map((m) => {
        const loadedCtx = Number(m.loaded_instances?.[0]?.config?.context_length) || 0;
        const ctx = loadedCtx || Number(m.max_context_length) || null;
        const quant = m.quantization?.name ? String(m.quantization.name) : '';
        const allowed = Array.isArray(m.capabilities?.reasoning?.allowed_options) ? m.capabilities.reasoning.allowed_options : [];
        const efforts = allowed.filter((x) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(x));
        const maker = inferMaker(m.key, m.publisher);
        return {
          id: `${LMSTUDIO_ID}/${m.key}`, realId: m.key, modelID: m.key, providerID: 'lmstudio', providerName: 'LM Studio', source: LMSTUDIO_ID,
          ...(maker ? { maker } : {}),
          name: `${m.display_name || m.key}${quant ? ` · ${quant}` : ''}`, kind: 'chat', ctx, maxOut: null, created: 0,
          in: m.capabilities?.vision ? ['text', 'image'] : ['text'], out: ['text'],
          price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'free',
          tools: true, temp: true, reasoning: !!m.capabilities?.reasoning, efforts,
          interleaved: /deepseek|glm|kimi|qwq/i.test(m.key) ? 'reasoning_content' : null,
          format: LMSTUDIO_ID, status: null, canonical: null,
          desc: `Runs on this computer through LM Studio${m.params_string ? ` (${m.params_string}${quant ? `, ${quant}` : ''})` : ''}.`,
        };
      });
    }
    const v0 = await get('/api/v0/models');
    if (Array.isArray(v0?.data)) {
      return v0.data.filter((m) => m?.id && (m.type === 'llm' || m.type === 'vlm') && (!Array.isArray(m.capabilities) || m.capabilities.includes('tool_use'))).map((m) => {
        const maker = inferMaker(m.id, m.publisher);
        return {
          id: `${LMSTUDIO_ID}/${m.id}`, realId: m.id, modelID: m.id, providerID: 'lmstudio', providerName: 'LM Studio', source: LMSTUDIO_ID,
          ...(maker ? { maker } : {}),
          name: `${cleanGgufName(m.id)}${m.quantization ? ` · ${m.quantization}` : ''}`, kind: 'chat',
          ctx: Number(m.loaded_context_length) || Number(m.max_context_length) || null, maxOut: null, created: 0,
          in: m.type === 'vlm' ? ['text', 'image'] : ['text'], out: ['text'],
          price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'free',
          tools: true, temp: true, reasoning: /r1|qwq|thinking|gpt-oss/i.test(m.id), efforts: [],
          format: LMSTUDIO_ID, status: null, canonical: null, desc: 'Runs on this computer through LM Studio.',
        };
      });
    }
  }

  if (id === FOUNDRY_ID) {
    const [cached, cat, oai] = await Promise.all([get('/openai/models'), get('/foundry/list'), get('/v1/models')]);
    const names = Array.isArray(cached) ? cached.map(String) : Array.isArray(oai?.data) ? oai.data.map((m) => String(m?.id || '')).filter(Boolean) : [];
    const byName = new Map((Array.isArray(cat?.models) ? cat.models : []).flatMap((m) => [[m.name, m], ...(m.alias ? [[m.alias, m]] : [])]));
    return [...new Set(names)].filter((n) => n && !NOT_CHAT.test(n)).flatMap((name) => {
      const meta = byName.get(name);
      if (meta && (meta.supportsToolCalling === false || (meta.task && !/chat/i.test(meta.task)))) return [];
      const ep = meta?.runtime?.executionProvider || meta?.runtime?.deviceType || '';
      const maker = inferMaker(name, meta?.publisher);
      return [{
        id: `${FOUNDRY_ID}/${name}`, realId: name, modelID: name, providerID: 'foundry-local', providerName: 'Foundry Local', source: FOUNDRY_ID,
        ...(maker ? { maker } : {}),
        name: `${meta?.displayName || meta?.alias || name}${ep ? ` · ${ep}` : ''}`, kind: 'chat', ctx: null, maxOut: null, created: 0,
        in: /vision|vl|multimodal/i.test(name) ? ['text', 'image'] : ['text'], out: ['text'],
        price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'free',
        tools: true, temp: true, reasoning: /reasoning|r1|qwq|phi-4-reasoning/i.test(name), efforts: [],
        format: FOUNDRY_ID, status: null, canonical: null,
        desc: `Runs on this computer through Microsoft Foundry Local${ep ? ` (${ep})` : ''}.`,
      }];
    });
  }

  // llama.cpp (`llama-server`) and compatible `/v1/models` servers (Jan, KoboldCpp, vLLM).
  const [modelsRes, props] = await Promise.all([get('/v1/models'), get('/props')]);
  const slotCtx = Number(props?.default_generation_settings?.n_ctx) || null;
  const rows = Array.isArray(modelsRes?.data) ? modelsRes.data : Array.isArray(modelsRes?.models) ? modelsRes.models : [];
  return rows.filter((m) => {
    const mid = String(m?.id || m?.name || '');
    if (!mid || NOT_CHAT.test(mid) || m?.status?.value === 'incomplete') return false;
    const outMod = m?.architecture?.output_modalities;
    if (Array.isArray(outMod) && !outMod.includes('text')) return false;
    return true;
  }).map((m) => {
    const mid = String(m.id || m.name);
    const inMod = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
    const ctx = slotCtx || Number(m.meta?.n_ctx_train) || Number(m.context_length) || null;
    const maker = inferMaker(mid, m.owned_by === 'llamacpp' ? '' : m.owned_by);
    return {
      id: `${id}/${mid}`, realId: mid, modelID: mid, providerID: id, providerName: LOCAL_HTTP[id].appName, source: id,
      ...(maker ? { maker } : {}),
      name: cleanGgufName(mid), kind: 'chat', ctx, maxOut: null, created: Number(m.created) > 1e9 ? Number(m.created) : 0,
      in: inMod.includes('image') || /vl|vision|pixtral|gemma-3|gemma-4/i.test(mid) ? ['text', 'image'] : ['text'], out: ['text'],
      price: [0, 0], listPrice: [0, 0], cost: {}, plan: 'free',
      tools: true, temp: true, reasoning: /r1|qwq|qwen3|glm-5|glm-4\.7|deepseek|gpt-oss|thinking/i.test(mid),
      efforts: /gpt-oss|qwen3|glm/i.test(mid) ? ['low', 'medium', 'high'] : [],
      interleaved: 'reasoning_content',
      format: id, status: null, canonical: null, desc: `Runs on this computer through ${LOCAL_HTTP[id].appName} (${root}).`,
    };
  });
}

async function httpFailure(r, appName) {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  const msg = (typeof j?.error === 'string' ? j.error : j?.error?.message) || j?.message || t.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${r.status}`;
  const kind = r.status === 401 || r.status === 403 ? 'auth' : r.status === 404 && /model/i.test(msg) ? 'model' : r.status === 503 ? 'server' : undefined;
  return err(`${appName}: ${msg}`, { status: r.status, ...(kind ? { kind } : {}) });
}
async function* quietLimit(body, ms, ac, name) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`${name} sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}

/** Builds the `/v1/chat/completions` body for a local server, adapting Foundry Local's parameter schema. */
export function localHttpBody(id, body, info = {}) {
  const real = info.realId || String(body.model || '').slice(id.length + 1);
  const out = goBody(body, { ...info, realId: real });
  if (id === FOUNDRY_ID) {
    delete out.stream_options;
    delete out.parallel_tool_calls;
    if (out.seed !== undefined) { out.random_seed = out.seed; delete out.seed; }
  }
  return out;
}

/** Streams one chat completion from LM Studio, Foundry Local, or `llama-server` into QuorX's standard shape. */
export async function localHttpStream(id, body, signal, onText, onThink, { info = {}, idleMs = 300e3, base = '', fetchFn = fetch, find = findOnPath, run = execFile, onCall } = {}) {
  const def = LOCAL_HTTP[id];
  if (!def) throw err(`no such local server ${id}`, { kind: 'request' });
  const root = await ensureLocalHttp(id, { base, fetchFn, find, run });
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now();
  try {
    const req = localHttpBody(id, body, info);
    const r = await fetchFn(`${root}/v1/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'QuorX', ...authHeader(id) },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw await httpFailure(r, def.appName);
    const out = await readChatStream({ body: quietLimit(r.body, idleMs, ac, def.appName) }, body, t, onText, onThink, onCall);
    if (!out.seen) throw err(`${def.appName} answered with an empty stream`, { kind: 'shape' });
    out.provider = def.short;
    out.model = body.model;
    markUp(id, root);
    if (info.interleaved && out.thinking) out.passBack = { [info.interleaved]: out.thinking };
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw Object.assign(ac.signal.reason, { partial: e?.partial });
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}
